#!/usr/bin/env python3
"""llama_ui_check.py - the headless smoke test for the dashboard.

Part of https://github.com/epittman23/local-llm

Reached as `llama-ui --check` or `llama-test ui --check`. It drives the real
app through Textual's own `App.run_test()` against a fixture database, so it
exercises the widgets rather than a model of them.

It is here and not under `tests/` on purpose: in this repo `tests/` means
benchmark items, and CLAUDE.md says the TOMLs in it "are the only hand-written
test artifacts". It is also not a pytest suite -- there is no pytest in
`requirements.txt` and adding one to run five assertions would be a dependency
bought with the project's own stated caution about them.

The fixture is built with `llama_db`'s own writers rather than hand-written
SQL, so it cannot drift from the schema, and building it doubles as a check
that MIGRATIONS still applies cleanly to an empty file.

THE CONSTRAINT THIS FILE IMPOSES on llama_ui_app.py: the shell surface is
reached as `shell.profile_names()` through `import llama_ui as shell`, never
`from llama_ui import profile_names`. Check 10 substitutes those two functions
so that mounting the app spawns no process; a from-import binds the real ones
at import time and cannot be substituted.
"""

from __future__ import annotations

import asyncio
import io
import os
import shutil
import subprocess
import sys
import tempfile
from contextlib import closing, redirect_stderr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

REPO = Path(__file__).resolve().parent.parent

PROFILE_STUB = {
    "qwen36": {"ngl": "99", "ctx": "65536", "threads": "6", "parallel": "1",
               "ot": "", "reasoning": "medium", "moe": "34",
               "model": "/models/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf",
               "weights_present": True},
    "qwen25c": {"ngl": "99", "ctx": "16384", "threads": "6", "parallel": "1",
                "ot": "", "reasoning": "",
                "model": "/models/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
                "weights_present": True},
}

CONFIG_LINES = [
    "arch: qwen3moe | ngl: 99 | ctx: 65536 (total) | parallel: 1 | "
    "threads: 6 | moe: 34",
    "override-tensors: n/a",
    "speculative: off",
    "cache: k=q8_0 v=q8_0 | fa: on | batch: 512 | ubatch: 512",
    "reasoning effort: medium",
    "samplers: temp 0.7 | top-p 0.8",
]


# ---------------------------------------------------------------------------
# the fixture
# ---------------------------------------------------------------------------
def build_fixture(path: Path) -> None:
    """A store with one serving run, its samples, and one graded suite run.

    Two results, one pass and one failure, because the Answers screen defaults
    to failures and an empty table there would make check 3 pass vacuously.
    """
    import llama_db as db

    os.environ["LLAMA_DB"] = str(path)
    with closing(db.connect(path)) as con:
        db.upsert_config(con, "abc12345", "qwen3.6-35b-a3b", CONFIG_LINES)
        run_id = db.open_run(con, "abc12345", model="Qwen3.6-35B-A3B",
                             quant="UD-Q4_K_XL", build="95b8e33e1/10597",
                             port=8090, pid=os.getpid())
        for i in range(12):
            db.add_sample(con, run_id, {
                "at": f"2026-09-04T12:00:{i:02d}Z", "temp_c": 60 + i,
                "util_pct": 0 if i < 4 else 90, "mem_used_mib": 5000 + 20 * i,
                "mem_total_mib": 6144, "power_w": 40.0 + i,
                "sm_mhz": 1200 + 10 * i, "throttle": 1})
        db.add_metrics(con, run_id, "2026-09-04T12:00:00Z",
                       {"llamacpp:prompt_tokens_total": 0.0,
                        "llamacpp:tokens_predicted_total": 0.0})
        db.add_metrics(con, run_id, "2026-09-04T12:00:11Z",
                       {"llamacpp:prompt_tokens_total": 120.0,
                        "llamacpp:tokens_predicted_total": 958.0})

        suite = "20260904T120000Z-fixture"
        common = {"suite_run_id": suite, "run_id": run_id,
                  "config_id": "abc12345", "model": "Qwen3.6-35B-A3B",
                  "profile": "qwen36", "dataset_revision": "fixture",
                  "tier": "smoke", "seed": 1,
                  "timings": {"prompt_n": 120, "prompt_ms": 1600.0,
                              "predicted_n": 480, "predicted_ms": 60000.0},
                  "params": {"temperature": 0}, "wall_ms": 61600.0}
        db.add_result(con, dict(common, at="2026-09-04T12:00:05Z",
                                benchmark="humaneval", item_id="HumanEval/0",
                                outcome="pass", reason="",
                                reasoning_chars=4210),
                      {"prompt": "Write has_close_elements.",
                       "content": "```python\ndef has_close_elements(x):\n"
                                  "    return False\n```",
                       "reasoning": "FIXTURE-THINKING considering the pairs."})
        db.add_result(con, dict(common, at="2026-09-04T12:00:09Z",
                                benchmark="ds1000", item_id="295",
                                outcome="fail_assert",
                                reason="AssertionError: arrays differ",
                                reasoning_chars=9100),
                      {"prompt": "Use np.eye to one-hot encode a.",
                       "content": "```python\nresult = a\n```",
                       "reasoning": "FIXTURE-THINKING one hot encoding."})
        db.close_run(con, run_id)
        con.commit()


