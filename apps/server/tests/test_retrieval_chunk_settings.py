"""Documents refuses chunk settings the text splitters cannot use (#235).

update_rag_config stored any CHUNK_SIZE and CHUNK_OVERLAP, and the
splitters then raised on every upload and reindex: a size of 0, or an
overlap larger than the size. A save with such values is now refused
before anything is written, checked against the stored value of the one
it leaves alone. A save that sets neither (Web Search) is not checked.
"""

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.routers import retrieval


@pytest.fixture
def stored(monkeypatch):
    """Retrieval settings as markers, with a working chunk size and overlap; returns what is written."""
    values = {field: f'stored:{field}' for field in retrieval.RETRIEVAL_CONFIG_KEYS}
    values.update(CHUNK_SIZE=1000, CHUNK_OVERLAP=100, ENABLE_RAG_HYBRID_SEARCH=False)
    written: dict = {}

    async def get_config():
        return retrieval.RetrievalConfig(dict(values))

    async def upsert(updates):
        written.update(updates)

    monkeypatch.setattr(retrieval, 'get_retrieval_config', get_config)
    monkeypatch.setattr(retrieval.Config, 'upsert', upsert)
    return written


def _save(form: retrieval.ConfigForm):
    state = SimpleNamespace(YOUTUBE_LOADER_TRANSLATION='stored', rf=None, RERANKING_FUNCTION=None)
    request = SimpleNamespace(app=SimpleNamespace(state=state))
    return asyncio.run(retrieval.update_rag_config(request, form, user=None))


@pytest.mark.parametrize(
    ('form', 'message'),
    [
        (retrieval.ConfigForm(CHUNK_SIZE=0), 'Chunk Size must be at least 1'),
        (retrieval.ConfigForm(CHUNK_SIZE=100, CHUNK_OVERLAP=200), 'Chunk Overlap must be smaller than Chunk Size'),
        (retrieval.ConfigForm(CHUNK_SIZE=100, CHUNK_OVERLAP=100), 'Chunk Overlap must be smaller than Chunk Size'),
        (retrieval.ConfigForm(CHUNK_OVERLAP=-1), 'Chunk Overlap cannot be negative'),
        # The stored size is 1000, so an overlap alone is checked against it.
        (retrieval.ConfigForm(CHUNK_OVERLAP=1000), 'Chunk Overlap must be smaller than Chunk Size'),
        # And a size alone against the stored overlap of 100.
        (retrieval.ConfigForm(CHUNK_SIZE=50), 'Chunk Overlap must be smaller than Chunk Size'),
    ],
)
def test_chunk_settings_the_splitters_cannot_use_are_refused_and_nothing_is_saved(stored, form, message):
    with pytest.raises(HTTPException) as refused:
        _save(form)

    assert refused.value.status_code == 400
    assert message in refused.value.detail
    assert stored == {}


def test_a_save_that_sets_no_chunk_value_is_not_held_up_by_the_stored_ones(stored, monkeypatch):
    # A Web Search save sends only its own block; a stored size of 0 from
    # before this check is for Documents to fix, not a reason to refuse it.
    async def broken_config():
        values = {field: f'stored:{field}' for field in retrieval.RETRIEVAL_CONFIG_KEYS}
        values.update(CHUNK_SIZE=0, CHUNK_OVERLAP=100, ENABLE_RAG_HYBRID_SEARCH=False)
        return retrieval.RetrievalConfig(values)

    monkeypatch.setattr(retrieval, 'get_retrieval_config', broken_config)

    response = _save(retrieval.ConfigForm(web=retrieval.WebConfig(ENABLE_WEB_SEARCH=True)))

    assert response['status'] is True


def test_working_chunk_settings_are_saved(stored):
    response = _save(retrieval.ConfigForm(CHUNK_SIZE=500, CHUNK_OVERLAP=50))

    assert (response['CHUNK_SIZE'], response['CHUNK_OVERLAP']) == (500, 50)
    assert stored[retrieval.RETRIEVAL_CONFIG_KEYS['CHUNK_SIZE']] == 500
    assert stored[retrieval.RETRIEVAL_CONFIG_KEYS['CHUNK_OVERLAP']] == 50
