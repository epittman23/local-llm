"""Two root directories of one knowledge base cannot share a name, even at once (#634).

#312 made creating, renaming and moving a directory check its siblings'
names first, but two requests at the same moment could both pass the check
and both insert a root directory of one name: the unique constraint on
(knowledge_id, parent_id, name) treats NULL parents as distinct, on Postgres
and SQLite alike. A migration now merges the root directories that already
share a name, recursively, keeping every file, and adds a unique index on
(knowledge_id, name) over root directories, so the request that loses a race
fails at the database and is answered with a 400.

The migration tests run the revision on a fresh SQLite file with the
pre-revision schema and foreign keys enforced, so a directory deleted before
its contents moved would take them with it; the others use the test run's
migrated SQLite database.

Run from apps/server:

    python -m pytest tests/test_knowledge_root_directory_unique.py
"""

import asyncio
import importlib
import importlib.util
import uuid
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from local_llm.internal.db import get_async_db
from local_llm.models.files import File
from local_llm.models.knowledge import (
    Knowledge,
    KnowledgeDirectory,
    KnowledgeFile,
    KnowledgeForm,
    Knowledges,
)
from local_llm.models.users import Users
from local_llm.routers import knowledge as knowledge_router

# Importing the config runs the migrations on the test run's database.
importlib.import_module('local_llm.config')

INDEX = 'uq_knowledge_directory_root_name'
MIGRATION = (
    Path(__file__).resolve().parents[1]
    / 'local_llm'
    / 'migrations'
    / 'versions'
    / 'e3a7c5f92b18_merge_duplicate_knowledge_root_directories.py'
)


def _run(coro):
    return asyncio.run(coro)


# ── The migration, on a database with the pre-revision schema ──────────


def _migration():
    spec = importlib.util.spec_from_file_location('merge_duplicate_knowledge_root_directories', MIGRATION)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


@pytest.fixture
def old_schema(tmp_path):
    """A SQLite file with the knowledge tables as they were before the revision."""
    engine = sa.create_engine(f'sqlite:///{tmp_path / "old.db"}')

    @sa.event.listens_for(engine, 'connect')
    def enforce_foreign_keys(dbapi_connection, _record):
        dbapi_connection.execute('PRAGMA foreign_keys=ON')

    tables = [Knowledge.__table__, File.__table__, KnowledgeDirectory.__table__, KnowledgeFile.__table__]
    Knowledge.metadata.create_all(engine, tables=tables)
    with engine.begin() as conn:
        conn.execute(sa.text(f'DROP INDEX IF EXISTS {INDEX}'))
    yield engine
    engine.dispose()


def _upgrade(engine):
    with engine.begin() as conn, Operations.context(MigrationContext.configure(conn)):
        _migration().upgrade()


def _downgrade(engine):
    with engine.begin() as conn, Operations.context(MigrationContext.configure(conn)):
        _migration().downgrade()


def _indexes(engine):
    return {index['name'] for index in sa.inspect(engine).get_indexes('knowledge_directory')}


def _seed(conn, kb, directories, files):
    """directories: (id, parent_id, name, created_at); files: (file_id, filename, directory_id)."""
    if not conn.execute(sa.text('SELECT 1 FROM knowledge WHERE id = :id'), {'id': kb}).first():
        conn.execute(
            sa.insert(Knowledge.__table__).values(
                id=kb, user_id='u', name=kb, description='', created_at=1, updated_at=1
            )
        )
    for directory_id, parent_id, name, created_at in directories:
        conn.execute(
            sa.insert(KnowledgeDirectory.__table__).values(
                id=directory_id,
                knowledge_id=kb,
                parent_id=parent_id,
                name=name,
                user_id='u',
                created_at=created_at,
                updated_at=created_at,
            )
        )
    for file_id, filename, directory_id in files:
        conn.execute(
            sa.insert(File.__table__).values(id=file_id, user_id='u', filename=filename, created_at=1, updated_at=1)
        )
        conn.execute(
            sa.insert(KnowledgeFile.__table__).values(
                id=f'kf-{file_id}',
                knowledge_id=kb,
                file_id=file_id,
                directory_id=directory_id,
                user_id='u',
                created_at=1,
                updated_at=1,
            )
        )


def _snapshot(engine):
    with engine.connect() as conn:
        directories = conn.execute(
            sa.text('SELECT id, knowledge_id, parent_id, name, created_at, updated_at FROM knowledge_directory')
        ).all()
        files = conn.execute(sa.text('SELECT id, knowledge_id, file_id, directory_id FROM knowledge_file')).all()
    return sorted(directories), sorted(files)


