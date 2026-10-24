"""ENABLE_ADMIN_CHAT_ACCESS keeps admins out of other users' chats on every chats route.

With the flag off, an admin could not read another user's chat
(GET /chats/{id}), yet three routes checked only the admin role and ignored
the flag: updating a message, deleting a message (which answers with the
whole chat) and sending a message event. Cloning a share skipped its grant
check for every admin, so an admin could copy any private share. All four
now follow the same rule as the rest of the router: the owner, or an admin
only while the flag is on (routers/chats.py, can_access_chat). Found by the
2026-10-23 security test pass.

Requests carry real tokens through the real auth dependencies, against users
and chats in the test run's migrated SQLite database; only side effects
(events, task cancellation, live streams) are faked.

Run from apps/server:

    python -m pytest tests/test_admin_chat_access_routes.py
"""

from __future__ import annotations

import asyncio
import copy
import datetime as dt
import uuid
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.config import DEFAULT_USER_PERMISSIONS
from local_llm.models import chats as chats_model
from local_llm.models.chats import ChatForm, Chats
from local_llm.models.config import Config
from local_llm.models.users import Users
from local_llm.routers import chats as chats_router
from local_llm.utils.auth import create_token

HISTORY = {
    'currentId': 'm2',
    'messages': {
        'm1': {'id': 'm1', 'parentId': None, 'childrenIds': ['m2'], 'role': 'user', 'content': 'private question'},
        'm2': {'id': 'm2', 'parentId': 'm1', 'childrenIds': [], 'role': 'assistant', 'content': 'private answer'},
    },
}


def _run(coro):
    return asyncio.run(coro)


def _user(role: str) -> SimpleNamespace:
    uid = f'adminacc-{role}-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, f'{role} user', f'{uid}@example.com', role=role))
    token = create_token({'id': uid}, dt.timedelta(minutes=30))
    return SimpleNamespace(id=uid, headers={'Authorization': f'Bearer {token}'})


@pytest.fixture(scope='module')
def people():
    return SimpleNamespace(owner=_user('user'), admin=_user('admin'))


def _chat(owner) -> str:
    chat_id = str(uuid.uuid4())
    form = ChatForm(chat={'title': 'secret', 'history': copy.deepcopy(HISTORY), 'models': ['m'], 'tags': []})
    _run(Chats.insert_new_chat(chat_id, owner.id, form))
    return chat_id


def _stored(chat_id: str) -> dict:
    return _run(Chats.get_chat_by_id(chat_id)).chat['history']['messages']


@pytest.fixture
def admin_chat_access(monkeypatch):
    def set_flag(value: bool):
        monkeypatch.setattr(chats_router, 'ENABLE_ADMIN_CHAT_ACCESS', value)
        monkeypatch.setattr(chats_model, 'ENABLE_ADMIN_CHAT_ACCESS', value)

    set_flag(False)
    return set_flag


@pytest.fixture
def events(monkeypatch):
    """Events the event route would emit into the owner's chat."""
    sent = []

    async def get_event_emitter(meta, *_args, **_kwargs):
        async def emit(event):
            sent.append((meta, event))

        return emit

    monkeypatch.setattr(chats_router, 'get_event_emitter', get_event_emitter)
    return sent


@pytest.fixture
def client(monkeypatch, admin_chat_access, events):
    overrides = {'user.permissions': copy.deepcopy(DEFAULT_USER_PERMISSIONS)}
    real_get = Config.get

    async def get(key, default=None):
        return overrides[key] if key in overrides else await real_get(key, default)

    async def nothing(*_a, **_k):
        return None

    async def no_streams(*_a, **_k):
        return []

    async def no_tasks(*_a, **_k):
        return False

    monkeypatch.setattr(Config, 'get', get)
    monkeypatch.setattr(chats_router, 'publish_event', nothing)
    monkeypatch.setattr(chats_router, 'stop_item_tasks', nothing)
    monkeypatch.setattr(chats_router, 'get_response_streams_by_chat_id', no_streams)
    monkeypatch.setattr(chats_router, 'get_chat_context_usage', nothing)
    monkeypatch.setattr(chats_router, 'has_active_tasks', no_tasks)
    app = FastAPI()
    app.state.redis = None
    app.include_router(chats_router.router, prefix='/chats')
    return TestClient(app)


# --- the message routes ---------------------------------------------------------


def test_an_admin_cannot_rewrite_a_message_with_admin_chat_access_off(client, people):
    chat_id = _chat(people.owner)
    r = client.post(
        f'/chats/{chat_id}/messages/m2', json={'content': 'admin rewrote this'}, headers=people.admin.headers
    )
    assert r.status_code == 401
    assert _stored(chat_id)['m2']['content'] == 'private answer'


