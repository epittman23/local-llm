# The batch path used by the update_memory tool and background review:
# routers/memories.py:243 validate_memory_operations -> models/memories.py apply_memory_operations
import asyncio, tempfile
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from local_llm.models.memories import Memory, Memories
from local_llm.utils.memory import validate_memory_operations
from local_llm.routers.memories import UpdateMemoriesForm

async def main():
    eng = create_async_engine('sqlite+aiosqlite:///' + tempfile.mkdtemp() + '/repro.db')
    async with eng.begin() as c:
        await c.run_sync(Memory.__table__.create)
    S = async_sessionmaker(eng, expire_on_commit=False)
    async with S() as s:
        m = await Memories.insert_new_memory('u1', 'Prefers R over Python', 'user', path='preferences/languages', db=s)
        print('before:', m.path, '|', m.content)
        ops = validate_memory_operations(UpdateMemoriesForm(operations=[{'action': 'replace', 'id': m.id, 'content': 'Prefers R and Julia over Python'}]))
        print('validated op:', ops[0])
        res = await Memories.apply_memory_operations('u1', ops, db=s)
        print('after: ', res[0]['memory'].path, '|', res[0]['memory'].content)
asyncio.run(main())
