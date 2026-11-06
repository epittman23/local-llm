"""A client that leaves before the upstream answers stops the upstream request (#614).

`generate_chat_completion` (routers/openai.py) waited for the upstream's
response headers with nothing watching the client, so a Cancel during a long
prompt-processing phase still cost the whole of it on a local model. It now
cancels the upstream request when a client waiting on it disconnects first,
which closes the connection to the upstream. Only a call a client waits on is
watched: the route itself, or the legacy chat path that answers in its
request. A chat's reply running as a background task, whose request was
answered long ago and so reads as disconnected, is not.

The upstream here is a real socket that reads the request and never answers,
and the client a real Starlette Request whose receive channel reports the
disconnect.

Run from apps/server:

    python -m pytest tests/test_chat_client_disconnect.py
"""

from __future__ import annotations

import asyncio
import copy
from types import SimpleNamespace

import aiohttp
import pytest
from fastapi import HTTPException
from starlette.requests import Request

from local_llm import main
from local_llm.routers import openai as openai_router
from local_llm.utils import client_disconnect
from tests import test_chat_completion as chat_harness

USER = SimpleNamespace(id='u1', name='Ada', email='ada@example.invalid', role='user', variables={})
ANSWER = b'{"id":"c1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"hi"}}]}'


class Upstream:
    """A server that reads each request and then answers after `answer_after` seconds, or never."""

    def __init__(self, answer_after: float | None = None):
        self.answer_after = answer_after
        self.connected = asyncio.Event()
        self.closed = asyncio.Event()
        self.server: asyncio.Server | None = None

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.connected.set()
        if self.answer_after is not None:
            await asyncio.sleep(self.answer_after)
            writer.write(
                b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: '
                + str(len(ANSWER)).encode()
                + b'\r\n\r\n'
                + ANSWER
            )
            await writer.drain()
        # Read until the client closes the connection.
        while await reader.read(65536):
            pass
        self.closed.set()
        writer.close()

    async def __aenter__(self):
        self.server = await asyncio.start_server(self.handle, '127.0.0.1', 0)
        return self

    async def __aexit__(self, *exc):
        assert self.server is not None
        self.server.close()

    @property
    def url(self) -> str:
        assert self.server is not None
        return f'http://127.0.0.1:{self.server.sockets[0].getsockname()[1]}/v1'


def _request(endpoint, gone: asyncio.Event) -> Request:
    """A Starlette request whose client is gone once `gone` is set."""

    async def receive():
        if gone.is_set():
            return {'type': 'http.disconnect'}
        await asyncio.Event().wait()
        return {}

    scope = {
        'type': 'http',
        'method': 'POST',
        'path': '/openai/chat/completions',
        'headers': [],
        'query_string': b'',
        'endpoint': endpoint,
        'app': SimpleNamespace(state=SimpleNamespace(OPENAI_MODELS={})),
    }
    return Request(scope, receive)


@pytest.fixture
def route(monkeypatch):
    """generate_chat_completion against `upstream`, with everything before the request stubbed."""
    monkeypatch.setattr(client_disconnect, 'POLL_SECONDS', 0.02)

    async def config_get(key, default=None):
        return True

    async def apply_model_info(request, payload, metadata, user, bypass_filter):
        return payload, payload['model']

    async def find_model(request, model_id, user):
        return {'id': model_id, 'urlIdx': 0}

    async def headers_and_cookies(*a, **k):
        return {'Content-Type': 'application/json'}, {}

    async def nothing(*a, **k):
        return None

    monkeypatch.setattr(openai_router.Config, 'get', config_get)
    monkeypatch.setattr(openai_router, '_apply_model_info', apply_model_info)
    monkeypatch.setattr(openai_router, '_find_openai_model', find_model)
    monkeypatch.setattr(openai_router, '_adapt_payload_for_provider', lambda payload, model, url, user: payload)
    monkeypatch.setattr(openai_router, 'get_headers_and_cookies', headers_and_cookies)
    monkeypatch.setattr(openai_router, 'publish_model_provider_request_failed', nothing)

    async def run(upstream: Upstream, request: Request, gone: asyncio.Event, leave: bool, waits: str = 'no'):
        """`waits`: 'no'; 'yes', the calling task enters client_waits(); 'spawned', a task it starts makes the call."""
        session = aiohttp.ClientSession()

        async def get_session():
            return session

        async def connection(idx):
            return upstream.url, 'k', {}

        monkeypatch.setattr(openai_router, 'get_session', get_session)
        monkeypatch.setattr(openai_router, 'get_openai_connection', connection)

        def generate():
            return openai_router.generate_chat_completion(
                request, {'model': 'm1', 'messages': [{'role': 'user', 'content': 'long prompt'}]}, user=USER
            )

        async def caller():
            if waits == 'no':
                return await generate()
            with client_disconnect.client_waits():
                if waits == 'spawned':
                    # Started inside, as a memory review or an event handler is, and so
                    # free to outlive the request.
                    return await asyncio.create_task(generate())
                return await generate()

        call = asyncio.ensure_future(caller())
        try:
            await asyncio.wait_for(upstream.connected.wait(), 5)
            if leave:
                gone.set()
            return await asyncio.wait_for(call, 5)
        finally:
            await session.close()

    return run


