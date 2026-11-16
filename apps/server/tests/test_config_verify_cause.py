"""routers/configs.py's tool and terminal connection tests say why they failed (#1018, as S5-D10 did for verify).

A refused connection, a timeout or a host not found is named with the host and port, never
the whole URL, which can carry a key; anything else keeps the old words. The HTTP session and
the spec fetch are fakes: no socket is opened.
"""

import asyncio
from types import SimpleNamespace

import aiohttp
import pytest
from fastapi import HTTPException

from local_llm.routers import configs


def _connector_error(cls, host, port):
    key = SimpleNamespace(host=host, port=port, ssl=None)
    os_error = OSError(111, 'Connect call failed')
    error = cls(key, os_error)
    # As aiohttp raises it: `raise ClientConnectorError(...) from exc`.
    error.__cause__ = os_error
    return error


class FakeGet:
    def __init__(self, outcome):
        self.outcome = outcome

    async def __aenter__(self):
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome

    async def __aexit__(self, *exc):
        return False


def _session(outcomes, calls):
    """A session whose successive GETs meet `outcomes` in order (a response or an error)."""

    class FakeSession:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def get(self, url=None, **kwargs):
            calls.append(url)
            return FakeGet(outcomes[len(calls) - 1])

    return FakeSession


def _terminal(monkeypatch, url, outcomes):
    calls = []
    monkeypatch.setattr(configs.aiohttp, 'ClientSession', _session(outcomes, calls))
    form = configs.TerminalServerConnection(url=url, key='sk-secret', auth_type='bearer')
    return asyncio.run(
        configs.verify_terminal_server_connection(SimpleNamespace(), form, user=SimpleNamespace(id='u'))
    ), calls


def _terminal_failure(monkeypatch, url, outcomes):
    with pytest.raises(HTTPException) as caught:
        _terminal(monkeypatch, url, outcomes)
    assert caught.value.status_code == 400
    return caught.value.detail


def test_a_terminal_that_answers_its_config_is_a_terminal(monkeypatch):
    result, calls = _terminal(
        monkeypatch,
        'http://127.0.0.1:8000/',
        [SimpleNamespace(ok=False, status=404), SimpleNamespace(ok=True, status=200)],
    )
    assert result == {'status': True, 'type': 'terminal'}
    assert calls == ['http://127.0.0.1:8000/api/v1/policies', 'http://127.0.0.1:8000/api/config']


def test_a_refused_terminal_says_where_and_why(monkeypatch):
    refused = _connector_error(aiohttp.ClientConnectorError, '127.0.0.1', 9)
    detail = _terminal_failure(monkeypatch, 'http://user:pw@127.0.0.1:9/x?key=k', [refused, refused])
    assert detail == 'Connection refused at 127.0.0.1:9. Check that the server is running.'
    assert 'pw' not in detail and 'key=k' not in detail


def test_a_terminal_that_answers_but_not_as_one_says_so(monkeypatch):
    detail = _terminal_failure(
        monkeypatch,
        'https://example.test/t',
        [SimpleNamespace(ok=False, status=404), SimpleNamespace(ok=False, status=401)],
    )
    assert detail == 'example.test:443 answered HTTP 401, but not as a terminal server. Check the URL and the key.'


def test_a_terminal_error_without_a_known_cause_keeps_the_old_words(monkeypatch):
    detail = _terminal_failure(monkeypatch, 'http://127.0.0.1:8000', [ValueError('odd'), ValueError('odd')])
    assert detail == 'Failed to connect to the terminal server'


def _tool(monkeypatch, url, error):
    async def no_headers(*args, **kwargs):
        return {}

    async def fetch(*args, **kwargs):
        raise error

    monkeypatch.setattr(configs, '_tool_server_auth_headers', no_headers)
    monkeypatch.setattr(configs, 'get_tool_server_data', fetch)
    form = configs.ToolServerConnection(
        url=url, path='openapi.json', type='openapi', auth_type='none', key=None, config={}
    )
    with pytest.raises(HTTPException) as caught:
        asyncio.run(configs.verify_tool_servers_config(SimpleNamespace(), form, user=SimpleNamespace(id='u')))
    assert caught.value.status_code == 400
    return caught.value.detail


def test_a_refused_tool_server_says_where_and_why_through_the_chained_cause(monkeypatch):
    refused = _connector_error(aiohttp.ClientConnectorError, '127.0.0.1', 9)
    wrapped = Exception('Cannot connect')
    wrapped.__cause__ = refused
    detail = _tool(monkeypatch, 'http://127.0.0.1:9', wrapped)
    assert detail == 'Connection refused at 127.0.0.1:9. Check that the server is running.'


def test_a_tool_server_timeout_is_said(monkeypatch):
    detail = _tool(monkeypatch, 'http://127.0.0.1:9', TimeoutError())
    assert detail.startswith('Timed out')


def test_a_tool_server_error_without_a_known_cause_keeps_the_old_words(monkeypatch):
    detail = _tool(monkeypatch, 'http://127.0.0.1:9', Exception({'detail': 'nope'}))
    assert detail == 'Failed to connect to the tool server'


def test_the_spec_fetch_keeps_the_network_error_as_its_cause(monkeypatch):
    from local_llm.utils import tools

    refused = _connector_error(aiohttp.ClientConnectorError, '127.0.0.1', 9)
    monkeypatch.setattr(tools.aiohttp, 'ClientSession', _session([refused], []))
    with pytest.raises(Exception) as caught:
        asyncio.run(tools.get_tool_server_data('http://127.0.0.1:9/openapi.json', None))
    assert caught.value.__cause__ is refused
