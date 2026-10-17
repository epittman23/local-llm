"""Characterization tests for OAuth sign-in and back-channel logout in utils/oauth.py.

OAuthManager.handle_callback and handle_backchannel_logout were refactored
for ruff's complexity limit with no tests of their own, so these pin what
they did before the refactor: the redirect (its location and every cookie)
or the JSON response, and every lookup and write made along the way, in
order. The OAuth clients, users, auth records, sessions, config, events and
the GitHub email API are fakes that record their calls. Logout tokens are
real JWTs signed with keys made here, so their validation runs for real.
Each case was recorded from the untouched methods into
fixtures/oauth_callback.json and must not change.

The golden file is only ever written by hand, never by this test. To record
it again (only for an intended behaviour change, reviewed as such), run
`OAUTH_GOLDEN_RECORD=1 pytest tests/test_oauth_callback.py`.
"""

import asyncio
import copy
import datetime as dt
import json
import os
from pathlib import Path
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from joserfc.errors import BadSignatureError

from local_llm.utils import oauth

GOLDEN = Path(__file__).parent / 'fixtures' / 'oauth_callback.json'
RECORD = os.environ.get('OAUTH_GOLDEN_RECORD') == '1'

ID_CLAIMS = {'sub': 'sub-1', 'email': 'Ada@Example.com', 'name': 'Ada', 'picture': 'https://idp.test/ada.png'}
TOKEN = {'access_token': 'at-1', 'id_token': 'idtok', 'expires_in': 3600, 'userinfo': ID_CLAIMS}
ADA = {
    'id': 'u-ada',
    'name': 'Ada',
    'email': 'ada@example.com',
    'oauth': {'oidc': {'sub': 'sub-1'}},
    'picture': '/a.png',
}
BOB = {'id': 'u-bob', 'name': 'Bob', 'email': 'bob@example.com', 'oauth': None, 'picture': '/b.png'}

