"""Characterization tests for routers/openai.py's chat completion path.

convert_to_responses_payload and generate_chat_completion were refactored
for ruff's complexity limit with no tests of their own, so these pin what
they did before the refactor. Each case's observable result was recorded
from the untouched functions into fixtures/openai_router.json and must not
change:

- convert_to_responses_payload: the returned payload, and the input after
  the call (it pops `messages` from the dict it is given).
- generate_chat_completion: the exact request sent upstream (URL, body
  string, headers, stream timeout flag), the access checks made, the
  failure events published, whether the response was cleaned up, what was
  returned or raised, and form_data after the call (the handler copies it
  only one level deep, so some changes reach the caller's messages).

The database, config, model discovery, connection lookup and HTTP session
are replaced by fakes that record their calls; the payload helpers in
between run for real.

The golden file is only ever written by hand, never by this test. To record
it again (only for an intended behaviour change, reviewed as such), run
`OPENAI_GOLDEN_RECORD=1 pytest tests/test_openai_router_conversion.py`.
"""

import asyncio
import copy
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse

from local_llm.routers import openai as openai_router

GOLDEN = Path(__file__).parent / 'fixtures' / 'openai_router.json'
RECORD = os.environ.get('OPENAI_GOLDEN_RECORD') == '1'

IMG = {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,AAAA'}}

# ---------------------------------------------------------------------------
# convert_to_responses_payload
# ---------------------------------------------------------------------------

RESPONSES_CASES = [
    ('empty', {}),
    ('no_messages_key', {'model': 'm', 'temperature': 0.3}),
    ('user_string', {'model': 'm', 'messages': [{'role': 'user', 'content': 'hi'}]}),
    ('role_defaults_to_user', {'messages': [{'content': 'hi'}]}),
    ('missing_content', {'messages': [{'role': 'user'}]}),
    ('non_string_content', {'messages': [{'role': 'user', 'content': 12}, {'role': 'user', 'content': None}]}),
    (
        'system_string_and_list',
        {
            'messages': [
                {'role': 'system', 'content': 'first'},
                {'role': 'system', 'content': [{'type': 'text', 'text': 'a'}, {'type': 'image'}, {'text': 'no type'}]},
                {'role': 'user', 'content': 'q'},
            ]
        },
    ),
    ('system_other_type_ignored', {'messages': [{'role': 'system', 'content': 5}]}),
    ('system_empty_string', {'messages': [{'role': 'system', 'content': ''}]}),
    (
        'stored_output_items',
        {
            'messages': [
                {
                    'role': 'assistant',
                    'content': 'ignored',
                    'output': [
                        {'type': 'message', 'role': 'assistant', 'content': [], 'id': 'x', 'status': 'done'},
                        {'type': 'function_call', 'call_id': 'c', 'name': 'f', 'arguments': '{}', 'id': 'i', 'x': 1},
                        {'type': 'function_call_output', 'call_id': 'c', 'output': 'o', 'duration': 2},
                        {'type': 'reasoning', 'summary': [], 'extra': True},
                        {'no_type': True},
                    ],
                },
                {'role': 'user', 'content': 'next', 'output': []},
                {'role': 'user', 'content': 'next2', 'output': 'not a list'},
            ]
        },
    ),
    (
        'assistant_tool_calls',
        {
            'messages': [
                {
                    'role': 'assistant',
                    'content': 'calling',
                    'tool_calls': [
                        {'id': 't1', 'function': {'name': 'f', 'arguments': '{"a": 1}'}},
                        {'function': {}},
                        {},
                    ],
                },
                {
                    'role': 'assistant',
                    'content': [
                        {'type': 'text', 'text': 'part'},
                        {'type': 'image_url'},
                        {'type': 'text', 'text': 'two'},
                    ],
                    'tool_calls': [{'id': 't2', 'function': {'name': 'g'}}],
                },
                {'role': 'assistant', 'content': '   ', 'tool_calls': [{'id': 't3'}]},
                {'role': 'assistant', 'content': [{'type': 'image_url'}], 'tool_calls': [{'id': 't4'}]},
                {'role': 'assistant', 'content': '', 'tool_calls': [{'id': 't5'}]},
                {'role': 'assistant', 'tool_calls': [{'id': 't6'}]},
                {'role': 'assistant', 'content': 'no calls', 'tool_calls': []},
            ]
        },
    ),
    (
        'tool_results',
        {
            'messages': [
                {'role': 'tool', 'tool_call_id': 't1', 'content': 'result'},
                {'role': 'tool', 'content': [{'type': 'text', 'text': 'x'}]},
                {'role': 'tool'},
            ]
        },
    ),
    (
        'content_parts',
        {
            'messages': [
                {
                    'role': 'user',
                    'content': [
                        {'type': 'text', 'text': 'look'},
                        {'type': 'text'},
                        {'type': 'image_url', 'image_url': {'url': 'u1', 'detail': 'high'}},
                        {'type': 'image_url', 'image_url': {'url': 'u2', 'detail': None}},
                        {'type': 'image_url', 'image_url': {}},
                        {'type': 'image_url', 'image_url': 'plain-url'},
                        {'type': 'image_url', 'image_url': 7},
                        {'type': 'image_url'},
                        {'type': 'file', 'file': {'file_id': 'f1', 'filename': 'a.pdf', 'other': 1}},
                        {'type': 'file', 'file': {'file_data': 'data:...', 'filename': 'b.pdf'}},
                        {'type': 'file', 'file': {'filename': 'only-name.pdf'}},
                        {'type': 'file', 'file': 'not a dict'},
                        {'type': 'file'},
                        {'type': 'audio'},
                    ],
                },
                {'role': 'assistant', 'content': [{'type': 'text', 'text': 'reply'}]},
                {'role': 'assistant', 'content': 'plain reply'},
                {'role': 'developer', 'content': 'dev'},
            ]
        },
    ),
    ('previous_response_id_kept', {'messages': [], 'previous_response_id': 'resp_1'}),
    ('previous_response_id_empty_dropped', {'messages': [], 'previous_response_id': ''}),
    ('previous_response_id_none_dropped', {'messages': [], 'previous_response_id': None}),
    ('max_tokens', {'messages': [], 'max_tokens': 10}),
    ('max_completion_tokens', {'messages': [], 'max_completion_tokens': 20}),
    ('both_max_tokens', {'messages': [], 'max_tokens': 10, 'max_completion_tokens': 20}),
    (
        'unsupported_params_removed',
        {
            'messages': [],
            'stream_options': {'include_usage': True},
            'logit_bias': {'1': 2},
            'frequency_penalty': 0.1,
            'presence_penalty': 0.2,
            'stop': ['x'],
            'stream': True,
            'top_p': 0.5,
        },
    ),
    (
        'tools',
        {
            'messages': [],
            'tools': [
                {
                    'type': 'function',
                    'function': {
                        'name': 'f',
                        'description': 'd',
                        'parameters': {'type': 'object'},
                        'strict': True,
                        'extra': 1,
                    },
                },
                {'function': {'name': 'g'}},
                {'type': 'custom', 'function': 'not a dict'},
                {'type': 'function', 'function': {}},
                {'type': 'function', 'name': 'already', 'parameters': {}},
                'not a dict',
            ],
        },
    ),
    ('tools_not_a_list', {'messages': [], 'tools': {'name': 'x'}}),
]

# ---------------------------------------------------------------------------
# generate_chat_completion
# ---------------------------------------------------------------------------

OPENROUTER = 'https://openrouter.ai/api/v1'
OPENAI = 'https://api.openai.com/v1'
AZURE = 'https://res.openai.azure.com'
AZURE_V1 = 'https://res.openai.azure.com/openai/v1'

SSE = {'Content-Type': 'text/event-stream', 'X-Request-Id': 'r1', 'Content-Length': '9'}
JSON_HEADERS = {'Content-Type': 'application/json'}
OK = {'status': 200, 'headers': JSON_HEADERS, 'json': {'id': 'c1', 'choices': [{'message': {'content': 'hi'}}]}}

USER_MSG = [{'role': 'user', 'content': 'hi'}]


def _case(
    case_id,
    form_data,
    *,
    enabled=True,
    model_info=None,
    request_base_model_id=None,
    state=None,
    bypass_env=False,
    cached=None,
    discovered=None,
    url=OPENROUTER,
    api_config=None,
    response=OK,
):
    """One generate_chat_completion case, as plain JSON-native data."""
    return (
        case_id,
        {
            'form_data': form_data,
            'enabled': enabled,
            'model_info': model_info,
            'request_base_model_id': request_base_model_id,
            'state': state or {},
            'bypass_env': bypass_env,
            'cached': cached if cached is not None else {'m': {'urlIdx': 0}},
            'discovered': discovered,
            'url': url,
            'api_config': api_config or {},
            'response': response,
        },
    )


CHAT_CASES = [
    _case('disabled', {'model': 'm', 'messages': USER_MSG}, enabled=False),
    _case('basic', {'model': 'm', 'messages': USER_MSG, 'temperature': 0.2}),
    _case('metadata_is_not_sent', {'model': 'm', 'messages': USER_MSG, 'metadata': {'chat_id': 'c'}}),
    _case(
        'model_discovered_when_not_cached',
        {'model': 'm2', 'messages': USER_MSG},
        cached={},
        discovered={'m2': {'urlIdx': 1}},
    ),
    _case('model_not_found', {'model': 'missing', 'messages': USER_MSG}, cached={}, discovered={}),
    _case(
        'model_info_with_base_model_params_and_system',
        {'model': 'custom', 'messages': USER_MSG, 'metadata': {'variables': {'{{NAME}}': 'Ada'}}},
        model_info={
            'id': 'custom',
            'base_model_id': 'm',
            'params': {'system': 'Be brief, {{NAME}}.', 'temperature': 0.7, 'max_tokens': 50},
        },
    ),
    _case(
        'request_base_model_id_and_bypass_system_prompt',
        {'model': 'custom', 'messages': USER_MSG},
        model_info={'id': 'custom', 'base_model_id': 'm-base', 'params': {'system': 'never applied'}},
        request_base_model_id='m',
        state={'bypass_system_prompt': True},
    ),
    _case(
        'model_info_without_base_model_or_params',
        {'model': 'm', 'messages': USER_MSG},
        model_info={'id': 'm', 'base_model_id': None, 'params': {}},
    ),
    _case('bypass_filter_from_state', {'model': 'm', 'messages': USER_MSG}, state={'bypass_filter': True}),
    _case('bypass_filter_from_env', {'model': 'm', 'messages': USER_MSG}, bypass_env=True),
    _case(
        'pipeline_model_gets_user',
        {'model': 'm', 'messages': USER_MSG},
        cached={'m': {'urlIdx': 0, 'pipeline': {'type': 'pipe'}}},
    ),
    _case(
        'prefix_is_stripped',
        {'model': 'or.m', 'messages': USER_MSG},
        cached={'or.m': {'urlIdx': 0}},
        api_config={'prefix_id': 'or'},
    ),
    _case(
        'reasoning_model',
        {'model': 'o3', 'messages': [{'role': 'system', 'content': 's'}, *USER_MSG], 'max_tokens': 9},
        cached={'o3': {'urlIdx': 0}},
        url=OPENAI,
    ),
    _case(
        'legacy_reasoning_model',
        {'model': 'o1-mini', 'messages': [{'role': 'system', 'content': 's'}, *USER_MSG]},
        cached={'o1-mini': {'urlIdx': 0}},
    ),
    _case('non_openai_url_uses_max_tokens', {'model': 'm', 'messages': USER_MSG, 'max_completion_tokens': 30}),
    _case(
        'openai_url_keeps_max_completion_tokens',
        {'model': 'm', 'messages': USER_MSG, 'max_tokens': 10, 'max_completion_tokens': 30},
        url=OPENAI,
    ),
    _case(
        'non_openai_url_with_both_max_tokens',
        {'model': 'm', 'messages': USER_MSG, 'max_tokens': 10, 'max_completion_tokens': 30},
    ),
    _case('logit_bias_converted', {'model': 'm', 'messages': USER_MSG, 'logit_bias': '50256:-100, 11:5'}),
    _case('logit_bias_empty', {'model': 'm', 'messages': USER_MSG, 'logit_bias': ''}),
    _case('logit_bias_dict', {'model': 'm', 'messages': USER_MSG, 'logit_bias': {'50256': -100}}),
    _case('logit_bias_clamped', {'model': 'm', 'messages': USER_MSG, 'logit_bias': '1:500, 2:-500'}),
    _case('logit_bias_bad_number', {'model': 'm', 'messages': USER_MSG, 'logit_bias': '1:high'}),
    _case('logit_bias_wrong_type', {'model': 'm', 'messages': USER_MSG, 'logit_bias': [1, 2]}),
    _case('logit_bias_invalid', {'model': 'm', 'messages': USER_MSG, 'logit_bias': 'nonsense'}),
    _case(
        'azure_deployment_chat',
        {'model': 'gpt-4o', 'messages': USER_MSG, 'temperature': 0.5, 'unsupported': 1},
        cached={'gpt-4o': {'urlIdx': 0}},
        url=AZURE,
        api_config={'azure': True, 'api_version': '2024-10-21'},
    ),
    _case(
        'azure_deployment_default_version_entra_id',
        {'model': 'gpt-4o', 'messages': USER_MSG},
        cached={'gpt-4o': {'urlIdx': 0}},
        url=AZURE,
        api_config={'provider': 'azure', 'auth_type': 'microsoft_entra_id'},
    ),
    _case(
        'azure_deployment_responses',
        {'model': 'o4-mini', 'messages': USER_MSG, 'max_tokens': 5, 'temperature': 0.5},
        cached={'o4-mini': {'urlIdx': 0}},
        url=AZURE,
        api_config={
            'azure': True,
            'api_type': 'responses',
            'api_version': '2025-04-01-preview',
            'auth_type': 'azure_ad',
        },
    ),
    _case(
        'azure_bad_deployment_name',
        {'model': '../x', 'messages': USER_MSG},
        cached={'../x': {'urlIdx': 0}},
        url=AZURE,
        api_config={'azure': True},
    ),
    _case(
        'azure_v1_chat',
        {'model': 'gpt-4o', 'messages': USER_MSG},
        cached={'gpt-4o': {'urlIdx': 0}},
        url=AZURE_V1 + '/',
        api_config={'azure': True},
    ),
    _case(
        'azure_v1_responses',
        {'model': 'gpt-4o', 'messages': USER_MSG},
        cached={'gpt-4o': {'urlIdx': 0}},
        url=AZURE_V1,
        api_config={'provider': 'azure', 'api_type': 'responses'},
    ),
    _case(
        'responses_api',
        {'model': 'm', 'messages': [{'role': 'system', 'content': 's'}, *USER_MSG], 'max_tokens': 7},
        api_config={'api_type': 'responses'},
        response={
            'status': 200,
            'headers': JSON_HEADERS,
            'json': {
                'id': 'resp_1',
                'model': 'm',
                'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': 'answer'}]}],
                'usage': {'input_tokens': 3},
            },
        },
    ),
    _case(
        'responses_api_non_dict_result',
        {'model': 'm', 'messages': USER_MSG},
        api_config={'api_type': 'responses'},
        response={'status': 200, 'headers': JSON_HEADERS, 'json': ['a', 'list']},
    ),
    _case(
        'tool_message_images_stripped_for_chat',
        {
            'model': 'm',
            'messages': [
                *USER_MSG,
                {
                    'role': 'tool',
                    'tool_call_id': 't1',
                    'content': [{'type': 'text', 'text': 'a'}, IMG, {'type': 'input_text', 'text': 'b'}, {'type': 'x'}],
                },
                {'role': 'tool', 'tool_call_id': 't2', 'content': 'plain'},
                {'role': 'user', 'content': [{'type': 'text', 'text': 'kept'}, IMG]},
            ],
        },
    ),
    _case(
        'tool_message_images_kept_for_responses',
        {
            'model': 'm',
            'messages': [{'role': 'tool', 'tool_call_id': 't1', 'content': [{'type': 'text', 'text': 'a'}, IMG]}],
        },
        api_config={'api_type': 'responses'},
    ),
    _case(
        'streaming',
        {'model': 'm', 'messages': USER_MSG, 'stream': True, 'stream_options': {'include_usage': True}},
        response={'status': 200, 'headers': SSE, 'text': 'data: {}\n\n'},
    ),
    _case(
        'stream_options_dropped_when_not_streaming',
        {'model': 'm', 'messages': USER_MSG, 'stream': False, 'stream_options': {'include_usage': True}},
    ),
    _case(
        'sse_error_with_json_body',
        {'model': 'm', 'messages': USER_MSG, 'stream': True},
        response={'status': 429, 'headers': SSE, 'text': '{"error": {"message": "slow down"}}'},
    ),
    _case(
        'sse_error_with_text_body',
        {'model': 'm', 'messages': USER_MSG, 'stream': True},
        response={'status': 502, 'headers': SSE, 'text': 'bad gateway'},
    ),
    _case(
        'json_error',
        {'model': 'm', 'messages': USER_MSG},
        response={'status': 400, 'headers': JSON_HEADERS, 'json': {'error': {'message': 'bad request'}}},
    ),
    _case(
        'json_error_list_body',
        {'model': 'm', 'messages': USER_MSG},
        response={'status': 400, 'headers': JSON_HEADERS, 'json': [{'error': 'x'}]},
    ),
    _case(
        'text_error',
        {'model': 'm', 'messages': USER_MSG},
        response={'status': 503, 'headers': {'Content-Type': 'text/html'}, 'text': '<h1>down</h1>'},
    ),
    _case(
        'text_success',
        {'model': 'm', 'messages': USER_MSG},
        response={'status': 200, 'headers': {}, 'text': 'plain text body'},
    ),
    _case('connection_fails', {'model': 'm', 'messages': USER_MSG}, response={'raise_on_request': 'refused'}),
    _case(
        'reading_the_body_fails',
        {'model': 'm', 'messages': USER_MSG},
        response={'status': 200, 'headers': JSON_HEADERS, 'raise_on_read': 'truncated'},
    ),
]


