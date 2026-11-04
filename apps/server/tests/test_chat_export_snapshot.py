"""The chat export gives every chat once, even when one is updated during it (#294).

`GET /chats/all` streamed the chats in batches with OFFSET over
`updated_at DESC`. A chat updated between two batches moved to the front, so
the rows after it shifted: one chat was skipped and another sent twice, and a
backup silently lost a chat. The export now takes the list of chat ids first
and streams those, a batch at a time.

Runs against the test run's migrated SQLite database.

Run from apps/server:

    python -m pytest tests/test_chat_export_snapshot.py
"""

import asyncio
import importlib
import json
import time
import uuid

from sqlalchemy import update

from local_llm.internal.db import get_async_db
from local_llm.models.chats import Chat, ChatForm, Chats
from local_llm.models.users import Users
from local_llm.routers import chats as chats_router

# Importing the config runs the migrations on the test run's database.
importlib.import_module('local_llm.config')


def test_a_chat_updated_during_the_export_is_neither_skipped_nor_repeated(monkeypatch):
    tag = uuid.uuid4().hex[:8]
    monkeypatch.setattr(chats_router, 'CHAT_EXPORT_BATCH_SIZE', 3)

    async def run():
        user = await Users.insert_new_user(f'u-{tag}', 'Una', f'u-{tag}@example.invalid', role='user')
        ids = [f'c{n}-{tag}' for n in range(8)]
        for n, chat_id in enumerate(ids):
            await Chats.insert_new_chat(chat_id, user.id, ChatForm(chat={'title': f'Chat {n}'}))
        # An internal chat (a sub-agent's, say) is not exported.
        await Chats.insert_new_chat(f'internal-{tag}', user.id, ChatForm(chat={'title': 'x'}))
        async with get_async_db() as db:
            await db.execute(update(Chat).where(Chat.id == f'internal-{tag}').values(meta={'internal': True}))
            await db.commit()

        exported = []
        async for line in chats_router.generate_chat_export_ndjson(user.id):
            exported.append(json.loads(line)['id'])
            if len(exported) == 3:
                # A chat not yet sent is updated after the first batch, which moves it to the front.
                async with get_async_db() as db:
                    await db.execute(update(Chat).where(Chat.id == ids[-1]).values(updated_at=int(time.time()) + 60))
                    await db.commit()
        return ids, exported

    ids, exported = asyncio.run(run())

    assert len(exported) == len(set(exported))
    assert sorted(exported) == sorted(ids)


def test_a_chat_deleted_during_the_export_is_left_out(monkeypatch):
    tag = uuid.uuid4().hex[:8]
    monkeypatch.setattr(chats_router, 'CHAT_EXPORT_BATCH_SIZE', 2)

    async def run():
        user = await Users.insert_new_user(f'd-{tag}', 'Dee', f'd-{tag}@example.invalid', role='user')
        ids = [f'd{n}-{tag}' for n in range(4)]
        for n, chat_id in enumerate(ids):
            await Chats.insert_new_chat(chat_id, user.id, ChatForm(chat={'title': f'Chat {n}'}))
        exported = []
        async for line in chats_router.generate_chat_export_ndjson(user.id):
            exported.append(json.loads(line)['id'])
            if len(exported) == 1:
                await Chats.delete_chat_by_id(ids[-1])
        return ids, exported

    ids, exported = asyncio.run(run())

    assert exported == ids[:-1]
