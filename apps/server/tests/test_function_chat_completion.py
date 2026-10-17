"""Characterization tests for functions.py's generate_function_chat_completion.

It runs a pipe plugin as if it were a model, and was refactored for ruff's
complexity limit with no tests of its own. These pin what it did before the
refactor: the body and the injected parameters the pipe receives (only
those its signature asks for), the access check, the OAuth token and user
valves it looks up, and what comes back, as a response or as the exact
stream chunks. Workspace models, event emitters, OAuth sessions, user
valves and the plugin modules are fakes; payload helpers and message
templates run for real, with ids and time fixed. Each case was recorded
from the untouched function into fixtures/function_chat_completion.json
and must not change.

The golden file is only ever written by hand, never by this test. To record
it again (only for an intended behaviour change, reviewed as such), run
`FUNCTION_COMPLETION_GOLDEN_RECORD=1 pytest tests/test_function_chat_completion.py`.
"""

import asyncio
import copy
import inspect
import json
import os
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import BaseModel
from starlette.responses import StreamingResponse

from local_llm import functions
from local_llm.models import oauth_sessions
from local_llm.models.users import UserModel

GOLDEN = Path(__file__).parent / 'fixtures' / 'function_chat_completion.json'
RECORD = os.environ.get('FUNCTION_COMPLETION_GOLDEN_RECORD') == '1'

USER = {
    'id': 'u1', 'name': 'Ada', 'email': 'ada@example.invalid', 'role': 'user',
    'profile_image_url': '', 'last_active_at': 0, 'updated_at': 0, 'created_at': 0,
}  # fmt: skip
ADMIN = {**USER, 'id': 'a1', 'role': 'admin'}
FULL_METADATA = {
    'session_id': 's1', 'chat_id': 'c1', 'message_id': 'm1', 'task': 'title_generation',
    'task_body': {'x': 1}, 'files': [{'id': 'f1'}], 'tool_ids': None, 'tools': {'search': {}},
}  # fmt: skip


class Reply(BaseModel):
    text: str


def _pipes():
    """Pipe plugins by name. Each records the params it got into PIPE_CALLS."""

    def sync_text(body):
        return f'echo: {body["messages"][-1]["content"]}'

    async def async_text(body):
        return 'async hello'

    async def every_param(body, __user__, __metadata__, __event_emitter__, __event_call__, __oauth_token__,
                          __tools__, __files__, __task__, __task_body__, __chat_id__, __session_id__,
                          __message_id__, __request__):  # fmt: skip
        return 'saw every param'

    def user_only(body, __user__):
        return 'user only'

    def sync_lines(body):
        yield 'plain text'
        yield b'bytes text'
        yield {'choices': [{'delta': {'content': 'from dict'}}]}
        yield Reply(text='from model')
        yield 'data: {"raw": true}'

    def sync_parts(body):
        yield 'part one, '
        yield 'part two'

    async def async_lines(body):
        yield 'async one'
        yield b'data: {"async": true}'

    def as_dict(body):
        return {'id': 'x', 'choices': [{'message': {'content': 'dict reply'}}]}

    def as_model(body):
        return Reply(text='model reply')

    def as_streaming_response(body):
        async def chunks():
            yield b'data: {"streamed": 1}\n\n'
            yield b'data: [DONE]'

        return StreamingResponse(chunks(), media_type='text/event-stream')

    def as_list(body):
        return ['not', 'text']

    def as_none(body):
        return None

    def fails(body):
        raise ValueError('pipe exploded')

    return {name: fn for name, fn in locals().items() if callable(fn)}


PIPES = _pipes()


def _case(case_id, pipe='sync_text', *, model='mypipe', stream=False, model_info=None, user=USER, metadata=None,
          state=None, cookie=None, oauth=None, sessions=None, user_valves=None, valves_class=False,
          bypass_model=False, bypass_admin=False, extra_body=None, models=None):  # fmt: skip
    return (case_id, {
        'pipe': pipe, 'model': model, 'stream': stream, 'model_info': model_info, 'user': user,
        'metadata': metadata, 'state': state or {}, 'cookie': cookie, 'oauth': oauth, 'sessions': sessions or [],
        'user_valves': user_valves, 'valves_class': valves_class, 'bypass_model': bypass_model,
        'bypass_admin': bypass_admin, 'extra_body': extra_body or {}, 'models': models,
    })  # fmt: skip


