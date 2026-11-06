"""Deleting a folder deletes its subtree in one transaction, and a failure is reported (#281).

`delete_folder_by_id_and_user_id` deleted and committed each child folder on
its own and swallowed any error into `[]`. A failure part way left some of the
subtree deleted, and the route, told no folder was, moved or deleted none of
their chats and still answered success: the chats kept a `folder_id` that no
longer existed, and the sidebar hid them. The subtree now goes in one commit,
an error reaches the route, and the route moves or deletes the chats before
it removes any folder.

Runs against the test run's migrated SQLite database.

Run from apps/server:

    python -m pytest tests/test_folder_delete_subtree.py
"""

import asyncio
import importlib
import uuid
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from local_llm.internal.db import get_async_session
from local_llm.models.chats import ChatForm, Chats
from local_llm.models.folders import FolderForm, Folders
from local_llm.models.users import Users
from local_llm.routers import folders as folders_router
from local_llm.utils.auth import get_verified_user

# Importing the config runs the migrations on the test run's database.
importlib.import_module('local_llm.config')


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def tree():
    """A user's folder Work > Sub > Deep, with a chat in each."""
    tag = uuid.uuid4().hex[:8]

    async def build():
        user = await Users.insert_new_user(f'u-{tag}', 'Una', f'u-{tag}@example.invalid', role='user')
        work = await Folders.insert_new_folder(user.id, FolderForm(name='Work'))
        sub = await Folders.insert_new_folder(user.id, FolderForm(name='Sub'), parent_id=work.id)
        deep = await Folders.insert_new_folder(user.id, FolderForm(name='Deep'), parent_id=sub.id)
        for folder in (work, sub, deep):
            await Chats.insert_new_chat(
                f'{folder.name}-{tag}', user.id, ChatForm(chat={'title': 'x'}, folder_id=folder.id)
            )
        return SimpleNamespace(
            user=user, ids=[work.id, sub.id, deep.id], chats=[f'{n}-{tag}' for n in ('Work', 'Sub', 'Deep')]
        )

    return _run(build())


async def _folders_left(ids, user_id):
    return [fid for fid in ids if await Folders.get_folder_by_id_and_user_id(fid, user_id)]


def test_a_failed_delete_leaves_every_folder_and_says_so(tree, monkeypatch):
    real_commit = AsyncSession.commit

    async def failing_commit(self):
        raise RuntimeError('database went away')

    monkeypatch.setattr(AsyncSession, 'commit', failing_commit)
    with pytest.raises(RuntimeError):
        _run(Folders.delete_folder_by_id_and_user_id(tree.ids[0], tree.user.id))
    monkeypatch.setattr(AsyncSession, 'commit', real_commit)

    assert _run(_folders_left(tree.ids, tree.user.id)) == tree.ids


def test_the_subtree_is_deleted_and_its_ids_returned(tree):
    assert sorted(_run(Folders.delete_folder_by_id_and_user_id(tree.ids[0], tree.user.id))) == sorted(tree.ids)
    assert _run(_folders_left(tree.ids, tree.user.id)) == []


def _client(user, monkeypatch):
    async def allowed(*_a, **_k):
        return None

    async def publish(*_a, **_k):
        return None

    monkeypatch.setattr(folders_router, 'check_folders_permission', allowed)
    monkeypatch.setattr(folders_router, 'publish_event', publish)
    app = FastAPI()
    app.include_router(folders_router.router, prefix='/folders')
    app.dependency_overrides[get_verified_user] = lambda: SimpleNamespace(id=user.id, role='user')
    app.dependency_overrides[get_async_session] = lambda: None
    return TestClient(app)


def test_deleting_a_folder_keeping_its_chats_moves_them_all_out(tree, monkeypatch):
    r = _client(tree.user, monkeypatch).delete(f'/folders/{tree.ids[0]}', params={'delete_contents': False})

    assert r.status_code == 200 and r.json() is True
    assert _run(_folders_left(tree.ids, tree.user.id)) == []
    assert [_run(Chats.get_chat_by_id(cid)).folder_id for cid in tree.chats] == [None, None, None]


def test_a_failed_folder_delete_is_an_error_and_hides_no_chat(tree, monkeypatch):
    async def fail(*_a, **_k):
        raise RuntimeError('database went away')

    monkeypatch.setattr(folders_router.Folders, 'delete_folder_by_id_and_user_id', fail)
    r = _client(tree.user, monkeypatch).delete(f'/folders/{tree.ids[0]}', params={'delete_contents': False})

    assert r.status_code == 400
    # The chats were moved out first, so none points at a folder that is gone.
    assert [_run(Chats.get_chat_by_id(cid)).folder_id for cid in tree.chats] == [None, None, None]


