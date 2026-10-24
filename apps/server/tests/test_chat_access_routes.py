"""The chats router keeps each user's chats to themselves, and shares only what was shared.

Requests carry real tokens through the real auth dependencies, against
users, chats, share snapshots, groups and access grants in the test run's
migrated SQLite database. Only side effects are faked (events, task
cancellation, live response streams, context usage). Pinned:

- every per-chat route refuses a user who does not own the chat, and leaves
  the chat as it was;
- an admin reads another user's chat (GET /{id}), share links and chat list
  only with ENABLE_ADMIN_CHAT_ACCESS on, and cannot update, pin, archive,
  share, tag or move it even then (the message routes, delete and cloning a
  share are not pinned for admins here);
- a share link (/share/{share_id}) serves the snapshot to its owner, to users
  and group members granted read, and to anonymous visitors only under an
  anyone grant; a pending user counts as anonymous;
- the share's grants are set by its owner only, filtered by the owner's
  sharing permissions, start empty on a new share and are cleared on unshare;
- cloning a share needs, for a user, the same grant as reading it.

Run from apps/server:

    python -m pytest tests/test_chat_access_routes.py
"""

from __future__ import annotations

import asyncio
import copy
import datetime as dt
import uuid
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.config import DEFAULT_USER_PERMISSIONS
from local_llm.models import chats as chats_model
from local_llm.models.access_grants import AccessGrants
from local_llm.models.chats import ChatForm, Chats
from local_llm.models.config import Config
from local_llm.models.groups import GroupForm, Groups
from local_llm.models.shared_chats import SharedChats
from local_llm.models.users import Users
from local_llm.routers import chats as chats_router
from local_llm.utils.auth import create_token


def _run(coro):
    return asyncio.run(coro)


def _user(role: str) -> SimpleNamespace:
    uid = f'chat-{role}-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, f'{role} user', f'{uid}@example.com', role=role))
    token = create_token({'id': uid}, dt.timedelta(minutes=30))
    return SimpleNamespace(id=uid, role=role, headers={'Authorization': f'Bearer {token}'})


@pytest.fixture(scope='module')
def people():
    return SimpleNamespace(
        owner=_user('user'),
        other=_user('user'),
        member=_user('user'),
        admin=_user('admin'),
        pending=_user('pending'),
    )


@pytest.fixture(scope='module')
def group(people):
    created = _run(
        Groups.insert_new_group(people.owner.id, GroupForm(name=f'g-{uuid.uuid4().hex[:6]}', description=''))
    )
    _run(Groups.add_users_to_group(created.id, [people.member.id]))
    return created


HISTORY = {
    'currentId': 'm2',
    'messages': {
        'm1': {'id': 'm1', 'parentId': None, 'childrenIds': ['m2'], 'role': 'user', 'content': 'private question'},
        'm2': {'id': 'm2', 'parentId': 'm1', 'childrenIds': [], 'role': 'assistant', 'content': 'private answer'},
    },
}


def _chat(owner) -> str:
    chat_id = str(uuid.uuid4())
    form = ChatForm(chat={'title': 'secret', 'history': copy.deepcopy(HISTORY), 'models': ['m'], 'tags': []})
    _run(Chats.insert_new_chat(chat_id, owner.id, form))
    return chat_id


@pytest.fixture
def config(monkeypatch):
    overrides: dict = {'user.permissions': copy.deepcopy(DEFAULT_USER_PERMISSIONS)}
    real_get = Config.get

    async def get(key, default=None):
        return overrides[key] if key in overrides else await real_get(key, default)

    monkeypatch.setattr(Config, 'get', get)
    return overrides


@pytest.fixture
def admin_chat_access(monkeypatch):
    def set_flag(value: bool):
        monkeypatch.setattr(chats_router, 'ENABLE_ADMIN_CHAT_ACCESS', value)
        monkeypatch.setattr(chats_model, 'ENABLE_ADMIN_CHAT_ACCESS', value)

    set_flag(False)
    return set_flag


