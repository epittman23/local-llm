"""External knowledge retrieval across several queries (#349).

Every query's hits were appended to one list, which was then cut to
`count`, so the first query filled the budget and the other queries never
contributed. The queries now take turns, best hit first, with a chunk that
several queries return kept once.

Run from apps/server:

    python -m pytest tests/test_external_retrieval.py
"""

import asyncio
from types import SimpleNamespace

import pytest

from local_llm.retrieval import external

REQUEST = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(EMBEDDING_FUNCTION=object())))
KNOWLEDGE = SimpleNamespace(id='kb', name='KB', meta={})


def _chunk(content: str, score: float, document_id: str | None = None) -> dict:
    return {'content': content, 'metadata': {'document_id': document_id}, 'distance': score}


def _retrieve(monkeypatch, hits_by_query: dict[str, list[dict]], count: int) -> dict:
    async def fake_provider(connection, auth_config, knowledge, query, count, embedding_function):
        return hits_by_query[query][:count]

    monkeypatch.setattr(external, '_retrieve_qdrant', fake_provider)
    return asyncio.run(
        external.retrieve_external_knowledge_for_connection(
            REQUEST, KNOWLEDGE, {'id': 'c', 'provider': 'qdrant'}, list(hits_by_query), count
        )
    )


def test_every_query_contributes(monkeypatch):
    result = _retrieve(
        monkeypatch,
        {
            'q1': [_chunk('q1-hit0', 0.5), _chunk('q1-hit1', 0.4), _chunk('q1-hit2', 0.3)],
            'q2': [_chunk('q2-hit0', 0.9), _chunk('q2-hit1', 0.8), _chunk('q2-hit2', 0.7)],
        },
        count=3,
    )

    assert result['documents'] == [['q1-hit0', 'q2-hit0', 'q1-hit1']]
    assert result['distances'] == [[0.5, 0.9, 0.4]]


def test_a_chunk_several_queries_return_is_kept_once(monkeypatch):
    shared = _chunk('shared', 0.9, document_id='d1')
    result = _retrieve(
        monkeypatch,
        {
            'q1': [shared, _chunk('q1-only', 0.5, document_id='d2')],
            'q2': [dict(shared, distance=0.8), _chunk('q2-only', 0.4, document_id='d3')],
        },
        count=5,
    )

    assert result['documents'] == [['shared', 'q1-only', 'q2-only']]
    # The first occurrence, from the query that ranked it highest, is the one kept.
    assert result['distances'] == [[0.9, 0.5, 0.4]]


def test_chunks_sharing_a_document_id_are_not_merged(monkeypatch):
    result = _retrieve(
        monkeypatch,
        {'q1': [_chunk('part one', 0.9, document_id='doc'), _chunk('part two', 0.8, document_id='doc')]},
        count=5,
    )

    assert result['documents'] == [['part one', 'part two']]


def test_one_query_keeps_the_provider_order(monkeypatch):
    hits = [_chunk('a', 0.1), _chunk('b', 0.7), _chunk('c', 0.3)]
    result = _retrieve(monkeypatch, {'q1': hits}, count=2)

    assert result['documents'] == [['a', 'b']]
    assert result['distances'] == [[0.1, 0.7]]


# The pgvector provider (#350): the query embedding went to psycopg as a
# Python list, which psycopg sends as double precision[] (oid 1022), and
# `vector <=> double precision[]` has no operator. The provider also reported
# the raw cosine distance, where a lower number is better, while the chat
# shows the value as relevance and the other providers report a similarity.


def _retrieve_pgvector(monkeypatch, rows: list[dict]):
    import pgvector.psycopg
    import psycopg

    executed = []

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, query, params):
            executed.append(params)

        def fetchall(self):
            return rows

    class Connection(Cursor):
        def cursor(self):
            return Cursor()

    async def embed(query, prefix=None):
        return [0.25, 0.5, 1.0]

    monkeypatch.setattr(psycopg, 'connect', lambda *a, **k: Connection())
    monkeypatch.setattr(pgvector.psycopg, 'register_vector', lambda conn: None)
    knowledge = SimpleNamespace(id='kb', name='KB', meta={'external': {'source': {'name': 'docs'}}})
    hits = asyncio.run(
        external._retrieve_pgvector({'endpoint': 'postgresql://example.invalid/db'}, {}, knowledge, 'q', 3, embed)
    )
    return hits, executed


def test_pgvector_sends_the_embedding_as_a_vector(monkeypatch):
    import psycopg
    from pgvector import Vector
    from pgvector.psycopg.vector import register_vector_info
    from psycopg.adapt import AdaptersMap, PyFormat, Transformer
    from psycopg.types import TypeInfo

    _, executed = _retrieve_pgvector(monkeypatch, [])

    (embedding, collection, count) = executed[0]
    assert isinstance(embedding, Vector)
    assert embedding.to_list() == [0.25, 0.5, 1.0]
    assert (collection, count) == ('docs', 3)

    # What register_vector sets up on a real connection, with a made-up oid
    # for the vector type: the value is dumped as that type, not float8[].
    adapters = AdaptersMap(psycopg.adapters)
    register_vector_info(adapters, TypeInfo('vector', 99999, 99998))
    assert Transformer(adapters).get_dumper(embedding, PyFormat.AUTO).oid == 99999


def test_pgvector_reports_similarity_best_first(monkeypatch):
    hits, _ = _retrieve_pgvector(
        monkeypatch,
        [
            {'id': 'a', 'content': 'closest', 'metadata': {}, 'distance': 0.1},
            {'id': 'b', 'content': 'further', 'metadata': {}, 'distance': 0.4},
            {'id': 'c', 'content': 'no vector', 'metadata': {}, 'distance': None},
        ],
    )

    assert [hit['content'] for hit in hits] == ['closest', 'further', 'no vector']
    assert [hit['distance'] for hit in hits][:2] == pytest.approx([0.9, 0.6])
    assert hits[2]['distance'] is None