def test_deleting_a_folder_with_its_chats_deletes_them_all(tree, monkeypatch):
    r = _client(tree.user, monkeypatch).delete(f'/folders/{tree.ids[0]}', params={'delete_contents': True})

    assert r.status_code == 200 and r.json() is True
    assert _run(_folders_left(tree.ids, tree.user.id)) == []
    assert [_run(Chats.get_chat_by_id(cid)) for cid in tree.chats] == [None, None, None]


def test_a_failed_chat_move_is_an_error_and_deletes_no_folder(tree, monkeypatch):
    async def refuse(*_a, **_k):
        return False

    monkeypatch.setattr(folders_router.Chats, 'move_chats_by_user_id_and_folder_id', refuse)
    r = _client(tree.user, monkeypatch).delete(f'/folders/{tree.ids[0]}', params={'delete_contents': False})

    assert r.status_code == 400
    # The chats stayed in folders that still exist.
    assert _run(_folders_left(tree.ids, tree.user.id)) == tree.ids


def _without_chat_delete(monkeypatch):
    async def has_permission(user_id, key, *_a, **_k):
        return key != 'chat.delete'

    monkeypatch.setattr(folders_router, 'has_permission', has_permission)


def test_without_chat_delete_a_folder_can_still_be_deleted_keeping_its_chats(tree, monkeypatch):
    """Keeping the chats only moves them, so it needs no chat delete permission (#316)."""
    _without_chat_delete(monkeypatch)

    r = _client(tree.user, monkeypatch).delete(f'/folders/{tree.ids[0]}', params={'delete_contents': False})

    assert r.status_code == 200 and r.json() is True
    assert _run(_folders_left(tree.ids, tree.user.id)) == []
    assert [_run(Chats.get_chat_by_id(cid)).folder_id for cid in tree.chats] == [None, None, None]


def test_without_chat_delete_deleting_a_folder_with_its_chats_is_refused(tree, monkeypatch):
    _without_chat_delete(monkeypatch)

    r = _client(tree.user, monkeypatch).delete(f'/folders/{tree.ids[0]}', params={'delete_contents': True})

    assert r.status_code == 403
    assert _run(_folders_left(tree.ids, tree.user.id)) == tree.ids
    assert all(_run(Chats.get_chat_by_id(cid)) for cid in tree.chats)


@pytest.mark.parametrize('delete_contents', [False, True], ids=['keeping_chats', 'deleting_chats'])
def test_another_users_chat_in_a_deleted_folder_moves_out_and_is_kept(tree, monkeypatch, delete_contents):
    """A shared folder can hold a write grantee's chats; deleting it moved or
    deleted only the owner's, and left the others pointing at a folder that
    was gone, where their sidebars hid them (#315)."""
    tag = uuid.uuid4().hex[:8]

    async def grantee_chat():
        other = await Users.insert_new_user(f'g-{tag}', 'Gil', f'g-{tag}@example.invalid', role='user')
        await Chats.insert_new_chat(f'g-{tag}', other.id, ChatForm(chat={'title': 'theirs'}, folder_id=tree.ids[1]))
        return f'g-{tag}'

    chat_id = _run(grantee_chat())

    r = _client(tree.user, monkeypatch).delete(f'/folders/{tree.ids[0]}', params={'delete_contents': delete_contents})

    assert r.status_code == 200
    kept = _run(Chats.get_chat_by_id(chat_id))
    assert kept is not None
    assert kept.folder_id is None


def test_a_failed_move_of_other_users_chats_is_an_error_and_deletes_no_folder(tree, monkeypatch):
    async def failing(*_a, **_k):
        raise RuntimeError('database went away')

    monkeypatch.setattr(folders_router.Chats, 'move_other_users_chats_out_of_folders', failing)

    r = _client(tree.user, monkeypatch).delete(f'/folders/{tree.ids[0]}', params={'delete_contents': False})

    assert r.status_code == 400
    assert _run(_folders_left(tree.ids, tree.user.id)) == tree.ids
    # Nothing was changed before it: the owner's chats are still in their folders.
    assert [_run(Chats.get_chat_by_id(cid)).folder_id for cid in tree.chats] == tree.ids
