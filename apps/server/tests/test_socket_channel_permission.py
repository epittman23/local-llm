"""A socket joins channel rooms only under the rule the channel HTTP routes apply.

Channel rooms carry live channel messages. The HTTP routes refuse a user
when channels are disabled or when the admin-configured permissions deny
`features.channels` (routers/channels.py, check_channels_access). The socket
handlers checked only the environment's default permissions and never
checked whether channels were enabled. So a member kept receiving live
channel events after an admin turned the feature off. `user-join` and
`join-channels` now go through socket/main.py's may_join_channels. Found by
the 2026-10-23 security test pass.

The handlers are called directly with real tokens against users in the test
run's migrated SQLite database; the Socket.IO server's room and session
calls are replaced by a recorder.

Run from apps/server:

    python -m pytest tests/test_socket_channel_permission.py
"""

from __future__ import annotations

import asyncio
import copy
import datetime as dt
import uuid
from types import SimpleNamespace

import pytest

from local_llm.config import DEFAULT_USER_PERMISSIONS
from local_llm.models.config import Config
from local_llm.models.users import Users
from local_llm.socket import main as socket_main
from local_llm.utils.auth import create_token


def _run(coro):
    return asyncio.run(coro)


def _user(role: str) -> SimpleNamespace:
    uid = f'sockch-{role}-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, f'{role} name', f'{uid}@example.com', role=role))
    return SimpleNamespace(id=uid, token=create_token({'id': uid}, dt.timedelta(minutes=30)))


@pytest.fixture(scope='module')
def people():
    return SimpleNamespace(alice=_user('user'), admin=_user('admin'))


@pytest.fixture
def rooms(monkeypatch, people):
    """Rooms entered, by sid; every user is a member of one channel."""
    entered: dict[str, set[str]] = {}

    async def enter_room(sid, room, namespace=None):
        entered.setdefault(sid, set()).add(room)

    async def save_session(sid, session, namespace=None):
        return None

    async def get_channels_by_user_id(user_id, db=None):
        return [SimpleNamespace(id=f'c-{user_id}')]

    monkeypatch.setattr(socket_main.sio, 'enter_room', enter_room)
    monkeypatch.setattr(socket_main.sio, 'save_session', save_session)
    monkeypatch.setattr(socket_main.sio, 'get_environ', lambda sid, namespace=None: {})
    monkeypatch.setattr(socket_main.Channels, 'get_channels_by_user_id', get_channels_by_user_id)
    monkeypatch.setattr(socket_main, 'SESSION_POOL', {})
    monkeypatch.setattr(socket_main, 'REDIS', None)
    return entered


@pytest.fixture
def config(monkeypatch):
    """Config.get answering from these settings: channels on, users permitted."""
    settings = {'channels.enable': True, 'user.permissions': copy.deepcopy(DEFAULT_USER_PERMISSIONS)}
    settings['user.permissions']['features']['channels'] = True

    async def get(key, default=None):
        return settings.get(key, default)

    monkeypatch.setattr(Config, 'get', get)
    return settings


def _channel_rooms(rooms, sid):
    return {r for r in rooms.get(sid, set()) if r.startswith('channel:')}


@pytest.mark.parametrize('join', ['user_join', 'join_channel'])
def test_a_permitted_user_joins_their_channels(rooms, config, people, join):
    _run(getattr(socket_main, join)('s1', {'auth': {'token': people.alice.token}}))
    assert _channel_rooms(rooms, 's1') == {f'channel:c-{people.alice.id}'}


@pytest.mark.parametrize('join', ['user_join', 'join_channel'])
def test_the_configured_permission_is_what_counts(rooms, config, people, join):
    config['user.permissions']['features']['channels'] = False
    _run(getattr(socket_main, join)('s1', {'auth': {'token': people.alice.token}}))
    assert _channel_rooms(rooms, 's1') == set()


@pytest.mark.parametrize('join', ['user_join', 'join_channel'])
def test_no_one_joins_channel_rooms_while_channels_are_disabled(rooms, config, people, join):
    config['channels.enable'] = False
    for sid, person in (('s1', people.alice), ('s2', people.admin)):
        _run(getattr(socket_main, join)(sid, {'auth': {'token': person.token}}))
        assert _channel_rooms(rooms, sid) == set()


def test_an_admin_joins_without_the_user_permission(rooms, config, people):
    config['user.permissions']['features']['channels'] = False
    _run(socket_main.user_join('s1', {'auth': {'token': people.admin.token}}))
    assert _channel_rooms(rooms, 's1') == {f'channel:c-{people.admin.id}'}
