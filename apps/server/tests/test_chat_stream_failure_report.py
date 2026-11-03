"""A reply whose upstream stream fails is reported once, on top of what streamed (#163).

The streamed reply saves the partial output, finished, and re-raises
(tests/test_streaming_response.py covers that half). This is the other
half: `main._process_chat` turns the re-raised error into one error on the
message and one `chat:message:error` plus one `chat:tasks:cancel` for the
open chat, and does not report it a second time.

Run from apps/server:

    python -m pytest tests/test_chat_stream_failure_report.py
"""

from __future__ import annotations

import asyncio

from local_llm import main


def test_a_stream_that_fails_mid_reply_is_reported_once(monkeypatch):
    saved: list[tuple] = []
    emitted: list[dict] = []
    metadata = {'chat_id': 'c1', 'message_id': 'r1', 'user_message_id': 'q1'}

    async def process_chat_payload(request, form_data, user, metadata, model):
        return form_data, metadata, []

    async def no(*args, **kwargs):
        return False

    async def nothing(*args, **kwargs):
        return None

    async def chat_completion_handler(request, form_data, user):
        return object()

    async def build_ctx(*args, **kwargs):
        return {}

    async def process_chat_response(response, ctx):
        # What the streamed reply does after saving the partial output.
        raise ConnectionResetError('upstream closed the connection')

    async def upsert(chat_id, message_id, data, **kwargs):
        saved.append((chat_id, message_id, data))

    async def emitter(event):
        emitted.append(event)

    async def get_event_emitter(metadata):
        return emitter

    monkeypatch.setattr(main, 'process_chat_payload', process_chat_payload)
    monkeypatch.setattr(main, 'drain_approved_tool_calls', no)
    monkeypatch.setattr(main, 'chat_completion_handler', chat_completion_handler)
    monkeypatch.setattr(main, 'build_chat_response_context', build_ctx)
    monkeypatch.setattr(main, 'process_chat_response', process_chat_response)
    monkeypatch.setattr(main, 'get_event_emitter', get_event_emitter)
    monkeypatch.setattr(main, 'is_saved_chat_id', lambda chat_id: True)
    monkeypatch.setattr(main.Chats, 'upsert_message_to_chat_by_id_and_message_id', upsert)
    monkeypatch.setattr(main, '_disconnect_mcp_clients', nothing)
    monkeypatch.setattr(main, '_end_chat_task', nothing)
    monkeypatch.setattr(main, '_run_pending_internal_messages', nothing)

    asyncio.run(main._process_chat(None, {}, None, metadata, {}))

    assert saved == [('c1', 'r1', {'parentId': 'q1', 'error': {'content': 'upstream closed the connection'}})]
    assert [e['type'] for e in emitted] == ['chat:message:error', 'chat:tasks:cancel']