CALLBACK_CASES = [
    ('oauth_disabled', 'oidc', {'config': {'ENABLE_OAUTH': False}}),
    ('unknown_provider', 'nope', {}),
    ('signup_first_user', 'oidc', {'num_users': 1}),
    (
        'signup_no_picture_claim_no_name',
        'oidc',
        {
            'config': {'OAUTH_PICTURE_CLAIM': ''},
            'token': {**TOKEN, 'userinfo': {'sub': 'sub-1', 'email': 'ada@example.com'}},
            'userinfo': {'sub': 'sub-1', 'email': 'ada@example.com'},
        },
    ),
    ('signup_disabled', 'oidc', {'config': {'ENABLE_OAUTH_SIGNUP': False}}),
    ('signup_email_taken', 'oidc', {'by_email': {'ada@example.com': BOB}}),
    ('signup_insert_fails', 'oidc', {'insert_fails': True}),
    (
        'existing_user_groups_and_pruning',
        'oidc',
        {
            'by_sub': ADA,
            'config': {'ENABLE_OAUTH_GROUP_MANAGEMENT': True},
            'sessions': [
                {'id': 's-old', 'provider': 'oidc', 'created_at': 1},
                {'id': 's-mid', 'provider': 'oidc', 'created_at': 2},
                {'id': 's-new', 'provider': 'oidc', 'created_at': 3},
                {'id': 's-gh', 'provider': 'github', 'created_at': 0},
            ],
        },
    ),
    (
        'existing_user_updates_email_taken',
        'oidc',
        {
            'by_sub': {**ADA, 'name': 'Old Name', 'email': 'ada@old.example.com'},
            'by_email': {'ada@example.com': BOB},
            'config': {
                'OAUTH_UPDATE_NAME_ON_LOGIN': True,
                'OAUTH_UPDATE_EMAIL_ON_LOGIN': True,
                'OAUTH_UPDATE_PICTURE_ON_LOGIN': True,
            },
        },
    ),
    (
        'existing_user_updates_email',
        'oidc',
        {
            'by_sub': {**ADA, 'email': 'ada@old.example.com', 'picture': 'processed:https://idp.test/ada.png'},
            'config': {
                'OAUTH_UPDATE_NAME_ON_LOGIN': True,
                'OAUTH_UPDATE_EMAIL_ON_LOGIN': True,
                'OAUTH_UPDATE_PICTURE_ON_LOGIN': True,
            },
        },
    ),
    (
        'existing_user_updates_fail',
        'oidc',
        {
            'by_sub': {**ADA, 'name': 'Old Name', 'email': 'ada@old.example.com'},
            'config': {
                'OAUTH_UPDATE_NAME_ON_LOGIN': True,
                'OAUTH_UPDATE_EMAIL_ON_LOGIN': True,
                'OAUTH_UPDATE_PICTURE_ON_LOGIN': True,
            },
            'updates_fail': True,
        },
    ),
    (
        'existing_user_update_claims_unset',
        'oidc',
        {
            'by_sub': {**ADA, 'name': 'Old Name'},
            'config': {
                'OAUTH_UPDATE_NAME_ON_LOGIN': True,
                'OAUTH_UPDATE_EMAIL_ON_LOGIN': True,
                'OAUTH_UPDATE_PICTURE_ON_LOGIN': True,
                'OAUTH_USERNAME_CLAIM': '',
                'OAUTH_EMAIL_CLAIM': '',
                'OAUTH_PICTURE_CLAIM': '',
            },
            'token': {**TOKEN, 'userinfo': {**ID_CLAIMS, '': 'x'}},
        },
    ),
    (
        'merge_by_email',
        'oidc',
        {'config': {'OAUTH_MERGE_ACCOUNTS_BY_EMAIL': True}, 'by_email': {'ada@example.com': BOB}},
    ),
    (
        'merge_by_email_update_returns_none',
        'oidc',
        {
            'config': {'OAUTH_MERGE_ACCOUNTS_BY_EMAIL': True},
            'by_email': {'ada@example.com': BOB},
            'oauth_update_fails': True,
        },
    ),
    ('merge_by_email_no_match', 'oidc', {'config': {'OAUTH_MERGE_ACCOUNTS_BY_EMAIL': True}}),
    ('legacy_numeric_sub_repaired', 'oidc', {'by_sub': {**ADA, 'oauth': {'oidc': {'sub': 123}}}}),
    ('user_oauth_not_a_dict', 'oidc', {'by_sub': {**ADA, 'oauth': 'corrupt'}}),
    ('authorize_fails', 'oidc', {'authorize': ['raise']}),
    ('bad_signature_then_ok', 'oidc', {'authorize': ['bad_signature', 'ok'], 'by_sub': ADA}),
    ('bad_signature_twice', 'oidc', {'authorize': ['bad_signature', 'raise']}),
    ('bad_signature_no_metadata', 'oidc', {'authorize': ['bad_signature', 'ok'], 'by_sub': ADA, 'metadata': None}),
    ('client_id_sent', 'oidc', {'env': {'OAUTH_ACCESS_TOKEN_REQUEST_INCLUDE_CLIENT_ID': True}, 'by_sub': ADA}),
    ('client_missing', 'unregistered', {}),
    (
        'userinfo_merges_id_claims',
        'oidc',
        {
            'token': {**TOKEN, 'userinfo': {'sub': 'sub-1', 'roles': ['admin'], 'email': 'ada@example.com'}},
            'userinfo': {'sub': 'sub-1', 'email': 'ada@idp.example.com', 'name': 'Ada L'},
            'by_sub': ADA,
        },
    ),
    ('userinfo_without_id_claims', 'oidc', {'token': {'access_token': 'at-1'}, 'userinfo': ID_CLAIMS, 'by_sub': ADA}),
    ('userinfo_missing', 'oidc', {'token': {'access_token': 'at-1', 'userinfo': {'sub': 'sub-1'}}, 'userinfo': None}),
    (
        'feishu_unwraps_data',
        'feishu',
        {'token': {'access_token': 'at-1'}, 'userinfo': {'data': {**ID_CLAIMS, 'open_id': 'f-1'}}},
    ),
    (
        'custom_sub_claim',
        'oidc',
        {'config': {'OAUTH_SUB_CLAIM': 'oid'}, 'token': {**TOKEN, 'userinfo': {**ID_CLAIMS, 'oid': 42}}},
    ),
    ('sub_missing', 'oidc', {'token': {**TOKEN, 'userinfo': {'email': 'a@b.c', 'name': 'A'}}}),
    (
        'github_primary_email',
        'github',
        {
            'token': {'access_token': 'gh-at', 'userinfo': {'id': 7, 'name': 'Ada'}},
            'userinfo': {'id': 7, 'name': 'Ada', 'email': None},
            'github_emails': {'ok': True, 'json': [{'email': 'old@x.io'}, {'email': 'Ada@GH.io', 'primary': True}]},
        },
    ),
    (
        'github_no_primary_email',
        'github',
        {
            'token': {'access_token': 'gh-at', 'userinfo': {'id': 7, 'name': 'Ada'}},
            'userinfo': {'id': 7, 'name': 'Ada'},
            'github_emails': {'ok': True, 'json': [{'email': 'old@x.io'}]},
        },
    ),
    (
        'github_email_request_fails',
        'github',
        {
            'token': {'access_token': 'gh-at', 'userinfo': {'id': 7, 'name': 'Ada'}},
            'userinfo': {'id': 7, 'name': 'Ada'},
            'github_emails': {'ok': False},
        },
    ),
    (
        'email_fallback',
        'oidc',
        {
            'env': {'ENABLE_OAUTH_EMAIL_FALLBACK': True},
            'token': {**TOKEN, 'userinfo': {'sub': 's9', 'name': 'N'}},
            'userinfo': {'sub': 's9', 'name': 'N'},
        },
    ),
    (
        'email_missing',
        'oidc',
        {'token': {**TOKEN, 'userinfo': {'sub': 's9', 'name': 'N'}}, 'userinfo': {'sub': 's9', 'name': 'N'}},
    ),
    ('domain_not_allowed', 'oidc', {'config': {'OAUTH_ALLOWED_DOMAINS': ['corp.test']}}),
    (
        'domain_allowed_email_unchanged',
        'oidc',
        {'config': {'OAUTH_ALLOWED_DOMAINS': ['example.com'], 'OAUTH_UPDATE_EMAIL_ON_LOGIN': True}, 'by_sub': ADA},
    ),
    ('session_not_created', 'oidc', {'by_sub': ADA, 'create_session': 'none'}),
    ('session_storage_fails', 'oidc', {'by_sub': ADA, 'create_session': 'raise'}),
    ('no_id_token_cookie', 'oidc', {'by_sub': ADA, 'env': {'ENABLE_OAUTH_ID_TOKEN_COOKIE': False}}),
    ('jwt_never_expires', 'oidc', {'by_sub': ADA, 'config': {'JWT_EXPIRES_IN': '-1'}}),
    ('webui_url_redirect', 'oidc', {'by_sub': ADA, 'webui_url': 'https://chat.example.com/'}),
    (
        'group_sync_fails',
        'oidc',
        {'by_sub': ADA, 'config': {'ENABLE_OAUTH_GROUP_MANAGEMENT': True}, 'groups_raise': True},
    ),
    ('invalid_jwt_lifetime', 'oidc', {'by_sub': ADA, 'config': {'JWT_EXPIRES_IN': 'forever'}}),
]

