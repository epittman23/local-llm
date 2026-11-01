"""Who a channel message notifies (routers/channels.py send_notification).

A standard channel's readers come from its access grants; a DM or group
channel has none, because its membership lives in channel_member. The
recipients were always taken from the grants, so in a DM or group channel
nobody offline was ever notified (#327).

Runs against the suite's temporary SQLite database (tests/conftest.py points
DATA_DIR at a temp directory, and DATABASE_URL defaults to a file in it),
with publish_event replaced by a recorder.

Run from apps/server:

    python -m pytest tests/test_channel_notifications.py
"""

import asyncio
import importlib
import pkgutil
import uuid

import local_llm.models as models_pkg
from local_llm.internal.db import Base, async_engine
from local_llm.models.channels import Channels, CreateChannelForm
from local_llm.models.config import Config
from local_llm.models.messages import MessageForm, Messages
from local_llm.models.users import Users
from local_llm.routers import channels as channels_router

for module in pkgutil.iter_modules(models_pkg.__path__):
    importlib.import_module(f'local_llm.models.{module.name}')


def _run(monkeypatch, scenario):
    published: list[dict] = []

    async def record(request, event, **kwargs):
        published.append({'event': event.name, **kwargs.get('data', {})})

    monkeypatch.setattr(channels_router, 'publish_event', record)

    async def go():
        async with async_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        await Config.upsert({'ui.enable_user_webhooks': True, 'webui.url': 'http://local.test'})
        return await scenario(published)

    return asyncio.run(go())


async def _users():
    tag = uuid.uuid4().hex[:8]
    sender = await Users.insert_new_user(f's{tag}', 'Sam', f's{tag}@example.invalid', role='admin')
    others = []
    for name in ('Bob', 'Cat'):
        user = await Users.insert_new_user(f'{name}{tag}', name, f'{name}{tag}@example.invalid', role='user')
        await Users.update_user_settings_by_id(user.id, {'notifications': {'webhook_url': 'http://hook.test'}})
        others.append(user)
    return sender, others


async def _post(channel, sender, published, active_user_ids=()):
    message = await Messages.insert_new_message(MessageForm(content='hi'), channel.id, sender.id)
    published.clear()
    await channels_router.send_notification(None, channel, message, active_user_ids=list(active_user_ids))
    return sorted(p['user_id'] for p in published if p['event'] == 'channel.message')


def test_a_dm_notifies_the_other_member(monkeypatch):
    async def scenario(published):
        sender, (bob, _) = await _users()
        form = CreateChannelForm(type='dm', name='', access_grants=[], group_ids=[], user_ids=[bob.id])
        dm = await Channels.insert_new_channel(form, sender.id)
        return bob, await _post(dm, sender, published)

    bob, notified = _run(monkeypatch, scenario)

    assert notified == [bob.id]


def test_a_group_notifies_its_offline_members_but_not_the_online_ones(monkeypatch):
    async def scenario(published):
        sender, (bob, cat) = await _users()
        form = CreateChannelForm(
            type='group', name='team', is_private=True, access_grants=[], group_ids=[], user_ids=[bob.id, cat.id]
        )
        group = await Channels.insert_new_channel(form, sender.id)
        return bob, await _post(group, sender, published, active_user_ids=[cat.id])

    bob, notified = _run(monkeypatch, scenario)

    assert notified == [bob.id]


def test_a_member_who_left_a_group_is_not_notified(monkeypatch):
    async def scenario(published):
        sender, (bob, cat) = await _users()
        form = CreateChannelForm(
            type='group', name='team', is_private=True, access_grants=[], group_ids=[], user_ids=[bob.id, cat.id]
        )
        group = await Channels.insert_new_channel(form, sender.id)
        await Channels.leave_channel(group.id, cat.id)
        return bob, await _post(group, sender, published)

    bob, notified = _run(monkeypatch, scenario)

    assert notified == [bob.id]


def test_a_standard_channel_still_notifies_its_offline_members(monkeypatch):
    async def scenario(published):
        sender, (bob, _) = await _users()
        form = CreateChannelForm(
            type='',
            name=f'general-{uuid.uuid4().hex[:6]}',
            access_grants=[{'principal_type': 'user', 'principal_id': '*', 'permission': 'read'}],
        )
        std = await Channels.insert_new_channel(form, sender.id)
        await Channels.join_channel(std.id, bob.id)
        return bob, await _post(std, sender, published, active_user_ids=[sender.id])

    bob, notified = _run(monkeypatch, scenario)

    assert notified == [bob.id]
