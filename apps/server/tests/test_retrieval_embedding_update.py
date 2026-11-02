"""`POST /retrieval/embedding/update` with a local model that will not load.

`get_ef` logs a load failure and returns None. The route used to unload the
working model first, then save the new name and report success, after which
every upload and query failed with "No embedding model is loaded" (#346).
These pin that a model that fails to load is refused with a message naming
it, that nothing is saved and the loaded model stays in use, that a model
that loads replaces the old one, and that an external engine (for which
`get_ef` returns None by design) still saves.
"""

import asyncio
import contextlib
import sys
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.routers import retrieval

OLD_EF = object()


async def OLD_EMBEDDING_FUNCTION(query, prefix=None, user=None):
    return [0.0]


@pytest.fixture
def stored(monkeypatch):
    """A local model is configured and loaded; returns what the route writes."""
    values = {field: '' for field in retrieval.RETRIEVAL_CONFIG_KEYS}
    values['RAG_EMBEDDING_MODEL'] = 'old/model'
    written: dict = {}

    async def get_config():
        return retrieval.RetrievalConfig(dict(values))

    async def upsert(updates):
        written.update(updates)

    monkeypatch.setattr(retrieval, 'get_retrieval_config', get_config)
    monkeypatch.setattr(retrieval.Config, 'upsert', upsert)
    monkeypatch.setattr(retrieval, 'get_model_path', lambda model, update_model=False: model)
    return written


def _loader(monkeypatch, *, fails: bool):
    """Stands in for sentence_transformers so nothing is downloaded or loaded."""

    class SentenceTransformer:
        def __init__(self, path, **kwargs):
            if fails:
                raise OSError(f'{path} is not in the cache and outgoing traffic has been disabled')
            self.path = path

    monkeypatch.setitem(sys.modules, 'sentence_transformers', SimpleNamespace(SentenceTransformer=SentenceTransformer))


def _request():
    state = SimpleNamespace(ef=OLD_EF, EMBEDDING_FUNCTION=OLD_EMBEDDING_FUNCTION)
    return SimpleNamespace(app=SimpleNamespace(state=state))


def _update(request, **form):
    return asyncio.run(
        retrieval.update_embedding_config(request, retrieval.EmbeddingModelUpdateForm(**form), user=None)
    )


def test_a_model_that_fails_to_load_is_refused_and_the_old_one_kept(stored, monkeypatch):
    _loader(monkeypatch, fails=True)
    request = _request()

    with pytest.raises(HTTPException) as raised:
        _update(request, RAG_EMBEDDING_ENGINE='', RAG_EMBEDDING_MODEL='missing/model')

    assert raised.value.status_code == 400
    assert 'missing/model' in raised.value.detail
    assert 'previous embedding model is still in use' in raised.value.detail
    assert stored == {}
    assert request.app.state.ef is OLD_EF
    assert request.app.state.EMBEDDING_FUNCTION is OLD_EMBEDDING_FUNCTION


def test_a_model_that_loads_replaces_the_old_one(stored, monkeypatch):
    _loader(monkeypatch, fails=False)
    request = _request()

    result = _update(request, RAG_EMBEDDING_ENGINE='', RAG_EMBEDDING_MODEL=' new/model ')

    assert result['RAG_EMBEDDING_MODEL'] == 'new/model'
    assert stored['rag.embedding_model'] == 'new/model'
    assert request.app.state.ef.path == 'new/model'
    assert request.app.state.EMBEDDING_FUNCTION is not OLD_EMBEDDING_FUNCTION


@pytest.mark.parametrize('fails', [True, False])
def test_the_vram_cache_is_cleared_only_after_a_model_is_replaced(stored, monkeypatch, fails):
    _loader(monkeypatch, fails=fails)
    emptied: list = []
    cuda = SimpleNamespace(is_available=lambda: True, empty_cache=lambda: emptied.append(True))
    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(cuda=cuda))
    monkeypatch.setattr(retrieval, 'DEVICE_TYPE', 'cuda')

    with contextlib.suppress(HTTPException):
        _update(_request(), RAG_EMBEDDING_ENGINE='', RAG_EMBEDDING_MODEL='new/model')

    assert emptied == ([] if fails else [True])


def test_an_external_engine_is_saved_without_a_local_model(stored, monkeypatch):
    _loader(monkeypatch, fails=True)
    request = _request()

    result = _update(
        request,
        RAG_EMBEDDING_ENGINE='openai',
        RAG_EMBEDDING_MODEL='text-embedding-3-small',
        openai_config={'url': 'https://api.openai.com/v1', 'key': 'k'},
    )

    assert result['RAG_EMBEDDING_ENGINE'] == 'openai'
    assert stored['rag.embedding_engine'] == 'openai'
    assert stored['rag.embedding_model'] == 'text-embedding-3-small'
    assert request.app.state.ef is None
    assert request.app.state.EMBEDDING_FUNCTION is not OLD_EMBEDDING_FUNCTION
