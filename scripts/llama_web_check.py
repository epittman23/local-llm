#!/usr/bin/env python3
"""llama_web_check.py - the headless smoke test for the web dashboard.

Part of https://github.com/epittman23/local-llm

Reached as `llama-web --check`. It drives the real FastAPI app through
`fastapi.testclient.TestClient` against a fixture database, the same idea
`llama_ui_check.py` used for the Textual dashboard this replaces: build a
store with `llama_db`'s own writers so the fixture cannot drift from the
schema, then exercise the real app rather than a model of it.

It is here and not under `tests/` on purpose, for the same reason the file it
replaces said so: in this repo `tests/` means benchmark items, and CLAUDE.md
says the TOMLs in it "are the only hand-written test artifacts". It is also
not a pytest suite -- adding one to run a handful of assertions would be a
dependency bought with this project's own stated caution about them.
"""

from __future__ import annotations

import io
import os
import sys
import tempfile
from contextlib import closing, redirect_stderr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

REPO = Path(__file__).resolve().parent.parent

CONFIG_LINES = [
    "arch: qwen3moe | ngl: 99 | ctx: 65536 (total) | parallel: 1 | "
    "threads: 6 | moe: 34",
    "override-tensors: n/a",
    "speculative: off",
    "cache: k=q8_0 v=q8_0 | fa: on | batch: 512 | ubatch: 512",
    "reasoning effort: medium",
]


# ---------------------------------------------------------------------------
# the fixture
# ---------------------------------------------------------------------------
def build_fixture(path: Path) -> None:
    """A store with one serving run, its samples, and one graded suite run."""
    import llama_db as db

    os.environ["LLAMA_DB"] = str(path)
    with closing(db.connect(path)) as con:
        db.upsert_config(con, "abc12345", "qwen3.6-35b-a3b", CONFIG_LINES)
        run_id = db.open_run(con, "abc12345", model="Qwen3.6-35B-A3B",
                             quant="UD-Q4_K_XL", build="95b8e33e1/10597",
                             port=8090, pid=os.getpid())
        db.add_sample(con, run_id, {
            "at": "2026-09-06T12:00:00Z", "temp_c": 61, "util_pct": 90,
            "mem_used_mib": 5200, "mem_total_mib": 6144, "power_w": 45.0,
            "sm_mhz": 1300, "throttle": 1})
        db.add_metrics(con, run_id, "2026-09-06T12:00:00Z",
                       {"llamacpp:prompt_tokens_total": 0.0,
                        "llamacpp:tokens_predicted_total": 0.0})

        suite = "20260906T120000Z-fixture"
        common = {"suite_run_id": suite, "run_id": run_id,
                  "config_id": "abc12345", "model": "Qwen3.6-35B-A3B",
                  "profile": "qwen36", "dataset_revision": "fixture",
                  "tier": "smoke", "seed": 1,
                  "timings": {"prompt_n": 120, "prompt_ms": 1600.0,
                              "predicted_n": 480, "predicted_ms": 60000.0},
                  "params": {"temperature": 0}, "wall_ms": 61600.0}
        db.add_result(con, dict(common, at="2026-09-06T12:00:05Z",
                                benchmark="humaneval", item_id="HumanEval/0",
                                outcome="pass", reason="", reasoning_chars=100),
                      {"prompt": "Write has_close_elements.",
                       "content": "```python\ndef f():\n    return True\n```",
                       "reasoning": "FIXTURE-THINKING."})
        db.add_result(con, dict(common, at="2026-09-06T12:00:09Z",
                                benchmark="ds1000", item_id="295",
                                outcome="fail_assert", reason="arrays differ",
                                reasoning_chars=200),
                      {"prompt": "Use np.eye.", "content": "```python\nresult = a\n```",
                       "reasoning": "FIXTURE-THINKING two."})
        db.close_run(con, run_id)
        con.commit()


# ---------------------------------------------------------------------------
# checks
# ---------------------------------------------------------------------------
def check_unknown_flag() -> str | None:
    """The lesson of the 2026-09-04 (second) entry, kept from recurring.

    A REMAINDER argument once swallowed a flag silently elsewhere in this
    project; llama_web.py's parser has none, and this is the regression
    guard that says so stays true.
    """
    import llama_web

    try:
        with redirect_stderr(io.StringIO()):
            llama_web.parse_args(["--nonsense"])
    except SystemExit as exc:
        if exc.code == 2:
            return None
        return f"--nonsense exited {exc.code}, expected 2"
    return "--nonsense was accepted"


def check_pages_and_api() -> list[str]:
    """Every page's HTML shell, every static asset, and one call per API
    router, all against the fixture database and a real TestClient.
    """
    import llama_web
    from fastapi.testclient import TestClient

    failures: list[str] = []
    app = llama_web.create_app()
    with TestClient(app) as client:
        for path in ("/ops", "/ops/serve", "/ops/live", "/ops/tests",
                    "/ops/compare", "/ops/answers", "/ops/report", "/ops/tune",
                    "/ops/this-does-not-exist"):
            r = client.get(path)
            if r.status_code != 200 or "local-llm dashboard" not in r.text:
                failures.append(f"{path}: expected the SPA shell, got "
                               f"{r.status_code}")

        for path in ("/ops/static/app.js", "/ops/static/style.css",
                    "/ops/static/vendor/marked.min.js"):
            r = client.get(path)
            if r.status_code != 200:
                failures.append(f"{path}: {r.status_code}")

        for path, method in (
            ("/ops/api/live", "get"),
            ("/ops/api/tests/options", "get"),
            ("/ops/api/compare?by=config", "get"),
            ("/ops/api/compare?by=serving", "get"),
            ("/ops/api/compare?by=failures", "get"),
            ("/ops/api/answers/runs", "get"),
            ("/ops/api/tune/status", "get"),
        ):
            r = getattr(client, method)(path)
            if r.status_code != 200:
                failures.append(f"{method.upper()} {path}: {r.status_code} "
                               f"{r.text[:200]}")

        # A lookup for an item that was never recorded must be a handled
        # {"error": ...} response, not a 500 -- the browser calls this for
        # whatever row the user happens to click.
        r = client.get("/ops/api/answers/one",
                       params={"run": "nope", "benchmark": "x", "item_id": "y"})
        if r.status_code != 200 or "error" not in r.json():
            failures.append(f"answers/one for a missing item: {r.status_code} "
                           f"{r.text[:200]}")

    return failures


# ---------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    checks = []
    with tempfile.TemporaryDirectory(prefix="llama-web-check-") as tmp:
        build_fixture(Path(tmp) / "fixture.db")
        checks.append(("1  an unknown flag exits 2",
                       [x for x in [check_unknown_flag()] if x]))
        checks.append(("2  every page and API route responds",
                       check_pages_and_api()))

    bad = 0
    for name, failures in checks:
        print(f"{'FAIL' if failures else 'ok  '}  {name}")
        for failure in failures:
            print(f"        {failure}")
        bad += bool(failures)
    print(f"\n{len(checks) - bad}/{len(checks)} checks passed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