def test_a_client_that_leaves_before_the_headers_cancels_the_upstream_request(route):
    async def scenario():
        async with Upstream(answer_after=None) as upstream:
            gone = asyncio.Event()
            with pytest.raises(HTTPException) as raised:
                await route(upstream, _request(openai_router.generate_chat_completion, gone), gone, leave=True)
            # The upstream sees its connection closed, not a client still waiting.
            await asyncio.wait_for(upstream.closed.wait(), 5)
            return raised.value

    error = asyncio.run(scenario())
    assert error.status_code == 499


def test_a_client_that_stays_gets_the_answer(route):
    async def scenario():
        async with Upstream(answer_after=0.2) as upstream:
            gone = asyncio.Event()
            return await route(upstream, _request(openai_router.generate_chat_completion, gone), gone, leave=False)

    result = asyncio.run(scenario())
    assert result['choices'][0]['message']['content'] == 'hi'


def test_an_internal_call_is_not_cancelled_by_a_request_that_was_answered_long_ago(route):
    # A chat's reply runs as a background task on a request that already had its
    # answer, and so reads as disconnected; it must still get the model's answer.
    async def scenario():
        async with Upstream(answer_after=0.2) as upstream:
            gone = asyncio.Event()
            gone.set()
            return await route(upstream, _request(main.chat_completion, gone), gone, leave=True)

    result = asyncio.run(scenario())
    assert result['choices'][0]['message']['content'] == 'hi'


def test_inside_client_waits_an_internal_call_is_watched_too(route):
    async def scenario():
        async with Upstream(answer_after=None) as upstream:
            gone = asyncio.Event()
            with pytest.raises(HTTPException) as raised:
                await route(upstream, _request(main.chat_completion, gone), gone, leave=True, waits='yes')
            return raised.value

    assert asyncio.run(scenario()).status_code == 499


def test_a_task_started_inside_client_waits_is_not_watched(route):
    # It may run after the request was answered, which then reads as disconnected.
    async def scenario():
        async with Upstream(answer_after=0.2) as upstream:
            gone = asyncio.Event()
            gone.set()
            return await route(upstream, _request(main.chat_completion, gone), gone, leave=True, waits='spawned')

    result = asyncio.run(scenario())
    assert result['choices'][0]['message']['content'] == 'hi'


def test_a_request_without_a_scope_is_never_watched():
    assert client_disconnect.watched_request(SimpleNamespace(state=SimpleNamespace()), object) is None


