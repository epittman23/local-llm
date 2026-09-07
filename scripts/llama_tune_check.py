#!/usr/bin/env python3
"""llama_tune_check.py - exercise llama-tune's algorithm without a GPU.

Part of https://github.com/epittman23/local-llm

Reached as `llama-tune --check` is not a thing (llama-tune has no dashboard to
smoke-test); this is run directly: `.venv/bin/python scripts/llama_tune_check.py`.
It follows the convention `llama_web_check.py` sets: not under `tests/` (that
directory is benchmark items, per CLAUDE.md), not pytest (there is no pytest in
requirements.txt), each check a function returning a list of failure strings.

What this checks and why it can, with no GPU. `llama_tune.py`'s algorithm --
successive halving, the paired log-ratio elimination, drift detection, the
cooldown loop, the correctness guard -- is server-agnostic: it reacts to what a
served candidate returns, not to how the tokens were generated. So the launcher
is pluggable (`LLAMA_TUNE_LAUNCH`), and `llama_tune_stub.py` stands in for
`llama-serve`: a stdlib HTTP server whose throughput is a deterministic
function of the candidate's own environment (a planted optimum, to be found)
plus seeded noise, with fault switches for OOM, a hang, a mid-visit death, a
cross-visit throughput cap, and a within-visit collapse. Two things it does
NOT fake: every row a check writes is written by the real `llama_tune.py`
through the real `llama_db` writers into a scratch `LLAMA_DB`, and every
correctness verdict is the benchmark's own grader executing the benchmark's
own reference solution (optionally patched with a planted `raise`), because the
guard is the half of this feature that makes a claim about answers and a stub
that told the grader the outcome would leave that untested.

Every check here needs `bash`/`jq` (llama-env.sh's `profile-json`/`config-id`
compute a real fingerprint for a real profile -- no GPU, no model weights, just
the flag table) and the venv (scipy, through llama_report). No server is ever
actually loaded; `qwen25c` is used throughout because it is dense (fewer knobs
collide) and its weights need not even be present on this machine.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import random
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

REPO = Path(__file__).resolve().parent.parent
VENV_PY = REPO / ".venv" / "bin" / "python"
PY = str(VENV_PY) if VENV_PY.exists() else sys.executable
TUNE = str(REPO / "scripts" / "llama_tune.py")
STUB = str(REPO / "scripts" / "llama_tune_stub.py")
SMI = str(REPO / "scripts" / "llama_tune_smi.py")
PROFILE = "qwen25c"

import llama_db as db                  # noqa: E402
import llama_report as rep             # noqa: E402
import llama_tests as bench            # noqa: E402

# A fresh port per invocation avoids TIME_WAIT collisions between checks that
# run back to back; a fresh scratch dir per check avoids state.json leaking a
# visit counter or a cap from one check's stub into another's.
_next_port = [19100]


def take_port() -> int:
    _next_port[0] += 1
    return _next_port[0]


# ---------------------------------------------------------------------------
# building blocks every check shares
# ---------------------------------------------------------------------------
def build_items(benchmark: str | None = "humaneval", tier: str = "smoke") -> dict:
    """LLAMA_TUNE_STUB_ITEMS: prompt sha -> {item, reference}.

    Built exactly the way Sweep.__init__ builds self.items, so a checked sweep
    sees the identical prompts, in the identical interleaved order, that a real
    one would. `reference` is the benchmark's own reference solution, run
    through the same extract_code() the grader itself uses on a model's answer
    -- the stub re-wraps it in a fence, so this must be the unfenced code.
    """
    adapters = bench.load_adapters()
    suite = bench.load_suite(tier)
    selected, _ = bench.build_suite(suite, adapters, only=benchmark)
    if not selected:
        raise RuntimeError(f"no items for benchmark={benchmark!r} tier={tier!r}")
    selected = bench.interleave(selected)
    items = {}
    for row in selected:
        adapter, item = row["adapter"], row["item"]
        prompt = bench.render_prompt(adapter, item)
        key = hashlib.sha1(prompt.encode()).hexdigest()
        want_def = adapter["check"]["harness"] in ("humaneval", "mbpp")
        raw = bench.reference_answer(adapter, item)
        code = bench.extract_code(raw or "", want_def=want_def)
        items[key] = {"item": bench.item_id(adapter, item), "reference": code}
    return items, len(selected)


_ITEMS_CACHE: dict[tuple[str | None, str], tuple[dict, int]] = {}


def cached_items(benchmark: str | None = "humaneval", tier: str = "smoke"):
    key = (benchmark, tier)
    if key not in _ITEMS_CACHE:
        _ITEMS_CACHE[key] = build_items(benchmark, tier)
    return _ITEMS_CACHE[key]


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data))


def write_grid(path: Path, knobs: dict[str, list], *, min_ctx: int = 16384) -> None:
    """A minimal search-space TOML: LLAMA_THREADS/LLAMA_BATCH by default.

    Kept to two small, fully-crossed knobs on purpose: sample_candidates draws
    `want` distinct legal combinations, and with a small enough grid a modest
    --candidates covers the *whole* space, which is what lets a check isolate
    "did elimination pick the right winner" from "did explore happen to sample
    it" -- the latter is a real property of the algorithm but not what most of
    these checks are about.
    """
    lines = [f'id = "check"', f'profile = "{PROFILE}"', f"min_ctx = {min_ctx}", ""]
    for var, values in knobs.items():
        lines.append(f"[knob.{var}]")
        lines.append(f"values = {json.dumps(values)}")
        lines.append("")
    path.write_text("\n".join(lines))


class Scratch:
    """One throwaway sweep's files: grid, stub config/state/items, db, port."""

    def __init__(self, tmp: Path, *, benchmark: str | None = "humaneval",
                 tier: str = "smoke", knobs: dict[str, list] | None = None):
        self.tmp = tmp
        self.port = take_port()
        self.grid_path = tmp / "grid.toml"
        write_grid(self.grid_path, knobs or {
            "LLAMA_THREADS": [4, 8], "LLAMA_BATCH": [512, 1024]})
        self.items, self.n_items = cached_items(benchmark, tier)
        self.benchmark = benchmark
        self.tier = tier
        self.cfg_path = tmp / "cfg.json"
        self.state_path = tmp / "state.json"
        self.items_path = tmp / "items.json"
        self.db_path = tmp / "llama.db"
        write_json(self.items_path, self.items)
        self.set_state({"visits": 0, "capped_at": None})

    def set_cfg(self, cfg: dict) -> None:
        write_json(self.cfg_path, cfg)

    def set_state(self, state: dict) -> None:
        write_json(self.state_path, state)

    def env(self) -> dict:
        env = dict(os.environ)
        env.update({
            "LLAMA_TUNE_LAUNCH": f"{PY} {STUB}",
            "LLAMA_TUNE_NVIDIA_SMI": SMI,
            "LLAMA_TUNE_STUB_CONFIG": str(self.cfg_path),
            "LLAMA_TUNE_STUB_STATE": str(self.state_path),
            "LLAMA_TUNE_STUB_ITEMS": str(self.items_path),
            "LLAMA_PORT": str(self.port),
            "LLAMA_DB": str(self.db_path),
            "LLAMA_PLAIN": "1",
        })
        return env

    def run(self, args: list[str], *, timeout: float = 120.0) -> subprocess.CompletedProcess:
        return subprocess.run(
            [PY, TUNE, PROFILE, "--tier", self.tier, "--grid", str(self.grid_path),
             *(["--benchmark", self.benchmark] if self.benchmark else []), *args],
            cwd=str(REPO), env=self.env(), capture_output=True, text=True,
            timeout=timeout)

    def resume(self, sweep_id: str, *, timeout: float = 120.0) -> subprocess.CompletedProcess:
        """`llama-tune resume <id>` -- no profile/tier/grid/benchmark prefix.

        Unlike `run`, `resume` takes only a sweep id: everything about the
        search space is read back from tune_sweep itself.
        """
        return subprocess.run(
            [PY, TUNE, "resume", sweep_id], cwd=str(REPO), env=self.env(),
            capture_output=True, text=True, timeout=timeout)

    def popen(self, args: list[str]) -> subprocess.Popen:
        return subprocess.Popen(
            [PY, TUNE, PROFILE, "--tier", self.tier, "--grid", str(self.grid_path),
             *(["--benchmark", self.benchmark] if self.benchmark else []), *args],
            cwd=str(REPO), env=self.env(), stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True)

    def con(self) -> sqlite3.Connection:
        con = sqlite3.connect(str(self.db_path))
        con.row_factory = sqlite3.Row
        return con


