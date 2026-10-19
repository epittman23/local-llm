"""Repro: saving a new prompt version with is_production=False still replaces the live content."""
import asyncio

from local_llm.internal.db import Base, async_engine
from local_llm.models.prompts import Prompts, PromptForm
from local_llm.models.prompt_history import PromptHistories


async def main():
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    p = await Prompts.insert_new_prompt('u1', PromptForm(command='sum', name='Sum', content='V1 content', access_grants=[]))
    v1 = p.version_id
    upd = await Prompts.update_prompt_by_id(
        p.id,
        PromptForm(command='sum', name='Sum', content='V2 draft', access_grants=[], is_production=False, tags=[]),
        'u1',
    )
    print('version_id unchanged (still v1):', upd.version_id == v1)
    entry = await PromptHistories.get_history_entry_by_id(upd.version_id)
    print('production snapshot content:', entry.snapshot['content'])
    live = await Prompts.get_prompt_by_command('sum')
    print('content served for /sum      :', live.content)

    # Snapshot vs saved state for data/meta when the form omits them
    p2 = await Prompts.insert_new_prompt('u1', PromptForm(command='d', name='D', content='c', data={'k': 1}, meta={'m': 1}, access_grants=[]))
    u2 = await Prompts.update_prompt_by_id(p2.id, PromptForm(command='d', name='D', content='c2', access_grants=[], tags=[]), 'u1')
    e2 = await PromptHistories.get_history_entry_by_id(u2.version_id)
    print('saved data/meta:', u2.data, u2.meta, '| snapshot data/meta:', e2.snapshot['data'], e2.snapshot['meta'])
    r = await Prompts.update_prompt_version(p2.id, u2.version_id)
    print('after setting that (current) version as production, data/meta:', r.data, r.meta)

asyncio.run(main())
