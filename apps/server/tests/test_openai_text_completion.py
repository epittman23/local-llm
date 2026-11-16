"""POST /openai/completions: a text completion the model continues (#1108, S6-D6).

The Playground's Completions tab sent its text as one assistant chat message,
so the model answered it instead of continuing it. It now calls this route,
which forwards to the connection's OpenAI-compatible `/completions`
(llama-server has one). These pin what it sends upstream: the prompt, the
request's own parameters (under `params`, as from the chat page, #208), a
workspace model's base model and parameters but never its system prompt,
the access check a chat completion makes, and the refusals: the API off, no
prompt, and a connection with no `/completions` to call.

The config, model discovery, connection lookup and HTTP session are fakes
that record their calls; the payload helpers in between run for real.

Run from apps/server:

    python -m pytest tests/test_openai_text_completion.py
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.routing import Match

from local_llm.routers import openai as openai_router

ADMIN = SimpleNamespace(id='a1', name='Ada', email='ada@example.invalid', role='admin', variables={})


class _Response:
    def __init__(self, status=200, headers=None, body=None):
        self.status = status
        self.headers = headers or {}
        self._body = body

    async def json(self, loads=json.loads):
        return self._body

    async def text(self):
        return json.dumps(self._body)


class _Session:
    def __init__(self, response: _Response, log: dict):
        self._response = response
        self._log = log

    async def request(self, **kwargs):
        self._log['request'] = {'url': kwargs['url'], 'body': json.loads(kwargs['data'])}
        return self._response


@pytest.fixture
def call(monkeypatch):
    """Runs generate_completion against fakes; returns (outcome, log)."""

    def run(
        form_data: dict,
        *,
        enabled=True,
        api_config=None,
        model_info=None,
        response=None,
        user=ADMIN,
    ):
        log = {'access_checks': [], 'request': None, 'failures': []}

        async def config_get(key, default=None):
            assert key == 'openai.enable', key
            return enabled

        async def get_model_by_id(model_id):
            return model_info if model_info and model_info.id == model_id else None

        async def check_model_access(u, info, bypass_filter=False):
            log['access_checks'].append(getattr(info, 'id', None))
            if u.role != 'admin' and info is None:
                raise HTTPException(status_code=403, detail='Model not found')

        async def get_all_models(request, user=None):
            request.app.state.OPENAI_MODELS = {'base': {'id': 'base', 'urlIdx': 0}, 'm1': {'id': 'm1', 'urlIdx': 0}}

        async def connection(idx):
            return 'http://upstream.invalid/v1', 'k', dict(api_config or {})

        async def headers_and_cookies(*a, **k):
            return {'Content-Type': 'application/json'}, {}

        async def get_session():
            return _Session(response or _Response(), log)

        async def publish_failure(request, **kwargs):
            log['failures'].append(kwargs['status'])

        async def nothing(*a, **k):
            return None

        async def stream_wrapper(r):
            yield b''

        monkeypatch.setattr(openai_router.Config, 'get', config_get)
        monkeypatch.setattr(openai_router.Models, 'get_model_by_id', get_model_by_id)
        monkeypatch.setattr(openai_router, 'check_model_access', check_model_access)
        monkeypatch.setattr(openai_router, 'get_all_models', get_all_models)
        monkeypatch.setattr(openai_router, 'get_openai_connection', connection)
        monkeypatch.setattr(openai_router, 'get_headers_and_cookies', headers_and_cookies)
        monkeypatch.setattr(openai_router, 'get_session', get_session)
        monkeypatch.setattr(openai_router, 'publish_model_provider_request_failed', publish_failure)
        monkeypatch.setattr(openai_router, 'cleanup_response', nothing)
        monkeypatch.setattr(openai_router, 'stream_wrapper', stream_wrapper)
        monkeypatch.setattr(openai_router, 'BYPASS_MODEL_ACCESS_CONTROL', False)

        request = SimpleNamespace(state=SimpleNamespace(), app=SimpleNamespace(state=SimpleNamespace(OPENAI_MODELS={})))
        try:
            outcome = asyncio.run(openai_router.generate_completion(request, form_data, user=user))
        except HTTPException as e:
            outcome = e
        return outcome, log

    return run


def test_the_route_is_matched_before_the_passthrough_catch_all():
    # Declared after the catch-all, /completions would answer "Direct API passthrough is disabled".
    scope = {'type': 'http', 'method': 'POST', 'path': '/completions', 'root_path': ''}
    first = next(r for r in openai_router.router.routes if r.matches(scope)[0] == Match.FULL)
    assert first.endpoint is openai_router.generate_completion


def test_forwards_the_prompt_to_the_connections_completions_and_streams_the_answer(call):
    sse = _Response(headers={'Content-Type': 'text/event-stream'})
    outcome, log = call(
        {'model': 'm1', 'prompt': 'The central limit theorem states that', 'stream': True}, response=sse
    )
    assert isinstance(outcome, StreamingResponse)
    assert log['request'] == {
        'url': 'http://upstream.invalid/v1/completions',
        'body': {'model': 'm1', 'prompt': 'The central limit theorem states that', 'stream': True},
    }
    # The access check a chat completion makes.
    assert log['access_checks'] == [None]


def test_the_requests_params_apply_like_the_chat_pages_and_never_reach_the_provider_as_params(call):
    _, log = call(
        {
            'model': 'm1',
            'prompt': 'x',
            'params': {'temperature': 0.5, 'max_tokens': '64', 'custom_params': {'top_k': '40'}},
        }
    )
    assert log['request']['body'] == {'model': 'm1', 'prompt': 'x', 'temperature': 0.5, 'max_tokens': 64, 'top_k': 40}


def test_a_workspace_model_brings_its_base_model_and_params_but_not_its_system_prompt(call):
    info = SimpleNamespace(
        id='m1',
        base_model_id='base',
        user_id='a1',
        params=SimpleNamespace(model_dump=lambda: {'system': 'You are terse.', 'temperature': 0.1}),
    )
    _, log = call({'model': 'm1', 'prompt': 'x'}, model_info=info)
    assert log['request']['body'] == {'model': 'base', 'prompt': 'x', 'temperature': 0.1}
    assert log['access_checks'] == ['m1']


def test_a_user_without_access_to_the_model_is_refused_before_anything_is_sent(call):
    user = SimpleNamespace(id='u2', name='Bo', email='bo@example.invalid', role='user', variables={})
    outcome, log = call({'model': 'm1', 'prompt': 'x'}, user=user)
    assert isinstance(outcome, HTTPException) and outcome.status_code == 403
    assert log['request'] is None


@pytest.mark.parametrize(
    ('form_data', 'kwargs', 'status'),
    [
        ({'model': 'm1', 'prompt': 'x'}, {'enabled': False}, 503),
        ({'model': 'm1'}, {}, 400),
        ({'model': 'm1', 'messages': [{'role': 'user', 'content': 'x'}]}, {}, 400),
        ({'model': 'm1', 'prompt': 'x'}, {'api_config': {'api_type': 'responses'}}, 400),
        ({'model': 'm1', 'prompt': 'x'}, {'api_config': {'azure': True}}, 400),
        ({'model': 'nope', 'prompt': 'x'}, {}, 404),
    ],
    ids=['api-off', 'no-prompt', 'chat-messages', 'responses-connection', 'azure-connection', 'unknown-model'],
)
def test_refusals(call, form_data, kwargs, status):
    outcome, log = call(form_data, **kwargs)
    assert isinstance(outcome, HTTPException) and outcome.status_code == status
    assert log['request'] is None


def test_an_upstream_error_comes_back_with_its_status_and_is_reported(call):
    error = _Response(status=404, headers={'Content-Type': 'application/json'}, body={'error': 'not found'})
    outcome, log = call({'model': 'm1', 'prompt': 'x', 'stream': True}, response=error)
    assert isinstance(outcome, JSONResponse) and outcome.status_code == 404
    assert json.loads(outcome.body) == {'error': 'not found'}
    assert log['failures'] == [404]
