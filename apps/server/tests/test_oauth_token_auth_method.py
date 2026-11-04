"""MCP OAuth picks a token endpoint auth method this client can use (#273).

The client model accepts only `none`, `client_secret_basic` and
`client_secret_post`. When an authorization server's metadata did not list
`client_secret_post`, both dynamic registration and the static-credentials
path took the server's first listed method instead, such as
`private_key_jwt`, which the client cannot use: the registration response
or the static client info then failed validation, and MCP OAuth failed
against that server. Now the first method the server lists that the client
supports is taken, in the server's order (a static client with no secret
takes `none` when it is listed); `client_secret_post` is still used whenever
the server lists it, as before. And token refresh, which always sent the
secret in the form body, now sends the credentials as the chosen method
says: an Authorization header for `client_secret_basic`, the client id only
for `none`.

Run from apps/server:

    python -m pytest tests/test_oauth_token_auth_method.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from local_llm.utils import oauth


def pick(offered, *, has_secret):
    return oauth._token_endpoint_auth_method(offered, has_secret=has_secret)


@pytest.mark.parametrize(
    ('offered', 'has_secret', 'expected'),
    [
        (None, True, 'client_secret_post'),
        ([], True, 'client_secret_post'),
        (['client_secret_basic', 'client_secret_post'], True, 'client_secret_post'),
        (['client_secret_post', 'none'], False, 'client_secret_post'),
        (['private_key_jwt', 'client_secret_basic'], True, 'client_secret_basic'),
        (['private_key_jwt', 'none', 'client_secret_basic'], True, 'none'),
        (['none', 'client_secret_basic'], True, 'none'),
        (['private_key_jwt', 'client_secret_basic', 'none'], True, 'client_secret_basic'),
        (['private_key_jwt', 'client_secret_basic', 'none'], False, 'none'),
        (['private_key_jwt', 'client_secret_basic'], False, 'client_secret_basic'),
        (['private_key_jwt', 'tls_client_auth'], True, 'client_secret_post'),
    ],
)
def test_the_method_is_the_first_the_server_lists_that_the_client_supports(offered, has_secret, expected):
    assert pick(offered, has_secret=has_secret) == expected


METADATA = {
    'issuer': 'https://as.example.com',
    'authorization_endpoint': 'https://as.example.com/authorize',
    'token_endpoint': 'https://as.example.com/token',
    'registration_endpoint': 'https://as.example.com/register',
    'response_types_supported': ['code'],
    'token_endpoint_auth_methods_supported': ['private_key_jwt', 'client_secret_basic'],
}


class _Response:
    def __init__(self, body, status=200):
        self.status = status
        self._body = body

    async def json(self):
        return self._body

    async def text(self):
        return str(self._body)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


@pytest.fixture
def server(monkeypatch):
    """A fake authorization server; `registered` collects what dynamic registration sent."""
    registered = []

    class _Session:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def get(self, url, **kwargs):
            return _Response(METADATA)

        def post(self, url, json: dict, **kwargs):
            registered.append(json)
            # A compliant server echoes the registered method back.
            return _Response({**json, 'client_id': 'registered-id', 'client_secret': 's3cret'})

    async def resource_metadata(url):
        return SimpleNamespace(
            resource=None,
            scopes_supported=None,
            get_discovery_urls=lambda _: ['https://as.example.com/.well-known/oauth-authorization-server'],
        )

    async def redirect_base(request):
        return 'https://llm.example'

    monkeypatch.setattr(oauth.aiohttp, 'ClientSession', _Session)
    monkeypatch.setattr(oauth, 'get_protected_resource_metadata', resource_metadata)
    monkeypatch.setattr(oauth, 'stored_redirect_base_url', redirect_base)
    return registered


def test_dynamic_registration_uses_a_method_the_client_supports(server):
    info = asyncio.run(
        oauth.get_oauth_client_info_with_dynamic_client_registration(None, 'mcp:x', 'https://mcp.example.com')
    )

    assert server[0]['token_endpoint_auth_method'] == 'client_secret_basic'
    assert info.client_id == 'registered-id'
    assert info.token_endpoint_auth_method == 'client_secret_basic'


def test_static_credentials_use_a_method_the_client_supports(server):
    info = asyncio.run(
        oauth.get_oauth_client_info_with_static_credentials(None, 'mcp:x', 'https://mcp.example.com', 'id', 'secret')
    )

    assert info.token_endpoint_auth_method == 'client_secret_basic'
    assert server == []


def test_static_credentials_without_a_secret_use_none_when_offered(server, monkeypatch):
    monkeypatch.setitem(
        METADATA, 'token_endpoint_auth_methods_supported', ['private_key_jwt', 'client_secret_basic', 'none']
    )
    info = asyncio.run(
        oauth.get_oauth_client_info_with_static_credentials(None, 'mcp:x', 'https://mcp.example.com', 'id', '')
    )

    assert info.token_endpoint_auth_method == 'none'


@pytest.mark.parametrize(
    ('method', 'secret', 'body', 'authorization'),
    [
        ('client_secret_basic', 's3cret', {}, 'Basic Y2lkOnMzY3JldA=='),
        ('client_secret_post', 's3cret', {'client_id': 'cid', 'client_secret': 's3cret'}, None),
        (None, 's3cret', {'client_id': 'cid', 'client_secret': 's3cret'}, None),
        ('none', None, {'client_id': 'cid'}, None),
        ('none', 's3cret', {'client_id': 'cid'}, None),
        ('client_secret_basic', None, {'client_id': 'cid'}, None),
    ],
)
def test_a_refresh_sends_the_credentials_as_the_method_says(monkeypatch, method, secret, body, authorization):
    posted = []

    class _Session:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def get(self, url, **kwargs):
            return _Response({'token_endpoint': 'https://as.example.com/token'})

        def post(self, url, data: dict, auth=None, **kwargs):
            posted.append((data, auth.encode() if auth else None))
            return _Response({'access_token': 'new', 'expires_in': 3600})

    async def runtime():
        return SimpleNamespace(OAUTH_REFRESH_TOKEN_INCLUDE_SCOPE=False)

    manager = oauth.OAuthClientManager(app=None)

    async def get_client(_id):
        return SimpleNamespace(client_id='cid', client_secret=secret, client_kwargs={})

    async def get_client_info(_id):
        return SimpleNamespace(token_endpoint_auth_method=method, resource=None, oauth_resource_parameter=None)

    async def metadata_url(_id):
        return 'https://as.example.com/.well-known/oauth-authorization-server'

    monkeypatch.setattr(oauth.aiohttp, 'ClientSession', _Session)
    monkeypatch.setattr(oauth, 'get_oauth_runtime_config', runtime)
    monkeypatch.setattr(manager, 'get_client', get_client)
    monkeypatch.setattr(manager, 'get_client_info', get_client_info)
    monkeypatch.setattr(manager, 'get_server_metadata_url', metadata_url)

    token = asyncio.run(
        manager._perform_token_refresh(SimpleNamespace(id='s1', provider='mcp:x', token={'refresh_token': 'r'}))
    )

    assert token is not None and token['access_token'] == 'new'
    ((data, sent_authorization),) = posted
    assert data == {'grant_type': 'refresh_token', 'refresh_token': 'r', **body}
    assert sent_authorization == authorization
