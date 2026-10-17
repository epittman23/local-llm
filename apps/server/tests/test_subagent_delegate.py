"""Characterization tests for utils/subagents.py's delegate (the sub-agent tool).

It was refactored for ruff's complexity limit with no tests of its own, so
these pin what it did before the refactor: the text it returns, the
sub-agent chat it creates, the completion request it runs, and for
background sub-agents the result message posted into the parent chat and
what is woken afterwards; plus the slots and semaphore it leaves behind.
Config, chat storage, the task runner, the completion handler, the parent
chat row, active-task tracking and socket events are fakes that record
their calls; ids and timestamps are fixed. Each case was recorded from the
untouched function into fixtures/subagent_delegate.json and must not
change.

The golden file is only ever written by hand, never by this test. To record
it again (only for an intended behaviour change, reviewed as such), run
`DELEGATE_GOLDEN_RECORD=1 pytest tests/test_subagent_delegate.py`.
"""

import asyncio
import copy
import json
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

from local_llm.utils import subagents

GOLDEN = Path(__file__).parent / 'fixtures' / 'subagent_delegate.json'
RECORD = os.environ.get('DELEGATE_GOLDEN_RECORD') == '1'

USER = {
    'id': 'u1',
    'name': 'Ada',
    'email': 'ada@example.invalid',
    'role': 'user',
    'profile_image_url': '',
    'last_active_at': 0,
    'updated_at': 0,
    'created_at': 0,
}
FILES = [
    {'id': 'f1', 'name': 'a.txt'},
    {'url': 'https://example.com/doc', 'type': 'url'},
    {'file': {'id': 'f3'}, 'name': 'nested'},
    {'id': None, 'file': 'not a dict'},
]
METADATA = {
    'model_id': 'qwen',
    'session_id': 'sess-1',
    'tool_ids': ['web'],
    'skill_ids': ['s1'],
    'system_prompt': 'Parent rules.',
    'tool_servers': [{'url': 'https://tools'}],
    'filter_ids': ['flt'],
    'terminal_id': 'term-1',
    'features': {'code_interpreter': True, 'web_search': True},
    'files': FILES,
    'variables': {'{{X}}': 'y'},
}
DONE_PARENT = {
    'history': {
        'messages': {
            'm1': {'id': 'm1', 'role': 'user', 'childrenIds': ['a1'], 'timestamp': 1},
            'a1': {'id': 'a1', 'role': 'assistant', 'done': True, 'childrenIds': [], 'timestamp': 2},
            'a2': {'id': 'a2', 'role': 'assistant', 'done': True, 'childrenIds': [], 'timestamp': 5},
            'a3': {'id': 'a3', 'role': 'assistant', 'done': False, 'childrenIds': [], 'timestamp': 9},
        }
    }
}


def _case(
    case_id,
    *,
    task='Summarize the report',
    context='',
    background=False,
    file_ids=None,
    metadata=None,
    parent_chat_id='parent-1',
    user=USER,
    config=None,
    ci_engine='pyodide',
    world=None,
):
    return (
        case_id,
        {
            'task': task,
            'context': context,
            'background': background,
            'file_ids': file_ids,
            'metadata': copy.deepcopy(METADATA) if metadata is None else metadata,
            'parent_chat_id': parent_chat_id,
            'user': user,
            'config': config or {},
            'ci_engine': ci_engine,
            'world': world or {},
        },
    )


