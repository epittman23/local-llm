"""Removing a file from one knowledge base keeps it when another base uses it.

`/file/remove` (with delete_file, the default) and `/reset` deleted the File
row and its stored bytes without checking whether another knowledge base
still linked it, as the sync cleanup does. The other base's link went with
the row while its collection kept the chunks, so chat kept answering from a
file that no longer existed anywhere (#313). All three paths now delete the
file only when no other base links it.

Runs against the suite's temporary SQLite database (tests/conftest.py points
DATA_DIR at a temp directory, and DATABASE_URL defaults to a file in it, migrated on import),
with the vector client and file storage replaced by recorders.

Run from apps/server:

    python -m pytest tests/test_knowledge_shared_file_delete.py
"""

import asyncio
import uuid
from types import SimpleNamespace

import pytest

from local_llm.models.files import FileForm, Files
from local_llm.models.knowledge import KnowledgeForm, Knowledges
from local_llm.models.users import Users
from local_llm.routers import knowledge as knowledge_router


class VectorRecorder:
    def __init__(self):
        self.deleted: list[tuple[str, dict]] = []
        self.dropped: list[str] = []

    async def delete(self, collection_name, ids=None, filter=None):
        self.deleted.append((collection_name, filter))

    async def delete_collection(self, collection_name):
        self.dropped.append(collection_name)

    async def has_collection(self, collection_name):
        # A file's own collection, which deleting the file drops.
        return collection_name.startswith('file-')


@pytest.fixture
def recorders(monkeypatch):
    vectors = VectorRecorder()
    removed_paths: list[str] = []

    async def publish(*_a, **_k):
        return None

    monkeypatch.setattr(knowledge_router, 'ASYNC_VECTOR_DB_CLIENT', vectors)
    monkeypatch.setattr(knowledge_router.Storage, 'delete_file', removed_paths.append)
    monkeypatch.setattr(knowledge_router, 'publish_event', publish)
    monkeypatch.setattr(knowledge_router, 'ENABLE_KNOWLEDGE_FILE_RETENTION', False)
    return vectors, removed_paths


async def _world():
    """Two knowledge bases; 'shared' is in both, 'own' only in the first."""
    tag = uuid.uuid4().hex[:8]
    user = await Users.insert_new_user(f'u{tag}', 'Ada', f'u{tag}@example.invalid', role='user')
    kb = await Knowledges.insert_new_knowledge(user.id, KnowledgeForm(name='Notes', description=''))
    other_kb = await Knowledges.insert_new_knowledge(user.id, KnowledgeForm(name='Other', description=''))

    async def file(name):
        f = await Files.insert_new_file(
            user.id, FileForm(id=str(uuid.uuid4()), hash=f'h-{name}-{tag}', filename=name, path=f'/store/{tag}/{name}')
        )
        await Knowledges.add_file_to_knowledge_by_id(kb.id, f.id, user.id)
        return f

    files = {'shared': await file('shared'), 'own': await file('own')}
    await Knowledges.add_file_to_knowledge_by_id(other_kb.id, files['shared'].id, user.id)
    return SimpleNamespace(id=user.id, role='user'), kb, other_kb, files, tag


async def _remove(user, kb, file_id):
    form = knowledge_router.KnowledgeFileIdForm(file_id=file_id)
    return await knowledge_router.remove_file_from_knowledge_by_id(
        None, kb.id, form, delete_file=True, user=user, db=None
    )


def test_removing_a_shared_file_keeps_it_for_the_other_base(recorders):
    vectors, removed_paths = recorders

    async def scenario():
        user, kb, other_kb, files, tag = await _world()
        await _remove(user, kb, files['shared'].id)
        return (
            kb,
            files,
            tag,
            await Files.get_file_by_id(files['shared'].id),
            {f.id for f in await Knowledges.get_files_by_id(kb.id)},
            {f.id for f in await Knowledges.get_files_by_id(other_kb.id)},
        )

    kb, files, tag, row, linked, other_linked = asyncio.run(scenario())

    assert row is not None
    assert removed_paths == []
    assert f'file-{files["shared"].id}' not in vectors.dropped
    # Gone from this base, its chunks included; still in the other one.
    assert linked == {files['own'].id}
    assert (kb.id, {'file_id': files['shared'].id}) in vectors.deleted
    assert other_linked == {files['shared'].id}