def rows(con: sqlite3.Connection, sql: str, *args) -> list[dict]:
    return [dict(r) for r in con.execute(sql, args).fetchall()]


def one(con: sqlite3.Connection, sql: str, *args) -> dict | None:
    r = con.execute(sql, args).fetchone()
    return dict(r) if r else None


def wait_for(predicate, *, timeout: float = 30.0, poll: float = 0.2):
    """Poll until predicate() is truthy, or give up. Returns the last value."""
    deadline = time.time() + timeout
    value = predicate()
    while not value and time.time() < deadline:
        time.sleep(poll)
        value = predicate()
    return value


# ===========================================================================
# assertion 8: the schedule refuses rather than truncates
# ===========================================================================
def check_8_schedule_refuses_rather_than_truncates() -> list[str]:
    failures = []
    with tempfile.TemporaryDirectory(prefix="llama-tune-check-") as tmp:
        s = Scratch(Path(tmp), benchmark=None, tier="smoke")  # 24 items
        proc = s.run(["--candidates", "16", "--dry-run"], timeout=30)
        if proc.returncode != 2:
            failures.append(f"--tier smoke --candidates 16 exited "
                            f"{proc.returncode}, expected 2")
        text = proc.stderr
        for needed in ("cannot carry", "24", "candidates"):
            if needed not in text:
                failures.append(f"refusal text is missing {needed!r}: {text[:300]}")
        if s.db_path.exists():
            # connect() migrates on open regardless, so the file itself may
            # exist; what must not exist is a sweep row -- the refusal has to
            # land before anything is recorded, not after a partial write.
            con = s.con()
            n = con.execute("SELECT COUNT(*) FROM tune_sweep").fetchone()[0]
            con.close()
            if n:
                failures.append("a refused --dry-run recorded a tune_sweep row")
    return failures


# ===========================================================================
# stats cross-check: plan_schedule vs brute force, log-ratio/sign-test vs scipy
# ===========================================================================
def check_stats_cross_check() -> list[str]:
    import io
    from contextlib import redirect_stderr

    import llama_tune as lt

    failures = []

    # -- plan_schedule, brute-force re-derivation --------------------------
    def brute(tier_size, candidates, round_items, eta):
        rounds = max(1, math.ceil(math.log(candidates, eta)))
        lo, alive = 0, candidates
        slices, survivors = [], []
        for r in range(rounds):
            width = round_items * (eta ** r)
            slices.append((lo, lo + width))
            survivors.append(alive)
            lo += width
            alive = max(2, math.ceil(alive / eta))
        return lo, rounds, slices, survivors

    rng = random.Random(20260906)
    for _ in range(200):
        candidates = rng.randint(2, 40)
        round_items = rng.randint(1, 40)
        eta = rng.choice([2, 3, 4])
        tier_size = rng.randint(20, 2000)
        want_lo, want_rounds, want_slices, want_surv = brute(
            tier_size, candidates, round_items, eta)
        try:
            with redirect_stderr(io.StringIO()):
                sched = lt.plan_schedule(tier_size, candidates, round_items, eta)
        except SystemExit:
            if want_lo <= tier_size:
                failures.append(
                    f"plan_schedule refused a fitting case: candidates="
                    f"{candidates} round_items={round_items} eta={eta} "
                    f"tier_size={tier_size} (brute needs {want_lo})")
            continue
        if want_lo > tier_size:
            failures.append(f"plan_schedule accepted a case brute-force says "
                            f"does not fit: needs {want_lo} > {tier_size}")
            continue
        if (sched.rounds, sched.slices, sched.survivors) != \
                (want_rounds, want_slices, want_surv):
            failures.append(
                f"plan_schedule disagrees with brute force at candidates="
                f"{candidates} round_items={round_items} eta={eta}: "
                f"{(sched.rounds, sched.slices, sched.survivors)} vs "
                f"{(want_rounds, want_slices, want_surv)}")
            break

    # -- sign_test, exact binomial cross-check ------------------------------
    try:
        from scipy import stats as sci
    except ImportError:
        failures.append("scipy unavailable for the sign-test cross-check "
                        "(llama_report already requires it, so this should "
                        "not happen)")
        sci = None

    if sci is not None:
        rng = random.Random(1)
        for _ in range(40):
            n = rng.randint(1, 30)
            values = [rng.choice([-1.0, 1.0]) * rng.random() for _ in range(n)]
            # zero out a few, to exercise the "nonzero" filtering
            for i in rng.sample(range(n), k=rng.randint(0, min(3, n))):
                values[i] = 0.0
            p, k = lt.sign_test(values)
            nonzero = [v for v in values if v != 0]
            if not nonzero:
                if p != 1.0 or k != 0:
                    failures.append(f"sign_test on all-zero input returned "
                                    f"({p}, {k}), expected (1.0, 0)")
                continue
            successes = sum(1 for v in nonzero if v > 0)
            ref = sci.binomtest(successes, len(nonzero), 0.5, alternative="two-sided")
            if abs(p - ref.pvalue) > 1e-9:
                failures.append(
                    f"sign_test disagrees with scipy.binomtest: {p} vs "
                    f"{ref.pvalue} on successes={successes}/{len(nonzero)}")

    # -- median: parity with statistics.median ------------------------------
    import statistics
    rng = random.Random(2)
    for _ in range(40):
        values = [rng.random() * 10 for _ in range(rng.randint(1, 15))]
        got = lt.median(values)
        want = statistics.median(values)
        if abs(got - want) > 1e-9:
            failures.append(f"median disagrees with statistics.median: "
                            f"{got} vs {want} on {values}")

    return failures


