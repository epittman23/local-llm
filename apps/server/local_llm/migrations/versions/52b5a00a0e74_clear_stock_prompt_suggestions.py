"""clear the stock prompt suggestions

Revision ID: 52b5a00a0e74
Revises: 807e3e98e4af
Create Date: 2026-11-14

The owner decided on 2026-11-14 (#1065, decision D2) that the new-chat screen
shows no prompt suggestions: Open WebUI's stock list ("Help me study
vocabulary...", "Tell me a fun fact about the Roman Empire", ...) misstated
what the assistant is for. config.py's default became an empty list, but an
existing install has the stock list stored in the `ui.prompt_suggestions`
row, seeded from the old default at its first start.

This deletes that row only when its value equals the stock list exactly
(compared as decoded JSON, so the stored spelling does not matter). A list an
admin edited in any way is left alone. With the row gone, the backend seeds
it again at startup, after migrations, from DEFAULT_PROMPT_SUGGESTIONS (the
environment, or the new empty default). Re-running it changes nothing. A
database without the per-key `config` table, or without the row, is left
alone.

downgrade() restores nothing. The deleted value was the old code's default,
not anything a person wrote, and an older backend re-seeds a missing key from
its own default when it starts, so the stock list comes back on its own if
the code is rolled back. config_id is unchanged, so there is no
benchmark_schema_note.
"""

import sqlalchemy as sa
from alembic import op

revision: str = '52b5a00a0e74'
down_revision: str | None = '807e3e98e4af'
branch_labels = None
depends_on = None

KEY = 'ui.prompt_suggestions'

# Open WebUI's stock list, as config.py defined it before this revision.
STOCK_PROMPT_SUGGESTIONS = [
    {
        'title': ['Help me study', 'vocabulary for a college entrance exam'],
        'content': (
            "Help me study vocabulary: write a sentence for me to fill in the blank, and I'll try to pick the "
            'correct option.'
        ),
    },
    {
        'title': ['Give me ideas', "for what to do with my kids' art"],
        'content': (
            "What are 5 creative things I could do with my kids' art? I don't want to throw them away, but it's "
            'also '
            'so much clutter.'
        ),
    },
    {
        'title': ['Tell me a fun fact', 'about the Roman Empire'],
        'content': 'Tell me a random fun fact about the Roman Empire',
    },
    {
        'title': ['Show me a code snippet', "of a website's sticky header"],
        'content': "Show me a code snippet of a website's sticky header in CSS and JavaScript.",
    },
    {
        'title': [
            'Explain options trading',
            "if I'm familiar with buying and selling stocks",
        ],
        'content': "Explain options trading in simple terms if I'm familiar with buying and selling stocks.",
    },
    {
        'title': ['Overcome procrastination', 'give me tips'],
        'content': (
            'Could you start by asking me about instances when I procrastinate the most and then give me some '
            'suggestions to overcome it?'
        ),
    },
]

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
    value = conn.execute(sa.select(config.c.value).where(config.c.key == KEY)).scalar_one_or_none()
    if value == STOCK_PROMPT_SUGGESTIONS:
        conn.execute(config.delete().where(config.c.key == KEY))


def downgrade():
    # Nothing to restore; see the module docstring.
    pass
