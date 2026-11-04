"""An admin deleting another user's chat cleans up the owner's tags (#338).

Deleting a chat removes the tag rows only that chat used. The route did
that for the caller: an admin deleting someone else's chat deleted the
admin's own rows for those tags (when the admin used them in at most one
chat) and left the owner's orphaned rows. It now uses the chat's owner.

Runs against the test run's migrated SQLite database.

Run from apps/server:

    python -m pytest tests/test_admin_chat_delete_tags.py
"""

import asyncio
import uuid
from types import SimpleNamespace

from local_llm.models.chats import ChatForm, Chats
from local_llm.models.tags import Tags
from local_llm.models.users import Users
from local_llm.routers import chats as chats_router


def _run(coro):
    return asyncio.run(coro)


def _user(role: str) -> SimpleNamespace:
    uid = f'{role}-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, role, f'{uid}@example.com', role=role))
    return SimpleNamespace(id=uid, role=role)


def _tagged_chat(user_id: str, tags: list[str]) -> str:
    chat_id = str(uuid.uuid4())
    form = ChatForm(chat={'title': 't', 'history': {'currentId': None, 'messages': {}}, 'models': ['m']})
    _run(Chats.insert_new_chat(chat_id, user_id, form))
    user = SimpleNamespace(id=user_id)
    _run(Chats.update_chat_tags_by_id(chat_id, tags, user))
    return chat_id


def test_an_admin_deleting_a_users_chat_cleans_the_owners_tags_not_their_own(monkeypatch):
    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(chats_router, 'stop_item_tasks', nothing)
    monkeypatch.setattr(chats_router, 'publish_event', nothing)

    owner, admin = _user('user'), _user('admin')
    chat_id = _tagged_chat(owner.id, ['Work'])
    _tagged_chat(admin.id, ['Work'])  # the admin's own chat with the same tag

    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(redis=None)))
    assert _run(chats_router.delete_chat_by_id(request, chat_id, user=admin, db=None)) is True

    owner_tags = {t.id for t in _run(Tags.get_tags_by_user_id(owner.id))}
    admin_tags = {t.id for t in _run(Tags.get_tags_by_user_id(admin.id))}
    assert 'work' not in owner_tags  # the owner's only chat with it is gone
    assert 'work' in admin_tags  # the admin still uses it