def _paths(engine, kb):
    """Every directory of a base by its path, and every file by (path, filename)."""
    with engine.connect() as conn:
        directories = conn.execute(
            sa.text('SELECT id, parent_id, name FROM knowledge_directory WHERE knowledge_id = :kb'), {'kb': kb}
        ).all()
        files = conn.execute(
            sa.text(
                'SELECT kf.file_id, f.filename, kf.directory_id FROM knowledge_file kf '
                'JOIN file f ON f.id = kf.file_id WHERE kf.knowledge_id = :kb'
            ),
            {'kb': kb},
        ).all()
    by_id = {d.id: d for d in directories}

    def path(directory_id):
        segments = []
        while directory_id:
            segments.insert(0, by_id[directory_id].name)
            directory_id = by_id[directory_id].parent_id
        return '/'.join(segments)

    directory_paths = sorted((path(d.id), d.id) for d in directories)
    file_paths = sorted((path(f.directory_id), f.filename, f.file_id) for f in files)
    return directory_paths, file_paths


def test_the_migration_merges_root_directories_of_one_name_and_their_colliding_children(old_schema):
    with old_schema.begin() as conn:
        _seed(
            conn,
            'kb',
            [
                # Three roots named "docs": the oldest survives.
                ('docs-b', None, 'docs', 200),
                ('docs-a', None, 'docs', 100),
                ('docs-c', None, 'docs', 200),  # as old as docs-b: the id decides
                # "sub" in docs-a and in docs-b collide once merged; docs-b's is older.
                ('a-sub', 'docs-a', 'sub', 150),
                ('b-sub', 'docs-b', 'sub', 120),
                # And so do their own "deep" children; a-sub's is older.
                ('a-deep', 'a-sub', 'deep', 130),
                ('b-deep', 'b-sub', 'deep', 140),
                # Children only one copy has move as they are.
                ('b-only', 'docs-b', 'only-b', 300),
                ('c-sub', 'docs-c', 'sub', 400),
                ('c-sub-more', 'c-sub', 'more', 400),
                ('notes', None, 'notes', 100),
            ],
            [
                ('f-a', 'readme.md', 'docs-a'),
                ('f-b', 'readme.md', 'docs-b'),  # same path and name as f-a once merged
                ('f-c', 'c.txt', 'docs-c'),
                ('f-a-sub', 'a.txt', 'a-sub'),
                ('f-b-sub', 'b.txt', 'b-sub'),
                ('f-a-deep', 'x.txt', 'a-deep'),
                ('f-b-deep', 'x.txt', 'b-deep'),
                ('f-b-only', 'o.txt', 'b-only'),
                ('f-c-more', 'm.txt', 'c-sub-more'),
                ('f-notes', 'n.txt', 'notes'),
                ('f-root', 'r.txt', None),
            ],
        )
        # Another base's "docs" is a different directory, and not a duplicate.
        _seed(conn, 'other', [('other-docs', None, 'docs', 50)], [('f-other', 'readme.md', 'other-docs')])
    other_before = _paths(old_schema, 'other')

    _upgrade(old_schema)

    directories, files = _paths(old_schema, 'kb')
    assert directories == [
        ('docs', 'docs-a'),
        ('docs/only-b', 'b-only'),
        ('docs/sub', 'b-sub'),
        ('docs/sub/deep', 'a-deep'),
        ('docs/sub/more', 'c-sub-more'),
        ('notes', 'notes'),
    ]
    # Every file is still in the base, at the path it had; two of one path and
    # name are both kept.
    assert files == [
        ('', 'r.txt', 'f-root'),
        ('docs', 'c.txt', 'f-c'),
        ('docs', 'readme.md', 'f-a'),
        ('docs', 'readme.md', 'f-b'),
        ('docs/only-b', 'o.txt', 'f-b-only'),
        ('docs/sub', 'a.txt', 'f-a-sub'),
        ('docs/sub', 'b.txt', 'f-b-sub'),
        ('docs/sub/deep', 'x.txt', 'f-a-deep'),
        ('docs/sub/deep', 'x.txt', 'f-b-deep'),
        ('docs/sub/more', 'm.txt', 'f-c-more'),
        ('notes', 'n.txt', 'f-notes'),
    ]
    assert _paths(old_schema, 'other') == other_before
    assert INDEX in _indexes(old_schema)

    # Run again, it changes nothing.
    merged = _snapshot(old_schema)
    _upgrade(old_schema)
    assert _snapshot(old_schema) == merged


