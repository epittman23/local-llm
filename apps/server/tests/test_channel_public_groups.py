"""A group channel saved as visible to all users is public (#331).

The channel dialog offered "Visible to all users" and the server stored
`is_private`, but nothing read it: a group channel was listed to and readable
by its members only. Now a group channel saved with `is_private` false is
listed to everyone who may use channels (marked as not joined), its history
is readable by them, and opening it (GET /channels/{id}) joins them. Posting,
reacting and pinning still need membership. Private group channels, DMs and
group channels saved before (`is_private` null) keep members-only access.

Runs against the suite's temporary SQLite database, calling the route
functions directly, with the channels feature check, events and socket calls
replaced by recorders.

Run from apps/server:

    python -m pytest tests/test_channel_public_groups.py
"""

import asyncio
import copy
import datetime as dt
import importlib
import pkgutil
import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import local_llm.models as models_pkg
from local_llm.config import DEFAULT_USER_PERMISSIONS
from local_llm.internal.db import Base, async_engine
from local_llm.models.channels import ChannelForm, Channels, CreateChannelForm, is_public_group_channel
from local_llm.models.config import Config
from local_llm.models.messages import MessageForm, Messages
from local_llm.models.users import Users
from local_llm.routers import channels as channels_router
from local_llm.socket import main as socket_main
from local_llm.utils.auth import create_token

for module in pkgutil.iter_modules(models_pkg.__path__):
    importlib.import_module(f'local_llm.models.{module.name}')


@pytest.fixture
def sockets(monkeypatch):
    """Records the rooms users are put in and the events sent to users."""
    recorded = SimpleNamespace(rooms=[], to_users=[])

    async def nothing(*_a, **_k):
        return None

    async def enter_room_for_users(room, user_ids):
        recorded.rooms.append((room, list(user_ids)))

    async def emit_to_users(event, data, user_ids):
        recorded.to_users.append((data, list(user_ids)))

    monkeypatch.setattr(channels_router, 'check_channels_access', nothing)
    monkeypatch.setattr(channels_router, 'publish_event', nothing)
    monkeypatch.setattr(channels_router, 'prune_channel_room', nothing)
    monkeypatch.setattr(channels_router.sio, 'emit', nothing)
    monkeypatch.setattr(channels_router, 'enter_room_for_users', enter_room_for_users)
    monkeypatch.setattr(channels_router, 'emit_to_users', emit_to_users)
    return recorded


def _run(scenario):
    async def go():
        async with async_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        return await scenario()

    return asyncio.run(go())


async def _world():
    """An owner, a member and an outsider, and one channel of each kind, all with a message."""
    tag = uuid.uuid4().hex[:8]

    async def user(name):
        return await Users.insert_new_user(f'{name}{tag}', name, f'{name}{tag}@example.invalid', role='user')

    owner, member, outsider = await user('owner'), await user('member'), await user('outsider')

    async def channel(kind, is_private):
        form = CreateChannelForm(
            type=kind, name=f'{kind}-{is_private}-{tag}', is_private=is_private, user_ids=[member.id]
        )
        created = await Channels.insert_new_channel(form, owner.id)
        message = await Messages.insert_new_message(MessageForm(content=f'hello {tag}'), created.id, owner.id)
        return SimpleNamespace(id=created.id, message_id=message.id)

    return SimpleNamespace(
        owner=owner,
        member=member,
        outsider=outsider,
        public=await channel('group', False),
        private=await channel('group', True),
        # A group channel from before: the column was added nullable, unset.
        legacy=await channel('group', None),
        # A DM is never public, whatever is_private says.
        dm=await channel('dm', False),
    )


async def _status(call):
    try:
        await call
    except HTTPException as e:
        return e.status_code
    return 200


async def _reads(channel, user):
    """The status of every read route for `user` on `channel`."""
    cid, mid = channel.id, channel.message_id
    return {
        'messages': await _status(channels_router.get_channel_messages(None, cid, user=user, db=None)),
        'pinned': await _status(channels_router.get_pinned_channel_messages(None, cid, user=user, db=None)),
        'message': await _status(channels_router.get_channel_message(None, cid, mid, user=user, db=None)),
        'data': await _status(channels_router.get_channel_message_data(None, cid, mid, user=user, db=None)),
        'thread': await _status(channels_router.get_channel_thread_messages(None, cid, mid, user=user, db=None)),
        'members': await _status(channels_router.get_channel_members_by_id(None, cid, user=user, db=None)),
    }


