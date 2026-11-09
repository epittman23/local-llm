"""Resuming after a tool approval keeps the built context and the user's images (#164).

`drain_approved_tool_calls` runs the approved calls, then rebuilt the
conversation from the database alone. That list had no system message, so
the chat prompt, retrieved context, memories and skills that
process_chat_payload had put there were gone, and it never inlined the
user's image files, so the model lost the images too. It now keeps the
built system message and inlines images, as the normal replay
(`_replay_history_from_db`) does.

Run from apps/server:

    python -m pytest tests/test_tool_approval_drain.py
"""

from __future__ import annotations

import asyncio
import copy
from types import SimpleNamespace
from typing import Any, cast

from local_llm.utils import middleware

# A saved chat stores an uploaded image by its file id (useAttachments.ts).
IMAGE = {'type': 'file', 'url': 'f-123', 'content_type': 'image/png'}
IMAGE_DATA = 'data:image/png;base64,QUJD'


def _drain(monkeypatch, form_messages):
    stored = {
        'role': 'assistant',
        'content': '',
        'output': [
            {
                'type': 'function_call',
                'id': 'fc1',
                'call_id': 'c1',
                'name': 'lookup',
                'arguments': '{}',
                'status': 'queued',
                'approved': True,
            }
        ],
    }

    async def get_message(chat_id, message_id):
        return copy.deepcopy(stored)

    async def upsert(chat_id, message_id, data, **kwargs):
        # The drain re-reads the message after saving the tool results.
        stored.update(copy.deepcopy(data))

    async def image_data(url, user=None):
        return IMAGE_DATA if url == IMAGE['url'] else None

    async def no_emitter(metadata):
        return None, None

    async def execute(*args, **kwargs):
        return {'content': '42', 'tool_call_id': 'c1'}

    async def load_messages(chat_id, message_id):
        return [{'role': 'user', 'content': 'what is in this picture?', 'files': [IMAGE]}]

    monkeypatch.setattr(middleware, 'is_saved_chat_id', lambda chat_id: True)
    monkeypatch.setattr(middleware.Chats, 'get_message_by_id_and_message_id', get_message)
    monkeypatch.setattr(middleware.Chats, 'upsert_message_to_chat_by_id_and_message_id', upsert)
    monkeypatch.setattr(middleware, 'get_image_base64_from_url', image_data)
    monkeypatch.setattr(middleware, 'get_event_emitter_and_caller', no_emitter)
    monkeypatch.setattr(middleware, 'execute_tool_call_for_output', execute)
    monkeypatch.setattr(middleware, 'load_messages_from_db', load_messages)
    monkeypatch.setattr(middleware, 'ENABLE_PLUGINS', False)

    form_data = {'model': 'm', 'messages': form_messages}
    metadata = {'chat_id': 'c', 'message_id': 'r', 'assistant_message_id': 'r', 'user_message_id': 'q'}
    paused = asyncio.run(
        middleware.drain_approved_tool_calls(SimpleNamespace(), form_data, None, {'id': 'm'}, metadata)
    )
    return paused, form_data['messages']


def test_the_built_system_message_survives_the_resume(monkeypatch):
    system = {'role': 'system', 'content': 'You are terse.\n<context>retrieved passage</context>'}
    paused, messages = _drain(monkeypatch, [system, {'role': 'user', 'content': 'what is in this picture?'}])

    assert paused is False
    assert messages[0] == system
    assert [m['role'] for m in messages].count('system') == 1
    # The tool's result follows the call that asked for it.
    assert [m['role'] for m in messages] == ['system', 'user', 'assistant', 'tool']
    assert messages[2]['tool_calls'][0]['id'] == 'c1'
    assert messages[3]['tool_call_id'] == 'c1'
    assert '42' in str(messages[3]['content'])


def test_the_users_images_are_sent_again_after_the_resume(monkeypatch):
    _, messages = _drain(monkeypatch, [{'role': 'user', 'content': 'what is in this picture?'}])

    user = next(m for m in messages if m['role'] == 'user')
    assert isinstance(user['content'], list)
    # Resolved from the file id, as the normal path does; a bare id is no URL.
    assert {'type': 'image_url', 'image_url': {'url': IMAGE_DATA}} in user['content']


# The splice: process_chat_payload builds the resumed request without the
# message's output, so everything it puts on the turn's user message stays,
# and the drain appends the output once the approved calls have run.

