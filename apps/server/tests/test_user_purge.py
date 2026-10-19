"""Deleting a user removes their private data and hands shared things to an admin.

Against the test run's migrated SQLite database.

Run from apps/server:

    python -m pytest tests/test_user_purge.py
"""

from __future__ import annotations

import asyncio
import time
import uuid

from sqlalchemy import JSON, BigInteger, Boolean, Date, DateTime, Integer, select

from local_llm.internal.db import get_async_db_context
from local_llm.models.access_grants import AccessGrant
from local_llm.models.auths import Auth
from local_llm.models.chats import Chat, ChatFile
from local_llm.models.files import File
from local_llm.models.knowledge import Knowledge, KnowledgeFile
from local_llm.models.memories import Memory
from local_llm.models.notes import Note
from local_llm.models.oauth_sessions import OAuthSession
from local_llm.models.users import ApiKey, User, Users


def _row(table, **values):
    """An instance with every column filled, so the test names only what it checks."""
    for column in table.__table__.columns:
        # Every unset column, nullable or not: the migrated tables are stricter
        # than some ORM declarations (knowledge.name is NOT NULL there).
        if column.name in values or column.default is not None or column.server_default is not None:
            continue
        if column.nullable and isinstance(column.type, (Date, DateTime)):
            continue
        if isinstance(column.type, (BigInteger, Integer)):
            values[column.name] = int(time.time())
        elif isinstance(column.type, Boolean):
            values[column.name] = False
        elif isinstance(column.type, JSON):
            values[column.name] = {}
        else:
            values[column.name] = f'{column.name}-{uuid.uuid4().hex[:8]}'
    return table(**values)


def _run(coro):
    return asyncio.run(coro)


async def _add(*rows):
    async with get_async_db_context() as db:
        for row in rows:
            db.add(row)
        await db.commit()


async def _get(table, **where):
    async with get_async_db_context() as db:
        return (await db.execute(select(table).filter_by(**where))).scalars().all()


def test_purge_deletes_private_data_and_reassigns_shared(monkeypatch):
    from local_llm.utils import user_purge

    async def no_stored_data(*_a, **_k):
        return None

    monkeypatch.setattr(user_purge, '_remove_stored_data', no_stored_data)

    gone, admin = f'gone-{uuid.uuid4().hex[:6]}', f'admin-{uuid.uuid4().hex[:6]}'
    _run(
        _add(
            _row(User, id=admin, role='admin', email=f'{admin}@x', created_at=1),
            _row(User, id=gone, role='user', email=f'{gone}@x', created_at=2),
            _row(Auth, id=gone, email=f'{gone}@x', password='hash'),
            _row(ApiKey, id=f'k-{gone}', user_id=gone, key=f'sk-{gone}'),
            _row(OAuthSession, id=f'o-{gone}', user_id=gone),
            _row(Memory, id=f'm-{gone}', user_id=gone, content='private'),
            _row(Note, id=f'private-{gone}', user_id=gone),
            _row(Note, id=f'shared-{gone}', user_id=gone),
            _row(
                AccessGrant,
                id=f'g-{gone}',
                resource_type='note',
                resource_id=f'shared-{gone}',
                principal_type='user',
                principal_id='someone-else',
                permission='read',
            ),  # fmt: skip
            _row(Knowledge, id=f'kb-{gone}', user_id=gone),
            _row(File, id=f'loose-{gone}', user_id=gone),
            _row(Chat, id=f'c-{gone}', user_id=gone, title='t', chat={}),
            _row(ChatFile, id=f'cf-{gone}', user_id=gone, chat_id=f'c-{gone}', file_id=f'loose-{gone}'),
            _row(File, id=f'inkb-{gone}', user_id=gone),
            _row(KnowledgeFile, id=f'kf-{gone}', knowledge_id=f'kb-{gone}', file_id=f'inkb-{gone}', user_id=gone),
        )
    )

    assert _run(Users.delete_user_by_id(gone)) is True

    for table in (User, ApiKey, OAuthSession, Memory, Chat, ChatFile):
        assert _run(_get(table, **({'id': gone} if table is User else {'user_id': gone}))) == [], table
    assert _run(_get(Auth, id=gone)) == []
    assert _run(_get(Note, id=f'private-{gone}')) == []
    assert _run(_get(File, id=f'loose-{gone}')) == []
    assert [n.user_id for n in _run(_get(Note, id=f'shared-{gone}'))] == [admin]
    assert [k.user_id for k in _run(_get(Knowledge, id=f'kb-{gone}'))] == [admin]
    assert [f.user_id for f in _run(_get(File, id=f'inkb-{gone}'))] == [admin]
