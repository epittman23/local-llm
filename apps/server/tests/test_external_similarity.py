"""External knowledge hits are reported as a similarity, higher is better, whatever the collection's metric (#503).

Qdrant and Milvus report what their collection's metric gives: a similarity
for cosine and inner product, but a distance (lower is better) for Euclid,
Manhattan or L2. That number went to the model and the chat as `distance`,
the field every other source fills with a similarity, so the closest hit of
such a collection looked the least relevant. A distance is now turned into
1 / (1 + distance), as pgvector's is into one already (#350).

Run from apps/server:

    python -m pytest tests/test_external_similarity.py
"""

from __future__ import annotations

import asyncio
import sys
from types import ModuleType, SimpleNamespace

import pytest

from local_llm.retrieval import external

KNOWLEDGE = SimpleNamespace(id='kb', name='KB', meta={'external': {'source': {'name': 'docs'}}})


async def _embed(query, prefix=None):
    return [0.1, 0.2]


def _point(index: int, score: float):
    return SimpleNamespace(
        score=score, model_dump=lambda: {'id': f'p{index}', 'score': score, 'payload': {'text': f'hit {index}'}}
    )


def _qdrant(monkeypatch, distance, scores, named=False, broken=False):
    class QdrantClient:
        def __init__(self, **_kwargs):
            pass

        def get_collection(self, collection_name):
            assert collection_name == 'docs'
            if broken:
                raise RuntimeError('no access to the collection info')
            params = SimpleNamespace(distance=SimpleNamespace(value=distance))
            vectors = {'dense': params} if named else params
            return SimpleNamespace(config=SimpleNamespace(params=SimpleNamespace(vectors=vectors)))

        def query_points(self, **_kwargs):
            return SimpleNamespace(points=[_point(i, s) for i, s in enumerate(scores)])

    module = ModuleType('qdrant_client')
    module.QdrantClient = QdrantClient
    monkeypatch.setitem(sys.modules, 'qdrant_client', module)
    knowledge = KNOWLEDGE
    if named:
        knowledge = SimpleNamespace(
            id='kb', name='KB', meta={'external': {'source': {'name': 'docs', 'config': {'vector_field': 'dense'}}}}
        )
    hits = asyncio.run(external._retrieve_qdrant({'endpoint': 'http://q.invalid'}, {}, knowledge, 'q', 3, _embed))
    return [hit['distance'] for hit in hits]


def _milvus(monkeypatch, metric, distances, broken=False):
    timeouts = []

    class MilvusClient:
        def __init__(self, **_kwargs):
            pass

        def list_indexes(self, collection_name, field_name='', timeout=None):
            timeouts.append(timeout)
            return ['vector_index'] if (collection_name, field_name) == ('docs', 'vector') else []

        def describe_index(self, collection_name, index_name, timeout=None):
            timeouts.append(timeout)
            if broken:
                raise RuntimeError('no index')
            return {'field_name': 'vector', **({'metric_type': metric} if metric else {})}

        def search(self, timeout=None, **_kwargs):
            timeouts.append(timeout)
            return [
                [{'id': i, 'distance': d, 'entity': {'data': {'text': f'hit {i}'}}} for i, d in enumerate(distances)]
            ]

    module = ModuleType('pymilvus')
    module.MilvusClient = MilvusClient
    monkeypatch.setitem(sys.modules, 'pymilvus', module)
    hits = asyncio.run(
        external._retrieve_milvus(
            {'endpoint': 'http://m.invalid', 'config': {'timeout': 7}}, {}, KNOWLEDGE, 'q', 3, _embed
        )
    )
    assert timeouts and set(timeouts) == {7}  # every call is bounded
    return [hit['distance'] for hit in hits]


@pytest.mark.parametrize('metric', ['Euclid', 'Manhattan'])
def test_a_qdrant_distance_metric_is_reported_as_a_similarity(monkeypatch, metric):
    assert _qdrant(monkeypatch, metric, [0.0, 1.0, 3.0]) == pytest.approx([1.0, 0.5, 0.25])


@pytest.mark.parametrize('metric', ['Cosine', 'Dot'])
def test_a_qdrant_similarity_metric_is_reported_as_it_is(monkeypatch, metric):
    assert _qdrant(monkeypatch, metric, [0.9, 0.5]) == pytest.approx([0.9, 0.5])


def test_a_qdrant_named_vector_uses_its_own_metric(monkeypatch):
    assert _qdrant(monkeypatch, 'Euclid', [1.0], named=True) == pytest.approx([0.5])


def test_a_qdrant_collection_whose_metric_cannot_be_read_reports_scores_as_they_are(monkeypatch):
    assert _qdrant(monkeypatch, 'Euclid', [1.0], broken=True) == pytest.approx([1.0])


def test_a_milvus_l2_distance_is_reported_as_a_similarity(monkeypatch):
    assert _milvus(monkeypatch, 'L2', [0.0, 1.0, 3.0]) == pytest.approx([1.0, 0.5, 0.25])


@pytest.mark.parametrize('metric', ['COSINE', 'IP'])
def test_a_milvus_similarity_is_reported_as_it_is(monkeypatch, metric):
    assert _milvus(monkeypatch, metric, [0.9, 0.5]) == pytest.approx([0.9, 0.5])


def test_a_milvus_index_that_cannot_be_read_reports_distances_as_they_are(monkeypatch):
    assert _milvus(monkeypatch, 'L2', [2.0], broken=True) == pytest.approx([2.0])


def test_a_milvus_index_without_a_metric_reports_distances_as_they_are(monkeypatch):
    assert _milvus(monkeypatch, None, [2.0]) == pytest.approx([2.0])