# ===========================================================================
# assertion 9: a grid edited between run and resume is refused, naming both
# ===========================================================================
def check_9_grid_edited_between_run_and_resume() -> list[str]:
    failures = []
    with tempfile.TemporaryDirectory(prefix="llama-tune-check-") as tmp:
        s = Scratch(Path(tmp))
        s.set_cfg({"base_tps": 40.0, "gain": 0.05, "noise": 0.02, "seed": 0,
                   "load_seconds": 0.1, "base_fail_rate": 0.0})
        # A budget that stops almost immediately (visits=1), so there is a
        # resumable, incomplete sweep to edit the grid underneath.
        proc = s.run(["--budget", "trials", "--max-visits", "1",
                      "--round-items", "2", "--candidates", "4"], timeout=60)
        con = s.con()
        sweep_id = one(con, "SELECT sweep_id FROM tune_sweep")["sweep_id"]
        con.close()

        # Edit the grid: add a value. grid_sha is over the parsed structure,
        # so this must actually change the knobs, not just whitespace.
        write_grid(s.grid_path, {"LLAMA_THREADS": [4, 6, 8],
                                 "LLAMA_BATCH": [512, 1024]})
        proc2 = s.resume(sweep_id, timeout=30)
        if proc2.returncode != 2:
            failures.append(f"resume after a grid edit exited "
                            f"{proc2.returncode}, expected 2")
        if "grid" not in proc2.stderr.lower() or "changed" not in proc2.stderr.lower():
            failures.append(f"refusal does not say the grid changed: "
                            f"{proc2.stderr[:300]}")
    return failures


# ===========================================================================
# assertion 10: migration 6 is clean, idempotent, and cascades correctly
# ===========================================================================
def check_10_migration_and_cascade() -> list[str]:
    failures = []
    with tempfile.TemporaryDirectory(prefix="llama-tune-check-") as tmp:
        path = Path(tmp) / "fresh.db"
        con = db.connect(path)
        con2 = db.connect(path)   # idempotent on reconnect
        for c in (con, con2):
            bad = c.execute("PRAGMA integrity_check").fetchone()[0]
            if bad != "ok":
                failures.append(f"integrity_check: {bad}")
            fk = c.execute("PRAGMA foreign_key_check").fetchall()
            if fk:
                failures.append(f"foreign_key_check found violations: {fk}")
        con2.close()

        sweep_id = "check-cascade"
        db.open_sweep(con, sweep_id, pid=os.getpid(), profile=PROFILE,
                      tier="smoke", benchmark="humaneval", grid_path="x",
                      grid_sha="x", item_order_sha="x", item_count=8,
                      budget_mode="trials", eta=2, round_items=2,
                      candidates=2, stages="explore", objective="gen_tps",
                      alpha=0.05, on_drift="cooldown", seed=0)
        db.add_candidates(con, sweep_id, [
            {"candidate_sha": "aaa111", "stage": "explore", "overrides": "{}",
             "is_baseline": 1, "suite_run_id": "check-cascade-aaa111"}])
        db.open_round(con, sweep_id, 1, stage="explore", item_from=0, item_to=2,
                      survivors=1)
        visit_id = db.open_visit(con, sweep_id, "aaa111", 1, item_from=0, item_to=2)
        pause_id = db.open_pause(con, sweep_id, trigger="drift", rnd=1,
                                 visit_id=visit_id)
        con.commit()

        # A real graded result, foreign-keyed to nothing tune_* owns, to prove
        # deleting the sweep does not touch measurements.
        db.upsert_config(con, "cfgcafe1", "qwen2.5-coder-7b", ["arch: dense"])
        db.add_result(con, {
            "suite_run_id": "check-cascade-aaa111", "run_id": None,
            "config_id": "cfgcafe1", "model": "qwen2.5-coder-7b",
            "profile": PROFILE, "dataset_revision": "fixture", "tier": "smoke",
            "seed": 0, "at": "2026-09-06T00:00:00Z", "benchmark": "humaneval",
            "item_id": "HumanEval/0", "outcome": "pass", "reason": "",
            "timings": {"prompt_n": 1, "prompt_ms": 1.0, "predicted_n": 1,
                        "predicted_ms": 1.0},
            "params": {"temperature": 0}, "wall_ms": 2.0, "reasoning_chars": 0,
        }, {"prompt": "x", "content": "x", "reasoning": ""})
        con.commit()

        before_results = con.execute("SELECT COUNT(*) FROM result").fetchone()[0]
        con.execute("DELETE FROM tune_sweep WHERE sweep_id = ?", (sweep_id,))
        con.commit()
        after_results = con.execute("SELECT COUNT(*) FROM result").fetchone()[0]
        if after_results != before_results:
            failures.append("deleting a tune_sweep touched the result table")
        for table in ("tune_candidate", "tune_round", "tune_visit", "tune_pause"):
            left = con.execute(f"SELECT COUNT(*) FROM {table} WHERE sweep_id = ?",
                               (sweep_id,)).fetchone()[0]
            if left:
                failures.append(f"{table} still has {left} row(s) after the "
                                f"sweep it belongs to was deleted")
        con.close()
    return failures


# ===========================================================================
# assertion 1: the planted optimum wins, most of the time
# ===========================================================================
def check_1_planted_optimum_recovery_rate(seeds: int = 20) -> list[str]:
    failures = []
    optimum = {"LLAMA_THREADS": "8", "LLAMA_BATCH": "1024"}
    wins = 0
    crashes = []
    with tempfile.TemporaryDirectory(prefix="llama-tune-check-") as tmp:
        for seed in range(seeds):
            sub = Path(tmp) / str(seed)
            sub.mkdir()
            s = Scratch(sub)
            s.set_cfg({"base_tps": 40.0, "gain": 0.08, "optimum": optimum,
                      "noise": 0.06, "seed": seed, "load_seconds": 0.05,
                      "base_fail_rate": 0.1})
            proc = s.run(["--budget", "trials", "--max-visits", "200",
                         "--candidates", "4", "--round-items", "2",
                         "--eta", "2", "--seed", str(seed),
                         "--load-timeout", "20"], timeout=90)
            if proc.returncode not in (0, 1, 3):
                crashes.append((seed, proc.returncode, proc.stderr[-500:]))
                continue
            con = s.con()
            winner = one(con, "SELECT overrides FROM tune_candidate "
                              "WHERE status = 'winner'")
            con.close()
            if winner and json.loads(winner["overrides"]) == optimum:
                wins += 1

    if crashes:
        failures.append(f"{len(crashes)}/{seeds} seeds crashed unexpectedly: "
                        f"{crashes[0]}")
    rate = wins / seeds
    print(f"        planted-optimum recovery: {wins}/{seeds} = {rate:.0%}")
    # A soft floor, not 20/20: the noise model is supposed to cost an
    # occasional seed. A rate this low would mean the ranking or the
    # elimination is not actually finding the faster candidate.
    if rate < 0.6:
        failures.append(f"recovery rate {rate:.0%} is too low to trust the "
                        f"elimination rule (wanted at least 60% over {seeds} "
                        f"seeds)")
    return failures


