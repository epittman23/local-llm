#!/usr/bin/env python3
"""llama_web_routes.py - the API routes behind the web dashboard's pages.

Part of https://github.com/epittman23/local-llm

One APIRouter per page (serve, live, tests, compare, answers, report, tune),
mounted by llama_web.py under /ops/api. None of these reimplements anything:
every route is a thin HTTP wrapper over the same functions the CLI tools call
directly (llama_compare, llama_db, llama_report, llama_test, llama_tune),
which is the rule CompareScreen's docstring stated for the Textual dashboard
this replaces and that stays true here -- a second implementation of any of
these would eventually disagree with the CLI about what it measured.

`shell` is `llama_web`, imported by name for the same reason llama_ui_app.py
imported llama_ui that way: `shell.profile_names()`, never a from-import, so
the headless check can substitute the shell surface without spawning a
process.
"""

from __future__ import annotations

import json
import queue
import shlex
import subprocess
import threading
from types import SimpleNamespace

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, StreamingResponse

import llama_web as shell
from llama_proc import Command

# ---------------------------------------------------------------------------
# shared: streaming a Command's output as SSE
# ---------------------------------------------------------------------------
def sse_from_command(job: Command):
    """Bridge a Command's blocking stdout iterator into an SSE generator.

    `job.lines()` is a plain blocking generator over `Popen.stdout`; it is
    pumped from a background thread into a queue, and the async generator
    below only ever blocks in a threadpool, never the event loop. One line
    per SSE `data:` event, JSON-encoded so a line containing its own
    newlines or a literal "data:" cannot break the framing; a final
    `event: done` carries the process's exit code.
    """
    async def gen():
        q: "queue.Queue" = queue.Queue()

        def pump() -> None:
            for line in job.lines():
                q.put(line)
            q.put(None)

        threading.Thread(target=pump, daemon=True).start()
        while True:
            line = await run_in_threadpool(q.get)
            if line is None:
                break
            yield f"data: {json.dumps(line)}\n\n"
        code = await run_in_threadpool(job.wait)
        yield f"event: done\ndata: {code}\n\n"
    return gen()


