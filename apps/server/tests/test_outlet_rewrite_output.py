"""A message an outlet filter rewrote takes the new text into its output too (#502).

The next request is built from a message's `output`, so when a filter
changed only its `content`, the model (and the next filter or action) still
got the old text. Now the stored output, and the one the `chat:outlet` event
carries, hold the new text; the output's other items are kept.

Run from apps/server:

    python -m pytest tests/test_outlet_rewrite_output.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from local_llm.utils import middleware
from local_llm.utils.misc import get_output_text, with_output_text


def _text(text, id='msg1'):
    return {'type': 'message', 'id': id, 'role': 'assistant', 'content': [{'type': 'output_text', 'text': text}]}


CALL = {'type': 'function_call', 'id': 'fc1', 'call_id': 'c1', 'name': 'lookup', 'status': 'completed'}


def test_with_output_text_replaces_the_text_and_keeps_the_other_items():
    output = [CALL, _text('Old answer')]

    rewritten = with_output_text(output, 'New answer, $$x^2$$')

    assert rewritten[0] == CALL
    assert get_output_text(rewritten) == 'New answer, $$x^2$$'
    assert rewritten[1]['id'] == 'msg1'
    assert get_output_text(output) == 'Old answer'  # not changed in place


def test_with_output_text_puts_the_text_where_the_last_message_was_and_drops_reasoning():
    reasoning = {'type': 'reasoning', 'id': 'rs1', 'summary': []}
    output = [reasoning, _text('Let me check.', 'a'), CALL, _text('It is 4', 'b')]

    rewritten = with_output_text(output, 'It is 4.\n\n-- checked')

    assert [item['type'] for item in rewritten] == ['function_call', 'message']
    assert rewritten[1]['id'] == 'b'
    assert get_output_text(rewritten) == 'It is 4.\n\n-- checked'


def test_with_output_text_adds_a_message_to_an_output_without_one_and_none_for_no_text():
    added = with_output_text([CALL], 'Added by a filter')

    assert added[0] == CALL
    assert get_output_text(added) == 'Added by a filter'
    assert with_output_text([CALL, _text('Old')], '  ') == [CALL]


def test_an_outlet_rewrite_of_the_content_is_saved_into_the_output_and_sent(monkeypatch):
    saved, emitted = [], []
    reply = {'id': 'r', 'role': 'assistant', 'content': 'Old answer', 'output': [CALL, _text('Old answer')]}

    async def filters(*_a, **_k):
        return [object()]

    async def messages_map(_chat_id):
        return {'r': reply}

    async def run_filters(**kwargs):
        data = kwargs['form_data']
        for message in data['messages']:
            message['content'] = 'Filtered answer'
        return data, {}

    async def upsert(chat_id, message_id, update):
        saved.append(update)

    async def emit(event):
        emitted.append(event)

    async def no_pipeline(_request, data, _user, _models):
        return data

    monkeypatch.setattr(middleware, 'ENABLE_PLUGINS', True)
    monkeypatch.setattr(middleware, 'get_filter_functions', filters)
    monkeypatch.setattr(middleware, 'process_filter_functions', run_filters)
    monkeypatch.setattr(middleware, 'process_pipeline_outlet_filter', no_pipeline)
    monkeypatch.setattr(middleware.Chats, 'get_messages_map_by_chat_id', messages_map)
    monkeypatch.setattr(middleware.Chats, 'upsert_message_to_chat_by_id_and_message_id', upsert)
    monkeypatch.setattr(middleware, 'get_message_list', lambda m, _id: list(m.values()))

    asyncio.run(
        middleware.outlet_filter_handler(
            {
                'request': SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(MODELS={}))),
                'user': SimpleNamespace(),
                'model': {'id': 'm'},
                'metadata': {'chat_id': 'saved-chat', 'message_id': 'r'},
                'event_emitter': emit,
            }
        )
    )

    assert saved == [
        {
            'originalContent': 'Old answer',
            'content': 'Filtered answer',
            'output': [CALL, {**_text('Filtered answer'), 'status': 'completed'}],
        }
    ]
    sent = emitted[-1]['data']['messages'][0]
    assert get_output_text(sent['output']) == 'Filtered answer'