LOGOUT_EVENT = {'http://schemas.openid.net/event/backchannel-logout': {}}
LOGOUT_CLAIMS = {'iss': 'https://idp.test', 'aud': 'cid', 'iat': 1_700_000_000, 'events': LOGOUT_EVENT, 'sub': 'sub-1'}
LOGOUT_CASES = [
    ('form_unreadable', {'form': 'raise'}),
    ('token_missing', {'form': {}}),
    ('token_malformed', {'raw_token': 'not-a-jwt'}),
    ('issuer_missing', {'claims': {k: v for k, v in LOGOUT_CLAIMS.items() if k != 'iss'}}),
    ('issuer_unknown', {'claims': {**LOGOUT_CLAIMS, 'iss': 'https://stranger.test'}}),
    ('provider_without_jwks_uri', {'oidc_metadata': {'issuer': 'https://idp.test'}}),
    ('provider_without_client_id', {'client_id': ''}),
    ('kid_missing', {'kid': None}),
    ('jwks_empty', {'jwks': {'keys': []}}),
    ('jwks_fetch_fails', {'jwks': 'raise'}),
    ('kid_unknown', {'kid': 'k-other'}),
    ('key_for_encryption_only', {'key_use': 'enc'}),
    ('key_without_use', {'key_use': None, 'user': ADA}),
    ('signature_wrong_key', {'sign_with': 'other'}),
    ('audience_wrong', {'claims': {**LOGOUT_CLAIMS, 'aud': 'someone-else'}}),
    ('events_claim_missing', {'claims': {k: v for k, v in LOGOUT_CLAIMS.items() if k != 'events'}}),
    ('logout_event_missing', {'claims': {**LOGOUT_CLAIMS, 'events': {'other': {}}}}),
    ('nonce_present', {'claims': {**LOGOUT_CLAIMS, 'nonce': 'n'}}),
    ('sub_and_sid_missing', {'claims': {k: v for k, v in LOGOUT_CLAIMS.items() if k != 'sub'}}),
    ('sid_only', {'claims': {**{k: v for k, v in LOGOUT_CLAIMS.items() if k != 'sub'}, 'sid': 'sid-1'}}),
    ('sub_unknown', {'claims': {**LOGOUT_CLAIMS, 'sid': 'sid-1'}}),
    ('sub_numeric', {'claims': {**LOGOUT_CLAIMS, 'sub': 42}, 'user': ADA}),
    ('user_logged_out', {'user': ADA, 'sessions': ['s1', 's2']}),
    ('user_logged_out_without_redis', {'user': ADA, 'sessions': ['s1'], 'redis': None}),
]

