"""add chat message meta

Revision ID: 856c5b02fb54
Revises: 42e2978c7933
Create Date: 2026-07-16 01:39:39.291935

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '856c5b02fb54'
down_revision: str | None = '42e2978c7933'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('chat_message', sa.Column('meta', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('chat_message', 'meta')
