"""note the harness spec change: the code interpreter engine from config, the sandbox image digest

Revision ID: 2c8cdc04929d
Revises: 5d1e9c3a7b42
Create Date: 2026-11-13

No schema change. The benchmark harness (benchmarks/evaluation/harness.py)
now runs on the code interpreter engine the app is configured with, the
sandbox or (until it is removed) Jupyter, instead of Jupyter alone
(docs/plans/sandbox-implementation.md, T30). Its spec's
`code_interpreter_engine` comes from config, and a sandbox-engine spec also
carries `sandbox_image` (the `data` image's digest) and the sandbox's tool
set, so its harness_sha never equals a Jupyter-era one. A Jupyter spec is
unchanged, so Jupyter-era shas still name their runs. This row says so, so
the database explains the discontinuity. config_id is unchanged.
"""

import sqlalchemy as sa
from alembic import op

revision: str = '2c8cdc04929d'
down_revision: str | None = '5d1e9c3a7b42'
branch_labels = None
depends_on = None

SCHEMA_NOTE = (
    'benchmark_harness specs now carry code_interpreter_engine from config instead of '
    'always jupyter, and, for the sandbox engine, sandbox_image (the digest of the data '
    'image every harness item runs on) and the sandbox tool set (bash, view, write_file, '
    'str_replace). A sandbox-engine harness_sha never equals a Jupyter-era one; results '
    'with different harness_sha values are never pooled. config_id is unchanged.'
)


def upgrade():
    conn = op.get_bind()
    note = sa.table('benchmark_schema_note', sa.column('noted_on', sa.Text), sa.column('note', sa.Text))
    exists = conn.execute(sa.select(sa.func.count()).select_from(note).where(note.c.note == SCHEMA_NOTE)).scalar()
    if not exists:
        conn.execute(note.insert().values(noted_on='2026-11-13', note=SCHEMA_NOTE))


def downgrade():
    conn = op.get_bind()
    note = sa.table('benchmark_schema_note', sa.column('note', sa.Text))
    conn.execute(note.delete().where(note.c.note == SCHEMA_NOTE))
