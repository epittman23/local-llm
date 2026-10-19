"""dispatch_notification_event: a failing first target suppresses the user's other targets."""

import asyncio
from types import SimpleNamespace
from unittest import mock

from local_llm import events
from local_llm.utils import notifications as n

calls = []


async def fake_post_webhook(name, url, message, data, description=None):
    calls.append(url)
    return 'broken' not in url  # first target's endpoint is down


notifications = {
    'targets': [
        {'id': 'slack', 'enabled': True, 'events': ['chat.finished'], 'delivery': 'always',
         'config': {'url': 'https://broken.example/hook'}},
        {'id': 'discord', 'enabled': True, 'events': ['chat.finished'], 'delivery': 'always',
         'config': {'url': 'https://ok.example/hook'}},
    ]
}

event = SimpleNamespace(event='chat.finished', data={'title': 't', 'message': 'm'}, message='Chat finished',
                        subject=None, model_dump=lambda: {})


async def main():
    with mock.patch.object(n, '_load_notifications', mock.AsyncMock(return_value=notifications)), \
            mock.patch.object(n.Users, 'is_user_active', mock.AsyncMock(return_value=False)), \
            mock.patch.object(n.Config, 'get', mock.AsyncMock(return_value=True)), \
            mock.patch.object(n, 'post_webhook', fake_post_webhook), \
            mock.patch.object(events, 'event_user_ids', lambda e: ['u1']):
        await n.dispatch_notification_event(SimpleNamespace(state=SimpleNamespace(LLLM_NAME='x')), event)
    print('webhooks attempted:', calls)


asyncio.run(main())
