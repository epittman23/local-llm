"""Importing a config refuses an embedding batch size below 1, as Documents does (#353).

`/configs/import` upserts any keys, so an imported `rag.embedding_batch_size`
of 0 or less (or none) would fail every embedding the way a Documents save
used to: uploads at once, queries from the next restart.

Run from apps/server:

    python -m pytest tests/test_config_import_embedding_batch_size.py
"""

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.routers import configs as configs_router
from local_llm.utils.auth import get_admin_user
from local_llm.utils.misc import embedding_batch_size_error


@pytest.fixture
def client(monkeypatch):
    saved: list[dict] = []

    async def upsert(updates):
        saved.append(updates)

    async def nothing(*_a, **_k):
        return None

    async def get_all():
        return {}

    monkeypatch.setattr(configs_router.Config, 'upsert', upsert)
    monkeypatch.setattr(configs_router.Config, 'get_all', get_all)
    monkeypatch.setattr(configs_router, 'publish_event', nothing)
    app = FastAPI()
    app.include_router(configs_router.router, prefix='/configs')
    app.dependency_overrides[get_admin_user] = lambda: SimpleNamespace(id='admin', role='admin')
    c = TestClient(app)
    c.saved = saved
    return c


@pytest.mark.parametrize('batch_size', [0, -1, None, '8', 1.5, True])
def test_an_unusable_batch_size_is_refused_and_nothing_is_imported(client, batch_size):
    r = client.post('/configs/import', json={'config': {'rag.embedding_batch_size': batch_size, 'ui.name': 'x'}})

    assert r.status_code == 400
    assert 'Embedding Batch Size' in r.json()['detail']
    assert client.saved == []


def test_a_batch_size_of_1_or_more_is_imported(client):
    r = client.post('/configs/import', json={'config': {'rag.embedding_batch_size': 32}})

    assert r.status_code == 200
    assert client.saved == [{'rag.embedding_batch_size': 32}]


def test_the_check_names_the_value_refused():
    assert embedding_batch_size_error(1) is None
    assert embedding_batch_size_error(0) == 'Embedding Batch Size must be a whole number of at least 1 (got 0).'
