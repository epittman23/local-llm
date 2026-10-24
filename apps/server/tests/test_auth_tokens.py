"""utils/auth.py: which credentials resolve to a user, and which are refused.

Every request goes through the real dependency chain (get_current_user and
the role gates on top of it) against users in the test run's migrated SQLite
database, with a dict standing in for Redis. Pinned:

- a JWT is refused when it is expired, signed with another key or another
  algorithm (including `none`), carries no user id, names an unknown user, or
  has been revoked by its jti or by a per-user revocation at or after it was
  issued;
- pending users pass get_current_user only: get_verified_user refuses them,
  and get_admin_user refuses everyone but admins;
- an API key works only while API keys are enabled, for admins or users
  holding features.api_keys, and only on the allowed endpoints when those are
  restricted (a path prefix does not match a longer sibling path);
- sign-out and password-change revocation write the markers that the checks
  above read;
- passwords hash and verify with both supported algorithms.

Run from apps/server:

    python -m pytest tests/test_auth_tokens.py
"""

from __future__ import annotations

import asyncio
import base64
import copy
import datetime as dt
import json
import re
import time
import uuid
from types import SimpleNamespace

import jwt
import pytest
from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient

from local_llm.config import DEFAULT_USER_PERMISSIONS
from local_llm.env import REDIS_KEY_PREFIX
from local_llm.models.config import Config
from local_llm.models.users import Users
from local_llm.utils import auth as auth_utils
from local_llm.utils.auth import (
    create_token,
    decode_token,
    get_admin_user,
    get_current_user,
    get_optional_verified_user_from_request,
    get_password_hash,
    get_verified_user,
    get_verified_user_by_id,
    get_verified_user_by_token,
    invalidate_token,
    is_valid_token,
    revoke_user_tokens,
    validate_password,
    verify_password,
)

SECRET = auth_utils.SESSION_SECRET


def _run(coro):
    return asyncio.run(coro)


class FakeRedis:
    def __init__(self):
        self.store: dict[str, str] = {}
        self.expiry: dict[str, int | None] = {}

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, ex=None):
        self.store[key] = value
        self.expiry[key] = ex


def _user(role: str) -> SimpleNamespace:
    uid = f'{role}-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, f'{role} user', f'{uid}@example.com', role=role))
    return SimpleNamespace(id=uid, email=f'{uid}@example.com', role=role)


@pytest.fixture(scope='module')
def people():
    return SimpleNamespace(admin=_user('admin'), user=_user('user'), pending=_user('pending'))


@pytest.fixture
def config(monkeypatch):
    """Config values a test sets; everything else reads the real table."""
    overrides: dict = {'user.permissions': copy.deepcopy(DEFAULT_USER_PERMISSIONS)}
    real_get, real_get_many = Config.get, Config.get_many

    async def get(key, default=None):
        return overrides[key] if key in overrides else await real_get(key, default)

    async def get_many(*keys):
        values = await real_get_many(*keys)
        values.update({key: overrides[key] for key in keys if key in overrides})
        return values

    monkeypatch.setattr(Config, 'get', get)
    monkeypatch.setattr(Config, 'get_many', get_many)
    return overrides


@pytest.fixture
def redis():
    return FakeRedis()


@pytest.fixture
def client(redis):
    app = FastAPI()
    app.state.redis = redis

    @app.get('/me')
    async def me(user=Depends(get_current_user)):
        return {'id': user.id}

    @app.get('/verified')
    async def verified(user=Depends(get_verified_user)):
        return {'id': user.id}

    @app.get('/admin')
    async def admin(user=Depends(get_admin_user)):
        return {'id': user.id}

    @app.get('/optional')
    async def optional(request: Request):
        user = await get_optional_verified_user_from_request(request)
        return {'id': user.id if user else None}

    for path in ('/api/x', '/api/x/y', '/api/xy'):

        @app.get(path)
        async def restricted(user=Depends(get_current_user)):
            return {'id': user.id}

    return TestClient(app)


def _bearer(token):
    return {'Authorization': f'Bearer {token}'}


def _token(user, minutes=5):
    return create_token({'id': user.id}, dt.timedelta(minutes=minutes))


def _b64(data: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b'=').decode()


# --- JWTs ---------------------------------------------------------------------


def test_a_valid_token_resolves_its_user(client, people):
    r = client.get('/me', headers=_bearer(_token(people.user)))
    assert r.status_code == 200 and r.json() == {'id': people.user.id}


