"""Unshare-all reaches every shared chat; a new share starts without old grants.

Against the test run's migrated SQLite database.

Run from apps/server:

    python -m pytest tests/test_unshare_all.py
"""

from __future__ import annotations

import asyncio
import time
import uuid
from types import SimpleNamespace

from local_llm.internal.db import get_async_db_context
from local_llm.models.shared_chats import SharedChat, SharedChats
from local_llm.routers import chats as chats_router


def _share(user_id: str, n: int) -> list[str]:
    async def go():
        ids = []
        async with get_async_db_context() as db:
            for i in range(n):
                chat_id = f'{user_id}-chat-{i}'
                ids.append(chat_id)
                db.add(
                    SharedChat(
                        id=str(uuid.uuid4()), chat_id=chat_id, user_id=user_id, title=f't{i}', chat={},
                        created_at=int(time.time()) + i, updated_at=int(time.time()) + i,
                    )
                )  # fmt: skip
            await db.commit()
        return ids

    return asyncio.run(go())


def test_every_shared_chat_id_is_returned_beyond_the_listing_page():
    ids = _share('u-many-shares', 75)
    assert len(asyncio.run(SharedChats.get_by_user_id('u-many-shares'))) == 50
    assert sorted(asyncio.run(SharedChats.get_chat_ids_by_user_id('u-many-shares'))) == sorted(ids)


def test_unshare_all_clears_grants_for_every_chat(monkeypatch):
    ids = _share('u-unshare-all', 60)
    cleared, unlinked = [], []

    async def set_grants(resource_type, resource_id, grants, db=None):
        assert resource_type == 'shared_chat' and grants == []
        cleared.append(resource_id)

    async def unlink(chat_id, share_id, db=None):
        unlinked.append(chat_id)

    async def publish(*_a, **_k):
        return None

    monkeypatch.setattr(chats_router.AccessGrants, 'set_access_grants', set_grants)
    monkeypatch.setattr(chats_router.Chats, 'update_chat_share_id_by_id', unlink)
    monkeypatch.setattr(chats_router, 'publish_event', publish)

    user = SimpleNamespace(id='u-unshare-all', role='user')
    assert asyncio.run(chats_router.unshare_all_chats(request=None, user=user, db=None)) is True
    assert sorted(cleared) == sorted(ids) and sorted(unlinked) == sorted(ids)
    assert asyncio.run(SharedChats.get_chat_ids_by_user_id('u-unshare-all')) == []
