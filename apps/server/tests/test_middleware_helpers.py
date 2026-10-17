"""Characterization tests for three chat middleware steps in utils/middleware.py.

handle_responses_streaming_event, process_tool_result and
background_tasks_handler were refactored for ruff's complexity limit with no
tests of their own, so these pin what they did before the refactor:
- handle_responses_streaming_event: the output list and metadata each
  Responses API stream event produces, and what it did to the list it was
  given;
- process_tool_result: the text, files and embeds a tool's result becomes,
  and what it did to a list result it was given;
- background_tasks_handler: every follow-up, title and tag request, chat
  write, event and memory review it makes after a reply.
The task models, chats, uploads, memory review and event emitter are fakes
that record their calls. Each case was recorded from the untouched
functions into fixtures/middleware_helpers.json and must not change.

The golden file is only ever written by hand, never by this test. To record
it again (only for an intended behaviour change, reviewed as such), run
`MIDDLEWARE_HELPERS_GOLDEN_RECORD=1 pytest tests/test_middleware_helpers.py`.
"""

import asyncio
import copy
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.responses import HTMLResponse

from local_llm.constants import TASKS
from local_llm.utils import middleware

GOLDEN = Path(__file__).parent / 'fixtures' / 'middleware_helpers.json'
RECORD = os.environ.get('MIDDLEWARE_HELPERS_GOLDEN_RECORD') == '1'

# --- handle_responses_streaming_event ----------------------------------------

MSG = {'type': 'message', 'id': 'msg1', 'content': [{'type': 'output_text', 'text': 'Hel'}]}
MSG_BARE = {'type': 'message', 'id': 'msg2'}
REASONING = {'type': 'reasoning', 'id': 'rs1', 'summary': [{'type': 'summary_text', 'text': 'Thin'}]}
REASONING_BARE = {'type': 'reasoning', 'id': 'rs2'}
CALL = {'type': 'function_call', 'id': 'fc1', 'call_id': 'call1', 'arguments': '{"a"'}
OTHER = {'type': 'web_search_call', 'id': 'ws1'}

