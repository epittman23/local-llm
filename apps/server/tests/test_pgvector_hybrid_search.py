"""Keyword-only hybrid search falls back to vector search when no chunk matches (#347).

With the BM25 weight at 1.0, native pgvector hybrid search skips vector
search, and its full-text query ANDs every word, so a natural-language
question usually matched no chunk and chat got no context at all. The
caller now embeds the query and asks for vector results when the keyword
search came back empty. Whether the full-text query should match any word
rather than every word is a retrieval-design question left to the owner
(see #347).
"""

import asyncio
from types import SimpleNamespace

import pytest

from local_llm.retrieval import utils
from local_llm.retrieval.vector.main import SearchResult

EMPTY = SearchResult(ids=[[]], distances=[[]], documents=[[]], metadatas=[[]])
VECTOR_HITS = SearchResult(ids=[['v1']], distances=[[0.9]], documents=[['vector hit']], metadatas=[[{}]])
KEYWORD_HITS = SearchResult(ids=[['k1']], distances=[[0.5]], documents=[['keyword hit']], metadatas=[[{}]])


@pytest.fixture
def world(monkeypatch):
    calls: list[tuple] = []
    answers: dict[float, SearchResult] = {}

    async def hybrid_search(collection_name, query, vectors, limit, hybrid_bm25_weight):
        calls.append((hybrid_bm25_weight, len(vectors)))
        return answers.get(hybrid_bm25_weight, EMPTY)

    async def embed(query, prefix=None):
        return [0.1, 0.2]

    class _Compressor:
        def __init__(self, **kwargs):
            pass

        async def acompress_documents(self, documents, query):
            return documents

    monkeypatch.setattr(
        utils, 'ASYNC_VECTOR_DB_CLIENT', SimpleNamespace(supports_hybrid_search=True, hybrid_search=hybrid_search)
    )
    monkeypatch.setattr(utils, 'RerankCompressor', _Compressor)

    def run(weight):
        return asyncio.run(
            utils.query_doc_with_native_hybrid_search('kb1', 'how do I rotate the key', embed, 5, None, 3, 0.0, weight)
        )

    return SimpleNamespace(calls=calls, answers=answers, run=run)


def _texts(result):
    return result['documents'][0]


def test_keywords_only_with_no_match_falls_back_to_vector_search(world):
    world.answers[0.0] = VECTOR_HITS

    result = world.run(1.0)

    assert world.calls == [(1.0, 0), (0.0, 1)]
    assert _texts(result) == ['vector hit']


def test_keywords_only_with_a_match_uses_the_keywords(world):
    world.answers[1.0] = KEYWORD_HITS

    result = world.run(1.0)

    assert world.calls == [(1.0, 0)]
    assert _texts(result) == ['keyword hit']


def test_a_mixed_weight_with_no_results_does_not_search_twice(world):
    result = world.run(0.5)

    assert world.calls == [(0.5, 1)]
    assert _texts(result) == []
