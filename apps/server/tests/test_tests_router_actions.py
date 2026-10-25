"""The Tests page's dataset actions: fetch, selfcheck and one item (#141).

Against the real router and grader, a temporary datasets directory, and a
test-only adapter directory whose two fetched benchmarks use a fake fetcher in
place of the network. Selfcheck grades the fake items' reference solutions for
real. The shipped benchmarks are vendored, which the last tests check through
the same routes.

Run from apps/server:

    python -m pytest tests/test_tests_router_actions.py
"""

from __future__ import annotations

import json
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.benchmarks.evaluation import adapters, datasets, grading, runner
from local_llm.benchmarks.evaluation.datasets import DatasetError
from local_llm.routers.benchmarks import tests as tests_router
from local_llm.routers.benchmarks import tune as tune_router
from local_llm.utils.auth import get_admin_user

ADMIN = SimpleNamespace(id='admin-1', email='admin@example.com', role='admin')

# Shaped like DS-1000's rows, whose tests are separate from the reference:
# item 2's reference fails its own test, so a correct answer to it still passes.
SAMPLE_ROWS = [
    {
        'metadata': {'problem_id': 1},
        'prompt': 'Add a and b.',
        'reference_code': 'result = a + b',
        'code_context': (
            'def test_execution(solution):\n'
            '    env = {"a": 1, "b": 2}\n'
            '    exec(solution, env)\n'
            '    assert env["result"] == 3\n'
        ),
    },
    {
        'metadata': {'problem_id': 2},
        'prompt': 'Negate a.',
        'reference_code': 'result = a',  # a reference that fails its own test
        'code_context': (
            'def test_execution(solution):\n'
            '    env = {"a": 1}\n'
            '    exec(solution, env)\n'
            '    assert env["result"] == -1\n'
        ),
    },
]

# Two fetched benchmarks, `sample` and `other`, which only these tests know.
TEST_ADAPTER = """
id = "{id}"
name = "{id}"
prompt_template = "{{prompt}}"

[fetch]
kind = "test"

[item]
id_field = "metadata.problem_id"
prompt_field = "prompt"

[check]
harness = "ds1000"
timeout = 20
isolated = false
"""


def fake_fetcher(rows=SAMPLE_ROWS, revision='rev1'):
    def fetch(spec):
        raw = json.dumps(rows).encode()
        return rows, revision, 'https://example.test/sample.json', raw

    return fetch


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    base = tmp_path / 'datasets'
    base.mkdir()
    adapter_dir = tmp_path / 'adapters'
    adapter_dir.mkdir()
    for name in ('sample', 'other'):
        (adapter_dir / f'{name}.toml').write_text(TEST_ADAPTER.format(id=name))
    monkeypatch.setattr(adapters, 'ADAPTERS_DIR', adapter_dir)
    monkeypatch.setenv('BENCHMARKS_DATA_DIR', str(base))
    monkeypatch.setitem(datasets.FETCHERS, 'test', fake_fetcher())
    # A fixed environment, so calibration_stale does not start the grader.
    monkeypatch.setattr(grading, 'env_fingerprint', lambda: {'python': 'test'})
    monkeypatch.setattr(tests_router, '_task', None)
    monkeypatch.setattr(tests_router, '_queue', None)
    monkeypatch.setattr(tests_router, '_cancel', False)
    return base


def _client(admin=True) -> TestClient:
    app = FastAPI()
    app.include_router(tests_router.router, prefix='/tests')
    if admin:
        app.dependency_overrides[get_admin_user] = lambda: ADMIN
    return TestClient(app)


def _events(client: TestClient) -> list[dict]:
    with client.stream('GET', '/tests/stream') as res:
        assert res.status_code == 200
        return [json.loads(line[6:]) for line in res.iter_lines() if line.startswith('data: ')]


# --- admin only -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    'method, path, body',
    [
        ('get', '/tests/datasets', None),
        ('post', '/tests/fetch', {}),
        ('post', '/tests/selfcheck', {}),
        ('post', '/tests/item', {'benchmark': 'sample', 'item_id': '1'}),
    ],
)
def test_the_actions_are_admin_only(data_dir, method, path, body):
    with _client(admin=False) as client:
        res = client.request(method.upper(), path, json=body)
    assert res.status_code in (401, 403)
    assert list(data_dir.iterdir()) == []


# --- fetch ----------------------------------------------------------------------------------