class _FakeResponse:
    def __init__(self, spec: dict):
        self.status = spec.get('status', 200)
        self.headers = spec.get('headers', {})
        self._spec = spec

    async def json(self, loads=json.loads):
        if 'raise_on_read' in self._spec:
            raise RuntimeError(self._spec['raise_on_read'])
        if 'json' in self._spec:
            return self._spec['json']
        return loads(self._spec.get('text', ''))

    async def text(self):
        if 'raise_on_read' in self._spec:
            raise RuntimeError(self._spec['raise_on_read'])
        if 'text' in self._spec:
            return self._spec['text']
        return json.dumps(self._spec.get('json'))


class _FakeSession:
    def __init__(self, spec: dict, log: dict):
        self._spec = spec
        self._log = log

    async def request(self, **kwargs):
        self._log['request'] = {
            'method': kwargs['method'],
            'url': kwargs['url'],
            'data': kwargs['data'],
            'headers': kwargs['headers'],
            'cookies': kwargs['cookies'],
            'timeout': kwargs['timeout'],
        }
        if 'raise_on_request' in self._spec:
            raise RuntimeError(self._spec['raise_on_request'])
        return _FakeResponse(self._spec)


def _model_info(spec):
    if spec is None:
        return None
    params = spec['params']
    return SimpleNamespace(
        id=spec['id'],
        base_model_id=spec['base_model_id'],
        params=SimpleNamespace(model_dump=lambda: copy.deepcopy(params)),
    )


