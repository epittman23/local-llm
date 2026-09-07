#!/usr/bin/env python3
"""llama_proc.py - one llama-env.sh invocation, owning its process group.

Part of https://github.com/epittman23/local-llm

Extracted out of the Textual dashboard (llama_ui.py) when it was replaced by
llama_web.py, because `llama_tune.py` already depended on this class for
launching each sweep candidate's `llama-serve` -- `Command` was never
TUI-specific, it just used to live in the file that happened to define it.
Stdlib-only: nothing here needs Textual, FastAPI, or anything else outside the
standard library, so it costs neither the recorder path nor a caller that only
wants the process-group semantics.
"""

from __future__ import annotations

import os
import shlex
import signal
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ENV_SH = REPO / "scripts" / "llama-env.sh"


class Command:
    """One llama-env.sh invocation, owning its process group.

    `start_new_session=True` is the whole point. Every caller runs its command
    through `bash -c "source llama-env.sh && ..."`, so llama-server and
    llama-test are children of that bash and not the process a caller holds a
    handle to -- and `proc.terminate()` would signal the wrapper alone. That is
    how a caller could report "[stopping]" and leave a llama-server holding
    5 GB on a 6 GB card. A session of its own means the whole tree can be
    signalled together.

    The signals are chosen for what the harness does with them, not for
    politeness:

    - SIGINT is a *clean, resumable* cancel. `llama_test.cmd_suite` catches
      KeyboardInterrupt, reports what it measured, prints the `--resume` line
      and exits 1, so interrupting the group produces the harness's own cancel
      rather than a killed process and a half-written suite.
    - SIGTERM before SIGKILL protects the store. `llama-serve` backgrounds the
      recorder, which calls close_run() on the way out; killing outright leaves
      the run open for sweep_stale_runs() to close as 'stale', so the database
      would record every server a caller stopped as a crash. The grace period
      is what keeps 'clean' meaning clean.
    """

    def __init__(self, command: str, *, env: dict | None = None,
                 plain: bool = False):
        self.command = command
        self.proc: subprocess.Popen | None = None
        self.env = dict(env or os.environ)
        if plain:
            # Output going somewhere other than a terminal (a Log widget, an
            # SSE stream) does its own rendering; Rich's escape codes would be
            # shown, not applied.
            self.env["LLAMA_PLAIN"] = "1"

    def start(self) -> None:
        self.proc = subprocess.Popen(
            ["bash", "-c",
             f"source {shlex.quote(str(ENV_SH))} && {self.command}"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            bufsize=1, env=self.env, start_new_session=True)

    def lines(self):
        """Stream stdout, then yield the exit tag. One pass, safe to iterate."""
        if self.proc is None or self.proc.stdout is None:
            return
        for line in self.proc.stdout:
            yield line.rstrip()

    def wait(self) -> int:
        return self.proc.wait() if self.proc else -1

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

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

    def stop(self, grace: float = 5.0) -> bool:
        """Ask the group to stop, then insist. See the class docstring."""
        if not self.signal(signal.SIGTERM):
            return False
        try:
            self.proc.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            self.signal(signal.SIGKILL)
        return True
