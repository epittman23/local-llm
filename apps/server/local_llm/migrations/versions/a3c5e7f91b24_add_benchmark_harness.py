"""add the harness: benchmark_result.harness_sha and harness_stats, benchmark_answer.output, benchmark_harness

Revision ID: a3c5e7f91b24
Revises: f4b6d2e8a913
Create Date: 2026-10-24

A result can now be answered through the app's own chat pipeline (a
Workspace model entry, its system prompt, the Jupyter code interpreter)
instead of straight by llama-server; docs/plans/benchmarks-through-the-app.md.

- `benchmark_result.harness_sha` groups those results beside system_sha:
  NULL means a bare request, so every existing row keeps its meaning.
- `benchmark_harness` holds what each sha stands for, as JSON.
- `benchmark_result.harness_stats` holds a harness item's rounds, output
  tokens and code-execution time; its `timings` stay empty, since llama.cpp
  reports them for the last upstream call only.
- `benchmark_answer.output` keeps the structured output (the code that ran
  and what it printed); `content` stays the graded text.

The harness is not part of config_id, so no existing id changes.
"""

import sqlalchemy as sa
from alembic import op

revision: str = 'a3c5e7f91b24'
down_revision: str | None = 'f4b6d2e8a913'
branch_labels = None
depends_on = None

SCHEMA_NOTE = (
    'benchmark_result.harness_sha added: NULL means the item was sent straight to '
    'llama-server; a value means it was answered through the app chat pipeline, '
    'described by benchmark_harness. Results with different harness_sha values are '
    'never pooled. config_id is unchanged.'
)


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    tables = set(inspector.get_table_names())

    result_columns = {c['name'] for c in inspector.get_columns('benchmark_result')}
    if 'harness_sha' not in result_columns:
        op.add_column('benchmark_result', sa.Column('harness_sha', sa.Text(), nullable=True))
    if 'harness_stats' not in result_columns:
        op.add_column('benchmark_result', sa.Column('harness_stats', sa.JSON(), nullable=True))

    answer_columns = {c['name'] for c in inspector.get_columns('benchmark_answer')}
    if 'output' not in answer_columns:
        op.add_column('benchmark_answer', sa.Column('output', sa.JSON(), nullable=True))

    if 'benchmark_harness' not in tables:
        op.create_table(
            'benchmark_harness',
            sa.Column('harness_sha', sa.Text(), primary_key=True),
            sa.Column('spec', sa.JSON(), nullable=False),
            sa.Column('recorded_at', sa.BigInteger(), nullable=False),
        )

    note = sa.table('benchmark_schema_note', sa.column('noted_on', sa.Text), sa.column('note', sa.Text))
    exists = conn.execute(sa.select(sa.func.count()).select_from(note).where(note.c.note == SCHEMA_NOTE)).scalar()
    if not exists:
        conn.execute(note.insert().values(noted_on='2026-10-24', note=SCHEMA_NOTE))


def downgrade():
    conn = op.get_bind()
    note = sa.table('benchmark_schema_note', sa.column('note', sa.Text))
    conn.execute(note.delete().where(note.c.note == SCHEMA_NOTE))
    op.drop_table('benchmark_harness')
    op.drop_column('benchmark_answer', 'output')
    op.drop_column('benchmark_result', 'harness_stats')
    op.drop_column('benchmark_result', 'harness_sha')