def test_fetch_downloads_and_reports_each_dataset(data_dir):
    with _client() as client:
        assert client.post('/tests/fetch', json={'benchmarks': ['sample']}).json() == {'started': True}
        events = _events(client)
        status = {row['benchmark']: row for row in client.get('/tests/datasets').json()}
    assert [e['type'] for e in events] == ['progress', 'dataset', 'done']
    assert events[1] == {
        'type': 'dataset',
        'benchmark': 'sample',
        'n_items': 2,
        'revision': 'rev1',
        'fetched': True,
        'vendored': False,
    }
    assert status['sample']['fetched'] and status['sample']['n_items'] == 2
    assert status['sample']['calibration_stale'] == 'not calibrated yet'
    assert not status['other']['fetched']


def test_fetch_keeps_a_dataset_unless_forced(data_dir, monkeypatch):
    with _client() as client:
        client.post('/tests/fetch', json={'benchmarks': ['sample']})
        _events(client)
        monkeypatch.setitem(datasets.FETCHERS, 'test', fake_fetcher(revision='rev2'))
        client.post('/tests/fetch', json={'benchmarks': ['sample']})
        kept = _events(client)[1]
        client.post('/tests/fetch', json={'benchmarks': ['sample'], 'force': True})
        forced = _events(client)[1]
    assert (kept['revision'], kept['fetched']) == ('rev1', False)
    assert (forced['revision'], forced['fetched']) == ('rev2', True)


def test_a_failed_fetch_is_an_error_event_and_the_server_carries_on(data_dir, monkeypatch):
    def broken(spec):
        raise DatasetError('sample returned no rows')

    monkeypatch.setitem(datasets.FETCHERS, 'test', broken)
    with _client() as client:
        client.post('/tests/fetch', json={'benchmarks': ['sample']})
        events = _events(client)
        assert client.get('/tests/datasets').status_code == 200
    assert events[-1] == {'type': 'error', 'message': 'sample returned no rows'}


def test_a_refetch_that_fails_partway_leaves_the_old_dataset_whole(data_dir, monkeypatch):
    adapter = datasets_adapter('sample')
    datasets.fetch_one(adapter)
    (data_dir / 'sample' / 'CALIBRATION.json').write_text('{}')
    before = {p.name: p.read_bytes() for p in (data_dir / 'sample').iterdir()}

    monkeypatch.setitem(datasets.FETCHERS, 'test', fake_fetcher(rows=SAMPLE_ROWS[:1], revision='rev2'))

    def fail(*_a):
        raise OSError('disk full')

    # After the new items are written, before the manifest is.
    monkeypatch.setattr(datasets.time, 'strftime', fail)
    with pytest.raises(OSError):
        datasets.fetch_one(adapter, force=True)
    assert {p.name: p.read_bytes() for p in (data_dir / 'sample').iterdir()} == before


def datasets_adapter(name: str) -> dict:
    return adapters.load_adapters()[name]


# --- names are adapter ids, nothing else ------------------------------------------------------


@pytest.mark.parametrize('names', [['../x'], ['nope'], ['sample', '../../etc'], []])
def test_unknown_benchmark_names_are_refused_before_anything_runs(data_dir, names):
    with _client() as client:
        assert client.post('/tests/fetch', json={'benchmarks': names}).status_code == 404
        assert client.post('/tests/selfcheck', json={'benchmarks': names}).status_code == 404
        if names:
            item = {'benchmark': names[-1], 'item_id': '1'}
            assert client.post('/tests/item', json=item).status_code == 404
    assert list(data_dir.iterdir()) == []
    assert tests_router._task is None


# --- selfcheck ------------------------------------------------------------------------------


def test_selfcheck_grades_the_references_and_writes_the_calibration(data_dir):
    with _client() as client:
        client.post('/tests/fetch', json={'benchmarks': ['sample']})
        _events(client)
        client.post('/tests/selfcheck', json={'benchmarks': ['sample']})
        events = _events(client)
        status = {row['benchmark']: row for row in client.get('/tests/datasets').json()}
    refs = [e for e in events if e['type'] == 'reference']
    assert [(e['item_id'], e['outcome']) for e in refs] == [('1', 'pass'), ('2', 'fail_assert')]
    assert refs[-1]['i'] == refs[-1]['total'] == 2 and refs[-1]['passed'] == 1
    assert events[-2] == {'type': 'calibrated', 'benchmark': 'sample', 'n_checked': 2, 'n_ungradeable': 1}
    assert events[-1] == {'type': 'done', 'cancelled': False}
    assert status['sample']['n_ungradeable'] == 1 and status['sample']['calibration_stale'] == ''
    assert list(grading.ungradeable('sample')) == ['2']


