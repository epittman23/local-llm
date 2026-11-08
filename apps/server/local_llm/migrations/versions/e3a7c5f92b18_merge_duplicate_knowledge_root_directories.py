"""merge knowledge root directories that share a name, and keep root names unique

Revision ID: e3a7c5f92b18
Revises: 6d9f8d9d38f6
Create Date: 2026-11-08

Sibling directories of a knowledge base are kept unique by the constraint on
(knowledge_id, parent_id, name), but Postgres and SQLite treat NULL parents as
distinct, so it never covered the root. #312 made the app check a sibling's
name first, which two requests at the same moment can both pass, and the
root directories that already shared a name stayed (#634).

This merges each set of root directories of one base and one name into its
oldest (created_at, then id). A merged directory's files move into the one it
merges into, and its subdirectories move under it; where both have a
subdirectory of one name, those are merged the same way, the oldest kept, all
the way down. No file is unlinked: two files of one path and name both stay,
as copies the sync already handles (#639). Then a unique index on
(knowledge_id, name) over root directories stops new ones, so the request
that loses a race fails at the database.

Every row that names a directory is moved before its directory is deleted:
knowledge_file.directory_id (ON DELETE SET NULL) and
knowledge_directory.parent_id (ON DELETE CASCADE). On a database without
such duplicates it changes no row. Nothing from `local_llm` is imported,
because the migrations run while its config is being imported.
"""

import logging
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'e3a7c5f92b18'
down_revision: str | None = '6d9f8d9d38f6'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# alembic.ini shows INFO from alembic's loggers only, so the merges are logged on its migration logger.
log = logging.getLogger('alembic.runtime.migration')

INDEX_NAME = 'uq_knowledge_directory_root_name'
PARENT_IS_NULL = sa.text('parent_id IS NULL')

_directory = sa.table(
    'knowledge_directory',
    sa.column('id', sa.Text),
    sa.column('knowledge_id', sa.Text),
    sa.column('parent_id', sa.Text),
    sa.column('name', sa.Text),
    sa.column('created_at', sa.BigInteger),
)

_knowledge_file = sa.table(
    'knowledge_file',
    sa.column('directory_id', sa.Text),
)

_OLDEST_FIRST = (_directory.c.created_at, _directory.c.id)


def _index_exists(conn) -> bool:
    return INDEX_NAME in {index['name'] for index in sa.inspect(conn).get_indexes('knowledge_directory')}


def _create_index() -> None:
    op.create_index(
        INDEX_NAME,
        'knowledge_directory',
        ['knowledge_id', 'name'],
        unique=True,
        postgresql_where=PARENT_IS_NULL,
        sqlite_where=PARENT_IS_NULL,
    )


def _children(conn, parent_id: str) -> list:
    return conn.execute(
        sa.select(_directory.c.id, _directory.c.name, _directory.c.created_at)
        .where(_directory.c.parent_id == parent_id)
        .order_by(*_OLDEST_FIRST)
    ).all()


def _merge(conn, keep: str, drop: str) -> None:
    """Move everything in directory `drop` into directory `keep`, then delete `drop`."""
    for child in _children(conn, drop):
        twin = next((c for c in _children(conn, keep) if c.name == child.name), None)
        if twin is None:
            conn.execute(sa.update(_directory).where(_directory.c.id == child.id).values(parent_id=keep))
        elif (child.created_at, child.id) < (twin.created_at, twin.id):
            # The older of the two stays: the twin merges into it, and it takes the twin's place.
            _merge(conn, child.id, twin.id)
            conn.execute(sa.update(_directory).where(_directory.c.id == child.id).values(parent_id=keep))
        else:
            _merge(conn, twin.id, child.id)

    conn.execute(sa.update(_knowledge_file).where(_knowledge_file.c.directory_id == drop).values(directory_id=keep))
    conn.execute(sa.delete(_directory).where(_directory.c.id == drop))


def upgrade() -> None:
    # Which directories to merge depends on the rows, which static SQL cannot see.
    if op.get_context().as_sql:
        _create_index()
        return

    conn = op.get_bind()
    if 'knowledge_directory' not in sa.inspect(conn).get_table_names() or _index_exists(conn):
        return

    duplicates = conn.execute(
        sa.select(_directory.c.knowledge_id, _directory.c.name)
        .where(_directory.c.parent_id.is_(None))
        .group_by(_directory.c.knowledge_id, _directory.c.name)
        .having(sa.func.count() > 1)
        .order_by(_directory.c.knowledge_id, _directory.c.name)
    ).all()

    for knowledge_id, name in duplicates:
        keep, *drops = conn.execute(
            sa.select(_directory.c.id)
            .where(
                _directory.c.knowledge_id == knowledge_id,
                _directory.c.parent_id.is_(None),
                _directory.c.name == name,
            )
            .order_by(*_OLDEST_FIRST)
        ).scalars()
        for drop in drops:
            _merge(conn, keep, drop)
        log.info(
            'Merged %d root directories named %r of knowledge base %s into %s', len(drops), name, knowledge_id, keep
        )

    _create_index()


def downgrade() -> None:
    # The merged directories stay merged: which files and subdirectories were
    # in which copy is not kept.
    if op.get_context().as_sql or _index_exists(op.get_bind()):
        op.drop_index(INDEX_NAME, table_name='knowledge_directory')
