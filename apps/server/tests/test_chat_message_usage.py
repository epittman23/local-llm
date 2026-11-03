"""A reply's token usage is counted once, however often its chat is saved (#196).

The chat_message upsert merged incoming usage into the stored row instead
of replacing it. A continued reply started from no usage, so the chat JSON
held only the continuation's usage while the row held the sum; every later
chat save (a rename, a param change, a history save) wrote the JSON usage
into the row again and added it once more. Usage now replaces the row's,
and a continue starts from the stored usage, so the reply's total is
summed in one place.

The row half runs against the test run's migrated database.

Run from apps/server:

    python -m pytest tests/test_chat_message_usage.py
"""

from __future__ import annotations

import asyncio
import uuid

from local_llm.models.chat_messages import ChatMessages
from local_llm.models.chats import ChatForm, Chats
from local_llm.models.users import Users

REPLY = {'prompt_tokens': 100, 'completion_tokens': 50, 'total_tokens': 150}
CONTINUED = {'prompt_tokens': 130, 'completion_tokens': 70, 'total_tokens': 200}


def _run(coro):
    return asyncio.run(coro)


def _history(usage: dict) -> dict:
    return {
        'currentId': 'a1',
        'messages': {
            'q1': {'id': 'q1', 'parentId': None, 'childrenIds': ['a1'], 'role': 'user', 'content': 'q'},
            'a1': {
                'id': 'a1',
                'parentId': 'q1',
                'childrenIds': [],
                'role': 'assistant',
                'content': 'answer',
                'done': True,
                'usage': usage,
            },
        },
    }


def _row_usage(chat_id: str) -> dict:
    return _run(ChatMessages.get_messages_map_by_chat_id(chat_id))['a1']['usage']


def test_saving_a_chat_again_does_not_add_its_usage_again():
    uid = f'usage-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, 'user', f'{uid}@example.com', role='user'))
    chat_id = str(uuid.uuid4())
    _run(Chats.insert_new_chat(chat_id, uid, ChatForm(chat={'title': 't', 'history': _history(REPLY)})))

    # Two later saves of the unchanged chat (a rename, a param change).
    for title in ('renamed', 'renamed again'):
        _run(Chats.update_chat_by_id(chat_id, {'title': title, 'history': _history(REPLY)}))

    assert _row_usage(chat_id)['total_tokens'] == 150


def test_the_saved_total_after_a_continue_replaces_the_rows():
    uid = f'usage-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, 'user', f'{uid}@example.com', role='user'))
    chat_id = str(uuid.uuid4())
    _run(Chats.insert_new_chat(chat_id, uid, ChatForm(chat={'title': 't', 'history': _history(REPLY)})))

    # The continued reply's save carries the reply's whole usage so far.
    _run(Chats.upsert_message_to_chat_by_id_and_message_id(chat_id, 'a1', {'usage': CONTINUED, 'done': True}))
    _run(Chats.update_chat_by_id(chat_id, {'title': 'later', 'history': _history(CONTINUED)}))

    assert _row_usage(chat_id)['total_tokens'] == 200
