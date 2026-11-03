"""Native pgvector hybrid search matches any query word, and falls back when none matches (#347).

The full-text half used `plainto_tsquery('simple', query)`, which ANDs every
word: a natural-language question ("how do I rotate the API key?") matched
almost no chunk, so at the default BM25 weight hybrid search was in effect
vector-only, and at weight 1.0 (vector search skipped) it returned nothing
and chat got no context. The query now ORs the words, ranked by
`ts_rank_cd` so chunks with more of them come first, and an empty
full-text result falls back to vector search. Checked by hand on Postgres
16 (pgvector image); these use a fake session and read the SQL sent.
"""

from local_llm.retrieval.vector.dbs import pgvector
from local_llm.retrieval.vector.main import SearchResult


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def all(self):
        return self._rows


class _Session:
    def __init__(self, fts_rows):
        self.fts_rows = fts_rows
        self.sql: list[str] = []

    def execute(self, stmt, params=None):
        self.sql.append(str(stmt))
        return _Rows(self.fts_rows)

    def rollback(self):
        pass


VECTOR_HITS = SearchResult(
    ids=[['v1', 'v2']], distances=[[0.9, 0.8]], documents=[['vec one', 'vec two']], metadatas=[[{}, {}]]
)


def _client(monkeypatch, fts_rows):
    client = pgvector.PgvectorClient.__new__(pgvector.PgvectorClient)
    client.session = _Session(fts_rows)
    searched: list[str] = []

    def search(collection_name, vectors, limit=10, filter=None):
        searched.append(collection_name)
        return VECTOR_HITS

    monkeypatch.setattr(client, 'search', search)
    monkeypatch.setattr(client, 'adjust_vector_length', lambda v: v)
    monkeypatch.setattr(pgvector, 'PGVECTOR_PGCRYPTO', False)
    return client, searched


def test_the_full_text_query_matches_any_word_not_every_word(monkeypatch):
    client, _ = _client(monkeypatch, fts_rows=[])

    client.hybrid_search('kb1', 'how do I rotate the key', vectors=[[0.1]], limit=5, hybrid_bm25_weight=0.5)

    (sql,) = client.session.sql
    assert "replace(plainto_tsquery('simple', :query)::text, ' & ', ' | ')::tsquery" in sql


def test_keywords_only_with_no_keyword_match_falls_back_to_vector_search(monkeypatch):
    client, searched = _client(monkeypatch, fts_rows=[])

    result = client.hybrid_search('kb1', 'unmatched words', vectors=[[0.1]], limit=5, hybrid_bm25_weight=1.0)

    assert searched == ['kb1']
    assert result.ids == [['v1', 'v2']]
    assert result.documents == [['vec one', 'vec two']]


def test_keywords_only_with_a_match_uses_the_keyword_ranking_alone(monkeypatch):
    rows = [{'id': 'k1', 'text': 'rotate the key', 'vmetadata': {}, 'rank': 0.5}]
    client, searched = _client(monkeypatch, fts_rows=rows)

    result = client.hybrid_search('kb1', 'rotate key', vectors=[[0.1]], limit=5, hybrid_bm25_weight=1.0)

    assert searched == []
    assert result.ids == [['k1']]