def _describe(result) -> dict:
    if isinstance(result, StreamingResponse):
        return {'kind': 'StreamingResponse', 'status': result.status_code, 'headers': dict(result.headers)}
    if isinstance(result, JSONResponse):
        return {'kind': 'JSONResponse', 'status': result.status_code, 'body': json.loads(result.body)}
    if isinstance(result, PlainTextResponse):
        return {'kind': 'PlainTextResponse', 'status': result.status_code, 'body': result.body.decode()}
    return {'kind': type(result).__name__, 'value': result}


def _run_chat_case(spec: dict, monkeypatch) -> dict:
    log = {'access_checks': [], 'discovery_calls': 0, 'failures': [], 'cleaned_up': [], 'request': None}
    user = SimpleNamespace(id='u1', name='Ada Lovelace', email='ada@example.invalid', role='user', variables={})

    async def config_get(key, default=None):
        assert key == 'openai.enable', key
        return spec['enabled']

    async def get_model_by_id(model_id):
        info = _model_info(spec['model_info'])
        return info if info and info.id == model_id else None

    async def check_model_access(u, model_info, bypass_filter=False):
        log['access_checks'].append({'model': getattr(model_info, 'id', None), 'bypass_filter': bypass_filter})

    async def get_all_models(request, user=None):
        log['discovery_calls'] += 1
        request.app.state.OPENAI_MODELS = copy.deepcopy(spec['discovered'] or {})

    async def get_openai_connection(idx):
        return spec['url'], f'key-{idx}', copy.deepcopy(spec['api_config'])

    async def get_headers_and_cookies(request, url, key, api_config, metadata, user=None):
        return {'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}, {'session': 'c'}

    async def get_session():
        return _FakeSession(spec['response'], log)

    async def publish_failure(request, **kwargs):
        kwargs.pop('actor')
        log['failures'].append(kwargs)

    async def cleanup_response(r):
        log['cleaned_up'].append(r is not None)

    async def stream_wrapper(r):
        yield b''

    monkeypatch.setattr(openai_router.Config, 'get', config_get)
    monkeypatch.setattr(openai_router.Models, 'get_model_by_id', get_model_by_id)
    monkeypatch.setattr(openai_router, 'check_model_access', check_model_access)
    monkeypatch.setattr(openai_router, 'get_all_models', get_all_models)
    monkeypatch.setattr(openai_router, 'get_openai_connection', get_openai_connection)
    monkeypatch.setattr(openai_router, 'get_headers_and_cookies', get_headers_and_cookies)
    monkeypatch.setattr(openai_router, 'get_session', get_session)
    monkeypatch.setattr(openai_router, 'publish_model_provider_request_failed', publish_failure)
    monkeypatch.setattr(openai_router, 'cleanup_response', cleanup_response)
    monkeypatch.setattr(openai_router, 'stream_wrapper', stream_wrapper)
    monkeypatch.setattr(openai_router, 'get_client_timeout', lambda stream=False: f'timeout(stream={stream})')
    monkeypatch.setattr(openai_router, 'BYPASS_MODEL_ACCESS_CONTROL', spec['bypass_env'])

    request = SimpleNamespace(
        state=SimpleNamespace(**spec['state']),
        app=SimpleNamespace(state=SimpleNamespace(OPENAI_MODELS=copy.deepcopy(spec['cached']))),
    )
    if spec['request_base_model_id'] is not None:
        request.base_model_id = spec['request_base_model_id']

    form_data = copy.deepcopy(spec['form_data'])
    try:
        outcome = _describe(asyncio.run(openai_router.generate_chat_completion(request, form_data, user=user)))
    except HTTPException as e:
        outcome = {'kind': 'HTTPException', 'status': e.status_code, 'detail': e.detail}
    except Exception as e:
        outcome = {'kind': 'raised', 'type': type(e).__name__, 'message': str(e)}
    return {**log, 'outcome': outcome, 'form_data_after': form_data}


def _golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding='utf-8'))


