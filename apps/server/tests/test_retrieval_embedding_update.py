"""`POST /retrieval/embedding/update`: a local model that will not load, and when a model is loaded at all.

`get_ef` logs a load failure and returns None. The route used to unload the
working model first, then save the new name and report success, after which
every upload and query failed with "No embedding model is loaded" (#346).
These pin that a model that fails to load is refused with a message naming
it and saying truthfully whether an embedding model is still in use, that
nothing is saved and the state is untouched, that a model that loads
replaces the old one, and that an external engine (for which `get_ef`
returns None by design) still saves. Also that a plain Documents save keeps a
loaded model it did not change, and loads one that differs from the model
loaded, and that a blank local model is refused (#532).

A batch size below 1, or none, is refused before anything changes too:
once saved it failed every embedding (#353). So is a negative number of
concurrent requests, which failed every external list embedding (#638).
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
def values():
    """The stored settings: a local model; a test may change them before the update."""
    stored_values = {field: '' for field in retrieval.RETRIEVAL_CONFIG_KEYS}
    stored_values['RAG_EMBEDDING_MODEL'] = 'old/model'
    return stored_values


@pytest.fixture
def stored(monkeypatch, values):
    """Serves `values` as the stored settings; returns what the route writes."""
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
    state = SimpleNamespace(ef=OLD_EF, ef_model='old/model', EMBEDDING_FUNCTION=OLD_EMBEDDING_FUNCTION)
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


def test_with_no_model_loaded_the_refusal_says_none_is(stored, monkeypatch):
    # An offline backend that booted with the stored model missing: nothing loaded.
    _loader(monkeypatch, fails=True)
    request = _request()
    request.app.state.ef = None

    with pytest.raises(HTTPException) as raised:
        _update(request, RAG_EMBEDDING_ENGINE='', RAG_EMBEDDING_MODEL='old/model')

    assert raised.value.status_code == 400
    assert 'No embedding model is loaded; uploads and queries will fail until one is.' in raised.value.detail
    assert 'still in use' not in raised.value.detail
    assert stored == {}
    assert request.app.state.ef is None
    assert request.app.state.EMBEDDING_FUNCTION is OLD_EMBEDDING_FUNCTION


def test_with_an_external_engine_in_use_the_refusal_says_it_is_kept(stored, values, monkeypatch):
    values['RAG_EMBEDDING_ENGINE'] = 'openai'
    _loader(monkeypatch, fails=True)
    request = _request()
    request.app.state.ef = None

    with pytest.raises(HTTPException) as raised:
        _update(request, RAG_EMBEDDING_ENGINE='', RAG_EMBEDDING_MODEL='missing/model')

    assert 'previous embedding model is still in use' in raised.value.detail
    assert stored == {}
    assert request.app.state.EMBEDDING_FUNCTION is OLD_EMBEDDING_FUNCTION


def test_a_failure_building_the_embedding_function_changes_nothing(stored, monkeypatch):
    _loader(monkeypatch, fails=False)

    def broken(*args, **kwargs):
        raise RuntimeError('cannot build the embedding function')

    monkeypatch.setattr(retrieval, 'get_embedding_function', broken)
    request = _request()

    with pytest.raises(HTTPException) as raised:
        _update(request, RAG_EMBEDDING_ENGINE='', RAG_EMBEDDING_MODEL='new/model')

    assert raised.value.status_code == 500
    assert stored == {}
    assert request.app.state.ef is OLD_EF
    assert request.app.state.EMBEDDING_FUNCTION is OLD_EMBEDDING_FUNCTION


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


def _counting_loader(monkeypatch):
    """A loader that loads and counts how often it did (#532)."""
    loads = []

    class SentenceTransformer:
        def __init__(self, path, **kwargs):
            loads.append(path)
            self.path = path

    monkeypatch.setitem(sys.modules, 'sentence_transformers', SimpleNamespace(SentenceTransformer=SentenceTransformer))
    return loads


def test_a_plain_save_keeps_the_loaded_model_when_it_is_unchanged(stored, monkeypatch):
    """The Documents page's Save sends the embedding settings every time (#532)."""
    loads = _counting_loader(monkeypatch)
    request = _request()

    _update(
        request,
        RAG_EMBEDDING_ENGINE='',
        RAG_EMBEDDING_MODEL='old/model',
        RAG_EMBEDDING_BATCH_SIZE=8,
        force_reload=False,
    )

    assert loads == []
    assert request.app.state.ef is OLD_EF
    # The other settings still apply: the embedding function is built again around the same model.
    assert request.app.state.EMBEDDING_FUNCTION is not OLD_EMBEDDING_FUNCTION
    assert stored['rag.embedding_batch_size'] == 8


def test_the_update_button_reloads_an_unchanged_model(stored, monkeypatch):
    loads = _counting_loader(monkeypatch)
    request = _request()

    _update(request, RAG_EMBEDDING_ENGINE='', RAG_EMBEDDING_MODEL='old/model')

    assert loads == ['old/model']
    assert request.app.state.ef is not OLD_EF


@pytest.mark.parametrize(
    ('model', 'loaded'),
    [('new/model', OLD_EF), ('old/model', None)],
    ids=['model_changed', 'nothing_loaded'],
)
def test_a_plain_save_loads_a_model_that_changed_or_is_not_loaded(stored, monkeypatch, model, loaded):
    loads = _counting_loader(monkeypatch)
    request = _request()
    request.app.state.ef = loaded

    _update(request, RAG_EMBEDDING_ENGINE='', RAG_EMBEDDING_MODEL=model, force_reload=False)

    assert loads == [model]
    assert request.app.state.ef is not None
    assert request.app.state.ef is not OLD_EF


def test_a_plain_save_loads_the_stored_model_when_another_one_is_loaded(stored, values, monkeypatch):
    """A config import stored a new name without loading it (#532)."""
    values['RAG_EMBEDDING_MODEL'] = 'imported/model'
    loads = _counting_loader(monkeypatch)
    request = _request()

    _update(request, RAG_EMBEDDING_ENGINE='', RAG_EMBEDDING_MODEL='imported/model', force_reload=False)

    assert loads == ['imported/model']
    assert request.app.state.ef_model == 'imported/model'


def test_a_blank_local_model_is_refused_and_nothing_saved(stored, monkeypatch):
    loads = _counting_loader(monkeypatch)
    request = _request()

    with pytest.raises(HTTPException) as raised:
        _update(request, RAG_EMBEDDING_ENGINE='', RAG_EMBEDDING_MODEL='  ', force_reload=False)

    assert raised.value.status_code == 400
    assert 'embedding model' in raised.value.detail.lower()
    assert stored == {}
    assert loads == []
    assert request.app.state.ef is OLD_EF


@pytest.mark.parametrize('batch_size', [0, -1, -2, None])
def test_a_batch_size_below_1_is_refused_and_nothing_changes(stored, monkeypatch, batch_size):
    """A saved 0 failed every embedding with an error, and -1 returned no vectors (#353)."""
    _loader(monkeypatch, fails=False)
    request = _request()

    with pytest.raises(HTTPException) as raised:
        _update(request, RAG_EMBEDDING_ENGINE='', RAG_EMBEDDING_MODEL='new/model', RAG_EMBEDDING_BATCH_SIZE=batch_size)

    assert raised.value.status_code == 400
    assert 'Embedding Batch Size must be a whole number of at least 1' in raised.value.detail
    assert stored == {}
    assert request.app.state.ef is OLD_EF
    assert request.app.state.EMBEDDING_FUNCTION is OLD_EMBEDDING_FUNCTION


def test_a_batch_size_of_1_or_more_is_saved(stored, monkeypatch):
    _loader(monkeypatch, fails=False)

    result = _update(_request(), RAG_EMBEDDING_ENGINE='', RAG_EMBEDDING_MODEL='new/model', RAG_EMBEDDING_BATCH_SIZE=1)
    assert result['RAG_EMBEDDING_BATCH_SIZE'] == 1
    assert stored['rag.embedding_batch_size'] == 1

    _update(_request(), RAG_EMBEDDING_ENGINE='', RAG_EMBEDDING_MODEL='new/model', RAG_EMBEDDING_BATCH_SIZE=64)
    assert stored['rag.embedding_batch_size'] == 64


def _external(**form):
    return {
        'RAG_EMBEDDING_ENGINE': 'openai',
        'RAG_EMBEDDING_MODEL': 'text-embedding-3-small',
        'openai_config': {'url': 'https://api.openai.com/v1', 'key': 'k'},
        **form,
    }


@pytest.mark.parametrize('concurrent', [-1, -5])
def test_negative_concurrent_requests_for_an_external_engine_are_refused_and_nothing_changes(
    stored, monkeypatch, concurrent
):
    """A saved -1 made asyncio.Semaphore raise on every external list embedding (#638)."""
    _loader(monkeypatch, fails=False)
    request = _request()

    with pytest.raises(HTTPException) as raised:
        _update(request, **_external(RAG_EMBEDDING_CONCURRENT_REQUESTS=concurrent))

    assert raised.value.status_code == 400
    assert 'Embedding Concurrent Requests must be a whole number of at least 0' in raised.value.detail
    assert stored == {}
    assert request.app.state.ef is OLD_EF
    assert request.app.state.EMBEDDING_FUNCTION is OLD_EMBEDDING_FUNCTION


@pytest.mark.parametrize('concurrent', [0, 4])
def test_concurrent_requests_of_0_or_more_are_saved(stored, monkeypatch, concurrent):
    _loader(monkeypatch, fails=False)

    _update(_request(), **_external(RAG_EMBEDDING_CONCURRENT_REQUESTS=concurrent))
    assert stored['rag.embedding_concurrent_requests'] == concurrent


def test_the_local_engine_saves_despite_negative_concurrent_requests_it_does_not_use(stored, monkeypatch):
    """Documents hides the field for the local engine and sends the stored value (an
    environment -1, say), so refusing it would block every save; it is replaced at use (#638)."""
    _loader(monkeypatch, fails=False)

    _update(
        _request(),
        RAG_EMBEDDING_ENGINE='',
        RAG_EMBEDDING_MODEL='new/model',
        RAG_EMBEDDING_BATCH_SIZE=1,
        RAG_EMBEDDING_CONCURRENT_REQUESTS=-1,
    )
    assert stored['rag.embedding_model'] == 'new/model'
