"""Socket.IO: who a connection is, which rooms it may join, and who its events reach.

Rooms are where live events go (chat streams, channel messages, note edits),
so joining one is an access decision. The handlers in socket/main.py are
called directly with the real token check against users in the test run's
migrated SQLite database; the Socket.IO server's own methods are replaced by
a recorder. Pinned:

- a connection becomes a user only with a valid token of a verified user,
  and then joins that user's own room and no other; a pending user, a forged
  or revoked token, or no token leaves it anonymous;
- a note room needs ownership, a read grant or the admin role;
- channel events are taken only from a session already in that channel's
  room, and carry the sender's name and role, never more of their profile;
- marking a chat read works only on the caller's own chat;
- an event call from the server reaches only a live session of the user who
  made the request;
- disconnecting a user ends every session of theirs and nobody else's.

Run from apps/server:

    python -m pytest tests/test_socket_auth.py
"""

from __future__ import annotations

import asyncio
import copy
import datetime as dt
import uuid
from types import SimpleNamespace

import pytest

from local_llm.config import DEFAULT_USER_PERMISSIONS
from local_llm.env import REDIS_KEY_PREFIX
from local_llm.models.access_grants import AccessGrants
from local_llm.models.chats import ChatForm, Chats
from local_llm.models.config import Config
from local_llm.models.users import Users
from local_llm.socket import main as socket_main
from local_llm.utils.auth import create_token, decode_token


def _run(coro):
    return asyncio.run(coro)


def _user(role: str) -> SimpleNamespace:
    uid = f'sock-{role}-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, f'{role} name', f'{uid}@example.com', role=role))
    return SimpleNamespace(id=uid, role=role, token=create_token({'id': uid}, dt.timedelta(minutes=30)))


@pytest.fixture(scope='module')
def people():
    return SimpleNamespace(alice=_user('user'), bob=_user('user'), admin=_user('admin'), pending=_user('pending'))


@pytest.fixture
def sio(monkeypatch):
    """A recorder in place of the Socket.IO server's room, session and emit calls."""
    state = SimpleNamespace(rooms={}, sessions={}, emitted=[], called=[], disconnected=[], environ={})

    async def enter_room(sid, room, namespace=None):
        state.rooms.setdefault(room, {})[sid] = sid

    async def leave_room(sid, room, namespace=None):
        state.rooms.get(room, {}).pop(sid, None)

    async def save_session(sid, session, namespace=None):
        state.sessions[sid] = session

    async def get_session(sid, namespace=None):
        if sid not in state.sessions:
            raise KeyError(sid)
        return state.sessions[sid]

    async def emit(event, data=None, room=None, to=None, **_k):
        state.emitted.append((event, data, room or to))

    async def call(event, data=None, to=None, **_k):
        state.called.append((event, data, to))
        return {'answered_by': to}

    async def disconnect(sid, namespace=None):
        state.disconnected.append(sid)

    def get_environ(sid, namespace=None):
        return state.environ.get(sid)

    for name, fn in {
        'enter_room': enter_room,
        'leave_room': leave_room,
        'save_session': save_session,
        'get_session': get_session,
        'emit': emit,
        'call': call,
        'disconnect': disconnect,
        'get_environ': get_environ,
    }.items():
        monkeypatch.setattr(socket_main.sio, name, fn)
    monkeypatch.setattr(socket_main.sio, 'manager', SimpleNamespace(rooms={'/': state.rooms}))
    monkeypatch.setattr(socket_main, 'get_room_sid_map', lambda _manager, _ns, room: state.rooms.get(room))
    monkeypatch.setattr(socket_main, 'SESSION_POOL', {})
    monkeypatch.setattr(socket_main, 'USAGE_POOL', {})
    monkeypatch.setattr(socket_main, 'REDIS', None)
    return state


def _rooms_of(state, sid):
    return {room for room, members in state.rooms.items() if sid in members}


async def sio_enter(sid, room):
    await socket_main.sio.enter_room(sid, room)


def _connect(sid, token=None, environ=None):
    auth = {'token': token} if token is not None else None
    _run(socket_main.connect(sid, environ or {}, auth))


# --- connecting ---------------------------------------------------------------


def test_a_valid_token_makes_the_connection_that_user(sio, people):
    _connect('s1', people.alice.token)
    session_user = socket_main.SESSION_POOL['s1']
    assert session_user['id'] == people.alice.id and session_user['role'] == 'user'
    assert 'profile_image_url' not in session_user
    assert sio.sessions['s1']['user']['id'] == people.alice.id
    assert _rooms_of(sio, 's1') == {f'user:{people.alice.id}'}
    assert socket_main.get_user_id_from_session_pool('s1') == people.alice.id


