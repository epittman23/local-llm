#!/usr/bin/env python3
"""llama_web.py - the entry point and shell surface for the web dashboard.

Part of https://github.com/epittman23/local-llm

Reached as `llama-web`. It replaced the Textual dashboard (llama_ui.py /
llama_ui_app.py) on 2026-09-06 so the project could be used entirely from a
browser, reachable at the same port as Open WebUI through the Caddy proxy in
open-web-ui/ (see README.md and CLAUDE.md's decisions log). The routes
themselves live in llama_web_routes.py; what is here is app assembly, argument
parsing, the database reader, and the job registry -- everything that stays
the same regardless of which page is being served.

Two conventions carried over from llama_ui.py, and the reasons for both are
unchanged:

  * The shell surface is reached as `shell.profile_names()` through `import
    llama_web as shell`, never `from llama_web import profile_names`. The
    lookup has to happen at call time so the headless check can substitute it;
    a from-import binds at import time and cannot be.
  * Serving configuration is not defined here. Profile fields come from
    `llama-env.sh profile-json` by way of `llama_console`, which keeps that
    file the single source of truth (CLAUDE.md) instead of creating a second
    profile table that would drift.

FastAPI and uvicorn are hard requirements of this module, unlike Textual's
optional degrade in the file this replaces: there is no plain-text fallback
for a web dashboard, so a missing dependency is a clear install message at
startup rather than a promise this module could otherwise keep.

`uvicorn.run(..., workers=1)` is not a default left alone -- it is load
bearing. The job registry (JOBS) and the per-thread database reader live in
this process's memory; a second worker process would have its own empty copy
of both; and could not stop a server or a suite run started against the
other one.
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
from contextlib import asynccontextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

REPO = Path(__file__).resolve().parent.parent
ENV_SH = REPO / "scripts" / "llama-env.sh"
SYSTEM_DIR = REPO / "prompts" / "system"
STATIC_DIR = Path(__file__).resolve().parent / "llama_web_static"
REPORT_DIR = REPO / "logs" / "report"

try:
    from fastapi import FastAPI
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles
except ImportError as exc:
    raise SystemExit(
        "llama-web: this needs fastapi and uvicorn, which are not installed.\n"
        f"  {REPO}/.venv/bin/pip install -r {REPO}/requirements-extra.txt\n"
        f"  ({exc})")

from llama_console import profile_json, profile_names  # noqa: E402
from llama_proc import Command                          # noqa: E402


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
    which is right once per process and wrong per request.
    """
    import llama_db as db
    db.connect().close()


def reader():
    """A per-thread, read-only connection to logs/llama.db.

    Read-only is declared to SQLite rather than merely intended: this
    dashboard is a *reader* of the store and a *caller* of the shell, and
    PRAGMA query_only makes the first half of that enforced instead of
    reviewed. Every write still happens in the subprocess a route started.
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


# -- running llama-env.sh commands -------------------------------------------
# One slot per kind of long-lived job this dashboard can start. A second
# "start" while one is already running is refused by the route, not silently
# overwritten -- overwriting the dict entry would leak the first process
# with nothing left holding a handle to stop it.
JOBS: dict[str, Command] = {}


def stop_jobs() -> None:
    """Stop every subprocess this process started. Safe to call twice."""
    for job in list(JOBS.values()):
        if job.running:
            job.stop()


@asynccontextmanager
async def lifespan(app: FastAPI):
    open_store()
    yield
    stop_jobs()


def create_app() -> FastAPI:
    app = FastAPI(title="local-llm dashboard", lifespan=lifespan)

    from llama_web_routes import (answers_router, compare_router,
                                  live_router, report_router, serve_router,
                                  tests_router, tune_router)
    for router in (serve_router, live_router, tests_router, compare_router,
                  answers_router, report_router, tune_router):
        app.include_router(router, prefix="/ops/api")

    # Order matters: Starlette matches routes/mounts in registration order,
    # so the specific paths (api routers above, the two mounts below) have to
    # be registered before the catch-all SPA route at the bottom, or that
    # route would shadow all of them.
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    app.mount("/ops/reports", StaticFiles(directory=REPORT_DIR), name="reports")
    app.mount("/ops/static", StaticFiles(directory=STATIC_DIR), name="static")

    index_html = STATIC_DIR / "index.html"

    @app.get("/ops")
    @app.get("/ops/{_path:path}")
    async def spa(_path: str = "") -> FileResponse:
        """Every other /ops/* path is a client-side route, not a file.

        The dashboard is a single page with History-API routing (/ops/tests,
        /ops/compare, ...), so a direct load or a reload of any of those has
        to come back here and let the router in index.html take it from
        there, rather than 404 for not being a file on disk.
        """
        return FileResponse(index_html)

    return app


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        prog="llama-web",
        description="The web dashboard over serving, testing, comparison, "
                    "reports and tuning.")
    ap.add_argument("--host", default=os.environ.get("LLAMA_WEB_HOST", "0.0.0.0"),
                    help="bind address (default 0.0.0.0, so the Caddy proxy "
                         "container can reach it via host.docker.internal)")
    ap.add_argument("--port", type=int,
                    default=int(os.environ.get("LLAMA_WEB_PORT", 8095)))
    ap.add_argument("--db", metavar="PATH",
                    help="read this database instead of logs/llama.db")
    ap.add_argument("--check", action="store_true",
                    help="run the headless smoke test and exit")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.db:
        # llama_db.db_path() already honours this, so pointing the dashboard
        # at another database needs no code path of its own.
        os.environ["LLAMA_DB"] = str(Path(args.db).expanduser())

    if args.check:
        import llama_web_check
        return llama_web_check.main([])

    # Built here, not at module import time. llama_web_routes imports this
    # module back (`import llama_web as shell`), and building the app eagerly
    # at the top of the file would make that back-import re-enter create_app()
    # before llama_web_routes had finished defining its routers -- the same
    # reason llama_ui.py never built LlamaApp until main() ran.
    app = create_app()
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, workers=1,
               log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
