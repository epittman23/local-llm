"""An OpenAPI tool call sends its header and cookie parameters (#190).

`convert_openapi_to_tool_payload` offers every parameter to the model,
`in: header` and `in: cookie` ones included, and marks the required ones
required. But `_route_params` routed only path and query parameters, so
a header the model filled in (an `X-Api-Version`, say) was dropped, and the
tool server saw none. Header parameters now go as request headers and
cookie parameters as cookies.

The connection's own headers and cookies (its auth, mostly) are not
replaced by a value the model gives: where both name the same header or
cookie, the connection's wins. And the three header names OpenAPI says a
parameter definition must ignore (Accept, Content-Type, Authorization) are
never sent from the model's arguments.

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


@pytest.mark.parametrize('name', ['Authorization', 'accept', 'Content-Type'])
def test_a_header_openapi_ignores_is_not_sent(monkeypatch, name):
    request = _call(monkeypatch, [{'name': name, 'in': 'header'}], {name: 'from-model'})

    assert request['headers'] == {}


def test_the_connections_headers_are_not_changed_in_place(monkeypatch):
    headers = {'Authorization': 'Bearer k'}
    _call(monkeypatch, [VERSION], {'X-Api-Version': '2'}, headers=headers)

    assert headers == {'Authorization': 'Bearer k'}
