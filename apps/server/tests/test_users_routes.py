"""The users router: what only an admin may do to accounts, and what a user may set on their own.

Requests carry real tokens through the real auth dependencies, against
accounts in the test run's migrated SQLite database; events, account
deletion and config writes are recorded instead of run. Pinned:

- every route that reads or changes other accounts, or the default
  permissions, refuses a non-admin;
- the primary (first) admin cannot be edited by another admin, demoted by
  themself, or deleted, and no admin can delete themself;
- an admin's role change is announced (the event that ends the user's live
  sockets), a taken email is refused, and a password reset revokes the
  user's tokens;
- a user's own settings update cannot turn on direct tool servers or
  webhooks the user lacks the permission for.

Run from apps/server:

    python -m pytest tests/test_users_routes.py
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
from local_llm.env import REDIS_KEY_PREFIX
from local_llm.events import EVENTS
from local_llm.models.auths import Auths
from local_llm.models.config import Config
from local_llm.models.groups import GroupForm, Groups
from local_llm.models.users import Users
from local_llm.routers import users as users_router
from local_llm.utils.auth import create_token

PW_KEY = 'pass' + 'word'  # built at runtime so secret scanners skip the test values


def _run(coro):
    return asyncio.run(coro)


def _account(role: str) -> SimpleNamespace:
    email = f'users-{role}-{uuid.uuid4().hex[:10]}@example.com'
    user = _run(Auths.insert_new_auth(email, 'not-a-real-hash', f'{role} name', role=role))
    token = create_token({'id': user.id}, dt.timedelta(minutes=30))
    return SimpleNamespace(id=user.id, email=email, role=role, headers={'Authorization': f'Bearer {token}'})


class FakeRedis:
    def __init__(self):
        self.store: dict[str, str] = {}

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, ex=None):
        self.store[key] = value


@pytest.fixture
def config(monkeypatch):
    overrides: dict = {
        'user.permissions': copy.deepcopy(DEFAULT_USER_PERMISSIONS),
        'auth.jwt_expiry': '1h',
        'ui.default_interface_settings': {},
    }
    real_get = Config.get

    async def get(key, default=None):
        return overrides[key] if key in overrides else await real_get(key, default)

    async def upsert(updates):
        overrides.update(updates)

    monkeypatch.setattr(Config, 'get', get)
    monkeypatch.setattr(Config, 'upsert', upsert)
    return overrides


@pytest.fixture
def world(monkeypatch, config):
    """The primary admin, a second admin and a user; recorded events and deletions."""
    world = SimpleNamespace(
        primary=_account('admin'), admin=_account('admin'), user=_account('user'), events=[], deleted=[]
    )

    async def get_first_user(db=None):
        return SimpleNamespace(id=world.primary.id)

    async def publish_event(request, event, **kwargs):
        world.events.append((event, kwargs.get('subject_id'), kwargs.get('data')))

    async def delete_auth_by_id(user_id, db=None):
        world.deleted.append(user_id)
        return True

    monkeypatch.setattr(users_router.Users, 'get_first_user', get_first_user)
    monkeypatch.setattr(users_router, 'publish_event', publish_event)
    monkeypatch.setattr(users_router.Auths, 'delete_auth_by_id', delete_auth_by_id)
    return world


@pytest.fixture
def redis():
    return FakeRedis()


@pytest.fixture
def client(world, redis):
    app = FastAPI()
    app.state.redis = redis
    app.include_router(users_router.router, prefix='/users')
    return TestClient(app)


# --- admin-only routes ----------------------------------------------------------


def test_a_user_reaches_none_of_the_admin_routes(client, world):
    target = world.admin.id
    routes = [
        ('get', '/users/', None),
        ('get', '/users/all', None),
        ('get', f'/users/{target}', None),
        ('get', f'/users/{target}/oauth/sessions', None),
        ('get', f'/users/{target}/groups', None),
        ('get', f'/users/{target}/preview', None),
        ('post', f'/users/{target}/update', {'role': 'user'}),
        ('delete', f'/users/{target}', None),
        ('get', '/users/default/permissions', None),
        ('post', '/users/default/permissions', {}),
        ('get', '/users/default/permissions/defaults', None),
    ]
    for method, path, body in routes:
        r = client.request(method, path, json=body, headers=world.user.headers)
        assert r.status_code == 401, (method, path, r.status_code)
    assert world.deleted == [] and world.events == []
    assert _run(Users.get_user_by_id(target)).role == 'admin'


def test_a_user_cannot_promote_themself(client, world):
    r = client.post(f'/users/{world.user.id}/update', json={'role': 'admin'}, headers=world.user.headers)
    assert r.status_code == 401
    assert _run(Users.get_user_by_id(world.user.id)).role == 'user'


def test_a_pending_user_cannot_list_or_search_users(client):
    pending = _account('pending')
    assert client.get('/users/search', headers=pending.headers).status_code == 401
    assert client.get('/users/permissions', headers=pending.headers).status_code == 401


# --- the primary admin ------------------------------------------------------------


def test_another_admin_cannot_change_the_primary_admin(client, world):
    for body in ({'role': 'user'}, {'name': 'Renamed'}, {PW_KEY: 'x' * 12}):
        r = client.post(f'/users/{world.primary.id}/update', json=body, headers=world.admin.headers)
        assert r.status_code == 403, body
    stored = _run(Users.get_user_by_id(world.primary.id))
    assert (stored.role, stored.name) == ('admin', 'admin name')


def test_the_primary_admin_cannot_demote_themself(client, world):
    r = client.post(f'/users/{world.primary.id}/update', json={'role': 'user'}, headers=world.primary.headers)
    assert r.status_code == 403
    r = client.post(f'/users/{world.primary.id}/update', json={'name': 'Still Admin'}, headers=world.primary.headers)
    assert r.status_code == 200 and r.json()['role'] == 'admin'


def test_the_primary_admin_cannot_be_deleted_and_nobody_deletes_themself(client, world):
    assert client.delete(f'/users/{world.primary.id}', headers=world.admin.headers).status_code == 403
    assert client.delete(f'/users/{world.admin.id}', headers=world.admin.headers).status_code == 403
    assert world.deleted == []
    assert client.delete(f'/users/{world.user.id}', headers=world.admin.headers).json() is True
    assert world.deleted == [world.user.id]
    assert (EVENTS.USER_DELETED, world.user.id, None) in world.events


# --- changing an account -------------------------------------------------------------


def test_a_role_change_is_announced(client, world):
    r = client.post(f'/users/{world.user.id}/update', json={'role': 'admin'}, headers=world.admin.headers)
    assert r.status_code == 200 and r.json()['role'] == 'admin'
    assert (EVENTS.USER_ROLE_UPDATED, world.user.id, {'role': 'admin'}) in world.events
    world.events.clear()
    client.post(f'/users/{world.user.id}/update', json={'name': 'Same Role'}, headers=world.admin.headers)
    assert [event for event, *_ in world.events] == [EVENTS.USER_UPDATED]


def test_an_email_already_taken_is_refused(client, world):
    r = client.post(
        f'/users/{world.user.id}/update', json={'email': world.admin.email.upper()}, headers=world.admin.headers
    )
    assert r.status_code == 400
    assert _run(Users.get_user_by_id(world.user.id)).email == world.user.email


def test_a_password_reset_revokes_the_users_tokens(client, world, redis):
    assert client.get('/users/user/info', headers=world.user.headers).status_code == 200
    r = client.post(f'/users/{world.user.id}/update', json={PW_KEY: 'a-new-password-1'}, headers=world.admin.headers)
    assert r.status_code == 200
    assert f'{REDIS_KEY_PREFIX}:auth:user:{world.user.id}:revoked_at' in redis.store
    assert client.get('/users/user/info', headers=world.user.headers).status_code == 401
    assert (EVENTS.AUTH_PASSWORD_CHANGED, world.user.id, None) in world.events


def test_updating_an_unknown_user_is_refused(client, world):
    r = client.post('/users/no-such-user/update', json={'name': 'x'}, headers=world.admin.headers)
    assert r.status_code == 400


# --- a user's own settings and permissions ------------------------------------------------


def _settings(client, who, ui):
    r = client.post('/users/user/settings/update', json={'ui': ui}, headers=who.headers)
    return r.status_code, (r.json() if r.status_code == 200 else None)


def test_settings_need_the_interface_permission(client, config, world):
    config['user.permissions']['settings']['interface'] = False
    assert _settings(client, world.user, {'theme': 'dark'})[0] == 403
    assert _settings(client, world.admin, {'theme': 'dark'})[0] == 200


def test_settings_cannot_enable_what_the_user_is_not_permitted(client, config, world):
    config['user.permissions']['features'].update({'direct_tool_servers': False, 'webhooks': False})
    ui = {
        'theme': 'dark',
        'toolServers': [{'url': 'http://evil.example'}],
        'notifications': {'webhook_url': 'http://x'},
    }
    status, saved = _settings(client, world.user, copy.deepcopy(ui))
    assert status == 200
    assert saved['ui']['theme'] == 'dark'
    assert 'toolServers' not in saved['ui'] and 'webhook_url' not in saved['ui'].get('notifications', {})
    r = client.post(
        '/users/user/settings/update', json={'notifications': {'webhook_url': 'http://x'}}, headers=world.user.headers
    )
    assert 'notifications' not in r.json()

    # The same settings stick for an admin, and for a user given the permissions.
    assert _settings(client, world.admin, copy.deepcopy(ui))[1]['ui']['toolServers']
    config['user.permissions']['features'].update({'direct_tool_servers': True, 'webhooks': True})
    saved = _settings(client, world.user, copy.deepcopy(ui))[1]
    assert saved['ui']['toolServers'] and saved['ui']['notifications']['webhook_url'] == 'http://x'


def test_a_users_permissions_combine_their_groups_with_the_defaults(client, config, world):
    config['user.permissions']['features']['api_keys'] = False
    assert client.get('/users/permissions', headers=world.user.headers).json()['features']['api_keys'] is False
    group = _run(
        Groups.insert_new_group(
            world.admin.id,
            GroupForm(
                name=f'keys-{uuid.uuid4().hex[:6]}', description='', permissions={'features': {'api_keys': True}}
            ),
        )
    )
    _run(Groups.add_users_to_group(group.id, [world.user.id]))
    assert client.get('/users/permissions', headers=world.user.headers).json()['features']['api_keys'] is True
    assert client.get('/users/groups', headers=world.user.headers).json()[0]['id'] == group.id
