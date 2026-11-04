"""`%`, `_` and `\\` in a chat search are text, not LIKE wildcards (#292).

The search phrase was bound raw into LIKE patterns, in the search, the
archived chats list and the chat list's title filter, so searching for `%`
or `_` matched every chat. They are now escaped, with an explicit ESCAPE
character, on SQLite (which has no default) and Postgres alike.

Runs against the test run's migrated SQLite database.

Run from apps/server:

    python -m pytest tests/test_chat_search_like_wildcards.py
"""

import asyncio
import importlib
import uuid

from local_llm.models.chats import ChatForm, Chats
from local_llm.models.users import Users

# Importing the config runs the migrations on the test run's database.
importlib.import_module('local_llm.config')

TITLES = {
    'plain': 'Weekly plan',
    'percent': 'Budget 50% off',
    'underscore': 'snake_case notes',
    'backslash': r'C:\temp files',
}


def _chats():
    tag = uuid.uuid4().hex[:8]

    async def build():
        user = await Users.insert_new_user(f'u-{tag}', 'Una', f'u-{tag}@example.invalid', role='user')
        for key, title in TITLES.items():
            message = {'id': 'm1', 'role': 'user', 'content': title}
            await Chats.insert_new_chat(
                f'{key}-{tag}',
                user.id,
                ChatForm(chat={'title': title, 'history': {'messages': {'m1': message}}, 'messages': [message]}),
            )
        for key in TITLES:
            await Chats.toggle_chat_archive_by_id(f'{key}-{tag}')
        return user.id, tag

    return asyncio.run(build())


def test_like_escape_escapes_the_wildcards_and_the_escape():
    from local_llm.models.chats import like_escape

    assert like_escape(r'50%_off\x') == r'50\%\_off\\x'


def test_search_treats_wildcards_as_text():
    user_id, tag = _chats()

    async def search(text):
        found = await Chats.get_chats_by_user_id_and_search_text(user_id, text, include_archived=True)
        return sorted(chat.id.removesuffix(f'-{tag}') for chat in found)

    async def run():
        return {text: await search(text) for text in ('%', '_', '\\', '50%', 'plan')}

    assert asyncio.run(run()) == {
        '%': ['percent'],
        '_': ['underscore'],
        '\\': ['backslash'],
        '50%': ['percent'],
        'plan': ['plain'],
    }


def test_the_archived_list_and_the_chat_list_treat_wildcards_as_text():
    user_id, tag = _chats()

    async def run():
        archived = await Chats.get_archived_chat_list_by_user_id(user_id, filter={'query': '%'})
        listed = await Chats.get_chat_list_by_user_id(user_id, include_archived=True, filter={'query': '_'})
        return (
            sorted(chat.id.removesuffix(f'-{tag}') for chat in archived),
            sorted(chat.id.removesuffix(f'-{tag}') for chat in listed),
        )

    assert asyncio.run(run()) == (['percent'], ['underscore'])