# ===========================================================================
# assertion 2: interleaving keeps a block's levels non-sequential
# ===========================================================================
def check_2_block_is_not_sequential() -> list[str]:
    """Block.sequential() is False for the sweep's block.

    A real sweep's config_id comes from the recorder that stamps a `run` row
    once a server actually binds -- this check's stub never runs one, by
    design (see the module docstring), so every visit's config_id is NULL and
    every candidate collapses onto one degenerate "unrecorded" level, which
    makes sequential() vacuously true regardless of scheduling. That is a gap
    in what the stub can observe, not in what llama_tune.py measured: the
    property under test -- do a candidate's request timestamps span multiple
    rounds and overlap another candidate's -- is entirely about wall-clock
    order, which the stub *does* produce faithfully. So candidate_sha stands
    in for config_id here, exactly as it would 1:1 once a real recorder filled
    it in (each candidate is one configuration by construction).
    """
    failures = []
    with tempfile.TemporaryDirectory(prefix="llama-tune-check-") as tmp:
        s = Scratch(Path(tmp))
        s.set_cfg({"base_tps": 40.0, "gain": 0.08,
                  "optimum": {"LLAMA_THREADS": "8", "LLAMA_BATCH": "1024"},
                  "noise": 0.03, "seed": 0, "load_seconds": 0.05,
                  "base_fail_rate": 0.0})
        proc = s.run(["--budget", "trials", "--max-visits", "200",
                     "--candidates", "4", "--round-items", "2", "--eta", "2",
                     "--seed", "0", "--load-timeout", "20"], timeout=90)
        if proc.returncode not in (0, 1, 3):
            failures.append(f"setup sweep failed: {proc.returncode} "
                            f"{proc.stderr[-500:]}")
            return failures
        con = s.con()
        sweep_id = one(con, "SELECT sweep_id FROM tune_sweep")["sweep_id"]
        cands = rows(con, "SELECT candidate_sha, suite_run_id FROM "
                          "tune_candidate WHERE sweep_id = ?", sweep_id)
        con.close()
        sha_of_run = {c["suite_run_id"]: c["candidate_sha"] for c in cands}
        records = [dict(r, config_id=sha_of_run[r["suite_run_id"]])
                  for r in db.results(db.connect(s.db_path))
                  if r.get("suite_run_id") in sha_of_run]
        if len(cands) < 3:
            failures.append("fewer than 3 candidates were registered; the "
                            "scenario did not run as designed")
            return failures
        if not records:
            failures.append("no graded records found for the sweep's runs")
            return failures
        blocks = rep.blocks_of(records, level_factor="config_id")
        if not blocks:
            failures.append("blocks_of found no blocks over config_id")
            return failures
        for b in blocks:
            if len(b.levels()) < 3:
                failures.append(f"block {b.key} only has {len(b.levels())} "
                                f"level(s); expected at least 3 candidates "
                                f"worth of spans to check for overlap")
                continue
            if b.sequential():
                failures.append(
                    f"block {b.key} reads as sequential over levels "
                    f"{b.levels()} with spans {b.spans()}; interleaving "
                    f"should have made a surviving candidate's later-round "
                    f"span overlap an eliminated one's round-1 span")
    return failures


# ===========================================================================
# assertion 3: a regression on the fastest candidate is rejected; the
# runner-up is adopted; the write-up never claims "better"
# ===========================================================================
def check_3_regression_on_fastest_is_rejected() -> list[str]:
    failures = []
    optimum = {"LLAMA_THREADS": "8", "LLAMA_BATCH": "1024"}
    with tempfile.TemporaryDirectory(prefix="llama-tune-check-") as tmp:
        s = Scratch(Path(tmp))
        s.set_cfg({
            "base_tps": 40.0, "gain": 0.08, "optimum": optimum,
            "noise": 0.02, "seed": 0, "load_seconds": 0.05,
            "base_fail_rate": 0.02,
            "regressions": [{"when": optimum, "fail_rate": 1.0}],
        })
        proc = s.run(["--budget", "trials", "--max-visits", "200",
                     "--candidates", "4", "--round-items", "2", "--eta", "2",
                     "--seed", "0", "--load-timeout", "20"], timeout=90)
        # "better" legitimately appears once, in the guard's own disclaimer
        # ("...is not a claim that the winner answers better..."); what must
        # never appear is the word used to assert it rather than disclaim it.
        text = (proc.stdout + proc.stderr).lower()
        pos = 0
        while True:
            idx = text.find("better", pos)
            if idx == -1:
                break
            window = text[max(0, idx - 60):idx]
            if "not a claim" not in window and "never" not in window:
                failures.append(f"'better' appears outside the disclaimer: "
                                f"...{text[max(0, idx-60):idx+20]}...")
            pos = idx + 6
        con = s.con()
        cands = rows(con, "SELECT * FROM tune_candidate")
        sweep = one(con, "SELECT * FROM tune_sweep")
        con.close()
        regressed = next((c for c in cands
                          if json.loads(c["overrides"] or "{}") == optimum), None)
        if regressed is None:
            failures.append("the planted-regression candidate never appeared "
                            "in tune_candidate; the scenario did not run as "
                            "designed")
            return failures
        if regressed["status"] != "rejected":
            failures.append(f"the fastest (and regressed) candidate has "
                            f"status={regressed['status']!r}, expected "
                            f"'rejected'")
        if "regression" not in (regressed["status_reason"] or "").lower():
            failures.append(f"rejection reason does not mention a regression: "
                            f"{regressed['status_reason']!r}")
        winner = next((c for c in cands if c["status"] == "winner"), None)
        if winner is None:
            if sweep["verdict"] == "adopted":
                failures.append("verdict is 'adopted' but no candidate has "
                                "status='winner'")
        elif json.loads(winner["overrides"] or "{}") == optimum:
            failures.append("the winner is the same candidate that was just "
                            "rejected for a regression")
    return failures


# ===========================================================================
# assertion 5: a candidate that cannot bind is infeasible, not a crash
# ===========================================================================
def check_5_oom_is_infeasible_not_fatal() -> list[str]:
    failures = []
    with tempfile.TemporaryDirectory(prefix="llama-tune-check-") as tmp:
        s = Scratch(Path(tmp))
        s.set_cfg({"base_tps": 40.0, "gain": 0.05, "noise": 0.02, "seed": 0,
                  "load_seconds": 0.05, "base_fail_rate": 0.0,
                  "oom_overrides": {"LLAMA_THREADS": "4"}})
        proc = s.run(["--budget", "trials", "--max-visits", "200",
                     "--candidates", "4", "--round-items", "2", "--eta", "2",
                     "--seed", "0", "--load-timeout", "20"], timeout=90)
        if proc.returncode not in (0, 1, 3):
            failures.append(f"sweep crashed instead of continuing past an "
                            f"OOM: exit {proc.returncode}\n{proc.stderr[-800:]}")
        con = s.con()
        cands = rows(con, "SELECT * FROM tune_candidate")
        con.close()
        oomed = [c for c in cands
                if json.loads(c["overrides"] or "{}").get("LLAMA_THREADS") == "4"
                and not c["is_baseline"]]
        if not oomed:
            failures.append("no non-baseline candidate overrode LLAMA_THREADS=4; "
                            "the scenario did not run as designed")
            return failures
        for c in oomed:
            if c["status"] != "infeasible":
                failures.append(f"candidate {c['candidate_sha'][:8]} set "
                                f"LLAMA_THREADS=4 (planted OOM) but status is "
                                f"{c['status']!r}, expected 'infeasible'")
            if "oom" not in (c["status_reason"] or "").lower():
                failures.append(f"infeasible reason does not mention oom: "
                                f"{c['status_reason']!r}")
            if c["config_id"] is not None:
                failures.append("an infeasible candidate has a config_id, but "
                                "no server of it ever bound")
        survivors = [c for c in cands if c["status"] not in ("infeasible",)]
        if len(survivors) < 2:
            failures.append("the sweep did not continue measuring other "
                            "candidates after the OOM")
    return failures


