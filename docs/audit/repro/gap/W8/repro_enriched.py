"""W8: enriched-text hybrid search returns the BM25 scoring text as the chunk content."""

import asyncio

import local_llm.retrieval.utils as ru
from local_llm.retrieval.vector.main import GetResult, SearchResult

DOCS = [
    'The quarterly revenue grew by 12 percent driven by subscriptions.',
    'Churn fell to 3 percent after the pricing change.',
    'Headcount stayed flat across all departments.',
]
METAS = [
    {'name': 'q3_report.pdf', 'source': 'q3_report.pdf', 'file_id': 'f1', 'title': 'Q3 Report'},
    {'name': 'q3_report.pdf', 'source': 'q3_report.pdf', 'file_id': 'f1', 'title': 'Q3 Report'},
    {'name': 'q3_report.pdf', 'source': 'q3_report.pdf', 'file_id': 'f1', 'title': 'Q3 Report'},
]


class FakeAsyncVDB:
    async def search(self, collection_name, vectors, filter=None, limit=10):
        return SearchResult(
            ids=[['a', 'b', 'c'][:limit]],
            documents=[DOCS[:limit]],
            metadatas=[[dict(m) for m in METAS[:limit]]],
            distances=[[0.9, 0.8, 0.7][:limit]],
        )


ru.ASYNC_VECTOR_DB_CLIENT = FakeAsyncVDB()


async def embed(q, prefix=None):
    return [[1.0, 0.0]] * len(q) if isinstance(q, list) else [1.0, 0.0]


def rerank(query, documents):
    # Simple, deterministic reranker: prefer documents mentioning "revenue".
    return [1.0 if 'revenue' in d.page_content else 0.5 for d in documents]


async def main():
    collection = GetResult(ids=[['a', 'b', 'c']], documents=[DOCS], metadatas=[METAS])
    for enriched in (False, True):
        res = await ru.query_doc_with_hybrid_search(
            collection_name='kb1',
            collection_result=collection,
            query='revenue growth',
            embedding_function=embed,
            k=3,
            reranking_function=rerank,
            k_reranker=3,
            r=0.0,
            hybrid_bm25_weight=0.5,
            enable_enriched_texts=enriched,
            native_hybrid_search=False,
        )
        print(f'enable_enriched_texts={enriched}')
        for d in res['documents'][0]:
            print('   ', repr(d))


asyncio.run(main())
