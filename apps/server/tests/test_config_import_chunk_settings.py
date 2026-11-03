"""Importing a config refuses chunk settings the text splitters cannot use, as Documents does (#235).

`/configs/import` upserts any keys, so an imported `rag.chunk_size` of 0,
or an overlap that is not smaller than the size, would break every upload
and reindex the same way a Documents save used to.

Run from apps/server:

    python -m pytest tests/test_config_import_chunk_settings.py
"""

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.routers import configs as configs_router
from local_llm.utils.auth import get_admin_user

STORED = {'rag.chunk_size': 1000, 'rag.chunk_overlap': 100}


@pytest.fixture
def client(monkeypatch):
    saved: list[dict] = []

    async def upsert(updates):
        saved.append(updates)

    async def nothing(*_a, **_k):
        return None

    async def get(key, default=None):
        return STORED.get(key, default)

    async def get_all():
        return {}

    monkeypatch.setattr(configs_router.Config, 'upsert', upsert)
    monkeypatch.setattr(configs_router.Config, 'get', get)
    monkeypatch.setattr(configs_router.Config, 'get_all', get_all)
    monkeypatch.setattr(configs_router, 'publish_event', nothing)
    app = FastAPI()
    app.include_router(configs_router.router, prefix='/configs')
    app.dependency_overrides[get_admin_user] = lambda: SimpleNamespace(id='admin', role='admin')
    c = TestClient(app)
    c.saved = saved
    return c


@pytest.mark.parametrize(
    'imported',
    [
        {'rag.chunk_size': 0},
        {'rag.chunk_size': 100, 'rag.chunk_overlap': 200},
        # Checked against the stored size of 1000.
        {'rag.chunk_overlap': 1000},
        # And against the stored overlap of 100.
        {'rag.chunk_size': 100},
    ],
)
def test_unusable_chunk_settings_are_refused_and_nothing_is_imported(client, imported):
    r = client.post('/configs/import', json={'config': {**imported, 'ui.name': 'x'}})

    assert r.status_code == 400
    assert 'Chunk' in r.json()['detail']
    assert client.saved == []


def test_working_chunk_settings_are_imported(client):
    r = client.post('/configs/import', json={'config': {'rag.chunk_size': 500, 'rag.chunk_overlap': 50}})

    assert r.status_code == 200
    assert client.saved == [{'rag.chunk_size': 500, 'rag.chunk_overlap': 50}]


def test_an_import_without_chunk_settings_is_not_checked_for_them(client):
    r = client.post('/configs/import', json={'config': {'ui.name': 'x'}})

    assert r.status_code == 200
    assert client.saved == [{'ui.name': 'x'}]
