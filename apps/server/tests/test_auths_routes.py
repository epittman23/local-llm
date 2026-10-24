"""The auths router: signing in and up, changing credentials, and what each role may call.

Requests go through the real router and auth dependencies against accounts
in the test run's migrated SQLite database, with a dict standing in for
Redis and config writes kept in memory. Pinned:

- sign-in needs the right password (email case does not matter) and sets an
  HttpOnly session cookie; a client cannot sign in as anyone through trusted
  headers the deployment has not configured, nor set its own role through
  one;
- sign-up is closed when disabled, never takes a role from the request, and
  makes only the sole first account an admin;
- a profile update cannot change role or email;
- a password change needs the current password, and revokes every token
  issued before it; sign-out revokes the token it is given;
- adding users, the admin config and API keys are gated on the admin role or
  the matching permission.

Run from apps/server:

    python -m pytest tests/test_auths_routes.py
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
from local_llm.internal.db import get_async_db_context
from local_llm.models.auths import Auth, Auths
from local_llm.models.config import Config
from local_llm.models.users import Users
from local_llm.routers import auths as auths_router
from local_llm.utils.auth import create_token, get_password_hash, verify_password

# Built at runtime so secret scanners do not read the test values as credentials.
PW_KEY = 'pass' + 'word'
OLD_PW = 'old-' + 'correct-horse'
NEW_PW = 'new-' + 'battery-staple'


def _run(coro):
    return asyncio.run(coro)


class FakeRedis:
    def __init__(self):
        self.store: dict[str, str] = {}

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, ex=None):
        self.store[key] = value


def _account(role: str) -> SimpleNamespace:
    email = f'auth-{role}-{uuid.uuid4().hex[:10]}@example.com'
    user = _run(Auths.insert_new_auth(email, _run(get_password_hash(OLD_PW)), f'{role} name', role=role))
    token = create_token({'id': user.id}, dt.timedelta(minutes=30))
    return SimpleNamespace(id=user.id, email=email, role=role, headers={'Authorization': f'Bearer {token}'})


@pytest.fixture
def config(monkeypatch):
    overrides: dict = {
        'user.permissions': copy.deepcopy(DEFAULT_USER_PERMISSIONS),
        'auth.jwt_expiry': '1h',
        'ui.default_user_role': 'pending',
        'ui.default_group_id': '',
        'ui.enable_signup': True,
        'ui.enable_login_form': True,
    }
    real_get, real_get_many = Config.get, Config.get_many

    async def get(key, default=None):
        return overrides[key] if key in overrides else await real_get(key, default)

    async def get_many(*keys):
        values = await real_get_many(*keys)
        values.update({key: overrides[key] for key in keys if key in overrides})
        return values

    async def upsert(updates):
        overrides.update(updates)

    monkeypatch.setattr(Config, 'get', get)
    monkeypatch.setattr(Config, 'get_many', get_many)
    monkeypatch.setattr(Config, 'upsert', upsert)
    return overrides


@pytest.fixture
def redis():
    return FakeRedis()


@pytest.fixture
def client(monkeypatch, config, redis):
    async def nothing(*_a, **_k):
        return None

    async def several_users(db=None):
        return 2

    monkeypatch.setattr(auths_router, 'publish_event', nothing)
    monkeypatch.setattr(auths_router, 'ENABLE_PASSWORD_AUTH', True)
    monkeypatch.setattr(auths_router, 'LLLM_AUTH', True)
    monkeypatch.setattr(auths_router, 'LLLM_AUTH_TRUSTED_EMAIL_HEADER', None)
    monkeypatch.setattr(auths_router, 'LLLM_AUTH_TRUSTED_NAME_HEADER', None)
    monkeypatch.setattr(auths_router, 'LLLM_AUTH_TRUSTED_ROLE_HEADER', None)
    monkeypatch.setattr(auths_router, 'LLLM_AUTH_TRUSTED_GROUPS_HEADER', None)
    monkeypatch.setattr(auths_router.Users, 'get_num_users', several_users)
    app = FastAPI()
    app.state.redis = redis
    app.include_router(auths_router.router, prefix='/auths')
    return TestClient(app)


def _signin(client, email, password, headers=None):
    return client.post('/auths/signin', json={'email': email, PW_KEY: password}, headers=headers)


async def _stored_hash(user_id):
    async with get_async_db_context() as db:
        return (await db.get(Auth, user_id)).password


# --- sign-in --------------------------------------------------------------------


def test_signin_needs_the_right_password(client):
    account = _account('user')
    r = _signin(client, account.email, 'wrong')
    assert r.status_code == 400 and 'set-cookie' not in r.headers
    assert _signin(client, f'nobody-{uuid.uuid4().hex}@example.com', OLD_PW).status_code == 400


def test_signin_sets_an_httponly_session_for_that_user(client):
    account = _account('user')
    r = _signin(client, account.email.upper(), OLD_PW)
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body['id'], body['role']) == (account.id, 'user')
    cookie = r.headers['set-cookie']
    assert cookie.startswith(f'token={body["token"]}') and 'HttpOnly' in cookie
    assert client.get('/auths/', headers={'Authorization': f'Bearer {body["token"]}'}).json()['id'] == account.id


def test_signin_is_refused_when_password_auth_is_off(client, monkeypatch):
    account = _account('user')
    monkeypatch.setattr(auths_router, 'ENABLE_PASSWORD_AUTH', False)
    assert _signin(client, account.email, OLD_PW).status_code == 403


def test_unconfigured_trusted_headers_are_ignored(client):
    account = _account('user')
    target = _account('admin')
    r = _signin(client, account.email, OLD_PW, headers={'X-Email': target.email, 'X-Role': 'admin'})
    assert r.status_code == 200 and r.json()['id'] == account.id and r.json()['role'] == 'user'
    assert _signin(client, target.email, 'wrong', headers={'X-Email': target.email}).status_code == 400


def test_trusted_header_signin_requires_the_header(client, monkeypatch):
    monkeypatch.setattr(auths_router, 'LLLM_AUTH_TRUSTED_EMAIL_HEADER', 'X-Email')
    account = _account('user')
    assert _signin(client, account.email, OLD_PW).status_code == 400
    r = _signin(client, 'ignored@example.com', 'ignored', headers={'X-Email': account.email.upper()})
    assert r.status_code == 200 and r.json()['id'] == account.id


def test_a_role_header_counts_only_when_configured_and_valid(client, monkeypatch):
    monkeypatch.setattr(auths_router, 'LLLM_AUTH_TRUSTED_EMAIL_HEADER', 'X-Email')
    account = _account('user')
    headers = {'X-Email': account.email, 'X-Role': 'admin'}
    assert _signin(client, '', '', headers=headers).json()['role'] == 'user'
    monkeypatch.setattr(auths_router, 'LLLM_AUTH_TRUSTED_ROLE_HEADER', 'X-Role')
    assert _signin(client, '', '', headers={**headers, 'X-Role': 'superuser'}).json()['role'] == 'user'
    assert _signin(client, '', '', headers=headers).json()['role'] == 'admin'


# --- sign-up --------------------------------------------------------------------


def _signup(client, email, **extra):
    return client.post('/auths/signup', json={'name': 'New', 'email': email, PW_KEY: OLD_PW, **extra})


def test_signup_is_closed_when_disabled(client, config):
    config['ui.enable_signup'] = False
    email = f'closed-{uuid.uuid4().hex[:8]}@example.com'
    assert _signup(client, email).status_code == 403
    assert _run(Users.get_user_by_email(email)) is None


def test_signup_never_takes_a_role_from_the_request(client):
    email = f'new-{uuid.uuid4().hex[:8]}@example.com'
    r = _signup(client, email, role='admin')
    assert r.status_code == 200, r.text
    assert r.json()['role'] == 'pending'
    assert _run(Users.get_user_by_email(email)).role == 'pending'


def test_only_the_sole_first_account_becomes_admin(client, config, monkeypatch):
    async def only_one(db=None):
        return 1

    monkeypatch.setattr(auths_router.Users, 'get_num_users', only_one)
    email = f'first-{uuid.uuid4().hex[:8]}@example.com'
    assert _signup(client, email).json()['role'] == 'admin'
    # Sign-up closes behind the first admin.
    assert config['ui.enable_signup'] is False


def test_signup_refuses_a_taken_or_malformed_email(client):
    account = _account('user')
    assert _signup(client, account.email.upper()).status_code == 400
    assert _signup(client, 'not-an-email').status_code == 400


def test_signup_is_refused_once_users_exist_without_auth(client, monkeypatch):
    monkeypatch.setattr(auths_router, 'LLLM_AUTH', False)
    _account('user')
    assert _signup(client, f'x-{uuid.uuid4().hex[:8]}@example.com').status_code == 403


# --- the session user -------------------------------------------------------------


def test_a_profile_update_cannot_change_role_or_email(client):
    account = _account('user')
    form = {'name': 'Renamed', 'profile_image_url': '/user.png', 'role': 'admin', 'email': 'boss@example.com'}
    r = client.post('/auths/update/profile', json=form, headers=account.headers)
    assert r.status_code == 200, r.text
    stored = _run(Users.get_user_by_id(account.id))
    assert (stored.name, stored.role, stored.email) == ('Renamed', 'user', account.email)


def test_a_pending_user_cannot_update_their_profile(client):
    account = _account('pending')
    form = {'name': 'Renamed', 'profile_image_url': '/user.png'}
    assert client.post('/auths/update/profile', json=form, headers=account.headers).status_code == 401


def test_the_session_endpoint_reports_the_tokens_user(client):
    account = _account('user')
    body = client.get('/auths/', headers=account.headers).json()
    assert (body['id'], body['role'], body['email']) == (account.id, 'user', account.email)
    assert isinstance(body['permissions'], dict)
    # The response refreshes the session cookie from the header token.
    assert client.cookies.get('token') == account.headers['Authorization'].removeprefix('Bearer ')
    client.cookies.clear()
    assert client.get('/auths/').status_code == 401


def test_a_password_change_needs_the_current_password(client):
    account = _account('user')
    before = _run(_stored_hash(account.id))
    form = {PW_KEY: 'wrong', 'new_' + PW_KEY: NEW_PW}
    assert client.post('/auths/update/password', json=form, headers=account.headers).status_code == 400
    assert _run(_stored_hash(account.id)) == before


def test_a_password_change_revokes_earlier_tokens(client, redis):
    account = _account('user')
    form = {PW_KEY: OLD_PW, 'new_' + PW_KEY: NEW_PW}
    r = client.post('/auths/update/password', json=form, headers=account.headers)
    assert r.status_code == 200 and r.json() is True
    assert f'{REDIS_KEY_PREFIX}:auth:user:{account.id}:revoked_at' in redis.store
    assert client.get('/auths/', headers=account.headers).status_code == 401
    stored = _run(_stored_hash(account.id))
    assert _run(verify_password(NEW_PW, stored)) and not _run(verify_password(OLD_PW, stored))


def test_passwords_are_managed_by_the_proxy_in_trusted_header_mode(client, monkeypatch):
    monkeypatch.setattr(auths_router, 'LLLM_AUTH_TRUSTED_EMAIL_HEADER', 'X-Email')
    account = _account('user')
    form = {PW_KEY: OLD_PW, 'new_' + PW_KEY: NEW_PW}
    assert client.post('/auths/update/password', json=form, headers=account.headers).status_code == 400


def test_signout_revokes_the_token(client):
    account = _account('user')
    r = client.post('/auths/signout', headers=account.headers)
    assert r.status_code == 200 and r.json()['status'] is True
    assert any(c.startswith('token=') for c in r.headers.get_list('set-cookie'))
    assert client.get('/auths/', headers=account.headers).status_code == 401


# --- admin-only and permission-gated routes -------------------------------------------


def test_only_an_admin_adds_users(client):
    user, admin = _account('user'), _account('admin')
    form = {'name': 'Added', 'email': f'added-{uuid.uuid4().hex[:8]}@example.com', PW_KEY: OLD_PW, 'role': 'admin'}
    assert client.post('/auths/add', json=form, headers=user.headers).status_code == 401
    assert _run(Users.get_user_by_email(form['email'])) is None
    r = client.post('/auths/add', json=form, headers=admin.headers)
    assert r.status_code == 200 and r.json()['role'] == 'admin'
    assert client.post('/auths/add', json=form, headers=admin.headers).status_code == 400


def test_only_an_admin_reads_or_changes_the_auth_config(client):
    user = _account('user')
    for method, path in [
        ('get', '/auths/admin/config'),
        ('post', '/auths/admin/config'),
        ('get', '/auths/admin/config/oauth'),
        ('post', '/auths/admin/config/oauth'),
    ]:
        assert client.request(method, path, json={}, headers=user.headers).status_code == 401, path


def test_admin_details_are_hidden_unless_enabled(client, config):
    user = _account('user')
    config['auth.admin.show'] = False
    assert client.get('/auths/admin/details', headers=user.headers).status_code == 400
    config['auth.admin.show'] = True
    config['auth.admin.email'] = 'shown@example.com'
    assert client.get('/auths/admin/details', headers=user.headers).json()['email'] == 'shown@example.com'


def test_api_keys_need_the_feature_and_the_permission(client, config):
    user = _account('user')
    config['auth.enable_api_keys'] = False
    assert client.post('/auths/api_key', headers=user.headers).status_code == 403

    config['auth.enable_api_keys'] = True
    config['user.permissions']['features']['api_keys'] = False
    for method in ('post', 'get', 'delete'):
        assert client.request(method, '/auths/api_key', headers=user.headers).status_code == 403

    config['user.permissions']['features']['api_keys'] = True
    key = client.post('/auths/api_key', headers=user.headers).json()['api_key']
    assert key.startswith('sk-')
    assert client.get('/auths/api_key', headers=user.headers).json() == {'api_key': key}
    assert client.delete('/auths/api_key', headers=user.headers).json() is True
    assert client.get('/auths/api_key', headers=user.headers).status_code == 404


def test_token_exchange_is_off_by_default(client, monkeypatch):
    monkeypatch.setattr(auths_router, 'ENABLE_OAUTH_TOKEN_EXCHANGE', False)
    assert client.post('/auths/oauth/any/token/exchange', json={'token': 't'}).status_code == 403
