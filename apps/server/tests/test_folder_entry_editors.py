"""What a folder's editor may add to it, and what its owner may pass on (#358).

A folder's entries (files, knowledge bases, notes) reach the chats it is
attached to. Since notes count as readable through a readable folder, as
its files and knowledge bases do, the entries a folder carries are checked
on both sides:

- someone with write access to another user's folder may add only entries
  they can read themselves, not ones only the owner can read; a note or
  knowledge base, only one they own or may write, as sharing it on requires
  (an admin's folder would otherwise pass on any entry its editor could
  merely read);
- a note or knowledge base reaches the folder's chats only if the owner
  could share it on directly: they own it or may write it, as its own
  sharing requires, or if the chatting user may read it themselves (#846).

Requests carry real tokens through the real auth dependency, against users,
folders, notes, knowledge bases and grants in the test run's migrated SQLite database, and
the end-to-end cases read what a folder's reader gets in a chat's context.

Run from apps/server:

    python -m pytest tests/test_folder_entry_editors.py
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.models.access_grants import AccessGrants
from local_llm.models.folders import FolderForm, Folders
from local_llm.models.knowledge import KnowledgeForm, Knowledges
from local_llm.models.notes import NoteForm, Notes
from local_llm.models.users import Users
from local_llm.retrieval import utils as retrieval
from local_llm.routers import folders as folders_router
from local_llm.utils.access_control.files import get_owner_accessible_folder_files
from local_llm.utils.auth import create_token


def _run(coro):
    return asyncio.run(coro)


def _user(role: str = 'user') -> SimpleNamespace:
    uid = f'fe-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, 'folder user', f'{uid}@example.com', role=role))
    token = create_token({'id': uid}, dt.timedelta(minutes=30))
    return SimpleNamespace(id=uid, headers={'Authorization': f'Bearer {token}'})


def _note(owner, *readers, writers=()) -> str:
    note = _run(Notes.insert_new_note(owner.id, NoteForm(title='n', data={'content': {'md': 'text'}})))
    assert note is not None
    for reader in readers:
        _run(AccessGrants.grant_access('note', note.id, 'user', reader.id, 'read'))
    for writer in writers:
        _run(AccessGrants.grant_access('note', note.id, 'user', writer.id, 'write'))
    return note.id


def _kb(owner, *readers, writers=()) -> str:
    kb = _run(Knowledges.insert_new_knowledge(owner.id, KnowledgeForm(name='kb', description='')))
    assert kb is not None
    for reader in readers:
        _run(AccessGrants.grant_access('knowledge', kb.id, 'user', reader.id, 'read'))
    for writer in writers:
        _run(AccessGrants.grant_access('knowledge', kb.id, 'user', writer.id, 'write'))
    return kb.id


@pytest.fixture
def people():
    return SimpleNamespace(owner=_user(), editor=_user(), third=_user())


@pytest.fixture
def folder(people):
    created = _run(Folders.insert_new_folder(people.owner.id, FolderForm(name=f'f-{uuid.uuid4().hex[:6]}')))
    assert created is not None
    _run(AccessGrants.grant_access('folder', created.id, 'user', people.editor.id, 'write'))
    return created


@pytest.fixture
def client(monkeypatch):
    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(folders_router, 'publish_event', nothing)
    monkeypatch.setattr(folders_router, 'check_folders_permission', nothing)
    app = FastAPI()
    app.include_router(folders_router.router, prefix='/folders')
    return TestClient(app)


def _files(folder_id) -> list:
    stored = _run(Folders.get_folder_by_id(folder_id))
    return ((stored.data if stored else None) or {}).get('files') or []


def _save(client, who, folder_id, entries):
    return client.post(f'/folders/{folder_id}/update', json={'data': {'files': entries}}, headers=who.headers)


# --- An editor adds only what they can read ------------------------------------------


def test_an_editor_cannot_add_a_note_only_the_owner_can_read(client, people, folder):
    private = _note(people.owner)

    r = _save(client, people.editor, folder.id, [{'type': 'note', 'id': private}])

    assert r.status_code == 403
    assert _files(folder.id) == []


def test_an_editor_adds_a_note_they_may_write_and_the_owner_can_read(client, people, folder):
    shared = _note(people.third, people.owner, people.editor, writers=(people.editor,))

    r = _save(client, people.editor, folder.id, [{'type': 'note', 'id': shared}])

    assert r.status_code == 200, r.text
    assert _files(folder.id) == [{'type': 'note', 'id': shared}]


def test_an_editor_keeps_what_the_owner_put_in_while_adding_their_own(client, people, folder):
    private = _note(people.owner)
    shared = _note(people.third, people.owner, people.editor, writers=(people.editor,))
    assert _save(client, people.owner, folder.id, [{'type': 'note', 'id': private}]).status_code == 200

    r = _save(client, people.editor, folder.id, [{'type': 'note', 'id': private}, {'type': 'note', 'id': shared}])

    assert r.status_code == 200, r.text
    assert len(_files(folder.id)) == 2


def test_the_owner_adds_their_own_private_note(client, people, folder):
    private = _note(people.owner)

    assert _save(client, people.owner, folder.id, [{'type': 'note', 'id': private}]).status_code == 200


def test_an_editor_cannot_create_a_subfolder_holding_a_note_only_the_owner_can_read(client, people, folder):
    private = _note(people.owner)

    r = client.post(
        '/folders/',
        json={'name': 'sub', 'parent_id': folder.id, 'data': {'files': [{'type': 'note', 'id': private}]}},
        headers=people.editor.headers,
    )

    assert r.status_code == 403
    assert _run(Folders.get_children_folders_by_id_and_user_id(folder.id, people.owner.id)) in (None, [])


def test_an_editor_cannot_add_a_knowledge_base_they_may_only_read(client, people, folder):
    kb = _kb(people.third, people.owner, people.editor)

    r = _save(client, people.editor, folder.id, [{'type': 'collection', 'id': kb}])

    assert r.status_code == 403
    assert _files(folder.id) == []


def test_an_editor_adds_a_knowledge_base_they_may_write_and_the_owner_can_read(client, people, folder):
    kb = _kb(people.third, people.owner, people.editor, writers=(people.editor,))

    r = _save(client, people.editor, folder.id, [{'type': 'collection', 'id': kb}])

    assert r.status_code == 200, r.text
    assert _files(folder.id) == [{'type': 'collection', 'id': kb}]


def test_the_owner_adds_a_knowledge_base_they_may_only_read(client, people, folder):
    kb = _kb(people.third, people.owner)

    assert _save(client, people.owner, folder.id, [{'type': 'collection', 'id': kb}]).status_code == 200


def test_an_editor_cannot_create_a_subfolder_holding_a_knowledge_base_they_may_only_read(client, people, folder):
    kb = _kb(people.third, people.owner, people.editor)

    r = client.post(
        '/folders/',
        json={'name': 'sub', 'parent_id': folder.id, 'data': {'files': [{'type': 'collection', 'id': kb}]}},
        headers=people.editor.headers,
    )

    assert r.status_code == 403


# --- The owner passes on a note or knowledge base only as they could share it ---------


def _delegated(owner, entry_id, entry_type='note') -> list:
    stored = _run(Folders.insert_new_folder(owner.id, FolderForm(name=f'd-{uuid.uuid4().hex[:6]}')))
    assert stored is not None
    updated = _run(
        Folders.update_folder_by_id_and_user_id(
            stored.id,
            owner.id,
            folders_router.FolderUpdateForm(data={'files': [{'type': entry_type, 'id': entry_id}]}),
        )
    )
    assert updated is not None
    return _run(get_owner_accessible_folder_files(updated))


def test_a_folder_passes_on_its_owners_own_note(people):
    note = _note(people.owner)

    assert _delegated(people.owner, note) == [{'type': 'note', 'id': note}]


def test_a_folder_passes_on_a_note_its_owner_may_write(people):
    note = _note(people.third, people.owner, writers=(people.owner,))

    assert _delegated(people.owner, note) == [{'type': 'note', 'id': note}]


def test_a_folder_does_not_pass_on_a_note_its_owner_may_only_read(people):
    # Sharing a note on needs its owner, an admin or write on it; a folder is not a way round that.
    note = _note(people.third, people.owner)

    assert _delegated(people.owner, note) == []


def test_a_folder_passes_on_a_knowledge_base_only_if_its_owner_may_write_it(people):
    read_only = _kb(people.third, people.owner)
    writable = _kb(people.third, writers=(people.owner,))
    own = _kb(people.owner)

    assert _delegated(people.owner, read_only, 'collection') == []
    assert _delegated(people.owner, writable, 'collection') == [{'type': 'collection', 'id': writable}]
    assert _delegated(people.owner, own, 'collection') == [{'type': 'collection', 'id': own}]


# --- End to end: what a folder's reader gets in a chat's context ---------------------


def _context(reader, folder_id, monkeypatch) -> list:
    """The documents a chat of `reader` gets from attaching the folder."""

    async def defaults(key, default=None):
        return default

    monkeypatch.setattr(retrieval.Config, 'get', defaults)
    user = _run(Users.get_user_by_id(reader.id))
    sources = _run(
        retrieval.get_sources_from_items(
            None,
            [{'type': 'folder', 'id': folder_id}],
            ['q'],
            embedding_function=None,
            k=4,
            reranking_function=None,
            k_reranker=None,
            r=0.0,
            hybrid_bm25_weight=0.5,
            hybrid_search=False,
            user=user,
        )
    )
    return [document for source in sources for document in source.get('document', [])]


def _note_text(note_id) -> str:
    note = _run(Notes.get_note_by_id(note_id))
    assert note is not None and note.data is not None
    return note.data['content']['md']


def test_an_editor_of_an_admins_folder_cannot_pass_on_a_note_they_may_only_read(client, monkeypatch):
    admin, editor, reader, third = _user('admin'), _user(), _user(), _user()
    folder = _run(Folders.insert_new_folder(admin.id, FolderForm(name=f'a-{uuid.uuid4().hex[:6]}')))
    assert folder is not None
    _run(AccessGrants.grant_access('folder', folder.id, 'user', editor.id, 'write'))
    _run(AccessGrants.grant_access('folder', folder.id, 'user', reader.id, 'read'))
    note = _note(third, editor)

    r = _save(client, editor, folder.id, [{'type': 'note', 'id': note}])

    assert r.status_code == 403
    assert _context(reader, folder.id, monkeypatch) == []


def test_a_note_an_editor_may_write_reaches_the_folders_reader(client, people, folder, monkeypatch):
    reader = _user()
    _run(AccessGrants.grant_access('folder', folder.id, 'user', reader.id, 'read'))
    note = _note(people.third, people.owner, people.editor, writers=(people.owner, people.editor))

    assert _save(client, people.editor, folder.id, [{'type': 'note', 'id': note}]).status_code == 200
    assert _context(reader, folder.id, monkeypatch) == [_note_text(note)]


def test_a_note_the_owner_may_only_read_is_kept_but_not_passed_on(client, people, folder, monkeypatch):
    # Stored, as the owner may read it, but passed on through the folder to no
    # one else, since the owner may not share it on. The owner's own chats in
    # the folder use it, as attaching the note itself would (#846).
    reader = _user()
    _run(AccessGrants.grant_access('folder', folder.id, 'user', reader.id, 'read'))
    note = _note(people.third, people.owner)

    assert _save(client, people.owner, folder.id, [{'type': 'note', 'id': note}]).status_code == 200
    assert _files(folder.id) == [{'type': 'note', 'id': note}]
    assert _context(reader, folder.id, monkeypatch) == []
    assert _context(people.owner, folder.id, monkeypatch) == [_note_text(note)]


def test_an_editor_of_an_admins_folder_creates_a_subfolder_only_with_notes_they_may_write(client, monkeypatch):
    admin, editor, third = _user('admin'), _user(), _user()
    parent = _run(Folders.insert_new_folder(admin.id, FolderForm(name=f'p-{uuid.uuid4().hex[:6]}')))
    assert parent is not None
    _run(AccessGrants.grant_access('folder', parent.id, 'user', editor.id, 'write'))
    read_only = _note(third, editor)
    writable = _note(third, editor, writers=(editor,))

    def create(note_id):
        body = {
            'name': f's-{uuid.uuid4().hex[:6]}',
            'parent_id': parent.id,
            'data': {'files': [{'type': 'note', 'id': note_id}]},
        }
        return client.post('/folders/', json=body, headers=editor.headers)

    assert create(read_only).status_code == 403
    assert create(writable).status_code == 200
