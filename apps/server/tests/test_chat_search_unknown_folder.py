"""A chat search's `folder:` filter that matches no folder finds no chats (#291).

The folder constraint was applied only when a folder matched, so a misspelled
`folder:nosuch` dropped the constraint and the search returned every chat.
It now returns none; a folder that exists still narrows the search.

Runs against the test run's migrated SQLite database.

Run from apps/server:

    python -m pytest tests/test_chat_search_unknown_folder.py
"""

import asyncio
import importlib
import uuid

from local_llm.models.chats import ChatForm, Chats
from local_llm.models.folders import FolderForm, Folders
from local_llm.models.users import Users

# Importing the config runs the migrations on the test run's database.
importlib.import_module('local_llm.config')


def test_an_unknown_folder_finds_no_chats():
    tag = uuid.uuid4().hex[:8]

    async def run():
        user = await Users.insert_new_user(f'u-{tag}', 'Una', f'u-{tag}@example.invalid', role='user')
        folder = await Folders.insert_new_folder(user.id, FolderForm(name='Work'))
        await Chats.insert_new_chat(f'in-{tag}', user.id, ChatForm(chat={'title': 'Plan'}, folder_id=folder.id))
        await Chats.insert_new_chat(f'out-{tag}', user.id, ChatForm(chat={'title': 'Plan'}))

        async def ids(text):
            return sorted(chat.id for chat in await Chats.get_chats_by_user_id_and_search_text(user.id, text))

        return {text: await ids(text) for text in ('folder:nosuch', 'folder:nosuch plan', 'folder:work', 'plan')}

    found = asyncio.run(run())

    assert found == {
        'folder:nosuch': [],
        'folder:nosuch plan': [],
        'folder:work': [f'in-{tag}'],
        'plan': sorted([f'in-{tag}', f'out-{tag}']),
    }
