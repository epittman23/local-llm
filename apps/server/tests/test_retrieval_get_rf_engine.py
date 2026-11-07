"""The reranking engine decides the reranker before the model name does (#678).

get_rf picked the local ColBERT reranker for any model name containing
jinaai/jina-colbert-v2, even with the engine set to external. Its predict()
takes no user argument, so every rerank through get_reranking_function then
raised TypeError. The name check now applies to the local engine only.
"""

import sys
from types import ModuleType

from local_llm.retrieval.models.external import ExternalReranker
from local_llm.routers import retrieval

COLBERT_MODEL = 'jinaai/jina-colbert-v2'


def _fake_colbert(monkeypatch):
    """Stand in for the ColBERT module, so no model loads; returns the classes it was built as."""
    built = []

    class FakeColBERT:
        def __init__(self, *args, **kwargs):
            built.append(self)

    module = ModuleType('local_llm.retrieval.models.colbert')
    module.ColBERT = FakeColBERT
    monkeypatch.setitem(sys.modules, 'local_llm.retrieval.models.colbert', module)
    monkeypatch.setattr(retrieval, 'get_model_path', lambda name, auto_update: name)
    return built


def test_a_colbert_model_name_with_the_external_engine_builds_the_external_reranker(monkeypatch):
    built = _fake_colbert(monkeypatch)

    rf = retrieval.get_rf(
        engine='external',
        reranking_model=COLBERT_MODEL,
        external_reranker_url='http://reranker.example/rerank',
        external_reranker_api_key='key',
    )

    assert isinstance(rf, ExternalReranker)
    assert built == []


def test_a_colbert_model_name_with_the_local_engine_still_builds_colbert(monkeypatch):
    built = _fake_colbert(monkeypatch)

    rf = retrieval.get_rf(engine='', reranking_model=COLBERT_MODEL)

    assert built == [rf]
