"""In chat, one failing attachment or knowledge base keeps the others' context (#351).

get_sources_from_items had no per-item error handling, so an external
knowledge base that raised (disabled, unreachable) aborted the whole call,
and the chat middleware went on with no sources: the model answered
without any of the attached files or bases.

Run from apps/server:

    python -m pytest tests/test_chat_sources_isolation.py
"""

import asyncio
from types import SimpleNamespace

import pytest

from local_llm.models.users import UserModel
from local_llm.retrieval import utils as retrieval

USER = UserModel(
    id='u1', name='Ada', email='ada@example.invalid', role='user',
    profile_image_url='', last_active_at=0, updated_at=0, created_at=0,
)  # fmt: skip
INLINE_FILE = {
    'type': 'file',
    'id': 'f1',
    'name': 'notes.txt',
    'context': 'full',
    'file': {'data': {'content': 'file content', 'metadata': {}}},
}
EXTERNAL = {
    'down': RuntimeError('External knowledge connection is disabled'),
    'up': {'documents': [['external hit']], 'metadatas': [[{'source': 'up'}]]},
}


def _run(monkeypatch, items):
    async def config_get(key, default=None):
        return False

    async def get_knowledge_by_id(kb_id):
        return SimpleNamespace(id=kb_id, name=kb_id, user_id='u1', meta={'source': 'external'})

    async def retrieve_external_knowledge(request, knowledge_base, queries, count, user):
        result = EXTERNAL[knowledge_base.id]
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(retrieval.Config, 'get', config_get)
    monkeypatch.setattr(retrieval.Knowledges, 'get_knowledge_by_id', get_knowledge_by_id)
    monkeypatch.setattr(retrieval, 'retrieve_external_knowledge', retrieve_external_knowledge)
    return asyncio.run(
        retrieval.get_sources_from_items(
            None,
            items,
            ['what?'],
            embedding_function=None,
            k=4,
            reranking_function=None,
            k_reranker=None,
            r=0.0,
            hybrid_bm25_weight=0.5,
            hybrid_search=False,
            user=USER,
        )
    )


def test_a_failing_knowledge_base_leaves_the_other_sources(monkeypatch, caplog):
    sources = _run(
        monkeypatch,
        [INLINE_FILE, {'type': 'collection', 'id': 'down'}, {'type': 'collection', 'id': 'up'}],
    )

    assert [s['document'] for s in sources] == [['file content'], ['external hit']]
    assert any('down' in r.getMessage() and 'disabled' in r.getMessage() for r in caplog.records)


def test_when_every_source_fails_the_error_is_raised(monkeypatch):
    """An empty list would read as nothing relevant, when the base could not be reached."""
    with pytest.raises(RuntimeError, match='down: External knowledge connection is disabled'):
        _run(monkeypatch, [{'type': 'collection', 'id': 'down'}])
