"""Every path that writes, removes, archives or unarchives chats keeps the
owner's tag rows in step with them (#645).

A user has a tag row for each tag that one of their chats, neither archived
nor internal, still uses. The single-chat routes kept that; these did not:

- the tag-generation task in a chat an admin continued created and cleaned
  up the admin's rows, not the owner's;
- deleting a folder with its chats left the tags only they used;
- deleting all chats and archiving all left orphaned rows, and unarchiving
  all never recreated the rows archiving dropped;
- moving an archived chat into a folder unarchives it, and did not recreate
  its rows either.

Runs against the test run's migrated SQLite database.

Run from apps/server:

    python -m pytest tests/test_chat_tag_upkeep.py
"""

import asyncio
import importlib
import uuid
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import update

from local_llm.internal.db import get_async_db_context, get_async_session
from local_llm.models.chats import Chat, ChatForm, Chats
from local_llm.models.folders import FolderForm, Folders
from local_llm.models.tags import Tags
from local_llm.models.users import Users
from local_llm.routers import chats as chats_router
from local_llm.routers import folders as folders_router
from local_llm.utils.auth import get_verified_user

# Importing the config runs the migrations on the test run's database.
importlib.import_module('local_llm.config')


def _run(coro):
    return asyncio.run(coro)


async def _nothing(*_a, **_k):
    return None


def _user(role: str = 'user') -> SimpleNamespace:
    uid = f'{role}-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, role, f'{uid}@example.com', role=role))
    return SimpleNamespace(id=uid, role=role)


def _chat(user_id: str, tags: list[str], folder_id: str | None = None) -> str:
    chat_id = str(uuid.uuid4())
    form = ChatForm(
        chat={'title': 't', 'history': {'currentId': None, 'messages': {}}, 'models': ['m']}, folder_id=folder_id
    )
    _run(Chats.insert_new_chat(chat_id, user_id, form))
    _run(Chats.update_chat_tags_by_id(chat_id, tags, SimpleNamespace(id=user_id)))
    return chat_id


def _tags(user_id: str) -> set[str]:
    return {t.id for t in _run(Tags.get_tags_by_user_id(user_id))}


def test_tags_generated_in_a_chat_an_admin_continues_are_the_owners():
    owner, admin = _user(), _user('admin')
    _chat(admin.id, ['Shared'])  # the admin's own chat, which keeps their row
    chat_id = _chat(owner.id, [])

    # The tag-generation task runs as whoever posted, here the admin.
    _run(Chats.update_chat_tags_by_id(chat_id, ['Shared', 'Math'], admin))
    assert _tags(owner.id) == {'shared', 'math'}
    assert _tags(admin.id) == {'shared'}

    # Retagging drops the owner's rows the chat no longer uses, not the admin's.
    _run(Chats.update_chat_tags_by_id(chat_id, ['Math'], admin))
    assert _tags(owner.id) == {'math'}
    assert _tags(admin.id) == {'shared'}


def test_deleting_a_folder_with_its_chats_drops_the_tags_only_they_used(monkeypatch):
    monkeypatch.setattr(folders_router, 'check_folders_permission', _nothing)
    monkeypatch.setattr(folders_router, 'publish_event', _nothing)
    owner = _user()
    work = _run(Folders.insert_new_folder(owner.id, FolderForm(name='Work')))
    sub = _run(Folders.insert_new_folder(owner.id, FolderForm(name='Sub'), parent_id=work.id))
    # 'project' only inside the folder, in two of its folders; 'kept' also outside it.
    _chat(owner.id, ['Project', 'Kept'], folder_id=work.id)
    _chat(owner.id, ['Project'], folder_id=sub.id)
    _chat(owner.id, ['Kept'])

    app = FastAPI()
    app.include_router(folders_router.router, prefix='/folders')
    app.dependency_overrides[get_verified_user] = lambda: SimpleNamespace(id=owner.id, role='user')
    app.dependency_overrides[get_async_session] = lambda: None
    r = TestClient(app).delete(f'/folders/{work.id}', params={'delete_contents': True})

    assert r.status_code == 200 and r.json() is True
    assert _tags(owner.id) == {'kept'}


def test_deleting_all_chats_drops_their_tags_and_no_one_elses(monkeypatch):
    monkeypatch.setattr(chats_router, 'publish_event', _nothing)
    owner, other = _user('admin'), _user()
    _chat(owner.id, ['Work'])
    _chat(other.id, ['Work'])

    assert _run(chats_router.delete_all_user_chats(SimpleNamespace(), user=owner, db=None)) is True
    assert _tags(owner.id) == set()
    assert _tags(other.id) == {'work'}


def test_archiving_all_drops_the_tags_and_unarchiving_all_brings_them_back(monkeypatch):
    monkeypatch.setattr(chats_router, 'publish_event', _nothing)
    owner, other = _user(), _user()
    _chat(owner.id, ['Work', 'Math'])
    _chat(owner.id, ['Work'])
    _chat(other.id, ['Work'])

    assert _run(chats_router.archive_all_chats(SimpleNamespace(), user=owner, db=None)) is True
    assert _tags(owner.id) == set()
    assert _tags(other.id) == {'work'}

    assert _run(chats_router.unarchive_all_chats(SimpleNamespace(), user=owner, db=None)) is True
    assert _tags(owner.id) == {'work', 'math'}
    assert _tags(other.id) == {'work'}


def test_moving_an_archived_chat_into_a_folder_brings_its_tags_back(monkeypatch):
    monkeypatch.setattr(chats_router, 'publish_event', _nothing)
    monkeypatch.setattr(chats_router, 'stop_item_tasks', _nothing)
    owner = _user()
    folder = _run(Folders.insert_new_folder(owner.id, FolderForm(name='Work')))
    chat_id = _chat(owner.id, ['Work'])
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(redis=None)))
    assert _run(chats_router.archive_chat_by_id(request, chat_id, user=owner, db=None)) is not None
    assert _tags(owner.id) == set()

    form = chats_router.ChatFolderIdForm(folder_id=folder.id)
    chat = _run(chats_router.update_chat_folder_id_by_id(request, chat_id, form, user=owner, db=None))
    assert chat is not None and chat.archived is False
    assert _tags(owner.id) == {'work'}


def test_a_chat_whose_tags_are_not_a_list_of_ids_does_not_stop_a_bulk_delete(monkeypatch):
    monkeypatch.setattr(chats_router, 'publish_event', _nothing)
    owner = _user('admin')
    _chat(owner.id, ['Work'])
    legacy = _chat(owner.id, [])

    async def corrupt():
        async with get_async_db_context() as session:
            await session.execute(update(Chat).filter_by(id=legacy).values(meta={'tags': [{'name': 'x'}, 3]}))
            await session.commit()

    _run(corrupt())
    assert _run(chats_router.delete_all_user_chats(SimpleNamespace(), user=owner, db=None)) is True
    assert _tags(owner.id) == set()
