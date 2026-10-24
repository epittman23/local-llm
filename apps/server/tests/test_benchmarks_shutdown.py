"""routers/benchmarks/__init__.py's shutdown(): what LLLM_STOP_JOBS_ON_SHUTDOWN stops.

main.py's lifespan calls it only when the flag is set (the desktop app's
backend). It must stop a running Tests job, a tune sweep and the served
model, log the `==>` markers the desktop's progress dialog follows, and log
nothing when there is nothing to stop. ServeProcess is a stub, so nothing
here touches llama-server or the GPU.

Run from apps/server:

    python -m pytest tests/test_benchmarks_shutdown.py
"""

from __future__ import annotations

import asyncio
import logging

import pytest

from local_llm import env
from local_llm.routers import benchmarks
from local_llm.routers.benchmarks import serve as serve_router
from local_llm.routers.benchmarks import tests as tests_router
from local_llm.routers.benchmarks import tune as tune_router


class _StubServeProcess:
    def __init__(self):
        self.running = True
        self.stopped = False

    async def stop(self):
        self.running = False
        self.stopped = True


@pytest.fixture(autouse=True)
def _idle(monkeypatch):
    monkeypatch.setattr(serve_router, '_job', None)
    monkeypatch.setattr(tests_router, '_task', None)
    monkeypatch.setattr(tests_router, '_cancel', False)
    monkeypatch.setattr(tune_router, '_task', None)


def _markers(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.getMessage().startswith('==> ')]


def test_the_flag_is_off_by_default():
    assert env.LLLM_STOP_JOBS_ON_SHUTDOWN is False


def test_nothing_running_logs_nothing(caplog):
    caplog.set_level(logging.INFO)
    asyncio.run(benchmarks.shutdown())
    assert _markers(caplog) == []


def test_stops_the_served_model(monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    job = _StubServeProcess()
    monkeypatch.setattr(serve_router, '_job', job)

    asyncio.run(benchmarks.shutdown())

    assert job.stopped
    assert _markers(caplog) == ['==> Stopping the served model', '==> Stopped the served model']


def test_stops_jobs_before_the_served_model(monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    job = _StubServeProcess()
    monkeypatch.setattr(serve_router, '_job', job)
    seen: dict[str, bool] = {}

    async def scenario():
        async def tests_job():
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                seen['tests cancelled'] = True
                seen['model still up then'] = job.running
                raise

        async def sweep():
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                # Like benchmarks.tuning.tune: a cancelled sweep finishes
                # cleanly rather than re-raising.
                seen['sweep cancelled'] = True

        monkeypatch.setattr(tests_router, '_task', asyncio.create_task(tests_job()))
        monkeypatch.setattr(tune_router, '_task', asyncio.create_task(sweep()))
        await asyncio.sleep(0)
        await benchmarks.shutdown()

    asyncio.run(scenario())

    assert seen == {'tests cancelled': True, 'model still up then': True, 'sweep cancelled': True}
    assert tests_router._cancel is True
    assert job.stopped
    assert _markers(caplog) == [
        '==> Stopping benchmark jobs',
        '==> Stopped benchmark jobs',
        '==> Stopping the served model',
        '==> Stopped the served model',
    ]


def test_a_job_that_ignores_cancellation_is_waited_on_only_up_to_the_timeout(monkeypatch):
    monkeypatch.setattr(benchmarks, '_JOB_STOP_TIMEOUT', 0.05)

    async def scenario():
        release = asyncio.Event()

        async def stubborn():
            while not release.is_set():
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    continue

        task = asyncio.create_task(stubborn())
        monkeypatch.setattr(tests_router, '_task', task)
        await asyncio.sleep(0)
        await asyncio.wait_for(benchmarks.shutdown(), timeout=2)
        assert not task.done()
        release.set()
        await task

    asyncio.run(scenario())
