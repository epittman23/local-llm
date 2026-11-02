"""Stopping a chat's tasks stops every one of them, and says which (#298).

Without Redis, `list_task_ids_by_item_id` handed back the live
`item_tasks` list. `stop_item_tasks` looped over it while each awaited
cancellation let the stopped task's cleanup remove its id from that same
list, so with three or more tasks the loop skipped one and still reported
"All tasks ... stopped". An id whose task had already ended (stopped on its
own, cleanup still pending) also made the loop return early, leaving the
rest running.

Run from apps/server:

    python -m pytest tests/test_stop_item_tasks.py
"""

from __future__ import annotations

import asyncio

import pytest

from local_llm import tasks
from local_llm.utils import background


@pytest.fixture(autouse=True)
def fresh_registry(monkeypatch):
    monkeypatch.setattr(tasks, 'tasks', {})
    monkeypatch.setattr(tasks, 'item_tasks', {})
    monkeypatch.setattr(tasks, 'response_streams', {})


async def _start(count: int, item_id: str) -> list[asyncio.Task]:
    started = []
    for n in range(1, count + 1):
        _, task = await tasks.create_task(None, asyncio.Event().wait(), id=item_id, task_id=f't{n}')
        started.append(task)
    await asyncio.sleep(0)  # let them start
    return started


async def _settle():
    # The done callbacks start the cleanups; let them all finish in this loop.
    while background._running:
        await asyncio.gather(*background._running)


@pytest.mark.parametrize('count', [1, 2, 3, 5])
def test_every_task_of_a_chat_is_stopped(count):
    async def scenario():
        started = await _start(count, 'chat-1')

        result = await tasks.stop_item_tasks(None, 'chat-1')

        assert [t.cancelled() for t in started] == [True] * count
        assert result['status'] is True
        assert result['stopped'] == [f't{n}' for n in range(1, count + 1)]
        await _settle()
        assert not await tasks.has_active_tasks(None, 'chat-1')
        assert tasks.tasks == {}

    asyncio.run(scenario())


def test_the_listed_ids_are_a_copy_of_the_registry():
    async def scenario():
        await _start(2, 'chat-1')
        listed = await tasks.list_task_ids_by_item_id(None, 'chat-1')
        listed.append('not-a-task')
        assert tasks.item_tasks['chat-1'] == ['t1', 't2']
        await tasks.stop_item_tasks(None, 'chat-1')
        await _settle()

    asyncio.run(scenario())


def test_an_already_ended_task_does_not_leave_the_rest_running():
    async def scenario():
        started = await _start(3, 'chat-1')
        # Stopped on its own (the UI stops tasks by id too); its id stays in
        # item_tasks until the background cleanup runs.
        await tasks.stop_task(None, 't1')
        assert 't1' in tasks.item_tasks['chat-1']

        result = await tasks.stop_item_tasks(None, 'chat-1')

        assert [t.cancelled() for t in started] == [True, True, True]
        assert result['status'] is True
        assert result['stopped'] == ['t2', 't3']
        assert not result['message'].startswith('No tasks found')
        await _settle()
        assert not await tasks.has_active_tasks(None, 'chat-1')

    asyncio.run(scenario())


def test_a_chat_without_tasks_says_so():
    result = asyncio.run(tasks.stop_item_tasks(None, 'chat-1'))
    assert result['status'] is True
    assert result['stopped'] == []
    assert result['message'].startswith('No tasks found')
