"""Retrieval numbers that break it: refused on save, replaced at use (#638).

A reranking batch size below 1 made `CrossEncoder.predict` raise, which
`query_collection` caught and logged at debug level, so every hybrid search
quietly became a vector search. Documents saved any integer for it. Below 1
it is now refused on save, before anything changes; a save that leaves it
unset, or has full context on (where Documents hides it), is not checked.

An environment variable (`RAG_EMBEDDING_BATCH_SIZE=0`,
`RAG_RERANKING_BATCH_SIZE=-1`) or a value stored before these checks still
reaches the functions that use them, so those log a warning and use the
default instead: an embedding batch size of 1, a reranking batch size of 32,
and no limit on concurrent embedding requests.

Run from apps/server:

    python -m pytest tests/test_retrieval_number_bounds.py
"""

import asyncio
import logging
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.retrieval import utils as retrieval_utils
from local_llm.routers import retrieval

stored_values = {field: f'stored:{field}' for field in retrieval.RETRIEVAL_CONFIG_KEYS}
stored_values.update(
    CHUNK_SIZE=1000,
    CHUNK_OVERLAP=100,
    ENABLE_RAG_HYBRID_SEARCH=False,
    RAG_FULL_CONTEXT=False,
    RAG_RERANKING_BATCH_SIZE=32,
)


@pytest.fixture
def stored(monkeypatch):
    """Retrieval settings as markers, with hybrid search off; returns what is written."""
    written: dict = {}

    async def get_config():
        return retrieval.RetrievalConfig(dict(stored_values))

    async def upsert(updates):
        written.update(updates)

    monkeypatch.setattr(retrieval, 'get_retrieval_config', get_config)
    monkeypatch.setattr(retrieval.Config, 'upsert', upsert)
    return written


def _save(form: retrieval.ConfigForm):
    state = SimpleNamespace(YOUTUBE_LOADER_TRANSLATION='stored', rf=None, RERANKING_FUNCTION=None)
    request = SimpleNamespace(app=SimpleNamespace(state=state))
    return asyncio.run(retrieval.update_rag_config(request, form, user=None))


@pytest.mark.parametrize('batch_size', [0, -5])
def test_a_reranking_batch_size_below_1_is_refused_and_nothing_is_saved(stored, batch_size):
    with pytest.raises(HTTPException) as refused:
        _save(retrieval.ConfigForm(RAG_RERANKING_BATCH_SIZE=batch_size, TOP_K=7))

    assert refused.value.status_code == 400
    assert refused.value.detail == f'Reranking Batch Size must be a whole number of at least 1 (got {batch_size}).'
    assert stored == {}


def test_a_reranking_batch_size_of_1_or_more_is_saved(stored):
    _save(retrieval.ConfigForm(RAG_RERANKING_BATCH_SIZE=16))

    assert stored['rag.reranking_batch_size'] == 16


@pytest.mark.parametrize('form', [{'RAG_FULL_CONTEXT': True}, {}])
def test_with_full_context_on_an_unused_reranking_batch_size_does_not_block_the_save(stored, monkeypatch, form):
    """Documents hides the field under full context and sends the stored value, so
    refusing it would block every save; it is replaced at use (#638)."""
    if not form:
        monkeypatch.setitem(stored_values, 'RAG_FULL_CONTEXT', True)
    _save(retrieval.ConfigForm(RAG_RERANKING_BATCH_SIZE=0, TOP_K=7, **form))

    assert stored['rag.top_k'] == 7


def test_a_save_that_leaves_the_reranking_batch_size_unset_keeps_it(stored):
    _save(retrieval.ConfigForm(TOP_K=7))

    assert stored['rag.top_k'] == 7
    assert stored['rag.reranking_batch_size'] == 32


def _warnings(caplog):
    return [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]


@pytest.mark.parametrize('batch_size', [0, -1, None])
def test_the_local_engine_embeds_with_a_batch_size_of_1_in_place_of_an_unusable_one(caplog, batch_size):
    seen: list = []

    class Model:
        def encode(self, query, batch_size, **kwargs):
            seen.append(batch_size)
            return SimpleNamespace(tolist=lambda: [[0.0]])

    with caplog.at_level(logging.WARNING, logger=retrieval_utils.log.name):
        embed = retrieval_utils.get_embedding_function('', 'm', Model(), None, None, batch_size)

    assert asyncio.run(embed(['a', 'b'])) == [[0.0]]
    assert seen == [1]
    assert _warnings(caplog) == [
        f'Embedding Batch Size must be a whole number of at least 1 (got {batch_size!r}). Using 1 instead.'
    ]


@pytest.mark.parametrize('enable_async', [True, False])
def test_an_external_engine_embeds_despite_an_unusable_batch_size_and_concurrency(monkeypatch, caplog, enable_async):
    batches: list = []

    async def generate_embeddings(*, text, **kwargs):
        batches.append(text)
        return [[float(len(t))] for t in text]

    monkeypatch.setattr(retrieval_utils, 'generate_embeddings', generate_embeddings)

    with caplog.at_level(logging.WARNING, logger=retrieval_utils.log.name):
        embed = retrieval_utils.get_embedding_function(
            'openai', 'm', None, 'u', 'k', 0, enable_async=enable_async, concurrent_requests=-1
        )

    assert asyncio.run(embed(['a', 'bb', 'ccc'])) == [[1.0], [2.0], [3.0]]
    assert batches == [['a'], ['bb'], ['ccc']]
    assert _warnings(caplog) == [
        'Embedding Batch Size must be a whole number of at least 1 (got 0). Using 1 instead.',
        'Embedding Concurrent Requests must be a whole number of at least 0 (got -1). Using no limit instead.',
    ]


def test_usable_embedding_numbers_are_used_as_they_are_and_log_nothing(monkeypatch, caplog):
    batches: list = []

    async def generate_embeddings(*, text, **kwargs):
        batches.append(text)
        return [[0.0] for _ in text]

    monkeypatch.setattr(retrieval_utils, 'generate_embeddings', generate_embeddings)

    with caplog.at_level(logging.WARNING, logger=retrieval_utils.log.name):
        embed = retrieval_utils.get_embedding_function('openai', 'm', None, 'u', 'k', 2, concurrent_requests=1)
        asyncio.run(embed(['a', 'b', 'c']))

    assert batches == [['a', 'b'], ['c']]
    assert _warnings(caplog) == []


@pytest.mark.parametrize(('batch_size', 'used'), [(0, 32), (-1, 32), (None, 32), (8, 8)])
def test_the_reranker_uses_a_batch_size_of_32_in_place_of_an_unusable_one(caplog, batch_size, used):
    seen: list = []

    class CrossEncoder:
        def predict(self, pairs, batch_size):
            seen.append(batch_size)
            return [1.0 for _ in pairs]

    with caplog.at_level(logging.WARNING, logger=retrieval_utils.log.name):
        rerank = retrieval_utils.get_reranking_function('', 'm', CrossEncoder(), reranking_batch_size=batch_size)

    assert rerank('q', [SimpleNamespace(page_content='d')]) == [1.0]
    assert seen == [used]
    expected = (
        []
        if used == batch_size
        else [f'Reranking Batch Size must be a whole number of at least 1 (got {batch_size!r}). Using 32 instead.']
    )
    assert _warnings(caplog) == expected
