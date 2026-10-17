"""Characterization tests for routers/configs.py's verify_tool_servers_config.

It was refactored for ruff's complexity limit with no tests of its own, so
these pin what it did before the refactor: for MCP servers (OAuth 2.1
discovery, or a live connection with each auth type) and OpenAPI servers,
what it returns or raises and exactly what it sent where. OAuth discovery,
the HTTP session, the MCP client, custom header rendering, the OpenAPI spec
fetch and the OAuth token lookup are fakes that record their calls; the
request model and URL building run for real. Each case was recorded from
the untouched function into fixtures/verify_tool_server.json and must not
change.

The golden file is only ever written by hand, never by this test. To record
it again (only for an intended behaviour change, reviewed as such), run
`VERIFY_TOOL_SERVER_GOLDEN_RECORD=1 pytest tests/test_verify_tool_server.py`.
"""

import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.routers import configs

GOLDEN = Path(__file__).parent / 'fixtures' / 'verify_tool_server.json'
RECORD = os.environ.get('VERIFY_TOOL_SERVER_GOLDEN_RECORD') == '1'

METADATA = {
    'issuer': 'https://auth.example',
    'authorization_endpoint': 'https://auth.example/authorize',
    'token_endpoint': 'https://auth.example/token',
    'response_types_supported': ['code'],
}
D1 = 'https://auth.example/.well-known/oauth-authorization-server'
D2 = 'https://auth.example/.well-known/openid-configuration'


def _case(case_id, form, *, discovery=None, discovery_urls=(D1, D2), mcp=None, openapi=None, oauth=None, cookie=True):
    """form: ToolServerConnection fields. discovery: url -> [status, json body or 'invalid'].
    mcp: {'init': 'raise'?, 'connect': 'raise'?, 'specs': 'raise'?}. openapi: 'raise', 'http_error' or None.
    oauth: token lookup result: None, 'raise', or an access token string."""
    return (
        case_id,
        {
            'form': {
                'url': 'https://tools.example',
                'path': 'openapi.json',
                'auth_type': None,
                'key': None,
                'config': None,
                **form,
            },
            'discovery': discovery or {},
            'discovery_urls': list(discovery_urls),
            'mcp': mcp or {},
            'openapi': openapi,
            'oauth': oauth,
            'cookie': cookie,
        },
    )


MCP = {'type': 'mcp'}
CASES = [
    # --- MCP, OAuth 2.1 discovery ---
    _case('mcp_oauth_first_document', {**MCP, 'auth_type': 'oauth_2.1'}, discovery={D1: [200, METADATA]}),
    _case(
        'mcp_oauth_second_document', {**MCP, 'auth_type': 'oauth_2.1'}, discovery={D1: [404, {}], D2: [200, METADATA]}
    ),
    _case('mcp_oauth_static', {**MCP, 'auth_type': 'oauth_2.1_static'}, discovery={D1: [200, METADATA]}),
    _case(
        'mcp_oauth_server_url_from_info',
        {**MCP, 'auth_type': 'oauth_2.1', 'info': {'oauth_server_url': 'https://other-auth.example'}},
        discovery={D1: [200, METADATA]},
    ),
    _case(
        'mcp_oauth_info_without_server_url',
        {**MCP, 'auth_type': 'oauth_2.1', 'info': {'x': 1}},
        discovery={D1: [200, METADATA]},
    ),
    _case(
        'mcp_oauth_invalid_document',
        {**MCP, 'auth_type': 'oauth_2.1'},
        discovery={D1: [200, 'invalid'], D2: [200, METADATA]},
    ),
    _case('mcp_oauth_no_document', {**MCP, 'auth_type': 'oauth_2.1'}, discovery={D1: [404, {}], D2: [500, {}]}),
    _case('mcp_oauth_no_discovery_urls', {**MCP, 'auth_type': 'oauth_2.1'}, discovery_urls=()),
    # --- MCP, live connection ---
    _case('mcp_no_auth', {**MCP}),
    _case('mcp_bearer', {**MCP, 'auth_type': 'bearer', 'key': 'secret'}),
    _case('mcp_bearer_without_key', {**MCP, 'auth_type': 'bearer'}),
    _case('mcp_session', {**MCP, 'auth_type': 'session'}),
    _case('mcp_system_oauth', {**MCP, 'auth_type': 'system_oauth'}, oauth='oauth-token'),
    _case('mcp_system_oauth_no_token', {**MCP, 'auth_type': 'system_oauth'}, oauth=None),
    _case('mcp_system_oauth_lookup_fails', {**MCP, 'auth_type': 'system_oauth'}, oauth='raise'),
    _case('mcp_system_oauth_no_cookie', {**MCP, 'auth_type': 'system_oauth'}, oauth='oauth-token', cookie=False),
    _case('mcp_custom_headers', {**MCP, 'headers': {'team': 'a'}}),
    _case('mcp_custom_headers_with_token', {**MCP, 'auth_type': 'bearer', 'key': 'secret', 'headers': {'team': 'a'}}),
    _case('mcp_string_headers_ignored', {**MCP, 'auth_type': 'bearer', 'key': 'secret', 'headers': '{"team": "a"}'}),
    _case('mcp_connect_fails', {**MCP, 'auth_type': 'bearer', 'key': 'secret'}, mcp={'connect': 'raise'}),
    _case('mcp_listing_fails', {**MCP}, mcp={'specs': 'raise'}),
    _case('mcp_client_cannot_be_created', {**MCP}, mcp={'init': 'raise'}),
    # --- OpenAPI ---
    _case('openapi_no_auth', {}),
    _case('openapi_type_none', {'type': None}),
    _case('openapi_bearer', {'type': 'openapi', 'auth_type': 'bearer', 'key': 'secret'}),
    _case('openapi_session', {'auth_type': 'session'}),
    _case('openapi_system_oauth', {'auth_type': 'system_oauth'}, oauth='oauth-token'),
    _case('openapi_system_oauth_no_token', {'auth_type': 'system_oauth'}, oauth=None),
    _case('openapi_system_oauth_lookup_fails', {'auth_type': 'system_oauth'}, oauth='raise'),
    _case('openapi_system_oauth_no_cookie', {'auth_type': 'system_oauth'}, oauth='oauth-token', cookie=False),
    _case('openapi_custom_headers', {'headers': {'team': 'a'}}),
    _case('openapi_custom_headers_with_token', {'auth_type': 'bearer', 'key': 'secret', 'headers': {'team': 'a'}}),
    _case('openapi_full_url_path', {'path': 'https://elsewhere.example/spec.json'}),
    _case('openapi_url_trailing_slash', {'url': 'https://tools.example/', 'path': '/openapi.json'}),
    _case('openapi_fetch_http_error', {}, openapi='http_error'),
    _case('openapi_fetch_fails', {}, openapi='raise'),
]