@pytest.mark.parametrize('kind', ['none', 'empty', 'garbage', 'expired', 'pending', 'unknown user'])
def test_anything_else_leaves_the_connection_anonymous(sio, people, kind):
    token = {
        'none': None,
        'empty': '',
        'garbage': 'not.a.jwt',
        'expired': create_token({'id': people.alice.id}, dt.timedelta(seconds=-5)),
        'pending': people.pending.token,
        'unknown user': create_token({'id': 'nobody'}, dt.timedelta(minutes=5)),
    }[kind]
    _connect('s1', token)
    assert socket_main.SESSION_POOL == {} and sio.sessions == {} and sio.rooms == {}
    assert socket_main.get_user_id_from_session_pool('s1') is None


class _Redis:
    def __init__(self, store):
        self.store = store

    async def get(self, key):
        return self.store.get(key)


def test_a_revoked_token_is_refused_at_connect(sio, people):
    jti = decode_token(people.bob.token)['jti']
    app = SimpleNamespace(state=SimpleNamespace(redis=_Redis({f'{REDIS_KEY_PREFIX}:auth:token:{jti}:revoked': '1'})))
    _connect('s1', people.bob.token, environ={'asgi.scope': {'app': app}})
    assert socket_main.SESSION_POOL == {} and sio.rooms == {}
    # The same token on an app whose Redis has no revocation for it connects.
    app.state.redis = _Redis({})
    _connect('s2', people.bob.token, environ={'asgi.scope': {'app': app}})
    assert socket_main.SESSION_POOL['s2']['id'] == people.bob.id


@pytest.fixture
def channels(monkeypatch):
    """Channel memberships, by user, with channels enabled and permitted.

    The socket joins channel rooms only under the channel routes' rule
    (socket/main.py may_join_channels), which test_socket_channel_permission.py
    pins; here channels are on, so these tests are about the tokens.
    """
    by_user: dict[str, list] = {}
    permissions = copy.deepcopy(DEFAULT_USER_PERMISSIONS)
    permissions['features']['channels'] = True
    settings = {'channels.enable': True, 'user.permissions': permissions}
    real_get = Config.get

    async def get(key, default=None):
        return settings[key] if key in settings else await real_get(key, default)

    monkeypatch.setattr(Config, 'get', get)

    async def get_channels_by_user_id(user_id, db=None):
        return [SimpleNamespace(id=channel_id) for channel_id in by_user.get(user_id, [])]

    monkeypatch.setattr(socket_main.Channels, 'get_channels_by_user_id', get_channels_by_user_id)
    return by_user


def test_user_join_identifies_the_session_and_joins_only_its_channels(sio, people, channels):
    channels[people.alice.id] = ['c-alice']
    channels[people.bob.id] = ['c-bob']
    out = _run(socket_main.user_join('s1', {'auth': {'token': people.alice.token}}))
    assert out == {'id': people.alice.id, 'name': 'user name'}
    assert _rooms_of(sio, 's1') == {f'user:{people.alice.id}', 'channel:c-alice'}
    assert socket_main.SESSION_POOL['s1']['id'] == people.alice.id


@pytest.mark.parametrize('data', [{}, {'auth': None}, {'auth': {}}, {'auth': {'token': 'not.a.jwt'}}])
def test_user_join_without_a_valid_token_does_nothing(sio, people, channels, data):
    assert _run(socket_main.user_join('s1', data)) is None
    assert sio.rooms == {} and socket_main.SESSION_POOL == {}


def test_user_join_refuses_a_pending_user(sio, people, channels):
    channels[people.pending.id] = ['c-any']
    assert _run(socket_main.user_join('s1', {'auth': {'token': people.pending.token}})) is None
    assert sio.rooms == {}


def test_join_channels_needs_a_valid_token(sio, people, channels):
    channels[people.alice.id] = ['c1', 'c2']
    _run(socket_main.join_channel('s1', {'auth': {'token': 'not.a.jwt'}}))
    _run(socket_main.join_channel('s1', {}))
    assert sio.rooms == {}
    _run(socket_main.join_channel('s1', {'auth': {'token': people.alice.token}}))
    assert _rooms_of(sio, 's1') == {'channel:c1', 'channel:c2'}


# --- note rooms ---------------------------------------------------------------


@pytest.fixture
def note(monkeypatch, people):
    note_id = f'note-{uuid.uuid4().hex[:8]}'

    async def get_note_by_id(requested, db=None):
        return SimpleNamespace(id=note_id, user_id=people.alice.id) if requested == note_id else None

    monkeypatch.setattr(socket_main.Notes, 'get_note_by_id', get_note_by_id)
    return note_id


def _join_note(state, sid, user, note_id):
    _run(socket_main.join_note(sid, {'auth': {'token': user.token}, 'note_id': note_id}))
    return f'note:{note_id}' in _rooms_of(state, sid)


