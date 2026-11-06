"""Shutdown stops running chat replies before it closes the HTTP pool (#362).

The lifespan's shutdown closed the shared aiohttp pool first and never
cancelled the chat tasks, so a reply streaming at the time (every `make
backend` reload) broke on a closed connection and took the stream-failure
path instead of being saved as stopped. Shutdown now cancels the tasks in
the registry and waits, a bounded time, for them to save, and only then
closes the pool.

Run from apps/server (any LLLM_SECRET_KEY of 32 characters or more):

    LLLM_SECRET_KEY=... python -m pytest tests/test_shutdown_stops_chat_tasks.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from local_llm import main
from local_llm import tasks as registry


def test_stop_all_tasks_cancels_each_and_waits_for_it_to_save(monkeypatch):
    saved: list[str] = []

    async def reply(name):
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            await asyncio.sleep(0.01)  # saving what arrived takes a moment
            saved.append(name)
            raise

    async def scenario():
        for name in ('r1', 'r2'):
            await registry.create_task(None, reply(name), id='chat', task_id=name)
        await asyncio.sleep(0)  # the replies are streaming when shutdown comes
        stopped = await registry.stop_all_tasks(wait_seconds=1)
        return stopped

    monkeypatch.setattr(registry, 'tasks', {})
    monkeypatch.setattr(registry, 'item_tasks', {})
    monkeypatch.setattr(registry, 'stopping', False)
    assert asyncio.run(scenario()) == 2
    assert sorted(saved) == ['r1', 'r2']
    assert registry.stopping is True


def test_stop_all_tasks_does_not_wait_past_its_limit(monkeypatch):
    async def stubborn():
        # Ignores cancellation for half a second, then ends, so the event
        # loop can always close even if the code under test misbehaves.
        loop = asyncio.get_running_loop()
        until = loop.time() + 0.5
        while loop.time() < until:
            try:
                await asyncio.sleep(until - loop.time())
            except asyncio.CancelledError:
                continue

    async def scenario():
        await registry.create_task(None, stubborn(), id='chat', task_id='s1')
        await asyncio.sleep(0)
        loop = asyncio.get_running_loop()
        started = loop.time()
        await registry.stop_all_tasks(wait_seconds=0.05)
        took = loop.time() - started
        await asyncio.gather(*registry.tasks.values(), return_exceptions=True)
        return took

    monkeypatch.setattr(registry, 'tasks', {})
    monkeypatch.setattr(registry, 'item_tasks', {})
    monkeypatch.setattr(registry, 'stopping', False)
    assert asyncio.run(scenario()) < 1


def test_shutdown_stops_the_chat_tasks_before_closing_the_pool(monkeypatch):
    order: list[str] = []

    async def stop_all_tasks(wait_seconds):
        order.append('stop chat tasks')
        return 0

    async def close_session():
        order.append('close pool')

    async def publish_event(app, event, **kwargs):
        order.append(f'publish {event.name}')

    from local_llm.utils import session_pool

    monkeypatch.setattr(main, 'stop_all_tasks', stop_all_tasks)
    monkeypatch.setattr(session_pool, 'close_session', close_session)
    monkeypatch.setattr(main, 'publish_event', publish_event)
    monkeypatch.setattr(main, 'LLLM_STOP_JOBS_ON_SHUTDOWN', False)
    background = SimpleNamespace(cancel=lambda: order.append('cancel background'))
    state = SimpleNamespace(
        periodic_usage_pool_cleanup=background,
        periodic_session_pool_cleanup=background,
        scheduler_worker_loop=background,
    )

    async def stop_jobs():
        order.append('stop served model and jobs')

    monkeypatch.setattr(main, 'LLLM_STOP_JOBS_ON_SHUTDOWN', True)
    monkeypatch.setattr(main.benchmarks, 'shutdown', stop_jobs)

    asyncio.run(main._shutdown(SimpleNamespace(state=state)))

    # Replies first: one may be streaming from the served model.
    assert order.index('stop chat tasks') < order.index('stop served model and jobs')
    assert order.index('stop chat tasks') < order.index('close pool')


def test_a_reply_started_while_stopping_is_stopped_too(monkeypatch):
    # A sub-agent's result, or a parent reply's finally, can start another
    # reply as the first one ends; the snapshot would miss it.
    ended: list[str] = []

    async def follow_up():
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            ended.append('follow-up')
            raise

    async def parent():
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            await registry.create_task(None, follow_up(), id='chat', task_id='f1')
            ended.append('parent')
            raise

    async def scenario():
        await registry.create_task(None, parent(), id='chat', task_id='p1')
        await asyncio.sleep(0)
        stopped = await registry.stop_all_tasks(wait_seconds=1)
        return stopped

    monkeypatch.setattr(registry, 'tasks', {})
    monkeypatch.setattr(registry, 'item_tasks', {})
    monkeypatch.setattr(registry, 'stopping', False)
    assert asyncio.run(scenario()) == 2
    assert ended == ['parent', 'follow-up']


def test_an_automation_reply_cut_by_shutdown_reads_interrupted_not_stopped(monkeypatch):
    from local_llm.utils import automations

    async def scenario():
        task = asyncio.create_task(asyncio.sleep(10))
        monkeypatch.setitem(registry.tasks, 't1', task)
        monkeypatch.setattr(registry, 'stopping', True)
        asyncio.get_running_loop().call_later(0.01, task.cancel)
        return await automations._wait_for_reply({'task_ids': ['t1']})

    assert asyncio.run(scenario()) == automations.REPLY_INTERRUPTED


def test_pending_sub_agent_results_start_no_reply_while_stopping(monkeypatch):
    from local_llm.utils import subagents

    async def has_active_tasks(*args):
        raise AssertionError('should not look for a reply to wait on')

    monkeypatch.setattr(registry, 'stopping', True)
    monkeypatch.setattr(subagents, 'has_active_tasks', has_active_tasks)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(redis=None)))

    assert asyncio.run(subagents.process_pending_internal_messages(request, 'chat', 'u1', {})) is None
