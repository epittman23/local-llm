"""The query API's per-request settings are honoured (#354).

`POST /retrieval/query/collection` with `hybrid: false` called
`query_collection`, which read the hybrid search setting again and ran a
hybrid search anyway. And both query routes read `r` and `k_reranker` with
falsy checks, so an explicit 0 was replaced by the configured value.

Run from apps/server:

    python -m pytest tests/test_retrieval_query_overrides.py
"""

import asyncio
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from local_llm.retrieval import utils as retrieval_utils
from local_llm.routers import retrieval as retrieval_router

CONFIG = SimpleNamespace(
    ENABLE_RAG_HYBRID_SEARCH=True,
    TOP_K=3,
    TOP_K_RERANKER=5,
    RELEVANCE_THRESHOLD=0.4,
    HYBRID_BM25_WEIGHT=0.5,
    ENABLE_RAG_HYBRID_SEARCH_ENRICHED_TEXTS=False,
)
REQUEST = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(EMBEDDING_FUNCTION=None, RERANKING_FUNCTION=None)))


@pytest.fixture
def searches(monkeypatch):
    """Records which search each route ran, with its arguments."""
    calls: list[tuple[str, dict]] = []

    async def config():
        return CONFIG

    async def allowed(*_a, **_k):
        return None

    def recorder(name):
        async def search(*_a, **kwargs):
            calls.append((name, kwargs))
            return {}

        return search

    monkeypatch.setattr(retrieval_router, 'get_retrieval_config', config)
    monkeypatch.setattr(retrieval_router, '_validate_collection_access', allowed)
    for name in ('query_collection', 'query_collection_with_hybrid_search', 'query_doc_with_hybrid_search'):
        monkeypatch.setattr(retrieval_router, name, recorder(name))
    return calls


def _collection(**fields):
    form = retrieval_router.QueryCollectionsForm(collection_names=['kb1'], query='q', **fields)
    return asyncio.run(retrieval_router.query_collection_handler(REQUEST, form, user=None))


def _doc(**fields):
    form = retrieval_router.QueryDocForm(collection_name='kb1', query='q', **fields)
    return asyncio.run(retrieval_router.query_doc_handler(REQUEST, form, user=None))


def test_hybrid_false_asks_the_collection_search_for_vector_search_only(searches):
    _collection(hybrid=False)

    [(name, kwargs)] = searches
    assert name == 'query_collection'
    assert kwargs['allow_hybrid'] is False


def test_a_collection_query_passes_an_explicit_r_of_0(searches):
    _collection(r=0, k_reranker=2)

    [(name, kwargs)] = searches
    assert name == 'query_collection_with_hybrid_search'
    assert (kwargs['r'], kwargs['k_reranker']) == (0, 2)


def test_a_doc_query_passes_an_explicit_r_of_0(searches):
    _doc(r=0, k_reranker=2)

    [(name, kwargs)] = searches
    assert name == 'query_doc_with_hybrid_search'
    assert (kwargs['r'], kwargs['k_reranker']) == (0, 2)


@pytest.mark.parametrize('form', [retrieval_router.QueryCollectionsForm, retrieval_router.QueryDocForm])
@pytest.mark.parametrize('field', ['k', 'k_reranker'])
@pytest.mark.parametrize('value', [0, -1])
def test_a_k_or_k_reranker_below_1_is_refused(form, field, value):
    """The reranker keeps its top k_reranker, so 0 returned nothing and -1 dropped the last hit."""
    names = (
        {'collection_names': ['kb1']} if form is retrieval_router.QueryCollectionsForm else {'collection_name': 'kb1'}
    )
    with pytest.raises(ValidationError):
        form(query='q', **names, **{field: value})


def test_unset_values_still_come_from_the_configuration(searches):
    _collection()
    _doc()

    for _name, kwargs in searches:
        assert (kwargs['r'], kwargs['k_reranker']) == (0.4, 5)


@pytest.mark.parametrize(('allow_hybrid', 'hybrid_ran'), [(False, False), (True, True)])
def test_query_collection_runs_hybrid_search_only_when_allowed(monkeypatch, allow_hybrid, hybrid_ran):
    ran: list[bool] = []

    async def settings(*_keys):
        return {'rag.enable_hybrid_search': True}

    async def hybrid(**_kwargs):
        ran.append(True)
        return {'documents': [['hybrid']]}

    monkeypatch.setattr(retrieval_utils.Config, 'get_many', settings)
    monkeypatch.setattr(retrieval_utils, 'query_collection_with_hybrid_search', hybrid)

    # No queries: the vector path answers empty without embedding anything.
    result = asyncio.run(
        retrieval_utils.query_collection(
            REQUEST, collection_names=['kb1'], queries=[], embedding_function=None, k=3, allow_hybrid=allow_hybrid
        )
    )

    assert bool(ran) is hybrid_ran
    assert result == (
        {'documents': [['hybrid']]} if hybrid_ran else {'distances': [[]], 'documents': [[]], 'metadatas': [[]]}
    )