def test_a_cancelled_selfcheck_writes_no_calibration(data_dir, monkeypatch):
    real_grade = grading.grade

    def slow_grade(*a):
        time.sleep(0.4)
        return real_grade(*a)

    monkeypatch.setattr(grading, 'grade', slow_grade)
    with _client() as client:
        client.post('/tests/fetch', json={'benchmarks': ['sample']})
        _events(client)
        client.post('/tests/selfcheck', json={'benchmarks': ['sample']})
        assert client.post('/tests/cancel').status_code == 200
        events = _events(client)
    assert events[-1] == {'type': 'done', 'cancelled': True}
    assert not (data_dir / 'sample' / 'CALIBRATION.json').exists()


def test_selfcheck_of_a_dataset_not_fetched_is_an_error(data_dir):
    with _client() as client:
        client.post('/tests/selfcheck', json={'benchmarks': ['sample']})
        events = _events(client)
    assert events[-1]['type'] == 'error'
    assert 'not downloaded yet' in events[-1]['message'] and 'Tests page' in events[-1]['message']


# --- one item -------------------------------------------------------------------------------


def test_one_item_streams_its_result(data_dir, monkeypatch):
    async def run_one(session, **kwargs):
        return {'benchmark': kwargs['benchmark'], 'item_id': kwargs['item'], 'outcome': 'pass', 'content': 'x'}

    monkeypatch.setattr(runner, 'run_one', run_one)
    with _client() as client:
        assert client.post('/tests/item', json={'benchmark': 'sample', 'item_id': '1'}).status_code == 200
        events = _events(client)
    assert events[0] == {'type': 'result', 'benchmark': 'sample', 'item_id': '1', 'outcome': 'pass', 'content': 'x'}
    assert events[-1] == {'type': 'done', 'cancelled': False}


def test_one_item_of_a_missing_id_is_an_error(data_dir):
    with _client() as client:
        client.post('/tests/fetch', json={'benchmarks': ['sample']})
        _events(client)
        client.post('/tests/item', json={'benchmark': 'sample', 'item_id': '999'})
        events = _events(client)
    assert events[-1] == {'type': 'error', 'message': "sample has no item '999'"}


def test_run_one_grades_without_recording_and_says_why_a_suite_would_skip_it(data_dir, monkeypatch):
    datasets.fetch_one(datasets_adapter('sample'))
    grading.write_calibration('sample', grading.calibrate('sample', datasets_adapter('sample'), SAMPLE_ROWS))

    async def context(session, **kwargs):
        return {'model': 'm', 'profile': {}, 'port': 0, 'stream': False, 'system': None}

    async def ask(*_a, **_k):
        ans = runner.Answer()
        ans.content = '```python\nresult = -a\n```'
        return ans

    async def add_result(*_a):
        raise AssertionError('a one-item run must not be recorded')

    monkeypatch.setattr(runner, 'context', context)
    monkeypatch.setattr(runner, 'ask', ask)
    monkeypatch.setattr(runner.BenchmarkResults, 'add_result', add_result)
    import asyncio

    result = asyncio.run(runner.run_one(None, benchmark='sample', item='2'))
    assert result['outcome'] == 'pass'
    assert result['excluded'].startswith('fail_assert')  # its own reference fails here
    assert asyncio.run(runner.run_one(None, benchmark='sample', item='1'))['excluded'] == ''


# --- one job at a time, and never during a sweep -----------------------------------------------


def test_a_second_job_or_a_running_sweep_is_refused(data_dir, monkeypatch):
    monkeypatch.setattr(tests_router, 'active', lambda: True)
    with _client() as client:
        assert client.post('/tests/fetch', json={}).status_code == 409
    monkeypatch.setattr(tests_router, 'active', lambda: False)
    monkeypatch.setattr(tune_router, 'running', lambda: True)
    with _client() as client:
        assert client.post('/tests/selfcheck', json={}).status_code == 409
        assert client.post('/tests/run', json={'suite': 'smoke'}).status_code == 409