CASES = [(f'callback:{c}', 'callback', p, w) for c, p, w in CALLBACK_CASES] + [
    (f'logout:{c}', 'logout', None, w) for c, w in LOGOUT_CASES
]

AUTH_CONFIG = {
    'ENABLE_OAUTH': True,
    'OAUTH_EMAIL_CLAIM': 'email',
    'OAUTH_USERNAME_CLAIM': 'name',
    'OAUTH_PICTURE_CLAIM': 'picture',
    'OAUTH_SUB_CLAIM': '',
    'OAUTH_ALLOWED_DOMAINS': ['*'],
    'OAUTH_MERGE_ACCOUNTS_BY_EMAIL': False,
    'OAUTH_UPDATE_NAME_ON_LOGIN': False,
    'OAUTH_UPDATE_EMAIL_ON_LOGIN': False,
    'OAUTH_UPDATE_PICTURE_ON_LOGIN': False,
    'ENABLE_OAUTH_SIGNUP': True,
    'JWT_EXPIRES_IN': '4w',
    'ENABLE_OAUTH_GROUP_MANAGEMENT': False,
}
ENV = {
    'OAUTH_ACCESS_TOKEN_REQUEST_INCLUDE_CLIENT_ID': False,
    'ENABLE_OAUTH_EMAIL_FALLBACK': False,
    'ENABLE_OAUTH_ID_TOKEN_COOKIE': True,
    'OAUTH_MAX_SESSIONS_PER_USER': 3,
    'LLLM_AUTH_COOKIE_SAME_SITE': 'lax',
    'LLLM_AUTH_COOKIE_SECURE': False,
}
PROVIDERS = {
    'oidc': {'sub_claim': 'sub', 'picture_url': ''},
    'github': {'sub_claim': 'id', 'picture_url': 'https://github.test/default.png'},
    'feishu': {'sub_claim': 'open_id'},
    'unregistered': {},
}

KEYS = {name: rsa.generate_private_key(public_exponent=65537, key_size=2048) for name in ('good', 'other')}


class _FixedDatetime(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 10, 17, 12, 0, 0, tzinfo=dt.UTC)


def _user(record):
    if record is None:
        return None
    return SimpleNamespace(
        id=record['id'],
        name=record['name'],
        email=record['email'],
        oauth=copy.deepcopy(record['oauth']),
        profile_image_url=record['picture'],
        role=record.get('role', 'user'),
    )


def _uid(user):
    return user.id if user is not None else None


class _Client:
    client_id = 'cid'

    def __init__(self, world, log):
        self.world, self.log = world, log
        self.authorize_results = list(world.get('authorize', ['ok']))
        metadata = world.get('metadata', {'jwks': {'keys': ['stale']}})
        if metadata is not None:
            self.server_metadata = copy.deepcopy(metadata)

    async def authorize_access_token(self, request, **params):
        cached = 'jwks' in getattr(self, 'server_metadata', {})
        self.log.append(['authorize_access_token', params, {'jwks_cached': cached}])
        result = self.authorize_results.pop(0)
        if result == 'bad_signature':
            raise BadSignatureError()
        if result == 'raise':
            raise RuntimeError('invalid_grant: authorization code expired')
        return copy.deepcopy(self.world.get('token', TOKEN))

    async def userinfo(self, token):
        self.log.append(['userinfo', token.get('access_token')])
        return copy.deepcopy(self.world.get('userinfo', ID_CLAIMS))