def test_a_token_in_the_cookie_works_too(client, people):
    client.cookies.set('token', _token(people.user))
    assert client.get('/me').json() == {'id': people.user.id}


def test_no_credentials_is_refused(client):
    assert client.get('/me').status_code == 401
    assert client.get('/verified').status_code == 401


def _forged(people):
    user_id = people.admin.id
    return {
        'expired': create_token({'id': user_id}, dt.timedelta(seconds=-30)),
        'other secret': jwt.encode({'id': user_id}, 'not-the-secret-' + 'x' * 32, algorithm='HS256'),
        'other algorithm': jwt.encode({'id': user_id}, SECRET, algorithm='HS512'),
        'alg none': f'{_b64({"alg": "none", "typ": "JWT"})}.{_b64({"id": user_id})}.',
        'no id claim': create_token({'sub': user_id}, dt.timedelta(minutes=5)),
        'unknown user': create_token({'id': 'no-such-user'}, dt.timedelta(minutes=5)),
        'garbage': 'not.a.jwt',
    }


@pytest.mark.parametrize(
    'kind', ['expired', 'other secret', 'other algorithm', 'alg none', 'no id claim', 'unknown user', 'garbage']
)
def test_forged_or_stale_tokens_are_refused(client, people, kind):
    token = _forged(people)[kind]
    assert decode_token(token) is None or kind in {'no id claim', 'unknown user'}
    assert client.get('/me', headers=_bearer(token)).status_code == 401
    assert client.get('/optional', headers=_bearer(token)).json() == {'id': None}
    assert _run(get_verified_user_by_token(token)) is None


def test_a_trusted_email_header_must_match_the_tokens_user(client, people, monkeypatch):
    monkeypatch.setattr(auth_utils, 'LLLM_AUTH_TRUSTED_EMAIL_HEADER', 'X-Forwarded-Email')
    token = _token(people.user)
    ok = client.get('/me', headers=_bearer(token) | {'X-Forwarded-Email': people.user.email.upper()})
    assert ok.status_code == 200
    other = client.get('/me', headers=_bearer(token) | {'X-Forwarded-Email': people.admin.email})
    assert other.status_code == 401


# --- roles ----------------------------------------------------------------------


@pytest.mark.parametrize(
    'role, me, verified, admin',
    [('admin', 200, 200, 200), ('user', 200, 200, 401), ('pending', 200, 401, 401)],
)
def test_role_gates(client, people, role, me, verified, admin):
    headers = _bearer(_token(getattr(people, role)))
    assert client.get('/me', headers=headers).status_code == me
    assert client.get('/verified', headers=headers).status_code == verified
    assert client.get('/admin', headers=headers).status_code == admin


def test_a_pending_user_is_anonymous_to_optional_auth(client, people):
    assert client.get('/optional', headers=_bearer(_token(people.pending))).json() == {'id': None}
    assert client.get('/optional', headers=_bearer(_token(people.user))).json() == {'id': people.user.id}
    client.cookies.set('token', _token(people.admin))
    assert client.get('/optional').json() == {'id': people.admin.id}


def test_resolving_by_token_or_id_refuses_pending_users(people):
    assert _run(get_verified_user_by_token(_token(people.user))).id == people.user.id
    assert _run(get_verified_user_by_token(_token(people.pending))) is None
    assert _run(get_verified_user_by_id(people.admin.id)).id == people.admin.id
    assert _run(get_verified_user_by_id(people.pending.id)) is None
    assert _run(get_verified_user_by_id('no-such-user')) is None
    assert _run(get_verified_user_by_id(None)) is None


# --- revocation -----------------------------------------------------------------


def test_a_revoked_jti_is_refused(client, people, redis):
    token = _token(people.user)
    assert client.get('/me', headers=_bearer(token)).status_code == 200
    redis.store[f'{REDIS_KEY_PREFIX}:auth:token:{decode_token(token)["jti"]}:revoked'] = '1'
    assert client.get('/me', headers=_bearer(token)).status_code == 401
    assert client.get('/optional', headers=_bearer(token)).json() == {'id': None}
    assert _run(get_verified_user_by_token(token, redis)) is None
    # Another token of the same user is unaffected.
    assert client.get('/me', headers=_bearer(_token(people.user))).status_code == 200


def _revoked_at(redis, user, at):
    redis.store[f'{REDIS_KEY_PREFIX}:auth:user:{user.id}:revoked_at'] = str(at)


