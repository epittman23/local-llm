"""Two tag writes that both find a tag missing do not collide (#531).

`Tags.ensure_tags_exist` checked which tags existed, then inserted the rest,
so two tag generations finishing together for one user could both find a tag
missing; the second insert hit the (id, user_id) key, and its other tags were
not created. Runs against the test run's migrated SQLite database, which
enforces that key as Postgres does.

Run from apps/server:

    python -m pytest tests/test_tag_insert_race.py
"""

from __future__ import annotations

import asyncio
import importlib
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from local_llm.models.tags import Tags


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


def test_an_existing_tag_keeps_its_name_and_new_ones_are_added():
    user_id = f'race-{uuid.uuid4().hex[:10]}'
    asyncio.run(Tags.ensure_tags_exist(['Python'], user_id))

    asyncio.run(Tags.ensure_tags_exist(['python', 'Rust'], user_id))

    assert _tags(user_id) == {'python': 'Python', 'rust': 'Rust'}


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


def test_an_imported_chat_with_malformed_tags_keeps_its_meta():
    from local_llm.models.chats import ChatImportForm, Chats

    user_id = f'race-{uuid.uuid4().hex[:10]}'
    form = ChatImportForm(
        chat={'title': 'imported', 'history': {'currentId': None, 'messages': {}}, 'models': ['m']},
        meta={'tags': 'not a list'},
    )

    [chat] = asyncio.run(Chats.import_chats(user_id, [form]))

    assert chat.meta == {'tags': 'not a list'}
    assert _tags(user_id) == {}