class _GitHubSession:
    def __init__(self, world, log):
        self.world, self.log = world, log

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def get(self, url, headers=None, ssl=None):
        self.log.append(['github_get', url, headers, ssl is oauth.AIOHTTP_CLIENT_SESSION_SSL])
        reply = self.world['github_emails']
        session = self

        class _Resp:
            ok = reply['ok']

            async def json(self):
                return copy.deepcopy(reply.get('json'))

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

        session.log.append(['github_reply_ok', reply['ok']])
        return _Resp()


def _install_users(m, world, log):
    users = {}
    for record in [world.get('by_sub'), *world.get('by_email', {}).values()]:
        if record:
            users[record['id']] = _user(record)
    by_sub_id = world['by_sub']['id'] if world.get('by_sub') else None
    fail = world.get('updates_fail', False)

    async def get_user_by_oauth_sub(provider, sub, db=None):
        log.append(['user_by_oauth_sub', provider, sub, db])
        return users.get(by_sub_id)

    async def get_user_by_email(email, db=None):
        log.append(['user_by_email', email, db])
        record = world.get('by_email', {}).get(email.lower())
        return users.get(record['id']) if record else None

    async def update_user_oauth_by_id(user_id, provider, sub, db=None):
        log.append(['update_user_oauth', user_id, provider, sub, db])
        if world.get('oauth_update_fails'):
            return None
        users[user_id].oauth = {
            **(users[user_id].oauth if isinstance(users[user_id].oauth, dict) else {}),
            provider: {'sub': sub},
        }
        return copy.copy(users[user_id])

    async def update_user_by_id(user_id, data, db=None):
        log.append(['update_user', user_id, data, db])
        if fail:
            return None
        for key, value in data.items():
            setattr(users[user_id], key, value)
        return copy.copy(users[user_id])

    async def get_user_by_id(user_id, db=None):
        log.append(['user_by_id', user_id, db])
        return copy.copy(users.get(user_id))

    async def update_user_profile_image_url_by_id(user_id, url, db=None):
        log.append(['update_profile_image', user_id, url, db])
        if fail:
            return None
        users[user_id].profile_image_url = url
        return copy.copy(users[user_id])

    async def get_num_users(db=None):
        log.append(['num_users', db])
        return world.get('num_users', 2)

    async def update_user_role_by_id(user_id, role, db=None):
        log.append(['update_role', user_id, role, db])
        users[user_id].role = role

    async def update_email_by_id(user_id, email, db=None):
        log.append(['update_email', user_id, email, db])
        if fail:
            return False
        users[user_id].email = email
        return True

    async def insert_new_auth(email, password, name, profile_image_url, role, oauth, db=None):
        log.append(['insert_new_auth', email, password, name, profile_image_url, role, oauth, db])
        if world.get('insert_fails'):
            return None
        users['u-new'] = SimpleNamespace(
            id='u-new', name=name, email=email, oauth=oauth, profile_image_url=profile_image_url, role=role
        )
        return copy.copy(users['u-new'])

    for name, fake in [
        ('get_user_by_oauth_sub', get_user_by_oauth_sub),
        ('get_user_by_email', get_user_by_email),
        ('update_user_oauth_by_id', update_user_oauth_by_id),
        ('update_user_by_id', update_user_by_id),
        ('get_user_by_id', get_user_by_id),
        ('update_user_profile_image_url_by_id', update_user_profile_image_url_by_id),
        ('get_num_users', get_num_users),
        ('update_user_role_by_id', update_user_role_by_id),
    ]:
        m.setattr(oauth.Users, name, fake)
    m.setattr(oauth.Auths, 'update_email_by_id', update_email_by_id)
    m.setattr(oauth.Auths, 'insert_new_auth', insert_new_auth)


