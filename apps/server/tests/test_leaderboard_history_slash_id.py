"""A model id with a slash reaches the leaderboard history route (#913).

OpenRouter ids look like `qwen/qwen3.6-27b`. The client encodes the slash
(`qwen%2Fqwen3.6-27b`), but the path is decoded before routing, so a plain
`{model_id}` segment never matched and the request fell through to the
SPA's index.html with a 200. The route now takes `{model_id:path}`, as the
analytics model routes already do, and the URL and response are unchanged.

A minimal app mounts only the evaluations router, with the admin and
database dependencies overridden and the history query stubbed.

Run from apps/server:

    python -m pytest tests/test_leaderboard_history_slash_id.py
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.internal.db import get_async_session
from local_llm.routers import evaluations as evaluations_router
from local_llm.utils.auth import get_admin_user

ADMIN = SimpleNamespace(id='admin', role='admin')


@pytest.fixture
def calls(monkeypatch):
    seen: list[tuple[str, int]] = []

    async def history(model_id, days=30, db=None):
        seen.append((model_id, days))
        return [{'date': '2026-11-15', 'won': 2, 'lost': 1}]

    monkeypatch.setattr(evaluations_router.Feedbacks, 'get_model_evaluation_history', history)
    return seen


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(evaluations_router.router)
    app.dependency_overrides[get_admin_user] = lambda: ADMIN

    async def no_session():
        yield None

    app.dependency_overrides[get_async_session] = no_session
    return TestClient(app)


@pytest.mark.parametrize('path', ['/leaderboard/qwen%2Fqwen3.6-27b/history', '/leaderboard/qwen/qwen3.6-27b/history'])
def test_a_slash_id_gets_its_history(client, calls, path):
    response = client.get(f'{path}?days=7')

    assert response.status_code == 200
    assert response.json() == {
        'model_id': 'qwen/qwen3.6-27b',
        'history': [{'date': '2026-11-15', 'won': 2, 'lost': 1}],
    }
    assert calls == [('qwen/qwen3.6-27b', 7)]


def test_a_plain_id_still_works(client, calls):
    response = client.get('/leaderboard/gpt-4o/history')

    assert response.status_code == 200
    assert response.json()['model_id'] == 'gpt-4o'
    assert calls == [('gpt-4o', 30)]
