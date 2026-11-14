"""migrate the code interpreter and code execution engines to sandbox

Revision ID: 807e3e98e4af
Revises: 2c8cdc04929d
Create Date: 2026-11-13

Step 3 of the sandbox code interpreter (its proposal, moved to docs/history/
when it was built; docs/plans/sandbox-implementation.md, T43) removes the
Jupyter and Pyodide engines, so `sandbox` is the only engine value. In `config`, the rows `code_interpreter.engine` and
`code_execution.engine` that hold "jupyter" or "pyodide" become "sandbox",
and the rows under `code_interpreter.jupyter.` and `code_execution.jupyter.`,
which no code reads any more, are deleted. Any other engine value is left as
it is. Values are compared and written through the column's JSON type, as
the app itself reads and writes them, so the stored JSON spelling does not
matter. Re-running it changes nothing. A database without the per-key
`config` table, or without the rows, is left alone: the backend seeds
missing keys from its defaults at startup, after migrations.

downgrade() is lossy. It cannot restore the deleted Jupyter values, and it
sets the two engine rows to "jupyter" wherever they are "sandbox", including
an engine that was already "sandbox" or was "pyodide" before the upgrade (the
upgrade keeps no record of which it was). The Jupyter keys come
back, at their defaults, only when a Jupyter-era backend starts and seeds
them. config_id is unchanged, so there is no benchmark_schema_note.
"""

import time

import sqlalchemy as sa
from alembic import op

revision: str = '807e3e98e4af'
down_revision: str | None = '2c8cdc04929d'
branch_labels = None
depends_on = None

ENGINE_KEYS = ('code_interpreter.engine', 'code_execution.engine')
JUPYTER_PREFIXES = ('code_interpreter.jupyter.', 'code_execution.jupyter.')
REMOVED_ENGINES = ('jupyter', 'pyodide')

config = sa.table(
    'config',
    sa.column('key', sa.Text),
    sa.column('value', sa.JSON),
    sa.column('updated_at', sa.BigInteger),
)


def _has_config_table(conn) -> bool:
    inspector = sa.inspect(conn)
    if 'config' not in inspector.get_table_names():
        return False
    return {'key', 'value'}.issubset({column['name'] for column in inspector.get_columns('config')})


def _set_engines(conn, from_values: tuple[str, ...], to_value: str) -> None:
    rows = conn.execute(sa.select(config.c.key, config.c.value).where(config.c.key.in_(ENGINE_KEYS))).all()
    now = int(time.time())
    for key, value in rows:
        if value in from_values:
            conn.execute(config.update().where(config.c.key == key).values(value=to_value, updated_at=now))


def upgrade():
    conn = op.get_bind()
    if not _has_config_table(conn):
        return
    _set_engines(conn, REMOVED_ENGINES, 'sandbox')
    jupyter_keys = sa.or_(*(config.c.key.startswith(prefix, autoescape=True) for prefix in JUPYTER_PREFIXES))
    conn.execute(config.delete().where(jupyter_keys))


def downgrade():
    conn = op.get_bind()
    if not _has_config_table(conn):
        return
    _set_engines(conn, ('sandbox',), 'jupyter')
