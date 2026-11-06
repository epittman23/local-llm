"""Two tag writes that both find a tag missing do not collide (#531).

`Tags.ensure_tags_exist` checked which tags existed, then inserted the rest,
so two tag generations finishing together for one user could both find a tag
missing; the second insert hit the (id, user_id) key, and its other tags were
not created. Runs against the test run's migrated SQLite database, which
enforces that key as Postgres does.

The same writes run on a fresh Postgres too, with TEST_DATABASE_URL (CI
provides one), where they really are concurrent.

Run from apps/server:

    python -m pytest tests/test_tag_insert_race.py
"""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from test_schema_drift import fresh_database

from local_llm.models.tags import Tags

__all__ = ['fresh_database']

SERVER_DIR = Path(__file__).resolve().parents[1]

WRITES = r"""
import asyncio, json
import local_llm.config  # runs the migrations
from sqlalchemy.ext.asyncio import AsyncSession
from local_llm.models.tags import Tags


async def main():
    found = {}
    # Writes finishing together, with their names in opposite orders.
    orders = [['python', 'data', 'ml'], ['ml', 'data', 'python']] * 5
    await asyncio.gather(*(Tags.ensure_tags_exist(names, 'u-concurrent') for names in orders))
    found['concurrent'] = sorted(t.id for t in await Tags.get_tags_by_user_id('u-concurrent'))

    # Another write lands just before this one's insert.
    real = AsyncSession.execute
    raced = False

    async def execute(self, statement, *args, **kwargs):
        nonlocal raced
        if not raced and str(statement).lstrip().upper().startswith('INSERT INTO TAG'):
            raced = True
            await Tags.ensure_tags_exist(['shared', 'Only B'], 'u-race')
        return await real(self, statement, *args, **kwargs)

    AsyncSession.execute = execute
    await Tags.ensure_tags_exist(['Shared', 'Only A'], 'u-race')
    AsyncSession.execute = real
    found['race'] = {t.id: t.name for t in await Tags.get_tags_by_user_id('u-race')}
    print('FOUND ' + json.dumps(found))


asyncio.run(main())
"""


def test_concurrent_and_racing_tag_writes_all_land_on_postgres(fresh_database, tmp_path):
    env = {**os.environ, 'DATABASE_URL': fresh_database, 'DATA_DIR': str(tmp_path), 'HF_HUB_OFFLINE': '1'}
    result = subprocess.run(
        [sys.executable, '-c', WRITES], cwd=SERVER_DIR, env=env, capture_output=True, text=True, timeout=600
    )
    assert result.returncode == 0, result.stderr[-4000:]
    line = next(line for line in result.stdout.splitlines() if line.startswith('FOUND '))
    assert json.loads(line.removeprefix('FOUND ')) == {
        'concurrent': ['data', 'ml', 'python'],
        'race': {'shared': 'shared', 'only_b': 'Only B', 'only_a': 'Only A'},
    }


@pytest.fixture(autouse=True, scope='module')
def _migrated():
    # Importing the config runs the migrations, as the app's startup does.
    importlib.import_module('local_llm.config')


def _tags(user_id: str) -> dict[str, str]:
    return {t.id: t.name for t in asyncio.run(Tags.get_tags_by_user_id(user_id))}


def test_a_write_that_lands_between_the_check_and_the_insert_does_not_fail_the_other(monkeypatch):
    """The other generation's write lands after this one has read what exists
    (just after a check of the tag table) and before its own insert."""
    user_id = f'race-{uuid.uuid4().hex[:10]}'
    real_execute = AsyncSession.execute
    raced = False

    async def other_write():
        nonlocal raced
        raced = True
        await Tags.ensure_tags_exist(['shared', 'Only B'], user_id)

    async def execute(self, statement, *args, **kwargs):
        sql = str(statement)
        if not raced and sql.lstrip().upper().startswith('INSERT INTO TAG'):
            await other_write()
        result = await real_execute(self, statement, *args, **kwargs)
        if not raced and 'FROM tag' in sql:
            await other_write()
        return result

    monkeypatch.setattr(AsyncSession, 'execute', execute)

    asyncio.run(Tags.ensure_tags_exist(['Shared', 'Only A'], user_id))

    monkeypatch.undo()
    tags = _tags(user_id)
    assert set(tags) == {'shared', 'only_a', 'only_b'}
    assert tags['shared'] == 'shared'


def test_an_imported_chat_stores_normalised_tag_ids_and_gets_its_tag_rows():
    """Chat import kept the file's tag names as ids (#531)."""
    from local_llm.models.chats import ChatImportForm, Chats

    user_id = f'race-{uuid.uuid4().hex[:10]}'
    form = ChatImportForm(
        chat={'title': 'imported', 'history': {'currentId': None, 'messages': {}}, 'models': ['m']},
        meta={'tags': ['Work Stuff', 'work stuff', 'None', 'Taxes'], 'other': 1},
    )

    [chat] = asyncio.run(Chats.import_chats(user_id, [form]))

    assert chat.meta == {'tags': ['work_stuff', 'taxes'], 'other': 1}
    assert _tags(user_id) == {'work_stuff': 'Work Stuff', 'taxes': 'Taxes'}


def test_an_imported_chat_whose_tags_are_not_a_list_gets_none():
    from local_llm.models.chats import ChatImportForm, Chats

    user_id = f'race-{uuid.uuid4().hex[:10]}'
    form = ChatImportForm(
        chat={'title': 'imported', 'history': {'currentId': None, 'messages': {}}, 'models': ['m']},
        meta={'tags': 'not a list'},
    )

    [chat] = asyncio.run(Chats.import_chats(user_id, [form]))

    assert chat.meta == {'tags': []}
    assert _tags(user_id) == {}


def test_an_imported_chat_drops_tags_that_are_not_names():
    from local_llm.models.chats import ChatImportForm, Chats

    user_id = f'race-{uuid.uuid4().hex[:10]}'
    form = ChatImportForm(
        chat={'title': 'imported', 'history': {'currentId': None, 'messages': {}}, 'models': ['m']},
        meta={'tags': ['Kept', 5, None, '  ']},
    )

    [chat] = asyncio.run(Chats.import_chats(user_id, [form]))

    assert chat.meta == {'tags': ['kept']}