def test_cases_have_unique_ids():
    for cases in (RESPONSES_CASES, CHAT_CASES):
        ids = [case[0] for case in cases]
        assert len(ids) == len(set(ids))


@pytest.mark.parametrize(('case_id', 'payload'), RESPONSES_CASES, ids=[c[0] for c in RESPONSES_CASES])
def test_responses_payload_matches_golden(case_id, payload):
    payload = copy.deepcopy(payload)
    result = openai_router.convert_to_responses_payload(payload)
    if RECORD:
        pytest.skip('recording')
    assert {'result': result, 'input_after': payload} == _golden()['responses'][case_id]


@pytest.mark.parametrize(('case_id', 'spec'), CHAT_CASES, ids=[c[0] for c in CHAT_CASES])
def test_chat_completion_matches_golden(monkeypatch, case_id, spec):
    observed = _run_chat_case(spec, monkeypatch)
    if RECORD:
        pytest.skip('recording')
    assert observed == _golden()['chat'][case_id]


@pytest.mark.parametrize(
    ('response', 'expected'),
    [(None, 500), (SimpleNamespace(status=200), 502), (SimpleNamespace(status=301), 502)]
    + [(SimpleNamespace(status=code), code) for code in (400, 404, 429, 500, 503)],
)
def test_upstream_error_status(response, expected):
    """Used by every upstream call in the router, not only the chat completion path the golden file covers."""
    assert openai_router._upstream_error_status(response) == expected


def test_record_golden(monkeypatch):
    """Writes the golden file, only when OPENAI_GOLDEN_RECORD=1."""
    if not RECORD:
        pytest.skip('set OPENAI_GOLDEN_RECORD=1 to record the golden file')
    golden = {'responses': {}, 'chat': {}}
    for case_id, payload in RESPONSES_CASES:
        payload = copy.deepcopy(payload)
        result = openai_router.convert_to_responses_payload(payload)
        golden['responses'][case_id] = {'result': result, 'input_after': payload}
    for case_id, spec in CHAT_CASES:
        with monkeypatch.context() as m:
            golden['chat'][case_id] = _run_chat_case(spec, m)
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
