import asyncio
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from local_llm.models.tags import Tag, Tags

async def main():
    eng = create_async_engine('sqlite+aiosqlite:///' + __import__('tempfile').mkdtemp() + '/repro.db')
    async with eng.begin() as c:
        await c.run_sync(Tag.__table__.create)
    S = async_sessionmaker(eng, expire_on_commit=False)
    for names in (['Python', 'python'], ['Data Analysis', 'data_analysis'], ['Math', 'Math']):
        async with S() as s:
            try:
                await Tags.ensure_tags_exist(names, 'u1', db=s)
                print(names, '-> ok', [t.id for t in await Tags.get_tags_by_user_id('u1', db=s)])
            except Exception as e:
                print(names, '->', type(e).__name__, str(e).splitlines()[0][:160])
asyncio.run(main())
