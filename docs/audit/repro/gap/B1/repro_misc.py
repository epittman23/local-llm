"""B1 repros: drain replay drops images, non-streaming empty content, query JSON rfind."""

import asyncio
import copy
import json
from types import SimpleNamespace

import pytest

from local_llm.utils import middleware

# (a) The tool-approval resume rebuilds messages with process_messages_with_output only.
stored = [
    {'id': 'u1', 'role': 'user', 'content': 'What is in this chart?',
     'files': [{'type': 'image', 'url': 'data:image/png;base64,AAAA'}]},
]
drain_messages = middleware.sanitize_tool_pairs(middleware.process_messages_with_output(copy.deepcopy(stored)))
print('(a) drain path messages      :', json.dumps(drain_messages))
normal = copy.deepcopy(stored)
middleware._inline_message_images(normal)
print('(a) normal replay messages   :', json.dumps(middleware.process_messages_with_output(normal)))

# (b) Non-streaming reply with tool_calls only / empty content.
mp = pytest.MonkeyPatch()
log = []


async def upsert(chat_id, message_id, data, touch=True):
    log.append(['upsert', data])


async def title(chat_id):
    return 'T'


async def emitter(event):
    log.append(['emit', event])


async def noop(*a, **k):
    log.append(['called', a[0] if a else k])


mp.setattr(middleware.Chats, 'upsert_message_to_chat_by_id_and_message_id', upsert)
mp.setattr(middleware.Chats, 'get_chat_title_by_id', title)
mp.setattr(middleware, 'publish_chat_finished_event', noop)
mp.setattr(middleware, 'outlet_filter_handler', noop)
mp.setattr(middleware, 'background_tasks_handler', noop)
for label, message in [
    ('tool_calls only', {'role': 'assistant', 'content': None,
                         'tool_calls': [{'id': 'c1', 'type': 'function',
                                         'function': {'name': 'search_web', 'arguments': '{"query":"x"}'}}]}),
    ('reasoning only (length)', {'role': 'assistant', 'content': '', 'reasoning_content': 'long thinking...'}),
]:
    log.clear()
    ctx = {
        'request': SimpleNamespace(state=SimpleNamespace()),
        'user': SimpleNamespace(id='u'),
        'metadata': {'chat_id': '7f1c0d9e-3b5a-4c1e-9a2f-0b8d6e4c2a10', 'message_id': 'a1'},
        'events': [],
        'event_emitter': emitter,
    }
    asyncio.run(middleware.non_streaming_chat_response_handler(
        {'choices': [{'message': message, 'finish_reason': 'tool_calls'}]}, ctx))
    print(f'(b) non-streaming {label}: DB writes / events =', log)
mp.undo()

# (c) generated search queries containing a brace
mp = pytest.MonkeyPatch()
seen = {}


async def gen_queries(request, body, user):
    return {'choices': [{'message': {'content': '{"queries": ["python {set} comprehension syntax"]}'}}]}


async def web_search(request, form, user):
    seen['queries'] = form.queries
    return None


async def emit(event):
    pass


mp.setattr(middleware, 'generate_queries', gen_queries)
mp.setattr(middleware, 'process_web_search', web_search)
mp.setattr(middleware, 'ENABLE_QUERIES_CACHE', False)
asyncio.run(middleware.chat_web_search_handler(
    SimpleNamespace(state=SimpleNamespace()),
    {'model': 'm', 'messages': [{'role': 'user', 'content': 'python set comprehension?'}]},
    {'__event_emitter__': emit}, None))
print('(c) queries sent to the search engine:', seen.get('queries'))
mp.undo()
