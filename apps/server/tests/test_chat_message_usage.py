"""A reply's token usage is counted once, however often its chat is saved (#196).

The chat_message upsert merged incoming usage into the stored row instead
of replacing it. A continued reply started from no usage, so the chat JSON
held only the continuation's usage while the row held the sum; every later
chat save (a rename, a param change, a history save) wrote the JSON usage
into the row again through the router's reconcile, and added it once more.
Usage now replaces the row's, and a continue starts from the stored usage
(tests/test_streaming_response.py), so the reply's total is summed in one
place.

The row half saves through the real router against the test run's migrated
database.

Run from apps/server:

    python -m pytest tests/test_chat_message_usage.py
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.models.chat_messages import ChatMessages
from local_llm.models.chats import ChatForm, Chats
from local_llm.models.users import Users
from local_llm.routers import chats as chats_router
from local_llm.utils import middleware
from local_llm.utils.auth import create_token

REPLY = {'prompt_tokens': 100, 'completion_tokens': 50, 'total_tokens': 150}
# What a continuation's own save carried before the fix: only its own call.
CONTINUATION = {'prompt_tokens': 30, 'completion_tokens': 20, 'total_tokens': 50}


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


def _row_total(chat_id: str) -> int:
    return _run(ChatMessages.get_messages_map_by_chat_id(chat_id))['a1']['usage']['total_tokens']


def test_saving_a_chat_after_a_continue_does_not_add_the_usage_again(monkeypatch):
    uid = f'usage-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, 'user', f'{uid}@example.com', role='user'))
    token = create_token({'id': uid}, dt.timedelta(minutes=30))
    chat_id = str(uuid.uuid4())
    _run(Chats.insert_new_chat(chat_id, uid, ChatForm(chat={'title': 't', 'history': _history(REPLY)})))

    # A continuation's save: the chat JSON and the row now hold its usage.
    _run(Chats.upsert_message_to_chat_by_id_and_message_id(chat_id, 'a1', {'usage': CONTINUATION, 'done': True}))

    async def nothing(*args, **kwargs):
        return None

    monkeypatch.setattr(chats_router, 'publish_event', nothing)
    app = FastAPI()
    app.state.redis = None
    app.include_router(chats_router.router, prefix='/chats')
    client = TestClient(app)
    totals = []
    for title in ('renamed', 'renamed again'):  # two later saves of the chat
        chat = _run(Chats.get_chat_by_id(chat_id))
        resp = client.post(
            f'/chats/{chat_id}',
            json={'chat': {**chat.chat, 'title': title}},
            headers={'Authorization': f'Bearer {token}'},
        )
        assert resp.status_code == 200
        totals.append(_row_total(chat_id))

    # The row matches the JSON every time (before the fix: 250, then 300).
    assert totals == [50, 50]


def test_a_non_streaming_continue_adds_its_usage_to_the_stored_usage(monkeypatch):
    saved = []

    async def upsert(chat_id, message_id, data, **kwargs):
        saved.append(data)

    async def stored(chat_id, message_id):
        return {'role': 'assistant', 'content': 'head', 'usage': REPLY}

    async def nothing(*args, **kwargs):
        return None

    async def title(chat_id):
        return 'T'

    monkeypatch.setattr(middleware, 'is_saved_chat_id', lambda chat_id: True)
    monkeypatch.setattr(middleware.Chats, 'upsert_message_to_chat_by_id_and_message_id', upsert)
    monkeypatch.setattr(middleware.Chats, 'get_message_by_id_and_message_id', stored)
    monkeypatch.setattr(middleware.Chats, 'get_chat_title_by_id', title)
    for name in ('publish_chat_finished_event', 'outlet_filter_handler', 'background_tasks_handler'):
        monkeypatch.setattr(middleware, name, nothing)
    ctx = {
        'request': SimpleNamespace(state=SimpleNamespace()),
        'user': SimpleNamespace(id='u'),
        'metadata': {'chat_id': 'c', 'message_id': 'a1', 'assistant_message_id': 'a1'},
        'events': [],
        'event_emitter': nothing,
    }
    response = {'choices': [{'message': {'role': 'assistant', 'content': ' tail'}}], 'usage': CONTINUATION}

    _run(middleware.non_streaming_chat_response_handler(response, ctx))

    final = [s for s in saved if s.get('done') is True][-1]
    assert final['usage']['total_tokens'] == 200
