"""Chat list pages start at 1, and anything below is refused with a 422 (#154).

The chats routes computed `skip = (page - 1) * limit` with no lower bound,
so `?page=0` gave a negative OFFSET, which Postgres refuses ("OFFSET must not
be negative"), and the request failed with a 400 or 500 instead of a plain
validation error. `page` (and the usage stats' `items_per_page`) is now
declared with `ge=1`, so FastAPI answers 422 before the route runs. The
same goes for the body of POST /tags, whose `skip` and `limit` reached
OFFSET and LIMIT unchecked: `skip` is now `ge=0` and `limit` `ge=1`.

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
    ('path', 'name'),
    [
        ('/list?page=0', 'page'),
        ('/?page=-1', 'page'),
        ('/stats/usage?page=0', 'page'),
        ('/stats/usage?items_per_page=0', 'items_per_page'),
        ('/list/user/u2?page=0', 'page'),
        ('/search?text=x&page=0', 'page'),
        ('/folder/f1/list?page=0', 'page'),
        ('/archived?page=0', 'page'),
        ('/shared?page=-3', 'page'),
    ],
)
def test_a_page_below_one_is_a_validation_error(client, path, name):
    response = client.get(path)

    assert response.status_code == 422
    assert response.json()['detail'][0]['loc'][-1] == name


@pytest.mark.parametrize(
    ('body', 'name'),
    [
        ({'name': 'x', 'skip': -1}, 'skip'),
        ({'name': 'x', 'limit': -1}, 'limit'),
        ({'name': 'x', 'limit': 0}, 'limit'),
    ],
)
def test_a_negative_tag_list_offset_or_limit_is_a_validation_error(client, body, name):
    response = client.post('/tags', json=body)

    assert response.status_code == 422
    assert response.json()['detail'][0]['loc'] == ['body', name]


def test_the_first_page_is_still_accepted(client, monkeypatch):
    calls = []

    async def chat_list(user_id, **kwargs):
        calls.append(kwargs)
        return []

    monkeypatch.setattr(chats_router.Chats, 'get_chat_title_id_list_by_user_id', chat_list)

    response = client.get('/list?page=1')

    assert response.status_code == 200
    assert response.json() == []
    assert (calls[0]['skip'], calls[0]['limit']) == (0, 60)


def test_a_tag_list_from_the_start_is_still_accepted(client, monkeypatch):
    calls = []

    async def tag_list(user_id, name, skip, limit, db=None):
        calls.append((name, skip, limit))
        return []

    async def delete_tag(name, user_id, db=None):
        return True

    monkeypatch.setattr(chats_router.Chats, 'get_chat_list_by_user_id_and_tag_name', tag_list)
    monkeypatch.setattr(chats_router.Tags, 'delete_tag_by_name_and_user_id', delete_tag)

    response = client.post('/tags', json={'name': 'x', 'skip': 0, 'limit': 1})

    assert response.status_code == 200
    assert calls == [('x', 0, 1)]
