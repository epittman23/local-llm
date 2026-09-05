#!/usr/bin/env python3
"""llama_ui.py - the entry point and shell surface for the Textual dashboard.

Part of https://github.com/epittman23/local-llm

Reached as `llama-ui` or `llama-test ui`. The screens themselves live in
`llama_ui_app.py`; what is here is everything the dashboard needs that does
*not* need Textual -- the argument parsing, the profile lookups, the database
reader, and the process handling.

THE POINT OF THE DASHBOARD, and the reason to read this before changing it:
every screen shows the shell command equivalent to its current form state,
updated as the form changes. The ask it answers is "so I don't have to remember
all the flags" -- and a dashboard that hid the flags would answer it only while
the dashboard was open. Showing the command means the form is a way to *learn*
the flags, and anything done here can be redone, scripted, or pasted into a
decisions-log entry afterwards.

WHY THIS FILE EXISTS SEPARATELY FROM llama_ui_app.py. Textual is an optional
dependency, and this module promises that without it you get the command to
install it rather than a traceback. That promise used to be made by an
`except ImportError: App = None` at the top of one big module -- which did not
work, because the widget classes below it were still defined at import time and
`class CommandBar(Static)` raised `NameError` before `main()` could say
anything. The fix is a module boundary rather than a guard: nothing in this file
imports Textual, `main()` imports the app inside a try, and a missing dependency
therefore *cannot* produce a traceback. A guard has to be remembered every time
a widget is added; a file boundary does not.

Serving configuration is not defined here. The profile fields are read from
`llama-env.sh profile-json` by way of `llama_console`, which keeps that file the
single source of truth (CLAUDE.md) instead of creating a second profile table
that would drift.
"""

from __future__ import annotations

import argparse
import os
import shlex
import signal
import subprocess
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

REPO = Path(__file__).resolve().parent.parent
ENV_SH = REPO / "scripts" / "llama-env.sh"
SYSTEM_DIR = REPO / "prompts" / "system"

# The shell surface, in the one place that owns it. llama_console already asks
# llama-env.sh these questions for `llama-profiles`, and the dashboard used to
# carry a byte-for-byte copy of both calls -- including a second hardcoded
# ["qwen38"] fallback, which is exactly the drift the 2026-09-04 (first) entry
# removed from llama_console and llama_ui in the first place.
from llama_console import profile_names, profile_json   # noqa: E402


def system_names() -> list:
    """The named system prompts on disk, so the picker cannot list a stale set."""
    if not SYSTEM_DIR.is_dir():
        return []
    return sorted(p.stem for p in SYSTEM_DIR.glob("*.txt"))


# -- the database, read-only -------------------------------------------------

_local = threading.local()


def open_store() -> None:
    """Migrate and sweep once, at startup.

    `llama_db.connect()` runs migrate() and sweep_stale_runs() on every call,
    which is right once per process and wrong per keystroke -- the Answers
    screen was opening one of these per cursor movement.
    """
    import llama_db as db
    db.connect().close()


def reader():
    """A per-thread, read-only connection to logs/llama.db.

    Read-only is declared to SQLite rather than merely intended: this dashboard
    is a *reader* of the store and a *caller* of the shell, and PRAGMA
    query_only makes the first half of that enforced instead of reviewed. Every
    write still happens in the subprocess the screen shows you the command for.
    """
    import llama_db as db
    con = getattr(_local, "con", None)
    if con is None:
        con = _local.con = db.connect(sweep=False)
        con.execute("PRAGMA query_only = ON")
    return con


def close_reader() -> None:
    """Drop this thread's connection, if it has one."""
    con = getattr(_local, "con", None)
    if con is not None:
        con.close()
        _local.con = None


# -- running one llama-env.sh command ----------------------------------------

class Command:
    """One llama-env.sh invocation, owning its process group.

    `start_new_session=True` is the whole point. The dashboard runs everything
    through `bash -c "source llama-env.sh && ..."`, so llama-server and
    llama-test are children of that bash and not the process we hold a handle
    to -- and `proc.terminate()` signalled the wrapper alone. That is how a
    dashboard could report "[stopping]" and leave a llama-server holding 5 GB
    on a 6 GB card. A session of its own means the whole tree can be signalled
    together.

    The signals are chosen for what the harness does with them, not for
    politeness:

    - SIGINT is a *clean, resumable* cancel. `llama_test.cmd_suite` catches
      KeyboardInterrupt, reports what it measured, prints the `--resume` line
      and exits 1, so interrupting the group produces the harness's own cancel
      rather than a killed process and a half-written suite.
    - SIGTERM before SIGKILL protects the store. `llama-serve` backgrounds the
      recorder, which calls close_run() on the way out; killing outright leaves
      the run open for sweep_stale_runs() to close as 'stale', so the database
      would record every server the UI stopped as a crash. The grace period is
      what keeps 'clean' meaning clean.
    """

    def __init__(self, command: str, *, env: dict | None = None,
                 plain: bool = False):
        self.command = command
        self.proc: subprocess.Popen | None = None
        self.env = dict(env or os.environ)
        if plain:
            # The output is going into a Log widget, which does its own
            # rendering; Rich's escape codes would be shown, not applied.
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


# -- entry point -------------------------------------------------------------

TABS = ("serve", "live", "tests", "compare", "answers")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse the dashboard's own flags.

    Unknown flags are an error rather than something to ignore. The
    2026-09-04 (second) entry records what the alternative costs: an
    argparse.REMAINDER in llama_test swallowed `--system`, so a run recorded
    itself as having had no system prompt and the measurement was wrong with no
    error anywhere.
    """
    ap = argparse.ArgumentParser(
        prog="llama-ui",
        description="The dashboard over serving, testing and comparison.")
    ap.add_argument("--tab", choices=TABS, default="tests",
                    help="which tab to open on (default: tests)")
    ap.add_argument("--db", metavar="PATH",
                    help="read this database instead of logs/llama.db")
    ap.add_argument("--check", action="store_true",
                    help="run the headless smoke test and exit")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.db:
        # llama_db.db_path() already honours this, so pointing the dashboard at
        # another database needs no code path of its own.
        os.environ["LLAMA_DB"] = str(Path(args.db).expanduser())

    if args.check:
        import llama_ui_check
        return llama_ui_check.main([])

    try:
        from llama_ui_app import LlamaApp
    except ImportError as exc:
        raise SystemExit(
            "llama-ui: this needs textual, which is not installed.\n"
            f"  {REPO}/.venv/bin/pip install -r {REPO}/requirements.txt\n"
            "  (or run any llama-test command, which bootstraps the venv)\n"
            f"  ({exc})")

    app = LlamaApp(initial_tab=args.tab)
    try:
        app.run()
    finally:
        # on_unmount is not guaranteed on an exception path, and a server left
        # running is the failure mode that costs the most here.
        app.stop_jobs()
    return 0


if __name__ == "__main__":
    sys.exit(main())