STREAM_CASES = [
    ('item_added_appended', {'type': 'response.output_item.added', 'item': CALL}, [MSG]),
    ('item_added_at_index', {'type': 'response.output_item.added', 'item': OTHER, 'output_index': 0}, [MSG]),
    (
        'item_added_replaces_same_id',
        {'type': 'response.output_item.added', 'item': {**MSG, 'status': 'x'}},
        [MSG, CALL],
    ),
    (
        'item_added_replaces_same_call_id',
        {'type': 'response.output_item.added', 'item': {'type': 'function_call', 'call_id': 'call1'}},
        [CALL],
    ),
    ('item_added_empty', {'type': 'response.output_item.added', 'item': {}}, [MSG]),
    (
        'part_added_to_message',
        {'type': 'response.content_part.added', 'part': {'type': 'output_text'}, 'output_index': 0},
        [MSG],
    ),
    (
        'part_added_creates_content',
        {'type': 'response.content_part.added', 'part': {'type': 'output_text'}},
        [MSG_BARE],
    ),
    ('part_added_to_reasoning_ignored', {'type': 'response.content_part.added', 'part': {'type': 'x'}}, [REASONING]),
    ('part_added_out_of_range', {'type': 'response.content_part.added', 'part': {}, 'output_index': 5}, [MSG]),
    ('part_added_no_output', {'type': 'response.content_part.added', 'part': {}}, []),
    (
        'summary_part_added',
        {'type': 'response.reasoning_summary_part.added', 'part': {'type': 'summary_text'}},
        [REASONING],
    ),
    (
        'summary_part_creates_summary',
        {'type': 'response.reasoning_summary_part.added', 'part': {'t': 1}},
        [REASONING_BARE],
    ),
    ('summary_part_out_of_range', {'type': 'response.reasoning_summary_part.added', 'part': {}}, []),
    ('args_delta', {'type': 'response.function_call_arguments.delta', 'delta': ': 1}'}, [CALL]),
    ('args_delta_not_a_call', {'type': 'response.function_call_arguments.delta', 'delta': 'x'}, [MSG]),
    ('text_delta_message', {'type': 'response.output_text.delta', 'delta': 'lo'}, [MSG]),
    ('text_delta_new_part', {'type': 'response.text.delta', 'delta': 'Hi', 'content_index': 2}, [MSG_BARE]),
    ('dict_delta_message', {'type': 'response.audio.delta', 'delta': {'data': 'AA'}}, [MSG_BARE]),
    (
        'dict_delta_merges',
        {'type': 'response.audio.delta', 'delta': {'data': 'BB'}},
        [{**MSG_BARE, 'content': [{'audio': {'data': 'AA'}}]}],
    ),
    ('reasoning_delta_on_message_skipped', {'type': 'response.reasoning_text.delta', 'delta': 'r'}, [MSG]),
    ('summary_delta', {'type': 'response.reasoning_summary_text.delta', 'delta': 'king'}, [REASONING]),
    (
        'summary_delta_new_index',
        {'type': 'response.reasoning_summary_text.delta', 'delta': 'x', 'summary_index': 1},
        [REASONING_BARE],
    ),
    ('reasoning_text_delta', {'type': 'response.reasoning_text.delta', 'delta': 'step'}, [REASONING_BARE]),
    (
        'reasoning_text_delta_appends',
        {'type': 'response.reasoning_text.delta', 'delta': ' two'},
        [{**REASONING_BARE, 'content': [{'type': 'text', 'text': 'one'}]}],
    ),
    ('text_delta_on_reasoning_skipped', {'type': 'response.output_text.delta', 'delta': 'x'}, [REASONING]),
    ('unknown_delta_on_reasoning', {'type': 'response.weird.delta', 'delta': 'x'}, [REASONING]),
    ('text_delta_other_item', {'type': 'response.text.delta', 'delta': 'q'}, [OTHER]),
    ('custom_delta_other_item', {'type': 'response.status.delta', 'delta': {'s': 1}}, [OTHER]),
    ('text_delta_other_item_appends', {'type': 'response.text.delta', 'delta': 'b'}, [{**OTHER, 'text': 'a'}]),
    ('delta_out_of_range', {'type': 'response.output_text.delta', 'delta': 'x', 'output_index': 3}, [MSG]),
    ('delta_short_type', {'type': 'response.delta', 'delta': 'x'}, [MSG]),
    (
        'item_done_replaces',
        {'type': 'response.output_item.done', 'item': {**MSG, 'status': 'completed'}, 'output_index': 0},
        [MSG],
    ),
    ('item_done_appends', {'type': 'response.output_item.done', 'item': CALL, 'output_index': 4}, [MSG]),
    ('item_done_without_item', {'type': 'response.output_item.done'}, [MSG]),
    (
        'content_part_done',
        {'type': 'response.content_part.done', 'part': {'type': 'output_text', 'text': 'Hello'}, 'output_index': 0},
        [MSG],
    ),
    ('content_part_done_no_content', {'type': 'response.content_part.done', 'part': {'t': 1}}, [MSG_BARE]),
    (
        'content_part_done_bad_index',
        {'type': 'response.content_part.done', 'part': {'t': 1}, 'content_index': 9},
        [MSG],
    ),
    ('content_part_done_no_part', {'type': 'response.content_part.done'}, [MSG]),
    ('summary_part_done', {'type': 'response.reasoning_summary_part.done', 'part': {'text': 'Done'}}, [REASONING]),
    (
        'summary_part_done_no_summary',
        {'type': 'response.reasoning_summary_part.done', 'part': {'t': 1}},
        [REASONING_BARE],
    ),
    (
        'summary_part_done_bad_index',
        {'type': 'response.reasoning_summary_part.done', 'part': {'t': 1}, 'summary_index': 7},
        [REASONING],
    ),
    ('summary_part_done_no_part', {'type': 'response.reasoning_summary_part.done'}, [REASONING]),
    ('text_done_message', {'type': 'response.output_text.done', 'text': 'Hello!'}, [MSG]),
    ('text_done_message_bad_index', {'type': 'response.output_text.done', 'text': 'x', 'content_index': 4}, [MSG]),
    ('text_done_message_no_content', {'type': 'response.output_text.done', 'text': 'x'}, [MSG_BARE]),
    ('args_done', {'type': 'response.function_call_arguments.done', 'arguments': '{"a": 1}'}, [CALL]),
    ('args_done_not_a_call', {'type': 'response.function_call_arguments.done', 'arguments': '{}'}, [MSG]),
    ('reasoning_text_done', {'type': 'response.reasoning_text.done', 'text': 'all'}, [REASONING]),
    ('custom_done_other_item', {'type': 'response.status.done', 'status': 'ok'}, [OTHER]),
    ('done_without_value', {'type': 'response.output_text.done'}, [MSG]),
    ('done_out_of_range', {'type': 'response.output_text.done', 'text': 'x'}, []),
    ('done_completed_type_ignored', {'type': 'response.completed.done'}, [MSG]),
    ('done_short_type', {'type': 'response.done'}, [MSG]),
    (
        'completed_with_output',
        {'type': 'response.completed', 'response': {'output': [REASONING_BARE, MSG], 'usage': {'t': 3}, 'id': 'resp1'}},
        [MSG],
    ),
    (
        'completed_empty_output_keeps_current',
        {'type': 'response.completed', 'response': {'output': []}},
        [REASONING, MSG],
    ),
    ('completed_without_response', {'type': 'response.completed'}, []),
    ('in_progress', {'type': 'response.in_progress'}, [MSG]),
    ('failed', {'type': 'response.failed', 'response': {'error': {'code': 'server_error'}}}, [MSG]),
    ('failed_without_error', {'type': 'response.failed'}, [MSG]),
    ('unknown_event', {'type': 'response.created'}, [MSG]),
    ('no_type', {}, [MSG]),
]


