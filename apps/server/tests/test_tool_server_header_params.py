"""An OpenAPI tool call sends its header and cookie parameters (#190).

`convert_openapi_to_tool_payload` offers every parameter to the model,
`in: header` and `in: cookie` ones included, and marks the required ones
required. But `_route_params` routed only path and query parameters, so
a header the model filled in (an `X-Api-Version`, say) was dropped, and the
tool server saw none. Header parameters now go as request headers and
cookie parameters as cookies.

The connection's own headers and cookies (its auth, mostly) are not
replaced by a value the model gives: where both name the same header or
cookie, the connection's wins. Some headers are never taken from the
model's arguments, nor offered to it in the tool's parameters: the three
OpenAPI says a parameter definition must ignore (Accept, Content-Type,
Authorization), those that frame the request (Host, Content-Length, ...), and
those this app sends itself (the user and session headers), which a call may
not carry, so "the connection's wins" alone would not keep them out.

Run from apps/server:

    python -m pytest tests/test_tool_server_header_params.py
"""

import asyncio

import pytest

from local_llm.utils import tools


def _server(parameters):
    return {'openapi': {'paths': {'/items': {'get': {'operationId': 'list_items', 'parameters': parameters}}}}}


class _Response:
    status = 200
    headers = {'Content-Type': 'application/json'}

    async def json(self):
        return {'ok': True}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def _call(monkeypatch, parameters, params, headers=None, cookies=None):
    sent = []

    class _Session:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def get(self, url, **kwargs):
            sent.append({'url': url, 'headers': kwargs.get('headers'), 'cookies': kwargs.get('cookies')})
            return _Response()

    monkeypatch.setattr(tools.aiohttp, 'ClientSession', _Session)
    result = asyncio.run(
        tools.execute_tool_server(
            'https://items.test', headers or {}, cookies or {}, 'list_items', params, _server(parameters)
        )
    )
    assert result[0] == {'ok': True}
    (request,) = sent
    return request


VERSION = {'name': 'X-Api-Version', 'in': 'header', 'required': True, 'schema': {'type': 'string'}}
SESSION = {'name': 'session', 'in': 'cookie', 'schema': {'type': 'string'}}
QUERY = {'name': 'q', 'in': 'query', 'schema': {'type': 'string'}}


def test_a_header_parameter_is_sent_as_a_header(monkeypatch):
    request = _call(
        monkeypatch, [VERSION, QUERY], {'X-Api-Version': '2', 'q': 'x'}, headers={'Authorization': 'Bearer k'}
    )

    assert request['headers'] == {'Authorization': 'Bearer k', 'X-Api-Version': '2'}
    assert request['url'] == 'https://items.test/items?q=x'


def test_a_cookie_parameter_is_sent_as_a_cookie(monkeypatch):
    request = _call(monkeypatch, [SESSION], {'session': 'abc'}, cookies={'other': '1'})

    assert request['cookies'] == {'other': '1', 'session': 'abc'}
    assert request['url'] == 'https://items.test/items'


def test_header_and_cookie_values_are_sent_as_text(monkeypatch):
    parameters = [
        {'name': 'X-Count', 'in': 'header'},
        {'name': 'X-Dry-Run', 'in': 'header'},
        {'name': 'X-Tags', 'in': 'header'},
        {'name': 'page', 'in': 'cookie'},
    ]
    request = _call(monkeypatch, parameters, {'X-Count': 3, 'X-Dry-Run': True, 'X-Tags': ['a', 'b'], 'page': 2})

    # OpenAPI's default style for a header is "simple": an array is its
    # values joined by commas. A boolean is written as JSON writes it.
    assert request['headers'] == {'X-Count': '3', 'X-Dry-Run': 'true', 'X-Tags': 'a,b'}
    assert request['cookies'] == {'page': '2'}


def test_a_missing_none_or_empty_optional_header_is_not_sent(monkeypatch):
    parameters = [{'name': 'X-Trace', 'in': 'header'}, {'name': 'X-Other', 'in': 'header'}, SESSION]
    request = _call(monkeypatch, parameters, {'X-Trace': '', 'X-Other': None, 'session': ''})

    assert request['headers'] == {}
    assert request['cookies'] == {}


def test_the_connections_own_header_and_cookie_win(monkeypatch):
    parameters = [{'name': 'x-api-key', 'in': 'header'}, SESSION]
    request = _call(
        monkeypatch,
        parameters,
        {'x-api-key': 'from-model', 'session': 'from-model'},
        headers={'X-API-Key': 'configured'},
        cookies={'session': 'configured'},
    )

    assert request['headers'] == {'X-API-Key': 'configured'}
    assert request['cookies'] == {'session': 'configured'}


RESERVED = [
    'Authorization',
    'accept',
    'Content-Type',
    'Host',
    'content-length',
    'Transfer-Encoding',
    'Connection',
    'Cookie',
    'X-User-Id',
    'x-session-id',
    'X-Terminal-Context-Id',
    'x-lllm-user-id',
    'X-LLLM-User-Name',
    'X-LLLM-User-Email',
    'X-LLLM-User-Role',
    'X-LLLM-User-Jwt',
    'X-LLLM-Chat-Id',
    'X-LLLM-Message-Id',
]


@pytest.mark.parametrize('name', RESERVED)
def test_a_reserved_header_is_not_sent(monkeypatch, name):
    request = _call(monkeypatch, [{'name': name, 'in': 'header'}], {name: 'from-model'})

    assert request['headers'] == {}


def test_the_connections_headers_are_not_changed_in_place(monkeypatch):
    headers = {'Authorization': 'Bearer k'}
    _call(monkeypatch, [VERSION], {'X-Api-Version': '2'}, headers=headers)

    assert headers == {'Authorization': 'Bearer k'}


def test_object_and_null_values_are_written_in_the_simple_style(monkeypatch):
    parameters = [{'name': 'X-Filter', 'in': 'header'}, {'name': 'X-Tags', 'in': 'header'}]
    request = _call(monkeypatch, parameters, {'X-Filter': {'a': 1, 'b': None, 'c': 'x'}, 'X-Tags': ['a', None, 'b']})

    assert request['headers'] == {'X-Filter': 'a,1,c,x', 'X-Tags': 'a,b'}


def test_the_tool_offers_header_parameters_but_not_reserved_ones():
    parameters = [
        VERSION,
        {'name': 'Authorization', 'in': 'header', 'required': True, 'schema': {'type': 'string'}},
        {'name': 'x-lllm-user-id', 'in': 'header', 'schema': {'type': 'string'}},
        SESSION,
        QUERY,
    ]
    (tool,) = tools.convert_openapi_to_tool_payload(_server(parameters)['openapi'])

    assert set(tool['parameters']['properties']) == {'X-Api-Version', 'session', 'q'}
    assert tool['parameters']['required'] == ['X-Api-Version']


def test_a_query_parameter_named_like_a_reserved_header_is_still_offered_and_sent(monkeypatch):
    parameters = [{'name': 'host', 'in': 'query', 'schema': {'type': 'string'}}]
    (tool,) = tools.convert_openapi_to_tool_payload(_server(parameters)['openapi'])
    request = _call(monkeypatch, parameters, {'host': 'a.example'})

    assert set(tool['parameters']['properties']) == {'host'}
    assert request['url'] == 'https://items.test/items?host=a.example'