def test_the_owner_and_an_admin_join_a_note(sio, people, note):
    assert _join_note(sio, 's-owner', people.alice, note)
    assert _join_note(sio, 's-admin', people.admin, note)


def test_another_user_joins_a_note_only_with_a_read_grant(sio, people, note):
    assert not _join_note(sio, 's-bob', people.bob, note)
    _run(
        AccessGrants.set_access_grants(
            'note', note, [{'principal_type': 'user', 'principal_id': people.bob.id, 'permission': 'read'}]
        )
    )
    assert _join_note(sio, 's-bob', people.bob, note)


def test_a_note_room_refuses_bad_tokens_and_missing_notes(sio, people, note):
    assert not _join_note(sio, 's1', people.pending, note)
    assert not _join_note(sio, 's1', SimpleNamespace(token='not.a.jwt'), note)
    _run(socket_main.join_note('s1', {'note_id': note}))
    _run(socket_main.join_note('s1', {'auth': {'token': people.alice.token}, 'note_id': 'no-such-note'}))
    assert sio.rooms == {}


# --- channel events -----------------------------------------------------------


@pytest.fixture
def read_marks(monkeypatch):
    marks = []

    async def update_member_last_read_at(channel_id, user_id, db=None):
        marks.append((channel_id, user_id))

    monkeypatch.setattr(socket_main.Channels, 'update_member_last_read_at', update_member_last_read_at)
    return marks


def test_channel_events_from_outside_the_room_are_dropped(sio, people, read_marks):
    _connect('s1', people.alice.token)
    for event_type in ('typing', 'last_read_at'):
        _run(socket_main.channel_events('s1', {'channel_id': 'c1', 'data': {'type': event_type}}))
    assert sio.emitted == [] and read_marks == []


def test_channel_events_speak_for_the_sessions_own_user(sio, people, read_marks):
    _connect('s1', people.alice.token)
    _run(sio_enter('s1', 'channel:c1'))
    _run(socket_main.channel_events('s1', {'channel_id': 'c1', 'data': {'type': 'typing', 'user_id': people.bob.id}}))
    (event, payload, room) = sio.emitted[0]
    assert (event, room) == ('events:channel', 'channel:c1')
    assert payload['user'] == {'id': people.alice.id, 'name': 'user name', 'role': 'user'}
    _run(socket_main.channel_events('s1', {'channel_id': 'c1', 'data': {'type': 'last_read_at'}}))
    assert read_marks == [('c1', people.alice.id)]


def test_channel_events_from_an_anonymous_session_in_the_room_are_dropped(sio, read_marks):
    _run(sio_enter('s-anon', 'channel:c1'))
    _run(socket_main.channel_events('s-anon', {'channel_id': 'c1', 'data': {'type': 'typing'}}))
    assert sio.emitted == [] and read_marks == []


# --- chat events --------------------------------------------------------------


def _saved_chat(user) -> str:
    chat_id = str(uuid.uuid4())
    _run(Chats.insert_new_chat(chat_id, user.id, ChatForm(chat={'title': 't', 'history': {'messages': {}}})))
    _run(Chats.mark_chat_unread_by_id(chat_id, user.id))  # last_read_at = 0
    return chat_id


def test_marking_another_users_chat_read_does_nothing(sio, people):
    chat_id = _saved_chat(people.bob)
    _connect('s1', people.alice.token)
    _run(socket_main.chat_events('s1', {'chat_id': chat_id, 'data': {'type': 'last_read_at'}}))
    assert sio.emitted == []
    assert _run(Chats.get_chat_by_id(chat_id)).last_read_at == 0


def test_marking_your_own_chat_read_tells_only_you(sio, people):
    chat_id = _saved_chat(people.alice)
    _connect('s1', people.alice.token)
    _run(socket_main.chat_events('s1', {'chat_id': chat_id, 'data': {'type': 'last_read_at'}}))
    assert _run(Chats.get_chat_by_id(chat_id)).last_read_at > 0
    assert [(event, room) for event, _data, room in sio.emitted] == [('events', f'user:{people.alice.id}')]


def test_chat_events_from_an_anonymous_session_are_dropped(sio, people):
    chat_id = _saved_chat(people.alice)
    _run(socket_main.chat_events('s-anon', {'chat_id': chat_id, 'data': {'type': 'last_read_at'}}))
    assert sio.emitted == [] and _run(Chats.get_chat_by_id(chat_id)).last_read_at == 0


# --- session bookkeeping ----------------------------------------------------------