def _run_stream(data, current_output, m):
    given = copy.deepcopy(current_output)
    new_output, meta = middleware.handle_responses_streaming_event(copy.deepcopy(data), given)
    return {
        'new_output': new_output,
        'meta': meta,
        'same_list_returned': new_output is given,
        'given_after': given,
    }


# --- process_tool_result -----------------------------------------------------

INLINE_HTML = {'Content-Disposition': 'inline'}


def _html(status=200, inline=True, body='<b>ui</b>'):
    return HTMLResponse(content=body, status_code=status, headers=INLINE_HTML if inline else {})


TOOL_CASES = [
    ('html_inline_ok', lambda: _html(), 'local'),
    ('html_inline_with_context', lambda: (_html(), {'rows': 3}), 'local'),
    ('html_inline_bad_context', lambda: (_html(), 42), 'local'),
    ('html_inline_client_error', lambda: _html(404), 'local'),
    ('html_inline_server_error', lambda: _html(503), 'local'),
    ('html_inline_other_status', lambda: _html(302), 'local'),
    ('html_attachment', lambda: _html(inline=False, body='plain body'), 'local'),
    (
        'external_html_inline',
        lambda: ('<i>x</i>', {'Content-Disposition': 'inline', 'Content-Type': 'text/html'}),
        'external',
    ),
    (
        'external_html_with_context',
        lambda: (
            ('<i>x</i>', 'context text'),
            {'content-disposition': 'inline', 'content-type': 'text/html; charset=utf-8'},
        ),
        'action',
    ),
    (
        'external_location',
        lambda: ({'ok': 1}, {'Content-Disposition': 'inline', 'Location': 'https://ui.test/x'}),
        'terminal',
    ),
    (
        'external_location_with_context',
        lambda: (['ignored', ['ctx']], {'content-disposition': 'inline', 'location': 'https://ui.test/y'}),
        'external',
    ),
    (
        'external_inline_neither',
        lambda: ({'a': 1}, {'Content-Disposition': 'inline', 'Content-Type': 'application/json'}),
        'external',
    ),
    ('external_attachment', lambda: ({'a': 1}, {'Content-Type': 'application/json'}), 'external'),
    (
        'external_headers_pairs',
        lambda: ('text', [('Content-Disposition', 'inline'), ('Location', 'https://l')]),
        'external',
    ),
    ('external_headers_unusable', lambda: ('text', 7), 'external'),
    ('external_headers_none', lambda: ('text', None), 'external'),
    (
        'direct_tool_pair',
        lambda: [{'a': 1}, {'Content-Disposition': 'inline', 'Content-Type': 'text/html'}],
        'local',
        True,
    ),
    ('image_data_uri', lambda: 'data:image/png;base64,AAAA', 'local'),
    (
        'mcp_items',
        lambda: [
            {'type': 'text', 'text': '{"x": 1}'},
            {'type': 'text', 'text': 'not json'},
            {'type': 'text', 'text': 5},
            {'type': 'image', 'mimeType': 'image/png', 'data': 'QUJD'},
            {'type': 'audio', 'mimeType': 'audio/wav', 'blob': 'V0FW'},
            {'type': 'resource', 'resource': {'text': '{"r": 2}'}},
            {'type': 'resource', 'resource': {'text': 'plain resource'}},
            {'type': 'resource', 'resource': {'blob': 'SU1H', 'mimeType': 'image/jpeg'}},
            {'type': 'resource', 'resource': {'blob': 'QklO', 'uri': 'file:///a.bin'}},
            {'type': 'resource', 'resource': {'uri': 'file:///b.txt'}},
            {'type': 'resource', 'resource': {}},
            {'type': 'unknown'},
            'not a dict',
        ],
        'mcp',
    ),
    ('mcp_single_text', lambda: [{'type': 'text', 'text': 'only'}], 'mcp'),
    (
        'openapi_list_with_data',
        lambda: ['data:text/plain;base64,QQ==', 'keep', 'data:image/png;base64,Qg==', 'also'],
        'local',
    ),
    ('openapi_list_consecutive_data', lambda: ['data:a', 'data:b', 'keep'], 'local'),
    ('dict_result', lambda: {'answer': 'é'}, 'local'),
    ('tuple_result', lambda: ({'data': 1}, 'headers'), 'local'),
    ('empty_tuple_result', lambda: (), 'local'),
    ('number_result', lambda: 42, 'local'),
    ('none_result', lambda: None, 'local'),
    ('string_result', lambda: 'plain', 'local'),
]