def test_removing_a_file_no_other_base_uses_still_deletes_it(recorders):
    _, removed_paths = recorders

    async def scenario():
        user, kb, _other, files, tag = await _world()
        await _remove(user, kb, files['own'].id)
        return tag, await Files.get_file_by_id(files['own'].id)

    tag, row = asyncio.run(scenario())

    assert row is None
    assert removed_paths == [f'/store/{tag}/own']


def test_resetting_a_base_keeps_the_files_another_base_uses(recorders):
    vectors, removed_paths = recorders

    async def scenario():
        user, kb, other_kb, files, tag = await _world()
        await knowledge_router.reset_knowledge_by_id(None, kb.id, include_directories=True, user=user, db=None)
        return (
            kb,
            files,
            tag,
            {name: await Files.get_file_by_id(f.id) for name, f in files.items()},
            await Knowledges.get_files_by_id(kb.id),
            {f.id for f in await Knowledges.get_files_by_id(other_kb.id)},
        )

    kb, files, tag, rows, linked, other_linked = asyncio.run(scenario())

    assert vectors.dropped == [kb.id, f'file-{files["own"].id}']
    assert linked == []
    assert rows['own'] is None and rows['shared'] is not None
    assert removed_paths == [f'/store/{tag}/own']
    assert other_linked == {files['shared'].id}


def test_sync_cleanup_still_keeps_a_shared_file(recorders):
    _, removed_paths = recorders

    async def scenario():
        user, kb, _other, files, tag = await _world()
        form = knowledge_router.SyncCleanupForm(file_ids=[files['shared'].id, files['own'].id])
        await knowledge_router.sync_knowledge_cleanup(kb.id, form, user=user, db=None)
        return tag, {name: await Files.get_file_by_id(f.id) for name, f in files.items()}

    tag, rows = asyncio.run(scenario())

    assert rows['own'] is None and rows['shared'] is not None
    assert removed_paths == [f'/store/{tag}/own']


def test_a_failed_link_lookup_keeps_the_file(recorders, monkeypatch):
    _, removed_paths = recorders

    async def scenario():
        user, kb, _other, files, _tag = await _world()

        async def broken(*_a, **_k):
            raise RuntimeError('database unavailable')

        monkeypatch.setattr(Knowledges, 'get_knowledge_ids_by_file_id', broken)
        with pytest.raises(RuntimeError):
            await _remove(user, kb, files['own'].id)
        return await Files.get_file_by_id(files['own'].id), await Knowledges.has_file(kb.id, files['own'].id)

    row, still_linked = asyncio.run(scenario())

    # Nothing changed: the file is still in the base, so removing it can be retried.
    assert row is not None and still_linked
    assert removed_paths == []


def test_a_failed_link_lookup_in_sync_cleanup_keeps_the_file_in_the_base(recorders, monkeypatch):
    vectors, removed_paths = recorders

    async def scenario():
        user, kb, _other, files, _tag = await _world()

        async def broken(*_a, **_k):
            raise RuntimeError('database unavailable')

        monkeypatch.setattr(Knowledges, 'get_knowledge_ids_by_file_id', broken)
        form = knowledge_router.SyncCleanupForm(file_ids=[files['own'].id])
        with pytest.raises(RuntimeError):
            await knowledge_router.sync_knowledge_cleanup(kb.id, form, user=user, db=None)
        return await Files.get_file_by_id(files['own'].id), await Knowledges.has_file(kb.id, files['own'].id)

    row, still_linked = asyncio.run(scenario())

    assert row is not None and still_linked
    assert removed_paths == [] and vectors.deleted == []


def test_the_link_lookup_lists_every_base_linking_the_file():
    async def scenario():
        _user, kb, other_kb, files, _tag = await _world()
        return kb, other_kb, files, await Knowledges.get_knowledge_ids_by_file_id(files['shared'].id)

    kb, other_kb, files, ids = asyncio.run(scenario())

    assert sorted(ids) == sorted([kb.id, other_kb.id])