def test_an_admin_cannot_delete_a_message_or_read_the_chat_through_it_with_access_off(client, people):
    chat_id = _chat(people.owner)
    r = client.delete(f'/chats/{chat_id}/messages/m2', headers=people.admin.headers)
    assert r.status_code == 401
    assert 'private' not in r.text
    assert set(_stored(chat_id)) == {'m1', 'm2'}
    # Deleting a message that doesn't exist answered with the whole chat.
    r = client.delete(f'/chats/{chat_id}/messages/does-not-exist', headers=people.admin.headers)
    assert r.status_code == 401
    assert 'private' not in r.text


def test_an_admin_cannot_send_events_into_a_users_chat_with_access_off(client, people, events):
    chat_id = _chat(people.owner)
    r = client.post(
        f'/chats/{chat_id}/messages/m2/event',
        json={'type': 'replace', 'data': {'content': 'injected'}},
        headers=people.admin.headers,
    )
    assert r.status_code == 401
    assert events == []


def test_with_admin_chat_access_on_an_admin_may_use_the_message_routes(client, people, admin_chat_access, events):
    admin_chat_access(True)
    chat_id = _chat(people.owner)
    r = client.post(f'/chats/{chat_id}/messages/m2', json={'content': 'moderated'}, headers=people.admin.headers)
    assert r.status_code == 200
    assert _stored(chat_id)['m2']['content'] == 'moderated'
    r = client.post(
        f'/chats/{chat_id}/messages/m2/event',
        json={'type': 'status', 'data': {'description': 'x'}},
        headers=people.admin.headers,
    )
    assert r.status_code == 200
    assert any(event.get('type') == 'status' for _, event in events)
    assert client.delete(f'/chats/{chat_id}/messages/m1', headers=people.admin.headers).status_code == 200


def test_the_owner_keeps_using_the_message_routes_with_access_off(client, people, events):
    chat_id = _chat(people.owner)
    r = client.post(f'/chats/{chat_id}/messages/m2', json={'content': 'edited'}, headers=people.owner.headers)
    assert r.status_code == 200
    assert _stored(chat_id)['m2']['content'] == 'edited'
    r = client.post(
        f'/chats/{chat_id}/messages/m2/event',
        json={'type': 'status', 'data': {'description': 'x'}},
        headers=people.owner.headers,
    )
    assert r.status_code == 200
    assert client.delete(f'/chats/{chat_id}/messages/m1', headers=people.owner.headers).status_code == 200


# --- cloning a share ---------------------------------------------------------------


def _share(client, owner, chat_id) -> str:
    r = client.post(f'/chats/{chat_id}/share', headers=owner.headers)
    assert r.status_code == 200, r.text
    return r.json()['share_id']


def test_an_admin_cannot_clone_a_private_share_without_a_grant_with_access_off(client, people):
    share_id = _share(client, people.owner, _chat(people.owner))
    assert client.get(f'/chats/share/{share_id}', headers=people.admin.headers).status_code == 401
    r = client.post(f'/chats/{share_id}/clone/shared', headers=people.admin.headers)
    assert r.status_code == 401
    assert 'private' not in r.text
    admin_chats = _run(Chats.get_chat_list_by_user_id(people.admin.id))
    assert all(c.title != 'secret' for c in admin_chats)


def test_with_admin_chat_access_on_an_admin_may_clone_a_share(client, people, admin_chat_access):
    share_id = _share(client, people.owner, _chat(people.owner))
    admin_chat_access(True)
    r = client.post(f'/chats/{share_id}/clone/shared', headers=people.admin.headers)
    assert r.status_code == 200
    assert r.json()['user_id'] == people.admin.id


def test_the_owner_may_clone_their_own_share(client, people):
    share_id = _share(client, people.owner, _chat(people.owner))
    r = client.post(f'/chats/{share_id}/clone/shared', headers=people.owner.headers)
    assert r.status_code == 200


def test_can_access_chat_is_the_owner_or_an_admin_with_the_flag(admin_chat_access):
    chat = SimpleNamespace(user_id='u1')
    owner, other = SimpleNamespace(id='u1', role='user'), SimpleNamespace(id='u2', role='user')
    admin = SimpleNamespace(id='a', role='admin')
    assert chats_router.can_access_chat(owner, chat)
    assert not chats_router.can_access_chat(other, chat)
    assert not chats_router.can_access_chat(admin, chat)
    admin_chat_access(True)
    assert chats_router.can_access_chat(admin, chat)
    assert not chats_router.can_access_chat(other, chat)
