"""query_knowledge_files survives a failing external knowledge base (#180).

The external retrieval loop had no per-base error handling, so one base
that was disabled or unreachable (including one someone else shared, in
the default search-everything mode) turned the whole call into an error
and discarded every internal result.

Run from apps/server:

    python -m pytest tests/test_query_knowledge_files.py
"""

import asyncio
import json
from types import SimpleNamespace

from local_llm.retrieval import external as external_retrieval
from local_llm.retrieval import utils as retrieval_utils
from local_llm.tools import builtin

USER = {
    'id': 'u1', 'name': 'Ada', 'email': 'ada@example.invalid', 'role': 'user',
    'profile_image_url': '', 'last_active_at': 0, 'updated_at': 0, 'created_at': 0,
}  # fmt: skip
REQUEST = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(EMBEDDING_FUNCTION=lambda *a, **k: None)))


def _hits(prefix: str, scores: list[float]) -> dict:
    return {
        'documents': [[f'{prefix} {i}' for i in range(len(scores))]],
        'metadatas': [[{'source': prefix, 'file_id': prefix} for _ in scores]],
        'distances': [scores],
    }


def _run(monkeypatch, *, notes=(), internal=(), externals=(), count=5):
    class Search:
        def __init__(self, user, group_ids):
            self.note_results = [{'content': f'note {n}', 'source': n, 'note_id': n, 'type': 'note'} for n in notes]
            self.collection_names = ['kb1'] if internal else []
            self.external_knowledges = [SimpleNamespace(id=k, name=k) for k, _ in externals]

        async def add_all_accessible(self):
            return None

    async def query_collection(*_a, **_k):
        return _hits('internal', list(internal))

    async def retrieve_external(request, knowledge, **_k):
        result = dict(externals)[knowledge.id]
        if isinstance(result, Exception):
            raise result
        return _hits(knowledge.id, result)

    async def no_groups(*_a, **_k):
        return []

    monkeypatch.setattr(builtin, '_KnowledgeSearch', Search)
    monkeypatch.setattr(builtin.Groups, 'get_groups_by_member_id', no_groups)
    monkeypatch.setattr(retrieval_utils, 'query_collection', query_collection)
    monkeypatch.setattr(external_retrieval, 'retrieve_external_knowledge', retrieve_external)
    out = asyncio.run(builtin.query_knowledge_files('q', count=count, __request__=REQUEST, __user__=USER))
    return json.loads(out)


def test_a_failing_external_base_leaves_the_rest(monkeypatch, caplog):
    got = _run(
        monkeypatch,
        internal=[0.5],
        externals=[('down', RuntimeError('connection refused')), ('up', [0.7])],
    )

    assert [c['source'] for c in got] == ['internal', 'up']
    assert any('down' in r.getMessage() for r in caplog.records)


def test_when_the_only_source_fails_the_error_is_returned(monkeypatch):
    """An empty list would read as nothing relevant, when the base could not be reached."""
    got = _run(monkeypatch, externals=[('down', RuntimeError('connection refused'))])

    assert got == {'error': 'External knowledge unavailable: down: connection refused'}
