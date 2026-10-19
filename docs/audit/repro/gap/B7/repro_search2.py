"""B7 repro 2: pinned:false vs NULL pinned (SQLite) and the Postgres-only safety filters as compiled."""

import asyncio
import inspect

from local_llm.internal import db as dbmod
from local_llm.models import chat_messages, files, folders, users, tags, shared_chats, automations  # noqa: F401
from local_llm.models.chats import ChatImportForm, Chats


async def main():
    async with dbmod.async_engine.begin() as conn:
        await conn.run_sync(dbmod.Base.metadata.create_all)
    uid = 'u1'
    await Chats.import_chats(
        uid,
        [
            ChatImportForm(chat={'title': 'imported null pinned'}, pinned=None),
            ChatImportForm(chat={'title': 'imported false pinned'}, pinned=False),
        ],
    )
    res = await Chats.get_chats_by_user_id_and_search_text(uid, 'pinned:false')
    print('search "pinned:false" ->', sorted(c.title for c in res))
    lst = await Chats.get_chat_title_id_list_by_user_id(uid)
    print('sidebar (unpinned) list ->', sorted(c.title for c in lst))

    src = inspect.getsource(Chats.get_chats_by_user_id_and_search_text)
    for line in src.splitlines():
        if 'NOT LIKE' in line:
            # Evaluate the Python string literal exactly as the code does, to see the SQL text sent
            lit = line.strip()[len('stmt = stmt.filter(text(') : -2]
            print('SQL sent to Postgres:', eval(lit))


asyncio.run(main())
