"""Chat list pages start at 1, and anything below is refused with a 422 (#154).

The chats routes computed `skip = (page - 1) * limit` with no lower bound,
so `?page=0` gave a negative OFFSET, which Postgres refuses ("OFFSET must not
be negative"), and the request failed with a 400 or 500 instead of a plain
validation error. `page` (and the usage stats' `items_per_page`) is now
declared with `ge=1`, so FastAPI answers 422 before the route runs.

A minimal app mounts only the chats router, with the user and database
dependencies overridden; a refused page never reaches the database.

Run from apps/server:

    python -m pytest tests/test_chat_page_validation.py
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.internal.db import get_async_session
from local_llm.routers import chats as chats_router
from local_llm.utils.auth import get_admin_user, get_verified_user

USER = SimpleNamespace(id='u1', role='admin')


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(chats_router.router)
    app.dependency_overrides[get_verified_user] = lambda: USER
    app.dependency_overrides[get_admin_user] = lambda: USER

    async def no_session():
        yield None

    app.dependency_overrides[get_async_session] = no_session
    return TestClient(app)


@pytest.mark.parametrize(
    'path',
    [
        '/list?page=0',
        '/?page=-1',
        '/stats/usage?page=0',
        '/stats/usage?items_per_page=0',
        '/list/user/u2?page=0',
        '/search?text=x&page=0',
        '/folder/f1/list?page=0',
        '/archived?page=0',
        '/shared?page=-3',
    ],
)
def test_a_page_below_one_is_a_validation_error(client, path):
    response = client.get(path)

    assert response.status_code == 422
    assert response.json()['detail'][0]['loc'][-1] in ('page', 'items_per_page')