def test_tokens_issued_up_to_a_user_revocation_are_refused(client, people, redis):
    token = _token(people.user)
    iat = decode_token(token)['iat']
    _revoked_at(redis, people.user, iat)
    assert client.get('/me', headers=_bearer(token)).status_code == 401
    _revoked_at(redis, people.user, iat + 60)
    assert client.get('/me', headers=_bearer(token)).status_code == 401
    # A token issued after the revocation is accepted.
    _revoked_at(redis, people.user, iat - 60)
    assert client.get('/me', headers=_bearer(token)).status_code == 200
    # Revoking one user leaves everyone else's tokens alone.
    assert client.get('/me', headers=_bearer(_token(people.admin))).status_code == 200


def test_is_valid_token_rules(redis):
    now = int(time.time())
    assert _run(is_valid_token({'id': 'u', 'jti': 'j', 'iat': now}, None))
    assert _run(is_valid_token({'id': 'u', 'jti': 'j', 'iat': now}, redis))
    redis.store[f'{REDIS_KEY_PREFIX}:auth:user:u:revoked_at'] = str(now - 10)
    assert _run(is_valid_token({'id': 'u', 'iat': now}, redis))
    # A token with no issue time cannot be shown to postdate the revocation.
    assert not _run(is_valid_token({'id': 'u'}, redis))
    # A marker that is not a timestamp is ignored rather than locking the user out.
    redis.store[f'{REDIS_KEY_PREFIX}:auth:user:u:revoked_at'] = 'garbage'
    assert _run(is_valid_token({'id': 'u', 'iat': now}, redis))


def test_signing_out_revokes_the_token_until_it_would_have_expired(people, redis):
    token = _token(people.user, minutes=10)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(redis=redis)))
    _run(invalidate_token(request, token))
    key = f'{REDIS_KEY_PREFIX}:auth:token:{decode_token(token)["jti"]}:revoked'
    assert redis.store[key] == '1'
    assert 590 <= redis.expiry[key] <= 600
    assert not _run(is_valid_token(decode_token(token), redis))


def test_signing_out_an_invalid_token_stores_nothing(redis):
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(redis=redis)))
    _run(invalidate_token(request, 'not.a.jwt'))
    _run(invalidate_token(request, create_token({'id': 'u'}, dt.timedelta(seconds=-5))))
    assert redis.store == {}


def test_revoking_a_user_outlives_their_tokens(config, redis):
    config['auth.jwt_expiry'] = '2h'
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(redis=redis)))
    before = int(time.time())
    _run(revoke_user_tokens(request, 'u1'))
    key = f'{REDIS_KEY_PREFIX}:auth:user:u1:revoked_at'
    assert before <= int(redis.store[key]) <= int(time.time())
    assert redis.expiry[key] == 7200


def test_revoking_without_redis_does_not_raise(config):
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(redis=None)))
    assert _run(revoke_user_tokens(request, 'u1')) is None


# --- API keys -------------------------------------------------------------------


@pytest.fixture
def api_keys(people):
    keys = {}
    for role in ('admin', 'user'):
        keys[role] = f'sk-{uuid.uuid4().hex}'
        _run(Users.update_user_api_key_by_id(getattr(people, role).id, keys[role]))
    return keys


def test_api_keys_are_refused_while_disabled(client, config, api_keys):
    config['auth.enable_api_keys'] = False
    assert client.get('/me', headers=_bearer(api_keys['admin'])).status_code == 403
    assert client.get('/optional', headers=_bearer(api_keys['admin'])).json() == {'id': None}


def test_an_unknown_api_key_is_refused(client, config):
    config['auth.enable_api_keys'] = True
    assert client.get('/me', headers=_bearer('sk-not-a-real-key')).status_code == 401


def test_a_user_needs_the_api_keys_permission(client, config, people, api_keys):
    config['auth.enable_api_keys'] = True
    config['auth.api_key.endpoint_restrictions'] = False
    config['user.permissions']['features']['api_keys'] = False
    assert client.get('/me', headers=_bearer(api_keys['user'])).status_code == 403
    assert client.get('/me', headers=_bearer(api_keys['admin'])).json() == {'id': people.admin.id}
    config['user.permissions']['features']['api_keys'] = True
    assert client.get('/me', headers=_bearer(api_keys['user'])).json() == {'id': people.user.id}
    assert client.get('/optional', headers=_bearer(api_keys['user'])).json() == {'id': people.user.id}


