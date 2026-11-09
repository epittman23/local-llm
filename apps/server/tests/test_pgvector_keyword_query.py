"""Native pgvector hybrid search matches any English-stemmed query word (#347).

The keyword half used `plainto_tsquery('simple', query)`, which ANDs every
word, so a natural-language question ("How do I rotate the API key?") matched
almost no chunk and hybrid search was in effect vector-only. It now ORs the
query's lexemes under the `english` text-search config: stop words are dropped
and words stemmed, as `plainto_tsquery('english', ...)` makes them, and the
chunks are matched against `to_tsvector('english', text)`, which a second GIN
index covers. A query of only stop words matches nothing, and the caller's
vector fallback (#566) answers it.

The first tests read the SQL the client sends. The rest run it on a fresh
Postgres with pgvector (TEST_DATABASE_URL; CI provides one).

Run from apps/server (any LLLM_SECRET_KEY of 32 characters or more):

    TEST_DATABASE_URL=postgresql://... python -m pytest tests/test_pgvector_keyword_query.py
"""

import asyncio
import re
from types import SimpleNamespace

import pytest
from sqlalchemy import text
from test_schema_drift import fresh_database

from local_llm.retrieval import utils
from local_llm.retrieval.vector.async_client import AsyncVectorDBClient
from local_llm.retrieval.vector.dbs import pgvector

__all__ = ['fresh_database']

ENGLISH_VECTOR = "to_tsvector('english', coalesce(text, ''))"


class _RecordingSession:
    def __init__(self):
        self.sql: list[str] = []

    def execute(self, stmt, params=None):
        self.sql.append(' '.join(str(stmt).split()))
        return SimpleNamespace(mappings=lambda: SimpleNamespace(all=list))

    def rollback(self):
        pass


def _recording_client(monkeypatch):
    monkeypatch.setattr(pgvector, 'PGVECTOR_PGCRYPTO', False)
    client = pgvector.PgvectorClient.__new__(pgvector.PgvectorClient)
    client.session = _RecordingSession()
    return client


def test_the_keyword_query_ors_the_english_lexemes_of_the_question(monkeypatch):
    client = _recording_client(monkeypatch)

    client.hybrid_search('kb', 'How do I rotate the API key?', vectors=[], hybrid_bm25_weight=1.0)

    (sql,) = client.session.sql
    assert "plainto_tsquery('simple'" not in sql
    assert "tsvector_to_array(to_tsvector('english', :query))" in sql
    assert "' | '" in sql
    assert f'ts_rank_cd({ENGLISH_VECTOR}, fts_query.query)' in sql
    assert f'AND {ENGLISH_VECTOR} @@ fts_query.query' in sql


def test_an_english_index_covers_the_expression_the_query_matches(monkeypatch):
    client = _recording_client(monkeypatch)

    client._ensure_text_search_index()

    english = [sql for sql in client.session.sql if 'idx_document_chunk_text_search_english' in sql]
    assert english == [
        'CREATE INDEX IF NOT EXISTS idx_document_chunk_text_search_english '
        f'ON document_chunk USING GIN ({ENGLISH_VECTOR});'
    ]


# On Postgres.

KEY = 'Rotate the API key from Settings.'
KEYS = 'Keys hang by the door.'
COMMON = 'How do you do it? The way you do it is how it is, and that is all there is to it.'
FRUIT = 'Bananas are yellow.'


def _unit(i):
    vector = [0.0] * pgvector.VECTOR_LENGTH
    vector[i] = 1.0
    return vector


@pytest.fixture
def client(fresh_database, monkeypatch):
    monkeypatch.setattr(pgvector, 'PGVECTOR_DB_URL', fresh_database)
    monkeypatch.setattr(pgvector, 'PGVECTOR_PGCRYPTO', False)
    monkeypatch.setattr(pgvector, 'PGVECTOR_CREATE_EXTENSION', True)
    client = pgvector.PgvectorClient()
    client.insert(
        'kb',
        [
            {'id': name, 'text': body, 'vector': _unit(i), 'metadata': {}}
            for i, (name, body) in enumerate({'key': KEY, 'keys': KEYS, 'common': COMMON, 'fruit': FRUIT}.items())
        ],
    )
    try:
        yield client
    finally:
        engine = client.session.get_bind()
        client.session.remove()
        engine.dispose()


def _keyword_ids(client, query):
    result = client.hybrid_search('kb', query, vectors=[], limit=5, hybrid_bm25_weight=1.0)
    assert result is not None
    return result.ids[0]


def test_a_question_finds_the_chunk_with_its_words_and_not_the_common_words_on_postgres(client):
    assert _keyword_ids(client, 'How do I rotate the API key?') == ['key', 'keys']


def test_a_question_of_only_stop_words_matches_nothing_on_postgres(client):
    assert _keyword_ids(client, 'how do you do it') == []


@pytest.mark.parametrize(
    ('query', 'expected'),
    [
        ("O'Brien's key", ['key', 'keys']),
        ('back\\slash keys', ['key', 'keys']),
        ('key: a & b | !c (d) <-> e', ['key', 'keys']),
        ('key 🔑', ['key', 'keys']),
        ("C:\\path\\it's", []),
        ("http://x.org/a?b='c'", []),
    ],
)
def test_punctuation_in_a_question_is_text_on_postgres(client, query, expected):
    assert _keyword_ids(client, query) == expected


def test_the_query_uses_the_english_index_on_postgres(client):
    session = client.session
    session.execute(text('SET LOCAL enable_seqscan = off'))
    plan = session.execute(
        text(f"EXPLAIN SELECT id FROM document_chunk WHERE {ENGLISH_VECTOR} @@ to_tsquery('english', 'key')")
    ).scalars()
    assert re.search(r'Bitmap Index Scan on idx_document_chunk_text_search_english', '\n'.join(plan))
    session.rollback()


def test_a_question_of_only_stop_words_falls_back_to_vector_search_on_postgres(client, monkeypatch):
    class _Compressor:
        def __init__(self, **kwargs):
            pass

        async def acompress_documents(self, documents, query):
            return documents

    async def embed(query, prefix=None):
        return _unit(3)

    monkeypatch.setattr(utils, 'ASYNC_VECTOR_DB_CLIENT', AsyncVectorDBClient(client))
    monkeypatch.setattr(utils, 'RerankCompressor', _Compressor)

    search = utils.query_doc_with_native_hybrid_search('kb', 'how do you do it', embed, 1, None, 1, 0.0, 1.0)
    result = asyncio.run(search)

    assert result['documents'] == [[FRUIT]]
