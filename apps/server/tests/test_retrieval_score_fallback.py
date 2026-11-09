"""A search that fell back says so, since its scores are on another scale (#503).

Hybrid search that fails is answered by vector search, and a reranker that
fails is replaced by embedding similarity (or, when that fails too, the
fusion's own order). Each gives scores on a different scale from the search
that was configured, so query_chat_files can only rank one file's hits
against another's when both came from the same kind of search. The result
of a search that fell back carries `fallback` naming what answered it, from
the compressor through the merged result to the source; a search that did
not fall back carries no such key, so the common case is unchanged.

Run from apps/server:

    python -m pytest tests/test_retrieval_score_fallback.py
"""

import asyncio
from types import SimpleNamespace

from langchain_core.documents import Document

from local_llm.retrieval import utils as retrieval
from local_llm.retrieval.vector.main import GetResult, SearchResult

REQUEST = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(RERANKING_FUNCTION=None)))
HIT = SearchResult(ids=[['c1']], distances=[[0.8]], documents=[['chunk']], metadatas=[[{'file_id': 'fa'}]])


async def _embed(text, prefix=None):
    if isinstance(text, str):
        return [1.0, 0.0]
    return [[1.0, 0.0] for _ in text]


def _query_collection(monkeypatch, hybrid):
    async def settings(*_keys):
        return {'rag.enable_hybrid_search': True}

    monkeypatch.setattr(retrieval.Config, 'get_many', settings)
    monkeypatch.setattr(retrieval, 'query_collection_with_hybrid_search', hybrid)
    monkeypatch.setattr(retrieval, 'query_doc', lambda **_kwargs: HIT)
    return asyncio.run(
        retrieval.query_collection(REQUEST, collection_names=['file-fa'], queries=['q'], embedding_function=_embed, k=3)
    )


def test_vector_search_answering_for_a_failed_hybrid_search_is_marked(monkeypatch):
    async def hybrid(**_kwargs):
        raise RuntimeError('Hybrid search failed for all collections.')

    result = _query_collection(monkeypatch, hybrid)

    assert result['documents'] == [['chunk']]
    assert result['fallback'] == 'vector'


def test_a_hybrid_search_that_answered_is_not_marked(monkeypatch):
    async def hybrid(**_kwargs):
        return {'distances': [[0.9]], 'documents': [['hybrid']], 'metadatas': [[{}]]}

    assert 'fallback' not in _query_collection(monkeypatch, hybrid)


def _compressor(reranking_function, embedding_function=_embed):
    return retrieval.RerankCompressor(
        embedding_function=embedding_function, top_n=2, reranking_function=reranking_function, r_score=0.0
    )


def _compress(compressor):
    documents = [Document(page_content=t, metadata={'score': 0.01}) for t in ('d0', 'd1')]
    return asyncio.run(compressor.acompress_documents(documents, 'q'))


async def _broken_embed(text, prefix=None):
    raise RuntimeError('embedding service down')


def _raising_reranker(query, documents):
    raise RuntimeError('CUDA out of memory')


def test_a_reranker_that_scored_leaves_no_mark():
    compressor = _compressor(lambda query, documents: [0.7, 0.3])
    _compress(compressor)

    assert compressor.fallback is None


def test_no_reranker_configured_leaves_no_mark():
    compressor = _compressor(None)
    _compress(compressor)

    assert compressor.fallback is None


def test_a_failed_reranker_marks_embedding_similarity():
    for reranker in (lambda query, documents: None, _raising_reranker):
        compressor = _compressor(reranker)
        _compress(compressor)

        assert compressor.fallback == 'embedding'


def test_a_failed_reranker_and_failed_embedding_mark_the_fusion_order():
    compressor = _compressor(lambda query, documents: None, embedding_function=_broken_embed)
    _compress(compressor)

    assert compressor.fallback == 'fused'


def test_native_hybrid_search_carries_the_compressors_mark(monkeypatch):
    async def hybrid_search(collection_name, query, vectors, limit, hybrid_bm25_weight):
        return HIT

    monkeypatch.setattr(
        retrieval, 'ASYNC_VECTOR_DB_CLIENT', SimpleNamespace(supports_hybrid_search=True, hybrid_search=hybrid_search)
    )

    def run(reranker) -> dict:
        search = retrieval.query_doc_with_native_hybrid_search('file-fa', 'q', _embed, 3, reranker, 3, 0.0, 0.5)
        result = asyncio.run(search)
        assert result is not None
        return result

    assert run(_raising_reranker)['fallback'] == 'embedding'
    assert 'fallback' not in run(lambda query, documents: [0.7])


def test_legacy_hybrid_search_carries_the_compressors_mark():
    """The compressor is wrapped in a ContextualCompressionRetriever here; its mark still arrives."""
    collection = GetResult(ids=[['c1', 'c2']], documents=[['rotate the key', 'other']], metadatas=[[{}, {}]])

    def run(reranker):
        search = retrieval.query_doc_with_hybrid_search(
            'file-fa', collection, 'rotate key', _embed, 3, reranker, 3, 0.0, 1.0, native_hybrid_search=False
        )
        return asyncio.run(search)

    assert run(_raising_reranker)['fallback'] == 'embedding'
    assert 'fallback' not in run(lambda query, documents: [0.7] * len(documents))


def test_merging_keeps_the_mark():
    marked = {'distances': [[0.4]], 'documents': [['a']], 'metadatas': [[{}]], 'fallback': 'embedding'}
    plain = {'distances': [[0.9]], 'documents': [['b']], 'metadatas': [[{}]]}

    assert retrieval.merge_and_sort_query_results([plain, marked], k=2)['fallback'] == 'embedding'
    assert 'fallback' not in retrieval.merge_and_sort_query_results([plain], k=2)


def test_the_source_carries_the_mark():
    result = {'documents': [['a']], 'metadatas': [[{}]], 'distances': [[0.4]], 'file': {'id': 'fa'}}

    marked, plain = retrieval._sources_from_results([{**result, 'fallback': 'vector'}, result])

    assert marked['fallback'] == 'vector'
    assert 'fallback' not in plain
