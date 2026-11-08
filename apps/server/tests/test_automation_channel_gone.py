"""An automation whose channel is gone pauses on its first run (#713).

A channel disappears by its deletion or a user's purge, and every later run
would fail the same way. The first run that finds it gone switches the
automation off with no next run and records an error run saying why; the
scheduler's claim then never picks it up again.

Run from apps/server:

    python -m pytest tests/test_automation_channel_gone.py
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

from local_llm.events import EVENTS
from local_llm.utils import automations


def _insert(automation_id: str, next_run_at: int):
    from local_llm.internal.db import get_async_db_context
    from local_llm.models.automations import Automation

    async def go():
        async with get_async_db_context() as db:
            now = time.time_ns()
            db.add(
                Automation(
                    id=automation_id, user_id='u-gone', name=automation_id,
                    data={'rrule': 'FREQ=MINUTELY;INTERVAL=5', 'target': {'type': 'channel', 'channel_id': 'ch1'}},
                    is_active=True, next_run_at=next_run_at, created_at=now, updated_at=now,
                )
            )  # fmt: skip
            await db.commit()

    asyncio.run(go())


def _row(automation_id: str):
    from local_llm.models.automations import Automations

    return asyncio.run(Automations.get_by_id(automation_id))


def _runs(automation_id: str):
    from local_llm.models.automations import AutomationRuns

    return asyncio.run(AutomationRuns.get_by_automation(automation_id, 0, 50))


def _claim(now_ns: int):
    from local_llm.models.automations import Automations

    return asyncio.run(Automations.claim_due(now_ns))


def _run(monkeypatch, automation_id: str, *, channel):
    published: list[tuple] = []
    dispatched: list[str] = []

    async def config_get(key, default=None):
        return True if key == 'channels.enable' else default

    async def get_channel(channel_id, db=None):
        return channel

    async def publish(app, event, **kwargs):
        published.append((event, kwargs['data']))

    async def model_defaults(app, model_id, user=None, token=None):
        dispatched.append('reached the post')
        raise RuntimeError('stop here')

    monkeypatch.setattr(automations.Config, 'get', config_get)
    monkeypatch.setattr(automations.Channels, 'get_channel_by_id', get_channel)
    monkeypatch.setattr(automations, 'publish_event', publish)
    monkeypatch.setattr(automations, '_resolve_model_defaults', model_defaults)

    automation = SimpleNamespace(
        id=automation_id, name=automation_id, user_id='u-gone', data={'target': {'channel_id': 'ch1'}}
    )
    user = SimpleNamespace(id='u-gone', name='Eli')
    try:
        asyncio.run(automations._execute_channel_automation(SimpleNamespace(), automation, user, 'hi', 'm', 'tok'))
    except RuntimeError:
        pass
    return published, dispatched


def test_the_first_run_after_the_channel_is_gone_pauses_and_records_why(monkeypatch):
    now = time.time_ns()
    _insert('gone-1', now - 1)

    published, dispatched = _run(monkeypatch, 'gone-1', channel=None)

    row = _row('gone-1')
    assert row.is_active is False
    assert row.next_run_at is None
    runs = _runs('gone-1')
    assert [(r.status, r.error) for r in runs] == [('error', automations.CHANNEL_GONE_ERROR)]
    assert 'deleted' in automations.CHANNEL_GONE_ERROR
    assert published == [(EVENTS.AUTOMATION_RUN_FAILED, {'name': 'gone-1', 'error': automations.CHANNEL_GONE_ERROR})]
    assert dispatched == []


def test_a_later_poll_does_not_run_it_again(monkeypatch):
    now = time.time_ns()
    _insert('gone-2', now - 1)
    _run(monkeypatch, 'gone-2', channel=None)

    claimed = [a.id for a in _claim(now + 10**12)]

    assert 'gone-2' not in claimed
    assert len(_runs('gone-2')) == 1


def test_an_automation_whose_channel_exists_is_unaffected(monkeypatch):
    now = time.time_ns()
    _insert('here-1', now + 10**12)

    published, dispatched = _run(monkeypatch, 'here-1', channel=SimpleNamespace(id='ch1'))

    row = _row('here-1')
    assert row.is_active is True
    assert row.next_run_at == now + 10**12
    assert _runs('here-1') == []
    assert published == []
    assert dispatched == ['reached the post']
