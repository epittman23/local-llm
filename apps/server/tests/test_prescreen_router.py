"""routers/benchmarks/prescreen.py: its routes, the GPU guard both ways, the dashboard, shutdown.

Database-free: the tables and the active-run check are stubbed, and a
pre-screen's own work is replaced where a test only needs the router's
answer. A minimal FastAPI app mounts the routers with get_admin_user
overridden. The dashboard's lifecycle runs real processes, a stand-in whose
command line names the dashboard module, so nothing here needs Postgres
(the real dashboard against a real database is in
test_prescreen_optuna_schema.py).

Run from apps/server:

    python -m pytest tests/test_prescreen_router.py
"""

from __future__ import annotations

import asyncio
import os
import signal
import socket
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from prescreen_stubs import Points, Sweeps

from local_llm.benchmarks.prescreen import PrescreenRefused
from local_llm.benchmarks.prescreen import dashboard as prescreen_dashboard
from local_llm.models.benchmarks.configs import BenchmarkRuns
from local_llm.routers import benchmarks
from local_llm.routers.benchmarks import prescreen as prescreen_router
from local_llm.routers.benchmarks import serve as serve_router
from local_llm.routers.benchmarks import tests as tests_router
from local_llm.routers.benchmarks import tune as tune_router
from local_llm.utils.auth import get_admin_user

ADMIN = SimpleNamespace(id='admin-1', email='admin@example.com')


class _RunningJob:
    running = True


@pytest.fixture(autouse=True)
def _idle(monkeypatch, tmp_path):
    monkeypatch.setattr(serve_router, '_job', None)
    monkeypatch.setattr(tests_router, '_task', None)
    monkeypatch.setattr(tune_router, '_task', None)
    monkeypatch.setattr(prescreen_router, '_task', None)
    monkeypatch.setattr(prescreen_router, '_sweep', None)
    monkeypatch.setattr(prescreen_router, '_dashboard', prescreen_dashboard.DashboardProcess(tmp_path / 'dash.pid'))

    async def no_active_run(db=None):
        return None

    monkeypatch.setattr(BenchmarkRuns, 'get_any_active_run', no_active_run)


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(benchmarks.router, prefix='/api/v1/benchmarks')
    app.dependency_overrides[get_admin_user] = lambda: ADMIN
    with TestClient(app) as c:
        yield c


def _start(client, **form):
    return client.post('/api/v1/benchmarks/prescreen/start', json={'profile': 'qwen38', **form})


# ---------------------------------------------------------------------------
# one GPU: the pre-screen against everything else, both ways
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ('setup', 'message'),
    [
        (lambda mp: mp.setattr(serve_router, '_job', _RunningJob()), 'served from the Serve page'),
        (lambda mp: mp.setattr(tune_router, 'running', lambda: True), 'a tune sweep is running'),
        (lambda mp: mp.setattr(tests_router, 'active', lambda: True), 'a test job is running'),
    ],
)
def test_start_refuses_while_the_gpu_is_in_use(client, monkeypatch, setup, message):
    setup(monkeypatch)
    response = _start(client)
    assert response.status_code == 409
    assert message in response.json()['detail']


def test_start_refuses_while_another_process_records_a_run(client, monkeypatch):
    async def active(db=None):
        return SimpleNamespace(run_id=1)

    monkeypatch.setattr(BenchmarkRuns, 'get_any_active_run', active)
    assert _start(client).status_code == 409


def test_serve_refuses_while_a_pre_screen_runs(client, monkeypatch):
    monkeypatch.setattr(prescreen_router, 'running', lambda: True)
    response = client.post('/api/v1/benchmarks/serve/start', json={'profile': 'qwen38'})
    assert response.status_code == 409
    assert 'a pre-screen is running' in response.json()['detail']


def test_tests_refuse_while_a_pre_screen_runs(client, monkeypatch):
    monkeypatch.setattr(prescreen_router, 'running', lambda: True)
    response = client.post('/api/v1/benchmarks/tests/fetch', json={})
    assert response.status_code == 409
    assert 'a pre-screen is running' in response.json()['detail']


@pytest.mark.parametrize('route', ['/api/v1/benchmarks/tune/start', '/api/v1/benchmarks/tune/resume'])
def test_tune_refuses_while_a_pre_screen_runs(client, monkeypatch, route):
    monkeypatch.setattr(prescreen_router, 'running', lambda: True)
    response = client.post(route, json={} if route.endswith('start') else None)
    assert response.status_code == 409
    assert 'a pre-screen is running' in response.json()['detail']


# ---------------------------------------------------------------------------
# start, cancel, read
# ---------------------------------------------------------------------------
def test_a_refusal_comes_back_as_a_400_with_the_reason(client, monkeypatch):
    async def refuse(self):
        raise PrescreenRefused('model not found: /m/x.gguf')

    monkeypatch.setattr(prescreen_router.Prescreen, 'prepare', refuse)
    response = _start(client)
    assert response.status_code == 400
    assert response.json()['detail'] == 'model not found: /m/x.gguf'
    assert not prescreen_router.running()


