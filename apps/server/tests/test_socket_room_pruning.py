"""Losing access to a channel or note also removes the user's live sockets from its room.

Run from apps/server:

    python -m pytest tests/test_socket_room_pruning.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from local_llm.socket import main as socket_main


@pytest.fixture
def rooms(monkeypatch):
    state = {
        'channel:c1': ['sid-owner', 'sid-removed', 'sid-anon'],
        'note:n1': ['sid-owner', 'sid-removed', 'sid-admin'],
    }
    pool = {
        'sid-owner': {'id': 'owner', 'role': 'user'},
        'sid-removed': {'id': 'removed', 'role': 'user'},
        'sid-admin': {'id': 'admin', 'role': 'admin'},
    }
    left = []

    async def leave_room(sid, room):
        left.append((sid, room))
        state[room].remove(sid)

    monkeypatch.setattr(socket_main, 'get_session_ids_from_room', lambda room: list(state.get(room, [])))
    monkeypatch.setattr(socket_main.sio, 'leave_room', leave_room)
    monkeypatch.setattr(socket_main, 'SESSION_POOL', pool)
    return state, left


def test_prune_room_removes_only_sessions_that_fail_the_check(rooms):
    state, left = rooms

    async def may_stay(user):
        return user['id'] == 'owner'

    removed = asyncio.run(socket_main.prune_room('channel:c1', may_stay))
    assert sorted(removed) == ['sid-anon', 'sid-removed']
    assert state['channel:c1'] == ['sid-owner']


def test_close_room_empties_it(rooms):
    state, _ = rooms
    asyncio.run(socket_main.close_room('channel:c1'))
    assert state['channel:c1'] == []


def test_removed_channel_member_is_pruned(rooms, monkeypatch):
    from local_llm.routers import channels as channels_router

    state, _ = rooms

    async def channels_of(user_id, db=None):
        return [SimpleNamespace(id='c1')] if user_id == 'owner' else []

    monkeypatch.setattr(channels_router.Channels, 'get_channels_by_user_id', channels_of)
    asyncio.run(channels_router.prune_channel_room('c1'))
    assert state['channel:c1'] == ['sid-owner']


def test_revoked_note_reader_is_pruned(rooms, monkeypatch):
    from local_llm.routers import notes as notes_router

    state, _ = rooms

    async def no_grant(**_k):
        return False

    monkeypatch.setattr(notes_router.AccessGrants, 'has_access', no_grant)
    asyncio.run(notes_router.prune_note_room(SimpleNamespace(id='n1', user_id='owner')))
    assert sorted(state['note:n1']) == ['sid-admin', 'sid-owner']
