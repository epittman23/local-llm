"""No copy of a chat is taken while a reply in it is still streaming (#336).

Fork already refused with a 409; clone, share and cloning a share copied the
chat verbatim, unfinished ``done: False`` placeholder included, and the copy
then showed a truncated reply as finished. Requests go through the real
router and auth against the test run's migrated database; only side effects
(events, the Redis task registry) are faked. Pinned:

- fork, clone and share refuse with a 409 while the chat has an active task
  ("Wait for ...") or, with no task, an assistant message that is not done,
  say one paused or orphaned ("Finish or stop ..."), and create or change
  nothing; another user still gets the 401 the routes give non-owners;
- clone and share check the chat JSON they copy as well as the chat_message
  rows, since the two can disagree;
- re-sharing mid-stream keeps the earlier snapshot as it was;
- cloning a share refuses a snapshot that holds an unfinished reply, but not
  a finished snapshot of a chat whose owner has a new reply streaming; an
  admin cloning a live chat by id is checked like clone.

Run from apps/server:

    python -m pytest tests/test_chat_unfinished_reply_copies.py
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
from sqlalchemy import update

from local_llm.config import DEFAULT_USER_PERMISSIONS
from local_llm.internal.db import get_async_db_context
from local_llm.models.chat_messages import ChatMessages
from local_llm.models.chats import Chat, ChatForm, Chats
from local_llm.models.config import Config
from local_llm.models.shared_chats import SharedChats
from local_llm.models.users import Users
from local_llm.routers import chats as chats_router
from local_llm.utils.auth import create_token


def _run(coro):
    return asyncio.run(coro)


def _user(role: str) -> SimpleNamespace:
    uid = f'unfinished-{role}-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, role, f'{uid}@example.com', role=role))
    token = create_token({'id': uid}, dt.timedelta(minutes=30))
    return SimpleNamespace(id=uid, headers={'Authorization': f'Bearer {token}'})


@pytest.fixture(scope='module')
def owner() -> SimpleNamespace:
    return _user('user')


@pytest.fixture(scope='module')
def other() -> SimpleNamespace:
    return _user('user')


@pytest.fixture(scope='module')
def admin() -> SimpleNamespace:
    return _user('admin')


WAIT = 'Wait for the current response to finish before {}.'
STOP = 'Finish or stop the current response before {}.'
STALE_SHARE = 'This share holds an unfinished response; its owner needs to share the chat again.'


def _history(done: bool) -> dict:
    return {
        'currentId': 'm2',
        'messages': {
            'm1': {'id': 'm1', 'parentId': None, 'childrenIds': ['m2'], 'role': 'user', 'content': 'question'},
            'm2': {
                'id': 'm2',
                'parentId': 'm1',
                'childrenIds': [],
                'role': 'assistant',
                'content': 'answer' if done else 'half an ans',
                'done': done,
            },
        },
    }


def _chat(owner, *, done: bool) -> str:
    chat_id = str(uuid.uuid4())
    form = ChatForm(chat={'title': 'chat', 'history': _history(done), 'models': ['m'], 'tags': []})
    _run(Chats.insert_new_chat(chat_id, owner.id, form))
    return chat_id


def _set_json_done(chat_id: str, done: bool) -> None:
    """Change the reply's done flag in the chat JSON only, leaving its chat_message row."""

    async def go():
        chat = await Chats.get_chat_by_id(chat_id)
        assert chat
        data = copy.deepcopy(chat.chat)
        data['history']['messages']['m2']['done'] = done
        async with get_async_db_context() as session:
            await session.execute(update(Chat).where(Chat.id == chat_id).values(chat=data))
            await session.commit()

    _run(go())


def _share_id(chat_id: str) -> str | None:
    chat = _run(Chats.get_chat_by_id(chat_id))
    assert chat
    return chat.share_id


def _chat_count(owner) -> int:
    return len(_run(Chats.get_chats_by_user_id(owner.id)).items)


@pytest.fixture
def active(monkeypatch):
    """Which chat ids the faked Redis task registry reports a running task for."""
    ids: set[str] = set()

    async def has_active_tasks(_redis, chat_id):
        return chat_id in ids

    monkeypatch.setattr(chats_router, 'has_active_tasks', has_active_tasks)
    return ids


@pytest.fixture
def client(monkeypatch, active):
    async def nothing(*_a, **_k):
        return None

    permissions = copy.deepcopy(DEFAULT_USER_PERMISSIONS)
    real_get = Config.get

    async def get(key, default=None):
        return permissions if key == 'user.permissions' else await real_get(key, default)

    monkeypatch.setattr(Config, 'get', get)
    monkeypatch.setattr(chats_router, 'publish_event', nothing)
    app = FastAPI()
    app.state.redis = None
    app.include_router(chats_router.router, prefix='/chats')
    return TestClient(app)


COPIES = [
    ('fork', lambda chat_id: (f'/chats/{chat_id}/fork', {'message_id': 'm2'}), 'forking'),
    ('clone', lambda chat_id: (f'/chats/{chat_id}/clone', {'title': 'copy'}), 'cloning'),
    ('share', lambda chat_id: (f'/chats/{chat_id}/share', None), 'sharing'),
]


