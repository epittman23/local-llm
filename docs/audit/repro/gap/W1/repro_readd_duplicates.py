"""save_docs_to_vector_db's hash check lets the same file_id through ("re-add/reindex"),
and with add=True (process_file's knowledge path) it inserts the chunks again.
/knowledge/{id}/file/add has no has_file guard, so adding a file twice doubles its chunks."""
import asyncio, threading, logging
from types import SimpleNamespace
import numpy as np
logging.disable(logging.CRITICAL)
from langchain_core.documents import Document
import local_llm.routers.retrieval as r
from local_llm.retrieval.vector.main import GetResult

class FakeVDB:
    def __init__(self): self.rows = []
    def has_collection(self, collection_name): return any(x['c'] == collection_name for x in self.rows)
    def delete_collection(self, collection_name): self.rows = [x for x in self.rows if x['c'] != collection_name]
    def query(self, collection_name, filter, limit=None):
        hits = [x for x in self.rows if x['c'] == collection_name and all(str(x['m'].get(k)) == str(v) for k, v in filter.items())]
        return GetResult(ids=[[h['id'] for h in hits]], documents=[[h['t'] for h in hits]], metadatas=[[h['m'] for h in hits]]) if hits else None
    def insert(self, collection_name, items):
        self.rows += [{'c': collection_name, 'id': i['id'], 't': i['text'], 'm': i['metadata']} for i in items]

class FakeEF:
    def encode(self, q, batch_size=1, **kw): return np.zeros((len(q), 4))

vdb = FakeVDB(); r.VECTOR_DB_CLIENT = vdb
loop = asyncio.new_event_loop(); threading.Thread(target=loop.run_forever, daemon=True).start()
req = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(ef=FakeEF(), main_loop=loop)))
cfg = SimpleNamespace(ENABLE_MARKDOWN_HEADER_TEXT_SPLITTER=False, TEXT_SPLITTER='', CHUNK_SIZE=50, CHUNK_OVERLAP=0,
                      CHUNK_MIN_SIZE_TARGET=0, RAG_EMBEDDING_ENGINE='', RAG_EMBEDDING_MODEL='m',
                      RAG_EMBEDDING_BATCH_SIZE=8, ENABLE_ASYNC_EMBEDDING=True, RAG_EMBEDDING_CONCURRENT_REQUESTS=0,
                      RAG_OPENAI_API_BASE_URL='', RAG_OPENAI_API_KEY='', RAG_OLLAMA_BASE_URL='', RAG_OLLAMA_API_KEY='',
                      RAG_AZURE_OPENAI_BASE_URL='', RAG_AZURE_OPENAI_API_KEY='', RAG_AZURE_OPENAI_API_VERSION='')
text = ' '.join(f'word{i}' for i in range(40))
docs = [Document(page_content=text, metadata={'file_id': 'f1', 'source': 'a.txt'})]
meta = {'file_id': 'f1', 'name': 'a.txt', 'hash': 'H'}
for attempt in (1, 2):
    r.save_docs_to_vector_db(req, docs, 'kb1', cfg, metadata=meta, add=True)
    print(f'after add #{attempt}: kb1 rows =', sum(x['c'] == 'kb1' for x in vdb.rows))
try:
    r.save_docs_to_vector_db(req, docs, 'kb1', cfg, metadata={**meta, 'file_id': 'f2'}, add=True)
except ValueError as e:
    print('different file, same content ->', e)
