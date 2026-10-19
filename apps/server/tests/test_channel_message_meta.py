"""Channel messages: clients cannot claim a webhook or model identity.

Run from apps/server:

    python -m pytest tests/test_channel_message_meta.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from local_llm.models import messages as messages_model
from local_llm.models.messages import Messages, client_meta


def test_client_meta_drops_server_reserved_keys():
    sent = {'webhook': {'id': 'w1'}, 'model_id': 'gpt', 'model_name': 'Alice', 'mood': 'fine'}
    assert client_meta(sent) == {'mood': 'fine'}
    assert client_meta(None) is None


def _webhooks(monkeypatch, channel_id: str):
    async def get_webhook_by_id(webhook_id, db=None):
        return SimpleNamespace(id=webhook_id, name='CI Alerts', channel_id=channel_id)

    monkeypatch.setattr(messages_model.Channels, 'get_webhook_by_id', get_webhook_by_id)


def test_a_webhook_from_another_channel_is_not_believed(monkeypatch):
    _webhooks(monkeypatch, channel_id='other-channel')
    message = SimpleNamespace(meta={'webhook': {'id': 'w1'}}, channel_id='this-channel')
    assert asyncio.run(Messages._resolve_user_info(message, None)) is None


def test_this_channels_webhook_is(monkeypatch):
    _webhooks(monkeypatch, channel_id='this-channel')
    message = SimpleNamespace(meta={'webhook': {'id': 'w1'}}, channel_id='this-channel')
    assert asyncio.run(Messages._resolve_user_info(message, None)) == {
        'id': 'w1',
        'name': 'CI Alerts',
        'role': 'webhook',
    }


def test_posting_strips_reserved_meta(monkeypatch):
    from local_llm.routers import channels as channels_router

    seen = []

    async def allowed(*_a, **_k):
        return None

    async def handler(request, id, form_data, user, db):
        seen.append(form_data.meta)
        raise RuntimeError('stop here')

    monkeypatch.setattr(channels_router, 'check_channels_access', allowed)
    monkeypatch.setattr(channels_router, 'new_message_handler', handler)
    form = channels_router.MessageForm(content='hi', meta={'webhook': {'id': 'w1'}, 'model_name': 'Alice'})
    try:
        asyncio.run(
            channels_router.post_new_message(
                request=None, id='c1', form_data=form, background_tasks=None, user=SimpleNamespace(id='m'), db=None
            )
        )
    except Exception:
        pass
    assert seen == [{}]
