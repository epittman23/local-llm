"""An automation run records how its reply ended, not that it was dispatched (#264).

execute_automation awaited the chat handler, which only dispatches the reply
to a background task, and then recorded the run as a success and published
AUTOMATION_RUN_COMPLETED. A model or provider failure afterwards never
reached the run history or the webhooks. The reply's task now records the
outcome when the reply ends (main._process_chat calls
finish_automation_run), and the dispatch publishes AUTOMATION_RUN_STARTED.

Run from apps/server:

    python -m pytest tests/test_automation_run_outcome.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from local_llm import main
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


def _process(monkeypatch, *, fails: bool):
    finished: list[tuple] = []

    async def finish(request, user, metadata, error=None):
        finished.append((metadata.get('automation_id'), error))

    async def process_chat_payload(request, form_data, user, metadata, model):
        return form_data, metadata, []

    async def no(*args, **kwargs):
        return False

    async def nothing(*args, **kwargs):
        return None

    async def completion(request, form_data, user):
        return object()

    async def process_chat_response(response, ctx):
        if fails:
            raise RuntimeError('upstream 500')
        return {'status': True}

    monkeypatch.setattr(main, '_finish_automation_run', finish)
    monkeypatch.setattr(main, 'process_chat_payload', process_chat_payload)
    monkeypatch.setattr(main, 'drain_approved_tool_calls', no)
    monkeypatch.setattr(main, 'chat_completion_handler', completion)
    monkeypatch.setattr(main, 'build_chat_response_context', nothing)
    monkeypatch.setattr(main, 'process_chat_response', process_chat_response)
    monkeypatch.setattr(main, '_report_chat_error', nothing)
    for name in ('_disconnect_mcp_clients', '_end_chat_task', '_run_pending_internal_messages'):
        monkeypatch.setattr(main, name, nothing)

    asyncio.run(main._process_chat(SimpleNamespace(app=None), {}, USER, dict(METADATA), {}))
    return finished


def test_the_reply_task_reports_a_finished_run_once(monkeypatch):
    assert _process(monkeypatch, fails=False) == [('auto-1', None)]


def test_the_reply_task_reports_a_failed_run_once_with_its_error(monkeypatch):
    assert _process(monkeypatch, fails=True) == [('auto-1', 'upstream 500')]