@pytest.fixture
def client(monkeypatch, config, admin_chat_access):
    async def nothing(*_a, **_k):
        return None

    async def no_streams(*_a, **_k):
        return []

    async def no_tasks(*_a, **_k):
        return False

    monkeypatch.setattr(chats_router, 'publish_event', nothing)
    monkeypatch.setattr(chats_router, 'stop_item_tasks', nothing)
    monkeypatch.setattr(chats_router, 'get_response_streams_by_chat_id', no_streams)
    monkeypatch.setattr(chats_router, 'get_chat_context_usage', nothing)
    monkeypatch.setattr(chats_router, 'has_active_tasks', no_tasks)
    app = FastAPI()
    app.state.redis = None
    app.include_router(chats_router.router, prefix='/chats')
    return TestClient(app)


def _content(chat_id):
    chat = _run(Chats.get_chat_by_id(chat_id))
    return chat and {
        'title': chat.title,
        'messages': {mid: m.get('content') for mid, m in chat.chat['history']['messages'].items()},
        'pinned': chat.pinned,
        'archived': chat.archived,
        'share_id': chat.share_id,
        'folder_id': chat.folder_id,
        'tags': chat.meta.get('tags', []),
    }


# --- the live chat ------------------------------------------------------------


def test_the_owner_reads_their_chat(client, people):
    chat_id = _chat(people.owner)
    r = client.get(f'/chats/{chat_id}', headers=people.owner.headers)
    assert r.status_code == 200
    assert r.json()['chat']['history']['messages']['m2']['content'] == 'private answer'


def test_another_user_cannot_read_it(client, people):
    chat_id = _chat(people.owner)
    for who in (people.other, people.member):
        r = client.get(f'/chats/{chat_id}', headers=who.headers)
        assert r.status_code == 401 and 'private' not in r.text
        assert client.get(f'/chats/{chat_id}/tags', headers=who.headers).status_code == 401
    assert client.get(f'/chats/{chat_id}', headers=people.pending.headers).status_code == 401
    assert client.get(f'/chats/{chat_id}').status_code == 401


def test_an_admin_reads_another_users_chat_only_with_admin_chat_access(client, people, admin_chat_access):
    chat_id = _chat(people.owner)
    assert client.get(f'/chats/{chat_id}', headers=people.admin.headers).status_code == 401
    assert client.get(f'/chats/share/{chat_id}', headers=people.admin.headers).status_code == 401
    assert client.get(f'/chats/list/user/{people.owner.id}', headers=people.admin.headers).status_code == 401
    admin_chat_access(True)
    assert client.get(f'/chats/{chat_id}', headers=people.admin.headers).status_code == 200
    assert client.get(f'/chats/share/{chat_id}', headers=people.admin.headers).status_code == 200
    listed = client.get(f'/chats/list/user/{people.owner.id}', headers=people.admin.headers)
    assert chat_id in [chat['id'] for chat in listed.json()]


def test_a_user_cannot_list_another_users_chats(client, people, admin_chat_access):
    admin_chat_access(True)
    assert client.get(f'/chats/list/user/{people.owner.id}', headers=people.other.headers).status_code == 401
    assert client.get('/chats/all/db', headers=people.other.headers).status_code == 401


def _refusals(chat_id, owner_id):
    """(method, path, json) for every route that acts on one chat as its owner."""
    return [
        ('post', f'/chats/{chat_id}', {'chat': {'title': 'pwned', 'history': {'messages': {}}}}),
        ('post', f'/chats/{chat_id}/messages/m2', {'content': 'pwned'}),
        ('delete', f'/chats/{chat_id}/messages/m2', None),
        ('post', f'/chats/{chat_id}/messages/m2/event', {'type': 'replace', 'data': {'content': 'pwned'}}),
        ('get', f'/chats/{chat_id}/pinned', None),
        ('post', f'/chats/{chat_id}/pin', None),
        ('post', f'/chats/{chat_id}/archive', None),
        ('post', f'/chats/{chat_id}/clone', {'title': 'mine now'}),
        ('post', f'/chats/{chat_id}/fork', {'message_id': 'm2'}),
        ('post', f'/chats/{chat_id}/compact', None),
        ('post', f'/chats/{chat_id}/share', None),
        ('delete', f'/chats/{chat_id}/share', None),
        ('post', f'/chats/{chat_id}/folder', {'folder_id': None}),
        ('post', f'/chats/{chat_id}/tags', {'name': 'pwned'}),
        ('delete', f'/chats/{chat_id}/tags', {'name': 'secret'}),
        ('post', f'/chats/{chat_id}/unread', None),
        ('get', f'/chats/shared/{chat_id}/access', None),
        (
            'post',
            f'/chats/shared/{chat_id}/access/update',
            {'access_grants': [{'principal_type': 'user', 'principal_id': owner_id, 'permission': 'read'}]},
        ),
        ('delete', f'/chats/{chat_id}', None),
    ]


