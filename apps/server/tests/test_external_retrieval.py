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


def _chunk(content: object, score: float, document_id: object = None) -> dict:
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


def test_queries_with_fewer_hits_drop_out_of_the_turns(monkeypatch):
    result = _retrieve(
        monkeypatch,
        {
            'q1': [_chunk('q1-hit0', 0.5)],
            'q2': [_chunk('q2-hit0', 0.9), _chunk('q2-hit1', 0.8), _chunk('q2-hit2', 0.7)],
        },
        count=3,
    )

    assert result['documents'] == [['q1-hit0', 'q2-hit0', 'q2-hit1']]


def test_content_and_ids_mapped_to_json_values_still_merge(monkeypatch):
    """An admin may map content or document_id to a jsonb/array column or an
    object node; such a value is not hashable and must not lose the results."""
    record = {'title': 'T', 'body': ['a', 'b']}
    result = _retrieve(
        monkeypatch,
        {
            'q1': [_chunk(record, 0.9, document_id={'k': 1}), _chunk(['x', 'y'], 0.5)],
            'q2': [_chunk(dict(reversed(record.items())), 0.8, document_id={'k': 1})],
        },
        count=5,
    )

    assert result['documents'] == [[record, ['x', 'y']]]


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


def _retrieve_pgvector(
    monkeypatch,
    rows: list[dict],
    connection=None,
    fetch=None,
    connected: list | None = None,
    statements: list | None = None,
):
    import pgvector.psycopg
    import psycopg

    executed = []
    connected = [] if connected is None else connected
    recorded: list = [] if statements is None else statements

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, query, params):
            executed.append(params)
            recorded.append((str(query), params))

        def fetchall(self):
            if fetch:
                fetch()
            return rows

    class Connection(Cursor):
        def cursor(self):
            return Cursor()

    async def embed(query, prefix=None):
        return [0.25, 0.5, 1.0]

    def connect(*args, **kwargs):
        connected.append((args, kwargs))
        return Connection()

    monkeypatch.setattr(psycopg, 'connect', connect)
    monkeypatch.setattr(pgvector.psycopg, 'register_vector', lambda conn: None)
    knowledge = SimpleNamespace(id='kb', name='KB', meta={'external': {'source': {'name': 'docs'}}})
    connection = connection or {'endpoint': 'postgresql://example.invalid/db'}
    hits = asyncio.run(external._retrieve_pgvector(connection, {}, knowledge, 'q', 3, embed))
    return hits, executed


def test_pgvector_sends_the_embedding_as_a_vector(monkeypatch):
    import psycopg
    from pgvector import Vector
    from pgvector.psycopg.vector import register_vector_info
    from psycopg.adapt import AdaptersMap, PyFormat, Transformer
    from psycopg.types import TypeInfo

    _, executed = _retrieve_pgvector(monkeypatch, [])

    # The search is the last statement: the statement timeout is set before it (#514).
    (embedding, collection, count) = executed[-1]
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


# A query with no time limit (#514): pgvector had a connect timeout only, so a
# server that took the connection and then never answered stalled the turn.


def _pgvector_timeouts(monkeypatch, connection: dict):
    """What the provider connects with, as one dict, and the statements it runs."""
    from psycopg.conninfo import conninfo_to_dict

    connected, statements = [], []
    _retrieve_pgvector(monkeypatch, [], connection=connection, connected=connected, statements=statements)
    (((conninfo,), kwargs),) = connected
    return {**conninfo_to_dict(conninfo), **kwargs}, statements


def test_pgvector_bounds_the_search_on_the_server_for_its_own_transaction(monkeypatch):
    kwargs, statements = _pgvector_timeouts(
        monkeypatch, {'endpoint': 'postgresql://example.invalid/db', 'config': {'timeout': 7}}
    )

    # SET LOCAL, as set_config(..., true) is: no startup parameter, which a
    # pooler such as PgBouncer refuses by default, and nothing left on a pooled
    # session after the transaction.
    (first, params), (search, _) = statements
    assert "set_config('statement_timeout', %s, true)" in first
    assert params == ('7000ms',)
    assert 'ORDER BY distance' in search
    assert kwargs['connect_timeout'] == 7
    assert 'statement_timeout' not in kwargs.get('options', '')


def test_pgvector_notices_a_dead_server_through_tcp(monkeypatch):
    kwargs, _ = _pgvector_timeouts(
        monkeypatch, {'endpoint': 'postgresql://example.invalid/db', 'config': {'timeout': 9}}
    )

    # Client-side libpq settings, never sent to the server: without them a
    # server gone after the connect holds the search's thread for the kernel's
    # keepalive default, over two hours.
    assert kwargs['keepalives'] == '1'
    assert kwargs['keepalives_idle'] == '9'
    assert kwargs['keepalives_interval'] == '3'
    assert kwargs['keepalives_count'] == '3'
    assert kwargs['tcp_user_timeout'] == '18000'


def test_pgvector_leaves_what_the_endpoint_sets_itself(monkeypatch):
    endpoint = 'postgresql://example.invalid/db?options=-c%20search_path%3Ddocs&keepalives_idle=5'
    kwargs, _ = _pgvector_timeouts(monkeypatch, {'endpoint': endpoint})

    # As the endpoint gives them, and only the missing settings added.
    assert kwargs['options'] == '-c search_path=docs'
    assert kwargs['keepalives_idle'] == '5'
    assert kwargs['keepalives_interval'] == '10'


@pytest.mark.parametrize('timeout', [-5, 0, '0', 'soon', 1e12, None])
def test_pgvector_uses_the_default_for_a_timeout_postgres_cannot_take(monkeypatch, timeout):
    kwargs, statements = _pgvector_timeouts(
        monkeypatch, {'endpoint': 'postgresql://example.invalid/db', 'config': {'timeout': timeout}}
    )

    assert statements[0][1] == ('30000ms',)
    assert kwargs['connect_timeout'] == 30


def test_pgvector_gives_up_on_a_server_that_never_answers(monkeypatch):
    import time

    # Without a bound the search returns its rows once the fetch ends; with one
    # (2 x 0.1 + 1 s), the turn is told the search did not answer instead.
    with pytest.raises(RuntimeError, match='did not answer'):
        _retrieve_pgvector(
            monkeypatch,
            [],
            connection={'endpoint': 'postgresql://example.invalid/db', 'config': {'timeout': 0.1}},
            fetch=lambda: time.sleep(1.5),
        )
