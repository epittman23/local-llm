"""add user variables

Revision ID: b0018471bbbe
Revises: c49178636c78
Create Date: 2026-07-24 01:21:46.457057

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'b0018471bbbe'
down_revision: str | None = 'c49178636c78'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = [col['name'] for col in inspector.get_columns('user')]

    if 'variables' not in columns:
        op.add_column('user', sa.Column('variables', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('user', 'variables')
