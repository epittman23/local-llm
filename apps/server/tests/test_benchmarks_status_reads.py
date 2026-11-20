"""The light status reads the Benchmarks section's chip polls on every page.

`GET /live/status` names the recorded run without reading its samples, and
`GET /tune/recent` says whether this backend's sweep task is alive, so a
sweep row a dead backend left without a verdict is not shown as running
forever. Database and sweep task are monkeypatched: nothing here touches a
real database, llama-server or the GPU.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.models.benchmarks.configs import BenchmarkRuns
from local_llm.models.benchmarks.telemetry import BenchmarkGpuSamples
from local_llm.routers.benchmarks import live as live_router
from local_llm.routers.benchmarks import tune as tune_router
from local_llm.utils.auth import get_admin_user

ADMIN = SimpleNamespace(id='admin-1', email='admin@example.com')


def _client(router) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_admin_user] = lambda: ADMIN
    return TestClient(app)


def test_live_status_names_the_run_and_reads_no_samples(monkeypatch):
    run = SimpleNamespace(run_id='run-1', model='qwen38', config_id='c98ef02c0123', pid=4242)

    async def active(db=None):
        return run

    async def no_samples(*args, **kwargs):
        raise AssertionError('the status read must not load samples')

    monkeypatch.setattr(BenchmarkRuns, 'get_any_active_run', active)
    monkeypatch.setattr(BenchmarkGpuSamples, 'list_samples', no_samples)

    body = _client(live_router.router).get('/status').json()

    assert body == {'run': {'run_id': 'run-1', 'model': 'qwen38', 'config_id': 'c98ef02c0123'}}


def test_live_status_is_empty_when_nothing_is_recorded(monkeypatch):
    async def none(db=None):
        return None

    monkeypatch.setattr(BenchmarkRuns, 'get_any_active_run', none)
    assert _client(live_router.router).get('/status').json() == {'run': None}


def test_recent_sweeps_say_no_sweep_is_running_without_a_live_task(monkeypatch):
    async def recent(limit=20):
        return [{'sweep_id': 's-dead', 'verdict': 'running'}]

    monkeypatch.setattr(tune_router.tune, 'list_recent_sweeps', recent)
    monkeypatch.setattr(tune_router, '_task', None)

    body = _client(tune_router.router).get('/recent').json()

    assert body == {'sweeps': [{'sweep_id': 's-dead', 'verdict': 'running'}], 'running': False}


def test_recent_sweeps_say_a_sweep_is_running_while_its_task_lives(monkeypatch):
    async def recent(limit=20):
        return []

    async def forever():
        await asyncio.Event().wait()

    monkeypatch.setattr(tune_router.tune, 'list_recent_sweeps', recent)
    loop = asyncio.new_event_loop()
    task = loop.create_task(forever())
    monkeypatch.setattr(tune_router, '_task', task)
    try:
        assert _client(tune_router.router).get('/recent').json()['running'] is True
    finally:
        task.cancel()
        loop.run_until_complete(asyncio.gather(task, return_exceptions=True))
        loop.close()
