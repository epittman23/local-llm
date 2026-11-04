"""Pinning a webhook's message keeps the webhook as its author (#330).

The pin route answered, and announced to the channel, the pinned message with
its author looked up again by user id: the webhook's creator. The page merges
that update live, so a webhook's message showed as written by a person. It
now keeps the author `get_message_by_id` resolved, the webhook's name.

Run from apps/server:

    python -m pytest tests/test_channel_pin_webhook_author.py
"""

import asyncio
from types import SimpleNamespace

from local_llm.routers import channels as channels_router

MESSAGE = {
    'id': 'm1',
    'user_id': 'ann',
    'channel_id': 'c1',
    'content': 'Build passed',
    'meta': {'webhook': {'id': 'w1'}},
    'is_pinned': True,
    'created_at': 1,
    'updated_at': 1,
    'latest_reply_at': None,
    'reply_count': 0,
    'reactions': [],
}


def test_the_pinned_message_keeps_its_webhook_author(monkeypatch):
    emitted: list[dict] = []

    async def nothing(*_a, **_k):
        return None

    async def allowed(*_a, **_k):
        return True

    async def channel(channel_id, db=None):
        return SimpleNamespace(id='c1', type='standard', model_dump=lambda: {'id': 'c1'})

    async def message(message_id, db=None, **_k):
        # As get_message_by_id resolves it: the webhook, not its creator.
        resolved = {**MESSAGE, 'user': {'id': 'w1', 'name': 'CI Bot', 'role': 'webhook'}}
        return SimpleNamespace(**MESSAGE, model_dump=lambda: resolved)

    async def creator(user_id, db=None):
        return SimpleNamespace(
            id='ann', name='Ann', role='admin', model_dump=lambda: {'id': 'ann', 'name': 'Ann', 'role': 'admin'}
        )

    async def emit(event, data, to=None):
        emitted.append(data)

    monkeypatch.setattr(channels_router, 'check_channels_access', nothing)
    monkeypatch.setattr(channels_router.Channels, 'get_channel_by_id', channel)
    monkeypatch.setattr(channels_router, 'channel_has_access', allowed)
    monkeypatch.setattr(channels_router.Messages, 'get_message_by_id', message)
    monkeypatch.setattr(channels_router.Messages, 'update_is_pinned_by_id', nothing)
    monkeypatch.setattr(channels_router.Users, 'get_user_by_id', creator)
    monkeypatch.setattr(channels_router.sio, 'emit', emit)
    monkeypatch.setattr(channels_router, 'publish_event', nothing)

    pinned = asyncio.run(
        channels_router.pin_channel_message(
            None,
            'c1',
            'm1',
            channels_router.PinMessageForm(is_pinned=True),
            user=SimpleNamespace(
                id='admin1',
                role='admin',
                name='Admin',
                model_dump=lambda: {'id': 'admin1', 'name': 'Admin', 'role': 'admin'},
            ),
            db=None,
        )
    )

    assert (pinned.user.name, pinned.user.role) == ('CI Bot', 'webhook')
    assert emitted[0]['data']['data']['user']['name'] == 'CI Bot'
