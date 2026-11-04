"""The prompt version diff endpoint is reachable (#223).

`GET /id/{prompt_id}/history/diff` was registered after
`GET /id/{prompt_id}/history/{history_id}`, so FastAPI matched the earlier
route with `history_id='diff'`, found no such entry and answered 404. The
diff route is now registered first. A minimal app mounts only the prompts
router, with the user and database dependencies overridden and the model
calls stubbed.

Run from apps/server:

    python -m pytest tests/test_prompt_diff_route.py
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.internal.db import get_async_session
from local_llm.routers import prompts as prompts_router
from local_llm.utils.auth import get_verified_user

USER = SimpleNamespace(id='u1', role='user')


@pytest.fixture
def client(monkeypatch):
    calls = []

    async def get_prompt(prompt_id, db=None):
        return SimpleNamespace(id=prompt_id, user_id=USER.id)

    async def compute_diff(from_id, to_id, prompt_id, db=None):
        calls.append(('diff', from_id, to_id, prompt_id))
        return {'from_id': from_id, 'to_id': to_id, 'diff': []}

    async def get_entry(history_id, db=None):
        calls.append(('entry', history_id))
        return None

    monkeypatch.setattr(prompts_router.Prompts, 'get_prompt_by_id', get_prompt)
    monkeypatch.setattr(prompts_router.PromptHistories, 'compute_diff', compute_diff)
    monkeypatch.setattr(prompts_router.PromptHistories, 'get_history_entry_by_id', get_entry)

    app = FastAPI()
    app.include_router(prompts_router.router)
    app.dependency_overrides[get_verified_user] = lambda: USER

    async def no_session():
        yield None

    app.dependency_overrides[get_async_session] = no_session
    return TestClient(app), calls


def test_the_diff_route_answers_with_the_diff(client):
    http, calls = client

    response = http.get('/id/p1/history/diff', params={'from_id': 'a', 'to_id': 'b'})

    assert response.status_code == 200
    assert response.json() == {'from_id': 'a', 'to_id': 'b', 'diff': []}
    assert calls == [('diff', 'a', 'b', 'p1')]


def test_a_history_entry_is_still_reached_by_its_id(client):
    http, calls = client

    response = http.get('/id/p1/history/h1')

    assert response.status_code == 404
    assert calls == [('entry', 'h1')]