ENABLED = {'subagents.background_enabled': True}
CASES = [
    # --- validation ---
    _case('empty_task', task='   '),
    _case('no_parent_chat', parent_chat_id=''),
    _case('no_user_id', user={**USER, 'id': ''}),
    _case('background_disabled', background=True),
    _case('no_model', metadata={**METADATA, 'model_id': None}),
    _case('model_from_model_dict', metadata={**METADATA, 'model_id': None, 'model': {'id': 'from-dict'}}),
    _case('direct_connection', metadata={**METADATA, 'direct': True}),
    _case('file_ids_selected', file_ids=['f1', 'https://example.com/doc', 'f3', '']),
    _case('file_ids_missing', file_ids=['f1', 'zz', 'aa']),
    _case('minimal_metadata', metadata={'model_id': 'qwen'}),
    _case('context_appended', context='Use the Q3 numbers.'),
    # --- foreground results ---
    _case('foreground_summary'),
    _case(
        'foreground_list_content',
        world={
            'message': {
                'content': [
                    {'type': 'text', 'text': 'part one '},
                    'x',
                    {'type': 'image'},
                    {'type': 'text', 'text': 'two'},
                ]
            }
        },
    ),
    _case(
        'foreground_output_items',
        world={
            'message': {
                'content': '',
                'output': [
                    {
                        'type': 'message',
                        'content': [{'type': 'output_text', 'text': 'from output'}, {'type': 'refusal'}],
                    },
                    {'type': 'reasoning'},
                ],
            }
        },
    ),
    _case('foreground_no_output', world={'message': {'content': ''}}),
    _case('foreground_truncated', config={'subagents.max_output': 10}),
    _case('foreground_message_error', world={'message': {'content': 'partial', 'error': {'content': 'model failed'}}}),
    _case('foreground_message_missing', world={'message': None}),
    _case('foreground_handler_raises', world={'handler': 'raise'}),
    _case('foreground_handler_cancelled', world={'handler': 'cancel'}),
    _case(
        'custom_subagent_prompt_without_parent_prompt',
        metadata={**METADATA, 'system_prompt': None},
        config={'subagents.system_prompt': '  Be terse.  '},
    ),
    _case('limits_from_config', config={'subagents.max_concurrent': 3, 'subagents.max_iterations': 7}),
    _case('limits_below_minimum', config={'subagents.max_concurrent': 0, 'subagents.max_async': -5}),
    _case('unlimited_concurrency', config={'subagents.max_concurrent': -1}),
    # --- chat creation and dispatch failures ---
    _case('chat_not_created', world={'insert': None}),
    _case('chat_insert_raises', world={'insert': 'raise'}),
    _case('chat_insert_raises_background', background=True, config=ENABLED, world={'insert': 'raise'}),
    _case('task_dispatch_fails', world={'create_task': 'raise'}),
    _case('task_dispatch_fails_background', background=True, config=ENABLED, world={'create_task': 'raise'}),
    # --- background ---
    _case('background_dispatched', background=True, config=ENABLED, world={'parent': DONE_PARENT}),
    _case(
        'background_keeps_code_interpreter_on_jupyter',
        background=True,
        config=ENABLED,
        ci_engine='jupyter',
        world={'parent': DONE_PARENT},
    ),
    _case('background_parent_busy', background=True, config=ENABLED, world={'parent': DONE_PARENT, 'active': True}),
    _case('background_parent_missing', background=True, config=ENABLED, world={'parent': None}),
    _case('background_parent_without_done_assistants', background=True, config=ENABLED, world={'parent': {}}),
    _case(
        'background_result_error',
        background=True,
        config=ENABLED,
        context='ctx',
        world={'parent': DONE_PARENT, 'message': {'content': 'half done', 'error': {'content': 'boom'}}},
    ),
    _case(
        'background_result_missing_message',
        background=True,
        config=ENABLED,
        world={'parent': DONE_PARENT, 'message': None},
    ),
    _case(
        'background_handler_raises', background=True, config=ENABLED, world={'parent': DONE_PARENT, 'handler': 'raise'}
    ),
    _case('background_cancelled', background=True, config=ENABLED, world={'parent': DONE_PARENT, 'handler': 'cancel'}),
    _case(
        'background_cancelled_parent_missing',
        background=True,
        config=ENABLED,
        world={'parent': None, 'handler': 'cancel'},
    ),
    _case(
        'background_capacity_reached',
        background=True,
        config={**ENABLED, 'subagents.max_async': 1},
        world={'already_running': 1},
    ),
    _case('second_call_reuses_semaphore', world={'calls': 2}),
    _case('unlimited_concurrency_insert_fails', config={'subagents.max_concurrent': -1}, world={'insert': 'raise'}),
    _case(
        'unlimited_concurrency_dispatch_fails', config={'subagents.max_concurrent': -1}, world={'create_task': 'raise'}
    ),
    _case('background_on_sqlite', background=True, config=ENABLED, world={'parent': DONE_PARENT, 'dialect': 'sqlite'}),
    _case('caller_cancelled_while_waiting', world={'handler': 'hang', 'cancel_caller': True}),
    _case(
        'background_unlimited',
        background=True,
        config={**ENABLED, 'subagents.max_async': -1},
        world={'parent': DONE_PARENT, 'already_running': 3},
    ),
]


