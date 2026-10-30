"""benchmarks/prescreen/dashboard.py - optuna-dashboard, as its own loopback process (D14).

optuna-dashboard cannot be mounted inside the app: its frontend is built
with root-absolute paths (`/api/...`, `/static/...`, `URL_PREFIX` baked in
at webpack build time as `/dashboard`), which collide with the app's own
`/api` and `/static`. So it runs as `python -m
local_llm.benchmarks.prescreen.dashboard --port N`, started and stopped from
the Pre-screen page, in a process group of its own.

**Always 127.0.0.1.** optuna-dashboard has no authentication and can edit
and delete studies, so it binds to loopback even when the backend listens
on every interface (`LLLM_BACKEND_HOST=0.0.0.0`); from another machine,
reach it over an SSH tunnel. The storage URL, password included, reaches
the process through DATABASE_URL in its environment, never its argv, so it
does not show in `ps`.

`main()` imports nothing from the app (see study.py). `DashboardProcess` is
the backend's handle on it, with a pid file so a backend restarted by
`--reload` can still find and stop the one its predecessor started.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import os
import signal
import socket
import sys
from pathlib import Path

HOST = '127.0.0.1'
DEFAULT_PORT = 8091
MODULE = 'local_llm.benchmarks.prescreen.dashboard'


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog=MODULE, description='optuna-dashboard over the pre-screen studies')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    args = parser.parse_args(argv)

    import optuna_dashboard

    from local_llm.benchmarks.prescreen import study

    storage = study.open_storage()
    optuna_dashboard.run_server(storage, host=HOST, port=args.port)
    return 0


def _port_open(port: int) -> bool:
    try:
        with socket.create_connection((HOST, port), timeout=1):
            return True
    except OSError:
        return False


def _ours(pid: int) -> bool:
    """Whether `pid` is still a dashboard process this module started."""
    try:
        cmdline = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
    except OSError:
        return False
    return MODULE.encode() in cmdline


class DashboardProcess:
    """The backend's handle on the dashboard process, one at a time."""

    def __init__(self, pidfile: Path, *, port: int = DEFAULT_PORT, cwd: str | None = None):
        self.pidfile = pidfile
        self.port = port
        self.cwd = cwd
        self.proc: asyncio.subprocess.Process | None = None

    @property
    def log_path(self) -> Path:
        """The dashboard's own output, beside its pid file, so a dashboard that dies at once says why."""
        return self.pidfile.parent / 'dashboard.log'

    @property
    def url(self) -> str:
        return f'http://{HOST}:{self.port}/dashboard'

    def pid(self) -> int | None:
        """The running dashboard's pid: this handle's, or the pid file's if that process is ours."""
        if self.proc is not None and self.proc.returncode is None:
            return self.proc.pid
        try:
            pid = int(self.pidfile.read_text().strip())
        except (OSError, ValueError):
            return None
        return pid if _ours(pid) else None

    def running(self) -> bool:
        return self.pid() is not None

    def last_output(self, lines: int = 5) -> str | None:
        """The end of the dashboard's log, for a dashboard that is not running."""
        try:
            text = self.log_path.read_text(errors='replace')
        except OSError:
            return None
        kept = [ln for ln in text.splitlines() if ln.strip()][-lines:]
        return '\n'.join(kept) or None

    async def start(self, env: dict[str, str]) -> None:
        """Start the dashboard. Raises RuntimeError, saying why, if it cannot."""
        if self.running():
            return
        if 'DATABASE_URL' not in env:
            raise RuntimeError('DATABASE_URL is not set; the dashboard reads the studies from Postgres')
        if await asyncio.to_thread(_port_open, self.port):
            raise RuntimeError(f'port {self.port} is already in use (LLLM_OPTUNA_DASHBOARD_PORT)')
        self.pidfile.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open('wb') as log:
            self.proc = await asyncio.create_subprocess_exec(
                sys.executable,
                '-m',
                MODULE,
                '--port',
                str(self.port),
                cwd=self.cwd,
                env=env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=log,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
            )
        self.pidfile.write_text(f'{self.proc.pid}\n')

    async def stop(self, grace: float = 5.0) -> bool:
        """SIGTERM to its group, then SIGKILL. False if nothing was running."""
        pid = self.pid()
        if pid is None:
            self.pidfile.unlink(missing_ok=True)
            return False
        with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
            os.killpg(pid, signal.SIGTERM)
        if self.proc is not None and self.proc.pid == pid:
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=grace)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
                    os.killpg(pid, signal.SIGKILL)
                await self.proc.wait()
        else:
            # Started by an earlier backend: not this process's child, so
            # there is nothing to wait on but the pid itself.
            loop = asyncio.get_running_loop()
            deadline = loop.time() + grace
            while _ours(pid) and loop.time() < deadline:
                await asyncio.sleep(0.2)
            if _ours(pid):
                with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
                    os.killpg(pid, signal.SIGKILL)
        self.proc = None
        self.pidfile.unlink(missing_ok=True)
        return True


if __name__ == '__main__':
    raise SystemExit(main())
