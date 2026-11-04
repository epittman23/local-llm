"""Imported chats are not unread (#295).

The import never set `last_read_at`, and a chat is unread while
`updated_at > coalesce(last_read_at, 0)`. So every imported chat showed as
unread, sorted first in the unread order and counted in its folder's unread
count. A new chat starts read (`insert_new_chat`), as the migration's
backfill made old ones; an imported chat now starts read at its own
`updated_at` too.

Runs against the test run's migrated SQLite database.

Run from apps/server:

    python -m pytest tests/test_chat_import_read.py
"""

import asyncio
import importlib
import uuid

from local_llm.models.chats import ChatImportForm, Chats
from local_llm.models.users import Users

# Importing the config runs the migrations on the test run's database.
importlib.import_module('local_llm.config')


def test_imported_chats_start_read():
    tag = uuid.uuid4().hex[:8]
    message = {'id': 'm1', 'role': 'user', 'content': 'Hi'}

    async def run():
        user = await Users.insert_new_user(f'u-{tag}', 'Una', f'u-{tag}@example.invalid', role='user')
        forms = [
            ChatImportForm(
                chat={'title': 'Old', 'history': {'messages': {'m1': message}, 'currentId': 'm1'}},
                created_at=1_700_000_000,
                updated_at=1_700_000_500,
            ),
            ChatImportForm(chat={'title': 'Undated'}),
        ]
        imported = await Chats.import_chats(user.id, forms)
        return [await Chats.get_chat_by_id(chat.id) for chat in imported]

    stored = asyncio.run(run())

    assert [chat.updated_at for chat in stored][0] == 1_700_000_500
    for chat in stored:
        assert chat.last_read_at is not None
        assert chat.last_read_at >= chat.updated_at
