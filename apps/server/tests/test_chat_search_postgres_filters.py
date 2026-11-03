"""Postgres chat search no longer drops chats over "x00" or a written \\u0000 (#289).

Two "safety" filters ran on every Postgres search:

- `Chat.title::text NOT LIKE '%\\x00%'`: backslash is LIKE's escape
  character, so the pattern was `%x00%`, and it hid every chat whose title
  contains "x00" ("Convert 0x00FF"). Postgres text cannot hold a NUL, so a
  title needs no filter at all.
- `Chat.chat::text NOT LIKE '%\\\\u0000%'`: it hid every chat whose messages
  contain the text \\u0000, as in a question about escape sequences.

The content guard is still needed in some form: a JSON-escaped NUL cannot
be extracted as text (Postgres raises "unsupported Unicode escape
sequence"), so one old row holding it would fail the whole search. It is
now a regex that matches only a real escape. Checked by hand on Postgres 16
(pgvector image) with the cases below; these tests run the search with a
fake session and read the SQL it sends, and check the pattern in Python.

Run from apps/server:

    python -m pytest tests/test_chat_search_postgres_filters.py
"""

import asyncio
import json
import re
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from sqlalchemy.dialects import postgresql

from local_llm.models import chats as chats_model


class _Result:
    def scalars(self):
        return self

    def all(self):
        return []


class _Session:
    def __init__(self, executed: list):
        self.executed = executed

    async def connection(self):
        return SimpleNamespace(dialect=SimpleNamespace(name='postgresql'))

    async def execute(self, stmt):
        compiled = stmt.compile(dialect=postgresql.dialect())
        self.executed.append((str(compiled), compiled.params))
        return _Result()


def _search(monkeypatch, text: str) -> tuple[str, list]:
    executed: list[tuple[str, dict]] = []

    @asynccontextmanager
    async def fake_db(db=None):
        yield _Session(executed)

    async def no_folders(user_id, names):
        return []

    monkeypatch.setattr(chats_model, 'get_async_db_context', fake_db)
    monkeypatch.setattr(chats_model.Folders, 'search_folders_by_names', no_folders)
    asyncio.run(chats_model.Chats.get_chats_by_user_id_and_search_text('u1', text))
    assert executed, 'the search ran no query'
    return '\n'.join(sql for sql, _ in executed), [v for _, params in executed for v in params.values()]


def test_the_search_sends_no_filter_on_x00_and_only_the_precise_nul_guard(monkeypatch):
    sql, _ = _search(monkeypatch, '0x00ff')

    assert 'NOT LIKE' not in sql
    assert 'x00' not in sql
    assert f"Chat.chat::text !~ '{chats_model.CHAT_JSON_NUL}'" in sql


@pytest.mark.parametrize(
    ('json_text', 'holds_a_nul'),
    [
        # What json.dumps writes, so what Chat.chat::text holds.
        (json.dumps({'c': 'use \\u0000 here'}), False),  # the user typed backslash-u0000
        (json.dumps({'c': 'Convert 0x00FF'}), False),
        (json.dumps({'c': 'a\x00b'}), True),  # a real NUL, escaped by JSON
        (json.dumps({'c': 'a\\\x00b'}), True),  # a typed backslash, then a real NUL
        (json.dumps({'c': '\x00'}), True),
    ],
)
def test_the_guard_matches_a_real_escaped_nul_only(json_text, holds_a_nul):
    assert bool(re.search(chats_model.CHAT_JSON_NUL, json_text)) is holds_a_nul


def test_the_search_still_matches_the_words_it_was_given(monkeypatch):
    _, params = _search(monkeypatch, '0x00ff')

    assert '%0x00ff%' in params
