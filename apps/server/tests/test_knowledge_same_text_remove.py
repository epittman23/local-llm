"""Removing a file from a knowledge base keeps another file's chunks with the same text (#792).

Every removal deleted the file's chunks by its file id and again by its text
hash, across the whole collection. When another file linked to the base had
the same text (a copy a folder sync left in place, say), its chunks went too:
it stayed listed but was no longer found by search. A file's chunks are now
deleted by hash only when no other file in the base has that hash, which
still clears chunks of its text that carry no file id.

Runs against the suite's temporary SQLite database (tests/conftest.py points
DATA_DIR at a temp directory), with the vector client replaced by an
in-memory store that deletes the chunks matching a filter.

Run from apps/server:

    python -m pytest tests/test_knowledge_same_text_remove.py
"""

import asyncio
import uuid
from types import SimpleNamespace

from local_llm.models.files import FileForm, Files
from local_llm.models.knowledge import KnowledgeForm, Knowledges
from local_llm.models.users import Users
from local_llm.routers import files as files_router
from local_llm.routers import knowledge as knowledge_router


class ChunkStore:
    """Chunks by collection; a delete drops those whose metadata matches every filter key."""

    def __init__(self):
        self.chunks: dict[str, list[dict]] = {}

    def add(self, collection_name, **metadata):
        self.chunks.setdefault(collection_name, []).append(metadata)

    async def delete(self, collection_name, ids=None, filter=None):
        if filter is None:
            self.chunks.pop(collection_name, None)
            return
        self.chunks[collection_name] = [
            c for c in self.chunks.get(collection_name, []) if any(c.get(k) != v for k, v in filter.items())
        ]

    async def has_collection(self, collection_name):
        return collection_name in self.chunks

    async def delete_collection(self, collection_name):
        self.chunks.pop(collection_name, None)

    def owners(self, collection_name):
        return sorted(c.get('file_id') or '-' for c in self.chunks.get(collection_name, []))


def _setup(monkeypatch):
    store = ChunkStore()

    async def publish(*_a, **_k):
        return None

    for router in (knowledge_router, files_router):
        monkeypatch.setattr(router, 'ASYNC_VECTOR_DB_CLIENT', store)
        monkeypatch.setattr(router, 'publish_event', publish)
    monkeypatch.setattr(knowledge_router.Storage, 'delete_file', lambda path: None)
    return store


async def _world(store):
    """A base with 'spare' in folder 'top' and 'twin' at its root, both holding one text."""
    tag = uuid.uuid4().hex[:8]
    user = await Users.insert_new_user(f'u{tag}', 'Ada', f'u{tag}@example.invalid', role='user')
    kb = await Knowledges.insert_new_knowledge(user.id, KnowledgeForm(name='Notes', description=''))
    top = await Knowledges.create_directory(knowledge_id=kb.id, name='top', user_id=user.id)
    text_hash = f'same-{tag}'

    async def file(name, directory_id):
        f = await Files.insert_new_file(
            user.id, FileForm(id=f'{name}-{tag}', hash=text_hash, filename=f'{name}.txt', path=f'/store/{name}')
        )
        await Knowledges.add_file_to_knowledge_by_id(kb.id, f.id, user.id, directory_id=directory_id)
        store.add(kb.id, file_id=f.id, hash=text_hash)
        return f

    files = {'spare': await file('spare', top.id), 'twin': await file('twin', None)}
    return SimpleNamespace(id=user.id, role='user'), kb, top, files, text_hash


def test_removing_one_of_two_same_text_files_keeps_the_others_chunks(monkeypatch):
    store = _setup(monkeypatch)

    async def scenario():
        user, kb, _top, files, _hash = await _world(store)
        form = knowledge_router.KnowledgeFileIdForm(file_id=files['spare'].id)
        await knowledge_router.remove_file_from_knowledge_by_id(None, kb.id, form, delete_file=True, user=user, db=None)
        return kb, files

    kb, files = asyncio.run(scenario())

    assert store.owners(kb.id) == [files['twin'].id]


def test_sync_cleanup_of_one_same_text_file_keeps_the_others_chunks(monkeypatch):
    store = _setup(monkeypatch)

    async def scenario():
        user, kb, _top, files, _hash = await _world(store)
        form = knowledge_router.SyncCleanupForm(file_ids=[files['spare'].id])
        await knowledge_router.sync_knowledge_cleanup(kb.id, form, user=user, db=None)
        return kb, files

    kb, files = asyncio.run(scenario())

    assert store.owners(kb.id) == [files['twin'].id]


def test_sync_cleanup_of_a_vanished_folder_keeps_same_text_chunks_outside_it(monkeypatch):
    # The path #792's comment names: a copy left in a folder gone from disk goes
    # with the folder, and the same text kept elsewhere in the base stays.
    store = _setup(monkeypatch)

    async def scenario():
        user, kb, top, files, _hash = await _world(store)
        form = knowledge_router.SyncCleanupForm(file_ids=[], dir_ids=[top.id])
        await knowledge_router.sync_knowledge_cleanup(kb.id, form, user=user, db=None)
        return kb, files, {f.id for f in await Knowledges.get_files_by_id(kb.id)}

    kb, files, linked = asyncio.run(scenario())

    assert linked == {files['twin'].id}
    assert store.owners(kb.id) == [files['twin'].id]


def test_deleting_a_folders_contents_keeps_same_text_chunks_outside_it(monkeypatch):
    store = _setup(monkeypatch)

    async def scenario():
        user, kb, top, files, _hash = await _world(store)
        await knowledge_router.delete_knowledge_directory(None, kb.id, top.id, move_files=False, user=user, db=None)
        return kb, files

    kb, files = asyncio.run(scenario())

    assert store.owners(kb.id) == [files['twin'].id]


def test_removing_the_last_file_with_a_text_still_deletes_its_chunks_by_hash(monkeypatch):
    # A chunk of the text with no file id goes with the last file holding it.
    store = _setup(monkeypatch)

    async def scenario():
        user, kb, _top, files, text_hash = await _world(store)
        store.add(kb.id, hash=text_hash)
        form = knowledge_router.SyncCleanupForm(file_ids=[files['spare'].id, files['twin'].id])
        await knowledge_router.sync_knowledge_cleanup(kb.id, form, user=user, db=None)
        return kb

    kb = asyncio.run(scenario())

    assert store.owners(kb.id) == []


def test_deleting_one_of_two_same_text_files_keeps_the_others_chunks(monkeypatch):
    # DELETE /files/{id} cleans every base linking the file the same way.
    store = _setup(monkeypatch)
    monkeypatch.setattr(files_router.Storage, 'delete_file', lambda path: None)

    async def scenario():
        user, kb, _top, files, _hash = await _world(store)
        await files_router.delete_file_by_id(None, files['spare'].id, user=user, db=None)
        return kb, files

    kb, files = asyncio.run(scenario())

    assert store.owners(kb.id) == [files['twin'].id]
