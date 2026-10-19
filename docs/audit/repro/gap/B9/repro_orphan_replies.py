"""Repro: deleting a thread's parent message (what the delete route calls) leaves its replies and their reactions."""
import asyncio

from local_llm.internal.db import Base, async_engine
import local_llm.models.files  # noqa: F401  (FK target for channel_file)
from local_llm.models.messages import MessageForm, MessageReaction, Messages
from sqlalchemy import select, func
from local_llm.internal.db import AsyncSessionLocal


async def main():
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    parent = await Messages.insert_new_message(MessageForm(content='parent'), 'c1', 'u1')
    reply = await Messages.insert_new_message(MessageForm(content='secret reply in thread', parent_id=parent.id), 'c1', 'u2')
    await Messages.add_reaction_to_message(reply.id, 'u1', 'thumbsup')
    await Messages.update_is_pinned_by_id(reply.id, True, 'u1')
    await Messages.delete_message_by_id(parent.id)  # routers/channels.py:1771 -- the only delete the route performs
    print('parent exists:', await Messages.get_message_by_id(parent.id) is not None)
    print('reply still stored:', (await Messages.get_message_by_id(reply.id, include_thread_replies=False)) is not None)
    print('channel list:', [m.content for m in await Messages.get_messages_by_channel_id('c1')])
    print('pinned list:', [m.content for m in await Messages.get_pinned_messages_by_channel_id('c1')])
    print('search tool backend:', [m.content for m in await Messages.search_messages_by_channel_ids(['c1'], 'secret')])
    async with AsyncSessionLocal() as s:
        print('reactions left on reply:', (await s.execute(select(func.count()).select_from(MessageReaction).filter_by(message_id=reply.id))).scalar())

asyncio.run(main())