def _install_sessions(m, world, log):
    async def get_sessions_by_user_id(user_id, db=None):
        log.append(['sessions_by_user', user_id, db])
        return [SimpleNamespace(**s) for s in world.get('sessions', [])]

    async def delete_session_by_id(session_id, db=None):
        log.append(['delete_session', session_id, db])

    async def create_session(user_id, provider, token, db=None):
        log.append(['create_session', user_id, provider, token, db])
        outcome = world.get('create_session', 'ok')
        if outcome == 'raise':
            raise RuntimeError('database is locked')
        return SimpleNamespace(id='sess-new') if outcome == 'ok' else None

    m.setattr(oauth.OAuthSessions, 'get_sessions_by_user_id', get_sessions_by_user_id)
    m.setattr(oauth.OAuthSessions, 'delete_session_by_id', delete_session_by_id)
    m.setattr(oauth.OAuthSessions, 'create_session', create_session)


def _install_app(m, world, log):
    config = {**AUTH_CONFIG, **world.get('config', {})}
    stored = {'webui.url': world.get('webui_url'), 'ui.default_group_id': 'g-default', 'user.permissions': {'chat': 1}}

    async def get_oauth_runtime_config():
        return SimpleNamespace(**copy.deepcopy(config))

    async def config_get(key):
        log.append(['config_get', key])
        return copy.deepcopy(stored.get(key))

    async def publish_event(request, event, actor=None, subject_id=None, **kwargs):
        log.append(['event', str(event), _uid(actor), subject_id, kwargs])

    async def apply_default_group_assignment(group_id, user_id, db=None):
        log.append(['default_group', group_id, user_id, db])

    async def get_password_hash(password):
        return f'hash:{password}'

    def create_token(data, expires_delta=None):
        log.append(['create_token', data, expires_delta.total_seconds() if expires_delta else None])
        return f'jwt-{data["id"]}'

    async def revoke_user_tokens(request, user_id):
        log.append(['revoke_user_tokens', user_id])

    m.setattr(oauth, 'get_oauth_runtime_config', get_oauth_runtime_config)
    m.setattr(oauth.Config, 'get', config_get)
    m.setattr(oauth, 'publish_event', publish_event)
    m.setattr(oauth, 'apply_default_group_assignment', apply_default_group_assignment)
    m.setattr(oauth, 'get_password_hash', get_password_hash)
    m.setattr(oauth, 'create_token', create_token)
    m.setattr(oauth, 'revoke_user_tokens', revoke_user_tokens)
    m.setattr(oauth, 'OAUTH_PROVIDERS', copy.deepcopy(PROVIDERS))
    m.setattr(oauth, 'dt', SimpleNamespace(datetime=_FixedDatetime, timedelta=dt.timedelta, timezone=dt.timezone))
    m.setattr(oauth.uuid, 'uuid4', lambda: 'uuid-fixed')
    m.setattr(oauth.aiohttp, 'ClientSession', lambda trust_env=False: _GitHubSession(world, log))
    for name, value in {**ENV, **world.get('env', {})}.items():
        m.setattr(oauth, name, value)


def _manager(world, log, clients):
    manager = oauth.OAuthManager(app=None)
    manager._clients = clients

    async def update_user_role_from_oauth(request, user, user_data, provider, db=None):
        log.append(['update_role_from_oauth', user.id, dict(user_data), provider, db])
        return user

    async def update_user_groups(request, user, user_data, default_permissions, db=None):
        log.append(['update_user_groups', user.id, dict(user_data), default_permissions, db])
        if world.get('groups_raise'):
            raise RuntimeError('group sync failed')

    async def process_picture_url(picture_url, access_token=None):
        log.append(['process_picture', picture_url, access_token])
        return f'processed:{picture_url}'

    async def get_user_role(user, user_data):
        log.append(['get_user_role', _uid(user), dict(user_data)])
        return 'pending'

    manager.update_user_role_from_oauth = update_user_role_from_oauth
    manager.update_user_groups = update_user_groups
    manager._process_picture_url = process_picture_url
    manager.get_user_role = get_user_role
    return manager


def _redirect(response) -> dict:
    headers = [[k.decode(), v.decode()] for k, v in response.raw_headers]
    return {'status': response.status_code, 'headers': headers}


def _run_callback(provider, world, m):
    log = []
    _install_app(m, world, log)
    _install_users(m, world, log)
    _install_sessions(m, world, log)
    clients = {name: _Client(world, log) for name in ('oidc', 'github', 'feishu')}
    manager = _manager(world, log, clients)
    request = SimpleNamespace(base_url='http://app.local/')
    response = SimpleNamespace(headers={'x-request-id': 'req-1'})
    try:
        outcome = {'redirect': _redirect(asyncio.run(manager.handle_callback(request, provider, response, db='<db>')))}
    except HTTPException as e:
        outcome = {'http_error': [e.status_code, e.detail]}
    return {**outcome, 'calls': log}


