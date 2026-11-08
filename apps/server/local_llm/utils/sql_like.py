"""User text in a SQL LIKE pattern, matched as text (#292, #625).

A search binds the user's text into `LIKE` / `ILIKE`, where `%` and `_` are
wildcards: searching for `%` matched everything, and `_` any one character.
`like_escape` escapes them, and the escape character itself, for a pattern
compared with `escape=LIKE_ESCAPE`. SQLite has no default escape character,
so the explicit one is what makes this work on both SQLite and Postgres.
"""

LIKE_ESCAPE = '\\'


def like_escape(text: str) -> str:
    """Text for a LIKE pattern with `ESCAPE '\\'`: its `\\`, `%` and `_` match themselves."""
    return text.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


def like_contains(text: str) -> str:
    """A LIKE pattern matching any value that contains `text`, compared with `escape=LIKE_ESCAPE`."""
    return f'%{like_escape(text)}%'
