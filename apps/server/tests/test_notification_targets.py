"""One failing notification target must not stop delivery to the others (#170).

dispatch_notification_event (utils/notifications.py) walks a user's enabled
notification targets and posts to each. The try/except wrapped the whole
loop, and _send_webhook raises when a post fails, so the first dead target
ended delivery for every target after it. Calendar alerts reach the same
loop through publish_event, so this covers them too.

The user's stored targets, the webhook post and the user lookups are
replaced, so nothing touches the database or the network.

Run from apps/server:

    python -m pytest tests/test_notification_targets.py
"""

import asyncio
import logging

import pytest

import local_llm.events as events_module
from local_llm.events import build_event
from local_llm.utils import notifications

BROKEN = 'https://broken.example/hook'
WORKING = 'https://working.example/hook'


def _target(target_id: str, url: str) -> dict:
    return {
        'id': target_id,
        'type': 'webhook',
        'enabled': True,
        'events': [notifications.CALENDAR_ALERT_EVENT],
        'delivery': 'always',
        'config': {'url': url},
    }


def _dispatch(monkeypatch, post_webhook) -> list[str]:
    attempted: list[str] = []

    async def record_post(name, url, message, event_data, description=None):
        attempted.append(url)
        return await post_webhook(url)

    async def config_get(key, *args, **kwargs):
        return key == 'ui.enable_user_webhooks'

    async def load_notifications(user_id):
        return {'targets': [_target('broken', BROKEN), _target('working', WORKING)]}

    async def is_user_active(user_id):
        return False

    monkeypatch.setattr(notifications, 'post_webhook', record_post)
    monkeypatch.setattr(notifications.Config, 'get', config_get)
    monkeypatch.setattr(notifications, '_load_notifications', load_notifications)
    monkeypatch.setattr(notifications.Users, 'is_user_active', is_user_active)
    monkeypatch.setattr(events_module, 'event_user_ids', lambda event: {'user-1'})

    event = build_event(
        object(),
        notifications.CALENDAR_ALERT_EVENT,
        subject_id='evt-1',
        subject_type='calendar.event',
        source='scheduler',
        data={'user_id': 'user-1', 'title': 'Standup', 'message': 'Standup: starting now'},
        message='Standup',
    )
    asyncio.run(notifications.dispatch_notification_event(object(), event))
    return attempted


async def _refused(url: str) -> bool:
    # post_webhook reports a failed post by returning False.
    return url != BROKEN


async def _raising(url: str) -> bool:
    if url == BROKEN:
        raise RuntimeError('connection refused')
    return True


@pytest.mark.parametrize('post_webhook', [_refused, _raising], ids=['refused', 'raises'])
def test_failing_target_does_not_stop_later_targets(monkeypatch, caplog, post_webhook):
    with caplog.at_level(logging.WARNING, logger=notifications.log.name):
        attempted = _dispatch(monkeypatch, post_webhook)

    assert attempted == [BROKEN, WORKING]
    failures = [record for record in caplog.records if record.levelno >= logging.WARNING]
    assert len(failures) == 1
    assert 'broken' in failures[0].getMessage()