async def _post(channel, user):
    return await _status(channels_router.new_message_handler(None, channel.id, MessageForm(content='hi'), user, None))


async def _react(channel, user):
    form = channels_router.ReactionForm(name='eyes')
    return await _status(
        channels_router.add_reaction_to_message(None, channel.id, channel.message_id, form, user=user, db=None)
    )


def _listed(items):
    return {c.id: c.is_member for c in items}


def test_old_rows_and_dms_are_never_public():
    assert is_public_group_channel(SimpleNamespace(type='group', is_private=False))
    assert not is_public_group_channel(SimpleNamespace(type='group', is_private=None))
    assert not is_public_group_channel(SimpleNamespace(type='group', is_private=True))
    assert not is_public_group_channel(SimpleNamespace(type='dm', is_private=False))
    assert not is_public_group_channel(SimpleNamespace(type=None, is_private=False))


def test_a_public_group_is_listed_to_everyone_as_not_joined(sockets):
    async def scenario():
        w = await _world()
        return w, (
            _listed(await channels_router.get_channels(None, user=w.outsider, db=None)),
            _listed(await channels_router.get_channels(None, user=w.member, db=None)),
            {c.id for c in await channels_router.get_all_channels(None, user=w.outsider, db=None)},
        )

    w, (outsider, member, listed) = _run(scenario)

    assert outsider.get(w.public.id) is False
    for hidden in (w.private, w.legacy, w.dm):
        assert hidden.id not in outsider
        assert hidden.id not in listed
    assert w.public.id in listed
    assert {member.get(c.id) for c in (w.public, w.private, w.legacy, w.dm)} == {True}


def test_anyone_reads_a_public_group_and_no_one_else_reads_the_rest(sockets):
    async def scenario():
        w = await _world()
        return {name: await _reads(getattr(w, name), w.outsider) for name in ('public', 'private', 'legacy', 'dm')} | {
            'member': await _reads(w.private, w.member)
        }

    reads = _run(scenario)

    assert set(reads['public'].values()) == {200}
    for name in ('private', 'legacy', 'dm'):
        assert set(reads[name].values()) == {403}, name
    assert set(reads['member'].values()) == {200}


def test_reading_a_public_group_does_not_make_a_member(sockets):
    async def scenario():
        w = await _world()
        await _reads(w.public, w.outsider)
        return await Channels.is_user_channel_member(w.public.id, w.outsider.id)

    assert _run(scenario) is False


def test_posting_needs_a_join_which_opening_does(sockets):
    async def scenario():
        w = await _world()
        before = (await _post(w.public, w.outsider), await _react(w.public, w.outsider))
        opened = await channels_router.get_channel_by_id(None, w.public.id, user=w.outsider, db=None)
        after = (await _post(w.public, w.outsider), await _react(w.public, w.outsider))
        listed = _listed(await channels_router.get_channels(None, user=w.outsider, db=None))
        return w, before, opened, after, listed

    w, before, opened, after, listed = _run(scenario)

    assert before == (403, 403)
    assert opened.write_access is True
    assert w.outsider.id in opened.user_ids
    assert after == (200, 200)
    assert listed[w.public.id] is True
    # Live events start at once, and the viewer's other tabs refresh their list.
    assert (f'channel:{w.public.id}', [w.outsider.id]) in sockets.rooms
    assert any(ids == [w.outsider.id] for _data, ids in sockets.to_users)


def test_opening_a_channel_that_is_not_public_joins_no_one(sockets):
    async def scenario():
        w = await _world()
        statuses = [
            await _status(channels_router.get_channel_by_id(None, c.id, user=w.outsider, db=None))
            for c in (w.private, w.legacy, w.dm)
        ]
        members = [await Channels.is_user_channel_member(c.id, w.outsider.id) for c in (w.private, w.legacy, w.dm)]
        posts = [await _post(c, w.outsider) for c in (w.private, w.legacy, w.dm)]
        return statuses, members, posts

    statuses, members, posts = _run(scenario)

    assert statuses == [403, 403, 403]
    assert members == [False, False, False]
    assert posts == [403, 403, 403]


def test_opening_reactivates_an_inactive_member(sockets):
    async def scenario():
        w = await _world()
        await Channels.update_member_active_status(w.public.id, w.member.id, False)
        before = await _post(w.public, w.member)
        await channels_router.get_channel_by_id(None, w.public.id, user=w.member, db=None)
        return before, await _post(w.public, w.member)

    assert _run(scenario) == (403, 200)