@pytest.mark.parametrize(
    ('form', 'world', 'waits'),
    [
        # No chat: answered in the request, which its client waits on.
        ({'model': 'm1', 'messages': [{'role': 'user', 'content': 'q'}]}, {}, [True]),
        # A chat: each model's reply is a background task, after the request was answered.
        ({'model': 'm1', 'chat_id': chat_harness.SAVED_CHAT, 'session_id': 's', 'id': 'x'}, {}, [False]),
        # A saved chat without a session takes the in-request path, but its reply is
        # saved and kept whether or not the client stays.
        ({'model': 'm1', 'chat_id': chat_harness.SAVED_CHAT, 'id': 'x'}, {}, [False]),
    ],
    ids=['legacy', 'chat', 'chat-without-session'],
)
def test_only_the_legacy_chat_path_marks_its_client_as_waiting(monkeypatch, form, world, waits):
    seen = []

    async def process_chat(request, form_data, user, metadata, model, tasks=None):
        seen.append(client_disconnect._client_waits.get() is asyncio.current_task())
        return {'status': True}

    w = chat_harness._World(world, [])
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(MODELS=copy.deepcopy(chat_harness.MODELS), redis='<redis>')),
        state=SimpleNamespace(),
        headers={'user-agent': 'pytest-agent'},
    )
    for install in (
        chat_harness._install_models,
        chat_harness._install_chats,
        chat_harness._install_access,
        chat_harness._install_pipeline,
        chat_harness._install_tasks,
        chat_harness._install_config,
    ):
        install(monkeypatch, w, request) if install is chat_harness._install_models else install(monkeypatch, w)
    monkeypatch.setattr(main, '_process_chat', process_chat)

    async def scenario():
        await main.chat_completion(request, copy.deepcopy(form), user=SimpleNamespace(id='u1', role='user'))
        while w.background:
            _, _, coroutine = w.background.pop(0)
            await coroutine

    asyncio.run(scenario())
    assert seen == waits
    assert client_disconnect._client_waits.get() is None


# --- The race itself, case by case ----------------------------------------------------


class _Client:
    def __init__(self, gone=False, fails=False):
        self.gone, self.fails = gone, fails

    async def is_disconnected(self):
        if self.fails:
            raise RuntimeError('receive is closed')
        return self.gone


def test_without_a_request_to_watch_it_is_a_plain_await():
    async def answer():
        return 'answer'

    assert asyncio.run(client_disconnect.unless_client_leaves(None, answer())) == 'answer'


def test_a_client_that_cannot_be_read_leaves_the_request_running(monkeypatch):
    monkeypatch.setattr(client_disconnect, 'POLL_SECONDS', 0.01)

    async def answer():
        await asyncio.sleep(0.05)
        return 'answer'

    assert asyncio.run(client_disconnect.unless_client_leaves(_Client(fails=True), answer())) == 'answer'


def test_an_answer_that_comes_as_the_client_leaves_is_closed(monkeypatch):
    monkeypatch.setattr(client_disconnect, 'POLL_SECONDS', 0.01)
    closed = []
    response = SimpleNamespace(close=lambda: closed.append(True))

    async def finishes_on_cancel():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            return response
        return None

    with pytest.raises(client_disconnect.ClientDisconnected):
        asyncio.run(client_disconnect.unless_client_leaves(_Client(gone=True), finishes_on_cancel()))
    assert closed == [True]


def test_cancelling_the_wait_cancels_the_request_too(monkeypatch):
    monkeypatch.setattr(client_disconnect, 'POLL_SECONDS', 0.01)
    cancelled = []

    async def never():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.append(True)
            raise

    async def scenario():
        waiting = asyncio.ensure_future(client_disconnect.unless_client_leaves(_Client(), never()))
        await asyncio.sleep(0.05)
        waiting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiting
        await asyncio.sleep(0)

    asyncio.run(scenario())
    assert cancelled == [True]


def test_a_client_that_left_is_logged_as_such_and_not_turned_into_a_400(monkeypatch, caplog):
    async def payload(request, form_data, user, metadata, model):
        raise HTTPException(status_code=499, detail='The client disconnected before the model answered')

    async def nothing(*a, **k):
        return None

    monkeypatch.setattr(main, 'process_chat_payload', payload)
    for name in ('_disconnect_mcp_clients', '_end_chat_task', '_run_pending_internal_messages'):
        monkeypatch.setattr(main, name, nothing)

    with caplog.at_level('INFO', logger=main.log.name), pytest.raises(HTTPException) as raised:
        asyncio.run(main._process_chat(SimpleNamespace(), {}, USER, {}, {'id': 'm1'}))

    assert raised.value.status_code == 499
    assert not [r for r in caplog.records if r.levelname == 'ERROR']
