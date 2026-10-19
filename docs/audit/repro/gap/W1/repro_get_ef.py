"""get_ef swallows a model-load failure and returns None, so update_embedding_config
proceeds to save the bad model and return status True."""
import asyncio, logging
logging.basicConfig(level=logging.ERROR)
from local_llm.routers.retrieval import get_ef
from local_llm.retrieval.utils import get_embedding_function

ef = get_ef('', 'sentence-transformers/this-model-does-not-exist-xyz')
print('get_ef returned:', ef)
fn = get_embedding_function('', 'sentence-transformers/this-model-does-not-exist-xyz', ef, '', '', 1)
print('get_embedding_function returned callable:', callable(fn))
try:
    asyncio.run(fn(['hello'], prefix=None))
except Exception as e:
    print('first embedding call raises:', type(e).__name__, str(e)[:90])
