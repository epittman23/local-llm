"""Deleting a knowledge directory with its contents removes the files' chunks too.

With "delete contents" checked (move_files=false, the UI default), the
directory delete only dropped the knowledge_file links. The chunks stayed
in the knowledge base's vector collection, which retrieval searches whole,
so chat kept answering from the deleted files, and with the link gone they
could no longer be removed from the UI (#195). It now removes each file as
the single-file remove and the sync cleanup do: vectors by file_id and
hash, and the File row unless another knowledge base still links it.

Runs against the suite's temporary SQLite database (tests/conftest.py points
DATA_DIR at a temp directory, and DATABASE_URL defaults to a file in it, migrated on import),
with the vector client and file storage replaced by recorders.

Run from apps/server:

    python -m pytest tests/test_knowledge_directory_delete.py
"""

import asyncio
import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.models.files import FileForm, Files
from local_llm.models.knowledge import KnowledgeForm, Knowledges
from local_llm.models.users import Users
from local_llm.routers import knowledge as knowledge_router


class VectorRecorder:
    def __init__(self, failing: set[str] = frozenset()):
        self.deleted: list[tuple[str, dict]] = []
        self.failing = failing

    async def delete(self, collection_name, ids=None, filter=None):
        if filter and filter.get('file_id') in self.failing:
            raise RuntimeError('vector store unavailable')
        self.deleted.append((collection_name, filter))

    async def has_collection(self, collection_name):
        return False


def _setup(monkeypatch, vectors=None):
    vectors = vectors or VectorRecorder()
    removed_paths: list[str] = []

    async def publish(*_a, **_k):
        return None

    monkeypatch.setattr(knowledge_router, 'ASYNC_VECTOR_DB_CLIENT', vectors)
    monkeypatch.setattr(knowledge_router.Storage, 'delete_file', removed_paths.append)
    monkeypatch.setattr(knowledge_router, 'publish_event', publish)
    return vectors, removed_paths


async def _world():
    tag = uuid.uuid4().hex[:8]
    user = await Users.insert_new_user(f'u{tag}', 'Ada', f'u{tag}@example.invalid', role='user')
    kb = await Knowledges.insert_new_knowledge(user.id, KnowledgeForm(name='Notes', description=''))
    other_kb = await Knowledges.insert_new_knowledge(user.id, KnowledgeForm(name='Other', description=''))
    top = await Knowledges.create_directory(knowledge_id=kb.id, name='top', user_id=user.id)
    child = await Knowledges.create_directory(knowledge_id=kb.id, name='child', user_id=user.id, parent_id=top.id)

    async def file(name, directory_id):
        f = await Files.insert_new_file(
            user.id, FileForm(id=str(uuid.uuid4()), hash=f'h-{name}', filename=name, path=f'/store/{name}')
        )
        await Knowledges.add_file_to_knowledge_by_id(kb.id, f.id, user.id, directory_id=directory_id)
        return f

    files = {
        'in_top': await file('in_top', top.id),
        'in_child': await file('in_child', child.id),
        'shared': await file('shared', top.id),
        'outside': await file('outside', None),
    }
    await Knowledges.add_file_to_knowledge_by_id(other_kb.id, files['shared'].id, user.id)
    return SimpleNamespace(id=user.id, role='user'), kb, top, files


def test_deleting_contents_removes_the_files_chunks_and_rows(monkeypatch):
    vectors, removed_paths = _setup(monkeypatch)

    async def scenario():
        user, kb, top, files = await _world()
        await knowledge_router.delete_knowledge_directory(None, kb.id, top.id, move_files=False, user=user, db=None)
        rows = {name: await Files.get_file_by_id(f.id) for name, f in files.items()}
        linked = {f.id for f in await Knowledges.get_files_by_id(kb.id)}
        return kb, files, rows, linked

    kb, files, rows, linked = _run(scenario())

    gone = ('in_top', 'in_child', 'shared')
    for name in gone:
        assert (kb.id, {'file_id': files[name].id}) in vectors.deleted
        assert (kb.id, {'hash': f'h-{name}'}) in vectors.deleted
    assert not any(f == {'file_id': files['outside'].id} for _, f in vectors.deleted)
    assert linked == {files['outside'].id}
    # Files nothing else links are deleted; one still in another knowledge base is kept.
    assert rows['in_top'] is None and rows['in_child'] is None
    assert rows['shared'] is not None and rows['outside'] is not None
    assert sorted(removed_paths) == ['/store/in_child', '/store/in_top']


