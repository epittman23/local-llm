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


def test_a_channel_run_is_announced_before_its_reply_is_dispatched(monkeypatch):
    # The router no longer publishes AUTOMATION_RUN_STARTED for a manual run,
    # so the channel path, which returns before the chat path's announcement,
    # announces its own run.
    order: list[str] = []
    published: list[tuple] = []

    async def config_get(key, default=None):
        return True if key == 'channels.enable' else default

    async def model_defaults(app, model_id, user=None, token=None):
        return None, None, None, None

    async def new_message_handler(request, channel_id, form, user, db):
        return SimpleNamespace(id='m1', parent_id=None), SimpleNamespace(id='ch1')

    class _Db:
        async def __aenter__(self):
            return None

        async def __aexit__(self, *exc):
            return False

    async def publish(app, event, **kwargs):
        order.append('published')
        published.append((event, kwargs['data']))

    async def handler(request, form_data, user=None):
        order.append('dispatched')

    async def record_run(*args, **kwargs):
        pass

    async def emit(*args, **kwargs):
        pass

    from local_llm.routers import channels
    from local_llm.socket import main as socket_main

    monkeypatch.setattr(automations.Config, 'get', config_get)
    monkeypatch.setattr(automations, '_resolve_model_defaults', model_defaults)
    monkeypatch.setattr(automations, '_build_request', lambda app, token=None: None)
    monkeypatch.setattr(automations, 'get_async_db', _Db)
    monkeypatch.setattr(channels, 'new_message_handler', new_message_handler)
    monkeypatch.setattr(automations, 'publish_event', publish)
    monkeypatch.setattr(automations, '_record_run', record_run)
    monkeypatch.setattr(socket_main.sio, 'emit', emit)

    app = SimpleNamespace(state=SimpleNamespace(MODELS={}, CHAT_COMPLETION_HANDLER=handler))
    automation = SimpleNamespace(id='auto-1', name='Daily digest', user_id='u1', data={'target': {'channel_id': 'ch1'}})
    user = SimpleNamespace(id='u1', name='Eli')

    asyncio.run(automations._execute_channel_automation(app, automation, user, 'hi', 'm', 'tok'))

    assert order[:2] == ['published', 'dispatched']
    assert published[0] == (EVENTS.AUTOMATION_RUN_STARTED, {'name': 'Daily digest', 'chat_id': 'channel:ch1'})


def test_a_stopped_reply_is_a_failure(monkeypatch):
    # Stop cancels the reply's task; its partial save marks the message done
    # with no error, so only the task says the reply was stopped.
    from local_llm import tasks as task_registry

    async def scenario():
        task = asyncio.create_task(asyncio.sleep(10))
        monkeypatch.setitem(task_registry.tasks, 't1', task)
        asyncio.get_running_loop().call_later(0.01, task.cancel)
        return await automations._wait_for_reply({'task_ids': ['t1']})

    assert asyncio.run(scenario()) == automations.REPLY_STOPPED


def test_a_reply_that_outlasts_the_wait_is_recorded_as_unfinished(monkeypatch):
    from local_llm import tasks as task_registry

    async def scenario():
        task = asyncio.create_task(asyncio.sleep(10))
        monkeypatch.setitem(task_registry.tasks, 't1', task)
        try:
            return await automations._wait_for_reply({'task_ids': ['t1']}, wait_seconds=0.01)
        finally:
            task.cancel()

    assert asyncio.run(scenario()) == 'The reply did not finish within 0 s'


def test_a_missing_reply_is_a_failure(monkeypatch):
    runs, _, _ = _finish(monkeypatch, stored_message=None)

    assert runs == [('auto-1', 'error', 'c1', 'The reply was not found')]


def test_a_provider_error_without_a_message_keeps_its_fields(monkeypatch):
    stored = {'done': True, 'error': {'content': {'code': 500, 'type': 'server_error'}}}
    runs, _, _ = _finish(monkeypatch, stored_message=stored)

    assert runs == [('auto-1', 'error', 'c1', "{'code': 500, 'type': 'server_error'}")]


def test_a_reply_that_cannot_be_read_is_still_recorded(monkeypatch):
    async def broken(chat_id, message_id):
        raise RuntimeError('database went away')

    runs, published, _ = _finish(monkeypatch, stored_message={'done': True})
    runs.clear()
    published.clear()
    monkeypatch.setattr(automations.Chats, 'get_message_by_id_and_message_id', broken)
    asyncio.run(automations.finish_automation_run(None, USER, METADATA))

    assert runs == [('auto-1', 'error', 'c1', 'The reply could not be read')]
    assert [p[0] for p in published] == [EVENTS.AUTOMATION_RUN_FAILED]


