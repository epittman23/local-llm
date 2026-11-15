"""turn off the arena models and message rating

Revision ID: c17c2aeb2577
Revises: 52b5a00a0e74
Create Date: 2026-11-15

The owner decided on 2026-11-15 that two Open WebUI features are off unless
turned on (#990, decision S3-D1; #995, decision S3-D2):

- the Arena model (`evaluation.arena.enable`), a blind comparison that
  answers with a random model;
- the thumbs under a reply (`ui.enable_message_rating`).

config.py's defaults became false, but an existing install has both stored
as true, seeded from the old defaults at its first start. This deletes each
of those rows when, and only when, its stored value is true. With the row
gone, the backend seeds it again at startup, after migrations, from the
environment (ENABLE_EVALUATION_ARENA_MODELS, ENABLE_MESSAGE_RATING) or the
new default, false. So an install that sets either variable keeps it on.

A stored true cannot be told apart from one an admin chose in Admin >
Evaluations or Admin Settings > Interface; the owner accepted that both are
turned off and can be turned on again there. A stored false, and any other
key, is left alone. Re-running it changes nothing. A database without the
per-key `config` table, or without the rows, is left alone.

downgrade() restores nothing. The deleted values were the old code's
defaults, and an older backend re-seeds a missing key from its own default
(true) when it starts. config_id is unchanged, so there is no
benchmark_schema_note.
"""

import sqlalchemy as sa
from alembic import op

revision: str = 'c17c2aeb2577'
down_revision: str | None = '52b5a00a0e74'
branch_labels = None
depends_on = None

KEYS = ('evaluation.arena.enable', 'ui.enable_message_rating')

config = sa.table(
    'config',
    sa.column('key', sa.Text),
    sa.column('value', sa.JSON),
)


def _has_config_table(conn) -> bool:
    inspector = sa.inspect(conn)
    if 'config' not in inspector.get_table_names():
        return False
    return {'key', 'value'}.issubset({column['name'] for column in inspector.get_columns('config')})


def upgrade():
    conn = op.get_bind()
    if not _has_config_table(conn):
        return
    for key in KEYS:
        value = conn.execute(sa.select(config.c.value).where(config.c.key == key)).scalar_one_or_none()
        if value is True:
            conn.execute(config.delete().where(config.c.key == key))


def downgrade():
    # Nothing to restore; see the module docstring.
    pass