def test_every_owner_route_refuses_another_user_and_changes_nothing(client, people):
    chat_id = _chat(people.owner)
    before = _content(chat_id)
    for method, path, body in _refusals(chat_id, people.other.id):
        r = client.request(method, path, json=body, headers=people.other.headers)
        assert r.status_code in (401, 403, 404), (method, path, r.status_code, r.text)
        assert 'private' not in r.text, (method, path)
    assert _content(chat_id) == before
    assert _run(AccessGrants.get_grants_by_resource('shared_chat', chat_id)) == []
    assert _run(SharedChats.get_chat_ids_by_user_id(people.other.id)) == []
    assert _run(Chats.get_chat_list_by_user_id(people.other.id)) == []


def test_an_admin_never_edits_another_users_chat_through_the_owner_routes(client, people, admin_chat_access):
    admin_chat_access(True)
    chat_id = _chat(people.owner)
    before = _content(chat_id)
    owner_only = [
        ('post', f'/chats/{chat_id}', {'chat': {'title': 'pwned'}}),
        ('post', f'/chats/{chat_id}/pin', None),
        ('post', f'/chats/{chat_id}/archive', None),
        ('post', f'/chats/{chat_id}/share', None),
        ('post', f'/chats/{chat_id}/tags', {'name': 'pwned'}),
        ('post', f'/chats/{chat_id}/folder', {'folder_id': None}),
    ]
    for method, path, body in owner_only:
        r = client.request(method, path, json=body, headers=people.admin.headers)
        assert r.status_code == 401, (method, path, r.status_code)
    assert _content(chat_id) == before


def test_the_owner_can_delete_only_with_the_delete_permission(client, config, people):
    chat_id = _chat(people.owner)
    config['user.permissions']['chat']['delete'] = False
    assert client.delete(f'/chats/{chat_id}', headers=people.owner.headers).status_code == 401
    assert _content(chat_id) is not None
    config['user.permissions']['chat']['delete'] = True
    assert client.delete(f'/chats/{chat_id}', headers=people.owner.headers).json() is True
    assert _content(chat_id) is None


# --- share links --------------------------------------------------------------


def _share(client, owner, chat_id) -> str:
    r = client.post(f'/chats/{chat_id}/share', headers=owner.headers)
    assert r.status_code == 200, r.text
    return r.json()['share_id']


def _set_grants(client, owner, chat_id, grants):
    r = client.post(f'/chats/shared/{chat_id}/access/update', json={'access_grants': grants}, headers=owner.headers)
    assert r.status_code == 200, r.text
    return [
        (g['principal_type'], g['principal_id'], g['permission'])
        for g in client.get(f'/chats/shared/{chat_id}/access', headers=owner.headers).json()
    ]


def _reads(client, share_id, who=None):
    r = client.get(f'/chats/share/{share_id}', headers=who.headers if who else None)
    return r.status_code == 200


def test_sharing_needs_the_share_permission(client, config, people):
    chat_id = _chat(people.owner)
    config['user.permissions']['chat']['share'] = False
    assert client.post(f'/chats/{chat_id}/share', headers=people.owner.headers).status_code == 401
    assert _content(chat_id)['share_id'] is None


