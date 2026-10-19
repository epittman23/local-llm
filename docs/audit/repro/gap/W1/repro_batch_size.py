"""RAG_EMBEDDING_BATCH_SIZE <= 0 is accepted (EmbeddingModelUpdateForm int|None, UI min=-2)
and breaks every embedding call."""
import asyncio, logging
logging.disable(logging.CRITICAL)
from local_llm.retrieval.utils import get_embedding_function
for bs in (0, -1):
    fn = get_embedding_function('openai', 'text-embedding-3-small', None, 'http://127.0.0.1:1', 'k', bs)
    try:
        out = asyncio.run(fn(['chunk one', 'chunk two', 'chunk three']))
        print(f'batch_size={bs}: returned {len(out)} embeddings for 3 texts')
    except Exception as e:
        print(f'batch_size={bs}: raises {type(e).__name__}: {e}')
