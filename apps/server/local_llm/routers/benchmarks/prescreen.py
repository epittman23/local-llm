"""routers/benchmarks/prescreen.py - start, cancel and watch a llama-bench pre-screen; run its dashboard.

`/start` checks everything a pre-screen needs before answering
(`Prescreen.prepare()`), so a refusal (a bad grid, no llama-bench, no
Postgres, the GPU in use) comes back as a 400 or 409 rather than vanishing
into a background task. The sweep itself then runs as an asyncio.Task, one
at a time, and never alongside a served model, a Tune sweep or a Tests job:
they share one GPU. Serve, Tune and Tests refuse to start while one runs,
through `running()`.

`/sweeps` and `/sweeps/{id}` are database reads, so they work across a
backend restart. A pre-screen does not outlive its backend: the orchestrator
is in this process, so the lifespan teardown stops it (`stop_sweep()`), and
a sweep left open by a backend that died is closed as stale, its orphan
stopped, by the next start.

The dashboard follows llama-server's lifecycle instead: it outlives a
`--reload` restart and is stopped only by `shutdown()`
(LLLM_STOP_JOBS_ON_SHUTDOWN).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict

from local_llm.benchmarks.prescreen import PrescreenRefused
from local_llm.benchmarks.prescreen.dashboard import DashboardProcess
from local_llm.benchmarks.prescreen.grid import grid_names, load_grid
from local_llm.benchmarks.prescreen.sweep import Prescreen, PrescreenOptions, rank
from local_llm.benchmarks.serving.launcher import IMPORT_ROOT
from local_llm.constants import ERROR_MESSAGES
from local_llm.env import DATA_DIR, DATABASE_SCHEMA, DATABASE_URL, LLLM_OPTUNA_DASHBOARD_PORT
from local_llm.models.benchmarks.configs import BenchmarkRuns
from local_llm.models.benchmarks.prescreen import BenchmarkPrescreenPoints, BenchmarkPrescreenSweeps
from local_llm.utils.auth import get_admin_user

log = logging.getLogger(__name__)

router = APIRouter()

_sweep: Prescreen | None = None
_task: asyncio.Task | None = None
# Set when a sweep that did start then failed outside its own bookkeeping.
_last_error: str | None = None
# Held across the whole of /start: the checks and the spawn are separated by
# database awaits, so two concurrent requests could otherwise both pass.
_start_lock = asyncio.Lock()

_dashboard = DashboardProcess(
    DATA_DIR / 'prescreen' / 'dashboard.pid', port=LLLM_OPTUNA_DASHBOARD_PORT, cwd=str(IMPORT_ROOT)
)


def running() -> bool:
    """Whether a pre-screen is running; Serve, Tune and Tests refuse to start meanwhile."""
    return _task is not None and not _task.done()


async def _gpu_busy() -> str | None:
    """What else is using the GPU, in words, or None."""
    from local_llm.routers.benchmarks import serve, tests

    if serve._job is not None and serve._job.running:
        return 'a model is being served from the Serve page'
    try:
        from local_llm.routers.benchmarks import tune
    except ImportError:
        tune = None
    if tune is not None and tune.running():
        return 'a tune sweep is running'
    if tests.active():
        return 'a test job is running'
    if await BenchmarkRuns.get_any_active_run() is not None:
        return 'a recorded run is active on another process'
    return None


class PrescreenStartForm(BaseModel):
    profile: str | None = None
    grid: str | None = None
    sampler: str = 'auto'
    trials: int = 40
    seed: int = 0
    objective: str = 'tg'
    n_prompt: int = 512
    n_gen: int = 128
    reps: int = 5
    point_timeout: int = 900
    ctx_checks: int = 3
    load_timeout: int = 600

    model_config = ConfigDict(extra='forbid')


async def _run(sweep: Prescreen) -> None:
    global _last_error
    try:
        await sweep.run()
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # reported through /sweeps, not lost with the task
        log.exception('pre-screen %s failed', sweep.sweep_id)
        _last_error = str(exc) or exc.__class__.__name__


@router.post('/start')
async def start_prescreen(form_data: PrescreenStartForm, user=Depends(get_admin_user)):
    global _sweep, _task, _last_error
    async with _start_lock:
        if running():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail=ERROR_MESSAGES.DEFAULT('a pre-screen is already running')
            )
        busy = await _gpu_busy()
        if busy:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ERROR_MESSAGES.DEFAULT(busy))
        sweep = Prescreen(
            PrescreenOptions(**form_data.model_dump()), database_url=DATABASE_URL, database_schema=DATABASE_SCHEMA
        )
        try:
            sweep_id = await sweep.prepare()
        except PrescreenRefused as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        _sweep, _last_error = sweep, None
        _task = asyncio.create_task(_run(sweep))
        return {'started': True, 'sweep_id': sweep_id}


@router.post('/cancel')
async def cancel_prescreen(user=Depends(get_admin_user)):
    if _sweep is None or not running():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ERROR_MESSAGES.NOT_FOUND)
    _sweep.cancel.set()
    return {'cancelling': True}


async def stop_sweep() -> None:
    """Cancel a running pre-screen and wait for it; the caller bounds the wait.

    The cooperative cancel first, so the point in flight is stopped (its
    group killed) and recorded as cancelled, and the sweep closed.
    """
    sweep, task = _sweep, _task
    if sweep is None or task is None or task.done():
        return
    sweep.cancel.set()
    await asyncio.wait({task})


def dashboard_running() -> bool:
    return _dashboard.running()


async def shutdown() -> None:
    """Stop a running pre-screen, then the dashboard, for a backend exiting for good."""
    await stop_sweep()
    if _dashboard.running():
        await _dashboard.stop()


@router.get('/grids')
async def get_grids(user=Depends(get_admin_user)):
    grids = []
    for name in grid_names():
        try:
            grid = load_grid(name)
        except PrescreenRefused as exc:
            grids.append({'name': name, 'error': str(exc)})
            continue
        grids.append({'name': name, 'profile': grid.profile, 'knobs': grid.knobs, 'combinations': grid.size()})
    return {'grids': grids}


def _state() -> dict:
    return {
        'running': running(),
        'active': _sweep.status() if _sweep is not None and running() else None,
        'last_error': _last_error,
    }


@router.get('/sweeps')
async def get_sweeps(limit: int = Query(20, ge=1, le=200), user=Depends(get_admin_user)):
    sweeps = await BenchmarkPrescreenSweeps.list_sweeps(limit=limit)
    return {'sweeps': [s.model_dump() for s in sweeps], **_state()}


async def _detail(sweep_id: str) -> dict | None:
    sweep = await BenchmarkPrescreenSweeps.get_by_id(sweep_id)
    if sweep is None:
        return None
    points = await BenchmarkPrescreenPoints.sweep_points(sweep_id)
    baseline = next((p.overrides for p in points if p.is_baseline and p.phase == 'search'), None)
    return {
        'sweep': sweep.model_dump(),
        'points': [p.model_dump() for p in points],
        'candidates': rank(points, sweep.objective, baseline),
        **_state(),
    }


@router.get('/sweeps/{sweep_id}')
async def get_sweep(sweep_id: str, user=Depends(get_admin_user)):
    detail = await _detail(sweep_id)
    if detail is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ERROR_MESSAGES.NOT_FOUND)
    return detail


@router.get('/stream')
async def stream_prescreen(sweep_id: str, user=Depends(get_admin_user)):
    """The sweep's detail every 2 s until it ends, then a `done` event.

    Polled from the database rather than pushed, the same contract as
    Tune's `/log`: a tab that reconnects sees the whole sweep at once.
    """
    if await BenchmarkPrescreenSweeps.get_by_id(sweep_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ERROR_MESSAGES.NOT_FOUND)

    async def event_stream():
        while True:
            detail = await _detail(sweep_id)
            if detail is not None:
                yield f'data: {json.dumps(detail, default=str)}\n\n'
            if detail is None or detail['sweep']['status'] != 'running' or not running():
                yield 'event: done\ndata: {}\n\n'
                return
            await asyncio.sleep(2)

    return StreamingResponse(event_stream(), media_type='text/event-stream')


def _dashboard_state() -> dict:
    return {'running': _dashboard.running(), 'url': _dashboard.url, 'port': _dashboard.port}


@router.get('/dashboard')
async def get_dashboard(user=Depends(get_admin_user)):
    return _dashboard_state()


@router.post('/dashboard/start')
async def start_dashboard(user=Depends(get_admin_user)):
    try:
        await _dashboard.start({**os.environ, 'DATABASE_URL': DATABASE_URL})
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ERROR_MESSAGES.DEFAULT(str(exc))) from exc
    return _dashboard_state()


@router.post('/dashboard/stop')
async def stop_dashboard(user=Depends(get_admin_user)):
    if not await _dashboard.stop():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ERROR_MESSAGES.NOT_FOUND)
    return _dashboard_state()
