"""What a folder's editor may add to it, and what its owner may pass on (#358).

A folder's entries (files, knowledge bases, notes) reach the chats it is
attached to. Since notes count as readable through a readable folder, as
its files and knowledge bases do, the entries a folder carries are checked
on both sides:

- someone with write access to another user's folder may add only entries
  they can read themselves, not ones only the owner can read;
- a note reaches the folder's chats only if the owner could share it on
  directly: they own it or may write it, as the note's own sharing requires.

Requests carry real tokens through the real auth dependency, against users,
folders, notes and grants in the test run's migrated database.

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
from local_llm.models.notes import NoteForm, Notes
from local_llm.models.users import Users
from local_llm.routers import folders as folders_router
from local_llm.utils.access_control.files import get_owner_accessible_folder_files
from local_llm.utils.auth import create_token


def _run(coro):
    return asyncio.run(coro)


def _user() -> SimpleNamespace:
    uid = f'fe-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, 'folder user', f'{uid}@example.com', role='user'))
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


def test_an_editor_adds_a_note_they_and_the_owner_can_read(client, people, folder):
    shared = _note(people.third, people.owner, people.editor)

    r = _save(client, people.editor, folder.id, [{'type': 'note', 'id': shared}])

    assert r.status_code == 200, r.text
    assert _files(folder.id) == [{'type': 'note', 'id': shared}]


def test_an_editor_keeps_what_the_owner_put_in_while_adding_their_own(client, people, folder):
    private = _note(people.owner)
    shared = _note(people.third, people.owner, people.editor)
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


# --- The owner passes on a note only as they could share it directly ------------------


def _delegated(owner, note_id) -> list:
    stored = _run(Folders.insert_new_folder(owner.id, FolderForm(name=f'd-{uuid.uuid4().hex[:6]}')))
    assert stored is not None
    updated = _run(
        Folders.update_folder_by_id_and_user_id(
            stored.id,
            owner.id,
            folders_router.FolderUpdateForm(data={'files': [{'type': 'note', 'id': note_id}]}),
        )
    )
    assert updated is not None
    return _run(get_owner_accessible_folder_files(updated))


def test_a_folder_passes_on_its_owners_own_note(people):
    note = _note(people.owner)

    assert _delegated(people.owner, note) == [{'type': 'note', 'id': note}]


def test_a_folder_passes_on_a_note_its_owner_may_write(people):
    note = _note(people.third, writers=(people.owner,))

    assert _delegated(people.owner, note) == [{'type': 'note', 'id': note}]


def test_a_folder_does_not_pass_on_a_note_its_owner_may_only_read(people):
    # Sharing a note on needs its owner, an admin or write on it; a folder is not a way round that.
    note = _note(people.third, people.owner)

    assert _delegated(people.owner, note) == []