def test_restricted_api_keys_reach_only_the_allowed_paths(client, config, api_keys):
    config['auth.enable_api_keys'] = True
    config['auth.api_key.endpoint_restrictions'] = True
    config['auth.api_key.allowed_endpoints'] = ' /api/x , '
    headers = _bearer(api_keys['admin'])
    assert client.get('/api/x', headers=headers).status_code == 200
    assert client.get('/api/x/y', headers=headers).status_code == 200
    assert client.get('/api/xy', headers=headers).status_code == 403
    assert client.get('/me', headers=headers).status_code == 403
    # The same key in the cookie is held to the same restriction.
    client.cookies.set('token', api_keys['admin'])
    assert client.get('/api/xy').status_code == 403


# --- passwords ------------------------------------------------------------------


def test_bcrypt_hashes_verify_only_their_password(monkeypatch):
    monkeypatch.setattr(auth_utils, 'PASSWORD_HASH_ALGORITHM', 'bcrypt')
    hashed = _run(get_password_hash('correct horse'))
    assert hashed.startswith('$2')
    assert _run(verify_password('correct horse', hashed))
    assert not _run(verify_password('correct horsE', hashed))


def test_argon2_hashes_verify_only_their_password(monkeypatch):
    monkeypatch.setattr(auth_utils, 'PASSWORD_HASH_ALGORITHM', 'argon2')
    hashed = _run(get_password_hash('correct horse'))
    assert hashed.startswith('$argon2')
    assert _run(verify_password('correct horse', hashed))
    assert not _run(verify_password('wrong', hashed))


def test_an_unknown_algorithm_is_refused(monkeypatch):
    monkeypatch.setattr(auth_utils, 'PASSWORD_HASH_ALGORITHM', 'md5')
    with pytest.raises(ValueError):
        _run(get_password_hash('x'))


@pytest.mark.parametrize('stored', ['', None, 'not-a-hash', '$argon2id$garbage'])
def test_a_missing_or_corrupt_hash_never_verifies(stored):
    assert not _run(verify_password('anything', stored))


def test_bcrypt_refuses_new_passwords_it_would_truncate(monkeypatch):
    monkeypatch.setattr(auth_utils, 'PASSWORD_HASH_ALGORITHM', 'bcrypt')
    monkeypatch.setattr(auth_utils, 'ENABLE_PASSWORD_VALIDATION', False)
    assert validate_password('x' * 72)
    with pytest.raises(Exception):
        validate_password('x' * 73)
    with pytest.raises(Exception):
        validate_password('é' * 37)  # 74 bytes


def test_the_password_policy_applies_when_enabled(monkeypatch):
    monkeypatch.setattr(auth_utils, 'ENABLE_PASSWORD_VALIDATION', True)
    monkeypatch.setattr(auth_utils, 'PASSWORD_VALIDATION_REGEX_PATTERN', re.compile(r'^.{12,}$'))
    assert validate_password('long enough pw')
    with pytest.raises(Exception):
        validate_password('short')


def test_the_bearer_header_parser():
    cred = auth_utils.get_http_authorization_cred('Bearer abc')
    assert (cred.scheme, cred.credentials) == ('Bearer', 'abc')
    assert auth_utils.get_http_authorization_cred(None) is None
    assert auth_utils.get_http_authorization_cred('Bearer a b') is None
    assert auth_utils.extract_token_from_auth_header('Bearer abc') == 'abc'
    assert auth_utils.create_api_key().startswith('sk-')


def test_the_admin_account_from_the_environment_is_created_only_on_an_empty_install(monkeypatch):
    async def has_users(db=None):
        return True

    monkeypatch.setattr(auth_utils.Users, 'has_users', has_users)
    assert _run(auth_utils.create_admin_user('root@example.com', 'pw')) is None
    assert _run(auth_utils.create_admin_user('', 'pw')) is None

    created = []

    async def no_users(db=None):
        return False

    async def insert_new_auth(email, password, name, role):
        created.append((email, role, password.startswith('$')))
        return SimpleNamespace(id='root', email=email, role=role)

    monkeypatch.setattr(auth_utils.Users, 'has_users', no_users)
    monkeypatch.setattr(auth_utils.Auths, 'insert_new_auth', insert_new_auth)
    assert _run(auth_utils.create_admin_user('Root@Example.com', 'pw')).role == 'admin'
    assert created == [('root@example.com', 'admin', True)]