class _FakeResponse:
    def __init__(self, status, body):
        self.status = status
        self._body = body

    async def json(self):
        return {'not': 'metadata'} if self._body == 'invalid' else self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def _run(spec: dict, monkeypatch) -> dict:
    log = {'discovery_fetched': [], 'mcp': [], 'openapi_fetch': None, 'oauth_lookups': []}

    async def get_discovery_urls(server_url):
        log['discovery_server_url'] = server_url
        return list(spec['discovery_urls'])

    class FakeSession:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def get(self, url, ssl=None):
            log['discovery_fetched'].append(url)
            status, body = spec['discovery'].get(url, [404, {}])
            return _FakeResponse(status, body)

    class FakeMCPClient:
        def __init__(self):
            if spec['mcp'].get('init') == 'raise':
                raise RuntimeError('cannot create client')

        async def connect(self, url, headers=None):
            log['mcp'].append({'connect': url, 'headers': headers})
            if spec['mcp'].get('connect') == 'raise':
                raise RuntimeError('refused')

        async def list_tool_specs(self):
            if spec['mcp'].get('specs') == 'raise':
                raise RuntimeError('bad listing')
            return [{'name': 'search'}]

        async def disconnect(self):
            log['mcp'].append('disconnect')

    async def get_custom_headers(headers, user):
        return {f'X-{key}': f'{value} for {user.id}' for key, value in headers.items()}

    async def get_tool_server_data(url, headers=None):
        log['openapi_fetch'] = {'url': url, 'headers': headers}
        if spec['openapi'] == 'raise':
            raise RuntimeError('unreachable')
        if spec['openapi'] == 'http_error':
            raise HTTPException(status_code=418, detail='teapot')
        return {'openapi': '3.1.0', 'paths': {}}

    async def get_oauth_token(user_id, session_id):
        log['oauth_lookups'].append([user_id, session_id])
        if spec['oauth'] == 'raise':
            raise RuntimeError('session expired')
        return {'access_token': spec['oauth']} if spec['oauth'] else None

    monkeypatch.setattr(configs, 'get_discovery_urls', get_discovery_urls)
    monkeypatch.setattr(configs.aiohttp, 'ClientSession', FakeSession)
    monkeypatch.setattr(configs, 'MCPClient', FakeMCPClient)
    monkeypatch.setattr(configs, 'get_custom_headers', get_custom_headers)
    monkeypatch.setattr(configs, 'get_tool_server_data', get_tool_server_data)

    request = SimpleNamespace(
        state=SimpleNamespace(token=SimpleNamespace(credentials='session-token')),
        cookies={'oauth_session_id': 'sess-1'} if spec['cookie'] else {},
        app=SimpleNamespace(state=SimpleNamespace(oauth_manager=SimpleNamespace(get_oauth_token=get_oauth_token))),
    )
    form = configs.ToolServerConnection(**spec['form'])
    user = SimpleNamespace(id='u1')
    try:
        outcome = {'returned': asyncio.run(configs.verify_tool_servers_config(request, form, user=user))}
    except HTTPException as e:
        outcome = {'http_error': e.status_code, 'detail': e.detail}
    return {**log, **outcome}


def _golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding='utf-8'))


def test_case_ids_are_unique():
    ids = [case[0] for case in CASES]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize(('case_id', 'spec'), CASES, ids=[c[0] for c in CASES])
def test_verify_matches_golden(monkeypatch, case_id, spec):
    observed = _run(spec, monkeypatch)
    if RECORD:
        pytest.skip('recording')
    assert observed == _golden()[case_id]


def test_record_golden(monkeypatch):
    """Writes the golden file, only when VERIFY_TOOL_SERVER_GOLDEN_RECORD=1."""
    if not RECORD:
        pytest.skip('set VERIFY_TOOL_SERVER_GOLDEN_RECORD=1 to record the golden file')
    golden = {}
    for case_id, spec in CASES:
        with monkeypatch.context() as m:
            golden[case_id] = _run(spec, m)
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