MODEL = {'id': 'm'}
DOCUMENT = {'type': 'file', 'id': 'd-1', 'url': 'd-1', 'name': 'notes.pdf'}
TOOL_IMAGE = 'data:image/png;base64,VE9PTA=='
TURN = {
    'id': 'q',
    'role': 'user',
    'content': '<$stats|Statistics> what does the chart show?',
    'files': [IMAGE, DOCUMENT],
}
# Retrieved for the turn; with RAG_SYSTEM_CONTEXT off it goes into the user message.
SOURCES = [
    {
        'source': {'id': 'd-1', 'name': 'notes.pdf'},
        'document': ['sales rose in March'],
        'metadata': [{'source': 'd-1'}],
    }
]


def _paused_message():
    """A reply that ran one tool (with an image result), said something, then queued an approved second call."""
    return {
        'id': 'r',
        'role': 'assistant',
        'model': 'm',
        'content': '',
        'output': [
            {
                'type': 'function_call',
                'id': 'fc0',
                'call_id': 'c0',
                'name': 'plot',
                'arguments': '{}',
                'status': 'completed',
            },
            {
                'type': 'function_call_output',
                'id': 'fco0',
                'call_id': 'c0',
                'output': [
                    {'type': 'input_text', 'text': 'plotted'},
                    {'type': 'input_image', 'image_url': TOOL_IMAGE},
                ],
                'status': 'completed',
            },
            {
                'type': 'message',
                'id': 'msg0',
                'role': 'assistant',
                'status': 'completed',
                'content': [{'type': 'output_text', 'text': 'Let me look one more thing up.'}],
            },
            {
                'type': 'function_call',
                'id': 'fc1',
                'call_id': 'c1',
                'name': 'lookup',
                'arguments': '{}',
                'status': 'queued',
                'approved': True,
            },
        ],
    }


async def _nothing(form_data, metadata):
    return None


def _resume(monkeypatch, history, compact=_nothing, decorate=_nothing, after_build=None):
    """Build the resumed request with process_chat_payload's own helpers, in its order, then drain."""
    stored = _paused_message()
    loads = []

    async def get_message(chat_id, message_id):
        return copy.deepcopy(stored)

    async def upsert(chat_id, message_id, data, **kwargs):
        stored.update(copy.deepcopy(data))

    async def load_messages(chat_id, message_id):
        loads.append(message_id)
        return copy.deepcopy(history)

    async def image_data(url, user=None):
        return IMAGE_DATA if url == IMAGE['url'] else None

    async def no_emitter(metadata):
        return None, None

    async def execute(*args, **kwargs):
        return {'content': '42', 'tool_call_id': 'c1'}

    monkeypatch.setattr(middleware, 'is_saved_chat_id', lambda chat_id: True)
    monkeypatch.setattr(middleware.Chats, 'get_message_by_id_and_message_id', get_message)
    monkeypatch.setattr(middleware.Chats, 'upsert_message_to_chat_by_id_and_message_id', upsert)
    monkeypatch.setattr(middleware, 'load_messages_from_db', load_messages)
    monkeypatch.setattr(middleware, 'get_image_base64_from_url', image_data)
    monkeypatch.setattr(middleware, 'get_event_emitter_and_caller', no_emitter)
    monkeypatch.setattr(middleware, 'execute_tool_call_for_output', execute)
    monkeypatch.setattr(middleware, 'ENABLE_PLUGINS', False)

    form_data = {'model': 'm', 'messages': [{'role': 'system', 'content': 'Be brief.'}]}
    metadata = {'chat_id': 'c', 'message_id': 'r', 'assistant_message_id': 'r', 'user_message_id': 'q'}

    async def run():
        # Replay, compaction, conversion and images, then what
        # process_chat_payload puts on the turn's user message.
        await middleware._replay_history_from_db(form_data, metadata, 'c', 'q')
        await compact(form_data, metadata)
        form_data['messages'] = middleware._messages_for_model(form_data['messages'], MODEL)
        await middleware.convert_url_images_to_base64(form_data, user=None)
        await decorate(form_data, metadata)
        if after_build:
            after_build(stored)
        return await middleware.drain_approved_tool_calls(SimpleNamespace(), form_data, None, MODEL, metadata)

    paused = asyncio.run(run())
    return paused, form_data['messages'], loads


def _text(message):
    content = message.get('content')
    if isinstance(content, list):
        return '\n'.join(part.get('text', '') for part in content if part.get('type') == 'text')
    return content or ''


def _tool_call_ids(messages):
    return [call['id'] for m in messages if m['role'] == 'assistant' for call in m.get('tool_calls') or []]