def test_a_new_share_is_private_to_its_owner(client, people, admin_chat_access):
    chat_id = _chat(people.owner)
    share_id = _share(client, people.owner, chat_id)
    assert _reads(client, share_id, people.owner)
    assert not _reads(client, share_id, people.other)
    assert not _reads(client, share_id, people.pending)
    assert not _reads(client, share_id)
    # The admin flag governs share links too.
    assert not _reads(client, share_id, people.admin)
    admin_chat_access(True)
    assert _reads(client, share_id, people.admin)


def test_a_share_serves_the_snapshot_not_the_live_chat(client, people):
    chat_id = _chat(people.owner)
    share_id = _share(client, people.owner, chat_id)
    _run(Chats.upsert_message_to_chat_by_id_and_message_id(chat_id, 'm2', {'content': 'written after sharing'}))
    shared = client.get(f'/chats/share/{share_id}', headers=people.owner.headers).json()
    assert shared['chat']['history']['messages']['m2']['content'] == 'private answer'


def test_a_user_grant_opens_the_share_to_that_user_only(client, people):
    chat_id = _chat(people.owner)
    share_id = _share(client, people.owner, chat_id)
    stored = _set_grants(
        client,
        people.owner,
        chat_id,
        [{'principal_type': 'user', 'principal_id': people.other.id, 'permission': 'read'}],
    )
    assert stored == [('user', people.other.id, 'read')]
    assert _reads(client, share_id, people.other)
    assert not _reads(client, share_id, people.member)
    assert not _reads(client, share_id)
    # The grant covers the snapshot, never the live chat.
    assert client.get(f'/chats/{chat_id}', headers=people.other.headers).status_code == 401


def test_a_group_grant_opens_the_share_to_its_members(client, people, group):
    chat_id = _chat(people.owner)
    share_id = _share(client, people.owner, chat_id)
    _set_grants(
        client, people.owner, chat_id, [{'principal_type': 'group', 'principal_id': group.id, 'permission': 'read'}]
    )
    assert _reads(client, share_id, people.member)
    assert not _reads(client, share_id, people.other)


def test_public_and_anyone_grants_need_their_sharing_permissions(client, config, people):
    chat_id = _chat(people.owner)
    share_id = _share(client, people.owner, chat_id)
    public = {'principal_type': 'user', 'principal_id': '*', 'permission': 'read'}
    anyone = {'principal_type': 'anyone', 'principal_id': '*', 'permission': 'read'}
    config['user.permissions']['sharing'].update({'public_chats': False, 'open_chats': False})
    assert _set_grants(client, people.owner, chat_id, [public, anyone]) == []
    assert not _reads(client, share_id, people.other)
    assert not _reads(client, share_id)

    config['user.permissions']['sharing']['public_chats'] = True
    assert _set_grants(client, people.owner, chat_id, [public, anyone]) == [('user', '*', 'read')]
    assert _reads(client, share_id, people.other)
    assert not _reads(client, share_id)

    config['user.permissions']['sharing']['open_chats'] = True
    assert sorted(_set_grants(client, people.owner, chat_id, [public, anyone])) == [
        ('anyone', '*', 'read'),
        ('user', '*', 'read'),
    ]
    assert _reads(client, share_id)
    # A pending user is no worse off than an anonymous visitor.
    assert _reads(client, share_id, people.pending)


def test_an_admin_sets_grants_on_another_users_share_only_with_admin_chat_access(client, people, admin_chat_access):
    chat_id = _chat(people.owner)
    _share(client, people.owner, chat_id)
    grant = {'principal_type': 'user', 'principal_id': people.admin.id, 'permission': 'read'}
    r = client.post(
        f'/chats/shared/{chat_id}/access/update', json={'access_grants': [grant]}, headers=people.admin.headers
    )
    assert r.status_code == 404
    assert client.get(f'/chats/shared/{chat_id}/access', headers=people.admin.headers).status_code == 404
    assert _run(AccessGrants.get_grants_by_resource('shared_chat', chat_id)) == []
    admin_chat_access(True)
    assert _set_grants(client, people.admin, chat_id, [grant]) == [('user', people.admin.id, 'read')]


