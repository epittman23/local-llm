"""Linking files to a chat skips the ones already linked, so new ones are still linked (#293).

`insert_chat_files` de-duplicated on chat_file row ids instead of file ids,
and only within one message. A file already linked to the chat then broke
the (chat_id, file_id) unique constraint, and the swallowed error rolled
back the new files in the same batch: linking F, then F and G, left only F.
chat_file decides what a shared chat's viewers may open, so G stayed out of
reach. Files already linked anywhere in the chat are now skipped.

Runs against the test run's migrated SQLite database.

Run from apps/server:

    python -m pytest tests/test_chat_files_link_once.py
"""

import asyncio
import importlib
import uuid

from local_llm.models.chats import ChatForm, Chats
from local_llm.models.files import FileForm, Files
from local_llm.models.users import Users

# Importing the config runs the migrations on the test run's database.
importlib.import_module('local_llm.config')


def test_a_file_already_linked_does_not_stop_the_new_ones():
    tag = uuid.uuid4().hex[:8]

    async def run():
        user = await Users.insert_new_user(f'u-{tag}', 'Una', f'u-{tag}@example.invalid', role='user')
        await Chats.insert_new_chat(f'chat-{tag}', user.id, ChatForm(chat={'title': 'Files'}))
        f, g, h = (f'{name}-{tag}' for name in 'fgh')
        for file_id in (f, g, h):
            await Files.insert_new_file(user.id, FileForm(id=file_id, filename=f'{file_id}.txt', path=f'/x/{file_id}'))

        first = await Chats.insert_chat_files(f'chat-{tag}', 'm1', [f], user.id)
        # The same message again with F and G; then another message with F, H and H.
        second = await Chats.insert_chat_files(f'chat-{tag}', 'm1', [f, g], user.id)
        third = await Chats.insert_chat_files(f'chat-{tag}', 'm2', [f, h, h], user.id)
        linked = await Chats.get_chat_files_by_chat_id_and_message_id(f'chat-{tag}', 'm1')
        linked += await Chats.get_chat_files_by_chat_id_and_message_id(f'chat-{tag}', 'm2')
        return (
            [c.file_id for c in first or []],
            [c.file_id for c in second or []],
            [c.file_id for c in third or []],
            sorted(c.file_id for c in linked),
            (f, g, h),
        )

    first, second, third, linked, (f, g, h) = asyncio.run(run())

    assert first == [f]
    assert second == [g]
    assert third == [h]
    assert linked == sorted([f, g, h])