def test_start_runs_the_sweep_in_the_background_and_cancel_stops_it(client, monkeypatch):
    seen = {}

    async def prepare(self):
        seen['database_url'] = self.database_url
        self.sweep_id = 'sweep-1'
        return self.sweep_id

    async def run(self):
        await self.cancel.wait()
        seen['cancelled'] = True
        return 'cancelled'

    monkeypatch.setattr(prescreen_router.Prescreen, 'prepare', prepare)
    monkeypatch.setattr(prescreen_router.Prescreen, 'run', run)
    response = _start(client, sampler='tpe', trials=5)
    assert response.json() == {'started': True, 'sweep_id': 'sweep-1'}
    assert seen['database_url'] == prescreen_router.DATABASE_URL
    assert prescreen_router.running()
    assert _start(client).status_code == 409  # one at a time
    assert client.post('/api/v1/benchmarks/prescreen/cancel').json() == {'cancelling': True}
    deadline = time.monotonic() + 5
    while prescreen_router.running() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert seen.get('cancelled')


def test_start_forbids_unknown_fields(client):
    assert _start(client, budget='overnight').status_code == 422


def test_cancel_with_nothing_running_is_a_404(client):
    assert client.post('/api/v1/benchmarks/prescreen/cancel').status_code == 404


def test_grids_lists_every_shipped_grid(client):
    grids = {g['name']: g for g in client.get('/api/v1/benchmarks/prescreen/grids').json()['grids']}
    assert {'qwen25c', 'qwen36', 'qwen38', 'qwen3c'} <= set(grids)
    assert grids['qwen38']['profile'] == 'qwen38'
    assert grids['qwen38']['knobs']['LLAMA_NGL'] == [16, 18, 20, 22, 24]
    assert grids['qwen38']['combinations'] == 40


def test_sweeps_and_a_sweeps_detail(client, monkeypatch):
    sweeps, points = Sweeps(), Points()
    monkeypatch.setattr(prescreen_router, 'BenchmarkPrescreenSweeps', sweeps)
    monkeypatch.setattr(prescreen_router, 'BenchmarkPrescreenPoints', points)
    fields = {
        'profile': 'qwen38',
        'sampler': 'grid',
        'seed': 0,
        'objective': 'tg',
        'study_name': 'prescreen-s',
        'grid_path': 'data/prescreen/qwen38.toml',
        'grid_sha': 'abc',
        'n_prompt': 512,
        'n_gen': 128,
        'reps': 5,
        'point_timeout': 900,
        'ctx_checks': 3,
        'model_file': 'm.gguf',
    }
    asyncio.run(sweeps.open_sweep('s', **fields))
    base = {'LLAMA_NGL': '20'}
    asyncio.run(
        points.open_point(
            's', phase='search', overrides=base, is_baseline=True, status='ok', pp_avg_ts=100.0, tg_avg_ts=5.0
        )
    )
    asyncio.run(
        points.open_point(
            's', phase='search', overrides={'LLAMA_NGL': '22'}, status='ok', pp_avg_ts=110.0, tg_avg_ts=6.0
        )
    )
    asyncio.run(points.open_point('s', phase='search', overrides={'LLAMA_NGL': '24'}, status='oom'))

    listed = client.get('/api/v1/benchmarks/prescreen/sweeps').json()
    assert [s['sweep_id'] for s in listed['sweeps']] == ['s']
    assert listed['running'] is False

    detail = client.get('/api/v1/benchmarks/prescreen/sweeps/s').json()
    assert len(detail['points']) == 3
    assert [c['point_id'] for c in detail['candidates']] == [2, 1]
    assert detail['candidates'][0]['changes'] == {'ngl': '22'}
    assert detail['candidates'][1]['changes'] == {}
    assert client.get('/api/v1/benchmarks/prescreen/sweeps/nope').status_code == 404


# ---------------------------------------------------------------------------
# the dashboard
# ---------------------------------------------------------------------------
def test_the_dashboard_binds_loopback_only(monkeypatch):
    seen = {}

    def run_server(storage, host, port):
        seen.update(storage=storage, host=host, port=port)

    import optuna_dashboard

    from local_llm.benchmarks.prescreen import study

    monkeypatch.setattr(optuna_dashboard, 'run_server', run_server)
    monkeypatch.setattr(study, 'open_storage', lambda: 'the-storage')
    assert prescreen_dashboard.main(['--port', '9123']) == 0
    assert seen == {'storage': 'the-storage', 'host': '127.0.0.1', 'port': 9123}


def _stand_in(pidfile):
    """A process whose command line names the dashboard module, as the real one's does."""
    proc = subprocess.Popen(
        [sys.executable, '-c', 'import time; time.sleep(60)', prescreen_dashboard.MODULE], start_new_session=True
    )
    pidfile.write_text(f'{proc.pid}\n')
    return proc


