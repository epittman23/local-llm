"""benchmarks/proc.py - one shell command, owning its process group.

Async port of local-llm's scripts/llama_proc.py (outer repo), so the backend
can launch and manage a subprocess (a tuning candidate's stub launcher, or
any other one-off command) without blocking the event loop. The
process-group and signal semantics are unchanged from the original -- only
the subprocess plumbing is now asyncio's.

Until 2026-09-14 this ran every command through `bash -c "source
llama-env.sh && ..."`, because llama-server itself was started through
main.sh's `lllm-serve` shell function. Serving now goes through
benchmarks/serving/launcher.ServeProcess directly (routers/benchmarks/
serve.py, benchmarks/tune_probe.py's Server) -- see docs/migration-plan.md's
Phase 2 -- so `Command` no longer needs a serving-profile shell layer
sourced into it; it just runs the command it is given. What it keeps: owning
a process group so a caller can signal a whole subprocess tree at once,
which is still useful for anything launched as an arbitrary shell command
(currently: `LLAMA_TUNE_LAUNCH`, tune_probe.py's escape hatch for launching
a candidate through something other than the real llama-server, for fault-
injection testing with no GPU involved).
"""

from __future__ import annotations

import asyncio
import os
import signal


class Command:
    """One shell command, owning its process group.

    `start_new_session=True` is the whole point. The command runs through
    `bash -c ...`, so whatever it launches is a child of that bash and not
    the process a caller holds a handle to -- `proc.terminate()` alone could
    leave a grandchild holding VRAM. A session of its own means the whole
    tree can be signalled together.

    The signals are chosen for what the harness does with them, not for
    politeness:

    - SIGINT is a *clean, resumable* cancel, matching the CLI original's
      cooperative-cancel behaviour for a test suite in progress.
    - SIGTERM before SIGKILL protects the store: a recorder in this tree
      may call close_run() on the way out, and killing outright leaves the
      run open for a stale-run sweep to close as 'stale' instead of 'clean'.
    """

    def __init__(self, command: str, *, env: dict | None = None, plain: bool = True):
        self.command = command
        self.proc: asyncio.subprocess.Process | None = None
        self.env = dict(env or os.environ)
        if plain:
            # Output going into an SSE stream does its own rendering; Rich's
            # escape codes would be shown raw, not applied.
            self.env['LLAMA_PLAIN'] = '1'

    async def start(self) -> None:
        self.proc = await asyncio.create_subprocess_exec(
            'bash',
            '-c',
            self.command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=self.env,
            start_new_session=True,
        )

    async def lines(self):
        """Stream stdout line by line. One pass, safe to iterate once."""
        if self.proc is None or self.proc.stdout is None:
            return
        async for raw in self.proc.stdout:
            yield raw.decode(errors='replace').rstrip()

    async def wait(self) -> int:
        return await self.proc.wait() if self.proc else -1

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    def signal(self, sig: int) -> bool:
        """Signal the whole process group. False if there was nothing to signal."""
        if not self.running:
            return False
        try:
            os.killpg(os.getpgid(self.proc.pid), sig)
            return True
        except (ProcessLookupError, PermissionError, OSError):
            return False

    def interrupt(self) -> bool:
        """Cancel, the way Ctrl-C at a shell would: resumable and recorded."""
        return self.signal(signal.SIGINT)

    async def stop(self, grace: float = 5.0) -> bool:
        """Ask the group to stop, then insist."""
        if not self.signal(signal.SIGTERM):
            return False
        try:
            await asyncio.wait_for(self.proc.wait(), timeout=grace)
        except TimeoutError:
            self.signal(signal.SIGKILL)
        return True
