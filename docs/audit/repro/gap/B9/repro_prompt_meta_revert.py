"""Repro: switching production versions reverts name/tags edited through the no-history /update/meta path."""
import asyncio

from local_llm.internal.db import Base, async_engine
from local_llm.models.prompts import Prompts, PromptForm


async def main():
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    p = await Prompts.insert_new_prompt('u1', PromptForm(command='sum', name='Old name', content='v1', tags=['a'], access_grants=[]))
    v1 = p.version_id
    p2 = await Prompts.update_prompt_by_id(p.id, PromptForm(command='sum', name='Old name', content='v2', tags=['a'], access_grants=[]), 'u1')
    v2 = p2.version_id
    # Edit page auto-saves name/command/tags via /update/meta (no history entry).
    m = await Prompts.update_prompt_metadata(p.id, 'New name', 'summarize', ['b'])
    print('after metadata save   :', m.name, m.command, m.tags)
    await Prompts.update_prompt_version(p.id, v1)   # "Set as Production" on v1
    r = await Prompts.update_prompt_version(p.id, v2)  # ...and back to v2
    print('after v1 then v2 live :', r.name, r.command, r.tags, '| content', r.content)

asyncio.run(main())
