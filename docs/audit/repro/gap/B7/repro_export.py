"""B7 repro 3: /chats/all export pages by OFFSET over updated_at DESC; a chat updated mid-export is skipped and another duplicated."""

import asyncio
import json

from sqlalchemy import update

from local_llm.internal import db as dbmod
from local_llm.models import chat_messages, files, folders, users, tags, shared_chats, automations  # noqa: F401
from local_llm.models.chats import Chat, ChatForm, Chats
import importlib, pkgutil, local_llm.models as _m
for _x in pkgutil.iter_modules(_m.__path__):
    importlib.import_module(f'local_llm.models.{_x.name}')
from local_llm.routers.chats import generate_chat_export_ndjson


async def main():
    async with dbmod.async_engine.begin() as conn:
        await conn.run_sync(dbmod.Base.metadata.create_all)
    uid = 'u1'
    for i in range(150):
        await Chats.insert_new_chat(f'c{i:03d}', uid, ChatForm(chat={'title': f't{i}'}))
    # distinct updated_at so ordering is c149 (newest) .. c000 (oldest)
    async with dbmod.get_async_db_context() as s:
        for i in range(150):
            await s.execute(update(Chat).filter_by(id=f'c{i:03d}').values(updated_at=1_000_000 + i))
        await s.commit()

    ids = []
    n = 0
    async for line in generate_chat_export_ndjson(uid):
        ids.append(json.loads(line)['id'])
        n += 1
        if n == 100:
            # A reply lands in an old chat (page 2) while the export is between batches.
            async with dbmod.get_async_db_context() as s:
                await s.execute(update(Chat).filter_by(id='c010').values(updated_at=2_000_000))
                await s.commit()
    print('exported rows:', len(ids), 'unique:', len(set(ids)))
    print('missing:', sorted({f'c{i:03d}' for i in range(150)} - set(ids)))
    print('duplicated:', sorted({x for x in ids if ids.count(x) > 1}))


asyncio.run(main())