def _jwk(name, kid, use):
    key = jwt.algorithms.RSAAlgorithm.to_jwk(KEYS[name].public_key(), as_dict=True)
    return {**key, 'kid': kid, 'alg': 'RS256', **({'use': use} if use else {})}


def _logout_token(world):
    if 'raw_token' in world:
        return world['raw_token']
    kid = world.get('kid', 'k1')
    headers = {'kid': kid} if kid else {}
    return jwt.encode(
        world.get('claims', LOGOUT_CLAIMS), KEYS[world.get('sign_with', 'good')], 'RS256', headers=headers
    )


class _LogoutClient:
    def __init__(self, metadata, world, log, client_id='cid'):
        self.metadata, self.world, self.log, self.client_id = metadata, world, log, client_id

    async def load_server_metadata(self):
        self.log.append(['load_server_metadata', self.client_id])
        if self.metadata == 'raise':
            raise RuntimeError('discovery unreachable')
        return copy.deepcopy(self.metadata)

    async def fetch_jwk_set(self):
        self.log.append(['fetch_jwk_set', self.client_id])
        jwks = self.world.get('jwks', 'good')
        if jwks == 'raise':
            raise RuntimeError('jwks unreachable')
        if jwks == 'good':
            return {'keys': [_jwk('good', 'k1', self.world.get('key_use', 'sig'))]}
        return copy.deepcopy(jwks)


def _run_logout(world, m):
    log = []
    _install_app(m, world, log)
    _install_sessions(m, {'sessions': [{'id': s} for s in world.get('sessions', [])]}, log)
    m.setattr(oauth, 'OAUTH_PROVIDERS', {'unregistered': {}, 'broken': {}, 'other': {}, 'oidc': {}})

    async def get_user_by_oauth_sub(provider, sub, db=None):
        log.append(['user_by_oauth_sub', provider, sub, db])
        return _user(world.get('user'))

    m.setattr(oauth.Users, 'get_user_by_oauth_sub', get_user_by_oauth_sub)
    oidc_metadata = world.get('oidc_metadata', {'issuer': 'https://idp.test', 'jwks_uri': 'https://idp.test/jwks'})
    clients = {
        'broken': _LogoutClient('raise', world, log, client_id='broken'),
        'other': _LogoutClient({'issuer': 'https://other.test', 'jwks_uri': 'x'}, world, log, client_id='other'),
        'oidc': _LogoutClient(oidc_metadata, world, log, client_id=world.get('client_id', 'cid')),
    }
    manager = _manager(world, log, clients)
    token = _logout_token(world)

    async def form():
        if world.get('form') == 'raise':
            raise RuntimeError('body is not form-encoded')
        return world.get('form', {'logout_token': token})

    request = SimpleNamespace(
        form=form, app=SimpleNamespace(state=SimpleNamespace(redis=world.get('redis', '<redis>')))
    )
    response = asyncio.run(manager.handle_backchannel_logout(request, db='<db>'))
    return {'response': [response.status_code, json.loads(response.body)], 'calls': log}


def _run(kind, provider, world, monkeypatch):
    observed = _run_callback(provider, world, monkeypatch) if kind == 'callback' else _run_logout(world, monkeypatch)
    return json.loads(json.dumps(observed, default=repr))


def _golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding='utf-8'))


def test_case_ids_are_unique():
    ids = [case[0] for case in CASES]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize(('case_id', 'kind', 'provider', 'world'), CASES, ids=[c[0] for c in CASES])
def test_oauth_matches_golden(monkeypatch, case_id, kind, provider, world):
    observed = _run(kind, provider, world, monkeypatch)
    if RECORD:
        pytest.skip('recording')
    assert observed == _golden()[case_id]


def test_record_golden(monkeypatch):
    """Writes the golden file, only when OAUTH_GOLDEN_RECORD=1."""
    if not RECORD:
        pytest.skip('set OAUTH_GOLDEN_RECORD=1 to record the golden file')
    golden = {}
    for case_id, kind, provider, world in CASES:
        with monkeypatch.context() as m:
            golden[case_id] = _run(kind, provider, world, m)
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
