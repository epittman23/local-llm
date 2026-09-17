"""HTTP-layer tests for routers/benchmarks/serve.py's /start rewiring.

Phase 2b: /start used to shell out to `lllm-serve <profile>` through
proc.Command; it now resolves the profile from the database and constructs
benchmarks.serving.launcher.ServeProcess directly. These check the new
404/400 mappings (no such profile, a profile that fails to resolve, a
ServeProcess that fails to start) and that overrides reach resolve()
correctly -- with BenchmarkProfiles and ServeProcess itself monkeypatched,
so nothing here touches a real database, llama-server, or the GPU.

Run from the backend directory:

    python -m pytest tests/test_serve_router.py
"""

from __future__ import annotations

import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from open_webui.benchmarks.serving.launcher import LauncherError
from open_webui.models.benchmark_configs import BenchmarkRuns
from open_webui.models.benchmark_profiles import (
    BenchmarkProfileEntry,
    BenchmarkProfileModel,
    BenchmarkProfiles,
    BenchmarkProfileVersionModel,
)
from open_webui.routers.benchmarks import serve as serve_router
from open_webui.utils.auth import get_admin_user

ADMIN = SimpleNamespace(id='admin-1', email='admin@example.com')


def _entry(name='qwen25c') -> BenchmarkProfileEntry:
    now = int(time.time())
    return BenchmarkProfileEntry(
        profile=BenchmarkProfileModel(profile_id=1, name=name, display_name=name, is_default=True, created_at=now),
        version=BenchmarkProfileVersionModel(
            version_id=1,
            profile_id=1,
            version=1,
            created_at=now,
            arch='dense',
            alias='qwen2.5-coder-7b',
            model_path='/models/x.gguf',
            ctx=16384,
            threads=6,
            ngl=99,
            spec=[],
            samplers=[],
            extra=[],
        ),
    )


class _StubServeProcess:
    """Stands in for launcher.ServeProcess: no binary, no GPU, no subprocess."""

    instances: list[_StubServeProcess] = []
    fail_with: Exception | None = None

    def __init__(self, config, **kwargs):
        self.config = config
        self.kwargs = kwargs
        self.warning = None
        self._running = False
        self.stopped = False
        _StubServeProcess.instances.append(self)

    async def start(self):
        if _StubServeProcess.fail_with is not None:
            raise _StubServeProcess.fail_with
        self._running = True

    @property
    def running(self):
        return self._running

    async def lines(self):
        return
        yield  # pragma: no cover - makes this an async generator

    async def stop(self):
        self._running = False
        self.stopped = True


@pytest.fixture(autouse=True)
def _reset_job_state(monkeypatch):
    monkeypatch.setattr(serve_router, '_job', None)
    monkeypatch.setattr(serve_router, 'ServeProcess', _StubServeProcess)
    _StubServeProcess.instances = []
    _StubServeProcess.fail_with = None

    async def fake_get_any_active_run(db=None):
        return None

    monkeypatch.setattr(BenchmarkRuns, 'get_any_active_run', fake_get_any_active_run)


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(serve_router.router)
    app.dependency_overrides[get_admin_user] = lambda: ADMIN
    return TestClient(app)


def test_start_404_when_profile_missing(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return None

    monkeypatch.setattr(BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    resp = client.post('/start', json={'profile': 'no-such-profile'})
    assert resp.status_code == 404
    assert _StubServeProcess.instances == []


def test_start_uses_the_default_profile_when_none_named(client, monkeypatch):
    calls = []

    async def fake_get_default(db=None):
        calls.append('default')
        return _entry()

    monkeypatch.setattr(BenchmarkProfiles, 'get_default', fake_get_default)
    resp = client.post('/start', json={})
    assert resp.status_code == 200
    assert calls == ['default']


def test_start_400_on_profile_error(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return _entry(name=name)

    monkeypatch.setattr(BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    # --parallel does not belong in a LLAMA_SPEC override.
    resp = client.post('/start', json={'profile': 'qwen25c', 'spec': '--parallel 2'})
    assert resp.status_code == 400
    assert _StubServeProcess.instances == []


def test_start_400_when_serveprocess_fails_to_start(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return _entry(name=name)

    monkeypatch.setattr(BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    _StubServeProcess.fail_with = LauncherError('llama-server not found at /nonexistent')

    resp = client.post('/start', json={'profile': 'qwen25c'})
    assert resp.status_code == 400
    assert 'llama-server not found' in resp.json()['detail']
    assert serve_router._job is None


def test_start_409_when_already_running(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return _entry(name=name)

    monkeypatch.setattr(BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    first = client.post('/start', json={'profile': 'qwen25c'})
    assert first.status_code == 200
    second = client.post('/start', json={'profile': 'qwen25c'})
    assert second.status_code == 409


def test_start_409_when_a_run_is_already_active(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return _entry(name=name)

    async def fake_get_any_active_run(db=None):
        return object()

    monkeypatch.setattr(BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    monkeypatch.setattr(BenchmarkRuns, 'get_any_active_run', fake_get_any_active_run)
    resp = client.post('/start', json={'profile': 'qwen25c'})
    assert resp.status_code == 409


def test_start_passes_overrides_through_to_resolve(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return _entry(name=name)

    monkeypatch.setattr(BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    resp = client.post('/start', json={'profile': 'qwen25c', 'ngl': 42, 'ctx': 8192})
    assert resp.status_code == 200
    (proc,) = _StubServeProcess.instances
    assert proc.config.ngl == 42
    assert proc.config.ctx == 8192


def test_stop_404_when_nothing_running(client):
    resp = client.post('/stop')
    assert resp.status_code == 404


def test_stop_200_and_stops_the_job(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return _entry(name=name)

    monkeypatch.setattr(BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    client.post('/start', json={'profile': 'qwen25c'})
    (proc,) = _StubServeProcess.instances
    resp = client.post('/stop')
    assert resp.status_code == 200
    assert proc.stopped is True