# ===========================================================================
# assertion 4: a planted power cap is detected on the right round;
# halt stops with best-so-far, segment keeps going
# ===========================================================================
def _drift_scenario(mode: str, tmp: Path) -> tuple[subprocess.CompletedProcess, Scratch]:
    tmp.mkdir(parents=True, exist_ok=True)
    s = Scratch(tmp)
    s.set_cfg({
        "base_tps": 40.0, "gain": 0.08,
        "optimum": {"LLAMA_THREADS": "8", "LLAMA_BATCH": "1024"},
        "noise": 0.02, "seed": 0, "load_seconds": 0.05,
        "base_fail_rate": 0.0,
        # Round 1 is 4 visits (candidates=4); the cap starts at visit 5,
        # which is round 2's first visit, so round 1 is the clean baseline
        # and round 2 is where the whole card looks capped.
        "cap_from_visit": 5, "cap_seconds": None,
    })
    proc = s.run(["--budget", "trials", "--max-visits", "200",
                 "--candidates", "4", "--round-items", "2", "--eta", "2",
                 "--seed", "0", "--load-timeout", "20",
                 "--on-drift", mode, "--drift-tolerance", "0.15"], timeout=90)
    return proc, s


def check_4_drift_halt_stops_segment_continues() -> list[str]:
    failures = []
    with tempfile.TemporaryDirectory(prefix="llama-tune-check-") as tmp:
        halt_proc, halt_s = _drift_scenario("halt", Path(tmp) / "halt")
        seg_proc, seg_s = _drift_scenario("segment", Path(tmp) / "segment")

        con = halt_s.con()
        sweep = one(con, "SELECT * FROM tune_sweep")
        r2 = one(con, "SELECT * FROM tune_round WHERE round = 2")
        r3 = one(con, "SELECT * FROM tune_round WHERE round = 3")
        con.close()
        if r2 is None or r2["drift_ratio"] is None or r2["drift_ratio"] >= 0.5:
            failures.append(f"round 2's drift_ratio is not the planted cap: "
                            f"{r2['drift_ratio'] if r2 else 'no round 2'}")
        if halt_proc.returncode != 1:
            failures.append(f"--on-drift halt exited {halt_proc.returncode}, "
                            f"expected 1")
        if sweep["verdict"] != "incomplete" or sweep["ended_reason"] != "drift":
            failures.append(f"--on-drift halt: verdict={sweep['verdict']!r} "
                            f"ended_reason={sweep['ended_reason']!r}, expected "
                            f"incomplete/drift")
        if r3 is not None:
            failures.append("--on-drift halt still opened a round 3 after the "
                            "card failed to recover")

        con = seg_s.con()
        seg_sweep = one(con, "SELECT * FROM tune_sweep")
        seg_r2 = one(con, "SELECT * FROM tune_round WHERE round = 2")
        seg_r3 = one(con, "SELECT * FROM tune_round WHERE round = 3")
        con.close()
        if seg_r2 is None or seg_r2["drift_ratio"] is None or seg_r2["drift_ratio"] >= 0.5:
            failures.append("segment: round 2's drift was not recorded the "
                            "same way as halt's")
        if seg_r3 is None:
            failures.append("--on-drift segment stopped instead of continuing "
                            "past the detected drift")
        if seg_sweep["ended_reason"] != "complete":
            failures.append(f"--on-drift segment: ended_reason="
                            f"{seg_sweep['ended_reason']!r}, expected "
                            f"'complete' (segment does not give up)")
    return failures


# ===========================================================================
# assertion 4a: cooldown, recoverable -- a mid-visit collapse (CollapseWatch),
# resolved by a cooldown probe, re-runs its visit as attempt 2
# ===========================================================================
def check_4a_cooldown_recoverable_mid_visit_cliff() -> list[str]:
    failures = []
    with tempfile.TemporaryDirectory(prefix="llama-tune-check-") as tmp:
        # benchmark=None: CollapseWatch needs warmup(4) + window(5) = 9 items
        # inside ONE visit, which none of smoke's three 8-item benchmarks has
        # alone.
        s = Scratch(Path(tmp), benchmark=None, tier="smoke",
                   knobs={"LLAMA_THREADS": [4, 8]})
        s.set_cfg({
            "base_tps": 40.0, "gain": 0.08, "noise": 0.02, "seed": 0,
            "load_seconds": 0.05, "base_fail_rate": 0.0,
            # visit 1 is round 1's first visit (candidates=2, rotate(rnd=1)
            # puts the non-baseline candidate first): its own throughput
            # craters after 6 of the round's 10 items, tripping CollapseWatch.
            "cliff_after": {"1": 6},
        })
        proc = s.run(["--budget", "trials", "--max-visits", "200",
                     "--candidates", "2", "--round-items", "10", "--eta", "2",
                     "--seed", "0", "--load-timeout", "20",
                     "--on-drift", "cooldown", "--cliff-ratio", "0.5",
                     "--cooldown-poll", "0.2", "--cooldown-hold", "0.3",
                     "--cooldown-max", "20", "--cooldown-attempts", "3",
                     "--cooldown-probe", "2"], timeout=90)
        if proc.returncode not in (0, 1, 3):
            failures.append(f"sweep crashed: {proc.returncode}\n"
                            f"{proc.stderr[-1000:]}")
            return failures
        con = s.con()
        pauses = rows(con, "SELECT * FROM tune_pause")
        visits = rows(con, "SELECT * FROM tune_visit ORDER BY visit_id")
        con.close()
        if len(pauses) != 1:
            failures.append(f"expected exactly one tune_pause row, found "
                            f"{len(pauses)}")
        elif pauses[0]["resolution"] != "recovered":
            failures.append(f"pause resolution is {pauses[0]['resolution']!r}, "
                            f"expected 'recovered'")
        cliffed = [v for v in visits if v["reason"] == "drift" and v["attempt"] == 1]
        if not cliffed:
            failures.append("no visit was closed with reason='drift' "
                            "(the mid-visit cliff); the scenario did not "
                            "trigger CollapseWatch as designed")
        else:
            v = cliffed[0]
            if v["counts_toward_round"]:
                failures.append("the cliffed visit still counts toward its "
                                "round's statistic")
            reattempt = next((r for r in visits
                              if r["candidate_sha"] == v["candidate_sha"]
                              and r["round"] == v["round"]
                              and r["attempt"] == v["attempt"] + 1), None)
            if reattempt is None:
                failures.append("the cliffed visit's candidate was never "
                                "re-visited as the next attempt")
            elif not reattempt["counts_toward_round"]:
                failures.append("the re-run attempt does not count toward "
                                "the round either")
    return failures


