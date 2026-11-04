"""The prompt version diff endpoint is reachable (#223).

`GET /id/{prompt_id}/history/diff` was registered after
`GET /id/{prompt_id}/history/{history_id}`, so FastAPI matched the earlier
route with `history_id='diff'`, found no such entry and answered 404. The
diff route is now registered first. The history entry routes it moved past
are checked too, so the move changes nothing for them.

A minimal app mounts only the prompts router, with the user and database
dependencies overridden and the model calls stubbed.

Run from apps/server:

    python -m pytest tests/test_prompt_diff_route.py
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.internal.db import get_async_session
from local_llm.models.prompt_history import PromptHistoryModel
from local_llm.routers import prompts as prompts_router
from local_llm.utils.auth import get_verified_user

USER = SimpleNamespace(id='u1', role='user')
# The shape PromptHistories.compute_diff returns.
DIFF = {
    'from_snapshot': {'content': 'a'},
    'to_snapshot': {'content': 'b'},
    'content_diff': ['-a', '+b'],
    'name_changed': False,
}


@pytest.fixture
def client(monkeypatch):
    calls = []
    state = SimpleNamespace(entry=None, deleted=True)

    async def get_prompt(prompt_id, db=None):
        return SimpleNamespace(id=prompt_id, user_id=USER.id, version_id='live')

    async def compute_diff(from_id, to_id, prompt_id, db=None):
        calls.append(('diff', from_id, to_id, prompt_id))
        return DIFF

    async def get_entry(history_id, db=None):
        calls.append(('entry', history_id))
        return state.entry

    async def delete_entry(history_id, prompt_id, db=None):
        calls.append(('delete', history_id, prompt_id))
        return state.deleted

    monkeypatch.setattr(prompts_router.Prompts, 'get_prompt_by_id', get_prompt)
    monkeypatch.setattr(prompts_router.PromptHistories, 'compute_diff', compute_diff)
    monkeypatch.setattr(prompts_router.PromptHistories, 'get_history_entry_by_id', get_entry)
    monkeypatch.setattr(prompts_router.PromptHistories, 'delete_history_entry', delete_entry)

    app = FastAPI()
    app.include_router(prompts_router.router)
    app.dependency_overrides[get_verified_user] = lambda: USER

    async def no_session():
        yield None

    app.dependency_overrides[get_async_session] = no_session
    return TestClient(app), calls, state


def test_the_diff_route_answers_with_the_diff(client):
    http, calls, _ = client

    response = http.get('/id/p1/history/diff', params={'from_id': 'a', 'to_id': 'b'})

    assert response.status_code == 200
    assert response.json() == DIFF
    assert calls == [('diff', 'a', 'b', 'p1')]


def test_a_history_entry_is_still_reached_by_its_id(client):
    http, calls, state = client
    state.entry = PromptHistoryModel(id='h1', prompt_id='p1', snapshot={'content': 'a'}, user_id=USER.id, created_at=1)

    response = http.get('/id/p1/history/h1')

    assert response.status_code == 200
    assert response.json()['id'] == 'h1'
    assert calls == [('entry', 'h1')]


def test_a_missing_history_entry_is_404(client):
    http, calls, _ = client

    assert http.get('/id/p1/history/h1').status_code == 404
    assert calls == [('entry', 'h1')]


def test_a_history_entry_is_deleted_by_its_id(client):
    http, calls, _ = client

    response = http.delete('/id/p1/history/h1')

    assert response.status_code == 200
    assert response.json() is True
    assert calls == [('delete', 'h1', 'p1')]


def test_the_live_version_cannot_be_deleted(client):
    http, calls, _ = client

    assert http.delete('/id/p1/history/live').status_code == 400
    assert calls == []


def test_deleting_a_missing_entry_is_404(client):
    http, calls, state = client
    state.deleted = False

    assert http.delete('/id/p1/history/h1').status_code == 404
    assert calls == [('delete', 'h1', 'p1')]