INFO = {'base_model_id': None, 'params': {}}
CASES = [
    _case('text'),
    _case('text_streamed', stream=True),
    _case('async_text', 'async_text'),
    _case('async_text_streamed', 'async_text', stream=True),
    _case('manifold_model_id', model='mypipe.sub-model'),
    _case(
        'every_param',
        'every_param',
        metadata=FULL_METADATA,
        cookie='oauth-sess',
        oauth={'oauth-sess': {'access_token': 't1'}},
    ),
    _case('metadata_without_event_ids', 'every_param', metadata={'chat_id': 'c1', 'task': 't'}),
    _case('no_metadata', 'every_param'),
    _case('signature_subset', 'user_only', metadata=FULL_METADATA),
    _case(
        'oauth_from_latest_session',
        'every_param',
        sessions=[['old', 1], ['new', 5], ['mid', 3]],
        oauth={'new': {'access_token': 'latest'}},
    ),
    _case(
        'oauth_cookie_without_token_falls_back',
        'every_param',
        cookie='dead',
        sessions=[['s9', 1]],
        oauth={'s9': {'access_token': 'fallback'}},
    ),
    _case('oauth_no_sessions', 'every_param'),
    _case('oauth_lookup_fails', 'every_param', cookie='boom', oauth='raise'),
    _case('user_valves', 'user_only', valves_class=True, user_valves={'level': 3}),
    _case('user_valves_invalid', 'user_only', valves_class=True, user_valves={'level': 'not a number'}),
    _case('user_valves_without_user_param', 'sync_text', valves_class=True, user_valves={'level': 3}),
    _case('user_not_a_user_model', 'every_param', user='dict', model_info=INFO),
    _case(
        'workspace_model_base_and_params',
        model_info={'base_model_id': 'mypipe', 'params': {'temperature': 0.2, 'system': 'Be brief.'}},
        model='custom',
    ),
    _case(
        'workspace_model_bypass_system_prompt',
        model_info={'base_model_id': None, 'params': {'system': 'never'}},
        state={'bypass_system_prompt': True},
    ),
    _case('workspace_model_empty_params', model_info=INFO),
    _case('access_check_admin_bypass', model_info=INFO, user=ADMIN, bypass_admin=True),
    _case('access_check_skipped', model_info=INFO, bypass_model=True),
    _case('lines_streamed', 'sync_lines', stream=True),
    _case('parts_joined', 'sync_parts'),
    _case('async_lines_streamed', 'async_lines', stream=True),
    _case('async_lines_joined', 'async_lines'),
    _case('dict_reply', 'as_dict'),
    _case('dict_reply_streamed', 'as_dict', stream=True),
    _case('model_reply', 'as_model'),
    _case('model_reply_streamed', 'as_model', stream=True),
    _case('streaming_response', 'as_streaming_response'),
    _case('streaming_response_streamed', 'as_streaming_response', stream=True),
    _case('list_reply', 'as_list'),
    _case('list_reply_streamed', 'as_list', stream=True),
    _case('none_reply', 'as_none'),
    _case('pipe_fails', 'fails'),
    _case('pipe_fails_streamed', 'fails', stream=True),
    _case('models_passed_in', models={'mypipe': {'id': 'mypipe'}}),
    _case(
        'caller_body_not_mutated',
        model_info={'base_model_id': 'mypipe', 'params': {}},
        model='custom',
        extra_body={'metadata': {'chat_id': 'c'}},
    ),
]


def _describe(value):
    if isinstance(value, SimpleNamespace) and getattr(value, '_marker', None):
        return value._marker
    if callable(value) and getattr(value, '_marker', None):
        return value._marker
    if isinstance(value, BaseModel):
        return {'model': type(value).__name__, **value.model_dump()}
    if isinstance(value, dict):
        return {k: _describe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_describe(v) for v in value]
    return value


