"""note the config_id change: model, extra and fit are fingerprinted

Revision ID: f4b6d2e8a913
Revises: c7e2a9d41b05
Create Date: 2026-10-19

No schema change. The serving fingerprint gained three lines (#127): the
weights file's basename, the profile's extra arguments, and `fit: off` (the
launcher now passes `-fit off`). Every config_id computed from here on
differs from one computed before, for the same profile; this row says so,
so the database explains its own discontinuity. The database held no
benchmark results when this was written.
"""

import sqlalchemy as sa
from alembic import op

revision: str = 'f4b6d2e8a913'
down_revision: str | None = 'c7e2a9d41b05'
branch_labels = None
depends_on = None

SCHEMA_NOTE = (
    'config_id now also covers the model file (basename, so moving the weights '
    "directory keeps the id), the profile's extra arguments, and fit (llama.cpp's "
    'automatic offload fitting, which the launcher turns off with -fit off). Every '
    'config_id changed once: a configuration recorded before this note and the '
    'same one recorded after it have different ids, and are not comparable.'
)


def upgrade():
    conn = op.get_bind()
    note = sa.table('benchmark_schema_note', sa.column('noted_on', sa.Text), sa.column('note', sa.Text))
    exists = conn.execute(sa.select(sa.func.count()).select_from(note).where(note.c.note == SCHEMA_NOTE)).scalar()
    if not exists:
        conn.execute(note.insert().values(noted_on='2026-10-19', note=SCHEMA_NOTE))


def downgrade():
    conn = op.get_bind()
    note = sa.table('benchmark_schema_note', sa.column('note', sa.Text))
    conn.execute(note.delete().where(note.c.note == SCHEMA_NOTE))