@pytest.mark.parametrize(('name', 'route', 'verb'), COPIES, ids=[c[0] for c in COPIES])
def test_an_unfinished_reply_is_never_copied(client, owner, name, route, verb):
    chat_id = _chat(owner, done=False)
    before = _chat_count(owner)
    path, body = route(chat_id)
    r = client.post(path, json=body, headers=owner.headers)
    assert r.status_code == 409, r.text
    assert r.json()['detail'] == STOP.format(verb)
    assert _chat_count(owner) == before
    assert _share_id(chat_id) is None


@pytest.mark.parametrize(('name', 'route', 'verb'), COPIES, ids=[c[0] for c in COPIES])
def test_a_running_task_blocks_the_copy(client, owner, active, name, route, verb):
    chat_id = _chat(owner, done=True)
    active.add(chat_id)
    before = _chat_count(owner)
    path, body = route(chat_id)
    r = client.post(path, json=body, headers=owner.headers)
    assert r.status_code == 409, r.text
    assert r.json()['detail'] == WAIT.format(verb)
    assert _chat_count(owner) == before
    assert _share_id(chat_id) is None


@pytest.mark.parametrize(('name', 'route', 'verb'), COPIES[1:], ids=[c[0] for c in COPIES[1:]])
@pytest.mark.parametrize(('json_done', 'rows_done'), [(False, True), (True, False)], ids=['json', 'rows'])
def test_clone_and_share_refuse_when_json_or_rows_hold_an_unfinished_reply(
    client, owner, name, route, verb, json_done, rows_done
):
    chat_id = _chat(owner, done=rows_done)
    _set_json_done(chat_id, json_done)
    assert _run(ChatMessages.has_unfinished_assistant_by_chat_id(chat_id)) is not rows_done
    before = _chat_count(owner)
    path, body = route(chat_id)
    r = client.post(path, json=body, headers=owner.headers)
    assert r.status_code == 409, r.text
    assert r.json()['detail'] == STOP.format(verb)
    assert _chat_count(owner) == before
    assert _share_id(chat_id) is None


@pytest.mark.parametrize(('name', 'route', 'verb'), COPIES, ids=[c[0] for c in COPIES])
def test_another_user_gets_401_not_409_on_a_streaming_chat(client, owner, other, active, name, route, verb):
    chat_id = _chat(owner, done=False)
    active.add(chat_id)
    path, body = route(chat_id)
    assert client.post(path, json=body, headers=other.headers).status_code == 401


@pytest.mark.parametrize(('name', 'route', 'verb'), COPIES, ids=[c[0] for c in COPIES])
def test_a_finished_chat_is_copied(client, owner, name, route, verb):
    chat_id = _chat(owner, done=True)
    path, body = route(chat_id)
    assert client.post(path, json=body, headers=owner.headers).status_code == 200


def test_resharing_mid_stream_keeps_the_earlier_snapshot(client, owner, active):
    chat_id = _chat(owner, done=True)
    share_id = client.post(f'/chats/{chat_id}/share', headers=owner.headers).json()['share_id']
    active.add(chat_id)
    r = client.post(f'/chats/{chat_id}/share', headers=owner.headers)
    assert r.status_code == 409
    snapshot = _run(SharedChats.get_by_id(share_id))
    assert snapshot
    assert snapshot.chat['history']['messages']['m2']['content'] == 'answer'


def test_cloning_a_share_refuses_a_snapshot_with_an_unfinished_reply(client, owner):
    chat_id = _chat(owner, done=False)
    shared = _run(SharedChats.create(chat_id, owner.id))
    assert shared
    before = _chat_count(owner)
    r = client.post(f'/chats/{shared.id}/clone/shared', headers=owner.headers)
    assert r.status_code == 409, r.text
    assert r.json()['detail'] == STALE_SHARE
    assert _chat_count(owner) == before


def test_cloning_a_finished_share_ignores_a_new_reply_streaming_in_its_chat(client, owner, active):
    chat_id = _chat(owner, done=True)
    share_id = client.post(f'/chats/{chat_id}/share', headers=owner.headers).json()['share_id']
    active.add(chat_id)
    r = client.post(f'/chats/{share_id}/clone/shared', headers=owner.headers)
    assert r.status_code == 200, r.text
    assert r.json()['chat']['history']['messages']['m2']['content'] == 'answer'


@pytest.mark.parametrize(('streaming', 'detail'), [(True, WAIT), (False, STOP)], ids=['task', 'unfinished'])
def test_an_admin_cloning_a_live_chat_by_id_is_checked_like_clone(
    client, owner, admin, active, monkeypatch, streaming, detail
):
    monkeypatch.setattr(chats_router, 'ENABLE_ADMIN_CHAT_ACCESS', True)
    chat_id = _chat(owner, done=streaming)
    if streaming:
        active.add(chat_id)
    before = _chat_count(admin)
    r = client.post(f'/chats/{chat_id}/clone/shared', headers=admin.headers)
    assert r.status_code == 409, r.text
    assert r.json()['detail'] == detail.format('cloning')
    assert _chat_count(admin) == before


def test_an_admin_clones_a_finished_live_chat_by_id(client, owner, admin, monkeypatch):
    monkeypatch.setattr(chats_router, 'ENABLE_ADMIN_CHAT_ACCESS', True)
    chat_id = _chat(owner, done=True)
    assert client.post(f'/chats/{chat_id}/clone/shared', headers=admin.headers).status_code == 200