def test_a_removed_member_can_rejoin_a_public_group_but_not_a_private_one(sockets):
    async def scenario():
        w = await _world()
        for c in (w.public, w.private):
            await Channels.remove_members_from_channel(c.id, [w.member.id])
        public = await _status(channels_router.get_channel_by_id(None, w.public.id, user=w.member, db=None))
        private = await _status(channels_router.get_channel_by_id(None, w.private.id, user=w.member, db=None))
        return public, await _post(w.public, w.member), private, await _post(w.private, w.member)

    assert _run(scenario) == (200, 200, 403, 403)


def test_making_a_group_private_hides_it_from_those_who_never_joined(sockets):
    async def scenario():
        w = await _world()
        listed = []
        for is_private in (True, False):
            form = ChannelForm(name=f'renamed-{is_private}', is_private=is_private)
            await channels_router.update_channel_by_id(None, w.public.id, form, user=w.owner, db=None)
            listed.append(w.public.id in _listed(await channels_router.get_channels(None, user=w.outsider, db=None)))
        return listed

    assert _run(scenario) == [False, True]


def test_live_rooms_hold_only_members(sockets):
    """The rooms a socket joins at connect come from get_channels_by_user_id:
    an unjoined public group is not among them, so its messages raise no
    unread badge or notification for someone who never opened it."""

    async def scenario():
        w = await _world()
        before = {c.id for c in await Channels.get_channels_by_user_id(w.outsider.id)}
        await channels_router.get_channel_by_id(None, w.public.id, user=w.outsider, db=None)
        after = {c.id for c in await Channels.get_channels_by_user_id(w.outsider.id)}
        return w, before, after

    w, before, after = _run(scenario)

    assert w.public.id not in before
    assert w.public.id in after


def test_a_public_groups_files_are_readable_by_everyone(sockets):
    async def scenario():
        w = await _world()
        file_id = f'file-{uuid.uuid4().hex[:8]}'
        private_file_id = f'file-{uuid.uuid4().hex[:8]}'
        await Channels.add_file_to_channel_by_id(w.public.id, file_id, w.owner.id)
        await Channels.add_file_to_channel_by_id(w.private.id, private_file_id, w.owner.id)
        return (
            [c.id for c in await Channels.get_channels_by_file_id_and_user_id(file_id, w.outsider.id)],
            [c.id for c in await Channels.get_channels_by_file_id_and_user_id(private_file_id, w.outsider.id)],
            await Channels.get_channel_by_id_and_user_id(w.public.id, w.outsider.id),
            await Channels.get_channel_by_id_and_user_id(w.private.id, w.outsider.id),
            w,
        )

    public, private, by_id_public, by_id_private, w = _run(scenario)

    assert public == [w.public.id]
    assert private == []
    assert by_id_public is not None
    assert by_id_private is None


def test_a_socket_enters_a_public_groups_room_only_once_joined(sockets, monkeypatch):
    """join-channels, with a real token: the outsider's socket is kept out of
    the room of a public group they have not opened, so the in-room check of
    `events:channel` (typing, last read) refuses them there too."""
    entered: dict[str, set[str]] = {}

    async def enter_room(sid, room, namespace=None):
        entered.setdefault(sid, set()).add(room)

    settings = {'channels.enable': True, 'user.permissions': copy.deepcopy(DEFAULT_USER_PERMISSIONS)}
    settings['user.permissions']['features']['channels'] = True

    async def get(key, default=None):
        return settings.get(key, default)

    monkeypatch.setattr(socket_main.sio, 'enter_room', enter_room)
    monkeypatch.setattr(socket_main.sio, 'get_environ', lambda sid, namespace=None: {})
    monkeypatch.setattr(socket_main, 'REDIS', None)
    monkeypatch.setattr(Config, 'get', get)

    async def scenario():
        w = await _world()
        token = create_token({'id': w.outsider.id}, dt.timedelta(minutes=30))
        await socket_main.join_channel('before', {'auth': {'token': token}})
        await channels_router.get_channel_by_id(None, w.public.id, user=w.outsider, db=None)
        await socket_main.join_channel('after', {'auth': {'token': token}})
        return w

    w = _run(scenario)

    room = f'channel:{w.public.id}'
    assert room not in entered.get('before', set())
    assert room in entered['after']
    for hidden in (w.private, w.legacy, w.dm):
        assert f'channel:{hidden.id}' not in entered['after']
