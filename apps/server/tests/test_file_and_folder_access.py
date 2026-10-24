"""Who may read or write a file or a folder, through each path that confers access.

Pins utils/access_control/folders.py and files.py, with the model lookups
faked so each path is seen on its own:

- a folder grant reaches the folder's subfolders, ownership of any ancestor
  counts, a write grant does not imply read, and a corrupt parent loop ends;
- a file is readable through a knowledge base, a channel, a shared chat
  snapshot or a shared model that holds it, but writable through a knowledge
  base or model only when that object's owner also owns the file (otherwise
  a read-only file put into an object the user controls would become
  writable);
- folder attachments a user cannot read are dropped, and an admin keeps all.

Run from apps/server:

    python -m pytest tests/test_file_and_folder_access.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from local_llm.models import notes as notes_model
from local_llm.models import shared_chats as shared_model
from local_llm.utils.access_control import files as file_access
from local_llm.utils.access_control import folders as folder_access

ALICE = SimpleNamespace(id='alice', role='user')
ADMIN = SimpleNamespace(id='admin', role='admin')


def _run(coro):
    return asyncio.run(coro)


# --- folders ----------------------------------------------------------------


@pytest.fixture
def folder_tree(monkeypatch):
    """root (owner) > child > grandchild; grants as (user, folder, permission)."""
    folders = {
        'root': SimpleNamespace(id='root', user_id='owner', parent_id=None),
        'child': SimpleNamespace(id='child', user_id='owner', parent_id='root'),
        'grandchild': SimpleNamespace(id='grandchild', user_id='owner', parent_id='child'),
    }
    grants: set[tuple[str, str, str]] = set()

    async def get_folder_by_id(folder_id, db=None):
        return folders.get(folder_id)

    async def has_grant(user_id, resource_type, resource_id, permission='read', db=None, **_k):
        assert resource_type == 'folder'
        return (user_id, resource_id, permission) in grants

    monkeypatch.setattr(folder_access.Folders, 'get_folder_by_id', get_folder_by_id)
    monkeypatch.setattr(folder_access.AccessGrants, 'has_access', has_grant)
    return folders, grants


def _folder_access(user_id, folder_id, permission, tree):
    folders, _ = tree
    return _run(folder_access.has_folder_access(user_id, folders[folder_id], permission, None))


def test_the_owner_reaches_every_level(folder_tree):
    for folder_id in ('root', 'child', 'grandchild'):
        assert _folder_access('owner', folder_id, 'write', folder_tree)


def test_a_grant_on_an_ancestor_reaches_its_descendants_only(folder_tree):
    _, grants = folder_tree
    grants.add(('alice', 'child', 'read'))
    assert _folder_access('alice', 'grandchild', 'read', folder_tree)
    assert _folder_access('alice', 'child', 'read', folder_tree)
    assert not _folder_access('alice', 'root', 'read', folder_tree)


def test_read_does_not_confer_write(folder_tree):
    _, grants = folder_tree
    grants.add(('alice', 'root', 'read'))
    assert not _folder_access('alice', 'grandchild', 'write', folder_tree)
    grants.add(('alice', 'root', 'write'))
    assert _folder_access('alice', 'grandchild', 'write', folder_tree)


def test_a_stranger_has_no_access(folder_tree):
    assert not _folder_access('mallory', 'grandchild', 'read', folder_tree)


def test_a_parent_loop_ends_in_a_denial(folder_tree):
    folders, _ = folder_tree
    folders['root'].parent_id = 'grandchild'
    assert not _folder_access('mallory', 'grandchild', 'read', folder_tree)


def test_write_access_by_folder_id(folder_tree):
    _, grants = folder_tree
    grants.add(('alice', 'root', 'write'))
    assert _run(folder_access.has_folder_write_access('alice', 'child'))
    assert not _run(folder_access.has_folder_write_access('mallory', 'child'))
    assert not _run(folder_access.has_folder_write_access('owner', 'no-such-folder'))


# --- files ------------------------------------------------------------------


@pytest.fixture
def file_world(monkeypatch):
    """One file owned by `owner`, and every place it can be attached."""
    world = SimpleNamespace(
        file=SimpleNamespace(id='f1', user_id='owner', meta={}),
        knowledge=[],  # knowledge bases holding the file
        knowledge_by_id={},
        knowledge_grants=set(),  # (user, kb, permission)
        channels=[],  # channels holding the file that the caller is a member of
        shared_chat_ids=[],
        snapshots={},
        shared_chat_grants=set(),  # chat ids the caller may read
        model_owners={},  # model id -> owner id, models attaching the file
        model_grants=set(),  # (model, permission) the caller holds
        notes={},
        note_grants=set(),
    )

    async def get_file_by_id(file_id, db=None):
        return world.file if world.file and file_id == world.file.id else None

    async def get_knowledges_by_file_id(file_id, db=None):
        return world.knowledge

    async def get_knowledge_by_id(kb_id, db=None):
        return world.knowledge_by_id.get(kb_id)

    async def no_groups(user_id, db=None):
        return []

    async def get_channels(file_id, user_id, db=None):
        return world.channels

    async def get_shared_chat_ids(file_id, db=None):
        return world.shared_chat_ids

    async def get_snapshot(chat_id, db=None):
        return world.snapshots.get(chat_id)

    async def get_model_owners(file_id, db=None):
        return dict(world.model_owners)

    async def has_grant(user_id, resource_type, resource_id, permission='read', user_group_ids=None, db=None):
        if resource_type == 'knowledge':
            return (user_id, resource_id, permission) in world.knowledge_grants
        if resource_type == 'note':
            return (user_id, resource_id) in world.note_grants
        raise AssertionError(resource_type)

    async def accessible_ids(user_id, resource_type, resource_ids, permission='read', user_group_ids=None, db=None):
        if resource_type == 'shared_chat':
            return {rid for rid in resource_ids if rid in world.shared_chat_grants}
        if resource_type == 'model':
            return {rid for rid in resource_ids if (rid, permission) in world.model_grants}
        raise AssertionError(resource_type)

    async def check_kb_access(kb_id, user_id, permission, db=None, user_group_ids=None):
        return (user_id, kb_id, permission) in world.knowledge_grants

    async def get_note(note_id, db=None):
        return world.notes.get(note_id)

    monkeypatch.setattr(file_access.Files, 'get_file_by_id', get_file_by_id)
    monkeypatch.setattr(file_access.Knowledges, 'get_knowledges_by_file_id', get_knowledges_by_file_id)
    monkeypatch.setattr(file_access.Knowledges, 'get_knowledge_by_id', get_knowledge_by_id)
    monkeypatch.setattr(file_access.Knowledges, 'check_access_by_user_id', check_kb_access)
    monkeypatch.setattr(file_access.Groups, 'get_groups_by_member_id', no_groups)
    monkeypatch.setattr(file_access.Channels, 'get_channels_by_file_id_and_user_id', get_channels)
    monkeypatch.setattr(file_access.Chats, 'get_shared_chat_ids_by_file_id', get_shared_chat_ids)
    monkeypatch.setattr(shared_model.SharedChats, 'get_by_chat_id', get_snapshot)
    monkeypatch.setattr(file_access.Models, 'get_model_owners_attaching_file', get_model_owners)
    monkeypatch.setattr(file_access.AccessGrants, 'has_access', has_grant)
    monkeypatch.setattr(file_access.AccessGrants, 'get_accessible_resource_ids', accessible_ids)
    monkeypatch.setattr(notes_model.Notes, 'get_note_by_id', get_note)
    return world


def _can(access_type, world, user=ALICE):
    return _run(file_access.has_access_to_file(world.file.id if world.file else 'f1', access_type, user))


def test_a_missing_file_is_inaccessible(file_world):
    file_world.file = None
    assert not _can('read', file_world)


def test_the_owner_has_full_access(file_world):
    owner = SimpleNamespace(id='owner', role='user')
    assert _can('read', file_world, owner) and _can('write', file_world, owner)


def test_a_stranger_has_none(file_world):
    assert not _can('read', file_world) and not _can('write', file_world)


def test_a_knowledge_base_of_the_files_owner_confers_what_it_grants(file_world):
    file_world.knowledge = [SimpleNamespace(id='kb', user_id='owner')]
    file_world.knowledge_grants.add(('alice', 'kb', 'read'))
    assert _can('read', file_world) and not _can('write', file_world)
    file_world.knowledge_grants.add(('alice', 'kb', 'write'))
    assert _can('write', file_world)


def test_a_file_put_into_your_own_knowledge_base_stays_read_only(file_world):
    file_world.knowledge = [SimpleNamespace(id='kb-alice', user_id='alice')]
    assert _can('read', file_world)
    assert not _can('write', file_world)


def test_the_collection_named_in_the_files_meta_follows_the_same_rule(file_world):
    file_world.file.meta = {'collection_name': 'kb-meta'}
    file_world.knowledge_by_id['kb-meta'] = SimpleNamespace(id='kb-meta', user_id='alice')
    assert _can('read', file_world) and not _can('write', file_world)
    file_world.knowledge_by_id['kb-meta'] = SimpleNamespace(id='kb-meta', user_id='owner')
    file_world.knowledge_grants.add(('alice', 'kb-meta', 'write'))
    assert _can('write', file_world)


def test_a_channel_confers_read_only(file_world):
    file_world.channels = [SimpleNamespace(id='c1')]
    assert _can('read', file_world) and not _can('write', file_world)


def test_a_shared_chat_confers_read_on_its_snapshots_files_only(file_world):
    file_world.shared_chat_ids = ['c1']
    file_world.shared_chat_grants.add('c1')
    snapshot = {'history': {'messages': {'m': {'files': [{'type': 'file', 'id': 'f1'}]}}}}
    file_world.snapshots['c1'] = SimpleNamespace(chat_id='c1', chat=snapshot)
    assert _can('read', file_world) and not _can('write', file_world)
    # The same chat without a grant for the caller confers nothing.
    file_world.shared_chat_grants.clear()
    assert not _can('read', file_world)


def test_a_shared_model_confers_access_by_its_grant(file_world):
    file_world.model_owners = {'m1': 'owner'}
    file_world.model_grants.add(('m1', 'read'))
    assert _can('read', file_world) and not _can('write', file_world)
    file_world.model_grants.add(('m1', 'write'))
    assert _can('write', file_world)


def test_a_file_attached_to_your_own_model_stays_read_only(file_world):
    file_world.model_owners = {'m-alice': 'alice'}
    assert _can('read', file_world)
    assert not _can('write', file_world)
    # Nor does a write grant on someone else's model that only borrowed the file.
    file_world.model_owners = {'m-bob': 'bob'}
    file_world.model_grants.add(('m-bob', 'write'))
    assert not _can('write', file_world)


# --- folder attachments -------------------------------------------------------


ENTRIES = [
    {'type': 'file', 'id': 'f1'},
    {'type': 'collection', 'id': 'kb'},
    {'type': 'note', 'id': 'n-own'},
    {'type': 'note', 'id': 'n-shared'},
    {'type': 'note', 'id': 'n-private'},
    {'type': 'note', 'id': 'n-missing'},
]


def test_only_readable_attachments_survive(file_world):
    file_world.notes = {
        'n-own': SimpleNamespace(id='n-own', user_id='alice'),
        'n-shared': SimpleNamespace(id='n-shared', user_id='bob'),
        'n-private': SimpleNamespace(id='n-private', user_id='bob'),
    }
    file_world.note_grants.add(('alice', 'n-shared'))
    out = _run(file_access.get_accessible_folder_files(ENTRIES, ALICE))
    assert out == [{'type': 'note', 'id': 'n-own'}, {'type': 'note', 'id': 'n-shared'}]
    file_world.channels = [SimpleNamespace(id='c1')]
    file_world.knowledge_grants.add(('alice', 'kb', 'read'))
    out = _run(file_access.get_accessible_folder_files(ENTRIES, ALICE))
    assert [entry['id'] for entry in out] == ['f1', 'kb', 'n-own', 'n-shared']


def test_entries_that_cannot_be_checked_are_dropped_even_for_an_admin(file_world):
    junk = ['f1', {'type': 'web', 'id': 'x'}, {'type': 'file'}, {'type': 'file', 'id': 'f1'}]
    assert _run(file_access.get_accessible_folder_files(junk, ADMIN)) == [{'type': 'file', 'id': 'f1'}]
    assert _run(file_access.get_accessible_folder_files('not-a-list', ADMIN)) == []


def test_can_read_all_folder_files(file_world):
    assert _run(file_access.can_read_all_folder_files(None, ALICE))
    assert _run(file_access.can_read_all_folder_files([], ALICE))
    assert not _run(file_access.can_read_all_folder_files('junk', ALICE))
    assert not _run(file_access.can_read_all_folder_files([{'type': 'file', 'id': 'f1'}], ALICE))
    file_world.channels = [SimpleNamespace(id='c1')]
    assert _run(file_access.can_read_all_folder_files([{'type': 'file', 'id': 'f1'}], ALICE))


def test_a_folder_delegates_only_what_its_owner_can_still_read(file_world, monkeypatch):
    async def get_user(user_id, db=None):
        return SimpleNamespace(id=user_id, role='user') if user_id == 'alice' else None

    monkeypatch.setattr(file_access.Users, 'get_user_by_id', get_user)
    folder = SimpleNamespace(user_id='alice', data={'files': [{'type': 'file', 'id': 'f1'}]})
    assert _run(file_access.get_owner_accessible_folder_files(folder)) == []
    file_world.channels = [SimpleNamespace(id='c1')]
    assert _run(file_access.get_owner_accessible_folder_files(folder)) == [{'type': 'file', 'id': 'f1'}]
    assert _run(file_access.get_owner_accessible_folder_files(SimpleNamespace(user_id='alice', data={}))) == []
    gone = SimpleNamespace(user_id='deleted', data={'files': [{'type': 'file', 'id': 'f1'}]})
    assert _run(file_access.get_owner_accessible_folder_files(gone)) == []
