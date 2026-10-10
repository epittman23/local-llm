"""Regression test for docs/history/bug-review-2026-09-27.md H1.

A note content save that does not send `access_grants` must not reach the
model layer with the field marked as set: update_note_by_id dumps with
exclude_unset, and a set `access_grants: None` used to delete every grant.

Database-free: the router's collaborators are monkeypatched and only the
form it hands to Notes.update_note_by_id is inspected.

    python -m pytest tests/test_notes_access_grants.py
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from open_webui.internal.db import get_async_session
from open_webui.routers import notes as notes_router
from open_webui.utils.auth import get_verified_user

ADMIN = SimpleNamespace(id='admin-1', role='admin', email='admin@example.com')


class _Note(SimpleNamespace):
    def model_dump(self):
        return dict(self.__dict__)


@pytest.fixture
def captured(monkeypatch):
    seen: dict = {}

    async def get_note_by_id(id, db=None):
        return _Note(id=id, user_id='owner', data={}, title='t')

    async def update_note_by_id(id, form_data, db=None):
        seen['fields_set'] = set(form_data.model_fields_set)
        seen['dump'] = form_data.model_dump(exclude_unset=True)
        return _Note(id=id, user_id='owner', data=form_data.data, title=form_data.title, created_at=1, updated_at=1)

    async def get_pinned_note_ids(user_id, db=None):
        return []

    async def filter_allowed(*args, **kwargs):
        seen['filtered'] = True
        return args[3]

    async def noop(*args, **kwargs):
        return None

    monkeypatch.setattr(notes_router.Notes, 'get_note_by_id', get_note_by_id)
    monkeypatch.setattr(notes_router.Notes, 'update_note_by_id', update_note_by_id)
    monkeypatch.setattr(notes_router.Notes, 'get_pinned_note_ids', get_pinned_note_ids)
    monkeypatch.setattr(notes_router, 'filter_allowed_access_grants', filter_allowed)
    monkeypatch.setattr(notes_router.sio, 'emit', noop)
    monkeypatch.setattr(notes_router, 'publish_event', noop)

    async def config_get(key):
        return {}

    monkeypatch.setattr(notes_router.Config, 'get', config_get)
    return seen


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(notes_router.router, prefix='/notes')
    app.dependency_overrides[get_verified_user] = lambda: ADMIN
    app.dependency_overrides[get_async_session] = lambda: None
    return TestClient(app)


def test_content_save_without_grants_leaves_them_unset(client, captured):
    res = client.post('/notes/n1/update', json={'title': 't', 'data': {'content': {'md': 'x'}}})
    assert res.status_code == 200, res.text
    assert 'access_grants' not in captured['fields_set']
    assert 'access_grants' not in captured['dump']
    assert 'filtered' not in captured


def test_explicit_grants_are_filtered_and_passed_through(client, captured):
    grants = [{'principal_type': 'user', 'principal_id': 'u2', 'permission': 'read'}]
    res = client.post('/notes/n1/update', json={'title': 't', 'access_grants': grants})
    assert res.status_code == 200, res.text
    assert captured['filtered'] is True
    assert captured['dump']['access_grants'] == grants
