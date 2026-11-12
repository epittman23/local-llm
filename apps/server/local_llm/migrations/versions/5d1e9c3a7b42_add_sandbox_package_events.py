"""add sandbox_package_events, the sandbox's package telemetry

Revision ID: 5d1e9c3a7b42
Revises: 8bede0d9f5c2
Create Date: 2026-11-12

The code sandbox's package telemetry (docs/plans/sandbox-implementation.md,
T21; docs/proposals/sandbox-code-interpreter.md, "Package telemetry"): after
each `bash` call the manager reads the imports the images' hooks recorded in
the workspace, the misses in the command's output, and the wheels the pip
mirror served, and appends one row per event here. The admin report
(GET /api/v1/sandbox/packages) ranks packages by the chats using them and
misses by the chats that met them, the review queue for the wheelhouse
allowlist and the images.

Append-only rows, with an index on (name, kind) for the report. Nothing from
`local_llm` is imported, because the migrations run while its config is
being imported. config_id is unchanged, so no benchmark_schema_note row.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '5d1e9c3a7b42'
down_revision: str | None = '8bede0d9f5c2'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade():
    conn = op.get_bind()
    if 'sandbox_package_events' in set(sa.inspect(conn).get_table_names()):
        return
    op.create_table(
        'sandbox_package_events',
        sa.Column('event_id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('ts', sa.BigInteger(), nullable=False),
        sa.Column('chat_id', sa.Text(), nullable=False),
        sa.Column('kind', sa.Text(), nullable=False),
        sa.Column('name', sa.Text(), nullable=False),
        sa.Column('version', sa.Text(), nullable=True),
        sa.Column('image_digest', sa.Text(), nullable=False),
        sa.Column('lock_sha', sa.Text(), nullable=False),
        sa.Column('harness_run_id', sa.Text(), nullable=True),
    )
    op.create_index('ix_sandbox_package_events_name_kind', 'sandbox_package_events', ['name', 'kind'])


def downgrade():
    op.drop_index('ix_sandbox_package_events_name_kind', table_name='sandbox_package_events')
    op.drop_table('sandbox_package_events')