def test_heartbeat_and_usage_need_an_identified_session(sio, people):
    _run(socket_main.heartbeat('s-anon', {}))
    _run(socket_main.usage('s-anon', {'model': 'm1'}))
    assert socket_main.SESSION_POOL == {} and socket_main.USAGE_POOL == {}

    _connect('s1', people.alice.token)
    socket_main.SESSION_POOL['s1']['last_seen_at'] = 0
    _run(socket_main.heartbeat('s1', {}))
    assert socket_main.SESSION_POOL['s1']['last_seen_at'] > 0
    _run(socket_main.usage('s1', {'model': 'm1'}))
    assert socket_main.get_models_in_use() == ['m1']


def test_disconnect_forgets_the_session_and_its_usage(sio, people):
    _connect('s1', people.alice.token)
    _connect('s2', people.bob.token)
    _run(socket_main.usage('s1', {'model': 'm1'}))
    _run(socket_main.usage('s2', {'model': 'm1'}))
    _run(socket_main.usage('s1', {'model': 'm2'}))
    _run(socket_main.disconnect('s1'))
    assert 's1' not in socket_main.SESSION_POOL and 's2' in socket_main.SESSION_POOL
    assert set(socket_main.USAGE_POOL) == {'m1'} and set(socket_main.USAGE_POOL['m1']) == {'s2'}
    _run(socket_main.disconnect('never-connected'))


def test_disconnecting_a_user_ends_only_their_sessions(sio, people):
    _connect('a1', people.alice.token)
    _connect('a2', people.alice.token)
    _connect('b1', people.bob.token)
    # A session known only to the shared pool (another worker's) is included.
    socket_main.SESSION_POOL['a3'] = {'id': people.alice.id}
    assert sorted(socket_main.get_session_ids_by_user_id(people.alice.id)) == ['a1', 'a2', 'a3']
    _run(socket_main.disconnect_user_sessions(people.alice.id))
    assert sorted(sio.disconnected) == ['a1', 'a2', 'a3']
    _run(socket_main.disconnect_user_sessions('nobody'))
    assert sorted(sio.disconnected) == ['a1', 'a2', 'a3']


def test_user_addressed_helpers_reach_only_the_named_users(sio, people):
    _connect('a1', people.alice.token)
    _connect('b1', people.bob.token)
    _run(socket_main.emit_to_users('ping', {'x': 1}, [people.alice.id]))
    assert sio.emitted == [('ping', {'x': 1}, f'user:{people.alice.id}')]
    _run(socket_main.enter_room_for_users('note:n1', [people.alice.id]))
    assert set(sio.rooms['note:n1']) == {'a1'}
    _run(sio_enter('anon', 'note:n1'))
    assert _run(socket_main.get_user_ids_from_room('note:n1')) == {people.alice.id}


# --- calls and events from the server ------------------------------------------------


def test_an_event_call_reaches_only_the_requesters_own_session(sio, people):
    _connect('a1', people.alice.token)
    _connect('b1', people.bob.token)
    info = {'user_id': people.alice.id, 'chat_id': 'c1', 'message_id': 'm1'}

    caller = _run(socket_main.get_event_call({**info, 'session_id': 'a1'}))
    assert _run(caller({'type': 'input'})) == {'answered_by': 'a1'}

    caller = _run(socket_main.get_event_call({**info, 'session_id': 'b1'}))
    assert 'error' in _run(caller({'type': 'input'}))
    caller = _run(socket_main.get_event_call({**info, 'session_id': 'gone'}))
    assert 'error' in _run(caller({'type': 'input'}))
    assert [to for _event, _data, to in sio.called] == ['a1']
    assert _run(socket_main.get_event_call({'session_id': 'a1'})) is None


def test_chat_events_from_the_server_go_to_the_chats_user_only(sio, people):
    _connect('a1', people.alice.token)
    _connect('b1', people.bob.token)
    emitter = _run(
        socket_main.get_event_emitter({'user_id': people.alice.id, 'chat_id': 'temporary:x', 'message_id': 'm'})
    )
    _run(emitter({'type': 'status', 'data': {'done': True}}))
    assert [room for _event, _data, room in sio.emitted] == [f'user:{people.alice.id}']
    # An internal run's notifications are not shown to the user at all.
    internal = _run(
        socket_main.get_event_emitter(
            {'user_id': people.alice.id, 'chat_id': 'temporary:x', 'message_id': 'm', 'internal': True}
        )
    )
    _run(internal({'type': 'notification', 'data': {}}))
    assert len(sio.emitted) == 1
    # Nothing is emitted for a user with no session here.
    nobody = _run(socket_main.get_event_emitter({'user_id': 'nobody', 'chat_id': 'temporary:x', 'message_id': 'm'}))
    _run(nobody({'type': 'status', 'data': {}}))
    assert len(sio.emitted) == 1
    assert _run(socket_main.get_event_emitter({'user_id': people.alice.id})) is None
