"""With enriched texts on, hybrid search returns each chunk's stored text (#357).

BM25 scores enriched texts: the chunk with its filename, title, headings and
source appended. The ensemble kept BM25's copy of each chunk, so the
reranker, the model and the citations received the enrichment
("... Filename: q3_report.pdf q3 report pdf ..."). Only the scoring sees it now.

Run from apps/server:

    python -m pytest tests/test_enriched_texts_content.py
"""

import asyncio
from types import SimpleNamespace

import pytest

from local_llm.retrieval import utils as retrieval_utils
from local_llm.retrieval.vector.main import GetResult

TEXTS = ['Revenue grew in the third quarter.', 'Costs fell in the second quarter.']
COLLECTION = GetResult(
    ids=[['c1', 'c2']],
    documents=[TEXTS],
    metadatas=[
        [{'name': 'q3_report.pdf', 'source': 'q3_report.pdf'}, {'name': 'q2_costs.pdf', 'source': 'q2_costs.pdf'}]
    ],
)


@pytest.fixture
def no_vector_hits(monkeypatch):
    async def search(**_kwargs):
        return None

    monkeypatch.setattr(retrieval_utils.ASYNC_VECTOR_DB_CLIENT, 'search', search, raising=False)


def _search(query, enriched):
    reranked: list[list[str]] = []

    def rerank(_query, documents):
        reranked.append([d.page_content for d in documents])
        return [1.0 for _ in documents]

    async def embed(*_a, **_k):
        return [1.0, 0.0]

    result = asyncio.run(
        retrieval_utils.query_doc_with_hybrid_search(
            collection_name='kb1',
            collection_result=COLLECTION,
            query=query,
            embedding_function=embed,
            k=2,
            reranking_function=rerank,
            k_reranker=2,
            r=0.0,
            hybrid_bm25_weight=1.0,
            enable_enriched_texts=enriched,
            native_hybrid_search=False,
        )
    )
    return result, reranked


@pytest.mark.parametrize('enriched', [True, False])
def test_the_reranker_and_the_result_see_the_stored_text(no_vector_hits, enriched):
    # "q3" and "report" are only in the filename, so only enrichment finds the chunk.
    result, reranked = _search('q3 report revenue', enriched)

    assert result['documents'][0]
    assert set(result['documents'][0]) <= set(TEXTS)
    assert all(text in TEXTS for batch in reranked for text in batch)
    assert not any('Filename:' in text for text in result['documents'][0])


def test_the_enrichment_still_drives_the_scoring(no_vector_hits):
    # Only the filename matches: found with enrichment, by the stored text.
    result, _ = _search('q2_costs', enriched=True)

    assert result['documents'][0][0] == TEXTS[1]


def test_a_document_from_elsewhere_keeps_its_content():
    inner = SimpleNamespace(invoke=lambda q: [retrieval_utils.Document(page_content='other', metadata={})])
    wrapped = retrieval_utils._StoredTextRetriever(retriever=inner, texts_by_hash={})

    assert [d.page_content for d in wrapped.invoke('q')] == ['other']
