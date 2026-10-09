"""add chat variables

Revision ID: c49178636c78
Revises: 9a1b2c3d4e5f
Create Date: 2026-07-23 23:33:45.497453

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'c49178636c78'
down_revision: str | None = '9a1b2c3d4e5f'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = [col['name'] for col in inspector.get_columns('chat')]

    if 'variables' not in columns:
        op.add_column('chat', sa.Column('variables', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('chat', 'variables')
