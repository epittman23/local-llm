"""add sandbox_workspace, the sandbox manager's record of each persistent workspace

Revision ID: 8bede0d9f5c2
Revises: e3a7c5f92b18
Create Date: 2026-11-12

Owner decision Q15 (docs/plans/sandbox-implementation.md, T24): a user holds
at most `code_interpreter.sandbox.max_workspaces` persistent sandbox
workspaces, and none is deleted for that cap or for the retention expiry
without the user's answer. The manager needs a record that survives
restarts for both: whose each volume is, when it was last used (its own
time, not the chat row's `updated_at`, which the chat import takes from the
client), and whether its deletion waits for the user (`cap` or `expired`).

One row per workspace volume, keyed by the backend key (a saved chat's id);
it goes with the volume. Nothing from `local_llm` is imported, because the
migrations run while its config is being imported. config_id is unchanged,
so no benchmark_schema_note row.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '8bede0d9f5c2'
down_revision: str | None = 'e3a7c5f92b18'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade():
    conn = op.get_bind()
    if 'sandbox_workspace' in set(sa.inspect(conn).get_table_names()):
        return
    op.create_table(
        'sandbox_workspace',
        sa.Column('key', sa.Text(), primary_key=True),
        sa.Column('user_id', sa.Text(), nullable=False),
        sa.Column('chat_id', sa.Text(), nullable=False),
        sa.Column('created_at', sa.BigInteger(), nullable=False),
        sa.Column('last_used_at', sa.BigInteger(), nullable=False),
        sa.Column('pending_reason', sa.Text(), nullable=True),
        sa.Column('pending_since', sa.BigInteger(), nullable=True),
        sa.Column('pending_for_chat_id', sa.Text(), nullable=True),
        sa.CheckConstraint(
            "pending_reason IS NULL OR pending_reason IN ('cap', 'expired')", name='ck_sandbox_workspace_pending'
        ),
    )
    op.create_index('ix_sandbox_workspace_user_id', 'sandbox_workspace', ['user_id'])


def downgrade():
    op.drop_index('ix_sandbox_workspace_user_id', table_name='sandbox_workspace')
    op.drop_table('sandbox_workspace')