# ===========================================================================
# assertion 4b: cooldown, unrecoverable -- gives up after --cooldown-attempts,
# each window doubling, and stays inside --max-cooldown-share of the budget
# ===========================================================================
def check_4b_cooldown_unrecoverable_is_bounded() -> list[str]:
    failures = []
    with tempfile.TemporaryDirectory(prefix="llama-tune-check-") as tmp:
        s = Scratch(Path(tmp))
        s.set_cfg({
            "base_tps": 40.0, "gain": 0.08, "noise": 0.02, "seed": 0,
            "load_seconds": 0.05, "base_fail_rate": 0.0,
            # A clean round 1 establishes baseline_tps; the cap starts at
            # round 2's first visit (candidates=4 -> round 1 is visits 1-4)
            # and cap_seconds is null, so it never lifts -- the recovery
            # probe (itself a fresh visit past visit 5) is served capped too.
            "cap_from_visit": 5, "cap_seconds": None,
        })
        attempts = 3
        started = time.time()
        proc = s.run(["--budget", "trials", "--max-visits", "200",
                     "--candidates", "4", "--round-items", "2", "--eta", "2",
                     "--seed", "0", "--load-timeout", "20",
                     "--on-drift", "cooldown", "--drift-tolerance", "0.15",
                     "--cooldown-poll", "0.1", "--cooldown-hold", "0.2",
                     "--cooldown-max", "1.0", "--cooldown-attempts", str(attempts),
                     "--cooldown-probe", "2", "--max-cooldown-share", "0.5"],
                    timeout=120)
        wall = time.time() - started
        if proc.returncode not in (0, 1, 3):
            failures.append(f"sweep crashed: {proc.returncode}\n"
                            f"{proc.stderr[-1000:]}")
            return failures
        con = s.con()
        pauses = rows(con, "SELECT * FROM tune_pause ORDER BY pause_id")
        con.close()
        if not pauses:
            failures.append("no cooldown was ever attempted")
            return failures
        if any(p["resolution"] == "recovered" for p in pauses):
            failures.append("a pause resolved as 'recovered' even though the "
                            "cap never lifts; the scenario did not run as "
                            "designed")
        timeouts = [p for p in pauses if p["resolution"] == "timeout"]
        if not timeouts:
            failures.append(f"no pause resolved as 'timeout'; resolutions: "
                            f"{[p['resolution'] for p in pauses]}")
        # The windows double per attempt inside one Cooldown.run() call, but
        # each call to cool.run() starts a fresh count -- what must not happen
        # is the wall clock running away past a small --cooldown-max times a
        # small --cooldown-attempts by an order of magnitude.
        budget_ceiling = attempts * 1.0 * (2 ** attempts)  # generous, not exact
        if wall > budget_ceiling + 30:
            failures.append(f"the sweep spent {wall:.0f}s on an unrecoverable "
                            f"card; expected it to give up well under "
                            f"{budget_ceiling + 30:.0f}s")

    # -- max_cooldown_share specifically: the regression that matters is an
    # infinite wait, so this uses a --cooldown-attempts high enough that
    # attempts-exhaustion alone would never be reached in reasonable time,
    # and checks that the budget cutoff -- not the attempt count -- is what
    # actually stopped it.
    with tempfile.TemporaryDirectory(prefix="llama-tune-check-") as tmp:
        s = Scratch(Path(tmp))
        s.set_cfg({
            "base_tps": 40.0, "gain": 0.08, "noise": 0.02, "seed": 0,
            "load_seconds": 0.05, "base_fail_rate": 0.0,
            "cap_from_visit": 5, "cap_seconds": None,
            "smi_hot_seconds": 0.05,   # telemetry "calms" almost instantly
        })
        # 30s of budget: round 1's 4 visits (each dominated by Server.wait()'s
        # 1s poll granularity, not the stub's own near-instant load) already
        # cost several seconds, and round 2 is where the cap starts -- a
        # budget too tight to reach round 2 at all would exit on 'budget'
        # before drift is ever measured, testing nothing about the ceiling.
        started = time.time()
        proc = s.run(["--budget", "interactive", "--max-hours", str(30 / 3600),
                     "--candidates", "4", "--round-items", "2", "--eta", "2",
                     "--seed", "0", "--load-timeout", "20",
                     "--on-drift", "cooldown", "--drift-tolerance", "0.15",
                     "--cooldown-poll", "0.02", "--cooldown-hold", "0.02",
                     "--cooldown-temp", "60", "--cooldown-max", "1.0",
                     "--cooldown-attempts", "50", "--cooldown-probe", "2",
                     "--max-cooldown-share", "0.3"], timeout=90)
        wall = time.time() - started
        if proc.returncode not in (0, 1, 3):
            failures.append(f"max_cooldown_share scenario crashed: "
                            f"{proc.returncode}\n{proc.stderr[-1000:]}")
            return failures
        con = s.con()
        pause = one(con, "SELECT * FROM tune_pause ORDER BY pause_id DESC "
                         "LIMIT 1")
        con.close()
        if pause is None:
            failures.append("max_cooldown_share scenario: no cooldown ran")
            return failures
        if pause["attempt"] >= 50:
            failures.append(
                f"cooldown ran all 50 configured attempts instead of being "
                f"cut off by --max-cooldown-share; the budget ceiling did "
                f"not bind")
        if wall > 90:
            failures.append(f"the sweep spent {wall:.0f}s on a 30s budget "
                            f"with --max-cooldown-share 0.3; the ceiling did "
                            f"not bound wall-clock time")
    return failures


