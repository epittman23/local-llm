"""Knowledge directories: a parent or target must belong to the same knowledge base.

Run from apps/server:

    python -m pytest tests/test_knowledge_directory_scope.py
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.internal.db import get_async_session
from local_llm.routers import knowledge as knowledge_router
from local_llm.utils.auth import get_verified_user

USER = SimpleNamespace(id='u1', role='user')
DIRS = {
    'mine': SimpleNamespace(id='mine', knowledge_id='kb1', name='Mine', parent_id=None),
    'theirs': SimpleNamespace(id='theirs', knowledge_id='kb2', name='Theirs', parent_id=None),
}


@pytest.fixture
def client(monkeypatch):
    calls = []

    async def write_ok(*_a, **_k):
        return SimpleNamespace(id='kb1')

    async def get_dir(dir_id, db=None):
        return DIRS.get(dir_id)

    async def create_dir(**k):
        calls.append(('create', k['parent_id']))
        return SimpleNamespace(
            id='new', knowledge_id='kb1', name=k['name'], parent_id=k['parent_id'], user_id='u1',
            created_at=1, updated_at=1,
        )  # fmt: skip

    async def update_dir(**k):
        calls.append(('update', k['parent_id']))
        return None

    async def publish(*_a, **_k):
        return None

    monkeypatch.setattr(knowledge_router, '_verify_knowledge_write_access', write_ok)
    monkeypatch.setattr(knowledge_router.Knowledges, 'get_directory_by_id', get_dir)
    monkeypatch.setattr(knowledge_router.Knowledges, 'create_directory', create_dir)
    monkeypatch.setattr(knowledge_router.Knowledges, 'update_directory', update_dir)
    monkeypatch.setattr(knowledge_router, 'publish_event', publish)

    app = FastAPI()
    app.include_router(knowledge_router.router, prefix='/knowledge')
    app.dependency_overrides[get_verified_user] = lambda: USER
    app.dependency_overrides[get_async_session] = lambda: None
    c = TestClient(app)
    c.calls = calls
    return c


def test_create_under_another_bases_directory_is_refused(client):
    r = client.post('/knowledge/kb1/dirs/create', json={'name': 'x', 'parent_id': 'theirs'})
    assert r.status_code == 404 and client.calls == []


def test_create_under_a_missing_directory_is_refused(client):
    assert client.post('/knowledge/kb1/dirs/create', json={'name': 'x', 'parent_id': 'nope'}).status_code == 404


def test_create_at_root_or_under_this_base_works(client):
    assert client.post('/knowledge/kb1/dirs/create', json={'name': 'x'}).status_code == 200
    assert client.post('/knowledge/kb1/dirs/create', json={'name': 'y', 'parent_id': 'mine'}).status_code == 200
    assert client.calls == [('create', None), ('create', 'mine')]


def test_moving_a_directory_under_another_base_is_refused(client):
    r = client.post('/knowledge/kb1/dirs/mine/update', json={'parent_id': 'theirs'})
    assert r.status_code == 404 and client.calls == []
