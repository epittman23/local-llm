"""Tag names that normalise to the same id never fail a tag batch (#283).

A tag's id is its name lower-cased with spaces turned into underscores, and
(id, user_id) is the tag table's primary key, so names like 'Python' and
'python' are one tag. Runs against the test run's migrated SQLite database,
which enforces that key as Postgres does; the chats router goes through the
real auth dependency, with only events faked. Pinned:

- `Tags.ensure_tags_exist` creates one row per normalised id, keeping the
  first spelling as its name;
- `Chats.update_chat_tags_by_id` (the tag-generation task's write) stores
  each id once in the chat's meta and creates its tag rows;
- unarchiving a chat whose meta already repeats a tag id (written before
  this fix) succeeds and creates the tag row instead of returning 500.

Run from apps/server:

    python -m pytest tests/test_tag_batch_dedupe.py
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import update

from local_llm.internal.db import get_async_db_context
from local_llm.models.chats import Chat, ChatForm, Chats
from local_llm.models.tags import Tags
from local_llm.models.users import Users
from local_llm.routers import chats as chats_router
from local_llm.utils.auth import create_token


def _run(coro):
    return asyncio.run(coro)


def _user() -> SimpleNamespace:
    uid = f'tag-user-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, 'tag user', f'{uid}@example.com', role='user'))
    token = create_token({'id': uid}, dt.timedelta(minutes=30))
    return SimpleNamespace(id=uid, headers={'Authorization': f'Bearer {token}'})


def _chat(user_id: str) -> str:
    chat_id = str(uuid.uuid4())
    form = ChatForm(chat={'title': 'tags', 'history': {'currentId': None, 'messages': {}}, 'models': ['m']})
    _run(Chats.insert_new_chat(chat_id, user_id, form))
    return chat_id


def _tags(user_id: str) -> dict[str, str]:
    return {t.id: t.name for t in _run(Tags.get_tags_by_user_id(user_id))}


def test_ensure_tags_exist_creates_one_row_per_normalised_id():
    user = _user()
    _run(Tags.ensure_tags_exist(['Python', 'python', 'Data Analysis', 'data_analysis', 'Math', 'Math'], user.id))
    assert _tags(user.id) == {'python': 'Python', 'data_analysis': 'Data Analysis', 'math': 'Math'}


def test_update_chat_tags_stores_each_id_once_and_creates_its_rows():
    user = _user()
    chat_id = _chat(user.id)
    _run(Chats.update_chat_tags_by_id(chat_id, ['Python', 'python', 'Data Analysis', 'data_analysis'], user))
    chat = _run(Chats.get_chat_by_id(chat_id))
    assert chat is not None
    assert chat.meta['tags'] == ['python', 'data_analysis']
    assert _tags(user.id) == {'python': 'Python', 'data_analysis': 'Data Analysis'}


def test_unarchive_with_repeated_tag_ids_in_meta_succeeds(monkeypatch):
    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(chats_router, 'publish_event', nothing)
    app = FastAPI()
    app.state.redis = None
    app.include_router(chats_router.router, prefix='/chats')
    client = TestClient(app)

    user = _user()
    chat_id = _chat(user.id)

    async def archive_with_repeated_tags():
        async with get_async_db_context() as session:
            await session.execute(
                update(Chat).filter_by(id=chat_id).values(archived=True, meta={'tags': ['python', 'python']})
            )
            await session.commit()

    _run(archive_with_repeated_tags())

    response = client.post(f'/chats/{chat_id}/archive', headers=user.headers)
    assert response.status_code == 200, response.text
    assert response.json()['archived'] is False
    assert _tags(user.id) == {'python': 'python'}


def test_ensure_tags_exist_leaves_an_existing_tag_and_its_spelling_alone():
    user = _user()
    _run(Tags.ensure_tags_exist(['Python'], user.id))

    _run(Tags.ensure_tags_exist(['PYTHON', 'Rust'], user.id))

    assert _tags(user.id) == {'python': 'Python', 'rust': 'Rust'}
