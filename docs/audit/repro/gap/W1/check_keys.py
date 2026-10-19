import logging; logging.disable(logging.CRITICAL)
from local_llm.models.config import Config
from local_llm.routers.retrieval import RETRIEVAL_CONFIG_KEYS
missing = [k for k, v in RETRIEVAL_CONFIG_KEYS.items() if v not in Config.DEFAULTS]
print('retrieval keys without a default:', missing)
for k in ['rag.top_k','rag.relevance_threshold','rag.hybrid_bm25_weight','rag.external_reranker_timeout','rag.chunk_min_size_target','rag.file.max_size','web.loader.firecrawl_timeout','web.loader.timeout']:
    print(k, repr(Config.DEFAULTS.get(k)))