# ---------------------------------------------------------------------------
# check 1 -- the degradation promise, enforced under bare python3
# ---------------------------------------------------------------------------
def check_import_is_stdlib() -> str | None:
    """`import llama_ui` must not pull in textual.

    This is the whole reason llama_ui_app.py is a separate file. A guarded
    import in one module cannot express it -- the previous version had one,
    and a widget subclass three lines below defeated it -- but a module that
    never names textual can, and this is what says so out loud.

    Run under a python3 off PATH rather than sys.executable, which is the
    venv's and would have textual importable; the recorder runs under exactly
    this interpreter, so it is the one the promise is about.
    """
    python3 = shutil.which("python3", path="/usr/bin:/bin") or "python3"
    code = ("import sys; sys.path.insert(0, %r); import llama_ui; "
            "sys.exit(1 if 'textual' in sys.modules else 0)"
            % str(Path(__file__).resolve().parent))
    proc = subprocess.run([python3, "-c", code], capture_output=True, text=True)
    if proc.returncode == 1:
        return "importing llama_ui pulled textual into sys.modules"
    if proc.returncode != 0:
        return f"{python3} could not import llama_ui: {proc.stderr.strip()}"
    return None


# ---------------------------------------------------------------------------
# check 11 -- an unknown flag is an error, never a silent no-op
# ---------------------------------------------------------------------------
def check_unknown_flag() -> str | None:
    """The lesson of the 2026-09-04 (second) entry, kept from recurring.

    An argparse REMAINDER swallowed --system there, so a run recorded itself
    as having had no system prompt: a wrong measurement with no error
    anywhere. An unknown flag must exit 2.
    """
    import llama_ui

    try:
        with redirect_stderr(io.StringIO()):
            llama_ui.main(["--nonsense"])
    except SystemExit as exc:
        if exc.code == 2:
            return None
        return f"--nonsense exited {exc.code}, expected 2"
    return "--nonsense was accepted"


# ---------------------------------------------------------------------------
# checks 2, 3 and 10 -- the app itself
# ---------------------------------------------------------------------------
class SpawnCounter:
    """Counts every subprocess start, so check 10 can assert there were none.

    Not a mock of the shell surface -- that is stubbed separately. This catches
    the case the stub cannot: some *other* path shelling out on mount, which is
    what the module-level `PROFILES = profile_names()` used to do at import.
    """

    def __init__(self):
        self.calls: list = []
        self._popen = subprocess.Popen

    def __enter__(self):
        outer = self

        # Popen alone, because subprocess.run() reaches it by module-global
        # lookup and so is counted through it. Wrapping both counted every
        # run() twice.
        class CountingPopen(self._popen):        # type: ignore[misc, valid-type]
            def __init__(self, args, *a, **kw):
                outer.calls.append(args)
                super().__init__(args, *a, **kw)

        subprocess.Popen = CountingPopen         # type: ignore[misc]
        return self

    def __exit__(self, *exc):
        subprocess.Popen = self._popen           # type: ignore[misc]


async def drive_app() -> list[str]:
    """Mount the app at 80x24 and read every CommandBar back.

    run_test() already defaults to headless at 80x24, which is this terminal's
    size, so the floor the layout has to survive is enforced by the harness
    rather than asserted as a magic number here.
    """
    import llama_ui as shell
    from llama_ui_app import CommandBar, LlamaApp

    shell.profile_names = lambda: list(PROFILE_STUB)
    shell.profile_json = lambda name: dict(PROFILE_STUB.get(name, {}))

    failures = []
    app = LlamaApp(initial_tab="tests")
    async with app.run_test() as pilot:
        await pilot.pause()
        # The profile load is a thread worker; without waiting for it the
        # Serve CommandBar would be read before it had anything to say.
        await app.workers.wait_for_complete()
        await pilot.pause()

        bars = {bar.id: bar.command for bar in app.query(CommandBar)}
        if not bars:
            failures.append("the app mounted with no CommandBar at all")
        for bar_id, command in sorted(bars.items()):
            if not command:
                failures.append(f"#{bar_id} is empty")
            elif not command.split("llama-", 1)[-1].startswith(
                    ("serve", "test", "db")):
                failures.append(f"#{bar_id} is not a shell command: {command!r}")
    return failures


def check_app() -> list[str]:
    with SpawnCounter() as spawns:
        try:
            failures = asyncio.run(drive_app())
        except Exception as exc:                 # the app must simply mount
            return [f"the app raised on mount: {type(exc).__name__}: {exc}"]
    if spawns.calls:
        failures.append(
            f"{len(spawns.calls)} subprocess(es) spawned while mounting: "
            f"{spawns.calls[0]}")
    return failures


# ---------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    checks = []
    with tempfile.TemporaryDirectory(prefix="llama-ui-check-") as tmp:
        build_fixture(Path(tmp) / "fixture.db")
        checks.append(("1  import llama_ui is stdlib-only",
                       [x for x in [check_import_is_stdlib()] if x]))
        checks.append(("11 an unknown flag exits 2",
                       [x for x in [check_unknown_flag()] if x]))
        checks.append(("2,3,10 the app mounts, shows commands, spawns nothing",
                       check_app()))

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