# ===========================================================================
# assertion 4c: idle telemetry clearing is not recovery -- the loaded probe is
# what gates it
# ===========================================================================
def check_4c_idle_clears_but_load_does_not() -> list[str]:
    """The idle-clears-but-load-does-not shape.

    The fake nvidia-smi stops admitting to being hot 1s after the cap starts
    (`smi_hot_seconds`), while the card's real throughput does not recover
    until `cap_seconds` (25s) later -- so on the first attempt, `_wait()`
    reads "calm" almost immediately, and if that alone gated resume, the very
    next visit would be measured capped and read as a real configuration
    effect. Recovery has to wait for the *probe* to actually clear, which
    means this pause should run for most of cap_seconds, not resolve in
    about how long telemetry alone takes to clear.
    """
    failures = []
    with tempfile.TemporaryDirectory(prefix="llama-tune-check-") as tmp:
        s = Scratch(Path(tmp))
        s.set_cfg({
            "base_tps": 40.0, "gain": 0.08, "noise": 0.02, "seed": 0,
            "load_seconds": 0.05, "base_fail_rate": 0.0,
            "cap_from_visit": 5, "cap_seconds": 25.0,
            "smi_hot_seconds": 1.0, "hot_temp": 87.0, "cool_temp": 52.0,
        })
        proc = s.run(["--budget", "trials", "--max-visits", "200",
                     "--candidates", "4", "--round-items", "2", "--eta", "2",
                     "--seed", "0", "--load-timeout", "20",
                     "--on-drift", "cooldown", "--drift-tolerance", "0.15",
                     "--cooldown-poll", "0.05", "--cooldown-hold", "0.05",
                     "--cooldown-temp", "60", "--cooldown-max", "0.5",
                     "--cooldown-attempts", "30", "--cooldown-probe", "2"],
                    timeout=90)
        if proc.returncode not in (0, 1, 3):
            failures.append(f"sweep crashed: {proc.returncode}\n"
                            f"{proc.stderr[-1000:]}")
            return failures
        con = s.con()
        pause = one(con, "SELECT * FROM tune_pause ORDER BY pause_id DESC "
                         "LIMIT 1")
        con.close()
        if pause is None:
            failures.append("no cooldown was attempted")
            return failures
        if pause["resolution"] != "recovered":
            failures.append(f"the card genuinely recovers after cap_seconds; "
                            f"expected resolution='recovered' eventually, got "
                            f"{pause['resolution']!r}")
        else:
            # `attempt` counts pause *events*, not the internal retries inside
            # one Cooldown.run() call, so a single row can still hide many
            # retries -- the tell is the pause's own duration. Telemetry alone
            # clears in ~1s (smi_hot_seconds); if that gated recovery this
            # would resolve in about that long, not cap_seconds's ballpark.
            started = time.strptime(pause["started_at"], "%Y-%m-%dT%H:%M:%SZ")
            ended = time.strptime(pause["ended_at"], "%Y-%m-%dT%H:%M:%SZ")
            duration = time.mktime(ended) - time.mktime(started)
            if duration < 3.0:
                failures.append(
                    f"the pause resolved 'recovered' in {duration:.0f}s, "
                    f"right after telemetry alone would have cleared "
                    f"(smi_hot_seconds=1s); if the probe is what actually "
                    f"gates recovery, waiting out most of cap_seconds=25s "
                    f"should have been unavoidable")
    return failures


# ===========================================================================
# assertion 4d: since_pause_seconds is recorded on the visit that follows a
# pause
# ===========================================================================
def check_4d_since_pause_seconds_recorded() -> list[str]:
    failures = []
    with tempfile.TemporaryDirectory(prefix="llama-tune-check-") as tmp:
        s = Scratch(Path(tmp), benchmark=None, tier="smoke",
                   knobs={"LLAMA_THREADS": [4, 8]})
        s.set_cfg({
            "base_tps": 40.0, "gain": 0.08, "noise": 0.02, "seed": 0,
            "load_seconds": 0.05, "base_fail_rate": 0.0,
            "cliff_after": {"1": 6},
        })
        proc = s.run(["--budget", "trials", "--max-visits", "200",
                     "--candidates", "2", "--round-items", "10", "--eta", "2",
                     "--seed", "0", "--load-timeout", "20",
                     "--on-drift", "cooldown", "--cliff-ratio", "0.5",
                     "--cooldown-poll", "0.1", "--cooldown-hold", "0.2",
                     "--cooldown-max", "10", "--cooldown-attempts", "3",
                     "--cooldown-probe", "2"], timeout=90)
        if proc.returncode not in (0, 1, 3):
            failures.append(f"sweep crashed: {proc.returncode}\n"
                            f"{proc.stderr[-1000:]}")
            return failures
        con = s.con()
        visits = rows(con, "SELECT * FROM tune_visit ORDER BY visit_id")
        con.close()
        after_pause = [v for v in visits[1:] if v["since_pause_seconds"] is not None]
        if not after_pause:
            failures.append("no visit after the pause recorded "
                            "since_pause_seconds")
    return failures


# ===========================================================================
# assertion 6: SIGKILL mid-visit -- the orphaned server is killed on resume,
# and the unique index is never actually hit
# ===========================================================================
def check_6_sigkill_mid_visit_then_resume() -> list[str]:
    failures = []
    with tempfile.TemporaryDirectory(prefix="llama-tune-check-") as tmp:
        s = Scratch(Path(tmp), benchmark=None, tier="smoke",
                   knobs={"LLAMA_THREADS": [4, 8]})
        s.set_cfg({
            "base_tps": 40.0, "gain": 0.05, "noise": 0.02, "seed": 0,
            # Slow enough that a mid-visit kill reliably lands between items.
            "item_seconds": 0.5, "base_fail_rate": 0.0,
        })
        proc = s.popen(["--budget", "trials", "--max-visits", "200",
                       "--candidates", "2", "--round-items", "10",
                       "--eta", "2", "--seed", "0", "--load-timeout", "20"])

        def some_items_done():
            if not s.db_path.exists():
                return False
            try:
                con = sqlite3.connect(str(s.db_path))
                n = con.execute("SELECT COUNT(*) FROM result").fetchone()[0]
                con.close()
                return n >= 2
            except sqlite3.Error:
                return False

        landed = wait_for(some_items_done, timeout=30.0)
        if not landed:
            proc.kill()
            proc.wait(timeout=10)
            failures.append("no items landed before the kill window elapsed; "
                            "cannot exercise a mid-visit crash")
            return failures
        os.kill(proc.pid, signal.SIGKILL)
        proc.wait(timeout=10)

        con = sqlite3.connect(str(s.db_path))
        con.row_factory = sqlite3.Row
        sweep_id = one(con, "SELECT sweep_id FROM tune_sweep")["sweep_id"]
        running = rows(con, "SELECT * FROM tune_visit WHERE status = 'running'")
        con.close()
        if not running:
            failures.append("no tune_visit row was left 'running' by the kill; "
                            "the kill landed after the visit already closed, "
                            "so this check did not exercise a crash")

        resume = s.resume(sweep_id, timeout=90)
        if resume.returncode not in (0, 1, 3):
            failures.append(f"resume crashed: {resume.returncode}\n"
                            f"{resume.stderr[-1500:]}")

        con = sqlite3.connect(str(s.db_path))
        con.row_factory = sqlite3.Row
        dupes = rows(con, "SELECT suite_run_id, benchmark, item_id, COUNT(*) c "
                          "FROM result GROUP BY 1, 2, 3 HAVING c > 1")
        still_running = rows(con, "SELECT * FROM tune_visit WHERE status = "
                                  "'running'")
        con.close()
        if dupes:
            failures.append(f"duplicate result rows after resume: {dupes[:3]} "
                            f"-- the unique index was supposed to prevent this")
        if still_running:
            failures.append("a tune_visit row is still 'running' after resume "
                            "completed")
    return failures


