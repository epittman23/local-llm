"""search_notes and search_chats find older matches inside a date range (#181).

Both tools fetched the newest `count * 3` matches and only then dropped the
ones outside start/end in Python, so a range in the past found nothing
whenever enough newer matches existed: "my notes about X from last year"
reported none. The range is now part of the query. These run against the
test run's migrated database.

Run from apps/server (any LLLM_SECRET_KEY of 32 characters or more):

    LLLM_SECRET_KEY=... python -m pytest tests/test_search_tools_date_range.py
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from types import SimpleNamespace

from sqlalchemy import update

from local_llm.internal.db import get_async_db_context
from local_llm.models.chats import Chat, ChatForm, Chats
from local_llm.models.notes import Note, NoteForm, Notes
from local_llm.models.users import Users
from local_llm.tools import builtin

YEAR = 365 * 24 * 3600
NOW = int(time.time())
LAST_YEAR = NOW - YEAR


def _run(coro):
    return asyncio.run(coro)


def _user() -> str:
    uid = f'range-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, 'user', f'{uid}@example.com', role='user'))
    return uid


async def _age(model, row_id: str, seconds: int, scale: int = 1):
    async with get_async_db_context() as db:
        await db.execute(update(model).where(model.id == row_id).values(updated_at=seconds * scale))
        await db.commit()


def _notes(uid: str):
    """15 recent notes about kubernetes and 5 from a year ago."""
    for i in range(20):
        note = _run(Notes.insert_new_note(uid, NoteForm(title=f'kubernetes {i}', data={'content': {'md': 'k8s'}})))
        when = NOW - i * 60 if i < 15 else LAST_YEAR - i * 60
        _run(_age(Note, note.id, when, scale=1_000_000_000))  # notes keep nanoseconds


def _chats(uid: str):
    """15 recent chats about kubernetes and 5 from a year ago."""
    for i in range(20):
        chat_id = str(uuid.uuid4())
        _run(Chats.insert_new_chat(chat_id, uid, ChatForm(chat={'title': f'kubernetes {i}', 'messages': []})))
        when = NOW - i * 60 if i < 15 else LAST_YEAR - i * 60
        _run(_age(Chat, chat_id, when))  # chats keep seconds


REQUEST = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))


def test_search_notes_finds_last_years_notes_behind_newer_matches():
    uid = _user()
    _notes(uid)

    found = json.loads(
        _run(
            builtin.search_notes(
                'kubernetes',
                count=5,
                end_timestamp=NOW - YEAR // 2,
                __request__=REQUEST,
                __user__={'id': uid},
            )
        )
    )

    assert [n['title'] for n in found] == [f'kubernetes {i}' for i in range(15, 20)]


def test_search_chats_finds_last_years_chats_behind_newer_matches():
    uid = _user()
    _chats(uid)

    found = json.loads(
        _run(
            builtin.search_chats(
                'kubernetes',
                count=5,
                end_timestamp=NOW - YEAR // 2,
                __request__=REQUEST,
                __user__={'id': uid},
            )
        )
    )

    assert [c['title'] for c in found] == [f'kubernetes {i}' for i in range(15, 20)]


def test_a_start_bound_keeps_only_the_newer_ones():
    uid = _user()
    _chats(uid)

    found = json.loads(
        _run(
            builtin.search_chats(
                'kubernetes',
                count=20,
                start_timestamp=NOW - 3600,
                __request__=REQUEST,
                __user__={'id': uid},
            )
        )
    )

    assert len(found) == 15
    assert all(c['updated_at'] >= NOW - 3600 for c in found)


def test_the_current_chat_is_still_left_out_and_does_not_cost_a_result():
    uid = _user()
    _chats(uid)
    newest = _run(Chats.get_chats_by_user_id_and_search_text(uid, 'kubernetes', limit=1))[0]

    found = json.loads(
        _run(
            builtin.search_chats(
                'kubernetes', count=5, __request__=REQUEST, __user__={'id': uid}, __chat_id__=newest.id
            )
        )
    )

    assert len(found) == 5
    assert newest.id not in [c['id'] for c in found]
