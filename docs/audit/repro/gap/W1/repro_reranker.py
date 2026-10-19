"""ExternalReranker: default timeout (RAG_EXTERNAL_RERANKER_TIMEOUT='') means no timeout,
and any failure is swallowed into None, after which RerankCompressor returns the
unreranked candidates without applying top_n or the relevance threshold."""
import asyncio, socket, threading, time, logging
logging.disable(logging.CRITICAL)
from langchain_core.documents import Document
from local_llm.config import RAG_EXTERNAL_RERANKER_TIMEOUT
from local_llm.retrieval.models.external import ExternalReranker
from local_llm.retrieval.utils import RerankCompressor, get_reranking_function

print('configured default timeout string:', repr(RAG_EXTERNAL_RERANKER_TIMEOUT))
timeout_value = int(RAG_EXTERNAL_RERANKER_TIMEOUT) if RAG_EXTERNAL_RERANKER_TIMEOUT else None  # as get_rf does
print('timeout passed to ExternalReranker:', timeout_value)

# 1) a server that accepts and never answers
srv = socket.socket(); srv.bind(('127.0.0.1', 0)); srv.listen(5)
port = srv.getsockname()[1]
rr = ExternalReranker(api_key='k', url=f'http://127.0.0.1:{port}/v1/rerank', model='m', timeout=timeout_value)
out = {}
t = threading.Thread(target=lambda: out.setdefault('r', rr.predict([('q', 'a'), ('q', 'b')])), daemon=True)
t.start(); t.join(5)
print('predict still blocked after 5 s:', t.is_alive())

# 2) a failing reranker -> None -> compressor returns originals
bad = ExternalReranker(api_key='k', url='http://127.0.0.1:1/v1/rerank', model='m', timeout=2)
rf = get_reranking_function('external', 'm', bad)
docs = [Document(page_content=f'doc{i}', metadata={'score': 0.016 - i * 0.001}) for i in range(5)]
comp = RerankCompressor(embedding_function=None, top_n=2, reranking_function=lambda q, d: rf(q, d), r_score=0.5)
res = asyncio.run(comp.acompress_documents(docs, 'q'))
print('top_n=2, r=0.5 -> returned', len(res), 'docs with scores', [d.metadata['score'] for d in res])
