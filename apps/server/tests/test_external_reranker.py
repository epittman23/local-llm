"""The external reranker's timeout, and what reranking does when it fails (#348).

An empty RAG_EXTERNAL_RERANKER_TIMEOUT used to reach requests as
timeout=None, so a hung reranker blocked retrieval forever. And a failed
rerank (the reranker returns None) made RerankCompressor hand back every
candidate in fusion order, ignoring top-k and the relevance threshold. A
failed rerank now scores the candidates by embedding similarity, as the
compressor does when no reranker is configured.
"""

import asyncio
import logging

import pytest
from langchain_core.documents import Document

from local_llm.env import REQUESTS_TIMEOUT_API
from local_llm.retrieval import utils as retrieval
from local_llm.retrieval.models import external

GOOD_RESULTS = [{'index': 1, 'relevance_score': 0.2}, {'index': 0, 'relevance_score': 0.9}]


class _Response:
    def __init__(self, results):
        self.results = results

    def raise_for_status(self):
        pass

    def json(self):
        return {'results': self.results}


def _record_post(monkeypatch, results=GOOD_RESULTS):
    calls = []

    def post(url, **kwargs):
        calls.append(kwargs)
        return _Response(results)

    monkeypatch.setattr(external.requests, 'post', post)
    return calls


def test_unset_timeout_uses_a_finite_default(monkeypatch):
    calls = _record_post(monkeypatch)
    reranker = external.ExternalReranker(api_key='k', timeout=None)

    assert reranker.predict([('q', 'a'), ('q', 'b')]) == [0.9, 0.2]
    assert calls[0]['timeout'] == REQUESTS_TIMEOUT_API


def test_configured_timeout_is_passed_through(monkeypatch):
    calls = _record_post(monkeypatch)
    external.ExternalReranker(api_key='k', timeout=5).predict([('q', 'a'), ('q', 'b')])

    assert calls[0]['timeout'] == 5


def test_results_not_covering_every_document_count_as_a_failure(monkeypatch):
    _record_post(monkeypatch, results=[{'index': 0, 'relevance_score': 0.9}])

    assert external.ExternalReranker(api_key='k').predict([('q', 'a'), ('q', 'b')]) is None


def test_duplicate_result_indices_count_as_a_failure(monkeypatch):
    duplicated = [{'index': 0, 'relevance_score': 0.9}, {'index': 0, 'relevance_score': 0.1}]
    _record_post(monkeypatch, results=duplicated)

    assert external.ExternalReranker(api_key='k').predict([('q', 'a'), ('q', 'b')]) is None


# Five candidates in fusion (RRF) order. Their embeddings against the query
# vector [1, 0] have cosine similarities 0.2, 0.6, 1.0, 0.8 and 0.0.
DOCS = ['d0', 'd1', 'd2', 'd3', 'd4']
VECTORS = {
    'd0': [0.2, 0.9797958971],
    'd1': [0.6, 0.8],
    'd2': [1.0, 0.0],
    'd3': [0.8, 0.6],
    'd4': [0.0, 1.0],
}


async def _embed(text, prefix=None):
    if isinstance(text, str):
        return [1.0, 0.0]
    return [VECTORS[t] for t in text]


def _compress(reranking_function, top_n=2, r_score=0.5, embedding_function=_embed):
    compressor = retrieval.RerankCompressor(
        embedding_function=embedding_function,
        top_n=top_n,
        reranking_function=reranking_function,
        r_score=r_score,
    )
    documents = [Document(page_content=t, metadata={'score': 1.0 / (60 + i)}) for i, t in enumerate(DOCS)]
    return asyncio.run(compressor.acompress_documents(documents, 'q'))


def test_failed_rerank_still_applies_top_k_and_threshold(caplog):
    with caplog.at_level(logging.WARNING, logger=retrieval.log.name):
        result = _compress(lambda query, documents: None)

    assert [d.page_content for d in result] == ['d2', 'd3']
    assert [round(d.metadata['score'], 6) for d in result] == [1.0, 0.8]
    assert any('rerank' in r.getMessage().lower() for r in caplog.records if r.levelno >= logging.WARNING)


def test_failed_rerank_threshold_can_exclude_everything_but_the_best():
    result = _compress(lambda query, documents: None, top_n=5, r_score=0.9)

    assert [d.page_content for d in result] == ['d2']


async def _broken_embed(text, prefix=None):
    raise RuntimeError('embedding service down')


def test_failed_rerank_and_failed_embedding_keep_top_k_in_original_order(caplog):
    with caplog.at_level(logging.WARNING, logger=retrieval.log.name):
        result = _compress(lambda query, documents: None, embedding_function=_broken_embed)

    assert [d.page_content for d in result] == ['d0', 'd1']
    assert any('embedding' in r.getMessage().lower() for r in caplog.records if r.levelno >= logging.WARNING)


def _raising_reranker(query, documents):
    raise RuntimeError('CUDA out of memory')


def test_a_reranker_that_raises_falls_back_to_similarity_like_one_that_fails(caplog):
    """A local CrossEncoder or ColBERT reranker raises instead of returning None (#533)."""
    with caplog.at_level(logging.WARNING, logger=retrieval.log.name):
        result = _compress(_raising_reranker)

    assert [d.page_content for d in result] == ['d2', 'd3']
    assert [round(d.metadata['score'], 6) for d in result] == [1.0, 0.8]
    assert any('CUDA out of memory' in r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING)


def test_a_reranker_that_raises_and_a_failed_embedding_keep_top_k_in_original_order():
    result = _compress(_raising_reranker, embedding_function=_broken_embed)

    assert [d.page_content for d in result] == ['d0', 'd1']


def test_without_a_reranker_an_embedding_failure_still_raises():
    with pytest.raises(RuntimeError, match='embedding service down'):
        _compress(None, embedding_function=_broken_embed)


def test_working_rerank_drives_order_and_scores():
    reranker_scores = {'d0': 0.95, 'd1': 0.1, 'd2': 0.3, 'd3': 0.7, 'd4': 0.4}

    result = _compress(lambda query, documents: [reranker_scores[d.page_content] for d in documents])

    assert [d.page_content for d in result] == ['d0', 'd3']
    assert [d.metadata['score'] for d in result] == [0.95, 0.7]
