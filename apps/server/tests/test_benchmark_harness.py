"""Benchmarks answered through the app's chat pipeline (benchmarks/evaluation/harness.py).

The rules come from docs/plans/benchmarks-through-the-app.md: a result is
recorded only when every upstream request went to the measured llama-server
(D4), under a harness sha read back from what was sent (D5), graded on the
final message alone (D6), with no llama.cpp timings (D7), and with a failed
pipeline recorded as a failure or a dead server raised (D8). These pin each
rule without a model: the pipeline's steps, the upstream calls and the
database are fakes, apart from the two query tests, which use the test run's
migrated database.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from types import SimpleNamespace

import pytest

from local_llm.benchmarks.evaluation import harness, runner
from local_llm.internal.db import get_async_db_context
from local_llm.models.benchmarks.tests import BenchmarkResult, BenchmarkResults
from local_llm.utils import upstream_trace

PORT = 8090
LOCAL = f'http://127.0.0.1:{PORT}/v1/chat/completions'


# ---------------------------------------------------------------------------
# the routing guard's URL check
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ('url', 'local'),
    [
        (f'http://127.0.0.1:{PORT}/v1', True),
        (f'http://localhost:{PORT}/v1/chat/completions', True),
        (f'http://[::1]:{PORT}/v1', True),
        ('http://127.0.0.1:8091/v1', False),
        ('https://openrouter.ai/api/v1', False),
        (f'http://192.168.1.5:{PORT}/v1', False),
        (f'http://127.0.0.1.example.com:{PORT}/v1', False),
        ('http://127.0.0.1/v1', False),
    ],
)
def test_only_the_measured_llama_server_counts_as_local(url, local):
    assert harness.is_local_target(url, PORT) is local


# ---------------------------------------------------------------------------
# what is graded
# ---------------------------------------------------------------------------
def _message(text):
    return {'type': 'message', 'content': [{'type': 'output_text', 'text': text}]}


def test_the_graded_text_is_the_message_after_the_last_code_run():
    output = [
        {'type': 'reasoning', 'content': [{'type': 'output_text', 'text': 'thinking'}]},
        _message('Let me test it:\n```python\nprint(f(2))\n```'),
        {'type': 'function_call', 'name': 'execute_code', 'arguments': '{}'},
        {'type': 'function_call_output', 'output': '4'},
        _message('```python\ndef f(x):\n    return x * 2\n```'),
    ]

    assert harness.final_text(output) == '```python\ndef f(x):\n    return x * 2\n```'
    assert harness.reasoning_text(output) == 'thinking'


def test_with_no_code_run_every_message_is_the_answer():
    assert harness.final_text([_message('a'), _message('b')]) == 'a\nb'


def test_an_answer_given_only_inside_a_code_run_grades_as_empty():
    output = [_message('x'), {'type': 'open_webui:code_interpreter', 'code': 'def f(): pass', 'output': ''}]

    assert harness.final_text(output) == ''


# ---------------------------------------------------------------------------
# preparing a run: the refusals
# ---------------------------------------------------------------------------
def _entry(params=None, base='qwen25c'):
    return SimpleNamespace(
        base_model_id=base,
        params=SimpleNamespace(model_dump=lambda: dict(params or {})) if params is not None else None,
    )


@pytest.fixture
def app_with(monkeypatch):
    """prepare() against a fake app: models, one connection URL, the code interpreter settings."""
    from local_llm import main
    from local_llm.models.config import Config
    from local_llm.routers import openai as openai_router

    state = {
        'models': {'coder': {'id': 'coder', 'info': {}}, 'qwen25c': {'id': 'qwen25c', 'urlIdx': 1}},
        'entry': _entry({}),
        'missing_base': False,
        'url': f'http://127.0.0.1:{PORT}/v1',
        'api_config': {},
        'engine': 'jupyter',
        'enabled': True,
        'defaults': {},
        'jupyter': True,
    }

    async def resolve(request, model_id, model_item, user):
        return state['models'][model_id], state['entry'], None, state['missing_base']

    async def connection(idx):
        return state['url'], 'key', state['api_config']

    async def get_many(*keys):
        return {'code_interpreter.enable': state['enabled'], 'code_interpreter.engine': state['engine']}

    async def get(key, default=None):
        return state['defaults'] if key == 'models.default_params' else default

    async def jupyter_alive(ci):
        return state['jupyter']

    monkeypatch.setattr(main, '_resolve_chat_model', resolve)
    monkeypatch.setattr(openai_router, 'get_openai_connection', connection)
    monkeypatch.setattr(Config, 'get_many', get_many)
    monkeypatch.setattr(Config, 'get', get)
    monkeypatch.setattr(harness, '_request_for', lambda source, user: source)
    monkeypatch.setattr(harness, '_jupyter_alive', jupyter_alive)

    def prepare(model='coder'):
        source = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(MODELS=state['models'])))
        return asyncio.run(harness.prepare(source, SimpleNamespace(id='u1'), model, PORT))

    return state, prepare


def test_a_local_entry_is_accepted(app_with):
    _, prepare = app_with
    hctx = prepare()

    assert (hctx['model_entry'], hctx['base_model'], hctx['port']) == ('coder', 'qwen25c', PORT)


@pytest.mark.parametrize(
    ('change', 'message'),
    [
        ({'url': 'https://openrouter.ai/api/v1'}, 'not the llama-server'),
        ({'url': 'http://127.0.0.1:8091/v1'}, 'not the llama-server'),
        ({'entry': None}, 'not a Workspace model entry'),
        ({'missing_base': True}, 'base model'),
        ({'entry': _entry({'stream_response': False})}, 'streaming'),
        ({'entry': _entry({'function_calling': 'legacy'})}, 'legacy'),
        ({'entry': _entry({'max_completion_tokens': 100})}, 'max_completion_tokens'),
        ({'engine': 'pyodide'}, 'Jupyter'),
        ({'enabled': False}, 'Jupyter'),
        ({'jupyter': False}, 'does not answer'),
        # The global defaults count too: the pipeline merges them under the entry's.
        ({'defaults': {'stream_response': False}}, 'streaming'),
        ({'defaults': {'max_completion_tokens': 64}}, 'max_completion_tokens'),
        ({'api_config': {'api_type': 'responses'}}, 'chat completions'),
    ],
)
def test_an_entry_the_harness_cannot_vouch_for_is_refused(app_with, change, message):
    state, prepare = app_with
    state.update(change)

    with pytest.raises(harness.HarnessRefused, match=message):
        prepare()


def test_an_unknown_model_is_refused(app_with):
    _, prepare = app_with
    with pytest.raises(harness.HarnessRefused, match='no model'):
        prepare('nope')


def test_an_entry_on_a_non_openai_connection_is_refused(app_with):
    state, prepare = app_with
    state['models']['qwen25c'] = {'id': 'qwen25c', 'owned_by': 'ollama', 'urlIdx': 0}

    with pytest.raises(harness.HarnessRefused, match='OpenAI-compatible'):
        prepare()


# ---------------------------------------------------------------------------
# asking: the guard during the call, errors, the spec
# ---------------------------------------------------------------------------
HCTX = {'model_entry': 'coder', 'base_model': 'qwen25c', 'port': PORT, 'timeout': 5, 'max_tokens': 2048}

BODY = {
    'model': 'qwen25c',
    'messages': [{'role': 'system', 'content': 'Be precise.'}, {'role': 'user', 'content': 'item'}],
    'tools': [{'type': 'function', 'function': {'name': 'execute_code'}}],
    'temperature': 0,
    'max_tokens': 2048,
    'stream': True,
}


def _pipeline(monkeypatch, *, urls=(LOCAL,), assistant=None, errors=(), runs=(), raises=None, alive=True):
    async def run(hctx, prompt, errs):
        for url in urls:
            upstream_trace.note_request(url, json.dumps(BODY))
        for ms in runs:
            upstream_trace.note_code_run(ms)
        errs.extend(errors)
        if raises:
            raise raises
        return assistant

    async def server_alive(port):
        return alive

    monkeypatch.setattr(harness, '_run_pipeline', run)
    monkeypatch.setattr(harness, '_server_alive', server_alive)


def test_an_answer_is_graded_on_its_final_message_with_stats_and_a_spec(monkeypatch):
    output = [_message('trying'), {'type': 'function_call_output', 'output': '4'}, _message('final')]
    _pipeline(
        monkeypatch,
        urls=(LOCAL, LOCAL),
        assistant={'output': output, 'usage': {'output_tokens': 31}},
        runs=(120.4, 80.2),
    )
    ans = asyncio.run(harness.ask(HCTX, 'item'))

    assert (ans.content, ans.error, ans.gone) == ('final', '', False)
    assert ans.stats == {'rounds': 2, 'code_runs': 2, 'code_ms': 201, 'output_tokens': 31}
    assert ans.spec['tools'] == ['execute_code']
    # Every key of the body but the conversation and the tools.
    assert ans.spec['params'] == {'model': 'qwen25c', 'temperature': 0, 'max_tokens': 2048, 'stream': True}
    assert ans.spec['system_sha'] == harness._sha('Be precise.')
    assert ans.spec['model_entry'] == 'coder'


def test_output_tokens_are_none_when_the_connection_reports_no_usage(monkeypatch):
    _pipeline(monkeypatch, assistant={'output': [_message('x')]})
    assert asyncio.run(harness.ask(HCTX, 'item')).stats['output_tokens'] is None


def test_a_request_anywhere_else_refuses_the_result(monkeypatch):
    _pipeline(monkeypatch, urls=(LOCAL, 'https://openrouter.ai/api/v1/chat/completions'), assistant={'output': []})

    with pytest.raises(harness.HarnessRefused, match='openrouter'):
        asyncio.run(harness.ask(HCTX, 'item'))


def test_no_observed_request_refuses_the_result(monkeypatch):
    _pipeline(monkeypatch, urls=(), assistant={'output': [_message('x')]})

    with pytest.raises(harness.HarnessRefused, match='no upstream request'):
        asyncio.run(harness.ask(HCTX, 'item'))


def test_the_refusal_names_the_pipelines_own_error(monkeypatch):
    _pipeline(monkeypatch, urls=(), errors=('Model not found',))

    with pytest.raises(harness.HarnessRefused, match='Model not found'):
        asyncio.run(harness.ask(HCTX, 'item'))


def test_a_request_elsewhere_is_stopped_before_it_is_sent():
    sent = []

    async def router(url):
        # What routers/openai.py does: note the request, then send it.
        upstream_trace.note_request(url, '{}')
        sent.append(url)

    async def go():
        with upstream_trace.tracing(allow=lambda url: harness.is_local_target(url, PORT)) as trace:
            await router(LOCAL)
            with pytest.raises(upstream_trace.UpstreamRefused):
                await router('https://openrouter.ai/api/v1/chat/completions')
        return trace.requests

    noted = asyncio.run(go())
    assert sent == [LOCAL]
    assert [url for url, _ in noted] == [LOCAL, 'https://openrouter.ai/api/v1/chat/completions']


def test_a_failed_code_interpreter_stops_the_run(monkeypatch):
    async def run(hctx, prompt, errs):
        upstream_trace.note_request(LOCAL, json.dumps(BODY))
        upstream_trace.note_code_run(5.0, failure='Cannot connect to host 127.0.0.1:8888')
        return {'output': [_message('answered without code')]}

    monkeypatch.setattr(harness, '_run_pipeline', run)
    with pytest.raises(harness.HarnessRefused, match='code interpreter failed'):
        asyncio.run(harness.ask(HCTX, 'item'))


def test_the_jupyter_client_reports_its_own_failure_to_the_trace(monkeypatch):
    from local_llm.utils import code_interpreter as ci

    class Executor:
        def __init__(self, *args):
            self.failure = 'HTTP 403'

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def run(self):
            return ci.ResultModel(stderr='Error: HTTP 403')

    monkeypatch.setattr(ci, 'JupyterCodeExecuter', Executor)

    async def go():
        with upstream_trace.tracing() as trace:
            await ci.execute_code_jupyter('http://jupyter', 'x')
        return trace

    trace = asyncio.run(go())
    assert len(trace.code_runs_ms) == 1 and trace.code_run_failures == ['HTTP 403']


def test_a_pipeline_error_with_the_server_up_is_the_items_failure(monkeypatch):
    _pipeline(monkeypatch, errors=('context window exceeded',), assistant=None)
    ans = asyncio.run(harness.ask(HCTX, 'item'))

    assert (ans.error, ans.gone, ans.content) == ('context window exceeded', False, '')


def test_a_pipeline_error_with_the_server_down_is_a_dead_server(monkeypatch):
    _pipeline(monkeypatch, errors=('Cannot connect',), assistant=None, alive=False)
    ans = asyncio.run(harness.ask(HCTX, 'item'))

    assert ans.gone and 'port 8090' in ans.error


def test_a_dead_server_before_any_request_is_a_dead_server_not_a_refusal(monkeypatch):
    _pipeline(monkeypatch, urls=(), raises=ConnectionError('refused'), alive=False)
    ans = asyncio.run(harness.ask(HCTX, 'item'))

    assert ans.gone


def test_an_exception_in_the_pipeline_is_recorded_as_the_error(monkeypatch):
    _pipeline(monkeypatch, raises=ValueError('bad chunk'))
    ans = asyncio.run(harness.ask(HCTX, 'item'))

    assert ans.error == 'ValueError: bad chunk' and not ans.gone


def test_an_item_past_its_timeout_is_a_failure(monkeypatch):
    async def run(hctx, prompt, errs):
        upstream_trace.note_request(LOCAL, json.dumps(BODY))
        await asyncio.sleep(1)

    async def server_alive(port):
        return True

    monkeypatch.setattr(harness, '_run_pipeline', run)
    monkeypatch.setattr(harness, '_server_alive', server_alive)
    ans = asyncio.run(harness.ask({**HCTX, 'timeout': 0.05}, 'item'))

    assert 'no answer within' in ans.error


def test_requests_from_tasks_started_inside_the_call_are_seen():
    async def go():
        with upstream_trace.tracing() as trace:
            await asyncio.create_task(asyncio.to_thread(lambda: None))
            await asyncio.gather(asyncio.create_task(_note()))
        return trace.requests

    async def _note():
        upstream_trace.note_request(LOCAL, '{}')

    assert asyncio.run(go()) == [(LOCAL, '{}')]


def test_outside_tracing_nothing_is_noted():
    upstream_trace.note_request(LOCAL, '{}')
    upstream_trace.note_code_run(1.0)
    with upstream_trace.tracing() as trace:
        pass
    assert trace.requests == [] and trace.code_runs_ms == []


# ---------------------------------------------------------------------------
# the pipeline's four steps, run by hand
# ---------------------------------------------------------------------------
@pytest.fixture
def pipeline_steps(monkeypatch):
    from local_llm import main
    from local_llm.utils import chat, middleware

    calls = []
    offered = {'execute_code': {'spec': {'name': 'execute_code'}}, 'search_notes': {'spec': {'name': 'search_notes'}}}

    async def merge(form_data, model_info):
        calls.append('merge_params')
        return {}

    def stream_params(form_data, model_info_params, capabilities):
        return {'stream_delta_chunk_size': None}

    async def payload(request, form_data, user, metadata, model):
        calls.append(('payload', metadata['chat_id'][:10], bool(metadata['session_id']), metadata['features']))
        metadata['tools'] = dict(offered)
        form_data['tools'] = [{'type': 'function', 'function': t['spec']} for t in offered.values()]
        return form_data, metadata, []

    async def generate(request, form_data, user):
        calls.append(('generate', [t['function']['name'] for t in form_data['tools']], form_data['temperature']))
        return 'stream'

    async def context(request, form_data, user, model, metadata, tasks, events):
        calls.append(('context', sorted(metadata['tools'])))
        return {'event_emitter': 'socket', 'event_caller': 'socket'}

    async def respond(response, ctx):
        calls.append(('respond', ctx['event_emitter'] != 'socket', ctx['event_caller'] != 'socket'))
        await ctx['event_emitter']({'type': 'chat:message:error', 'data': {'error': {'content': 'upstream 500'}}})
        ctx['assistant_message'] = {'output': [_message('done')]}

    async def cleanup(*args):
        calls.append('cleanup')

    monkeypatch.setattr(main, '_merge_chat_params', merge)
    monkeypatch.setattr(main, '_chat_stream_params', stream_params)
    monkeypatch.setattr(main, '_disconnect_mcp_clients', cleanup)
    monkeypatch.setattr(main, '_end_chat_task', cleanup)
    monkeypatch.setattr(middleware, 'process_chat_payload', payload)
    monkeypatch.setattr(middleware, 'build_chat_response_context', context)
    monkeypatch.setattr(middleware, 'process_chat_response', respond)
    monkeypatch.setattr(chat, 'generate_chat_completion', generate)
    return calls, offered


def _hctx():
    request = SimpleNamespace(state=SimpleNamespace())
    return {**HCTX, 'request': request, 'user': SimpleNamespace(id='u1'), 'model': {'info': {}}, 'model_info': None}


def test_the_steps_run_in_order_with_only_execute_code_and_a_capturing_emitter(pipeline_steps):
    calls, _ = pipeline_steps
    errors: list[str] = []
    assistant = asyncio.run(harness._run_pipeline(_hctx(), 'item', errors))

    assert calls == [
        'merge_params',
        ('payload', 'temporary:', True, {'code_interpreter': True}),
        ('generate', ['execute_code'], 0),
        ('context', ['execute_code']),
        ('respond', True, True),
        'cleanup',
        'cleanup',
    ]
    assert errors == ['upstream 500']
    assert assistant == {'output': [_message('done')]}


def test_a_model_not_offered_execute_code_is_refused_and_cleaned_up(pipeline_steps):
    calls, offered = pipeline_steps
    del offered['execute_code']

    with pytest.raises(harness.HarnessRefused, match='execute_code'):
        asyncio.run(harness._run_pipeline(_hctx(), 'item', []))
    assert calls[-2:] == ['cleanup', 'cleanup']


# ---------------------------------------------------------------------------
# the runner: one harness sha per run, and what a harness row holds
# ---------------------------------------------------------------------------
def _spec(**over):
    return {**harness.spec_from_request(HCTX, BODY), **over}


def test_a_runs_sha_is_fixed_by_its_first_item_and_a_changed_spec_stops_it(monkeypatch):
    recorded = []

    async def record(sha, spec):
        recorded.append(sha)

    monkeypatch.setattr(runner.BenchmarkHarnesses, 'record', record)
    ctx = {'harness_spec': None, 'harness_sha': None}

    first = asyncio.run(runner._harness_sha(ctx, _spec()))
    assert asyncio.run(runner._harness_sha(ctx, _spec())) == first
    assert recorded == [first]
    with pytest.raises(harness.HarnessRefused, match='system_sha'):
        asyncio.run(runner._harness_sha(ctx, _spec(system_sha='other')))


def test_a_harness_row_holds_the_harness_and_no_llama_timings(monkeypatch):
    stored = {}

    async def ask(hctx, prompt):
        return harness.HarnessAnswer(
            content='answer',
            reasoning='hm',
            output=[_message('answer')],
            wall_ms=1234.5,
            spec=_spec(),
            stats={'rounds': 2, 'code_runs': 1, 'code_ms': 900, 'output_tokens': 40},
        )

    async def add_result(record, answer):
        stored.update(record=record, answer=answer)
        return 7

    async def record(sha, spec):
        pass

    monkeypatch.setattr(runner.harness, 'ask', ask)
    monkeypatch.setattr(runner, 'grade', lambda adapter, item, content: ('pass', ''))
    monkeypatch.setattr(runner, 'item_cluster', lambda adapter, item: None)
    monkeypatch.setattr(runner.BenchmarkResults, 'add_result', add_result)
    monkeypatch.setattr(runner.BenchmarkHarnesses, 'record', record)
    ctx = {
        'suite_run_id': 's1',
        'run_id': None,
        'model': 'qwen25c',
        'config_id': 'cfg',
        'profile': {'name': 'qwen25c'},
        'revisions': {'humaneval': 'r1'},
        'tier': 'smoke',
        'seed': 0,
        'harness': HCTX,
        'harness_spec': None,
        'harness_sha': None,
    }
    row = {'adapter': {'_sha': 'a1'}, 'item': {}, 'benchmark': 'humaneval', 'item_id': 'HumanEval/0'}
    asyncio.run(runner._run_harness_item(row, ctx, 'prompt'))

    rec = stored['record']
    assert rec['harness_sha'] == harness.spec_sha(_spec())
    assert rec['harness_stats']['rounds'] == 2
    assert rec['timings'] == {}
    assert rec['params'] == _spec()['params']
    assert (rec['system_name'], rec['system_sha']) == ('', '')
    assert rec['outcome'] == 'pass'
    assert stored['answer']['output'] == [_message('answer')]


def test_a_dead_server_raises_server_gone_and_records_nothing(monkeypatch):
    async def ask(hctx, prompt):
        return harness.HarnessAnswer(gone=True, error='no response from port 8090')

    async def add_result(record, answer):
        raise AssertionError('nothing may be recorded')

    monkeypatch.setattr(runner.harness, 'ask', ask)
    monkeypatch.setattr(runner.BenchmarkResults, 'add_result', add_result)
    with pytest.raises(runner.ServerGone):
        asyncio.run(runner._run_harness_item({'adapter': {}, 'item': {}}, {'harness': HCTX}, 'prompt'))


def test_a_harness_run_brings_no_system_prompt_of_its_own(monkeypatch):
    async def profile(name):
        return {'name': 'qwen25c'}

    async def served(session, port, prof):
        return 'qwen25c'

    async def no_run(port):
        return None

    monkeypatch.setattr(runner.env_profile, 'profile', profile)
    monkeypatch.setattr(runner.env_profile, 'port', lambda prof: PORT)
    monkeypatch.setattr(runner.env_profile, 'served_model', served)
    monkeypatch.setattr(runner.BenchmarkRuns, 'get_active_run', no_run)

    with pytest.raises(runner.SuiteLoadError, match='system prompt'):
        asyncio.run(
            runner.context(
                None,
                profile_name=None,
                tier='smoke',
                seed=0,
                benches=[],
                system_name='assistant',
                harness_entry='coder',
                source_request=object(),
                user=object(),
            )
        )


# ---------------------------------------------------------------------------
# the queries: Compare's bare rows, and a resume in the same mode
# ---------------------------------------------------------------------------
def _insert(rows):
    async def go():
        async with get_async_db_context() as db:
            for r in rows:
                db.add(BenchmarkResult(**r))
            await db.commit()

    asyncio.run(go())


def _row(suite_run_id, at, harness_sha=None):
    return dict(
        suite_run_id=suite_run_id,
        at=at,
        model=f'harness-test-{RUN}',
        benchmark='humaneval',
        item_id=f'{suite_run_id}/0',
        dataset_revision='r',
        tier='smoke',
        seed=0,
        outcome='pass',
        harness_sha=harness_sha,
    )


RUN = uuid.uuid4().hex[:8]


def test_bare_only_leaves_out_harness_rows_and_resume_stays_in_its_mode():
    now = int(time.time())
    _insert([_row(f'bare-{RUN}', now), _row(f'app-{RUN}', now + 1, harness_sha='abc123')])
    model = f'harness-test-{RUN}'

    everything = asyncio.run(BenchmarkResults.list_results(model=model))
    bare = asyncio.run(BenchmarkResults.list_results(model=model, bare_only=True))
    assert {r.suite_run_id for r in everything} == {f'bare-{RUN}', f'app-{RUN}'}
    assert [r.suite_run_id for r in bare] == [f'bare-{RUN}']

    # The harness run is newer; a bare resume must still pick the bare run.
    assert asyncio.run(BenchmarkResults.latest_suite_run(model=model, tier='smoke')) == f'bare-{RUN}'
    assert asyncio.run(BenchmarkResults.latest_suite_run(model=model, tier='smoke', harness=True)) == f'app-{RUN}'


# ---------------------------------------------------------------------------
# resume, the runner's harness paths, the router
# ---------------------------------------------------------------------------
def test_a_resume_continues_under_the_recorded_spec_and_stops_on_a_changed_one(monkeypatch):
    spec = _spec()

    async def sha_of(suite_run_id):
        return 'sha-A'

    async def get(sha):
        return dict(spec) if sha == 'sha-A' else None

    monkeypatch.setattr(runner.BenchmarkResults, 'harness_sha_of', sha_of)
    monkeypatch.setattr(runner.BenchmarkHarnesses, 'get', get)
    ctx = {'harness_spec': None, 'harness_sha': None}
    asyncio.run(runner._resume_harness(ctx, 'run-A'))

    assert (ctx['harness_spec'], ctx['harness_sha']) == (spec, 'sha-A')
    assert asyncio.run(runner._harness_sha(ctx, _spec())) == 'sha-A'
    with pytest.raises(harness.HarnessRefused, match='system_sha'):
        asyncio.run(runner._harness_sha(ctx, _spec(system_sha='edited')))


def test_a_resume_of_a_run_with_no_recorded_harness_is_refused(monkeypatch):
    async def sha_of(suite_run_id):
        return None

    monkeypatch.setattr(runner.BenchmarkResults, 'harness_sha_of', sha_of)
    with pytest.raises(harness.HarnessRefused, match='no recorded harness'):
        asyncio.run(runner._resume_harness({}, 'run-A'))


def test_a_harness_sha_and_its_spec_are_read_back_from_the_database():
    from local_llm.models.benchmarks.tests import BenchmarkHarness, BenchmarkHarnesses

    sha = f'h{RUN}'
    _insert([_row(f'resume-{RUN}', int(time.time()), harness_sha=sha)])

    async def store():
        async with get_async_db_context() as db:
            db.add(BenchmarkHarness(harness_sha=sha, spec=_spec(), recorded_at=0))
            await db.commit()

    asyncio.run(store())
    assert asyncio.run(BenchmarkResults.harness_sha_of(f'resume-{RUN}')) == sha
    assert asyncio.run(BenchmarkResults.harness_sha_of(f'bare-none-{RUN}')) is None
    assert asyncio.run(BenchmarkHarnesses.get(sha)) == _spec()
    assert asyncio.run(BenchmarkHarnesses.get('missing')) is None


def _harness_ctx():
    return {
        'suite_run_id': 's1',
        'run_id': None,
        'model': 'qwen25c',
        'config_id': 'cfg',
        'profile': {'name': 'qwen25c'},
        'revisions': {},
        'tier': 'smoke',
        'seed': 0,
        'harness': HCTX,
        'harness_spec': None,
        'harness_sha': None,
    }


def test_run_items_sends_a_harness_run_through_the_pipeline_not_llama_server(monkeypatch):
    asked = []

    async def bare_ask(*args, **kwargs):
        raise AssertionError('a harness item must not go straight to llama-server')

    async def harness_ask(hctx, prompt):
        asked.append(prompt)
        return harness.HarnessAnswer(content='ok', spec=_spec(), stats={'rounds': 1})

    async def add_result(record, answer):
        return 1

    async def record(sha, spec):
        pass

    monkeypatch.setattr(runner, 'ask', bare_ask)
    monkeypatch.setattr(runner.harness, 'ask', harness_ask)
    monkeypatch.setattr(runner, 'render_prompt', lambda adapter, item: 'the item')
    monkeypatch.setattr(runner, 'grade', lambda adapter, item, content: ('pass', ''))
    monkeypatch.setattr(runner, 'item_cluster', lambda adapter, item: None)
    monkeypatch.setattr(runner.BenchmarkResults, 'add_result', add_result)
    monkeypatch.setattr(runner.BenchmarkHarnesses, 'record', record)
    rows = [{'adapter': {}, 'item': {}, 'benchmark': 'humaneval', 'item_id': f'HumanEval/{i}'} for i in range(2)]
    results = asyncio.run(runner.run_items(None, rows, _harness_ctx()))

    assert asked == ['the item', 'the item']
    assert {r['harness_sha'] for r in results} == {harness.spec_sha(_spec())}


def test_run_one_answers_through_the_pipeline_and_returns_the_harness(monkeypatch):
    async def context(session, **kwargs):
        assert kwargs['harness_entry'] == 'coder'
        return _harness_ctx()

    async def harness_ask(hctx, prompt):
        return harness.HarnessAnswer(content='ok', output=[_message('ok')], spec=_spec(), stats={'rounds': 1})

    monkeypatch.setattr(runner, 'context', context)
    monkeypatch.setattr(runner, '_find_item', lambda benchmark, item: ({}, {}, ''))
    monkeypatch.setattr(runner, 'render_prompt', lambda adapter, item: 'the item')
    monkeypatch.setattr(runner.harness, 'ask', harness_ask)
    monkeypatch.setattr(runner, 'grade', lambda adapter, item, content: ('pass', ''))
    result = asyncio.run(runner.run_one(None, benchmark='humaneval', item='HumanEval/0', harness_entry='coder'))

    assert result['outcome'] == 'pass'
    assert result['harness'] == _spec() and result['output'] == [_message('ok')]


def test_the_tests_router_reports_a_refusal_as_not_recorded(monkeypatch):
    from local_llm.routers.benchmarks import tests as tests_router

    async def refuse(session, **kwargs):
        raise harness.HarnessRefused("'coder' is served by https://openrouter.ai/api/v1")

    monkeypatch.setattr(tests_router.runner, 'prepare_suite', refuse)
    queue: asyncio.Queue = asyncio.Queue()
    form = tests_router.TestsRunForm(suite='smoke', harness_model='coder')
    asyncio.run(tests_router._run_suite(form, queue, request=object(), user=object()))

    message = queue.get_nowait()
    assert message['type'] == 'error' and message['message'].startswith('not recorded: ')


# ---------------------------------------------------------------------------
# code-run images stay out of the owner's Files during a benchmark
# ---------------------------------------------------------------------------
@pytest.mark.parametrize('benchmark', [True, False])
def test_a_benchmark_keeps_code_run_images_inline(monkeypatch, benchmark):
    from local_llm.models.users import Users
    from local_llm.tools import builtin
    from local_llm.utils import code_interpreter, files

    uploaded = []

    async def config_get(key, default=None):
        return {'code_interpreter.engine': 'jupyter', 'code_interpreter.jupyter.auth': 'token'}.get(key, default)

    async def run_code(*args, **kwargs):
        return {'stdout': 'data:image/png;base64,AAAA', 'stderr': '', 'result': ''}

    async def user_by_id(user_id):
        return SimpleNamespace(id=user_id)

    async def upload(request, line, metadata, user):
        uploaded.append(line)
        return '/files/plot'

    monkeypatch.setattr(builtin.Config, 'get', config_get)
    monkeypatch.setattr(code_interpreter, 'execute_code_jupyter', run_code)
    monkeypatch.setattr(Users, 'get_user_by_id', user_by_id)
    monkeypatch.setattr(files, 'get_image_url_from_base64', upload)
    request = SimpleNamespace(state=SimpleNamespace(benchmark_harness=benchmark))
    out = json.loads(asyncio.run(builtin.execute_code('plot()', __request__=request, __user__={'id': 'u1'})))

    assert uploaded == ([] if benchmark else ['data:image/png;base64,AAAA'])
    assert ('data:image/png;base64' in out['stdout']) is benchmark