# ===========================================================================
# assertion 6a: SIGKILL during a cooldown -- the open pause survives as
# 'abandoned', and resume re-probes rather than trusting the idle card
# ===========================================================================
def check_6a_sigkill_during_cooldown_then_resume() -> list[str]:
    failures = []
    with tempfile.TemporaryDirectory(prefix="llama-tune-check-") as tmp:
        s = Scratch(Path(tmp), benchmark=None, tier="smoke",
                   knobs={"LLAMA_THREADS": [4, 8]})
        s.set_cfg({
            "base_tps": 40.0, "gain": 0.05, "noise": 0.02, "seed": 0,
            "load_seconds": 0.05, "base_fail_rate": 0.0,
            "cliff_after": {"1": 6},
        })
        proc = s.popen(["--budget", "trials", "--max-visits", "200",
                       "--candidates", "2", "--round-items", "10",
                       "--eta", "2", "--seed", "0", "--load-timeout", "20",
                       "--on-drift", "cooldown", "--cliff-ratio", "0.5",
                       # Slow the cooldown down so there is a wide window to
                       # land the kill inside an open pause.
                       "--cooldown-poll", "1.0", "--cooldown-hold", "3.0",
                       "--cooldown-max", "60", "--cooldown-attempts", "3",
                       "--cooldown-probe", "2"])

        def pause_open():
            if not s.db_path.exists():
                return False
            try:
                con = sqlite3.connect(str(s.db_path))
                n = con.execute("SELECT COUNT(*) FROM tune_pause WHERE "
                                "ended_at IS NULL").fetchone()[0]
                con.close()
                return n >= 1
            except sqlite3.Error:
                return False

        opened = wait_for(pause_open, timeout=30.0)
        if not opened:
            proc.kill()
            proc.wait(timeout=10)
            failures.append("no tune_pause row ever opened; cannot exercise a "
                            "crash during cooldown")
            return failures
        os.kill(proc.pid, signal.SIGKILL)
        proc.wait(timeout=10)

        con = sqlite3.connect(str(s.db_path))
        con.row_factory = sqlite3.Row
        sweep_id = one(con, "SELECT sweep_id FROM tune_sweep")["sweep_id"]
        pauses_before = rows(con, "SELECT * FROM tune_pause")
        con.close()
        if not any(p["ended_at"] is None for p in pauses_before):
            failures.append("the kill landed after the pause already closed; "
                            "did not exercise a crash mid-cooldown")

        # resume has no --cooldown-* flags of its own (cmd_resume rebuilds
        # operational options from parse_args(["run"])'s defaults, since they
        # have no column on tune_sweep -- see its own comment), so the
        # re-probe below runs at cooldown_hold=90s/cooldown_poll=20s
        # regardless of what this sweep was launched with. Telemetry never
        # goes hot in this scenario, so _wait() only pays that fixed ~90-110s
        # once; the timeout here has to cover it.
        resume = s.resume(sweep_id, timeout=240)
        if resume.returncode not in (0, 1, 3):
            failures.append(f"resume crashed: {resume.returncode}\n"
                            f"{resume.stderr[-1500:]}")

        con = sqlite3.connect(str(s.db_path))
        con.row_factory = sqlite3.Row
        pauses_after = rows(con, "SELECT * FROM tune_pause ORDER BY pause_id")
        con.close()
        abandoned = [p for p in pauses_after if p["resolution"] == "abandoned"]
        if not abandoned:
            failures.append("no pause was closed 'abandoned' by the crash; "
                            "sweep_stale_sweeps should have caught the open "
                            "one on the next connect()")
        if len(pauses_after) <= len(pauses_before):
            failures.append("resume did not open a fresh pause to re-probe "
                            "the card; it must not assume recovery happened "
                            "while nothing was watching")
        if "re-probing" not in resume.stderr and "re-probe" not in resume.stderr:
            failures.append("resume's own output does not say it is "
                            "re-probing before trusting an abandoned pause")
    return failures


# ===========================================================================
# assertion 7: budget exhausted mid-round leaves that round open and excluded
# ===========================================================================
def check_7_budget_exhausted_mid_round() -> list[str]:
    failures = []
    with tempfile.TemporaryDirectory(prefix="llama-tune-check-") as tmp:
        s = Scratch(Path(tmp))
        s.set_cfg({"base_tps": 40.0, "gain": 0.05, "noise": 0.02, "seed": 0,
                  "load_seconds": 0.05, "base_fail_rate": 0.0})
        # candidates=4 means round 1 visits 4 candidates; a 2-visit cap stops
        # partway through it.
        proc = s.run(["--budget", "trials", "--max-visits", "2",
                     "--candidates", "4", "--round-items", "2", "--eta", "2",
                     "--seed", "0", "--load-timeout", "20"], timeout=60)
        if proc.returncode not in (0, 1, 3):
            failures.append(f"sweep crashed: {proc.returncode}\n"
                            f"{proc.stderr[-800:]}")
            return failures
        con = s.con()
        sweep = one(con, "SELECT * FROM tune_sweep")
        r1 = one(con, "SELECT * FROM tune_round WHERE round = 1")
        con.close()
        if sweep["verdict"] != "incomplete" or sweep["ended_reason"] != "visits":
            failures.append(f"verdict={sweep['verdict']!r} "
                            f"ended_reason={sweep['ended_reason']!r}, "
                            f"expected incomplete/visits")
        if r1 is None:
            failures.append("round 1 was never opened at all")
        elif r1["ended_at"] is not None:
            failures.append("round 1 closed normally even though the visit "
                            "budget ran out partway through it; a resume "
                            "would then treat a partial round as decided")
        resume = s.resume(sweep["sweep_id"], timeout=60)
        if resume.returncode not in (0, 1, 3):
            failures.append(f"resume after budget exhaustion crashed: "
                            f"{resume.returncode}\n{resume.stderr[-800:]}")
    return failures


# ===========================================================================
def main(argv: list[str] | None = None) -> int:
    checks: list[tuple[str, list[str]]] = [
        ("8  the schedule refuses rather than truncates",
         check_8_schedule_refuses_rather_than_truncates()),
        ("stats  plan_schedule / sign_test / median cross-checked",
         check_stats_cross_check()),
        ("9  a grid edited between run and resume is refused",
         check_9_grid_edited_between_run_and_resume()),
        ("10 migration 6 is clean, idempotent, and cascades correctly",
         check_10_migration_and_cascade()),
        ("2  interleaving keeps a block non-sequential",
         check_2_block_is_not_sequential()),
        ("3  a regression on the fastest candidate is rejected",
         check_3_regression_on_fastest_is_rejected()),
        ("5  a candidate that cannot bind is infeasible, not fatal",
         check_5_oom_is_infeasible_not_fatal()),
        ("7  budget exhausted mid-round leaves it open and excluded",
         check_7_budget_exhausted_mid_round()),
        ("4  drift: halt stops, segment continues",
         check_4_drift_halt_stops_segment_continues()),
        ("4a cooldown recovers a mid-visit collapse, re-runs the visit",
         check_4a_cooldown_recoverable_mid_visit_cliff()),
        ("4b cooldown gives up on an unrecoverable card, bounded",
         check_4b_cooldown_unrecoverable_is_bounded()),
        ("4c idle telemetry clearing is not trusted as recovery",
         check_4c_idle_clears_but_load_does_not()),
        ("4d since_pause_seconds is recorded after a pause",
         check_4d_since_pause_seconds_recorded()),
        ("6  SIGKILL mid-visit: orphan killed, resume completes cleanly",
         check_6_sigkill_mid_visit_then_resume()),
        ("6a SIGKILL during cooldown: abandoned, resume re-probes",
         check_6a_sigkill_during_cooldown_then_resume()),
        ("1  the planted optimum wins, most of the time",
         check_1_planted_optimum_recovery_rate()),
    ]

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