def _run(spec: dict, monkeypatch) -> dict:
    log = []
    counter = iter(range(1, 10_000))
    monkeypatch.setattr(uuid, 'uuid4', lambda: uuid.UUID(int=next(counter)))
    monkeypatch.setattr(time, 'time', lambda: 1000.0)
    monkeypatch.setattr(functions, 'BYPASS_MODEL_ACCESS_CONTROL', spec['bypass_model'])
    monkeypatch.setattr(functions, 'BYPASS_ADMIN_ACCESS_CONTROL', spec['bypass_admin'])

    async def get_model_by_id(model_id):
        info = spec['model_info']
        if info is None:
            return None
        params = copy.deepcopy(info['params'])
        return SimpleNamespace(
            id=model_id,
            base_model_id=info['base_model_id'],
            params=SimpleNamespace(model_dump=lambda: copy.deepcopy(params)),
        )

    def emitter(kind, metadata):
        async def fn(*args, **kwargs):
            return None

        fn._marker = f'<{kind} for {metadata.get("chat_id")}>'
        return fn

    async def get_event_emitter(metadata):
        return emitter('event emitter', metadata)

    async def get_event_call(metadata):
        return emitter('event call', metadata)

    async def check_model_access(user, model_info, bypass=False):
        log.append(['check_model_access', user.id, model_info.id, bypass])

    async def get_oauth_token(user_id, session_id):
        log.append(['oauth_token', user_id, session_id])
        if spec['oauth'] == 'raise':
            raise RuntimeError('oauth store down')
        return (spec['oauth'] or {}).get(session_id)

    async def get_sessions_by_user_id(user_id):
        log.append(['oauth_sessions', user_id])
        return [SimpleNamespace(id=sid, updated_at=updated) for sid, updated in spec['sessions']]

    pipe_fn = PIPES[spec['pipe']]

    async def get_function_module_by_id(request, pipe_id):
        log.append(['load_pipe', pipe_id])
        module = SimpleNamespace(pipe=pipe_fn)
        if spec['valves_class']:

            class UserValves(BaseModel):
                level: int = 1

            module.UserValves = UserValves
        return module

    async def get_user_valves(pipe_id, user_id):
        log.append(['user_valves', pipe_id, user_id])
        return copy.deepcopy(spec['user_valves'])

    received = {}

    def recording(fn):
        """The pipe, recording the params it is called with; same signature and kind (coroutine or not)."""
        if asyncio.iscoroutinefunction(fn):

            async def wrapper(**params):
                received.update(params)
                return await fn(**params)
        else:

            def wrapper(**params):
                received.update(params)
                return fn(**params)

        wrapper.__signature__ = inspect.signature(fn)
        return wrapper

    monkeypatch.setattr(functions.Models, 'get_model_by_id', get_model_by_id)
    monkeypatch.setattr(functions, 'get_event_emitter', get_event_emitter)
    monkeypatch.setattr(functions, 'get_event_call', get_event_call)
    monkeypatch.setattr(functions, 'check_model_access', check_model_access)
    monkeypatch.setattr(oauth_sessions.OAuthSessions, 'get_sessions_by_user_id', get_sessions_by_user_id)
    monkeypatch.setattr(functions, 'get_function_module_by_id', get_function_module_by_id)
    monkeypatch.setattr(functions.Functions, 'get_user_valves_by_id_and_user_id', get_user_valves)
    pipe_fn = recording(pipe_fn)

    request = SimpleNamespace(
        _marker='<request>',
        state=SimpleNamespace(**spec['state']),
        cookies={'oauth_session_id': spec['cookie']} if spec['cookie'] else {},
        app=SimpleNamespace(state=SimpleNamespace(oauth_manager=SimpleNamespace(get_oauth_token=get_oauth_token))),
    )
    # A plain mapping user is wrapped as UserModel(**user) for the access check.
    user = _PlainUser(USER) if spec['user'] == 'dict' else UserModel(**spec['user'])
    body = {
        'model': spec['model'],
        'messages': [{'role': 'user', 'content': 'hi'}],
        'stream': spec['stream'],
        **({'metadata': copy.deepcopy(spec['metadata'])} if spec['metadata'] is not None else {}),
        **copy.deepcopy(spec['extra_body']),
    }
    caller_body = copy.deepcopy(body)

    async def scenario():
        result = await functions.generate_function_chat_completion(request, body, user, models=spec['models'])
        if isinstance(result, StreamingResponse):
            chunks = [c.decode() if isinstance(c, bytes) else c async for c in result.body_iterator]
            return {'stream': chunks}
        return {'returned': _describe(result)}

    outcome = asyncio.run(scenario())
    return json.loads(json.dumps({
        **outcome,
        'pipe_received': {k: _describe(v) for k, v in sorted(received.items())},
        'caller_body_unchanged': body == caller_body,
        'calls': log,
    }, default=str))  # fmt: skip


class _PlainUser(dict):
    """A user given as a mapping, as some internal callers pass it."""

    @property
    def id(self):
        return self['id']


def _golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding='utf-8'))


def test_case_ids_are_unique():
    ids = [case[0] for case in CASES]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize(('case_id', 'spec'), CASES, ids=[c[0] for c in CASES])
def test_function_completion_matches_golden(monkeypatch, case_id, spec):
    observed = _run(spec, monkeypatch)
    if RECORD:
        pytest.skip('recording')
    assert observed == _golden()[case_id]


def test_record_golden(monkeypatch):
    """Writes the golden file, only when FUNCTION_COMPLETION_GOLDEN_RECORD=1."""
    if not RECORD:
        pytest.skip('set FUNCTION_COMPLETION_GOLDEN_RECORD=1 to record the golden file')
    golden = {}
    for case_id, spec in CASES:
        with monkeypatch.context() as m:
            golden[case_id] = _run(spec, m)
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
