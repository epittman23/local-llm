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

from local_llm.retrieval import utils as retrieval_utils
from local_llm.retrieval.vector.main import GetResult, SearchResult

# Three chunks: BM25 gives a term found in one chunk of three a positive weight
# (with two, every such term weighs 0). "q2" is only in the second's filename.
TEXTS = ['Revenue grew in the third quarter.', 'Costs fell in the second quarter.', 'Headcount was flat.']
METADATAS = [
    {'name': 'q3_report.pdf', 'source': 'q3_report.pdf'},
    {'name': 'q2_costs.pdf', 'source': 'q2_costs.pdf'},
    {'name': 'hr.pdf', 'source': 'hr.pdf'},
]
COLLECTION = GetResult(ids=[['c1', 'c2', 'c3']], documents=[TEXTS], metadatas=[METADATAS])


def _search(monkeypatch, query, enriched, weight=1.0, vector_hits=()):
    reranked: list[list[str]] = []

    async def search(**_kwargs):
        hits = list(vector_hits)
        return SearchResult(
            ids=[[f'c{i + 1}' for i in hits]],
            documents=[[TEXTS[i] for i in hits]],
            metadatas=[[METADATAS[i] for i in hits]],
            distances=[[0.9 for _ in hits]],
        )

    def rerank(_query, documents):
        reranked.append([d.page_content for d in documents])
        # Keeps the ensemble's order.
        return [1.0 - n / 10 for n in range(len(documents))]

    async def embed(*_a, **_k):
        return [1.0, 0.0]

    monkeypatch.setattr(retrieval_utils.ASYNC_VECTOR_DB_CLIENT, 'search', search, raising=False)
    result = asyncio.run(
        retrieval_utils.query_doc_with_hybrid_search(
            collection_name='kb1',
            collection_result=COLLECTION,
            query=query,
            embedding_function=embed,
            k=3,
            reranking_function=rerank,
            k_reranker=3,
            r=0.0,
            hybrid_bm25_weight=weight,
            enable_enriched_texts=enriched,
            native_hybrid_search=False,
        )
    )
    return result, reranked


def test_the_reranker_and_the_result_see_the_stored_text(monkeypatch):
    result, reranked = _search(monkeypatch, 'q2 costs', enriched=True)

    assert result['documents'][0]
    assert set(result['documents'][0]) <= set(TEXTS)
    assert all(text in TEXTS for batch in reranked for text in batch)


def test_the_enrichment_still_drives_the_scoring(monkeypatch):
    # "q2" is only in a filename: enrichment ranks that chunk first, by its stored text.
    with_enrichment, _ = _search(monkeypatch, 'q2', enriched=True)
    without, _ = _search(monkeypatch, 'q2', enriched=False)

    assert with_enrichment['documents'][0][0] == TEXTS[1]
    assert without['documents'][0][0] != TEXTS[1]


def test_at_a_mixed_weight_a_chunk_both_sides_found_keeps_its_stored_text_and_metadata(monkeypatch):
    result, _ = _search(monkeypatch, 'q2', enriched=True, weight=0.5, vector_hits=(1, 0))

    assert set(result['documents'][0]) <= set(TEXTS)
    found = dict(zip(result['documents'][0], result['metadatas'][0], strict=True))
    assert found[TEXTS[1]]['name'] == 'q2_costs.pdf'
    assert not any('Filename:' in text for text in result['documents'][0])


def test_with_enrichment_off_the_results_are_the_stored_texts(monkeypatch):
    result, _ = _search(monkeypatch, 'costs', enriched=False)

    assert set(result['documents'][0]) <= set(TEXTS)


def test_a_document_from_elsewhere_keeps_its_content():
    inner = SimpleNamespace(invoke=lambda q: [retrieval_utils.Document(page_content='other', metadata={})])
    wrapped = retrieval_utils._StoredTextRetriever(retriever=inner, texts_by_hash={})

    assert [d.page_content for d in wrapped.invoke('q')] == ['other']
