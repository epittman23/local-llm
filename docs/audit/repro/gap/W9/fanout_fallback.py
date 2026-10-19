"""Drive main.chat_completion -> _fan_out_chat with DB-touching helpers stubbed, and record what each
per-model _process_chat call receives.

Case 1: custom model 'custom' whose base model is gone; ENABLE_CUSTOM_MODEL_FALLBACK picks 'fallback'.
Case 2: two-model chat (A primary, B second) where only A's workspace params are merged.
"""

import asyncio
import types

from starlette.requests import Request

import local_llm.main as main

calls = []


async def fake_process_chat(request, form_data, user, metadata, model, tasks=None):
    calls.append({'form_model': form_data['model'], 'resolved_model': model['id'], 'params': form_data.get('params')})
    return {'ok': True}


async def fake_create_task(redis, coroutine, id=None, task_id=None):
    await coroutine
    return task_id, None


async def fake_get_event_emitter(*a, **k):
    return None


async def fake_tool_approval_mode(form_data, chat_id, automation_id):
    return 'full'


main._process_chat = fake_process_chat
main.create_task = fake_create_task
main.get_event_emitter = fake_get_event_emitter
main._tool_approval_mode = fake_tool_approval_mode

user = types.SimpleNamespace(id='u1', role='admin')


def make_request():
    scope = {
        'type': 'http',
        'method': 'POST',
        'path': '/api/chat/completions',
        'headers': [],
        'query_string': b'',
        'app': main.app,
    }
    return Request(scope)


async def case_fallback():
    calls.clear()
    custom = {'id': 'custom', 'owned_by': 'openai', 'info': {'meta': {}}}
    fallback = {'id': 'fallback', 'owned_by': 'openai', 'info': {'meta': {}}}
    main.app.state.MODELS = {'custom': custom, 'fallback': fallback}

    async def fake_resolve(request, model_id, model_item, user):
        return custom, None, fallback, True

    async def fake_merge(form_data, model_info):
        return {}

    main._resolve_chat_model = fake_resolve
    main._merge_chat_params = fake_merge

    body = {
        'model': 'custom',
        'messages': [{'role': 'user', 'content': 'hi'}],
        'session_id': 'sid',
        'chat_id': 'local:sid',
        'id': 'assistant-1',
    }
    await main.chat_completion(make_request(), body, user)
    print('fallback case ->', calls)


async def case_multimodel():
    calls.clear()
    A = {'id': 'A', 'owned_by': 'openai', 'info': {'meta': {}}}
    B = {'id': 'B', 'owned_by': 'openai', 'info': {'meta': {}}}
    main.app.state.MODELS = {'A': A, 'B': B}

    async def fake_resolve(request, model_id, model_item, user):
        return main.app.state.MODELS[model_id], None, None, False

    async def fake_merge(form_data, model_info):
        # what _merge_chat_params produces for the primary model's workspace params
        form_data['params'] = {'temperature': 0.2, 'max_tokens': 512, 'system': 'A system'}
        return dict(form_data['params'])

    main._resolve_chat_model = fake_resolve
    main._merge_chat_params = fake_merge

    body = {
        'model': 'A',
        'messages': [{'role': 'user', 'content': 'hi'}],
        'session_id': 'sid',
        'chat_id': 'local:sid',
        'message_ids': [{'model_id': 'A', 'message_id': 'm-a'}, {'model_id': 'B', 'message_id': 'm-b'}],
    }
    await main.chat_completion(make_request(), body, user)
    for c in calls:
        print('multi-model ->', c)
    print('same params object:', calls[0]['params'] is calls[1]['params'])


asyncio.run(case_fallback())
asyncio.run(case_multimodel())
