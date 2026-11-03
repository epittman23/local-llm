"""Saving hybrid search with a reranker that cannot load says so (#232).

update_rag_config caught the load error, turned ENABLE_RAG_HYBRID_SEARCH
off, saved and returned 200 like any save, so the Documents tab showed
success with the toggle still on, and retrieval ran without hybrid search
or reranking. Hybrid search still goes off (there is no reranker to run),
but the response now carries a warning that says why, and the stored
flag, so the tab can show both.
"""

import asyncio
from types import SimpleNamespace

import pytest

from local_llm.routers import retrieval


@pytest.fixture
def stored(monkeypatch):
    """Retrieval settings as markers, with retrieval on and hybrid search off; returns what is written."""
    values = {field: f'stored:{field}' for field in retrieval.RETRIEVAL_CONFIG_KEYS}
    values.update(BYPASS_EMBEDDING_AND_RETRIEVAL=False, ENABLE_RAG_HYBRID_SEARCH=False)
    written: dict = {}

    async def get_config():
        return retrieval.RetrievalConfig(dict(values))

    async def upsert(updates):
        written.update(updates)

    monkeypatch.setattr(retrieval, 'get_retrieval_config', get_config)
    monkeypatch.setattr(retrieval.Config, 'upsert', upsert)
    return written


def _save(form: retrieval.ConfigForm) -> dict:
    state = SimpleNamespace(YOUTUBE_LOADER_TRANSLATION='stored', rf=None, RERANKING_FUNCTION=None)
    request = SimpleNamespace(app=SimpleNamespace(state=state))
    return asyncio.run(retrieval.update_rag_config(request, form, user=None))


def test_a_reranker_that_cannot_load_turns_hybrid_search_off_and_says_so(stored, monkeypatch):
    def cannot_load(*args, **kwargs):
        raise Exception('CrossEncoder error: not in the Hugging Face cache')

    monkeypatch.setattr(retrieval, 'get_rf', cannot_load)

    response = _save(retrieval.ConfigForm(ENABLE_RAG_HYBRID_SEARCH=True, RAG_RERANKING_MODEL='BAAI/bge-reranker-v2-m3'))

    assert response['ENABLE_RAG_HYBRID_SEARCH'] is False
    assert stored[retrieval.RETRIEVAL_CONFIG_KEYS['ENABLE_RAG_HYBRID_SEARCH']] is False
    assert len(response['warnings']) == 1
    assert 'Hybrid search was turned off' in response['warnings'][0]
    assert 'not in the Hugging Face cache' in response['warnings'][0]


def test_a_reranker_that_loads_keeps_hybrid_search_on_without_a_warning(stored, monkeypatch):
    monkeypatch.setattr(retrieval, 'get_rf', lambda *args, **kwargs: object())
    monkeypatch.setattr(retrieval, 'get_reranking_function', lambda *args, **kwargs: lambda *a, **k: None)

    response = _save(retrieval.ConfigForm(ENABLE_RAG_HYBRID_SEARCH=True, RAG_RERANKING_MODEL='BAAI/bge-reranker-v2-m3'))

    assert response['ENABLE_RAG_HYBRID_SEARCH'] is True
    assert response['warnings'] == []