def test_the_migration_changes_no_row_of_a_database_without_duplicates(old_schema):
    with old_schema.begin() as conn:
        _seed(
            conn,
            'kb',
            [('docs', None, 'docs', 1), ('sub', 'docs', 'sub', 2), ('docs2', 'sub', 'docs', 3)],
            [('f1', 'a.txt', 'docs'), ('f2', 'a.txt', 'sub'), ('f3', 'a.txt', None)],
        )
        _seed(conn, 'other', [('other-docs', None, 'docs', 1)], [])
    before = _snapshot(old_schema)

    _upgrade(old_schema)

    assert _snapshot(old_schema) == before
    assert INDEX in _indexes(old_schema)


def test_the_downgrade_drops_the_index_and_keeps_the_merged_directories(old_schema):
    with old_schema.begin() as conn:
        _seed(conn, 'kb', [('a', None, 'docs', 1), ('b', None, 'docs', 2)], [('f', 'a.txt', 'b')])
    _upgrade(old_schema)
    merged = _snapshot(old_schema)

    _downgrade(old_schema)

    assert INDEX not in _indexes(old_schema)
    assert _snapshot(old_schema) == merged
    with old_schema.begin() as conn:
        _seed(conn, 'kb', [('c', None, 'docs', 3)], [])  # accepted again


# ── The index, and the request that loses a race ──────────────────────


def _base():
    tag = uuid.uuid4().hex[:8]
    user = _run(Users.insert_new_user(f'u-{tag}', 'Una', f'u-{tag}@example.invalid', role='user'))
    base = _run(Knowledges.insert_new_knowledge(user.id, KnowledgeForm(name=f'kb-{tag}', description='')))
    return base.id, user.id


async def _insert_directory(kb, user_id, name, parent_id=None):
    async with get_async_db() as db:
        db.add(
            KnowledgeDirectory(
                id=str(uuid.uuid4()),
                knowledge_id=kb,
                parent_id=parent_id,
                name=name,
                user_id=user_id,
                created_at=1,
                updated_at=1,
            )
        )
        await db.commit()


def test_the_database_refuses_a_second_root_directory_of_one_name():
    kb, user_id = _base()
    _run(_insert_directory(kb, user_id, 'docs'))

    with pytest.raises(IntegrityError):
        _run(_insert_directory(kb, user_id, 'docs'))

    # Below the root, and in another base, the name is free.
    parent = _run(Knowledges.get_directories(kb))[0]
    _run(_insert_directory(kb, user_id, 'docs', parent_id=parent.id))
    other_kb, _ = _base()
    _run(_insert_directory(other_kb, user_id, 'docs'))


@pytest.fixture
def lost_race(monkeypatch):
    """Every sibling check passes, as it does for both of two requests at once."""

    async def publish(*_a, **_k):
        return None

    async def no_sibling(*_a, **_k):
        return False

    monkeypatch.setattr(knowledge_router, 'publish_event', publish)
    monkeypatch.setattr(Knowledges, '_sibling_has_name', no_sibling)


def test_a_request_that_loses_a_race_for_a_root_name_gets_a_400(lost_race):
    kb, user_id = _base()
    user = _run(Users.get_user_by_id(user_id))
    docs = knowledge_router.KnowledgeDirectoryCreateForm(name='docs')

    _run(knowledge_router.create_knowledge_directory(None, kb, docs, user=user, db=None))
    with pytest.raises(HTTPException) as refused_create:
        _run(knowledge_router.create_knowledge_directory(None, kb, docs, user=user, db=None))

    notes = _run(
        knowledge_router.create_knowledge_directory(
            None, kb, knowledge_router.KnowledgeDirectoryCreateForm(name='notes'), user=user, db=None
        )
    )
    with pytest.raises(HTTPException) as refused_rename:
        _run(
            knowledge_router.update_knowledge_directory(
                None, kb, notes.id, knowledge_router.KnowledgeDirectoryUpdateForm(name='docs'), user=user, db=None
            )
        )

    nested = _run(
        knowledge_router.create_knowledge_directory(
            None, kb, knowledge_router.KnowledgeDirectoryCreateForm(name='docs', parent_id=notes.id), user=user, db=None
        )
    )
    with pytest.raises(HTTPException) as refused_move:
        _run(
            knowledge_router.update_knowledge_directory(
                None, kb, nested.id, knowledge_router.KnowledgeDirectoryUpdateForm(parent_id=None), user=user, db=None
            )
        )

    assert refused_create.value.status_code == 400
    assert refused_rename.value.status_code == 400
    assert refused_move.value.status_code == 400
    assert sorted(d.name for d in _run(Knowledges.get_directories(kb))) == ['docs', 'notes']
    assert _run(Knowledges.get_directory_by_id(nested.id)).parent_id == notes.id
