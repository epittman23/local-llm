"""B7 repro 4: middleware's delta-image path (add_message_files + 'files' event) through the real socket event emitter."""

import asyncio
import importlib
import pkgutil

import local_llm.models as _m

for _x in pkgutil.iter_modules(_m.__path__):
    importlib.import_module(f'local_llm.models.{_x.name}')

from local_llm.internal import db as dbmod
from local_llm.models.chats import ChatForm, Chats
from local_llm.socket.main import get_event_emitter


async def main():
    async with dbmod.async_engine.begin() as conn:
        await conn.run_sync(dbmod.Base.metadata.create_all)
    uid = 'u1'
    await Chats.insert_new_chat(
        'c1',
        uid,
        ChatForm(
            chat={
                'title': 't',
                'history': {
                    'currentId': 'm1',
                    'messages': {'m1': {'id': 'm1', 'role': 'user', 'content': 'draw', 'parentId': None, 'childrenIds': []}},
                },
            }
        ),
    )
    # Assistant placeholder, written as main.py does (dual-written)
    await Chats.upsert_message_to_chat_by_id_and_message_id(
        'c1', 'a1', {'role': 'assistant', 'parentId': 'm1', 'content': '', 'done': False}
    )
    emitter = await get_event_emitter({'user_id': uid, 'chat_id': 'c1', 'message_id': 'a1', 'session_id': None})

    for n in (1, 2):
        # middleware.py _handle_delta_images: persist, then emit the returned list as a 'files' event
        image_file_list = [{'type': 'image', 'url': f'img{n}'}]
        message_files = await Chats.add_message_files_by_id_and_message_id('c1', 'a1', image_file_list)
        await emitter({'type': 'files', 'data': {'files': message_files}})
        chat = await Chats.get_chat_by_id('c1')
        print(f'after image {n}: blob files =', [f['url'] for f in chat.chat['history']['messages']['a1']['files']])


asyncio.run(main())
