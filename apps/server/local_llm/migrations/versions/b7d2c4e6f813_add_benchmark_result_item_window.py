"""add benchmark_result.item_window: the release-date window a windowed item was drawn under

Revision ID: b7d2c4e6f813
Revises: a3c5e7f91b24
Create Date: 2026-10-25

LiveCodeBench problems are dated, and a run draws them from a release-date
window the user gives (docs/plans/benchmark-upgrade.md, sections 5.3 and
7.3). The window is a request-side choice, like the system prompt, so it is
a column on the result and part of the Compare and Report grouping keys, not
part of config_id.

- `YYYY-MM-DD..YYYY-MM-DD`, or `YYYY-MM-DD..` with no upper bound.
- NULL for every unwindowed benchmark, so every existing row keeps its
  meaning.
"""

import sqlalchemy as sa
from alembic import op

revision: str = 'b7d2c4e6f813'
down_revision: str | None = 'a3c5e7f91b24'
branch_labels = None
depends_on = None

SCHEMA_NOTE = (
    'benchmark_result.item_window added: the release-date window a windowed item '
    '(LiveCodeBench) was drawn under, as YYYY-MM-DD..YYYY-MM-DD or YYYY-MM-DD.. with no '
    'upper bound. NULL for unwindowed benchmarks. Results with different windows are '
    'never grouped or compared together. config_id is unchanged.'
)


def upgrade():
    conn = op.get_bind()
    columns = {c['name'] for c in sa.inspect(conn).get_columns('benchmark_result')}
    if 'item_window' not in columns:
        op.add_column('benchmark_result', sa.Column('item_window', sa.Text(), nullable=True))

    note = sa.table('benchmark_schema_note', sa.column('noted_on', sa.Text), sa.column('note', sa.Text))
    exists = conn.execute(sa.select(sa.func.count()).select_from(note).where(note.c.note == SCHEMA_NOTE)).scalar()
    if not exists:
        conn.execute(note.insert().values(noted_on='2026-10-25', note=SCHEMA_NOTE))


def downgrade():
    conn = op.get_bind()
    note = sa.table('benchmark_schema_note', sa.column('note', sa.Text))
    conn.execute(note.delete().where(note.c.note == SCHEMA_NOTE))
    op.drop_column('benchmark_result', 'item_window')