def test_moving_contents_to_the_parent_leaves_the_chunks(monkeypatch):
    vectors, removed_paths = _setup(monkeypatch)

    async def scenario():
        user, kb, top, files = await _world()
        await knowledge_router.delete_knowledge_directory(None, kb.id, top.id, move_files=True, user=user, db=None)
        return files, {f.id for f in await Knowledges.get_files_by_id(kb.id)}

    files, linked = _run(scenario())

    assert vectors.deleted == [] and removed_paths == []
    assert linked == {f.id for f in files.values()}


def test_sync_cleanup_of_a_directory_still_holding_files_removes_their_chunks(monkeypatch):
    vectors, _ = _setup(monkeypatch)

    async def scenario():
        user, kb, top, files = await _world()
        form = knowledge_router.SyncCleanupForm(file_ids=[], dir_ids=[top.id])
        await knowledge_router.sync_knowledge_cleanup(kb.id, form, user=user, db=None)
        return kb, files, {f.id for f in await Knowledges.get_files_by_id(kb.id)}

    kb, files, linked = _run(scenario())

    assert linked == {files['outside'].id}
    assert (kb.id, {'file_id': files['in_child'].id}) in vectors.deleted


def test_a_collaborator_removes_the_chunks_but_not_the_owners_files(monkeypatch):
    vectors, removed_paths = _setup(monkeypatch)

    async def scenario():
        owner, kb, top, files = await _world()
        collaborator = SimpleNamespace(id='someone-else', role='user')
        monkeypatch.setattr(knowledge_router, '_verify_knowledge_write_access', _allowed)
        await knowledge_router.delete_knowledge_directory(
            None, kb.id, top.id, move_files=False, user=collaborator, db=None
        )
        return kb, files, {name: await Files.get_file_by_id(f.id) for name, f in files.items()}

    kb, files, rows = _run(scenario())

    assert (kb.id, {'file_id': files['in_top'].id}) in vectors.deleted
    assert all(row is not None for row in rows.values())
    assert removed_paths == []


def test_with_retention_on_the_files_are_kept(monkeypatch):
    vectors, removed_paths = _setup(monkeypatch)
    monkeypatch.setattr(knowledge_router, 'ENABLE_KNOWLEDGE_FILE_RETENTION', True)

    async def scenario():
        user, kb, top, files = await _world()
        await knowledge_router.delete_knowledge_directory(None, kb.id, top.id, move_files=False, user=user, db=None)
        return files, {name: await Files.get_file_by_id(f.id) for name, f in files.items()}

    files, rows = _run(scenario())

    assert (len(vectors.deleted), removed_paths) == (6, [])
    assert all(row is not None for row in rows.values())


def test_a_file_whose_chunks_cannot_be_deleted_stays_listed(monkeypatch):
    state = {}

    async def scenario():
        user, kb, top, files = await _world()
        state['vectors'], _ = _setup(monkeypatch, VectorRecorder(failing={files['in_top'].id}))
        with pytest.raises(HTTPException) as refused:
            await knowledge_router.delete_knowledge_directory(None, kb.id, top.id, move_files=False, user=user, db=None)
        assert refused.value.status_code == 500
        assert await Knowledges.get_directory_by_id(top.id) is not None
        return (
            files,
            {f.id for f in await Knowledges.get_files_by_id(kb.id)},
            await Files.get_file_by_id(files['in_top'].id),
        )

    files, linked, row = _run(scenario())

    assert linked == {files['in_top'].id, files['outside'].id}
    assert row is not None


async def _allowed(*_a, **_k):
    return None


def _run(coro):
    return asyncio.run(coro)
