"""Pinning a webhook's message keeps the webhook as its author (#330).

The pin route answered, and announced to the channel, the pinned message with
its author looked up again by user id: the webhook's creator. The page merges
that update live, so a webhook's message showed as written by a person, with
their name and avatar. Reading one message (GET /channels/{id}/messages/{id})
did the same. Both now keep the author `get_message_by_id` resolves.

Runs against the suite's temporary SQLite database.

Run from apps/server:

    python -m pytest tests/test_channel_pin_webhook_author.py
"""

import asyncio
import importlib
import pkgutil
import uuid
from types import SimpleNamespace

import pytest

import local_llm.models as models_pkg
from local_llm.internal.db import Base, async_engine
from local_llm.models.channels import Channels, ChannelWebhookForm, CreateChannelForm
from local_llm.models.messages import MessageForm, Messages
from local_llm.models.users import Users
from local_llm.routers import channels as channels_router

for module in pkgutil.iter_modules(models_pkg.__path__):
    importlib.import_module(f'local_llm.models.{module.name}')


@pytest.fixture
def quiet(monkeypatch):
    emitted: list[dict] = []

    async def nothing(*_a, **_k):
        return None

    async def emit(event, data, to=None):
        emitted.append(data)

    monkeypatch.setattr(channels_router, 'check_channels_access', nothing)
    monkeypatch.setattr(channels_router, 'publish_event', nothing)
    monkeypatch.setattr(channels_router.sio, 'emit', emit)
    return emitted


async def _channel(owner_id, tag, name):
    form = CreateChannelForm(
        type='',
        name=f'{name}-{tag}',
        access_grants=[{'principal_type': 'user', 'principal_id': '*', 'permission': 'read'}],
    )
    return await Channels.insert_new_channel(form, owner_id)


async def _message(case):
    """A message in a fresh channel, posted by Ann as the case says; returns it and the channel."""
    tag = uuid.uuid4().hex[:8]
    ann = await Users.insert_new_user(f'ann{tag}', 'Ann', f'ann{tag}@example.invalid', role='admin')
    channel = await _channel(ann.id, tag, 'general')
    other = await _channel(ann.id, tag, 'other')
    webhook = await Channels.insert_webhook(channel.id, ann.id, ChannelWebhookForm(name='CI Bot'))
    foreign = await Channels.insert_webhook(other.id, ann.id, ChannelWebhookForm(name='Other Bot'))
    meta = {
        'webhook': {'webhook': {'id': webhook.id}},
        'deleted webhook': {'webhook': {'id': webhook.id}},
        'webhook of another channel': {'webhook': {'id': foreign.id}},
    }.get(case)
    message = await Messages.insert_new_message(MessageForm(content='Build passed', meta=meta), channel.id, ann.id)
    if case == 'deleted webhook':
        await Channels.delete_webhook_by_id(webhook.id)
    if case == 'deleted user':
        await Users.delete_user_by_id(ann.id)
    return channel, message


CASES = {
    'webhook': ('CI Bot', 'webhook'),
    'deleted webhook': ('Deleted Webhook', 'webhook'),
    # Not believed: a webhook from another channel shows the real author.
    'webhook of another channel': ('Ann', 'admin'),
    'user': ('Ann', 'admin'),
    'deleted user': None,
}
ADMIN = SimpleNamespace(
    id='admin1', role='admin', name='Admin', model_dump=lambda: {'id': 'admin1', 'name': 'Admin', 'role': 'admin'}
)


def _author(message):
    return (message.user.name, message.user.role) if message.user else None


async def _setup_tables():
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


@pytest.mark.parametrize('case', list(CASES))
def test_a_pinned_message_keeps_its_author(quiet, case):
    async def scenario():
        await _setup_tables()
        channel, message = await _message(case)
        return await channels_router.pin_channel_message(
            None, channel.id, message.id, channels_router.PinMessageForm(is_pinned=True), user=ADMIN, db=None
        )

    pinned = asyncio.run(scenario())

    assert _author(pinned) == CASES[case]
    sent = quiet[0]['data']['data']['user']
    assert ((sent['name'], sent['role']) if sent else None) == CASES[case]


@pytest.mark.parametrize('case', list(CASES))
def test_reading_one_message_gives_its_author(quiet, case):
    async def scenario():
        await _setup_tables()
        channel, message = await _message(case)
        return await channels_router.get_channel_message(None, channel.id, message.id, user=ADMIN, db=None)

    assert _author(asyncio.run(scenario())) == CASES[case]
