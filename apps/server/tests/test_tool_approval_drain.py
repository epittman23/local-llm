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
