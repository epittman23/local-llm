import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable

from fastapi import APIRouter

from local_llm.routers.benchmarks import answers, compare, live, profiles, report, serve, tests

log = logging.getLogger(__name__)

router = APIRouter()
router.include_router(serve.router, prefix='/serve')
router.include_router(profiles.router, prefix='/profiles')
router.include_router(live.router, prefix='/live')
router.include_router(tests.router, prefix='/tests')
router.include_router(compare.router, prefix='/compare')
router.include_router(answers.router, prefix='/answers')
router.include_router(report.router, prefix='/report')

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
    (the desktop app's backend); otherwise all of them deliberately outlive
    the backend. Jobs first: a sweep stops its own candidate server, and a
    Tests run would only fail against a model already stopped. The `==>`
    lines are the markers the desktop app's progress dialog follows.
    """
    sweeping = tune is not None and tune.running()
    if sweeping or tests.active():
        log.info('==> Stopping benchmark jobs')
        await _stop_job(tests.shutdown)
        if tune is not None:
            await _stop_job(tune.shutdown)
        log.info('==> Stopped benchmark jobs')
    await serve.shutdown()