def test_an_automation_deleted_during_its_reply_gets_no_run(monkeypatch):
    async def gone(automation_id):
        return None

    runs, published, _ = _finish(monkeypatch, stored_message={'done': True})
    runs.clear()
    published.clear()
    monkeypatch.setattr(automations.Automations, 'get_by_id', gone)
    asyncio.run(automations.finish_automation_run(None, USER, METADATA))

    assert runs == []
    assert published == []


def _chat_run(monkeypatch, handler, stored_message):
    """Drive execute_automation's chat path with a fake chat pipeline."""
    events: list[tuple] = []

    async def get_user(user_id):
        return SimpleNamespace(id='u1', role='admin', name='Eli')

    async def prompt_template(prompt, user):
        return prompt

    async def config_get(key, default=None):
        return default

    async def insert_chat(chat_id, user_id, form):
        return SimpleNamespace(id=chat_id)

    async def model_defaults(app, model_id, user=None, token=None):
        return None, None, None, None

    async def record_run(automation_id, status, chat_id=None, error=None):
        events.append(('run', status, error))

    async def publish(app, event, **kwargs):
        events.append(('event', event))

    async def emit(name, payload, room=None):
        if name == 'automation:result':
            events.append(('result', payload['status']))

    async def get_message(chat_id, message_id):
        return stored_message

    async def get_automation(automation_id):
        return SimpleNamespace(id=automation_id, name='Daily digest')

    from local_llm.socket import main as socket_main

    monkeypatch.setattr(automations.Users, 'get_user_by_id', get_user)
    monkeypatch.setattr(automations, 'prompt_template', prompt_template)
    monkeypatch.setattr(automations.Config, 'get', config_get)
    monkeypatch.setattr(automations.Chats, 'insert_new_chat', insert_chat)
    monkeypatch.setattr(automations.Chats, 'get_message_by_id_and_message_id', get_message)
    monkeypatch.setattr(automations.Automations, 'get_by_id', get_automation)
    monkeypatch.setattr(automations, '_resolve_model_defaults', model_defaults)
    monkeypatch.setattr(automations, '_build_request', lambda app, token=None: None)
    monkeypatch.setattr(automations, '_record_run', record_run)
    monkeypatch.setattr(automations, 'publish_event', publish)
    monkeypatch.setattr(socket_main.sio, 'emit', emit)

    app = SimpleNamespace(state=SimpleNamespace(CHAT_COMPLETION_HANDLER=handler))
    automation = SimpleNamespace(
        id='auto-1', name='Daily digest', user_id='u1', folder_id=None, data={'prompt': 'hi', 'model_id': 'm'}
    )
    return app, automation, events


def test_a_chat_run_is_announced_then_recorded_once_its_reply_fails(monkeypatch):
    from local_llm import tasks as task_registry

    async def handler(request, form_data, user=None):
        async def reply():
            await asyncio.sleep(0.01)

        monkeypatch.setitem(task_registry.tasks, 't1', asyncio.create_task(reply()))
        return {'status': True, 'task_ids': ['t1']}

    stored = {'done': True, 'error': {'content': '401: invalid API key'}}
    app, automation, events = _chat_run(monkeypatch, handler, stored)
    asyncio.run(automations.execute_automation(app, automation))

    assert events == [
        ('event', EVENTS.AUTOMATION_RUN_STARTED),
        ('run', 'error', '401: invalid API key'),
        ('result', 'error'),
        ('event', EVENTS.AUTOMATION_RUN_FAILED),
    ]


def test_a_chat_run_interrupted_by_a_shutdown_is_still_recorded(monkeypatch):
    from local_llm import tasks as task_registry

    async def handler(request, form_data, user=None):
        monkeypatch.setitem(task_registry.tasks, 't1', asyncio.create_task(asyncio.sleep(10)))
        return {'status': True, 'task_ids': ['t1']}

    app, automation, events = _chat_run(monkeypatch, handler, {'done': False})

    async def scenario():
        run = asyncio.create_task(automations.execute_automation(app, automation))
        await asyncio.sleep(0.05)
        run.cancel()
        try:
            await run
        except asyncio.CancelledError:
            return True
        finally:
            task_registry.tasks['t1'].cancel()
        return False

    assert asyncio.run(scenario()) is True
    assert events[1:] == [
        ('run', 'error', automations.REPLY_INTERRUPTED),
        ('result', 'error'),
        ('event', EVENTS.AUTOMATION_RUN_FAILED),
    ]
