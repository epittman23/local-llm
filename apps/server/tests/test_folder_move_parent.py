"""Moving a folder checks the new parent as creating one does.

Run from apps/server:

    python -m pytest tests/test_folder_move_parent.py
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.internal.db import get_async_session
from local_llm.routers import folders as folders_router
from local_llm.utils.auth import get_verified_user

USER = SimpleNamespace(id='u1', role='user')
FOLDERS = {
    'mine': SimpleNamespace(id='mine', user_id='u1', name='Mine', parent_id=None),
    'other-target': SimpleNamespace(id='other-target', user_id='u1', name='Target', parent_id=None),
    'theirs': SimpleNamespace(id='theirs', user_id='u2', name='Theirs', parent_id=None),
}


@pytest.fixture
def client(monkeypatch):
    moved = []

    async def allowed(*_a, **_k):
        return None

    async def by_id_and_user(fid, uid, db=None):
        f = FOLDERS.get(fid)
        return f if f and f.user_id == uid else None

    async def by_id(fid, db=None):
        return FOLDERS.get(fid)

    async def none(*_a, **_k):
        return None

    async def subtree(*_a, **_k):
        return []

    async def no_access(*_a, **_k):
        return False

    async def update(fid, uid, parent_id, db=None):
        moved.append((fid, parent_id))
        return {'id': fid, 'parent_id': parent_id}

    async def publish(*_a, **_k):
        return None

    monkeypatch.setattr(folders_router, 'check_folders_permission', allowed)
    monkeypatch.setattr(folders_router.Folders, 'get_folder_by_id_and_user_id', by_id_and_user)
    monkeypatch.setattr(folders_router.Folders, 'get_folder_by_id', by_id)
    monkeypatch.setattr(folders_router.Folders, 'get_folder_by_parent_id_and_user_id_and_name', none)
    monkeypatch.setattr(folders_router.Folders, 'get_folder_ids_by_id_and_user_id_in_subtree', subtree)
    monkeypatch.setattr(folders_router.Folders, 'update_folder_parent_id_by_id_and_user_id', update)
    monkeypatch.setattr(folders_router, '_has_folder_access', no_access)
    monkeypatch.setattr(folders_router, 'publish_event', publish)

    app = FastAPI()
    app.include_router(folders_router.router, prefix='/folders')
    app.dependency_overrides[get_verified_user] = lambda: USER
    app.dependency_overrides[get_async_session] = lambda: None
    c = TestClient(app)
    c.moved = moved
    return c


def test_moving_under_another_users_folder_is_refused(client):
    r = client.post('/folders/mine/update/parent', json={'parent_id': 'theirs'})
    assert r.status_code == 403 and client.moved == []


def test_moving_under_a_nonexistent_folder_is_refused(client):
    r = client.post('/folders/mine/update/parent', json={'parent_id': 'missing'})
    assert r.status_code == 404 and client.moved == []


def test_moving_under_ones_own_folder_still_works(client):
    r = client.post('/folders/mine/update/parent', json={'parent_id': 'other-target'})
    assert r.status_code == 200 and client.moved == [('mine', 'other-target')]
