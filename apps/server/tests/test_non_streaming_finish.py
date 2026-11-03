"""A non-streaming reply with no text still finishes (#165).

With streaming off, the done event, the save and the outlet/background
handlers were all gated on the reply having text or output items. A
native tool-call reply (`content: null`) and a thinking model that spent
its budget on reasoning (`content: ''`) wrote nothing and emitted nothing,
so the placeholder stayed "generating" forever. Both now finish, keeping
any reasoning, with an error that says why there is no answer.

Run from apps/server:

    python -m pytest tests/test_non_streaming_finish.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from local_llm.utils import middleware

SAVED_CHAT = 'chat-1'


def _run(monkeypatch, message: dict):
    saved: list[dict] = []
    emitted: list[dict] = []

    async def upsert(chat_id, message_id, data, **kwargs):
        saved.append(data)

    async def title(chat_id):
        return 'T'

    async def nothing(*args, **kwargs):
        return None

    async def emitter(event):
        emitted.append(event)

    monkeypatch.setattr(middleware, 'is_saved_chat_id', lambda chat_id: True)
    monkeypatch.setattr(middleware.Chats, 'upsert_message_to_chat_by_id_and_message_id', upsert)
    monkeypatch.setattr(middleware.Chats, 'get_chat_title_by_id', title)
    monkeypatch.setattr(middleware, 'publish_chat_finished_event', nothing)
    monkeypatch.setattr(middleware, 'outlet_filter_handler', nothing)
    monkeypatch.setattr(middleware, 'background_tasks_handler', nothing)

    ctx = {
        'request': SimpleNamespace(state=SimpleNamespace()),
        'user': SimpleNamespace(id='u'),
        'metadata': {'chat_id': SAVED_CHAT, 'message_id': 'r1'},
        'events': [],
        'event_emitter': emitter,
    }
    response = {'choices': [{'message': {'role': 'assistant', **message}}]}
    asyncio.run(middleware.non_streaming_chat_response_handler(response, ctx))
    return saved, emitted


def _finished(saved, emitted):
    done_saves = [s for s in saved if s.get('done') is True]
    done_events = [e for e in emitted if e['type'] == 'chat:completion' and e['data'].get('done') is True]
    return done_saves, done_events


def test_a_tool_call_only_reply_finishes_with_an_error_saying_tools_need_streaming(monkeypatch):
    saved, emitted = _run(
        monkeypatch,
        {
            'content': None,
            'tool_calls': [{'id': 'c1', 'type': 'function', 'function': {'name': 'lookup', 'arguments': '{}'}}],
        },
    )

    done_saves, done_events = _finished(saved, emitted)
    assert len(done_saves) == 1 and len(done_events) == 1
    assert 'stream' in done_saves[0]['error']['content'].lower()
    assert [e for e in emitted if e['type'] == 'chat:message:error']


def test_an_empty_reply_after_reasoning_finishes_and_keeps_the_reasoning(monkeypatch):
    saved, emitted = _run(monkeypatch, {'content': '', 'reasoning_content': 'Let me think about this at length...'})

    done_saves, done_events = _finished(saved, emitted)
    assert len(done_saves) == 1 and len(done_events) == 1
    reasoning = [item for item in done_saves[0]['output'] if item['type'] == 'reasoning']
    assert reasoning and 'think about this' in reasoning[0]['content'][0]['text']
    assert done_saves[0]['error']['content']


def test_a_reply_with_text_is_unchanged(monkeypatch):
    saved, emitted = _run(monkeypatch, {'content': 'Hello.'})

    done_saves, _ = _finished(saved, emitted)
    assert len(done_saves) == 1
    assert 'error' not in done_saves[0]
