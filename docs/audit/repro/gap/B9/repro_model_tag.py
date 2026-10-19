"""Repro: filtering workspace models by a tag also returns models that merely have that word as a meta key/value."""
import asyncio

from local_llm.internal.db import Base, async_engine
from local_llm.models.models import ModelForm, ModelMeta, ModelParams, Models


async def main():
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    tagged = ModelForm(id='m-tagged', base_model_id='qwen', name='Tagged',
                       meta=ModelMeta(tags=[{'name': 'vision'}], capabilities={'vision': True}), params=ModelParams())
    untagged = ModelForm(id='m-untagged', base_model_id='qwen', name='Untagged',
                         meta=ModelMeta(tags=[], capabilities={'vision': False}), params=ModelParams())
    await Models.insert_new_model(tagged, 'u1')
    await Models.insert_new_model(untagged, 'u1')
    res = await Models.search_models('u1', filter={'user_id': 'u1', 'tag': 'vision'})
    print('tag=vision ->', [m.id for m in res.items], 'tags:', {m.id: m.meta.model_dump().get('tags') for m in res.items})

asyncio.run(main())
