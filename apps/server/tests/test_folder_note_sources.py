"""A note in a folder the user may read reaches RAG, as the folder's files do (#358).

Attaching a folder expands it to its entries, and the files and knowledge
bases among them count as readable because access was checked on the
folder. Notes did not: `_note_item` accepted only an admin, the owner or a
direct grant, so a shared folder's notes were silently left out of the
context.

Run from apps/server:

    python -m pytest tests/test_folder_note_sources.py
"""

import asyncio
from types import SimpleNamespace

from local_llm.retrieval import utils as retrieval

USER = SimpleNamespace(id='u1', role='user')
NOTES = {
    'n_folder': SimpleNamespace(
        id='n_folder', user_id='owner', title='Folder note', data={'content': {'md': 'folder note'}}
    ),
    'n_private': SimpleNamespace(id='n_private', user_id='owner', title='Private', data={'content': {'md': 'private'}}),
}
FOLDERS = {
    'shared': SimpleNamespace(id='shared', user_id='owner', data={}),
    'other': SimpleNamespace(id='other', user_id='owner', data={}),
}
READABLE_FOLDERS = {'shared'}
READERS = []
FOLDER_ENTRIES = {'shared': [{'type': 'note', 'id': 'n_folder'}], 'other': [{'type': 'note', 'id': 'n_private'}]}


def _sources(monkeypatch, items):
    async def note(note_id, db=None):
        return NOTES.get(note_id)

    async def no_grant(**_kwargs):
        return False

    async def folder(folder_id, db=None):
        return FOLDERS.get(folder_id)

    async def folder_access(user_id, folder, permission, db=None):
        return folder.id in READABLE_FOLDERS

    async def entries(folder, db=None, reader=None):
        READERS.append(reader)
        return [dict(e) for e in FOLDER_ENTRIES[folder.id]]

    async def config_get(key, default=None):
        return default

    monkeypatch.setattr(retrieval.Notes, 'get_note_by_id', note)
    monkeypatch.setattr(retrieval.AccessGrants, 'has_access', no_grant)
    monkeypatch.setattr(retrieval.Folders, 'get_folder_by_id', folder)
    monkeypatch.setattr(retrieval, 'has_folder_access', folder_access)
    monkeypatch.setattr(retrieval, 'get_owner_accessible_folder_files', entries)
    monkeypatch.setattr(retrieval.Config, 'get', config_get)

    sources = asyncio.run(
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
    return [doc for source in sources for doc in source.get('document', [])]


def test_a_note_in_a_readable_folder_reaches_the_context(monkeypatch):
    assert _sources(monkeypatch, [{'type': 'folder', 'id': 'shared'}]) == ['folder note']


def test_a_note_in_a_folder_the_user_cannot_read_does_not(monkeypatch):
    assert _sources(monkeypatch, [{'type': 'folder', 'id': 'other'}]) == []


def test_a_note_attached_on_its_own_still_needs_its_own_access(monkeypatch):
    assert _sources(monkeypatch, [{'type': 'note', 'id': 'n_folder'}]) == []


def test_the_folders_entries_are_judged_for_the_chatting_user_too(monkeypatch):
    """The folder keeps what the user may read themselves, so it is asked about them (#846)."""
    READERS.clear()
    _sources(monkeypatch, [{'type': 'folder', 'id': 'shared'}])
    assert READERS == [USER]
