import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable

from fastapi import APIRouter

from local_llm.routers.benchmarks import answers, compare, live, prescreen, profiles, report, serve, tests

log = logging.getLogger(__name__)

router = APIRouter()
router.include_router(serve.router, prefix='/serve')
router.include_router(profiles.router, prefix='/profiles')
router.include_router(live.router, prefix='/live')
router.include_router(tests.router, prefix='/tests')
router.include_router(compare.router, prefix='/compare')
router.include_router(answers.router, prefix='/answers')
router.include_router(report.router, prefix='/report')
router.include_router(prescreen.router, prefix='/prescreen')

try:
    from local_llm.routers.benchmarks import tune

    router.include_router(tune.router, prefix='/tune')
except ImportError:
    # benchmarks.tune (the config-search engine) is ported separately and
    # may not exist yet in every checkout of this branch -- every other
    # page works without it, so its absence should not break the rest of
    # the Benchmarks feature.
    tune = None

# Per job; ServeProcess.stop() bounds itself (three 5 s graces).
_JOB_STOP_TIMEOUT = 20.0


async def _stop_job(stop: Callable[[], Awaitable[None]]) -> None:
    """Wait up to _JOB_STOP_TIMEOUT for one job to stop, then go on regardless.

    A job that ignores cancellation is left to finish on its own rather than
    hold up the rest of the shutdown and its `==>` markers.
    """
    with contextlib.suppress(TimeoutError):
        async with asyncio.timeout(_JOB_STOP_TIMEOUT):
            await stop()


async def shutdown() -> None:
    """Stop every benchmark job, then the served model, for a backend exiting for good.

    main.py's lifespan calls this only when LLLM_STOP_JOBS_ON_SHUTDOWN is set
    (the desktop app's backend); otherwise all of them but a pre-screen
    deliberately outlive the backend (stop_prescreen() below). Jobs first: a sweep stops its own candidate server, and a
    Tests run would only fail against a model already stopped. A pre-screen
    and its dashboard count as jobs. The `==>` lines are the markers the
    desktop app's progress dialog follows.
    """
    sweeping = tune is not None and tune.running()
    if sweeping or tests.active() or prescreen.running() or prescreen.dashboard_running():
        log.info('==> Stopping benchmark jobs')
        await _stop_job(tests.shutdown)
        if tune is not None:
            await _stop_job(tune.shutdown)
        await _stop_job(prescreen.shutdown)
        log.info('==> Stopped benchmark jobs')
    await serve.shutdown()


async def startup() -> None:
    """At backend startup: close a pre-screen a dead backend left open, and stop its orphan."""
    try:
        await prescreen.startup()
    except Exception:  # startup must go on; the next pre-screen start retries it
        log.exception('the pre-screen startup check failed')


async def stop_prescreen() -> None:
    """Stop a running pre-screen at every backend shutdown, LLLM_STOP_JOBS_ON_SHUTDOWN or not.

    Unlike a served model, a pre-screen cannot outlive its backend: the
    orchestrator choosing the next point runs in this process. Left alone,
    its llama-bench would hold the GPU with nothing to record the result.
    The dashboard is left running, as llama-server is.
    """
    if prescreen.running():
        log.info('Stopping the running pre-screen')
        await _stop_job(prescreen.stop_sweep)
