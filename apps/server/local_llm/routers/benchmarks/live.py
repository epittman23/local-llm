"""routers/benchmarks/live.py - GPU/throughput telemetry for the currently-recording run."""

from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException, status
from local_llm.benchmarks import stats
from local_llm.benchmarks.tune_probe import kill_pgid
from local_llm.constants import ERROR_MESSAGES
from local_llm.models.benchmarks.configs import BenchmarkRuns
from local_llm.models.benchmarks.telemetry import BenchmarkGpuSamples, BenchmarkMetricsScrapes
from local_llm.models.benchmarks.tests import BenchmarkRequests
from local_llm.utils.auth import get_admin_user

router = APIRouter()


@router.get('/')
async def get_live(user=Depends(get_admin_user)):
    run = await BenchmarkRuns.get_any_active_run()
    if run is None:
        return {'run': None}

    samples = [s.model_dump() for s in await BenchmarkGpuSamples.list_samples(run.run_id)]
    summary = stats.gpu_stats(samples)
    deltas = await BenchmarkMetricsScrapes.get_delta(run.run_id)
    aggregate = await BenchmarkRequests.get_run_request_aggregate(run.run_id)
    requests = aggregate['requests'] if aggregate else 0
    warning = stats.headroom_warning(f'{run.model} ({run.config_id})', summary.get('vram_headroom_mib'))

    return {
        'run': run.model_dump(),
        'summary': summary,
        'deltas': deltas,
        'requests': requests,
        'recent_samples': samples[-12:],
        'warning': warning,
    }


@router.post('/kill')
async def kill_active_run(user=Depends(get_admin_user)):
    """Force-stop whatever is currently being recorded, from Serve or a
    Tune candidate alike.

    Reads the process group off the *recorded* run row's pid, not any
    in-memory handle (serve.py's `_job`, a Tune visit's Server instance),
    so it still works exactly when it is most needed: after a backend
    restart or crash orphans the llama-server/recorder pair with nothing
    in this process tracking them, while the DB row -- and the pid on it
    -- survives untouched. kill_pgid() escalates SIGINT -> SIGTERM ->
    SIGKILL, the same sequence Server.stop() uses, so the recorder still
    gets a chance to close its own run cleanly before this does it anyway.
    """
    run = await BenchmarkRuns.get_any_active_run()
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ERROR_MESSAGES.NOT_FOUND)
    try:
        pgid = os.getpgid(run.pid)
    except ProcessLookupError:
        pgid = None
    await kill_pgid(pgid)
    await BenchmarkRuns.close_run(run.run_id, reason='killed')
    return {'killed': True, 'run_id': run.run_id}
