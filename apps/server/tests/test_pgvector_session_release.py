"""pgvector's read paths end their transaction on every return (#352).

`query`, `get` and `search` used to return early when nothing matched,
before the read-only `rollback()`, so the thread's scoped session stayed idle
in a transaction holding a pooled connection. Nothing matching is the normal
case for the duplicate-hash check and for a new collection.
"""

from types import SimpleNamespace

import pytest

from local_llm.retrieval.vector.dbs import pgvector


class _FakeQuery:
    def __init__(self, session):
        self._session = session

    def filter(self, *args):
        return self

    def limit(self, n):
        return self

    def all(self):
        return self._session.rows()


class _FakeSession:
    """Records how each transaction ends; `rows` is what every read returns."""

    def __init__(self, rows=(), error=None):
        self._rows = list(rows)
        self._error = error
        self.calls = []

    def rows(self):
        if self._error is not None:
            raise self._error
        self.calls.append('read')
        return self._rows

    def query(self, *args):
        return _FakeQuery(self)

    def execute(self, stmt):
        return SimpleNamespace(all=self.rows)

    def rollback(self):
        self.calls.append('rollback')

    def commit(self):
        self.calls.append('commit')


def _client(session):
    client = pgvector.PgvectorClient.__new__(pgvector.PgvectorClient)
    client.session = session
    return client


@pytest.fixture(autouse=True)
def _plain_columns(monkeypatch):
    monkeypatch.setattr(pgvector, 'PGVECTOR_PGCRYPTO', False)


def test_query_with_no_match_ends_the_transaction():
    session = _FakeSession()
    assert _client(session).query('new-collection', {'hash': 'abc'}) is None
    assert session.calls == ['read', 'rollback']


def test_get_with_no_match_ends_the_transaction():
    session = _FakeSession()
    assert _client(session).get('new-collection') is None
    assert session.calls == ['read', 'rollback']


def test_search_with_no_match_ends_the_transaction():
    session = _FakeSession()
    result = _client(session).search('new-collection', [[0.1, 0.2]])
    assert result is not None
    assert result.ids == [[]]
    assert session.calls == ['read', 'rollback']


def test_query_with_a_match_still_returns_it_and_ends_the_transaction():
    row = SimpleNamespace(id='c1', text='hello', vmetadata={'hash': 'abc'})
    session = _FakeSession(rows=[row])
    result = _client(session).query('docs', {'hash': 'abc'})
    assert result is not None
    assert result.ids == [['c1']]
    assert result.documents == [['hello']]
    assert result.metadatas == [[{'hash': 'abc'}]]
    assert session.calls == ['read', 'rollback']


@pytest.mark.parametrize(
    'call',
    [
        lambda c: c.query('docs', {'hash': 'abc'}),
        lambda c: c.get('docs'),
        lambda c: c.search('docs', [[0.1, 0.2]]),
    ],
    ids=['query', 'get', 'search'],
)
def test_a_failed_read_ends_the_transaction_and_returns_none(call):
    session = _FakeSession(error=RuntimeError('connection lost'))
    assert call(_client(session)) is None
    assert session.calls == ['rollback']
