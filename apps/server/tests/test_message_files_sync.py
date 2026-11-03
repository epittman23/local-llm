"""Files and status added to a message reach its chat_message row too (#290).

Tools and streamed images add files to a reply, and status updates add to
its status history, through two writers that changed only the chat JSON.
Reads prefer the chat_message row (`get_message_metadata`, the messages map
that forks and compaction use), so they saw nothing; and the socket's
`files` handler extended the full list the middleware sends with that same
list read back, duplicating every image. These run against the test run's
migrated database.

Run from apps/server:

    python -m pytest tests/test_message_files_sync.py
"""

from __future__ import annotations

import asyncio
import uuid

from local_llm.models.chat_messages import ChatMessages
from local_llm.models.chats import ChatForm, Chats
from local_llm.models.users import Users
from local_llm.socket.main import merge_message_files

IMG1 = {'type': 'image', 'url': '/api/v1/files/img1/content'}
IMG2 = {'type': 'image', 'url': '/api/v1/files/img2/content'}


def _run(coro):
    return asyncio.run(coro)


def _chat() -> str:
    uid = f'files-sync-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, 'user', f'{uid}@example.com', role='user'))
    chat_id = str(uuid.uuid4())
    history = {
        'currentId': 'm2',
        'messages': {
            'm1': {'id': 'm1', 'parentId': None, 'childrenIds': ['m2'], 'role': 'user', 'content': 'draw'},
            'm2': {
                'id': 'm2',
                'parentId': 'm1',
                'childrenIds': [],
                'role': 'assistant',
                'content': '',
                'done': False,
            },
        },
    }
    _run(Chats.insert_new_chat(chat_id, uid, ChatForm(chat={'title': 't', 'history': history, 'models': ['m']})))
    return chat_id


def test_added_files_reach_the_message_row(monkeypatch):
    chat_id = _chat()

    _run(Chats.add_message_files_by_id_and_message_id(chat_id, 'm2', [IMG1]))
    _run(Chats.add_message_files_by_id_and_message_id(chat_id, 'm2', [IMG2]))

    assert _run(Chats.get_message_metadata(chat_id, 'm2', 'files')) == [IMG1, IMG2]
    messages = _run(ChatMessages.get_messages_map_by_chat_id(chat_id))
    assert messages['m2']['files'] == [IMG1, IMG2]


def test_added_status_reaches_the_message_row():
    chat_id = _chat()

    _run(Chats.add_message_status_to_chat_by_id_and_message_id(chat_id, 'm2', {'description': 'searching'}))

    messages = _run(ChatMessages.get_messages_map_by_chat_id(chat_id))
    assert messages['m2']['statusHistory'] == [{'description': 'searching'}]


def test_metadata_falls_back_to_the_chat_json_when_the_row_has_none():
    chat_id = _chat()
    # A row written before the column was filled: the chat JSON holds the file.
    _run(Chats.upsert_message_to_chat_by_id_and_message_id(chat_id, 'm2', {'files': [IMG1]}))
    _run(ChatMessages.upsert_message('m2', chat_id, 'u', {'files': None}))

    assert _run(Chats.get_message_metadata(chat_id, 'm2', 'files')) == [IMG1]


def test_files_events_merge_without_duplicates():
    # The middleware sends the full list it saved; a tool sends only its own new files.
    assert merge_message_files([IMG1], [IMG1, IMG2]) == [IMG1, IMG2]
    assert merge_message_files([IMG1], [IMG2]) == [IMG1, IMG2]
    assert merge_message_files(None, [IMG1]) == [IMG1]
