"""routers/openai.py's verify_connection names the cause of a failed connection test (#1018, S5-D10).

The status code stays what it was (500 when nothing answered, the upstream's own when
it refused); `detail` says why, naming the host and port but never the whole URL, which
can carry a key. The HTTP session and the header builder are fakes: no socket is opened.
"""

import asyncio
import json
from types import SimpleNamespace

import aiohttp
import pytest
from fastapi import HTTPException
from fastapi.responses import JSONResponse

from local_llm.routers import openai


class FakeResponse:
    def __init__(self, status, body):
        self.status = status
        self._body = body

    async def json(self, loads=None):
        if isinstance(self._body, str):
            raise ValueError('not JSON')
        return self._body

    async def text(self):
        return self._body if isinstance(self._body, str) else json.dumps(self._body)


class FakeGet:
    def __init__(self, outcome):
        self.outcome = outcome

    async def __aenter__(self):
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome

    async def __aexit__(self, *exc):
        return False


def _session(outcome, calls):
    class FakeSession:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def get(self, url=None, **kwargs):
            calls.append(url)
            return FakeGet(outcome)

    return FakeSession


def _verify(monkeypatch, url, outcome, config=None):
    calls = []

    async def headers_and_cookies(*args, **kwargs):
        return {}, {}

    monkeypatch.setattr(openai, 'get_headers_and_cookies', headers_and_cookies)
    monkeypatch.setattr(openai.aiohttp, 'ClientSession', _session(outcome, calls))
    form = openai.ConnectionVerificationForm(url=url, key='sk-secret', config=config)
    result = asyncio.run(openai.verify_connection(SimpleNamespace(), form, user=SimpleNamespace(id='u')))
    return result, calls


def _failure(monkeypatch, url, outcome):
    with pytest.raises(HTTPException) as caught:
        _verify(monkeypatch, url, outcome)
    return caught.value


def _connector_error(cls, host, port):
    key = SimpleNamespace(host=host, port=port, ssl=None)
    return cls(key, OSError(111, 'Connect call failed'))


def test_a_listed_server_returns_its_model_list(monkeypatch):
    body = {'data': [{'id': 'a'}, {'id': 'b'}]}
    result, calls = _verify(monkeypatch, 'http://127.0.0.1:4190/v1', FakeResponse(200, body))
    assert result == body
    assert calls == ['http://127.0.0.1:4190/v1/models']


def test_a_refused_connection_names_host_and_port(monkeypatch):
    error = _failure(
        monkeypatch,
        'http://127.0.0.1:9/v1',
        _connector_error(aiohttp.ClientConnectorError, '127.0.0.1', 9),
    )
    assert error.status_code == 500
    assert error.detail == 'Connection refused at 127.0.0.1:9. Check that the server is running.'


def test_an_unknown_host_says_so(monkeypatch):
    error = _failure(
        monkeypatch,
        'https://nowhere.invalid/v1',
        _connector_error(aiohttp.ClientConnectorDNSError, 'nowhere.invalid', 443),
    )
    assert error.status_code == 500
    assert error.detail == "Couldn't find the host nowhere.invalid. Check the address."


def test_text_that_is_not_a_url_asks_for_one(monkeypatch):
    error = _failure(monkeypatch, 'not a url', aiohttp.InvalidUrlClientError('not%20a%20url/models'))
    assert error.status_code == 500
    assert error.detail == 'This is not a web address. Enter one that starts with http:// or https://.'


def test_a_timeout_gives_the_limit(monkeypatch):
    monkeypatch.setattr(openai, 'AIOHTTP_CLIENT_TIMEOUT_MODEL_LIST', 5)
    error = _failure(monkeypatch, 'https://slow.example:8443/v1', TimeoutError())
    assert error.status_code == 500
    assert error.detail == 'Timed out after 5 s waiting for slow.example:8443.'


def test_another_client_error_never_shows_the_whole_url(monkeypatch):
    error = _failure(monkeypatch, 'https://user:sk-secret@host.example/v1', aiohttp.ServerDisconnectedError('gone'))
    assert error.status_code == 500
    assert error.detail == 'Lost the connection to host.example:443 before it answered.'
    assert 'sk-secret' not in error.detail


def test_an_unexpected_error_still_names_the_target(monkeypatch):
    error = _failure(monkeypatch, 'http://10.0.0.2:8090/v1', RuntimeError('boom'))
    assert error.status_code == 500
    assert error.detail == "Couldn't test the connection to 10.0.0.2:8090."


@pytest.mark.parametrize(
    ('status', 'detail'),
    [
        (401, 'HTTP 401 from /models: check the API key'),
        (403, 'HTTP 403 from /models: check the API key and what it is allowed to do'),
        (404, 'HTTP 404 from /models: check the URL; an OpenAI-compatible base URL usually ends in /v1'),
        (502, 'HTTP 502 from /models'),
    ],
)
def test_an_upstream_refusal_keeps_its_status_and_says_why(monkeypatch, status, detail):
    result, _ = _verify(monkeypatch, 'https://openrouter.ai/api/v1', FakeResponse(status, {'error': 'raw'}))
    assert isinstance(result, JSONResponse)
    assert result.status_code == status
    assert json.loads(result.body) == {'detail': detail}


def test_a_refusal_that_is_not_json_says_why_too(monkeypatch):
    result, _ = _verify(monkeypatch, 'http://127.0.0.1:8090/v1', FakeResponse(500, '<html>oops</html>'))
    assert result.status_code == 500
    assert json.loads(result.body) == {'detail': 'HTTP 500 from /models'}


def test_an_answer_that_is_not_json_is_returned_as_text(monkeypatch):
    # The status code stays 200; the dialog says it got no model list.
    result, _ = _verify(monkeypatch, 'http://127.0.0.1:8090/v1', FakeResponse(200, '<html>hello</html>'))
    assert result == '<html>hello</html>'


def test_azure_names_its_own_path(monkeypatch):
    result, calls = _verify(
        monkeypatch,
        'https://acct.openai.azure.com',
        FakeResponse(401, {}),
        config={'provider': 'azure', 'api_version': '2024-02-01'},
    )
    assert calls == ['https://acct.openai.azure.com/openai/models?api-version=2024-02-01']
    assert json.loads(result.body) == {'detail': 'HTTP 401 from /openai/models: check the API key'}