parent_dialect = 'postgresql'


class _FakeDB:
    def __init__(self, parent, log):
        self.parent = parent
        self.log = log
        self.bind = SimpleNamespace(dialect=SimpleNamespace(name=parent_dialect))

    async def execute(self, stmt):
        self.log.append(['select_parent', 'FOR UPDATE' in str(stmt)])
        return SimpleNamespace(scalar_one_or_none=lambda: self.parent)

    async def commit(self):
        self.log.append(['commit'])


def _install_world(spec: dict, monkeypatch):
    """Patches every collaborator with a fake; returns (call log, created tasks, parent row, request)."""
    log = []
    world = spec['world']
    config = {
        'subagents.background_enabled': False,
        'subagents.max_concurrent': None,
        'subagents.max_async': None,
        'subagents.max_iterations': None,
        'subagents.max_output': None,
        'subagents.system_prompt': None,
        **spec['config'],
    }
    global parent_dialect
    parent_dialect = world.get('dialect', 'postgresql')
    counter = iter(range(1, 10_000))
    monkeypatch.setattr(subagents, 'uuid4', lambda: uuid.UUID(int=next(counter)))
    monkeypatch.setattr(subagents.time, 'time', lambda: 1000.0)
    monkeypatch.setattr(
        subagents, '_background_active', {f'running-{i}' for i in range(world.get('already_running', 0))}
    )
    monkeypatch.setattr(subagents, '_foreground_semaphore', None)
    monkeypatch.setattr(subagents, '_parent_locks', {})
    monkeypatch.setattr(subagents, '_background_lock', None)

    parent_row = (
        SimpleNamespace(chat=copy.deepcopy(world['parent']), updated_at=0) if world.get('parent') is not None else None
    )

    async def get_many(*keys):
        return {key: config.get(key) for key in keys}

    async def config_get(key, default=None):
        assert key == 'code_interpreter.engine', key
        return spec['ci_engine']

    async def insert_new_chat(chat_id, user_id, form, internal_meta=None):
        log.append(['insert_chat', chat_id, user_id, form.chat, internal_meta])
        if world.get('insert') == 'raise':
            raise RuntimeError('db down')
        return None if 'insert' in world and world['insert'] is None else SimpleNamespace(id=chat_id)

    def build_request(source, user_id, *, internal):
        return SimpleNamespace(state=SimpleNamespace(), app=source.app, _internal=internal)

    async def handler(request, form_data, user=None):
        log.append(
            [
                'completion',
                {
                    'internal': request._internal,
                    'max_tool_call_iterations': getattr(request.state, 'max_tool_call_iterations', None),
                    'form_data': form_data,
                    'user': user.id,
                },
            ]
        )
        if world.get('handler') == 'raise':
            raise RuntimeError('completion failed')
        if world.get('handler') == 'cancel':
            raise asyncio.CancelledError
        if world.get('handler') == 'hang':
            await asyncio.sleep(30)

    async def get_message(chat_id, message_id):
        return copy.deepcopy(world.get('message', {'content': 'The report says sales grew.'}))

    async def upsert_message_to_chat(chat_id, message_id, data):
        log.append(['mark_message', chat_id, message_id, data])

    tasks = []

    async def create_task(redis, coroutine, id=None):
        if world.get('create_task') == 'raise':
            coroutine.close()
            raise RuntimeError('task queue unavailable')
        task = asyncio.ensure_future(coroutine)
        tasks.append(task)
        return id, task

    @asynccontextmanager
    async def get_async_db():
        yield _FakeDB(parent_row, log)

    async def has_active_tasks(redis, chat_id):
        log.append(['has_active_tasks', chat_id])
        return bool(world.get('active'))

    async def upsert_chat_message(message_id, chat_id, user_id, data):
        log.append(['upsert_chat_message', message_id, chat_id, user_id, data])

    async def emit(event, data, room=None):
        log.append(['emit', event, data, room])

    async def process_pending(request, parent_chat_id, user_id, run):
        log.append(['process_pending', parent_chat_id, user_id, run])

    monkeypatch.setattr(subagents.Config, 'get_many', get_many)
    monkeypatch.setattr(subagents.Config, 'get', config_get)
    monkeypatch.setattr(subagents.Chats, 'insert_new_chat', insert_new_chat)
    monkeypatch.setattr(subagents.Chats, 'get_message_by_id_and_message_id', get_message)
    monkeypatch.setattr(subagents.Chats, 'upsert_message_to_chat_by_id_and_message_id', upsert_message_to_chat)
    monkeypatch.setattr(subagents, '_build_request', build_request)
    monkeypatch.setattr(subagents, 'create_task', create_task)
    monkeypatch.setattr(subagents, 'get_async_db', get_async_db)
    monkeypatch.setattr(subagents, 'has_active_tasks', has_active_tasks)
    monkeypatch.setattr(subagents.ChatMessages, 'upsert_message', upsert_chat_message)
    monkeypatch.setattr(subagents, 'process_pending_internal_messages', process_pending)
    from local_llm.socket import main as socket_main

    monkeypatch.setattr(socket_main.sio, 'emit', emit)

    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(redis='<redis>', CHAT_COMPLETION_HANDLER=handler))
    )
    return log, tasks, parent_row, request


