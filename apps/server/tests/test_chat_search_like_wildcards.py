"""`%`, `_` and `\\` in a chat search are text, not LIKE wildcards (#292).

The search phrase was bound raw into LIKE patterns, in the search, the
archived chats list and the chat list's title filter, so searching for `%`
or `_` matched every chat. They are now escaped, with an explicit ESCAPE
character, on SQLite (which has no default) and Postgres alike.

Runs against the test run's migrated SQLite database and, with
TEST_DATABASE_URL (CI and `make test-backend` provide one), a fresh Postgres.

Run from apps/server:

    python -m pytest tests/test_chat_search_like_wildcards.py
"""

import asyncio
import importlib
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

from test_schema_drift import fresh_database

from local_llm.models.chats import ChatForm, Chats
from local_llm.models.users import Users

# Importing the config runs the migrations on the test run's database.
importlib.import_module('local_llm.config')

__all__ = ['fresh_database']

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


SEARCH_ON_POSTGRES = r"""
import asyncio, json, sys
import local_llm.config  # runs the migrations on DATABASE_URL
from local_llm.models.chats import ChatForm, Chats
from local_llm.models.users import Users

TITLES = json.loads(sys.argv[1])
TEXTS = json.loads(sys.argv[2])


async def main():
    user = await Users.insert_new_user('u', 'Una', 'u@example.invalid', role='user')
    for key, title in TITLES.items():
        await Chats.insert_new_chat(key, user.id, ChatForm(chat={'title': title}))
    found = {}
    for text in TEXTS:
        chats = await Chats.get_chats_by_user_id_and_search_text(user.id, text)
        found[text] = sorted(chat.id for chat in chats)
    listed = await Chats.get_chat_list_by_user_id(user.id, filter={'query': '_'})
    found['list _'] = sorted(chat.id for chat in listed)
    print('FOUND ' + json.dumps(found))


asyncio.run(main())
"""


def test_search_treats_wildcards_as_text_on_postgres(fresh_database, tmp_path):
    env = {**os.environ, 'DATABASE_URL': fresh_database, 'DATA_DIR': str(tmp_path), 'HF_HUB_OFFLINE': '1'}
    texts = ['%', '_', '\\', '50%', 'plan']
    result = subprocess.run(
        [sys.executable, '-c', SEARCH_ON_POSTGRES, json.dumps(TITLES), json.dumps(texts)],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert result.returncode == 0, result.stderr[-4000:]
    line = next(line for line in result.stdout.splitlines() if line.startswith('FOUND '))

    assert json.loads(line.removeprefix('FOUND ')) == {
        '%': ['percent'],
        '_': ['underscore'],
        '\\': ['backslash'],
        '50%': ['percent'],
        'plan': ['plain'],
        'list _': ['underscore'],
    }
