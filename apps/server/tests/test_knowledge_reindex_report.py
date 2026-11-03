"""Reindex keeps the vectors when the embedding model cannot embed, and reports failures (#308).

POST /knowledge/reindex deleted every knowledge base's collection and each
file's, then re-embedded file by file, logging failures and returning True
whatever happened. With an embedding model that cannot run (a wrong key,
or one not in the cache under HF_HUB_OFFLINE=1), every vector was gone and
Admin Settings > Documents said "Success". It now checks the model embeds
before deleting anything, and reports how many files were re-embedded and
which failed.

Run from apps/server (any LLLM_SECRET_KEY of 32 characters or more):

    LLLM_SECRET_KEY=... python -m pytest tests/test_knowledge_reindex_report.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.routers import knowledge


def _setup(monkeypatch, *, embeds=True, failing=(), bypass=False, delete_fails=False):
    deleted: list[str] = []
    processed: list[str] = []
    files = [SimpleNamespace(id=f'f{i}', filename=f'doc{i}.pdf') for i in range(3)]

    class _Vectors:
        async def has_collection(self, collection_name):
            return True

        async def delete_collection(self, collection_name):
            if delete_fails and collection_name == 'kb1':
                raise RuntimeError('lock timeout')
            deleted.append(collection_name)

    async def bases(db=None):
        return [SimpleNamespace(id='kb1')]

    async def files_of(kb_id, db=None):
        return files

    async def process_file(request, form, user=None, db=None):
        if form.file_id in failing:
            raise RuntimeError('embedding failed')
        processed.append(form.file_id)

    async def embed(text, prefix=None, user=None):
        if not embeds:
            raise RuntimeError('CrossEncoder error: model not found in the cache')
        return [0.1, 0.2]

    async def config_get(key, default=None):
        return bypass if key == 'rag.bypass_embedding_and_retrieval' else default

    async def nothing(*args, **kwargs):
        return None

    monkeypatch.setattr(knowledge, 'ASYNC_VECTOR_DB_CLIENT', _Vectors())
    monkeypatch.setattr(knowledge.Knowledges, 'get_knowledge_bases', bases)
    monkeypatch.setattr(knowledge.Knowledges, 'get_files_by_id', files_of)
    monkeypatch.setattr(knowledge, 'process_file', process_file)
    monkeypatch.setattr(knowledge.Config, 'get', config_get)
    monkeypatch.setattr(knowledge, 'publish_event', nothing)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(EMBEDDING_FUNCTION=embed)))
    admin = SimpleNamespace(id='admin', role='admin')
    return request, admin, deleted, processed


def test_an_embedding_model_that_cannot_embed_stops_the_reindex_before_anything_is_deleted(monkeypatch):
    request, admin, deleted, processed = _setup(monkeypatch, embeds=False)

    with pytest.raises(HTTPException) as refused:
        asyncio.run(knowledge.reindex_knowledge_files(request, user=admin, db=None))

    assert refused.value.status_code == 400
    assert 'nothing was deleted' in refused.value.detail
    assert deleted == []
    assert processed == []


def test_failed_files_are_reported_not_hidden(monkeypatch):
    request, admin, _, processed = _setup(monkeypatch, failing={'f1'})

    report = asyncio.run(knowledge.reindex_knowledge_files(request, user=admin, db=None)).model_dump()

    assert processed == ['f0', 'f2']
    assert report['status'] is False
    assert (report['total'], report['reindexed']) == (3, 2)
    assert report['failed'] == [{'file_id': 'f1', 'filename': 'doc1.pdf', 'error': 'embedding failed'}]


def test_a_clean_reindex_reports_every_file(monkeypatch):
    request, admin, deleted, _ = _setup(monkeypatch)

    report = asyncio.run(knowledge.reindex_knowledge_files(request, user=admin, db=None)).model_dump()

    assert report == {'status': True, 'total': 3, 'reindexed': 3, 'failed': []}
    assert 'kb1' in deleted


def test_files_of_a_knowledge_base_that_could_not_be_cleared_are_reported_failed(monkeypatch):
    request, admin, _, processed = _setup(monkeypatch, delete_fails=True)

    report = asyncio.run(knowledge.reindex_knowledge_files(request, user=admin, db=None)).model_dump()

    assert processed == []
    assert (report['status'], report['reindexed']) == (False, 0)
    assert [f['file_id'] for f in report['failed']] == ['f0', 'f1', 'f2']
    assert 'lock timeout' in report['failed'][0]['error']


def test_with_retrieval_bypassed_the_embedding_check_is_skipped(monkeypatch):
    request, admin, _, processed = _setup(monkeypatch, embeds=False, bypass=True)

    report = asyncio.run(knowledge.reindex_knowledge_files(request, user=admin, db=None)).model_dump()

    assert report['status'] is True
    assert processed == ['f0', 'f1', 'f2']


def test_no_embedding_model_loaded_stops_the_reindex(monkeypatch):
    request, admin, deleted, _ = _setup(monkeypatch)
    del request.app.state.EMBEDDING_FUNCTION

    with pytest.raises(HTTPException) as refused:
        asyncio.run(knowledge.reindex_knowledge_files(request, user=admin, db=None))

    assert 'no embedding model is loaded' in refused.value.detail
    assert deleted == []


def test_an_embedder_that_never_answers_is_given_up_on(monkeypatch):
    request, admin, deleted, _ = _setup(monkeypatch)

    async def hangs(text, prefix=None, user=None):
        await asyncio.sleep(60)

    request.app.state.EMBEDDING_FUNCTION = hangs
    real_wait_for = asyncio.wait_for
    monkeypatch.setattr(knowledge.asyncio, 'wait_for', lambda aw, timeout: real_wait_for(aw, timeout=0.05))

    with pytest.raises(HTTPException) as refused:
        asyncio.run(knowledge.reindex_knowledge_files(request, user=admin, db=None))

    assert 'TimeoutError' in refused.value.detail
    assert deleted == []
