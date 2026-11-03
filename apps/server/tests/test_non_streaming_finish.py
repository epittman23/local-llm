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


def _run(monkeypatch, message: dict, *, finish_reason='stop', usage=None):
    saved: list[dict] = []
    emitted: list[dict] = []
    failed: list[str] = []

    async def chat_failed(request, user, metadata, text):
        failed.append(text)

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
    monkeypatch.setattr(middleware, '_publish_chat_failed', chat_failed)

    ctx = {
        'request': SimpleNamespace(state=SimpleNamespace()),
        'user': SimpleNamespace(id='u'),
        'metadata': {'chat_id': SAVED_CHAT, 'message_id': 'r1'},
        'events': [],
        'event_emitter': emitter,
    }
    response = {
        'choices': [{'message': {'role': 'assistant', **message}, 'finish_reason': finish_reason}],
        **({'usage': usage} if usage else {}),
    }
    asyncio.run(middleware.non_streaming_chat_response_handler(response, ctx))
    _run.failed = failed
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
    assert 'Stream Chat Response' in done_saves[0]['error']['content']
    assert [e for e in emitted if e['type'] == 'chat:message:error']
    # Webhook subscribers learn the reply failed.
    assert _run.failed == [done_saves[0]['error']['content']]


def test_an_empty_reply_after_reasoning_finishes_and_keeps_the_reasoning(monkeypatch):
    saved, emitted = _run(
        monkeypatch,
        {'content': '', 'reasoning_content': 'Let me think about this at length...'},
        finish_reason='length',
        usage={'prompt_tokens': 10, 'completion_tokens': 4096},
    )

    done_saves, done_events = _finished(saved, emitted)
    assert len(done_saves) == 1 and len(done_events) == 1
    reasoning = [item for item in done_saves[0]['output'] if item['type'] == 'reasoning']
    assert reasoning and 'think about this' in reasoning[0]['content'][0]['text']
    assert 'token limit' in done_saves[0]['error']['content']
    # The tokens it spent are kept, as on the ordinary path.
    assert done_saves[0]['usage'] and done_events[0]['data']['usage'] == done_saves[0]['usage']


def test_an_empty_reply_that_did_not_run_out_says_only_that_there_is_no_text(monkeypatch):
    saved, emitted = _run(monkeypatch, {'content': ''}, finish_reason='content_filter')

    done_saves, _ = _finished(saved, emitted)
    assert done_saves[0]['error']['content'] == 'The model returned no text.'


def test_a_reply_with_text_is_unchanged(monkeypatch):
    saved, emitted = _run(monkeypatch, {'content': 'Hello.'})

    done_saves, _ = _finished(saved, emitted)
    assert len(done_saves) == 1
    assert 'error' not in done_saves[0]


def test_provider_reasoning_details_are_kept_on_a_reply_without_text(monkeypatch):
    details = [{'type': 'reasoning.encrypted', 'data': 'opaque'}]
    saved, emitted = _run(monkeypatch, {'content': '', 'reasoning_details': details}, finish_reason='length')

    done_saves, _ = _finished(saved, emitted)
    (reasoning,) = [item for item in done_saves[0]['output'] if item['type'] == 'reasoning']
    assert reasoning['reasoning_details'] == details
