"""A failed OAuth refresh deletes the session only when the provider refused it (#284).

Both OAuthClientManager (MCP) and OAuthManager (SSO) deleted the session
on any refresh failure: a DNS error, an IdP 5xx, a metadata fetch that
failed. Each then had to be authorised again. Refresh also had no lock,
so two requests near expiry both refreshed with the same refresh token;
with rotation and reuse detection the second failed and deleted the
session the first had just updated.

Now only a definitive refusal (the token endpoint answering 400 or 401,
or no refresh token to send) deletes the session. A transient failure
keeps it, and returns the current token while it has not expired.
Refreshes of one session run one at a time, and a request that waited
uses the token the one before it obtained.

Run from apps/server:

    python -m pytest tests/test_oauth_refresh_keeps_session.py
"""

import asyncio
import time
from types import SimpleNamespace

import pytest

from local_llm.utils import oauth


class _Sessions:
    """OAuthSessions in memory."""

    def __init__(self, session):
        self.rows = {session.id: session}
        self.deleted: list[str] = []

    async def get_session_by_provider_and_user_id(self, provider, user_id, db=None):
        return next((s for s in self.rows.values() if s.provider == provider and s.user_id == user_id), None)

    async def get_session_by_id_and_user_id(self, session_id, user_id, db=None):
        s = self.rows.get(session_id)
        return s if s and s.user_id == user_id else None

    async def get_session_by_id(self, session_id, db=None):
        return self.rows.get(session_id)

    async def update_session_by_id(self, session_id, token, db=None):
        s = self.rows[session_id]
        self.rows[session_id] = SimpleNamespace(**{**vars(s), 'token': token, 'expires_at': token.get('expires_at')})
        return self.rows[session_id]

    async def delete_session_by_id(self, session_id, db=None):
        self.deleted.append(session_id)
        return self.rows.pop(session_id, None) is not None


def _session(provider, *, expires_in):
    token = {'access_token': 'old', 'refresh_token': 'r1', 'expires_at': int(time.time()) + expires_in}
    return SimpleNamespace(id='s1', provider=provider, user_id='u1', token=token, expires_at=token['expires_at'])


MANAGERS = {
    # (manager class, provider, how get_oauth_token names the session)
    'mcp': (oauth.OAuthClientManager, 'mcp:server', 'mcp:server'),
    'sso': (oauth.OAuthManager, 'oidc', 's1'),
}


@pytest.fixture(params=list(MANAGERS))
def manager(request, monkeypatch):
    cls, provider, key = MANAGERS[request.param]
    m = object.__new__(cls)

    def setup(*, expires_in=60):
        sessions = _Sessions(_session(provider, expires_in=expires_in))
        monkeypatch.setattr(oauth, 'OAuthSessions', sessions)
        return sessions

    def get(force_refresh=False):
        return m.get_oauth_token('u1', key, force_refresh=force_refresh)

    return SimpleNamespace(m=m, setup=setup, get=get, provider=provider)


def _refresh_with(manager, monkeypatch, outcome):
    calls: list[str] = []

    async def perform(session):
        calls.append(session.token['refresh_token'])
        await asyncio.sleep(0.01)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(manager.m, '_perform_token_refresh', perform)
    return calls


def test_a_transient_failure_keeps_the_session_and_its_unexpired_token(manager, monkeypatch):
    sessions = manager.setup(expires_in=60)
    _refresh_with(manager, monkeypatch, None)

    token = asyncio.run(manager.get())

    assert token['access_token'] == 'old'
    assert sessions.deleted == []


def test_a_transient_failure_after_expiry_returns_no_token_but_keeps_the_session(manager, monkeypatch):
    sessions = manager.setup(expires_in=-60)
    _refresh_with(manager, monkeypatch, None)

    assert asyncio.run(manager.get()) is None
    assert sessions.deleted == []


def test_a_refused_refresh_deletes_the_session(manager, monkeypatch):
    sessions = manager.setup(expires_in=-60)
    _refresh_with(manager, monkeypatch, oauth.RefreshRejected('400: invalid_grant'))

    assert asyncio.run(manager.get()) is None
    assert sessions.deleted == ['s1']


def test_concurrent_requests_refresh_once_and_share_the_new_token(manager, monkeypatch):
    manager.setup(expires_in=-60)
    new = {'access_token': 'new', 'refresh_token': 'r2', 'expires_at': int(time.time()) + 3600}
    calls = _refresh_with(manager, monkeypatch, new)

    async def both():
        return await asyncio.gather(manager.get(), manager.get())

    first, second = asyncio.run(both())

    assert calls == ['r1']
    assert first['access_token'] == second['access_token'] == 'new'


# --- what counts as a refusal -------------------------------------------------


class _Reply:
    def __init__(self, status, body=None):
        self.status = status
        self.body = body or {}

    async def json(self):
        return self.body

    async def text(self):
        return str(self.body)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def _endpoint(monkeypatch, *, post):
    """The IdP: discovery answers with a token endpoint, and the token endpoint answers with `post`."""

    class _Http:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def get(self, url, **kwargs):
            return _Reply(200, {'token_endpoint': 'https://idp.test/token'})

        def post(self, url, **kwargs):
            if isinstance(post, Exception):
                raise post
            return _Reply(*post)

    monkeypatch.setattr(oauth.aiohttp, 'ClientSession', _Http)


@pytest.fixture
def performer(manager, monkeypatch):
    client = SimpleNamespace(client_id='c', client_secret='', client_kwargs={})

    async def runtime_config():
        return SimpleNamespace(OAUTH_REFRESH_TOKEN_INCLUDE_SCOPE=False)

    monkeypatch.setattr(oauth, 'get_oauth_runtime_config', runtime_config)
    monkeypatch.setattr(oauth, 'should_send_oauth_resource', lambda info: False)
    if isinstance(manager.m, oauth.OAuthClientManager):

        async def get_client(_id):
            return client

        async def metadata_url(_id):
            return 'https://idp.test/.well-known/openid-configuration'

        async def client_info(_id):
            return SimpleNamespace(resource=None)

        monkeypatch.setattr(manager.m, 'get_client', get_client)
        monkeypatch.setattr(manager.m, 'get_server_metadata_url', metadata_url)
        monkeypatch.setattr(manager.m, 'get_client_info', client_info)
    else:
        monkeypatch.setattr(manager.m, 'get_client', lambda _p: client)
        monkeypatch.setattr(manager.m, 'get_server_metadata_url', lambda _p: 'https://idp.test/.well-known')
    return lambda: asyncio.run(manager.m._perform_token_refresh(_session(manager.provider, expires_in=-60)))


@pytest.mark.parametrize('status', [400, 401])
def test_the_token_endpoint_refusing_the_grant_is_a_refusal(performer, monkeypatch, status):
    _endpoint(monkeypatch, post=(status, {'error': 'invalid_grant'}))

    with pytest.raises(oauth.RefreshRejected):
        performer()


@pytest.mark.parametrize('post', [(503, {}), (429, {}), OSError('name resolution failed')])
def test_a_server_error_or_a_network_error_is_not_a_refusal(performer, monkeypatch, post):
    _endpoint(monkeypatch, post=post)

    assert performer() is None
