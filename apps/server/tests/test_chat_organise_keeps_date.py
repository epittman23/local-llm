"""Organising a chat does not change its date (#949).

Pinning, archiving and moving a chat into or out of a folder set its
`updated_at` to now, so the sidebar, which groups chats by that date, moved
an old chat to Today. Those three changes organise a chat; they do not
change what it says, so its date stays.

Runs against the test run's migrated SQLite database.

Run from apps/server:

    python -m pytest tests/test_chat_organise_keeps_date.py
"""

import asyncio
import uuid

from local_llm.config import run_migrations
from local_llm.internal.db import get_async_db_context
from local_llm.models.chats import Chat, ChatForm, Chats
from local_llm.models.users import Users

OLD = 1_000_000


def setup_module():
    # The database is migrated when local_llm.config is first imported; say so here.
    run_migrations()


def _run(coro):
    return asyncio.run(coro)


async def _old_chat() -> str:
    user_id = f'user-{uuid.uuid4().hex[:10]}'
    await Users.insert_new_user(user_id, 'u', f'{user_id}@example.com', role='user')
    chat_id = str(uuid.uuid4())
    form = ChatForm(chat={'title': 't', 'history': {'currentId': None, 'messages': {}}, 'models': ['m']})
    await Chats.insert_new_chat(chat_id, user_id, form)
    async with get_async_db_context() as session:
        chat = await session.get(Chat, chat_id)
        chat.updated_at = OLD
        chat.last_read_at = OLD
        await session.commit()
    return chat_id


async def _dates(chat_id: str) -> tuple[int, int]:
    chat = await Chats.get_chat_by_id(chat_id)
    return chat.updated_at, chat.last_read_at


def test_pinning_and_unpinning_keeps_the_date_and_read_state():
    async def go():
        chat_id = await _old_chat()
        assert (await Chats.toggle_chat_pinned_by_id(chat_id)).pinned is True
        assert await _dates(chat_id) == (OLD, OLD)
        assert (await Chats.toggle_chat_pinned_by_id(chat_id)).pinned is False
        assert await _dates(chat_id) == (OLD, OLD)

    _run(go())


def test_archiving_and_unarchiving_keeps_the_date():
    async def go():
        chat_id = await _old_chat()
        assert (await Chats.toggle_chat_archive_by_id(chat_id)).archived is True
        assert (await _dates(chat_id))[0] == OLD
        assert (await Chats.toggle_chat_archive_by_id(chat_id)).archived is False
        assert (await _dates(chat_id))[0] == OLD

    _run(go())


def test_moving_into_and_out_of_a_folder_keeps_the_date():
    async def go():
        chat_id = await _old_chat()
        user_id = (await Chats.get_chat_by_id(chat_id)).user_id
        moved = await Chats.update_chat_folder_id_by_id_and_user_id(chat_id, user_id, 'folder-1')
        assert moved.folder_id == 'folder-1'
        assert (await _dates(chat_id))[0] == OLD
        back = await Chats.update_chat_folder_id_by_id_and_user_id(chat_id, user_id, None)
        assert back.folder_id is None
        assert (await _dates(chat_id))[0] == OLD

    _run(go())
