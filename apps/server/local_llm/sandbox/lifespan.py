"""Starting and stopping the sandbox manager with the app, from main.py's lifespan.

`start` puts a SandboxManager on `app.state.sandbox` (None when it does not
run), sweeps up after the previous process, and starts the maintenance loop;
`stop` ends the loop and the manager. The app starts whatever the sandbox's
state: when the backend reports a reason it cannot run sandboxes (no Kata on
the host, say), the reason is logged, the admin page shows it
(GET /api/v1/sandbox/status), and the backend's `create` refuses each call
with it.

One server process only. The manager's per-chat lock and its slot count are
per process (T12's security review, N7), so a second process managing the
same sandboxes would let two commands run in one sandbox at once. `start`
refuses when uvicorn was asked for more than one worker, and holds an
exclusive lock on a file under DATA_DIR for the life of the process, so a
second server sharing the data directory refuses too. A `--reload` restart
is safe: uvicorn ends the old process, which releases the lock, before it
starts the new one.
"""

import asyncio
import fcntl
import logging
import os
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import IO, Any, Final

from local_llm.sandbox.backend import SandboxBackend
from local_llm.sandbox.manager import SandboxManager

log = logging.getLogger(__name__)

#: Seconds startup waits for the startup sweep; a slower one is finished, and a failed one retried, in the background.
STARTUP_SWEEP_TIMEOUT_S: Final = 30.0
#: Seconds between attempts at a startup sweep that failed.
SWEEP_RETRY_S: Final = 60.0
#: The lock file under the sandbox's data directory.
LOCK_FILE: Final = 'manager.lock'


def server_workers(argv: Sequence[str] | None = None, environ: Mapping[str, str] | None = None) -> int:
    """How many server processes were asked for: uvicorn's or gunicorn's worker flag, else WEB_CONCURRENCY or
    UVICORN_WORKERS, else 1.

    The worker flag is `--workers N`, `--workers=N`, or gunicorn's `-w N`,
    `-wN`; the last one given counts, as with the servers' own option
    parsers; `-w` counts only when the program is gunicorn. uvicorn's and gunicorn's worker processes start with the
    parent's argv, so the flag is seen in every worker. A value that is not
    a number counts as 1, as the server would refuse it anyway. `argv` and
    `environ` default to the process's, read at call time.
    """
    argv = sys.argv if argv is None else argv
    environ = os.environ if environ is None else environ
    value = None
    # `-w` is gunicorn's; uvicorn has none, and another tool's `-w4` must not turn the sandbox off (N4).
    gunicorn = bool(argv) and Path(argv[0]).name.startswith('gunicorn')
    for i, arg in enumerate(argv):
        if (arg == '--workers' or (gunicorn and arg == '-w')) and i + 1 < len(argv):
            value = argv[i + 1]
        elif arg.startswith('--workers='):
            value = arg.split('=', 1)[1]
        elif gunicorn and arg.startswith('-w') and len(arg) > 2 and not arg.startswith('--'):
            value = arg[2:]
    if value is not None:
        return _count(value)
    for name in ('WEB_CONCURRENCY', 'UVICORN_WORKERS'):
        if environ.get(name):
            return _count(environ[name])
    return 1


def _count(text: str) -> int:
    try:
        return max(int(text), 1)
    except ValueError:
        return 1


def _lock(directory: Path) -> IO[str] | None:
    """The open, exclusively locked lock file, or None when another process holds it.

    Raises:
        OSError: The directory or the file cannot be made or locked.
    """
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Held open for the life of the process: closing it releases the lock.
    handle = open(directory / LOCK_FILE, 'a')
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        return None
    except BaseException:
        handle.close()
        raise
    return handle


async def _settle(sweep: asyncio.Task[None], *, quiet: bool = False) -> bool:
    """Wait for a startup sweep to end; whether it completed. Any error is logged, never raised."""
    try:
        await sweep
    except asyncio.CancelledError:
        raise
    except Exception:
        (log.debug if quiet else log.warning)(
            'the sandbox startup sweep failed; retrying every %g s', SWEEP_RETRY_S, exc_info=True
        )
        return False
    return True


async def _maintain(manager: SandboxManager, sweep: asyncio.Task[None]) -> None:
    """Finish the startup sweep (retrying it until it completes), then run the maintenance loop."""
    quiet = False
    while not await _settle(sweep, quiet=quiet):
        quiet = True
        await asyncio.sleep(SWEEP_RETRY_S)
        sweep = asyncio.ensure_future(manager.startup_sweep())
    await manager.maintenance_loop()


async def start(app: Any, backend: SandboxBackend, data_dir: Path) -> None:
    """Start the sandbox manager on `app.state.sandbox`, or leave it None when this process may not run one.

    Never raises: whatever goes wrong is logged and the app starts without
    the manager (or with one whose `ready()` gives the reason).

    The startup sweep runs first, for at most STARTUP_SWEEP_TIMEOUT_S; one
    that takes longer is not cancelled (a cancelled sweep would release a
    sandbox's lock while its backend call ran on) but finished in the
    background before the maintenance loop starts.

    Args:
        app: The FastAPI app.
        backend: Runs the sandboxes.
        data_dir: The sandbox's directory under DATA_DIR, which holds the lock file.
    """
    app.state.sandbox = None
    app.state.sandbox_maintenance = None
    app.state.sandbox_lock = None
    app.state.sandbox_backend = backend
    workers = server_workers()
    if workers > 1:
        log.error('the code sandbox needs a single server process, and %d workers were asked for; it is off', workers)
        return
    try:
        lock = _lock(data_dir)
    except OSError:
        log.exception('the code sandbox could not take its lock in its data directory; it is off')
        return
    if lock is None:
        log.error('another server process sharing this data directory runs the code sandbox; it is off here')
        return
    try:
        manager = SandboxManager(backend)
        reason = await manager.ready()
        if reason is not None:
            log.warning('the code sandbox cannot run sandboxes: %s', reason)
        sweep = asyncio.ensure_future(manager.startup_sweep())
        await asyncio.wait({sweep}, timeout=STARTUP_SWEEP_TIMEOUT_S)
        if not sweep.done():
            log.warning(
                'the sandbox startup sweep is taking longer than %g s; finishing it in the background',
                STARTUP_SWEEP_TIMEOUT_S,
            )
    except Exception:
        log.exception('the code sandbox could not start; it is off')
        lock.close()
        return
    app.state.sandbox = manager
    app.state.sandbox_lock = lock
    app.state.sandbox_maintenance = asyncio.create_task(_maintain(manager, sweep))


async def stop(app: Any, *, stop_running: bool) -> None:
    """End the maintenance loop and the manager; running sandboxes are stopped only with `stop_running`.

    Never raises: the rest of the app's teardown must run whatever happens here.
    """
    task = getattr(app.state, 'sandbox_maintenance', None)
    if task is not None:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception('the sandbox maintenance task had failed')
    manager = getattr(app.state, 'sandbox', None)
    if manager is not None:
        try:
            await manager.shutdown(stop_running=stop_running)
        except Exception:
            log.exception('the sandbox manager could not stop the running sandboxes')
    lock = getattr(app.state, 'sandbox_lock', None)
    if lock is not None:
        lock.close()
    # The Kata backend's own thread pool for command streams; other backends have none.
    close = getattr(getattr(app.state, 'sandbox_backend', None), 'close', None)
    if close is not None:
        try:
            close()
        except Exception:
            log.exception('the sandbox backend could not release its threads')
    app.state.sandbox = None
    app.state.sandbox_maintenance = None
    app.state.sandbox_lock = None
    app.state.sandbox_backend = None
