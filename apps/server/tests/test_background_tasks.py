"""Fire-and-forget tasks are held until they finish (ruff RUF006).

The event loop keeps only a weak reference to a task, so one started with
a bare asyncio.create_task() and stored nowhere could be garbage-collected
and silently stop part way. Event delivery, scheduled automations and
timers, the last-active write, the first title and chat-task cleanup now
start through utils.background.run_in_background(), which holds each task
until it is done.

Run from apps/server:

    python -m pytest tests/test_background_tasks.py
"""

from __future__ import annotations

import asyncio
import gc
import logging
from types import SimpleNamespace

import pytest

from local_llm import events, tasks
from local_llm.utils import background, notifications


def test_a_task_is_held_while_it_runs_and_released_when_done():
    async def scenario():
        release = asyncio.Event()
        finished = []

        async def work():
            await release.wait()
            finished.append(True)

        task = background.run_in_background(work())
        del task
        gc.collect()
        assert len(background._running) == 1
        (held,) = background._running

        release.set()
        await held
        await asyncio.sleep(0)
        return finished

    assert asyncio.run(scenario()) == [True]
    assert background._running == set()


def test_without_a_running_loop_it_raises_like_create_task():
    async def work():
        pass

    coro = work()
    with pytest.raises(RuntimeError):
        background.run_in_background(coro)
    coro.close()


def _event() -> SimpleNamespace:
    return SimpleNamespace(event='test.event')


@pytest.mark.parametrize(
    ('schedule', 'target', 'module'),
    [
        (lambda: events.schedule_webhook_dispatch(None, _event()), 'dispatch_webhook_event', events),
        (lambda: events.schedule_event_function_dispatch(None, _event()), 'dispatch_event_functions', events),
        (
            lambda: events.schedule_notification_dispatch(None, _event()),
            'dispatch_notification_event',
            notifications,
        ),
    ],
    ids=['webhooks', 'event functions', 'notifications'],
)
def test_event_delivery_runs_to_completion(monkeypatch, schedule, target, module):
    delivered = []

    async def deliver(*args, **_kwargs):
        await asyncio.sleep(0)
        delivered.append(args[1].event)

    monkeypatch.setattr(module, target, deliver)

    async def scenario():
        schedule()
        assert len(background._running) == 1
        await asyncio.gather(*background._running)

    asyncio.run(scenario())
    assert delivered == ['test.event']


def test_event_delivery_outside_a_loop_is_logged_not_raised(monkeypatch, caplog):
    async def deliver(*_args, **_kwargs):
        pass

    monkeypatch.setattr(events, 'dispatch_webhook_event', deliver)
    caplog.set_level(logging.ERROR)

    events.schedule_webhook_dispatch(None, _event())

    assert 'could not be scheduled for test.event' in caplog.text


def test_a_finished_chat_task_is_cleaned_up(monkeypatch):
    cleaned = []

    async def cleanup(redis, task_id, id=None):
        cleaned.append((task_id, id))

    monkeypatch.setattr(tasks, 'cleanup_task', cleanup)

    async def scenario():
        async def work():
            return 'done'

        task_id, task = await tasks.create_task(None, work(), id='chat-1', task_id='t1')
        assert await task == 'done'
        # The done callback starts the cleanup; let it run.
        while background._running:
            await asyncio.gather(*background._running)
        tasks.tasks.pop(task_id, None)
        tasks.item_tasks.pop('chat-1', None)

    asyncio.run(scenario())
    assert cleaned == [('t1', 'chat-1')]