def _empty_stream() -> StreamingResponse:
    async def gen():
        return
        yield  # pragma: no cover - makes this an async generator
    return StreamingResponse(gen(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# serve
# ---------------------------------------------------------------------------
serve_router = APIRouter(prefix="/serve", tags=["serve"])


@serve_router.get("/profiles")
async def serve_profiles():
    names = await run_in_threadpool(shell.profile_names)
    return {"profiles": names}


@serve_router.get("/profile/{name}")
async def serve_profile(name: str):
    return await run_in_threadpool(shell.profile_json, name)


def _build_serve_command(profile_name: str, base: dict, form: dict) -> str:
    """The `llama-serve <profile>` invocation for this form state.

    Ports ServeScreen.refresh_command (llama_ui_app.py) unchanged: only
    overrides that actually differ from the profile are passed as env vars,
    so a command line restating the profile's own defaults never suggests
    those were choices made here.
    """
    env: list[str] = []
    overrides = {
        "LLAMA_NGL": form.get("ngl", ""),
        "LLAMA_CTX": form.get("ctx", ""),
        "LLAMA_THREADS": form.get("threads", ""),
        "LLAMA_PARALLEL": form.get("parallel", ""),
        "LLAMA_OT": form.get("ot", ""),
    }
    # A profile with no reasoning_effort in its flags is not a thinking model,
    # so the override is skipped rather than sent to a server that ignores it.
    if base.get("reasoning") and form.get("reasoning"):
        overrides["LLAMA_REASONING"] = form["reasoning"]
    for var, value in overrides.items():
        key = var.replace("LLAMA_", "").lower()
        if value not in (None, "") and str(value) != str(base.get(key, "")):
            env.append(f"{var}={shlex.quote(str(value))}")
    if form.get("spec") == "off":
        env.append("LLAMA_SPEC=off")
    prefix = " ".join(env) + " " if env else ""
    return f"{prefix}llama-serve {shlex.quote(profile_name)}"


@serve_router.post("/start")
async def serve_start(payload: dict):
    profile = payload.get("profile")
    if not profile:
        return JSONResponse({"error": "profile is required"}, status_code=400)
    job = shell.JOBS.get("serve")
    if job and job.running:
        return JSONResponse({"error": "a server is already running from "
                                      "this dashboard"}, status_code=409)
    base = await run_in_threadpool(shell.profile_json, profile)
    command = _build_serve_command(profile, base, payload)
    job = Command(command)
    # Run llama-serve exactly as the shell would, through the same
    # llama-env.sh: this route is a caller of the shell surface, never a
    # reimplementation of it, so telemetry recording and config-id
    # fingerprinting happen identically whether a server was started here or
    # by hand.
    await run_in_threadpool(job.start)
    shell.JOBS["serve"] = job
    return {"started": True}


@serve_router.post("/stop")
async def serve_stop():
    job = shell.JOBS.get("serve")
    if not job or not job.running:
        return {"stopped": False}
    # SIGTERM, 5s grace, then SIGKILL -- killing outright would leave the
    # run's recorder unable to close_run(), and sweep_stale_runs() would then
    # record this stop as a crash rather than a clean shutdown.
    await run_in_threadpool(job.stop)
    return {"stopped": True}


@serve_router.get("/check")
async def serve_check():
    return await run_in_threadpool(_serve_check_sync)


def _serve_check_sync() -> dict:
    try:
        proc = subprocess.run(["bash", str(shell.ENV_SH), "check"],
                              capture_output=True, text=True, timeout=15)
        return {"output": (proc.stdout or proc.stderr or "").strip()}
    except subprocess.TimeoutExpired:
        return {"output": "check timed out after 15s; is the port answering?"}
    except OSError as exc:
        return {"output": f"check failed: {exc}"}


@serve_router.get("/stream")
async def serve_stream():
    job = shell.JOBS.get("serve")
    if not job:
        return _empty_stream()
    return StreamingResponse(sse_from_command(job), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# live
# ---------------------------------------------------------------------------
live_router = APIRouter(prefix="/live", tags=["live"])


@live_router.get("")
async def live():
    return await run_in_threadpool(_live_sync)


def _live_sync() -> dict:
    """The run being recorded right now, exactly as LiveScreen.reload() read it.

    Every figure is derived from stored rows at the moment it is drawn, so
    this is the same arithmetic a finished run's summary will use.
    """
    import llama_db as db
    import llama_stats as stats

    conn = shell.reader()
    rows = db.runs(conn, limit=1, active_only=True) or db.runs(conn, limit=1)
    if not rows:
        return {"run": None}
    run = rows[0]
    samples = db.samples(conn, run["run_id"])
    summary = stats.gpu_stats(samples)
    deltas = db.metrics_delta(conn, run["run_id"])
    requests = db.request_count(conn, run["run_id"])
    headroom = summary.get("vram_headroom_mib")
    warning = (stats.headroom_warning(f"run {run['run_id']}", headroom)
              if samples else None)
    return {"run": run, "summary": summary, "deltas": deltas,
           "requests": requests, "recent_samples": samples[-12:],
           "warning": warning.lstrip("> ") if warning else None}


# ---------------------------------------------------------------------------
# tests
# ---------------------------------------------------------------------------
tests_router = APIRouter(prefix="/tests", tags=["tests"])

_test_lock = threading.Lock()
_test_state: dict = {"thread": None, "queue": None, "stop": None}


@tests_router.get("/options")
async def tests_options():
    return await run_in_threadpool(
        lambda: {"tiers": ["smoke", "standard", "full"],
                "benchmarks": ["", "humaneval", "mbpp", "ds1000"],
                "systems": shell.system_names()})


def _run_suite_job(tier: str, benchmark: str | None, resume: bool,
                   system: str | None, q: "queue.Queue",
                   stop_event: threading.Event) -> None:
    """Runs in a background thread; every message crosses to the API via q."""
    import llama_results as store
    import llama_test
    from llama_console import console

    con = console()
    args = SimpleNamespace(profile=None, suite=tier, benchmark=benchmark,
                           slice=None, system=system, resume=resume,
                           run_id=None, show=False)
    conn = None
    try:
        ctx, todo, skipped = llama_test.prepare_suite(args, con)
        conn = ctx["db"]
        q.put({"type": "start", "suite_run_id": ctx["suite_run_id"],
              "total": len(todo), "skipped": len(skipped)})
        results: list[dict] = []

        def on_record(record: dict) -> None:
            passed, attempted, rate = store.pass_rate(results)
            q.put({"type": "item", "benchmark": record["benchmark"],
                  "item_id": record["item_id"], "outcome": record["outcome"],
                  "reason": record.get("reason", ""), "i": len(results),
                  "total": len(todo), "passed": passed, "attempted": attempted})

        llama_test.run_items(todo, ctx, con, show=False, results=results,
                             on_record=on_record, should_stop=stop_event.is_set)
        passed, attempted, rate = store.pass_rate(results)
        q.put({"type": "done", "passed": passed, "attempted": attempted,
              "cancelled": stop_event.is_set()})
    except llama_test.ServerGone as exc:
        q.put({"type": "error", "message": str(exc)})
    except Exception as exc:  # noqa: BLE001 - surfaced to the browser, not swallowed
        q.put({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
    finally:
        if conn is not None:
            conn.close()
        q.put(None)


@tests_router.post("/run")
async def tests_run(payload: dict):
    with _test_lock:
        thread = _test_state.get("thread")
        if thread and thread.is_alive():
            return JSONResponse({"error": "a suite is already running"},
                                status_code=409)
        q: "queue.Queue" = queue.Queue()
        stop_event = threading.Event()
        thread = threading.Thread(
            target=_run_suite_job,
            args=(payload.get("tier") or "smoke", payload.get("benchmark") or None,
                 bool(payload.get("resume")), payload.get("system") or None,
                 q, stop_event),
            daemon=True)
        _test_state.update(thread=thread, queue=q, stop=stop_event)
        thread.start()
    return {"started": True}


@tests_router.post("/cancel")
async def tests_cancel():
    """Set the should_stop flag run_items() polls before each item.

    Not an OS signal -- there is no subprocess to signal, the suite is
    running in-process. Per-item autocommit in run_item() makes this exactly
    as resumable as the CLI's SIGINT cancel: the next run with --resume picks
    up wherever should_stop actually took effect.
    """
    stop_event = _test_state.get("stop")
    if stop_event is None:
        return {"cancelled": False}
    stop_event.set()
    return {"cancelled": True}


@tests_router.get("/stream")
async def tests_stream():
    q = _test_state.get("queue")
    if q is None:
        return _empty_stream()

    async def gen():
        while True:
            item = await run_in_threadpool(q.get)
            if item is None:
                break
            yield f"data: {json.dumps(item)}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# compare
# ---------------------------------------------------------------------------
compare_router = APIRouter(prefix="/compare", tags=["compare"])


@compare_router.get("")
async def compare(by: str = "config", tier: str = ""):
    return await run_in_threadpool(_compare_sync, by, tier or None)


def _compare_sync(by: str, tier: str | None) -> dict:
    """The exact sequence CompareScreen.reload() used, read through llama_compare.

    Not reimplemented here: the caveats, the counts-beside-every-rate rule
    and the ranking are the same ones `llama-test compare` prints, and a
    second implementation would be a second place for those rules to drift.
    """
    import llama_compare
    import llama_db as db
    import llama_results as store

    conn = shell.reader()
    if by == "serving":
        rows, derived, notes = llama_compare.serving_rows(conn)
        return {"columns": llama_compare.SERVING_COLUMNS, "rows": rows,
               "derived_columns": llama_compare.DERIVED_COLUMNS,
               "derived": derived,
               "notes": [n.lstrip("> ") for n in notes]}

    records = store.read_all(conn, tier=tier)
    if not records:
        return {"columns": [], "rows": [],
               "notes": ["No test results yet. Run a suite on the Tests page."]}
    groups = llama_compare.group_records(records)
    blocks = db.configs(conn)
    notes = llama_compare.caveats(groups, blocks) + llama_compare.exclusion_note(conn)

    if by == "benchmark":
        columns, rows = llama_compare.benchmark_rows(groups)
    elif by == "failures":
        columns, rows = llama_compare.failure_rows(groups)
        notes = []
    else:
        columns, rows = llama_compare.COLUMNS, llama_compare.rows_for(groups, blocks)
    return {"columns": columns, "rows": rows,
           "notes": [n.lstrip("> ") for n in notes]}


@compare_router.post("/export-answers")
async def compare_export_answers():
    return await run_in_threadpool(_export_answers_sync)


def _export_answers_sync() -> dict:
    """Writes the old logs/answers/<run>/ layout out of the database on demand."""
    import llama_db as db
    import llama_results as store
    import llama_test

    conn = shell.reader()
    run = store.latest_run(conn)
    if not run:
        return {"written": 0, "note": "nothing recorded to export"}
    out = shell.REPO / "logs" / "answers" / run
    out.mkdir(parents=True, exist_ok=True)
    written = 0
    for r in db.results(conn):
        if r["suite_run_id"] != run:
            continue
        answer = db.answer_for(conn, r["benchmark"], r["item_id"], run)
        if not answer:
            continue
        name = f"{r['benchmark']}_{r['item_id']}".replace("/", "_")
        (out / f"{name}.md").write_text(llama_test._answer_document(answer))
        written += 1
    return {"written": written, "dir": str(out)}


# ---------------------------------------------------------------------------
# answers
# ---------------------------------------------------------------------------
answers_router = APIRouter(prefix="/answers", tags=["answers"])


@answers_router.get("/runs")
async def answers_runs():
    return await run_in_threadpool(_answers_runs_sync)


def _answers_runs_sync() -> dict:
    import llama_db as db
    return {"runs": db.suite_runs(shell.reader())}


@answers_router.get("")
async def answers(run: str = "", filter: str = "failures"):  # noqa: A002
    return await run_in_threadpool(_answers_sync, run or None, filter)


def _answers_sync(run: str | None, wanted_: str) -> dict:
    import llama_db as db
    import llama_results as store

    if not run:
        return {"rows": []}
    conn = shell.reader()
    rows = []
    for r in db.results(conn):
        if r["suite_run_id"] != run:
            continue
        outcome = r.get("outcome")
        if wanted_ == "failures" and outcome not in store.FAILURES:
            continue
        if wanted_ == "pass" and outcome != store.PASS:
            continue
        if outcome == store.SKIPPED:
            continue
        rows.append({"benchmark": r["benchmark"], "item_id": r["item_id"],
                     "outcome": outcome, "reason": (r.get("reason") or "")[:200],
                     "reasoning_chars": r.get("reasoning_chars")})
    return {"rows": rows}


@answers_router.get("/one")
async def answers_one(run: str = "", benchmark: str = "", item_id: str = "",
                      thinking: int = 0):
    return await run_in_threadpool(
        _answer_one_sync, run or None, benchmark, item_id, bool(thinking))


def _answer_one_sync(run: str | None, benchmark: str, item_id: str,
                     thinking: bool) -> dict:
    import llama_db as db
    import llama_test

    conn = shell.reader()
    answer = db.answer_for(conn, benchmark, item_id, run)
    if not answer:
        return {"error": f"no stored answer for {benchmark}/{item_id}"}
    if not thinking:
        # Dropped from the copy rather than the row: a reasoning trace can run
        # to tens of thousands of characters and is never graded, so it never
        # crosses the wire unless the toggle is on.
        answer = dict(answer, reasoning="")
    return {"markdown": llama_test._answer_document(answer, collapse=False)}


# ---------------------------------------------------------------------------
# report
# ---------------------------------------------------------------------------
report_router = APIRouter(prefix="/report", tags=["report"])


@report_router.post("")
async def report_build(payload: dict):
    return await run_in_threadpool(_report_build_sync, payload)


def _report_build_sync(payload: dict) -> dict:
    """Renders llama_report.build()'s own markdown+PNG output, unmodified.

    Deliberately not refactored to return structured data: llama_report.py is
    the module CLAUDE.md's decisions log describes as carefully re-audited
    for subtle figure bugs, and a second output path through it is a second
    way for that class of bug to come back for no real gain over markdown and
    images the browser can already render.
    """
    import datetime as dt

    import llama_db as db

    try:
        import llama_report
    except SystemExit:
        return {"error": "llama-report needs scipy.\n"
                         "  install: <repo>/.venv/bin/pip install -r "
                         "requirements-extra.txt"}

    tier = payload.get("tier") or None
    model = payload.get("model") or None
    benchmark = payload.get("benchmark") or None
    no_figures = bool(payload.get("no_figures"))

    con = llama_report.open_readonly(db.db_path())
    try:
        records = db.results(con, tier=tier, model=model)
        if benchmark:
            records = [r for r in records if r.get("benchmark") == benchmark]
        if not records:
            return {"error": "no results match those filters"}

        filters = {"tier": tier, "model": model, "benchmark": benchmark,
                  "db": None}
        # Synthesized rather than empty: the document's provenance line quotes
        # this verbatim ("Generated by `llama-report ...`"), and a reader
        # should be able to paste it into a terminal and reproduce the same
        # report, even though this run was actually started from the browser.
        argv = []
        for flag, value in (("--tier", tier), ("--model", model),
                            ("--benchmark", benchmark)):
            if value:
                argv += [flag, value]
        if no_figures:
            argv.append("--no-figures")

        date = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
        outdir = shell.REPORT_DIR / date
        outdir.mkdir(parents=True, exist_ok=True)
        figs = llama_report.Figures(outdir, enabled=not no_figures)
        document = llama_report.build(con, db.db_path(), records, filters,
                                      figs, argv)
        (outdir / "report.md").write_text(document, encoding="utf-8")
        return {"markdown_url": f"/ops/reports/{date}/report.md",
               "figures": [f"/ops/reports/{date}/{name}"
                          for name in figs.written],
               "date": date}
    finally:
        con.close()


# ---------------------------------------------------------------------------
# tune
# ---------------------------------------------------------------------------
tune_router = APIRouter(prefix="/tune", tags=["tune"])

# The subset of `llama-tune run`'s ~25 flags exposed as named form fields; the
# long tail is reachable through `extra_args` (appended verbatim) rather than
# by growing this form to match the CLI one flag at a time.
_TUNE_FLAGS = (("--tier", "tier"), ("--benchmark", "benchmark"),
              ("--system", "system"), ("--budget", "budget"),
              ("--stages", "stages"), ("--seed", "seed"))


def _build_tune_command(payload: dict) -> str:
    parts = ["llama-tune", "run"]
    profile = payload.get("profile")
    if profile:
        parts.append(shlex.quote(str(profile)))
    for flag, key in _TUNE_FLAGS:
        value = payload.get(key)
        if value not in (None, ""):
            parts += [flag, shlex.quote(str(value))]
    extra = (payload.get("extra_args") or "").strip()
    if extra:
        parts.append(extra)
    return " ".join(parts)


@tune_router.post("/start")
async def tune_start(payload: dict):
    job = shell.JOBS.get("tune")
    if job and job.running:
        return JSONResponse({"error": "a sweep is already running from "
                                      "this dashboard"}, status_code=409)
    command = _build_tune_command(payload)
    job = Command(command, plain=True)
    await run_in_threadpool(job.start)
    shell.JOBS["tune"] = job
    return {"started": True}


@tune_router.post("/resume")
async def tune_resume(payload: dict):
    job = shell.JOBS.get("tune")
    if job and job.running:
        return JSONResponse({"error": "a sweep is already running from "
                                      "this dashboard"}, status_code=409)
    sweep_id = payload.get("sweep_id") or ""
    command = "llama-tune resume" + (f" {shlex.quote(sweep_id)}" if sweep_id else "")
    job = Command(command, plain=True)
    await run_in_threadpool(job.start)
    shell.JOBS["tune"] = job
    return {"started": True}


@tune_router.post("/stop")
async def tune_stop():
    job = shell.JOBS.get("tune")
    if not job or not job.running:
        return {"stopped": False}
    await run_in_threadpool(job.stop)
    return {"stopped": True}


@tune_router.get("/status")
async def tune_status(sweep_id: str = ""):
    return await run_in_threadpool(_tune_status_sync, sweep_id or None)


def _tune_status_sync(sweep_id: str | None) -> dict:
    import llama_db as db

    conn = shell.reader()
    sid = sweep_id or db.latest_sweep(conn)
    if not sid:
        return {"sweep": None}
    return {"sweep": db.sweep(conn, sid), "rounds": db.sweep_rounds(conn, sid),
           "visits": db.sweep_visits(conn, sid),
           "candidates": db.sweep_candidates(conn, sid)}


@tune_router.get("/log")
async def tune_log():
    job = shell.JOBS.get("tune")
    if not job:
        return _empty_stream()
    return StreamingResponse(sse_from_command(job), media_type="text/event-stream")