def _run_tool(make_result, tool_type, m, direct_tool=False):
    log = []

    async def get_file_url_from_base64(request, data_url, metadata, user):
        log.append(['upload_base64', data_url, metadata, user])
        return f'/files/{len(log)}'

    m.setattr(middleware, 'get_file_url_from_base64', get_file_url_from_base64)
    given = make_result()
    result, files, embeds = asyncio.run(
        middleware.process_tool_result(
            '<request>',
            'my_tool',
            given,
            tool_type,
            direct_tool=direct_tool,
            metadata={'chat_id': 'c1', 'message_id': 'm1', 'session_id': 's1'},
            user='<user>',
        )
    )
    return {
        'result': result,
        'files': files,
        'embeds': embeds,
        'given_after': given if isinstance(given, list) else None,
        'calls': log,
    }


# --- background_tasks_handler --------------------------------------------------

SAVED_CHAT = '7f1c0d9e-3b5a-4c1e-9a2f-0b8d6e4c2a10'


def _map(*messages):
    return {m['id']: m for m in messages}


U1 = {'id': 'u1', 'role': 'user', 'content': 'What is <details>x</details> a monad? ![img](a.png)', 'parentId': None}
A1 = {'id': 'a1', 'role': 'assistant', 'content': 'A monoid in the category.', 'parentId': 'u1', 'model': 'm1'}
TWO = _map(U1, A1)
LONG_USER = {'id': 'u1', 'role': 'user', 'content': 'q' * 150, 'parentId': None}
FOUR = _map(
    {'id': 'u0', 'role': 'user', 'content': [{'type': 'image_url'}, {'type': 'text', 'text': 'Hi'}], 'parentId': None},
    {'id': 'a0', 'content': 'Hello', 'parentId': 'u0', 'model': 'm1'},
    {'id': 'u1', 'role': 'user', 'content': 'More', 'parentId': 'a0'},
    {'id': 'a1', 'role': 'assistant', 'content': 'Sure', 'parentId': 'u1', 'model': 'm1'},
)

ALL_TASKS = {TASKS.FOLLOW_UP_GENERATION: True, TASKS.TITLE_GENERATION: True, TASKS.TAGS_GENERATION: True}


def _reply(content=None, reasoning=None, choices=1):
    message = {}
    if content is not None:
        message['content'] = content
    if reasoning is not None:
        message['reasoning_content'] = reasoning
    return {'choices': [{'message': message}] * choices}


