"""Importing a config refuses an unusable JWT expiry, as the admin form does (#242).

An imported `auth.jwt_expiry` such as '-1h' expired every new session at
once and locked everyone out, with no way back through the UI.

Run from apps/server:

    python -m pytest tests/test_config_import_jwt_expiry.py
"""

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.routers import configs as configs_router
from local_llm.utils.auth import get_admin_user


@pytest.fixture
def client(monkeypatch):
    saved: list[dict] = []

    async def upsert(updates):
        saved.append(updates)

    async def nothing(*_a, **_k):
        return None

    async def get_many(*keys):
        return {}

    monkeypatch.setattr(configs_router.Config, 'upsert', upsert)
    monkeypatch.setattr(configs_router.Config, 'get_many', get_many)
    monkeypatch.setattr(configs_router, 'publish_event', nothing)
    app = FastAPI()
    app.include_router(configs_router.router, prefix='/configs')
    app.dependency_overrides[get_admin_user] = lambda: SimpleNamespace(id='admin', role='admin')
    c = TestClient(app)
    c.saved = saved
    return c


def test_an_unusable_jwt_expiry_is_refused_and_nothing_is_imported(client):
    r = client.post('/configs/import', json={'config': {'auth.jwt_expiry': '-1h', 'ui.name': 'x'}})

    assert r.status_code == 400
    assert client.saved == []


def test_a_valid_jwt_expiry_is_imported(client):
    client.post('/configs/import', json={'config': {'auth.jwt_expiry': '4w'}})

    assert client.saved == [{'auth.jwt_expiry': '4w'}]
