"""B7 repro: chats.py search, insert_chat_files dedupe, files metadata (SQLite, temp DATA_DIR)."""

import asyncio
import time

from local_llm.internal import db as dbmod
from local_llm.models import chats as chats_mod  # noqa: F401  (register tables)
from local_llm.models import chat_messages, files, folders, users, tags, shared_chats, automations  # noqa: F401
from local_llm.models.chats import ChatForm, Chats
from local_llm.models.files import File
from local_llm.models.folders import Folder


async def main():
    engine = dbmod.async_engine
    async with engine.begin() as conn:
        await conn.run_sync(dbmod.Base.metadata.create_all)

    uid = 'u1'
    now = int(time.time())
    # Three chats, distinct titles
    for i, title in enumerate(['Alpha notes', 'Beta plan', 'Gamma 0x00FF hex']):
        await Chats.insert_new_chat(
            f'c{i}',
            uid,
            ChatForm(
                chat={
                    'title': title,
                    'history': {
                        'currentId': f'm{i}',
                        'messages': {f'm{i}': {'id': f'm{i}', 'role': 'user', 'content': f'hello {i}', 'parentId': None, 'childrenIds': []}},
                    },
                }
            ),
        )

    async def search(q):
        res = await Chats.get_chats_by_user_id_and_search_text(uid, q)
        return sorted(c.title for c in res)

    print('search "%"            ->', await search('%'))
    print('search "_"            ->', await search('_'))
    print('search "alpha"        ->', await search('alpha'))
    print('search "folder:nosuch"->', await search('folder:nosuch'))
    print('search "folder:nosuch alpha" ->', await search('folder:nosuch alpha'))

    # ---- insert_chat_files dedupe ----
    async with dbmod.get_async_db_context() as s:
        for fid in ('F', 'G'):
            s.add(File(id=fid, user_id=uid, filename=fid, meta={}, created_at=now, updated_at=now))
        await s.commit()
    r1 = await Chats.insert_chat_files('c0', 'm0', ['F'], uid)
    print('insert F for m0       ->', [x.file_id for x in r1] if r1 else r1)
    r2 = await Chats.insert_chat_files('c0', 'm0', ['F'], uid)
    print('insert F again for m0 ->', [x.file_id for x in r2] if r2 else r2, '(dedupe should give None without trying)')
    r3 = await Chats.insert_chat_files('c0', 'm1x', ['F', 'G'], uid)
    print('insert F,G for m1x    ->', [x.file_id for x in r3] if r3 else r3)
    async with dbmod.get_async_db_context() as s:
        from sqlalchemy import select
        from local_llm.models.chats import ChatFile

        rows = (await s.execute(select(ChatFile.file_id, ChatFile.message_id))).all()
    print('chat_file rows        ->', sorted(rows))

    # ---- add_message_files vs chat_message row ----
    await Chats.upsert_message_to_chat_by_id_and_message_id(
        'c1', 'a1', {'role': 'assistant', 'parentId': 'm1', 'content': '', 'done': False}
    )
    out = await Chats.add_message_files_by_id_and_message_id('c1', 'a1', [{'type': 'image', 'url': 'img1'}])
    print('add_message_files ret ->', out)
    print('get_message_metadata  ->', await Chats.get_message_metadata('c1', 'a1', 'files'))
    blob = await Chats.get_chat_by_id('c1')
    print('blob files            ->', blob.chat['history']['messages']['a1'].get('files'))
    mm = await Chats.get_messages_map_by_chat_id('c1')
    print('messages_map a1 files ->', mm['a1'].get('files'))


asyncio.run(main())