BACKGROUND_CASES = [
    ('saved_chat_deleted', {'chat_id': SAVED_CHAT, 'tasks': ALL_TASKS}, {'messages_map': {}}),
    (
        'saved_chat_all_tasks',
        {'chat_id': SAVED_CHAT, 'tasks': ALL_TASKS},
        {
            'messages_map': TWO,
            'follow_ups': _reply('Sure: {"follow_ups": ["Why?", "How?"]} done'),
            'title': _reply('{"title": "Monads"}'),
            'tags': _reply(reasoning='{"tags": ["math"]}'),
        },
    ),
    (
        'saved_chat_replies_unusable',
        {'chat_id': SAVED_CHAT, 'tasks': ALL_TASKS},
        {
            'messages_map': TWO,
            'follow_ups': _reply('no json here'),
            'title': _reply('{"title": ""}'),
            'tags': _reply('{"tags": broken}'),
        },
    ),
    (
        'saved_chat_two_choices',
        {'chat_id': SAVED_CHAT, 'tasks': ALL_TASKS},
        {
            'messages_map': TWO,
            'follow_ups': _reply('{}', choices=2),
            'title': _reply('{}', choices=2),
            'tags': _reply('{}', choices=2),
        },
    ),
    (
        'saved_chat_title_falls_back_to_reasoning',
        {'chat_id': SAVED_CHAT, 'tasks': {TASKS.TITLE_GENERATION: True}},
        {
            'messages_map': _map(LONG_USER, {**A1, 'parentId': 'u1'}),
            'title': _reply(reasoning='{"title": "From reasoning"}'),
        },
    ),
    (
        'saved_chat_title_from_message_content',
        {'chat_id': SAVED_CHAT, 'tasks': {TASKS.TITLE_GENERATION: True}},
        {'messages_map': _map(U1, {**A1, 'content': 'Answer {"title": "Embedded"}'}), 'title': _reply()},
    ),
    (
        'saved_chat_title_unparseable',
        {'chat_id': SAVED_CHAT, 'tasks': {TASKS.TITLE_GENERATION: True}},
        {'messages_map': TWO, 'title': _reply('{bad json}')},
    ),
    (
        'saved_chat_title_request_fails',
        {'chat_id': SAVED_CHAT, 'tasks': {TASKS.TITLE_GENERATION: True}},
        {'messages_map': TWO, 'title': None},
    ),
    (
        'saved_chat_title_disabled_first_turn',
        {'chat_id': SAVED_CHAT, 'tasks': {TASKS.TITLE_GENERATION: False}},
        {'messages_map': TWO},
    ),
    (
        'saved_chat_title_disabled_later_turn',
        {'chat_id': SAVED_CHAT, 'tasks': {TASKS.TITLE_GENERATION: False, TASKS.TAGS_GENERATION: False}},
        {'messages_map': FOUR},
    ),
    (
        'saved_chat_follow_ups_disabled',
        {'chat_id': SAVED_CHAT, 'tasks': {TASKS.FOLLOW_UP_GENERATION: False}},
        {'messages_map': TWO},
    ),
    (
        'saved_chat_follow_up_emit_fails',
        {'chat_id': SAVED_CHAT, 'tasks': {TASKS.FOLLOW_UP_GENERATION: True}},
        {'messages_map': TWO, 'follow_ups': _reply('{"follow_ups": ["a"]}'), 'emit_raise': True},
    ),
    ('saved_chat_no_tasks', {'chat_id': SAVED_CHAT, 'tasks': None}, {'messages_map': TWO}),
    (
        'saved_chat_follow_up_reply_all_none',
        {'chat_id': SAVED_CHAT, 'tasks': {TASKS.FOLLOW_UP_GENERATION: True, TASKS.TAGS_GENERATION: True}},
        {'messages_map': TWO, 'follow_ups': {'choices': [{'message': {'content': '', 'reasoning_content': None}}]}},
    ),
    (
        'saved_chat_tags_reply_all_none',
        {'chat_id': SAVED_CHAT, 'tasks': {TASKS.TAGS_GENERATION: True}},
        {'messages_map': TWO, 'tags': {'choices': [{'message': {'content': None, 'reasoning_content': None}}]}},
    ),
    (
        'saved_chat_title_reply_and_message_empty',
        {'chat_id': SAVED_CHAT, 'tasks': {TASKS.TITLE_GENERATION: True}},
        {'messages_map': _map(U1, {**A1, 'content': None}), 'title': {'choices': [{'message': {}}]}},
    ),
    (
        'saved_chat_odd_contents_and_no_replies',
        {'chat_id': SAVED_CHAT, 'tasks': {TASKS.FOLLOW_UP_GENERATION: True, TASKS.TAGS_GENERATION: True}},
        {
            'messages_map': _map(
                {'id': 'u1', 'role': 'user', 'content': [{'type': 'image_url'}], 'parentId': None},
                {'id': 'a1', 'role': 'assistant', 'content': None, 'parentId': 'u1', 'model': 'm1'},
            ),
            'follow_ups': None,
            'tags': None,
        },
    ),
    (
        'saved_chat_message_missing',
        {'chat_id': SAVED_CHAT, 'message_id': 'ghost', 'tasks': ALL_TASKS},
        {'messages_map': TWO},
    ),
    (
        'saved_chat_message_without_model',
        {'chat_id': SAVED_CHAT, 'tasks': ALL_TASKS},
        {'messages_map': _map(U1, {k: v for k, v in A1.items() if k != 'model'})},
    ),
    (
        'local_chat',
        {
            'chat_id': 'local:abc',
            'tasks': ALL_TASKS,
            'messages': [
                {'role': 'user', 'content': 'hi'},
                {'role': 'assistant', 'content': 'yo'},
                {'role': 'user', 'content': 'q'},
            ],
        },
        {'follow_ups': _reply('{"follow_ups": ["x"]}')},
    ),
    ('local_chat_no_messages', {'chat_id': 'local:abc', 'tasks': ALL_TASKS, 'messages': []}, {}),
    (
        'local_chat_no_user_message',
        {'chat_id': None, 'tasks': ALL_TASKS, 'messages': [{'role': 'assistant', 'content': 'a'}]},
        {},
    ),
]


