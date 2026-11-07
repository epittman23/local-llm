"""give every user without a credentials row one, with a random password nobody knows

Revision ID: 6d9f8d9d38f6
Revises: c8e1f5a2d907
Create Date: 2026-11-06

Every way of creating a user makes a credentials (`auth`) row beside the
user row, but SCIM's create did not until #296 was fixed (#718). Users it
made before that still have none, so trusted-header sign-in fails for them
(`Auths.authenticate_user_by_email` needs the row), and the OAuth sign-in's
email sync and SCIM's email updates have no row to change (#627).

This gives each such user the row SCIM's create now makes: their email,
active, and the hash of a random password nobody knows, so password sign-in
stays closed until an admin sets a password. The hash is bcrypt whatever
PASSWORD_HASH_ALGORITHM says: `verify_password` reads the algorithm from the
hash, and a password set later is hashed with the configured one. Nothing
from `local_llm` is imported, because the migrations run while its config
is being imported.
"""

import secrets
from collections.abc import Sequence

import bcrypt
import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '6d9f8d9d38f6'
down_revision: str | None = 'c8e1f5a2d907'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_user = sa.table(
    'user',
    sa.column('id', sa.String),
    sa.column('email', sa.String),
)

_auth = sa.table(
    'auth',
    sa.column('id', sa.String),
    sa.column('email', sa.String),
    sa.column('password', sa.Text),
    sa.column('active', sa.Boolean),
)


def _unknown_password_hash() -> str:
    return bcrypt.hashpw(secrets.token_urlsafe(32).encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def upgrade() -> None:
    # Each row needs its own random hash, which static SQL cannot make.
    if op.get_context().as_sql:
        return

    conn = op.get_bind()
    tables = set(sa.inspect(conn).get_table_names())
    if not {'user', 'auth'} <= tables:
        return

    without_credentials = conn.execute(
        sa.select(_user.c.id, _user.c.email).where(~sa.exists().where(_auth.c.id == _user.c.id))
    ).fetchall()

    for user_id, email in without_credentials:
        conn.execute(
            sa.insert(_auth).values(id=user_id, email=email, password=_unknown_password_hash(), active=True)
        )


def downgrade() -> None:
    # Which rows this made cannot be told from rows whose password was set
    # since, and removing them would break those users' sign-in again.
    pass