def test_unsharing_closes_the_link_and_a_new_share_starts_without_old_grants(client, people):
    chat_id = _chat(people.owner)
    share_id = _share(client, people.owner, chat_id)
    _set_grants(
        client,
        people.owner,
        chat_id,
        [{'principal_type': 'user', 'principal_id': people.other.id, 'permission': 'read'}],
    )
    assert _reads(client, share_id, people.other)

    assert client.delete(f'/chats/{chat_id}/share', headers=people.owner.headers).json() is True
    assert not _reads(client, share_id, people.other)
    assert not _reads(client, share_id, people.owner)
    assert _content(chat_id)['share_id'] is None
    assert _run(AccessGrants.get_grants_by_resource('shared_chat', chat_id)) == []

    # Grants left behind by any earlier share do not carry over to a new one.
    _run(
        AccessGrants.set_access_grants(
            'shared_chat', chat_id, [{'principal_type': 'user', 'principal_id': people.other.id, 'permission': 'read'}]
        )
    )
    new_share_id = _share(client, people.owner, chat_id)
    assert new_share_id != share_id
    assert not _reads(client, new_share_id, people.other)


def test_resharing_refreshes_the_snapshot_under_the_same_link(client, people):
    chat_id = _chat(people.owner)
    share_id = _share(client, people.owner, chat_id)
    _run(Chats.upsert_message_to_chat_by_id_and_message_id(chat_id, 'm2', {'content': 'revised answer'}))
    assert _share(client, people.owner, chat_id) == share_id
    shared = client.get(f'/chats/share/{share_id}', headers=people.owner.headers).json()
    assert shared['chat']['history']['messages']['m2']['content'] == 'revised answer'


def test_an_unknown_share_id_is_refused(client, people):
    assert client.get('/chats/share/no-such-share', headers=people.owner.headers).status_code == 401
    assert client.get('/chats/share/no-such-share').status_code == 401


def test_the_shared_list_holds_only_the_callers_shares(client, people):
    chat_id = _chat(people.owner)
    share_id = _share(client, people.owner, chat_id)
    mine = client.get('/chats/shared', headers=people.owner.headers).json()
    assert share_id in [s['share_id'] for s in mine]
    theirs = client.get('/chats/shared', headers=people.other.headers).json()
    assert share_id not in [s['share_id'] for s in theirs]


# --- cloning a share ------------------------------------------------------------


def test_cloning_a_share_needs_a_grant(client, people):
    chat_id = _chat(people.owner)
    share_id = _share(client, people.owner, chat_id)
    r = client.post(f'/chats/{share_id}/clone/shared', headers=people.other.headers)
    assert r.status_code == 401 and 'private' not in r.text
    assert _run(Chats.get_chat_list_by_user_id(people.other.id)) == []

    _set_grants(
        client,
        people.owner,
        chat_id,
        [{'principal_type': 'user', 'principal_id': people.other.id, 'permission': 'read'}],
    )
    r = client.post(f'/chats/{share_id}/clone/shared', headers=people.other.headers)
    assert r.status_code == 200, r.text
    clone = r.json()
    assert clone['user_id'] == people.other.id and clone['id'] not in (chat_id, share_id)
    assert clone['chat']['history']['messages']['m2']['content'] == 'private answer'


def test_cloning_by_a_live_chat_id_is_refused(client, people):
    chat_id = _chat(people.owner)
    _share(client, people.owner, chat_id)
    assert client.post(f'/chats/{chat_id}/clone/shared', headers=people.other.headers).status_code == 401


def test_cloning_needs_the_import_permission(client, config, people):
    chat_id = _chat(people.owner)
    share_id = _share(client, people.owner, chat_id)
    config['user.permissions']['chat']['import'] = False
    assert client.post(f'/chats/{share_id}/clone/shared', headers=people.owner.headers).status_code == 403
    assert client.post(f'/chats/{chat_id}/clone', json={}, headers=people.owner.headers).status_code == 403