def test_the_resume_keeps_what_the_payload_put_on_the_users_message(monkeypatch):
    history_map = {'q': {**TURN, 'parentId': None}}

    async def chat_for(chat_id, user_id):
        return SimpleNamespace(chat={'history': {'messages': history_map, 'currentId': 'q'}})

    async def template(name):
        return ''

    async def rag(template_text, context, query):
        return f'<context>{context}</context>\n{query}'

    monkeypatch.setattr(middleware.Chats, 'get_chat_by_id_and_user_id', chat_for)
    monkeypatch.setattr(middleware.Config, 'get', template)
    monkeypatch.setattr(middleware, 'rag_template', rag)
    monkeypatch.setattr(middleware, 'RAG_SYSTEM_CONTEXT', False)

    async def decorate(form_data, metadata):
        form_data['messages'] = await middleware.add_file_context(form_data['messages'], 'c', SimpleNamespace(id='u'))
        middleware.strip_skill_mentions(form_data['messages'])
        prompt = middleware.get_last_user_message(form_data['messages'])
        assert prompt
        form_data['messages'] = await middleware.apply_source_context_to_messages(
            cast(Any, SimpleNamespace()), form_data['messages'], SOURCES, prompt
        )

    paused, messages, _ = _resume(monkeypatch, [copy.deepcopy(TURN)], decorate=decorate)

    assert paused is False
    turn = [m for m in messages if m['role'] == 'user' and 'what does the chart show?' in _text(m)]
    assert len(turn) == 1
    turn = turn[0]
    text = _text(turn)
    # The retrieved context, in the user message as RAG_SYSTEM_CONTEXT off puts it.
    assert 'sales rose in March' in text
    # The file tags add_file_context put there.
    assert '<attached_files>' in text
    assert 'name="notes.pdf"' in text
    # The skill mention stripped to its label.
    assert '<$stats' not in text
    assert 'Statistics what does the chart show?' in text
    # The user's image, resolved to a data URL.
    assert {'type': 'image_url', 'image_url': {'url': IMAGE_DATA}} in turn['content']
    # The turn's user message comes before the reply's output, which follows it once.
    assert messages.index(turn) == 1
    assert _tool_call_ids(messages) == ['c0', 'c1']
    assert [m['tool_call_id'] for m in messages if m['role'] == 'tool'] == ['c0', 'c1']
    assert sum('Let me look one more thing up.' in _text(m) for m in messages) == 1
    assert sum(TOOL_IMAGE in str(m['content']) for m in messages) == 1
    assert '42' in str(next(m for m in messages if m.get('tool_call_id') == 'c1')['content'])


def test_the_resume_keeps_the_compacted_history(monkeypatch):
    history = [
        {'id': 'o1', 'role': 'user', 'content': 'an old question'},
        {'id': 'o2', 'role': 'assistant', 'content': 'an old answer'},
        {'id': 'q', 'role': 'user', 'content': 'what does the chart show?'},
    ]

    async def compact(request, user, messages, metadata, model_id, models, system_prompt=''):
        kept = [m for m in messages if m['role'] == 'system'] + [m for m in messages if m.get('id') == 'q']
        return kept, 'Earlier we talked.', True

    monkeypatch.setattr(middleware, 'compact_messages_for_request', compact)
    request = SimpleNamespace(state=SimpleNamespace(), app=SimpleNamespace(state=SimpleNamespace(MODELS={})))

    async def compact_history(form_data, metadata):
        await middleware._compact_history(request, None, form_data, metadata)

    paused, messages, loads = _resume(monkeypatch, history, compact=compact_history)

    assert paused is False
    assert 'an old question' not in str(messages)
    assert 'an old answer' not in str(messages)
    assert str(messages).count('[CONVERSATION SUMMARY]') == 1
    # Only process_chat_payload's replay read the stored history.
    assert loads == ['q']
    assert [m['role'] for m in messages][:2] == ['system', 'user']
    assert _tool_call_ids(messages) == ['c0', 'c1']


def test_output_left_out_of_the_request_is_sent_when_the_calls_were_resolved_meanwhile(monkeypatch):
    def resolve_elsewhere(stored):
        stored['output'].append(
            {
                'type': 'function_call_output',
                'id': 'fco1',
                'call_id': 'c1',
                'output': [{'type': 'input_text', 'text': 'done elsewhere'}],
                'status': 'completed',
            }
        )
        stored['output'][3]['status'] = 'completed'

    paused, messages, _ = _resume(
        monkeypatch, [{'id': 'q', 'role': 'user', 'content': 'go'}], after_build=resolve_elsewhere
    )

    assert paused is False
    assert [m['role'] for m in messages][:2] == ['system', 'user']
    assert _tool_call_ids(messages) == ['c0', 'c1']
    assert [m['tool_call_id'] for m in messages if m['role'] == 'tool'] == ['c0', 'c1']
