"""An automation run records how its reply ended, not that it was dispatched (#264).

execute_automation awaited the chat handler, which only dispatches the reply
to a background task, and then recorded the run as a success and published
AUTOMATION_RUN_COMPLETED. A model or provider failure afterwards never
reached the run history or the webhooks. The run now waits for the
dispatched tasks (it runs in the background itself), then records the
outcome from the stored message. It publishes AUTOMATION_RUN_STARTED once,
before the dispatch, for a scheduled and a manual run alike.

Run from apps/server:

    python -m pytest tests/test_automation_run_outcome.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from local_llm.events import EVENTS
from local_llm.utils import automations

USER = SimpleNamespace(id='u1')
METADATA = {'chat_id': 'c1', 'message_id': 'r1', 'automation_id': 'auto-1'}


def _finish(monkeypatch, *, stored_message=None, error=None):
    runs: list[tuple] = []
    published: list[tuple] = []
    emitted: list[dict] = []

    async def record_run(automation_id, status, chat_id=None, error=None):
        runs.append((automation_id, status, chat_id, error))

    async def publish(app, event, **kwargs):
        published.append((event, kwargs['data']))

    async def get_message(chat_id, message_id):
        return stored_message

    async def get_automation(automation_id):
        return SimpleNamespace(id=automation_id, name='Daily digest')

    async def emit(name, payload, room=None):
        emitted.append(payload)

    from local_llm.socket import main as socket_main

    monkeypatch.setattr(automations, '_record_run', record_run)
    monkeypatch.setattr(automations, 'publish_event', publish)
    monkeypatch.setattr(automations.Chats, 'get_message_by_id_and_message_id', get_message)
    monkeypatch.setattr(automations.Automations, 'get_by_id', get_automation)
    monkeypatch.setattr(socket_main.sio, 'emit', emit)

    asyncio.run(automations.finish_automation_run(None, USER, METADATA, error))
    return runs, published, emitted


def test_a_reply_that_ended_well_records_a_success(monkeypatch):
    runs, published, emitted = _finish(monkeypatch, stored_message={'done': True, 'content': 'digest'})

    assert runs == [('auto-1', 'success', 'c1', None)]
    assert [p[0] for p in published] == [EVENTS.AUTOMATION_RUN_COMPLETED]
    assert emitted[0]['status'] == 'success'


def test_a_reply_that_failed_records_the_error(monkeypatch):
    runs, published, _ = _finish(monkeypatch, error='401: invalid API key')

    assert runs == [('auto-1', 'error', 'c1', '401: invalid API key')]
    assert published == [
        (EVENTS.AUTOMATION_RUN_FAILED, {'name': 'Daily digest', 'chat_id': 'c1', 'error': '401: invalid API key'})
    ]


def test_a_provider_error_saved_inside_the_stream_is_a_failure(monkeypatch):
    stored = {'done': True, 'content': 'partial', 'error': {'content': 'Provider disconnected'}}
    runs, published, _ = _finish(monkeypatch, stored_message=stored)

    assert runs == [('auto-1', 'error', 'c1', 'Provider disconnected')]
    assert [p[0] for p in published] == [EVENTS.AUTOMATION_RUN_FAILED]


def test_a_reply_that_never_finished_is_a_failure(monkeypatch):
    runs, _, _ = _finish(monkeypatch, stored_message={'done': False, 'content': 'half'})

    assert runs == [('auto-1', 'error', 'c1', 'The reply did not finish')]


def test_the_run_waits_for_the_tasks_the_chat_dispatched(monkeypatch):
    from local_llm import tasks as task_registry

    order: list[str] = []

    async def scenario():
        async def reply():
            await asyncio.sleep(0.05)
            order.append('reply ended')

        task = asyncio.create_task(reply())
        monkeypatch.setitem(task_registry.tasks, 't1', task)
        await automations._wait_for_reply({'status': True, 'task_ids': ['t1', 'gone']})
        order.append('outcome recorded')

    asyncio.run(scenario())

    assert order == ['reply ended', 'outcome recorded']


def test_a_provider_error_object_is_recorded_as_its_message(monkeypatch):
    stored = {'done': True, 'error': {'content': {'message': 'Invalid API key', 'code': 401}}}
    runs, _, _ = _finish(monkeypatch, stored_message=stored)

    assert runs == [('auto-1', 'error', 'c1', 'Invalid API key')]


def test_an_empty_error_is_still_a_failure_with_a_reason(monkeypatch):
    runs, _, _ = _finish(monkeypatch, stored_message={'done': True, 'error': {'content': None}})

    assert runs == [('auto-1', 'error', 'c1', 'The reply failed')]