def _run_background(kwargs, world, m):
    log = []

    async def get_messages_map_by_chat_id(chat_id):
        log.append(['messages_map', chat_id])
        return copy.deepcopy(world.get('messages_map'))

    def task_model(name):
        async def generate(request, form_data, user):
            log.append([name, copy.deepcopy(form_data), user])
            return copy.deepcopy(world.get(name))

        return generate

    def chats_fake(name):
        async def fake(*args, **kwargs):
            log.append([f'chats.{name}', list(args), kwargs])

        return fake

    async def review_memory_after_turn(**kwargs):
        log.append(['review_memory_after_turn', {k: v for k, v in kwargs.items() if k != 'request'}])

    async def event_emitter(event):
        log.append(['emit', event])
        if world.get('emit_raise'):
            raise RuntimeError('socket closed')

    m.setattr(middleware.Chats, 'get_messages_map_by_chat_id', get_messages_map_by_chat_id)
    m.setattr(middleware, 'generate_follow_ups', task_model('follow_ups'))
    m.setattr(middleware, 'generate_title', task_model('title'))
    m.setattr(middleware, 'generate_chat_tags', task_model('tags'))
    for name in ('upsert_message_to_chat_by_id_and_message_id', 'update_chat_title_by_id', 'update_chat_tags_by_id'):
        m.setattr(middleware.Chats, name, chats_fake(name))
    m.setattr(middleware, 'review_memory_after_turn', review_memory_after_turn)

    form_data = {'model': 'form-model', 'messages': copy.deepcopy(kwargs.get('messages', []))}
    ctx = {
        'request': SimpleNamespace(name='<request>'),
        'form_data': form_data,
        'user': '<user>',
        'metadata': {'chat_id': kwargs['chat_id'], 'message_id': kwargs.get('message_id', 'a1')},
        'tasks': copy.deepcopy(kwargs['tasks']),
        'event_emitter': event_emitter,
        'model': {'id': 'm1'},
        'assistant_message': {'content': 'final'},
    }
    try:
        outcome = {'returned': asyncio.run(middleware.background_tasks_handler(ctx))}
    except Exception as e:
        outcome = {'raised': [type(e).__name__, str(e)]}
    return {**outcome, 'form_messages_after': form_data['messages'], 'calls': log}


# --- harness -------------------------------------------------------------------

CASES = (
    [(f'stream:{c}', 'stream', (d, out)) for c, d, out in STREAM_CASES]
    + [(f'tool:{c[0]}', 'tool', c[1:]) for c in TOOL_CASES]
    + [(f'background:{c}', 'background', (k, w)) for c, k, w in BACKGROUND_CASES]
)


def _run(kind, args, monkeypatch):
    if kind == 'stream':
        observed = _run_stream(*args, monkeypatch)
    elif kind == 'tool':
        observed = _run_tool(args[0], args[1], monkeypatch, *args[2:])
    else:
        observed = _run_background(*args, monkeypatch)
    return json.loads(json.dumps(observed, default=repr))


def _golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding='utf-8'))


def test_case_ids_are_unique():
    ids = [case[0] for case in CASES]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize(('case_id', 'kind', 'args'), CASES, ids=[c[0] for c in CASES])
def test_middleware_step_matches_golden(monkeypatch, case_id, kind, args):
    observed = _run(kind, args, monkeypatch)
    if RECORD:
        pytest.skip('recording')
    assert observed == _golden()[case_id]


def test_record_golden(monkeypatch):
    """Writes the golden file, only when MIDDLEWARE_HELPERS_GOLDEN_RECORD=1."""
    if not RECORD:
        pytest.skip('set MIDDLEWARE_HELPERS_GOLDEN_RECORD=1 to record the golden file')
    golden = {}
    for case_id, kind, args in CASES:
        with monkeypatch.context() as m:
            golden[case_id] = _run(kind, args, m)
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