async def _settle(tasks: list) -> list:
    """Each background task's outcome, once it finishes."""
    outcomes = []
    for task in tasks:
        try:
            outcomes.append({'result': await task})
        except asyncio.CancelledError:
            outcomes.append({'cancelled': True})
        except Exception as e:
            outcomes.append({'raised': f'{type(e).__name__}: {e}'})
    return outcomes


def _run(spec: dict, monkeypatch) -> dict:
    world = spec['world']
    log, tasks, parent_row, request = _install_world(spec, monkeypatch)

    def call():
        return subagents.delegate(
            spec['task'],
            spec['context'],
            spec['background'],
            file_ids=spec['file_ids'],
            request=request,
            user_data=spec['user'],
            metadata=copy.deepcopy(spec['metadata']),
            parent_chat_id=spec['parent_chat_id'],
            parent_message_id='pm-1',
        )

    async def scenario():
        subagents._background_lock = asyncio.Lock()
        if world.get('cancel_caller'):
            caller = asyncio.ensure_future(call())
            await asyncio.sleep(0.05)
            caller.cancel()
            try:
                returned = await caller
            except asyncio.CancelledError:
                returned = '<caller cancelled>'
        else:
            returned = [await call() for _ in range(world.get('calls', 1))]
            returned = returned[0] if len(returned) == 1 else returned
        background = await _settle(tasks)
        semaphore = subagents._foreground_semaphore
        return {
            'returned': returned,
            'background_task': background,
            'background_slots_left': sorted(subagents._background_active),
            'semaphore_free': semaphore._value if semaphore is not None else None,
        }

    outcome = asyncio.run(scenario())
    return json.loads(
        json.dumps({**outcome, 'calls': log, 'parent_after': parent_row.chat if parent_row else None}, default=str)
    )


def _golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding='utf-8'))


def test_case_ids_are_unique():
    ids = [case[0] for case in CASES]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize(('case_id', 'spec'), CASES, ids=[c[0] for c in CASES])
def test_delegate_matches_golden(monkeypatch, case_id, spec):
    observed = _run(spec, monkeypatch)
    if RECORD:
        pytest.skip('recording')
    assert observed == _golden()[case_id]


def test_record_golden(monkeypatch):
    """Writes the golden file, only when DELEGATE_GOLDEN_RECORD=1."""
    if not RECORD:
        pytest.skip('set DELEGATE_GOLDEN_RECORD=1 to record the golden file')
    golden = {}
    for case_id, spec in CASES:
        with monkeypatch.context() as m:
            golden[case_id] = _run(spec, m)
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')


@pytest.mark.parametrize(
    ('error', 'text'),
    [
        ({'content': 'model failed'}, 'model failed'),
        ({'content': None}, ''),
        ({'code': 500}, "{'code': 500}"),
        ('plain', 'plain'),
    ],
)
def test_error_text(error, text):
    """A stored message error reads as its content; anything else as its string form."""
    assert subagents._error_text(error) == text
