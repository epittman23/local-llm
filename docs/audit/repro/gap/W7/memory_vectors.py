"""Memory routes commit the DB change before embedding. When the embedding
call fails (e.g. no embedding model in the HF cache with HF_HUB_OFFLINE=1),
the route errors but the DB change stays, and the vector store is not updated."""
import asyncio
import time
import types

import local_llm.routers.memories as mr
from local_llm.models.memories import Memories, MemoryModel
from local_llm.retrieval.vector.main import SearchResult
from local_llm.utils.memory import _vector_hit_labels

db_rows = {}
vector_store = {}


async def allow(user):
    return None


async def insert_new_memory(user_id, content, memory_type=None, path=None, meta=None, db=None):
    now = int(time.time())
    m = MemoryModel(id=f'm{len(db_rows)+1}', user_id=user_id, type=memory_type or 'context', path=path,
                    content=content, meta=meta, created_at=now, updated_at=now)
    db_rows[m.id] = m
    return m


async def update_memory(id, user_id, content, memory_type=None, path=None, update_path=False, meta=None, db=None):
    m = db_rows[id]
    db_rows[id] = m.model_copy(update={'content': content})
    return db_rows[id]


class FakeVectors:
    async def upsert(self, collection_name, items):
        for item in items:
            vector_store[item['id']] = item


async def broken_embedding(text, prefix=None, user=None):
    raise ValueError('No embedding model is loaded. Set RAG_EMBEDDING_MODEL ...')


async def working_embedding(text, prefix=None, user=None):
    return [0.1, 0.2]


mr.check_memories_permission = allow
Memories.insert_new_memory = insert_new_memory
Memories.update_memory_by_id_and_user_id = update_memory
mr.ASYNC_VECTOR_DB_CLIENT = FakeVectors()
user = types.SimpleNamespace(id='u1', role='user')
state = types.SimpleNamespace(EMBEDDING_FUNCTION=broken_embedding)
request = types.SimpleNamespace(app=types.SimpleNamespace(state=state))


async def main():
    # 1. add while embeddings are broken
    try:
        await mr.add_memory(request, mr.AddMemoryForm(content='I prefer R over Python for stats'), user=user)
    except Exception as e:
        print('add_memory raised:', type(e).__name__)
    print('DB rows after failed add:', {k: v.content for k, v in db_rows.items()})
    print('vector items after failed add:', list(vector_store))

    # 2. a memory indexed while embeddings worked, then edited while they are broken
    state.EMBEDDING_FUNCTION = working_embedding
    m = await mr.add_memory(request, mr.AddMemoryForm(content='My thesis deadline is 2026-11-01'), user=user)
    state.EMBEDDING_FUNCTION = broken_embedding
    try:
        await mr.update_memory_by_id(m.id, request, mr.MemoryUpdateModel(content='My thesis deadline is 2027-02-15'), user=user)
    except Exception as e:
        print('update_memory_by_id raised:', type(e).__name__)
    print('DB content now:', db_rows[m.id].content)
    item = vector_store[m.id]
    hit = SearchResult(ids=[[m.id]], documents=[[item['text']]], metadatas=[[item['metadata']]], distances=[[0.9]])
    print('what chat context injects for a vector hit:', _vector_hit_labels(hit, set()))


asyncio.run(main())


# 3. "Reset memory embeddings" while embeddings are broken
class FakeVectors2(FakeVectors):
    async def delete_collection(self, name):
        vector_store.clear()


async def reset_case():
    mr.ASYNC_VECTOR_DB_CLIENT = FakeVectors2()
    Memories.get_memories_by_user_id = lambda user_id, db=None: asyncio.sleep(0, list(db_rows.values()))
    mr.publish_event = lambda *a, **k: asyncio.sleep(0)
    state.EMBEDDING_FUNCTION = broken_embedding
    print('vector items before reset:', list(vector_store))
    try:
        await mr.reset_memory_from_vector_db(request, user=user)
    except Exception as e:
        print('reset raised:', type(e).__name__)
    print('vector items after failed reset:', list(vector_store))


asyncio.run(reset_case())
