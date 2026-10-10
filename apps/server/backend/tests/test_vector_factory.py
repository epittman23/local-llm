"""VECTOR_DB_CLIENT is created on first use, not when retrieval code is imported.

It used to connect at import, so importing a router that touches retrieval
needed a live vector store. That was invisible while the default store was an
embedded Chroma; with pgvector as the default it meant every such import
needed Postgres.
"""

import threading

from open_webui.retrieval.vector import factory
from open_webui.retrieval.vector.async_client import AsyncVectorDBClient
from open_webui.retrieval.vector.main import VectorDBBase


class _Plain(VectorDBBase):
    def has_collection(self, collection_name):
        return collection_name == 'docs'

    def delete_collection(self, collection_name):
        pass

    def insert(self, collection_name, items):
        pass

    def upsert(self, collection_name, items):
        pass

    def search(self, collection_name, vectors, filter=None, limit=10):
        return None

    def query(self, collection_name, filter, limit=None):
        return None

    def get(self, collection_name):
        return None

    def delete(self, collection_name, ids=None, filter=None):
        pass

    def reset(self):
        pass


class _Hybrid(_Plain):
    def hybrid_search(self, *args, **kwargs):
        return None


def _counting(monkeypatch, cls):
    calls = []

    def get_vector(vector_type):
        calls.append(vector_type)
        return cls()

    monkeypatch.setattr(factory.Vector, 'get_vector', staticmethod(get_vector))
    return calls


def test_nothing_is_created_until_first_use(monkeypatch):
    calls = _counting(monkeypatch, _Plain)
    client = factory.LazyVectorDBClient('pgvector')
    assert calls == []
    assert client.has_collection('docs') is True
    assert client.has_collection('other') is False
    assert calls == ['pgvector']


def test_created_once_even_with_concurrent_first_use(monkeypatch):
    calls = _counting(monkeypatch, _Plain)
    client = factory.LazyVectorDBClient('pgvector')
    threads = [threading.Thread(target=client.resolve) for _ in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert calls == ['pgvector']
    assert client.resolve() is client.resolve()


def test_async_facade_sees_the_real_client_type(monkeypatch):
    _counting(monkeypatch, _Hybrid)
    assert AsyncVectorDBClient(factory.LazyVectorDBClient('x')).supports_hybrid_search is True
    _counting(monkeypatch, _Plain)
    assert AsyncVectorDBClient(factory.LazyVectorDBClient('x')).supports_hybrid_search is False