def test_a_dashboard_an_earlier_backend_started_is_found_and_stopped(tmp_path):
    proc = _stand_in(tmp_path / 'dash.pid')
    try:
        handle = prescreen_dashboard.DashboardProcess(tmp_path / 'dash.pid')
        assert handle.running()
        assert asyncio.run(handle.stop(grace=2)) is True
        assert proc.wait(timeout=5) is not None
        assert not handle.running()
        assert not (tmp_path / 'dash.pid').exists()
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)


def test_a_stale_pid_file_naming_another_process_is_ignored(tmp_path):
    bystander = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session=True)
    try:
        (tmp_path / 'dash.pid').write_text(f'{bystander.pid}\n')
        handle = prescreen_dashboard.DashboardProcess(tmp_path / 'dash.pid')
        assert not handle.running()
        assert asyncio.run(handle.stop()) is False
        assert bystander.poll() is None
    finally:
        bystander.kill()


def test_the_dashboard_refuses_without_a_database_or_with_its_port_taken(tmp_path):
    handle = prescreen_dashboard.DashboardProcess(tmp_path / 'dash.pid', port=_listening_port())
    with pytest.raises(RuntimeError, match='DATABASE_URL'):
        asyncio.run(handle.start({}))
    with pytest.raises(RuntimeError, match='already in use'):
        asyncio.run(handle.start({'DATABASE_URL': 'postgresql://u:p@127.0.0.1/db'}))


_listeners: list[socket.socket] = []


def _listening_port() -> int:
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    s.listen()
    _listeners.append(s)
    return s.getsockname()[1]


def test_dashboard_routes(client, tmp_path, monkeypatch):
    assert client.get('/api/v1/benchmarks/prescreen/dashboard').json()['running'] is False
    assert client.post('/api/v1/benchmarks/prescreen/dashboard/stop').status_code == 404
    started = {}

    async def start(env):
        started['env'] = env

    monkeypatch.setattr(prescreen_router._dashboard, 'start', start)
    state = client.post('/api/v1/benchmarks/prescreen/dashboard/start').json()
    assert state['url'] == 'http://127.0.0.1:8091/dashboard'
    assert started['env']['DATABASE_URL'] == prescreen_router.DATABASE_URL


# ---------------------------------------------------------------------------
# shutdown
# ---------------------------------------------------------------------------
def test_every_shutdown_stops_a_running_pre_screen(monkeypatch):
    async def scenario():
        sweep = SimpleNamespace(cancel=asyncio.Event())

        async def run():
            await sweep.cancel.wait()

        monkeypatch.setattr(prescreen_router, '_sweep', sweep)
        monkeypatch.setattr(prescreen_router, '_task', asyncio.create_task(run()))
        await asyncio.sleep(0)
        await benchmarks.stop_prescreen()
        return sweep.cancel.is_set(), prescreen_router.running()

    assert asyncio.run(scenario()) == (True, False)


def test_the_flagged_shutdown_also_stops_the_dashboard(monkeypatch, tmp_path, caplog):
    import logging

    caplog.set_level(logging.INFO)
    proc = _stand_in(tmp_path / 'dash.pid')
    try:
        asyncio.run(benchmarks.shutdown())
        assert proc.wait(timeout=10) is not None
        markers = [r.getMessage() for r in caplog.records if r.getMessage().startswith('==> ')]
        assert markers == ['==> Stopping benchmark jobs', '==> Stopped benchmark jobs']
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)


def test_an_unflagged_shutdown_leaves_the_dashboard_running(tmp_path):
    proc = _stand_in(tmp_path / 'dash.pid')
    try:
        asyncio.run(benchmarks.stop_prescreen())
        time.sleep(0.3)
        assert proc.poll() is None
    finally:
        os.killpg(proc.pid, signal.SIGKILL)


def test_the_stream_sends_the_detail_until_the_sweep_ends(client, monkeypatch):
    sweeps, points = Sweeps(), Points()
    monkeypatch.setattr(prescreen_router, 'BenchmarkPrescreenSweeps', sweeps)
    monkeypatch.setattr(prescreen_router, 'BenchmarkPrescreenPoints', points)
    fields = {
        'profile': 'qwen38',
        'sampler': 'grid',
        'seed': 0,
        'objective': 'tg',
        'study_name': 'prescreen-s',
        'grid_path': 'data/prescreen/qwen38.toml',
        'grid_sha': 'abc',
        'n_prompt': 512,
        'n_gen': 128,
        'reps': 5,
        'point_timeout': 900,
        'ctx_checks': 3,
        'model_file': 'm.gguf',
    }
    asyncio.run(sweeps.open_sweep('s', **fields))
    assert client.get('/api/v1/benchmarks/prescreen/stream', params={'sweep_id': 'nope'}).status_code == 404

    # Running in the table, but no task in this backend: one event, then done.
    with client.stream('GET', '/api/v1/benchmarks/prescreen/stream', params={'sweep_id': 's'}) as response:
        body = ''.join(response.iter_text())
    events = [line for line in body.splitlines() if line.startswith('data: ')]
    assert len(events) == 2
    assert '"sweep_id": "s"' in events[0]
    assert 'event: done' in body
