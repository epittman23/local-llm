"""retrieve_external_knowledge_for_connection: results of every query are concatenated
and then cut to `count`, so with several queries only the first query's hits survive."""
import asyncio, logging
from types import SimpleNamespace
logging.disable(logging.CRITICAL)
import local_llm.retrieval.external as ext
from local_llm.models.knowledge import KnowledgeModel

async def fake_pg(connection, auth, knowledge, query, count, ef):
    # each query returns `count` hits, best first; the second query's hits are better
    base = 0.30 if query == 'q1' else 0.05
    return [{'content': f'{query}-hit{i}', 'metadata': {}, 'distance': base + i * 0.01} for i in range(count)]

ext._retrieve_pgvector = fake_pg
kb = KnowledgeModel(id='kb', user_id='u', name='KB', description='', meta={}, created_at=0, updated_at=0)
req = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(EMBEDDING_FUNCTION=object())))
res = asyncio.run(ext.retrieve_external_knowledge_for_connection(
    req, kb, {'id': 'c', 'provider': 'pgvector'}, ['q1', 'q2'], 3))
print('documents:', res['documents'][0])
print('distances:', res['distances'][0])
