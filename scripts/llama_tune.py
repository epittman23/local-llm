#!/usr/bin/env python3
"""llama_tune.py - search the serving configuration space, and judge the winner.

Part of https://github.com/epittman23/local-llm

`llama-test compare` and `llama-report` analyse configurations somebody already
thought to try. This searches: it serves a batch of configurations against the
same benchmark items, eliminates the slow ones round by round, narrows onto the
best values of each knob, and then asks whether the winner answers any worse
than the profile's own defaults.

What it will and will not claim, because this is the whole design:

  * It ranks on **generation throughput**, paired per item against the
    baseline. It never ranks on pass rate: at the observed discordance a paired
    correctness test needs 451 items to see 5 pp (2026-09-05), so a per-round
    correctness ranking at 6 or 8 items would be ranking noise.
  * The winner then has to survive **one** pre-registered correctness check
    against the incumbent, at the end, over every item both ran. The output of
    that check is "no regression was detectable, and here is the smallest one
    this comparison could have found". The word "better" is never used, because
    the design cannot support it.
  * When the design cannot support the throughput claim either -- levels that
    never overlap in time, a machine state that changed underneath the sweep --
    the verdict is `indeterminate` and the ranking is printed labelled as
    refused. That refusal is `llama_report`'s, reused rather than re-derived.

Three structural choices, each of them a lesson from this repo's own history:

  * **Candidates are interleaved, not run one at a time to completion.** On
    2026-09-05 generation fell from 49.4 to 6.1 t/s mid-run and never
    recovered; a sweep that measured candidate A for an hour and then candidate
    B would have reported the power cap as a configuration effect, with an
    F of 419 to back it up. Round-robin makes every pair of candidates share a
    machine state, which is what makes the paired ratio mean anything.
  * **The statistic is the median paired log-ratio against the baseline**,
    which is invariant to a slowdown that hits both arms, rather than a mean of
    absolute t/s, which is not.
  * **Nothing here reimplements serving.** A candidate is `llama-serve` under
    `LLAMA_*` overrides, so it is fingerprinted by `_vramlog_config`,
    telemetered by the recorder and recorded as an ordinary run. This module is
    a caller of scripts/llama-env.sh, never a second copy of it.

Adoption is deliberately manual: `llama-tune report` prints the override line
and the flag diff, and a human edits llama-env.sh. That file is the source of
truth for serving configuration, and a tool that rewrote it would be
application code in a repo that holds none.

Needs the venv (scipy, through llama_report). See llama-tune in llama-env.sh.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import re
import shlex
import subprocess
import sys
import threading
import time
import tomllib
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

REPO = Path(__file__).resolve().parent.parent
ENV_SH = REPO / "scripts" / "llama-env.sh"
GRID_DIR = REPO / "tests" / "tuning"

import llama_db as db                      # noqa: E402
import llama_results as store              # noqa: E402
import llama_stats as stats                # noqa: E402
import llama_test as harness               # noqa: E402
import llama_tests as bench                # noqa: E402
from llama_console import console          # noqa: E402
from llama_ui import Command               # noqa: E402


def refuse(message: str):
    """Decline the request, in words, with exit 2.

    Exit 2 rather than 1 throughout, and it is the same 2 llama-report uses for
    a missing scipy: this command distinguishes "I will not do that, here is
    why" from "the sweep ran and did not find a winner", which exits 0 with a
    verdict, and from an interrupted sweep, which exits 1 and prints a resume
    line. A caller scripting this needs those three apart. Returns the
    exception so callers can `raise refuse(...)` and keep the control flow
    visible at the call site.
    """
    print(message, file=sys.stderr)
    return SystemExit(2)


try:
    import llama_report as rep             # noqa: E402
except ImportError as exc:                 # pragma: no cover - environment
    # Same contract llama-report makes, for the same reason recorded on
    # 2026-09-05: a search whose correctness guard has been removed is not a
    # smaller version of this command, it is a different and less honest one.
    # This import sits below refuse() rather than beside the others because it
    # calls it, and a module-level statement cannot reach a def written later.
    raise refuse(
        "llama-tune: this needs scipy, which is not installed.\n"
        f"  {REPO}/.venv/bin/pip install -r {REPO}/requirements.txt\n"
        f"  ({exc})")


# ---------------------------------------------------------------------------
# budgets and the schedule they buy
# ---------------------------------------------------------------------------
class Budget:
    """How much machine time a sweep may spend, and what shape that buys.

    `seconds` is wall clock from the first launch, and **cooling counts against
    it**. `--budget overnight` is a promise that the machine is free in the
    morning; making up cooled time by running into the next day would break the
    one thing the mode exists to say. A sweep that spends its budget cooling
    finishes fewer rounds and says so.
    """

    def __init__(self, mode: str, *, seconds: float | None,
                 visits: int | None, candidates: int, round_items: int):
        self.mode = mode
        self.seconds = seconds
        self.visits = visits
        self.candidates = candidates
        self.round_items = round_items

    def spent(self, started: float, visits: int) -> str | None:
        """Why the sweep must stop now, or None to keep going."""
        if self.seconds is not None and time.time() - started >= self.seconds:
            return "budget"
        if self.visits is not None and visits >= self.visits:
            return "visits"
        return None

    def remaining(self, started: float) -> float | None:
        if self.seconds is None:
            return None
        return max(0.0, self.seconds - (time.time() - started))


#: The four modes, with the candidate count and round size each can afford at
#: the measured ~42 s/item (2026-09-05, qwen36) plus reload overhead. They are
#: starting points: --candidates and --round-items override any of them, and
#: plan_schedule refuses the combination if the tier cannot carry it.
MODES = {
    "interactive": dict(seconds=2 * 3600, visits=None, candidates=6, round_items=6),
    "overnight": dict(seconds=8 * 3600, visits=None, candidates=16, round_items=8),
    # No deadline: multiday is resumed by hand, so what bounds it is the tier.
    "multiday": dict(seconds=None, visits=None, candidates=32, round_items=8),
    # No clock at all, a hard cap on visits. The mode for a stub run or a
    # deliberately short experiment.
    "trials": dict(seconds=None, visits=24, candidates=4, round_items=6),
}


class Schedule:
    """The rounds a sweep will run, computed before anything is launched.

    Successive halving with eta=2 and doubling slices: every round costs about
    the same number of item-visits, and the survivor accumulates
    k0 * (2^R - 1) items -- which is the number the correctness guard gets, and
    therefore the number worth printing before a sweep rather than after it.
    """

    def __init__(self, candidates: int, round_items: int, eta: int,
                 rounds: int, slices: list[tuple[int, int]],
                 survivors: list[int]):
        self.candidates = candidates
        self.round_items = round_items
        self.eta = eta
        self.rounds = rounds
        self.slices = slices
        self.survivors = survivors

    @property
    def winner_items(self) -> int:
        return self.slices[-1][1] if self.slices else 0

    @property
    def item_visits(self) -> int:
        return sum(n * (hi - lo)
                   for n, (lo, hi) in zip(self.survivors, self.slices))

    def rows(self) -> list[list[str]]:
        return [[str(i + 1), f"{lo}:{hi}", str(hi - lo), str(n),
                 str(n * (hi - lo))]
                for i, (n, (lo, hi)) in enumerate(zip(self.survivors, self.slices))]


def plan_schedule(tier_size: int, candidates: int, round_items: int,
                  eta: int = 2) -> Schedule:
    """Lay out the rounds, or refuse.

    Refuses rather than truncating. A sweep asked for more rounds than the tier
    has items would otherwise quietly pick a "winner" on three items, which is
    the failure mode this whole command exists to avoid -- and `smoke` is 24
    items, so it is the common case rather than a corner one.
    """
    if candidates < 2:
        raise refuse("llama-tune: --candidates must be at least 2 "
                         "(the baseline plus something to compare it with)")
    if round_items < 1 or eta < 2:
        raise refuse("llama-tune: --round-items must be >= 1 and --eta >= 2")

    rounds = max(1, math.ceil(math.log(candidates, eta)))
    slices, survivors = [], []
    lo = 0
    alive = candidates
    for r in range(rounds):
        width = round_items * (eta ** r)
        slices.append((lo, lo + width))
        survivors.append(alive)
        lo += width
        alive = max(2, math.ceil(alive / eta))

    if lo > tier_size:
        rows = "\n".join(
            f"  round {i + 1}: items {a}:{b} ({b - a}), {n} candidates"
            for i, (n, (a, b)) in enumerate(zip(survivors, slices)))
        raise refuse(
            f"llama-tune: this tier cannot carry that search.\n"
            f"  {candidates} candidates at eta {eta} needs {rounds} rounds;\n"
            f"  rounds of {round_items} items doubling need {lo} items, and\n"
            f"  the tier has {tier_size}.\n{rows}\n"
            f"  Either lower --candidates, lower --round-items, or run a "
            f"larger tier. Truncating instead would pick a winner on a "
            f"handful of items.")
    return Schedule(candidates, round_items, eta, rounds, slices, survivors)


# ---------------------------------------------------------------------------
# the search space
# ---------------------------------------------------------------------------
COMPARISONS = [("<=", lambda a, b: a <= b), (">=", lambda a, b: a >= b),
               ("==", lambda a, b: a == b), ("!=", lambda a, b: a != b),
               ("<", lambda a, b: a < b), (">", lambda a, b: a > b)]


def profile_key(var: str) -> str:
    """LLAMA_UBATCH -> ubatch, the key llama-profile-json reports it under.

    The same transform llama_ui_app uses to decide whether a form field is an
    override. Spelling it once, here, is why the profile-json keys had to be
    exactly this and not something more readable.
    """
    return var[len("LLAMA_"):].lower() if var.startswith("LLAMA_") else var.lower()


class Grid:
    """A declared search space: knob values, constraints, and its fingerprint.

    A grid declares *overrides only* and carries no base values. Every base
    value comes from llama-env.sh, which stays the single source of truth; a
    grid that could set a baseline would be a second profile table.
    """

    def __init__(self, path: Path, data: dict):
        self.path = path
        self.data = data
        self.id = str(data.get("id") or path.stem)
        self.profile = str(data.get("profile") or self.id)
        self.knobs: dict[str, list] = {}
        self.refine_step: dict[str, object] = {}
        self.ordered: dict[str, bool] = {}
        for var, spec in (data.get("knob") or {}).items():
            if not var.startswith("LLAMA_"):
                raise refuse(
                    f"llama-tune: {path}: knob '{var}' is not an LLAMA_* "
                    f"override. A grid may only name the documented override "
                    f"variables; anything else would not reach llama-serve.")
            values = spec.get("values")
            if not isinstance(values, list) or not values:
                raise refuse(f"llama-tune: {path}: knob '{var}' has no values")
            self.knobs[var] = list(values)
            self.refine_step[var] = spec.get("refine_step", 1)
            self.ordered[var] = bool(spec.get("ordered", True))
        if not self.knobs:
            raise refuse(f"llama-tune: {path} declares no knobs")
        self.constraints = [str(c["expr"]) for c in (data.get("constraint") or [])
                            if c.get("expr")]
        self.scalars = {k: v for k, v in data.items()
                        if isinstance(v, (int, float, str))}
        # Over the parsed structure, not the file's bytes: a grid carries the
        # prose explaining why it is shaped as it is, and hashing that would
        # file a comment edit as a change of search space. Same choice, for the
        # same reason, as adapter_sha (2026-09-04, fourth).
        payload = json.dumps(
            {"id": self.id, "profile": self.profile,
             "knobs": {k: self.knobs[k] for k in sorted(self.knobs)},
             "constraints": sorted(self.constraints),
             "scalars": {k: self.scalars[k] for k in sorted(self.scalars)}},
            sort_keys=True)
        self.sha = hashlib.sha1(payload.encode()).hexdigest()[:12]

    # -- constraints -------------------------------------------------------
    def _resolve(self, token: str, overrides: dict, defaults: dict):
        token = token.strip()
        if token in overrides:
            return _numeric(overrides[token])
        if token in self.scalars:
            return _numeric(self.scalars[token])
        key = profile_key(token)
        if token.startswith("LLAMA_") and key in defaults:
            return _numeric(defaults[key])
        return _numeric(token)

    def violated(self, overrides: dict, defaults: dict) -> str | None:
        """The first constraint this candidate breaks, in the grid's own words.

        Deliberately a small comparison parser rather than eval(): a grid is a
        file on disk, and this process runs benchmarks that already execute
        model-generated code under process isolation. Nothing here needs to
        also be an expression evaluator.
        """
        for expr in self.constraints:
            for symbol, test in COMPARISONS:
                if symbol not in expr:
                    continue
                left, right = expr.split(symbol, 1)
                a = self._resolve(left, overrides, defaults)
                b = self._resolve(right, overrides, defaults)
                if a is None or b is None:
                    break
                try:
                    if not test(a, b):
                        return expr
                except TypeError:
                    break
                break
            else:
                raise refuse(
                    f"llama-tune: {self.path}: constraint '{expr}' has no "
                    f"comparison operator")
        return None


def _numeric(value):
    """int/float where the text is one, the text itself otherwise."""
    if isinstance(value, (int, float)):
        return value
    text = str(value).strip()
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        return text


def load_grid(path_or_name: str | None, profile: str) -> Grid:
    if path_or_name:
        path = Path(path_or_name)
        if not path.is_file():
            path = GRID_DIR / f"{path_or_name}.toml"
    else:
        path = GRID_DIR / f"{profile}.toml"
    if not path.is_file():
        known = ", ".join(sorted(p.stem for p in GRID_DIR.glob("*.toml"))) or "none"
        raise refuse(f"llama-tune: no search space at {path} "
                         f"(defined: {known})")
    with path.open("rb") as fh:
        data = tomllib.load(fh)
    return Grid(path, data)


# ---------------------------------------------------------------------------
# candidates
# ---------------------------------------------------------------------------
class Candidate:
    """One serving configuration under test.

    Identified by `candidate_sha` over its overrides, **not** by config_id: a
    candidate that fails to load never reaches upsert_config and so never has a
    config_id at all, and a sweep has to be able to record that it tried it.

    Two config_id fields, deliberately not one. `predicted_config_id` comes
    from `llama-config-id` before launch and is what dedup and the dry-run
    table use -- it costs nothing and needs nothing running. `config_id` is
    filled in only from the recorder's own observation once a server has
    actually bound under these flags, because `tune_candidate.config_id` and
    `tune_visit.config_id` are foreign keys into `config`, and no row exists
    there until `upsert_config` runs -- a candidate that OOMs never gets one at
    all. Writing the prediction into either column would violate the
    constraint on a candidate that was only ever planned, and silently
    misattribute rows on the rarer candidate that predicts one id and is
    recorded under another (visit() warns on that mismatch rather than hiding
    it behind a `config_id or predicted_config_id` fallback).
    """

    def __init__(self, profile: str, overrides: dict, *, stage: str,
                 baseline: bool = False):
        self.profile = profile
        self.overrides = {k: str(v) for k, v in sorted(overrides.items())}
        self.stage = stage
        self.baseline = baseline
        self.predicted_config_id: str | None = None
        self.config_id: str | None = None
        self.status = "pending"
        self.reason = ""
        self.score: float | None = None
        payload = json.dumps({"profile": profile, "overrides": self.overrides},
                             sort_keys=True)
        self.sha = hashlib.sha1(payload.encode()).hexdigest()[:12]

    @property
    def label(self) -> str:
        return "baseline" if self.baseline else self.sha[:8]

    def flags(self) -> str:
        if not self.overrides:
            return "(profile defaults)"
        return " ".join(f"{k}={v}" for k, v in self.overrides.items())

    def env(self) -> dict:
        env = dict(os.environ)
        env.update(self.overrides)
        return env


def config_id_of(candidate: Candidate) -> dict:
    """The fingerprint this candidate would be recorded under, without serving.

    Asks llama-env.sh, which asks _vramlog_config -- the same function the
    recorder uses. Computing it in Python instead would put a second copy of
    the fingerprint beside the shell one, and the day they disagreed two
    different configurations would be filed under one id.
    """
    proc = subprocess.run([str(ENV_SH), "config-id", candidate.profile],
                          capture_output=True, text=True, env=candidate.env(),
                          timeout=60)
    if proc.returncode != 0:
        raise refuse(f"llama-tune: llama-config-id failed for "
                         f"{candidate.flags()}: {proc.stderr.strip()[:300]}")
    return json.loads(proc.stdout)


def sample_candidates(grid: Grid, profile_json: dict, want: int,
                      seed: int) -> tuple[list[Candidate], list[tuple[Candidate, str]]]:
    """The explore stage: a broad, deduplicated draw over the whole grid.

    Random over the cross product rather than one-knob-at-a-time, because the
    knobs interact -- ubatch against batch, threads against how much of the
    model is CPU-resident -- and a one-at-a-time screen would miss exactly the
    combinations worth finding. Narrowing is the refine stage's job, and it is
    coordinate descent precisely because by then there is a point to descend
    from.

    Deduplication is on config_id, not on the override dict: setting a knob to
    the value the profile already uses produces a different dict and the same
    server, and measuring it twice would spend a round learning nothing.
    """
    rng = random.Random(seed)
    baseline = Candidate(grid.profile, {}, stage="explore", baseline=True)
    chosen = [baseline]
    rejected: list[tuple[Candidate, str]] = []
    seen_config = set()
    seen_sha = {baseline.sha}

    baseline.predicted_config_id = config_id_of(baseline)["config_id"]
    seen_config.add(baseline.predicted_config_id)

    knobs = sorted(grid.knobs)
    # Bounded rather than while-True: a heavily constrained grid can have far
    # fewer legal points than the caller asked for, and spinning forever
    # looking for them would be worse than saying so.
    for _ in range(want * 200):
        if len(chosen) >= want:
            break
        overrides = {k: rng.choice(grid.knobs[k]) for k in knobs}
        cand = Candidate(grid.profile, overrides, stage="explore")
        if cand.sha in seen_sha:
            continue
        seen_sha.add(cand.sha)
        why = infeasible_reason(cand, grid, profile_json)
        if why:
            rejected.append((cand, why))
            continue
        cand.predicted_config_id = config_id_of(cand)["config_id"]
        if cand.predicted_config_id in seen_config:
            rejected.append((cand, f"duplicate of config "
                                    f"{cand.predicted_config_id}"))
            continue
        seen_config.add(cand.predicted_config_id)
        chosen.append(cand)
    return chosen, rejected


def refine_candidates(grid: Grid, profile_json: dict, winner: Candidate,
                      keep: list[Candidate],
                      ) -> tuple[list[Candidate], list[tuple[Candidate, str]]]:
    """The refine stage: the winner's immediate neighbourhood, knob by knob.

    This is the half of "start broad and narrow" that halving cannot do on its
    own: successive halving narrows the candidate *set* and never the parameter
    *values*, so without a stage that generates new points near the leader, the
    search stops at whatever the first draw happened to contain.
    """
    out: list[Candidate] = []
    rejected: list[tuple[Candidate, str]] = []
    seen_config = set()
    seen_sha = set()
    for cand in keep:
        seen_sha.add(cand.sha)
        if cand.config_id or cand.predicted_config_id:
            seen_config.add(cand.config_id or cand.predicted_config_id)
        out.append(cand)

    base = dict(winner.overrides)
    for var in sorted(grid.knobs):
        values = grid.knobs[var]
        current = base.get(var, profile_json.get(profile_key(var)))
        neighbours = []
        if grid.ordered.get(var, True):
            index = next((i for i, v in enumerate(values)
                          if str(v) == str(current)), None)
            if index is None:
                neighbours = list(values)
            else:
                for j in (index - 1, index + 1):
                    if 0 <= j < len(values):
                        neighbours.append(values[j])
        else:
            # An unordered knob (a cache type) has no adjacency, so the
            # neighbourhood is every other value it can take.
            neighbours = [v for v in values if str(v) != str(current)]

        for value in neighbours:
            overrides = dict(base)
            overrides[var] = value
            cand = Candidate(grid.profile, overrides, stage="refine")
            if cand.sha in seen_sha:
                continue
            seen_sha.add(cand.sha)
            why = infeasible_reason(cand, grid, profile_json)
            if why:
                rejected.append((cand, why))
                continue
            cand.predicted_config_id = config_id_of(cand)["config_id"]
            if cand.predicted_config_id in seen_config:
                rejected.append((cand, f"duplicate of config "
                                        f"{cand.predicted_config_id}"))
                continue
            seen_config.add(cand.predicted_config_id)
            out.append(cand)
    return out, rejected


def infeasible_reason(cand: Candidate, grid: Grid,
                      profile_json: dict) -> str | None:
    """Why this candidate cannot be measured, before anything is launched.

    Every check here is one that would otherwise cost a full server load to
    discover, and two of them would not announce themselves at all: llama-env.sh
    silently blanks --n-cpu-moe for a dense profile (so two candidates would
    collapse onto one configuration and be measured as if they were two), and a
    --parallel inside LLAMA_SPEC is passed twice and recorded wrong, which is
    the exact defect the 2026-08-23 entry describes.
    """
    if profile_json.get("arch") == "dense" and cand.overrides.get("LLAMA_MOE"):
        return "dense profile: --n-cpu-moe is dropped by llama-env.sh"
    spec = cand.overrides.get("LLAMA_SPEC", "")
    if "--parallel" in spec:
        return "--parallel inside LLAMA_SPEC is passed twice; use LLAMA_PARALLEL"
    broken = grid.violated(cand.overrides, profile_json)
    if broken:
        return f"constraint: {broken}"
    return None


# ---------------------------------------------------------------------------
# statistics: the elimination rule
# ---------------------------------------------------------------------------
def median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def log_ratios(matrix: dict, candidate: str, baseline: str,
               items: list[tuple[str, str]]) -> list[float]:
    """ln(candidate t/s / baseline t/s), per item both of them served.

    A ratio rather than a difference, and a median rather than a mean, for two
    separate reasons. The ratio is invariant to a machine-wide slowdown that
    hits both arms -- which is what a thermal cap is, and what made the
    2026-09-05 throughput comparison unanalysable. The median survives one
    pathological item, which on DS-1000 is a real prospect.
    """
    out = []
    for key in items:
        a = matrix.get((*key, candidate))
        b = matrix.get((*key, baseline))
        if not a or not b:
            continue
        ta, tb = a.get("gen_tps"), b.get("gen_tps")
        if ta and tb and ta > 0 and tb > 0:
            out.append(math.log(ta / tb))
    return out


def sign_test(values: list[float]) -> tuple[float, int]:
    """Two-sided exact sign test on paired differences. Returns (p, n non-zero).

    Used before a cut, not to justify it: if the two candidates either side of
    the line cannot be told apart, the cut is recorded as unsupported rather
    than presented as a finding. Elimination on throughput alone is not
    unconditionally safe, and the honest thing is to say which cuts were
    guesses.
    """
    nonzero = [v for v in values if v != 0]
    n = len(nonzero)
    if n == 0:
        return 1.0, 0
    k = sum(1 for v in nonzero if v > 0)
    k = min(k, n - k)
    tail = sum(math.comb(n, i) for i in range(k + 1))
    return min(1.0, 2 * tail / (2 ** n)), n


# ---------------------------------------------------------------------------
# serving one candidate
# ---------------------------------------------------------------------------
OOM_PATTERN = re.compile(
    r"out of memory|cudaMalloc|failed to allocate|ggml_backend_.*alloc.*failed",
    re.I)

#: Serving is not the only way to fail, and the four are not interchangeable.
#: An OOM prunes a region of the grid; a load error is a bug in the grid or the
#: build; a timeout may be a slow disk on a cold page cache. They are recorded
#: apart so a reader can tell "this configuration does not fit" from "this
#: configuration was never actually tried".
class Infeasible(RuntimeError):
    def __init__(self, kind: str, reason: str):
        super().__init__(reason)
        self.kind = kind
        self.reason = reason


class Server:
    """One `llama-serve` under a candidate's overrides, and its readiness.

    Readiness is `GET /v1/models`, deliberately not a TCP connect: llama-server
    binds the port before it loads the model, so a port check would start the
    clock on a candidate whose weights are still being read and hand the first
    items of a visit a partially warmed cache.

    Launching is pluggable through LLAMA_TUNE_LAUNCH so the whole algorithm can
    be exercised against a stub with no GPU. That is not a testing convenience
    bolted on: fault injection -- refuse to bind, OOM, hang past the timeout,
    die mid-visit, drop to 12% throughput -- is where this module's real
    defects live, and none of them can be provoked on demand from real hardware.
    """

    def __init__(self, candidate: Candidate, port: int, *, load_timeout: float,
                 con):
        self.candidate = candidate
        self.port = port
        self.load_timeout = load_timeout
        self.con = con
        self.cmd: Command | None = None
        self.load_ms: float | None = None
        self.tail: deque[str] = deque(maxlen=40)
        self._drain: threading.Thread | None = None

    def _command(self) -> str:
        launch = os.environ.get("LLAMA_TUNE_LAUNCH")
        if launch:
            return f"{launch} {shlex.quote(self.candidate.profile)}"
        return f"llama-serve {shlex.quote(self.candidate.profile)}"

    def start(self) -> None:
        self.cmd = Command(self._command(), env=self.candidate.env(), plain=True)
        self.cmd.start()
        # Drained on a thread rather than read at the end. The pipe is 64 KiB
        # and llama-server runs at -lv 4, so a server left unread blocks on
        # write partway through loading and the tuner waits out its whole load
        # timeout on a process that is alive and stuck. The tail is kept for
        # the OOM classification below.
        self._drain = threading.Thread(target=self._pump, daemon=True)
        self._drain.start()

    def _pump(self) -> None:
        try:
            for line in self.cmd.lines():
                self.tail.append(line)
        except (ValueError, OSError):
            pass

    def ready(self) -> bool:
        try:
            with urllib.request.urlopen(
                    f"http://127.0.0.1:{self.port}/v1/models", timeout=3) as r:
                return r.status == 200
        except (urllib.error.URLError, OSError, ValueError):
            return False

    def wait(self) -> float:
        """Block until the model answers, or raise Infeasible saying why."""
        started = time.time()
        while time.time() - started < self.load_timeout:
            if self.ready():
                self.load_ms = (time.time() - started) * 1000.0
                return self.load_ms
            if self.cmd is not None and not self.cmd.running:
                text = "\n".join(self.tail)
                if OOM_PATTERN.search(text):
                    raise Infeasible("oom", _tail_reason(text))
                raise Infeasible("load_error", _tail_reason(text))
            time.sleep(1.0)
        self.stop()
        raise Infeasible("load_timeout",
                         f"no /v1/models within {self.load_timeout:.0f}s")

    def pgid(self) -> int | None:
        if self.cmd is None or self.cmd.proc is None:
            return None
        try:
            return os.getpgid(self.cmd.proc.pid)
        except (ProcessLookupError, OSError):
            return None

    def stop(self) -> None:
        """SIGINT first, so the recorder closes its own run.

        `llama-serve` backgrounds llama-vram-log.sh and kills it on the way
        out; killing the group outright leaves the run row open for
        sweep_stale_runs to close as 'stale'. A sweep of eighty visits would
        then have the store claiming eighty servers crashed, and the one that
        genuinely did would be indistinguishable.
        """
        if self.cmd is None:
            return
        if self.cmd.running:
            self.cmd.interrupt()
            deadline = time.time() + 20.0
            while self.cmd.running and time.time() < deadline:
                time.sleep(0.5)
        if self.cmd.running:
            self.cmd.stop(grace=10.0)
        if self._drain is not None:
            self._drain.join(timeout=5.0)


def _tail_reason(text: str) -> str:
    lines = [ln for ln in text.strip().splitlines() if ln.strip()]
    return " / ".join(lines[-3:])[:400] or "no output"


def port_busy(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/models",
                                    timeout=3) as r:
            return r.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False


def kill_pgid(pgid: int | None) -> bool:
    """Stop an orphan from an earlier, crashed sweep. Signals only its group."""
    if not pgid or pgid <= 1:
        return False
    import signal as _signal
    for sig in (_signal.SIGINT, _signal.SIGTERM, _signal.SIGKILL):
        try:
            os.killpg(pgid, sig)
        except (ProcessLookupError, PermissionError, OSError):
            return sig is not _signal.SIGINT
        time.sleep(3.0)
    return True


# ---------------------------------------------------------------------------
# cooldown
# ---------------------------------------------------------------------------
class GpuProbe:
    """What nvidia-smi says with nothing served.

    The one place the tuner reads the GPU without the recorder, and it exists
    because the recorder needs a served port while the entire point of a pause
    is that nothing is served. The throttle mask is decoded through
    llama_stats.throttle_reasons so a pause and a run name the same hardware
    state in the same words -- `SwPowerCap` in a pause table and `SwPowerCap`
    in a run summary have to be comparable by eye.
    """

    QUERY = "temperature.gpu,power.draw,clocks_throttle_reasons.active"

    def __init__(self):
        self.binary = os.environ.get("LLAMA_TUNE_NVIDIA_SMI", "nvidia-smi")

    def read(self) -> dict | None:
        try:
            proc = subprocess.run(
                [self.binary, f"--query-gpu={self.QUERY}",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=20)
        except (OSError, subprocess.SubprocessError):
            return None
        if proc.returncode != 0 or not proc.stdout.strip():
            return None
        parts = [p.strip() for p in proc.stdout.strip().splitlines()[0].split(",")]
        if len(parts) < 3:
            return None
        try:
            temp = float(parts[0])
            power = float(parts[1])
        except ValueError:
            return None
        raw = parts[2]
        try:
            mask = int(raw, 16) if raw.lower().startswith("0x") else int(raw)
        except ValueError:
            mask = 0
        return {"temp": temp, "power": power, "throttle": mask,
                "reasons": stats.throttle_reasons([{"throttle": mask}])}


#: The bits that invalidate a measurement, as opposed to describing an idle
#: card. GpuIdle and the clock-setting bits are expected and are not faults
#: (2026-08-23); the thermal and power ones are what a cooldown waits out.
#: Named from llama_stats.THROTTLE_BITS rather than written as a hex literal,
#: so a bit renamed there does not leave a silently wrong mask here.
BAD_REASONS = {"SwPowerCap", "HwSlowdown", "SwThermalSlowdown",
               "HwThermalSlowdown", "HwPowerBrakeSlowdown"}
THERMAL_POWER_MASK = 0
for _bit, _name in stats.THROTTLE_BITS:
    if _name in BAD_REASONS:
        THERMAL_POWER_MASK |= _bit


def throttled(sample: dict | None) -> bool:
    return bool(sample and (sample["throttle"] & THERMAL_POWER_MASK))


class Cooldown:
    """Stop, let the card recover, prove it recovered, resume.

    The design decision worth stating is step 3. An idle GPU reports `GpuIdle`
    and clears its thermal and power bits **by construction**, so idle
    telemetry can never show that recovery will hold under load -- it shows
    only that nothing is currently loading it. Waiting for clear bits and then
    resuming would therefore resume onto a still-capped card and file its
    throughput under whichever candidate came next. So recovery is confirmed by
    re-serving the baseline and re-measuring items already measured, against a
    number already known.

    The loop is bounded, and that bound is not defensive coding. On 2026-09-05
    generation fell from 49.4 to 6.1 t/s and never recovered across the
    following 72 requests; an unbounded cooldown would have spent an entire
    overnight budget waiting on a card that was capped rather than hot.

    The probe writes no `result` rows. It re-asks items whose verdicts are
    already stored, so recording them again would both spend budget and collide
    with UNIQUE (suite_run_id, benchmark, item_id). It calls harness.ask()
    directly and keeps only the timings.
    """

    def __init__(self, sweep, opts):
        self.sweep = sweep
        self.o = opts
        self.gpu = GpuProbe()
        self.total_seconds = 0.0
        self.count = 0

    def budget_exhausted(self) -> bool:
        limit = self.sweep.budget.seconds
        if limit is None:
            return False
        return self.total_seconds > limit * self.o.max_cooldown_share

    def run(self, *, trigger: str, rnd: int, visit_id: int | None,
            drift_ratio: float | None) -> str:
        """Cool until the baseline probes clean. Returns the resolution word."""
        con, db_con = self.sweep.con, self.sweep.db
        before = self.gpu.read()
        pause_id = db.open_pause(
            db_con, self.sweep.sweep_id, trigger=trigger, rnd=rnd,
            visit_id=visit_id, attempt=self.count + 1, drift_ratio=drift_ratio,
            throttle_before=(before or {}).get("reasons"),
            temp_before=(before or {}).get("temp"),
            power_before=(before or {}).get("power"))
        db_con.commit()
        self.count += 1

        # Auto: 8 C under the temperature observed while throttling, floored so
        # a card that idles warm is not waited on forever.
        target = self.o.cooldown_temp
        if target is None:
            target = max(55.0, ((before or {}).get("temp") or 75.0) - 8.0)

        started = time.time()
        window = self.o.cooldown_max
        resolution = "timeout"
        probe_tps = None
        for attempt in range(1, self.o.cooldown_attempts + 1):
            con.warn(f"cooling ({trigger}, attempt {attempt}/"
                     f"{self.o.cooldown_attempts}): waiting for the card to "
                     f"settle below {target:.0f}C with the thermal and power "
                     f"bits clear")
            self._wait(target, window, con)
            probe_tps = self._probe(con)
            if probe_tps is not None and self.sweep.baseline_tps:
                ratio = probe_tps / self.sweep.baseline_tps
                con.note(f"  probe {probe_tps:.2f} t/s against a round-1 "
                         f"baseline of {self.sweep.baseline_tps:.2f} "
                         f"({ratio:.2f}x)")
                if abs(1 - ratio) <= self.o.drift_tolerance:
                    resolution = "recovered"
                    break
            elif probe_tps is not None:
                resolution = "recovered"
                break
            # Doubling rather than retrying the same window: if the first wait
            # was not enough, waiting the same amount again is a guess that has
            # already been wrong once.
            window *= 2
            self.total_seconds = time.time() - started
            if self.budget_exhausted():
                resolution = "timeout"
                break

        self.total_seconds += time.time() - started
        after = self.gpu.read()
        db.close_pause(db_con, pause_id, resolution=resolution,
                       throttle_after=(after or {}).get("reasons"),
                       temp_after=(after or {}).get("temp"),
                       power_after=(after or {}).get("power"),
                       probe_tps=probe_tps)
        db_con.commit()
        self.sweep.last_pause_at = time.time()
        if resolution == "recovered":
            con.note(f"resumed after {time.time() - started:.0f}s of cooling")
        else:
            con.warn(f"gave up cooling after {time.time() - started:.0f}s; "
                     f"the card did not return to its round-1 throughput")
        return resolution

    def _wait(self, target: float, window: float, con) -> None:
        """Poll until clear-and-cool has held, or the window elapses."""
        deadline = time.time() + window
        held_since = None
        while time.time() < deadline:
            sample = self.gpu.read()
            if sample is None:
                # No nvidia-smi is not a reason to resume immediately: the
                # probe still gates recovery, so fall back to serving out the
                # window rather than pretending the card is cool.
                time.sleep(self.o.cooldown_poll)
                continue
            calm = not throttled(sample) and sample["temp"] <= target
            if calm:
                held_since = held_since or time.time()
                if time.time() - held_since >= self.o.cooldown_hold:
                    return
            else:
                held_since = None
            time.sleep(self.o.cooldown_poll)

    def _probe(self, con) -> float | None:
        """Serve the baseline and re-ask a few already-measured items."""
        rows = self.sweep.probe_rows()
        if not rows:
            return None
        server = Server(self.sweep.baseline, self.sweep.port,
                        load_timeout=self.o.load_timeout, con=con)
        try:
            server.start()
            server.wait()
            model = harness.served_model(self.sweep.port,
                                         self.sweep.profile_dict, con)
            rates = []
            for row in rows:
                prompt = bench.render_prompt(row["adapter"], row["item"])
                ans = harness.ask(prompt, model, self.sweep.profile_dict,
                                  self.sweep.port, con, stream=False,
                                  show=False, system=self.sweep.system)
                if ans.gone or ans.error:
                    continue
                rate = _tps(ans.timings)
                if rate:
                    rates.append(rate)
            return median(rates)
        except Infeasible as exc:
            con.warn(f"  probe could not serve the baseline: {exc.reason}")
            return None
        finally:
            server.stop()


def _tps(timings: dict | None) -> float | None:
    if not timings:
        return None
    n, ms = timings.get("predicted_n"), timings.get("predicted_ms")
    try:
        return (float(n) / float(ms)) * 1000.0 if n and ms else None
    except (TypeError, ValueError, ZeroDivisionError):
        return None


# ---------------------------------------------------------------------------
# the sweep
# ---------------------------------------------------------------------------
class Args:
    """The handful of attributes llama_test.context() reads off a namespace."""

    def __init__(self, **kw):
        self.__dict__.update(kw)


class Sweep:
    """One search: candidates, rounds, drift control, guard, verdict."""

    def __init__(self, opts, con):
        self.o = opts
        self.con = con
        self.db = db.connect()
        self.sweep_id = opts.sweep_id or time.strftime(
            "tune-%Y%m%dT%H%M%SZ", time.gmtime())
        self.profile_dict = harness.profile(opts.profile)
        self.profile_name = self.profile_dict.get("name") or opts.profile
        self.port = harness.port(self.profile_dict)
        self.profile_json = console_profile(self.profile_name)
        self.grid = load_grid(opts.grid, self.profile_name)
        self.system = harness.load_system(opts.system)

        self.adapters = bench.load_adapters()
        self.suite = bench.load_suite(opts.tier)
        selected, self.skipped = bench.build_suite(
            self.suite, self.adapters, only=opts.benchmark)
        if not selected:
            raise refuse(f"llama-tune: tier '{opts.tier}' selected no items")
        self.items = bench.interleave(selected)
        self.order_sha = bench.order_sha(self.items)

        mode = MODES[opts.budget]
        self.budget = Budget(
            opts.budget,
            seconds=(round(opts.max_hours * 3600) if opts.max_hours
                    else mode["seconds"]),
            visits=(opts.max_visits or mode["visits"]),
            candidates=(opts.candidates or mode["candidates"]),
            round_items=(opts.round_items or mode["round_items"]))
        self.schedule = plan_schedule(len(self.items), self.budget.candidates,
                                      self.budget.round_items, opts.eta)

        self.started = time.time()
        self.visits = 0
        self.baseline: Candidate | None = None
        self.candidates: dict[str, Candidate] = {}
        self.baseline_tps: float | None = None
        self.last_pause_at: float | None = None
        self.cool = Cooldown(self, opts)
        self.load_ms: list[float] = []
        self.serve_seconds = 0.0
        self.ended_reason = "complete"

    # -- setup -------------------------------------------------------------
    def suite_run_id(self, cand: Candidate) -> str:
        """One suite run per (sweep, candidate).

        The highest-value reuse in the whole design: the existing
        UNIQUE (suite_run_id, benchmark, item_id) then makes double-counting
        across rounds impossible *at the schema level* rather than by the round
        loop being careful, and db.completed() gives crash-safe per-candidate
        resume for free -- the same mechanism --resume already uses.
        """
        return f"{self.sweep_id}-{cand.sha[:6]}"

    def register(self, cands: list[Candidate]) -> None:
        for c in cands:
            self.candidates[c.sha] = c
            if c.baseline:
                self.baseline = c
        # config_id is deliberately NOT written here, even though config_id_of
        # has already predicted it (that prediction is what the dry-run table
        # shows). tune_candidate.config_id is a foreign key into config, and no
        # config row exists until a server under these flags has actually
        # bound and the recorder has upserted one -- a candidate that OOMs on
        # load never gets one at all. Writing the prediction here would fail
        # that constraint immediately (a candidate cannot be registered before
        # it is ever served) and, worse, would sometimes silently succeed by
        # colliding with an unrelated existing config row of the same id. The
        # real id is attached in visit() once the recorder confirms it.
        db.add_candidates(self.db, self.sweep_id, [
            {"candidate_sha": c.sha, "stage": c.stage,
             "overrides": json.dumps(c.overrides), "is_baseline": c.baseline,
             "suite_run_id": self.suite_run_id(c)}
            for c in cands])
        self.db.commit()

    def open(self) -> None:
        db.open_sweep(
            self.db, self.sweep_id, pid=os.getpid(), profile=self.profile_name,
            tier=self.o.tier, benchmark=self.o.benchmark,
            system_name=(self.system or {}).get("name"),
            system_sha=(self.system or {}).get("sha"),
            grid_path=str(self.grid.path), grid_sha=self.grid.sha,
            item_order_sha=self.order_sha, item_count=len(self.items),
            budget_mode=self.budget.mode, budget_seconds=self.budget.seconds,
            budget_visits=self.budget.visits, eta=self.o.eta,
            round_items=self.budget.round_items,
            candidates=self.budget.candidates, stages=",".join(self.o.stages),
            objective="gen_tps",
            alpha=self.o.alpha, on_drift=self.o.on_drift, seed=self.o.seed)
        self.db.commit()

    def guard_port(self) -> None:
        """Refuse to measure a server this sweep did not start.

        A port that already answers is somebody else's model, and running items
        against it would file their throughput under a candidate whose flags
        were never in effect. The one exception is an orphan from this sweep's
        own crashed visit, which is identified by the pgid the visit recorded
        and killed rather than measured.

        By the time this runs, a crash's visit is almost never still 'running':
        connect() (called both here and, again, by this very Sweep's own
        __init__) already ran sweep_stale_sweeps() first, which reclassifies
        any visit whose tuner pid is dead to 'aborted'/'tuner gone' before this
        method ever sees it. Looking only for 'running' therefore missed every
        real crash and left the orphaned server listening forever -- a resume
        would kill nothing and immediately refuse on the port it was written to
        recover from. So both states are treated as the same orphan here.
        """
        if not port_busy(self.port):
            return
        candidates = [v for v in db.sweep_visits(self.db, self.sweep_id)
                     if v["status"] == "running"
                     or (v["status"] == "aborted" and v["reason"] == "tuner gone")]
        killed_one = False
        for orphan in candidates:
            if orphan["server_pgid"]:
                self.con.warn(f"killing an orphaned server from visit "
                              f"{orphan['visit_id']} (pgid "
                              f"{orphan['server_pgid']})")
                kill_pgid(orphan["server_pgid"])
                killed_one = True
            if orphan["status"] == "running":
                db.close_visit(self.db, orphan["visit_id"], status="aborted",
                               reason="orphaned by a crash")
                self.db.commit()
        if not killed_one or port_busy(self.port):
            raise refuse(
                f"llama-tune: something is already serving on port {self.port} "
                f"and this sweep did not start it. Measuring it would file its "
                f"throughput under a candidate whose flags were never in "
                f"effect. Stop it, then re-run.")

    # -- one visit ---------------------------------------------------------
    def rows_for(self, lo: int, hi: int, cand: Candidate) -> list[dict]:
        done = store.completed(self.db, self.suite_run_id(cand))
        return [r for r in self.items[lo:hi]
                if (r["benchmark"], r["item_id"]) not in done]

    def probe_rows(self) -> list[dict]:
        n = max(1, self.o.cooldown_probe)
        return self.items[:n]

    def visit(self, cand: Candidate, rnd: int, lo: int, hi: int,
              attempt: int = 1) -> dict:
        """Serve one candidate and run its slice. Never raises for a bad config.

        Returns a small summary; everything durable is already committed.
        """
        todo = self.rows_for(lo, hi, cand)
        if not todo:
            return {"status": "done", "items": 0, "drift": None}

        since = (time.time() - self.last_pause_at) if self.last_pause_at else None
        visit_id = db.open_visit(self.db, self.sweep_id, cand.sha, rnd,
                                 attempt=attempt, item_from=lo, item_to=hi,
                                 since_pause_seconds=since)
        self.db.commit()
        self.con.rule(f"round {rnd} - {cand.label} - items {lo}:{hi}"
                      + (f" (attempt {attempt})" if attempt > 1 else ""))
        self.con.note(cand.flags())

        server = Server(cand, self.port, load_timeout=self.o.load_timeout,
                        con=self.con)
        drift: str | None = None
        records: list[dict] = []
        t0 = time.time()
        try:
            server.start()
            load_ms = server.wait()
            self.load_ms.append(load_ms)
            db.set_visit(self.db, visit_id, server_pgid=server.pgid(),
                         load_ms=load_ms)
            self.db.commit()

            ctx = harness.context(
                Args(profile=self.profile_name, run_id=self.suite_run_id(cand),
                     system=self.o.system),
                self.con, self.suite["id"], int(self.suite.get("seed", 0)),
                sorted({r["benchmark"] for r in todo}))
            if cand.predicted_config_id and ctx["config_id"] \
                    and ctx["config_id"] != cand.predicted_config_id:
                # Not fatal, but it means the fingerprint the sweep planned
                # with and the one the recorder observed disagree, and every
                # comparison downstream keys on the recorder's.
                self.con.warn(
                    f"  the recorder filed this visit under {ctx['config_id']}, "
                    f"not the {cand.predicted_config_id} llama-config-id "
                    f"predicted")
            if ctx["config_id"]:
                # Only the confirmed id is ever written: config_id is a
                # foreign key into config, and the prediction has no row there
                # until this moment. A hand-started server or (in the stub
                # checks) no recorder at all leaves this None, and the visit's
                # rows are still written -- they just carry no config_id, which
                # is the same "unrecorded" case a hand-started server has
                # always produced.
                cand.config_id = ctx["config_id"]
                db.set_candidate(self.db, self.sweep_id, cand.sha,
                                 config_id=cand.config_id)
                db.set_visit(self.db, visit_id, run_id=ctx["run_id"],
                             config_id=cand.config_id)
            else:
                db.set_visit(self.db, visit_id, run_id=ctx["run_id"])
            self.db.commit()

            watch = CollapseWatch(self.o.cliff_ratio)
            try:
                harness.run_items(todo, ctx, self.con, show=False,
                                  results=records, on_record=watch,
                                  should_stop=lambda: watch.collapsed
                                  or self.spent() is not None)
            finally:
                ctx["db"].close()
            drift = "cliff" if watch.collapsed else None
        except Infeasible as exc:
            db.close_visit(self.db, visit_id, status="infeasible",
                           reason=f"{exc.kind}: {exc.reason}",
                           items_done=0, counts_toward_round=0)
            db.set_candidate(self.db, self.sweep_id, cand.sha,
                             status="infeasible",
                             status_reason=f"{exc.kind}: {exc.reason}")
            cand.status, cand.reason = "infeasible", exc.reason
            self.db.commit()
            self.con.warn(f"  {exc.kind}: {exc.reason}")
            return {"status": "infeasible", "items": 0, "drift": None}
        except harness.ServerGone as exc:
            # The server died under us. The items that landed are committed and
            # the rest were never written, so the candidate is re-visited on the
            # next round rather than eliminated on a truncated slice.
            db.close_visit(self.db, visit_id, status="aborted",
                           reason=str(exc)[:400], items_done=len(records),
                           counts_toward_round=0)
            self.db.commit()
            self.con.warn(f"  server gone after {len(records)} items")
            return {"status": "aborted", "items": len(records), "drift": None}
        except KeyboardInterrupt:
            db.close_visit(self.db, visit_id, status="aborted",
                           reason="interrupted", items_done=len(records),
                           counts_toward_round=0)
            self.db.commit()
            raise
        finally:
            server.stop()
            self.serve_seconds += time.time() - t0

        counts = 0 if drift else 1
        db.close_visit(self.db, visit_id, status="done", items_done=len(records),
                       counts_toward_round=counts,
                       reason="drift" if drift else "")
        self.db.commit()
        if drift:
            self.con.warn(f"  throughput collapsed mid-visit; this visit's "
                          f"{len(records)} items are excluded from the round")
        return {"status": "done", "items": len(records), "drift": drift,
                "visit_id": visit_id}

    def spent(self) -> str | None:
        return self.budget.spent(self.started, self.visits)

    def stopped(self) -> bool:
        """Whether the round loop must not start another round.

        A spent budget is one reason. The other is a fall_back() that already
        decided to end the sweep on a drift the card never recovered from
        (--on-drift halt): it sets ended_reason but, unlike the budget, has no
        counter the loop checks on its own, so a caller must ask this after
        every run_round() rather than only before it.
        """
        return self.spent() is not None or self.ended_reason != "complete"

    # -- rounds ------------------------------------------------------------
    def record_rejected(self, rejected: list[tuple[Candidate, str]]) -> None:
        """Candidates the grid ruled out, stored rather than silently dropped.

        A reader asking why a knob value never appears in the results deserves
        an answer from the database, not from re-running the sampler.
        """
        if not rejected:
            return
        db.add_candidates(self.db, self.sweep_id, [
            {"candidate_sha": c.sha, "stage": c.stage,
             "overrides": json.dumps(c.overrides), "is_baseline": False,
             "suite_run_id": self.suite_run_id(c), "status": "infeasible"}
            for c, _ in rejected])
        for cand, why in rejected:
            db.set_candidate(self.db, self.sweep_id, cand.sha,
                             status="infeasible", status_reason=why[:400])
        self.db.commit()

    def scores(self, rnd: int | None) -> dict[str, tuple[float | None, int]]:
        """Median paired log-ratio against the baseline, per candidate."""
        matrix = db.tune_matrix(self.db, self.sweep_id, rnd=rnd)
        items = sorted({(k[0], k[1]) for k in matrix})
        base = self.baseline.sha
        out: dict[str, tuple[float | None, int]] = {}
        for sha in self.candidates:
            ratios = log_ratios(matrix, sha, base, items)
            out[sha] = (median(ratios), len(ratios))
        return out

    def absolute_baseline(self, rnd: int) -> float | None:
        matrix = db.tune_matrix(self.db, self.sweep_id, rnd=rnd)
        rates = [c["gen_tps"] for k, c in matrix.items()
                 if k[2] == self.baseline.sha and c["gen_tps"]]
        return median(rates)

    def run_round(self, rnd: int, stage: str, alive: list[Candidate],
                  lo: int, hi: int) -> list[Candidate]:
        """Visit every survivor once, then decide who survives.

        Idempotent by design, not just by intent: it is called a second time
        for the *same* round number whenever a resume finds this round's
        `tune_round` row still open (no `ended_at`), which means budget ran
        out mid-round last time. Re-deriving `already` from `tune_visit`
        skips whoever already has a done visit here rather than re-visiting
        them (`open_visit` has no ON CONFLICT and would raise on the unique
        (sweep_id, candidate_sha, round, attempt) index), and elimination is
        withheld -- not run on whatever partial data exists -- until every
        survivor has actually been visited in this round. Closing early on a
        thin sample was the original bug: it let "budget ran out after 2 of
        11 candidates" read as a real "kept 11 of 11" decision, which then
        made the round look finished to every future resume.
        """
        db.open_round(self.db, self.sweep_id, rnd, stage=stage, item_from=lo,
                      item_to=hi, survivors=len(alive))
        self.db.commit()
        # A visit only counts as "handled" here if it either landed data that
        # counts toward the round or is permanently infeasible. A drift- or
        # crash-discarded visit (status 'done' with counts_toward_round=0, or
        # 'aborted') still owes this round a real attempt, whether that retry
        # happens later in this same call (the cooldown branch below) or on a
        # resume that re-enters this round after a crash caught it mid-retry.
        visits_here = db.sweep_visits(self.db, self.sweep_id, rnd=rnd)
        already = {v["candidate_sha"] for v in visits_here
                  if v["status"] == "infeasible"
                  or (v["status"] == "done" and v["counts_toward_round"])}
        # UNIQUE (sweep_id, candidate_sha, round, attempt) means a re-visit
        # after a crash or a drift-discarded attempt must claim the next
        # attempt number, not assume it is the first (a resume) or the
        # second (the cooldown retry below) -- either guess collides with a
        # leftover row from an attempt that never got the chance to count.
        next_attempt = {}
        for v in visits_here:
            next_attempt[v["candidate_sha"]] = max(
                next_attempt.get(v["candidate_sha"], 0), v["attempt"]) + 1

        # rotate: the first candidate of a round pays whatever a cold page
        # cache costs, and always making the same one pay it would confound
        # candidate with position for the whole sweep.
        order = alive[rnd % len(alive):] + alive[:rnd % len(alive)]
        order = [c for c in order if c.sha not in already]
        cut_short = False
        for cand in order:
            if self.spent():
                self.ended_reason = self.spent()
                cut_short = True
                break
            attempt = next_attempt.get(cand.sha, 1)
            outcome = self.visit(cand, rnd, lo, hi, attempt=attempt)
            self.visits += 1
            next_attempt[cand.sha] = attempt + 1
            if outcome["status"] == "infeasible":
                continue
            if outcome["drift"]:
                if self.o.on_drift == "cooldown":
                    resolution = self.cool.run(trigger="cliff", rnd=rnd,
                                               visit_id=outcome.get("visit_id"),
                                               drift_ratio=None)
                    if resolution == "recovered":
                        # Runs the *remainder* of the slice, not the whole of
                        # it: the contaminated attempt's rows are already in
                        # `result` and UNIQUE (suite_run_id, benchmark,
                        # item_id) forbids rewriting them. They keep their
                        # verdicts, which the correctness guard still uses,
                        # and are excluded from the round's throughput
                        # statistic by counts_toward_round=0.
                        attempt = next_attempt[cand.sha]
                        self.visit(cand, rnd, lo, hi, attempt=attempt)
                        self.visits += 1
                        next_attempt[cand.sha] = attempt + 1
                    elif not self.fall_back(rnd):
                        cut_short = True
                        break
                # --on-drift halt|segment skips cooldown outright and asks
                # fall_back() directly what a cliff means under that policy,
                # rather than only ever reaching it through a failed cooldown.
                elif not self.fall_back(rnd):
                    cut_short = True
                    break

        if cut_short:
            # Leave the round open (no close_round) and nobody eliminated:
            # a resume re-enters run_round for this same round number and
            # finishes visiting whoever `already` does not yet name.
            return alive

        alive = [c for c in alive if c.status != "infeasible"]
        base_tps = self.absolute_baseline(rnd)
        if rnd == 1 and base_tps:
            self.baseline_tps = base_tps
        ratio = (base_tps / self.baseline_tps
                 if base_tps and self.baseline_tps else None)
        if ratio is not None and abs(1 - ratio) > self.o.drift_tolerance:
            self.con.warn(f"round {rnd}: the baseline moved to {ratio:.2f}x its "
                          f"round-1 throughput")
            if self.o.on_drift == "cooldown":
                resolution = self.cool.run(trigger="drift", rnd=rnd,
                                           visit_id=None, drift_ratio=ratio)
                if resolution != "recovered":
                    self.fall_back(rnd)
            else:
                # This round already ran to completion under the new regime,
                # so it is fair to close and score it; fall_back() decides
                # only whether a *later* round is allowed to start (halt) or
                # not (segment), via ended_reason below.
                self.fall_back(rnd)

        survivors, decision = self.eliminate(rnd, alive)
        db.close_round(self.db, self.sweep_id, rnd,
                       baseline_gen_tps=base_tps, drift_ratio=ratio,
                       decision=decision, survivors=len(survivors))
        self.db.commit()
        return survivors

    def fall_back(self, rnd: int) -> bool:
        """What an unrecoverable card means, per budget mode. False ends the sweep.

        `halt` for interactive, because somebody is waiting; `segment` for the
        unattended modes, which keeps measuring and lets audit_design decide
        afterwards whether the segments can be compared at all. Neither
        pretends the numbers either side of the cap are one population.
        """
        mode = self.o.on_drift
        if mode == "cooldown":
            mode = "halt" if self.budget.mode == "interactive" else "segment"
        if mode == "halt":
            self.ended_reason = "drift"
            self.con.warn("stopping: the card did not recover and this is an "
                          "interactive budget")
            return False
        self.con.warn("continuing under a changed machine state; the design "
                      "audit decides whether these rounds can be compared")
        return True

    def eliminate(self, rnd: int,
                  alive: list[Candidate]) -> tuple[list[Candidate], str]:
        keep_n = max(2, math.ceil(len(alive) / self.o.eta))
        if len(alive) <= 2:
            return alive, "kept all (at the floor)"
        scored = self.scores(rnd)
        matrix = db.tune_matrix(self.db, self.sweep_id, rnd=rnd)
        items = sorted({(k[0], k[1]) for k in matrix})

        # Too few paired items is not evidence of slowness. A candidate whose
        # visit was cut short by a dead server or a pause is re-visited rather
        # than eliminated on three items.
        thin = [c for c in alive
                if not c.baseline and scored.get(c.sha, (None, 0))[1] < 3]
        ranked = sorted(
            [c for c in alive if not c.baseline and c not in thin],
            key=lambda c: scored.get(c.sha, (None, 0))[0] or -math.inf,
            reverse=True)
        for c in alive:
            score, n = scored.get(c.sha, (None, 0))
            c.score = score
            self.con.note(
                f"  {c.label:<10} "
                + (f"{math.exp(score) - 1:+7.1%} over {n} paired items"
                   if score is not None else f"no paired items")
                + ("   [baseline]" if c.baseline else ""))
            if score is not None:
                db.set_candidate(self.db, self.sweep_id, c.sha, score=score)

        survivors = [self.baseline] + ranked[:max(1, keep_n - 1)] + thin
        cut = [c for c in ranked[max(1, keep_n - 1):]]
        decision = f"kept {len(survivors)} of {len(alive)}"

        if cut and ranked[:max(1, keep_n - 1)]:
            lowest = ranked[max(1, keep_n - 1) - 1]
            highest = cut[0]
            paired = [a - b for a, b in zip(
                log_ratios(matrix, lowest.sha, self.baseline.sha, items),
                log_ratios(matrix, highest.sha, self.baseline.sha, items))]
            p, n = sign_test(paired)
            if n and p > 0.20:
                decision = "uncertain"
                self.con.warn(f"  the cut between {lowest.label} and "
                              f"{highest.label} is not supported "
                              f"(sign test p = {p:.2f} on {n} pairs)")
                for c in cut:
                    db.set_candidate(
                        self.db, self.sweep_id, c.sha, status="eliminated",
                        eliminated_round=rnd,
                        status_reason="cut not statistically supported")
                self.db.commit()
                return survivors, decision

        for c in cut:
            c.status = "eliminated"
            db.set_candidate(self.db, self.sweep_id, c.sha, status="eliminated",
                             eliminated_round=rnd,
                             status_reason=f"slower over round {rnd}")
        self.db.commit()
        return survivors, decision

    # -- the whole search --------------------------------------------------
    def execute(self) -> int:
        self.guard_port()
        self.open()
        cands, rejected = sample_candidates(
            self.grid, self.profile_json, self.budget.candidates, self.o.seed)
        self.register(cands)
        self.record_rejected(rejected)

        alive = list(cands)
        rnd = 0
        try:
            for lo, hi in self.schedule.slices:
                if self.spent():
                    self.ended_reason = self.spent()
                    break
                rnd += 1
                alive = self.run_round(rnd, "explore", alive, lo, hi)
                if self.ended_reason != "complete":
                    break

            cursor = self.schedule.slices[-1][1]
            if "refine" in self.o.stages and not self.stopped():
                rnd, alive, cursor = self.refine(rnd, alive, cursor)
        except KeyboardInterrupt:
            self.ended_reason = "interrupted"
            self.con.warn(f"interrupted. resume with: "
                          f"llama-tune resume {self.sweep_id}")

        return self.finish(alive)

    def refine(self, rnd: int, alive: list[Candidate],
               cursor: int) -> tuple[int, list[Candidate], int]:
        """Coordinate descent around the leader, on items nobody has seen.

        It runs on the *remaining* prefix rather than re-using explore's items,
        because a refine candidate measured today against a baseline measured
        three hours ago is the confound this whole module is built to avoid.
        When the tier has no items left, refine is skipped and says so -- a
        stage that silently compared across a three-hour gap would be worse
        than a stage that did not run.
        """
        best = self.best(alive)
        if best is None or best.baseline:
            self.con.note("refine: nothing beat the profile's own defaults, so "
                          "there is no neighbourhood to descend into")
            return rnd, alive, cursor
        remaining = len(self.items) - cursor
        if remaining < self.budget.round_items:
            self.con.warn(
                f"refine skipped: {remaining} items left after explore and a "
                f"round needs {self.budget.round_items}. The refine stage "
                f"would have to re-use explore's items, and comparing a "
                f"candidate measured now against a baseline measured hours ago "
                f"is the confound this command exists to avoid. Run a larger "
                f"tier, or lower --round-items.")
            return rnd, alive, cursor

        cands, rejected = refine_candidates(self.grid, self.profile_json, best,
                                            alive)
        self.register([c for c in cands if c.sha not in self.candidates
                       or self.candidates[c.sha] is c])
        self.record_rejected(rejected)
        return self.run_refine_rounds(rnd, cands, cursor)

    def run_refine_rounds(self, rnd: int, alive: list[Candidate],
                          cursor: int) -> tuple[int, list[Candidate], int]:
        """The refine round loop, split out so resume can re-enter it.

        `refine()` calls this after generating this stage's candidates; a
        sweep resumed mid-refine already has them (loaded from
        `tune_candidate`) and must run more rounds for the *same* candidates
        rather than regenerate a fresh set from a `best()` computed at
        resume time, which is only defined over whatever `alive` it is
        handed.
        """
        remaining = len(self.items) - cursor
        while alive and remaining >= self.budget.round_items and not self.stopped():
            rnd += 1
            lo = cursor
            hi = min(len(self.items), cursor + self.budget.round_items)
            alive = self.run_round(rnd, "refine", alive, lo, hi)
            cursor, remaining = hi, len(self.items) - hi
            if len(alive) <= 2:
                break
            if self.ended_reason != "complete":
                break
        return rnd, alive, cursor

    def best(self, alive: list[Candidate]) -> Candidate | None:
        scored = self.scores(None)
        ranked = sorted(
            [c for c in alive if not c.baseline
             and scored.get(c.sha, (None, 0))[0] is not None],
            key=lambda c: scored[c.sha][0], reverse=True)
        return ranked[0] if ranked else None

    # -- the guard ---------------------------------------------------------
    def sweep_records(self) -> list[dict]:
        runs = {self.suite_run_id(c) for c in self.candidates.values()}
        return [r for r in db.results(self.db)
                if r.get("suite_run_id") in runs]

    def audit(self) -> tuple[str, object, list]:
        """The refusal contract, borrowed whole from llama-report.

        A second, more forgiving implementation of "can this design support
        this claim" is exactly the thing that would let a sweep announce a
        winner across a power cap, so the sweep's rows go through the same
        blocks_of/audit_design the report uses, on the config_id axis.
        """
        records = self.sweep_records()
        blocks = rep.blocks_of(records, level_factor="config_id")
        design, audit = rep.audit_design(self.db, records, blocks,
                                         rep.Regimes(self.db))
        return design, audit, blocks

    def guard(self, winner: Candidate) -> dict:
        """Winner vs incumbent, once, at the end. Never the word 'better'."""
        matrix = db.tune_matrix(self.db, self.sweep_id, counted_only=False)
        items = sorted({(k[0], k[1]) for k in matrix})
        b = c = both = wp = bp = 0
        for key in items:
            w = matrix.get((*key, winner.sha))
            i = matrix.get((*key, self.baseline.sha))
            if not w or not i:
                continue
            if w["outcome"] not in store.GRADED or i["outcome"] not in store.GRADED:
                continue
            both += 1
            wpass = w["outcome"] == store.PASS
            ipass = i["outcome"] == store.PASS
            wp += wpass
            bp += ipass
            if ipass and not wpass:
                b += 1
            elif wpass and not ipass:
                c += 1
        p, disc = rep.mcnemar_exact(b, c)
        psi = disc / both if both else 0.0
        return {"n": both, "b": b, "c": c, "p": p, "discordant": disc,
                "psi": psi, "winner_passed": wp, "incumbent_passed": bp,
                "mde": rep.detectable_effect(both, psi) if both else None,
                "needed": rep.items_needed(psi, 0.05) if psi else None,
                "regressed": (p < self.o.alpha and wp < bp)}

    # -- the verdict -------------------------------------------------------
    def finish(self, alive: list[Candidate]) -> int:
        """Decide, record and print. Three verdicts and an exit code each."""
        design, audit, blocks = self.audit()
        blocked = [r for b in blocks
                   for r in audit.blocked(f"throughput:{b.key}")]
        winner = self.best(alive)
        scored = self.scores(None)

        if self.ended_reason in ("budget", "visits", "interrupted", "drift"):
            verdict = "incomplete"
            reason = {
                "budget": "the time budget ran out mid-sweep",
                "visits": "the --max-visits cap was reached",
                "interrupted": "stopped by the user (SIGINT)",
                "drift": "gave up on drift recovery before finishing",
            }[self.ended_reason]
        elif blocked:
            verdict, reason = "indeterminate", "; ".join(blocked)[:400]
        elif winner is None:
            verdict, reason = "rejected", "no candidate beat the profile defaults"
        else:
            verdict, reason = "adopted", ""

        guard = None
        if verdict == "adopted":
            # Pre-registered, and it walks down the ranking rather than
            # stopping: rejecting the fastest candidate is a reason to look at
            # the next one, not a reason to abandon the sweep.
            ranked = sorted([c for c in alive if not c.baseline
                             and scored.get(c.sha, (None, 0))[0] is not None],
                            key=lambda c: scored[c.sha][0], reverse=True)
            for cand in ranked:
                guard = self.guard(cand)
                if not guard["regressed"]:
                    winner = cand
                    break
                db.set_candidate(self.db, self.sweep_id, cand.sha,
                                 status="rejected",
                                 status_reason="correctness regression "
                                               f"(McNemar p = {guard['p']:.3f})")
                winner = None
            if winner is None:
                verdict, reason = "rejected", "every faster candidate showed a " \
                                              "correctness regression"

        if winner is not None and verdict == "adopted":
            db.set_candidate(self.db, self.sweep_id, winner.sha, status="winner")
        db.close_sweep(self.db, self.sweep_id, reason=self.ended_reason,
                       verdict=verdict, verdict_reason=reason,
                       winner=winner.sha if winner and verdict == "adopted"
                       else None)
        self.db.commit()

        report_sweep(self.con, self.db, self.sweep_id, design=design,
                     blocked=blocked, guard=guard, fmt=self.o.format)
        return {"adopted": 0, "rejected": 0, "incomplete": 1,
                "indeterminate": 3}[verdict]


class CollapseWatch:
    """Watch a visit for the 2026-09-05 shape: a mid-run fall that never lifts.

    Round-level drift control compares one round's baseline against round 1's,
    which cannot see a cliff that happens *inside* a visit -- and that is
    exactly what happened on 2026-09-05, at 03:05:59Z, partway through run 4.
    So the running median over the last five requests is compared against the
    median of the visit's opening requests.
    """

    def __init__(self, ratio: float, window: int = 5, warmup: int = 4):
        self.ratio = ratio
        self.window = window
        self.warmup = warmup
        self.rates: list[float] = []
        self.opening: float | None = None
        self.collapsed = False

    def __call__(self, record: dict) -> None:
        rate = _tps(record.get("timings"))
        if not rate:
            return
        self.rates.append(rate)
        if len(self.rates) == self.warmup:
            self.opening = median(self.rates)
        if self.opening and len(self.rates) >= self.warmup + self.window:
            recent = median(self.rates[-self.window:])
            if recent is not None and recent < self.opening * self.ratio:
                self.collapsed = True


def console_profile(name: str) -> dict:
    """llama-profile-json for one profile, as a dict.

    Read from the shell rather than from llama_test.profile() because the
    constraint evaluator resolves an unset knob to the profile's *default*, and
    those defaults live in llama-env.sh. Getting them from anywhere else would
    make the grid's constraints true against a copy.
    """
    try:
        proc = subprocess.run([str(ENV_SH), "profile-json", name],
                              capture_output=True, text=True, timeout=60)
        if proc.returncode == 0:
            return json.loads(proc.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        pass
    return {}


# ---------------------------------------------------------------------------
# reporting
# ---------------------------------------------------------------------------
def emit(con, fmt: str, title: str, columns: list[str],
         rows: list[list[str]]) -> None:
    if not rows:
        return
    if fmt == "markdown":
        print(f"\n### {title}\n")
        print("\n".join(stats.render_table(columns, rows)))
    else:
        con.rule(title)
        con.table(columns, rows)


def pct(value: float | None) -> str:
    return "-" if value is None else f"{math.exp(value) - 1:+.1%}"


def report_sweep(con, dbc, sweep_id: str, *, design: str = "",
                 blocked: list[str] | None = None, guard: dict | None = None,
                 fmt: str = "table") -> None:
    """Everything operational about one sweep, in the order it is read in.

    The pause table and the wall-clock split come before the ranking on
    purpose: a sweep that spent 40% of an overnight budget cooling is a fact
    about the hardware, and a reader who sees the ranking first will have
    formed a conclusion before reaching the reason to distrust it.
    """
    row = db.sweep(dbc, sweep_id)
    if not row:
        raise refuse(f"llama-tune: no sweep '{sweep_id}'")
    cands = {c["candidate_sha"]: c for c in db.sweep_candidates(dbc, sweep_id)}
    rounds = db.sweep_rounds(dbc, sweep_id)
    visits = db.sweep_visits(dbc, sweep_id)
    pauses = db.sweep_pauses(dbc, sweep_id)

    con.rule(f"sweep {sweep_id}")
    con.note(f"profile={row['profile']} tier={row['tier']} "
             f"grid={row['grid_path']}@{row['grid_sha']} "
             f"budget={row['budget_mode']} seed={row['seed']} "
             f"items={row['item_count']} order={row['item_order_sha']}")
    con.note(f"verdict={row['verdict'] or 'running'} "
             f"({row['ended_reason'] or 'in progress'})"
             + (f": {row['verdict_reason']}" if row["verdict_reason"] else ""))
    if row["verdict"] == "incomplete":
        con.warn(f"  resume with: llama-tune resume {sweep_id}")

    serve = sum((v["load_ms"] or 0) / 1000.0 for v in visits)
    cooled = sum(p["seconds"] or 0 for p in pauses)
    emit(con, fmt, "time", ["what", "seconds", "share"], [
        ["reloading", f"{serve:.0f}", "-"],
        ["cooling", f"{cooled:.0f}",
         f"{cooled / row['budget_seconds']:.0%}" if row["budget_seconds"] else "-"],
        ["pauses", str(len(pauses)), "-"],
    ])

    emit(con, fmt, "rounds",
         ["round", "stage", "items", "survivors", "baseline t/s", "drift",
          "decision"],
         [[str(r["round"]), r["stage"], f"{r['item_from']}:{r['item_to']}",
           str(r["survivors"] or "-"),
           f"{r['baseline_gen_tps']:.2f}" if r["baseline_gen_tps"] else "-",
           f"{r['drift_ratio']:.2f}x" if r["drift_ratio"] else "-",
           r["decision"] or "-"] for r in rounds])

    emit(con, fmt, "pauses",
         ["started", "why", "seconds", "interrupted", "throttle before",
          "temp before", "temp after", "probe t/s", "resolution"],
         [[p["started_at"], p["trigger_kind"], f"{p['seconds'] or 0:.0f}",
           p["interrupted_candidate"] or "-", p["throttle_before"] or "-",
           f"{p['temp_before']:.0f}" if p["temp_before"] else "-",
           f"{p['temp_after']:.0f}" if p["temp_after"] else "-",
           f"{p['probe_tps']:.2f}" if p["probe_tps"] else "-",
           p["resolution"] or "open"] for p in pauses])

    matrix = db.tune_matrix(dbc, sweep_id)
    items = sorted({(k[0], k[1]) for k in matrix})
    base = next((c for c in cands.values() if c["is_baseline"]), None)
    ranking = []
    for sha, c in cands.items():
        if c["status"] == "infeasible":
            continue
        n = 0
        score = c["score"]
        if base:
            paired = log_ratios(matrix, sha, base["candidate_sha"], items)
            n = len(paired)
            score = median(paired) if paired else score
        ranking.append([
            sha[:8] + (" *" if c["is_baseline"] else ""),
            c["stage"], c["config_id"] or "-", pct(score), str(n),
            c["status"], (c["status_reason"] or "")[:60],
            json.loads(c["overrides"] or "{}") and
            " ".join(f"{k}={v}" for k, v in
                     sorted(json.loads(c["overrides"]).items())) or "(defaults)"])
    ranking.sort(key=lambda r: -(float(r[3].rstrip("%").replace("+", ""))
                                 if r[3] != "-" else -math.inf))
    emit(con, fmt, "candidates",
         ["candidate", "stage", "config", "median vs baseline", "paired items",
          "status", "why", "overrides"], ranking)

    infeasible = [[sha[:8], (c["status_reason"] or "")[:100]]
                  for sha, c in cands.items() if c["status"] == "infeasible"]
    emit(con, fmt, "not measured", ["candidate", "reason"], infeasible)

    if blocked:
        con.warn("this sweep could not distinguish its candidates:")
        for why in blocked:
            con.warn(f"  - {why}")
        con.note("the ranking above is printed for reference and is refused as "
                 "evidence; the design does not support it")

    if guard:
        say_guard(con, row, cands, guard)

    if row["verdict"] == "adopted" and row["winner_candidate"]:
        adoption_note(con, cands[row["winner_candidate"]], base)


def say_guard(con, row: dict, cands: dict, g: dict) -> None:
    """The one claim this command makes, with the effect size it could detect.

    Deliberately never the word "better". The design supports "faster, and no
    regression was detectable"; it does not support a claim about answer
    quality, and at the discordance this store has measured it would take 451
    items to support even a 5 pp one.
    """
    con.rule("correctness guard")
    n = g["n"]
    if not n:
        con.warn("no items were graded under both the winner and the "
                 "incumbent, so no correctness comparison was possible")
        return
    wr = rep.rate(g["winner_passed"], n)
    br = rep.rate(g["incumbent_passed"], n)
    con.say(f"  winner {wr} {rep.interval(g['winner_passed'], n)} against "
            f"incumbent {br} {rep.interval(g['incumbent_passed'], n)}")
    con.say(f"  McNemar exact p = {g['p']:.3f} on {g['discordant']} discordant "
            f"pairs (b={g['b']}, c={g['c']}) of {n}")
    if g["regressed"]:
        con.warn("  a correctness regression was detected; this candidate is "
                 "rejected regardless of its speed")
        return
    if g["mde"] is None:
        con.warn(f"  no effect is reachable at 80% power over {n} items at a "
                 f"discordance of {g['psi']:.1%}; 'no regression detectable' "
                 f"here means the comparison had no power, not that the "
                 f"configurations answer alike")
    else:
        con.say(f"  the smallest difference this comparison would find 80% of "
                f"the time is {g['mde']:.1%}")
    if g["needed"]:
        con.say(f"  detecting 5 pp would need {g['needed']} items")
    con.note("no correctness regression was detectable. That is not a claim "
             "that the winner answers better; this design cannot make one.")


def adoption_note(con, winner: dict, base: dict | None) -> None:
    """What to put in llama-env.sh, and the flag diff, for a human to commit.

    Adoption is not automated on purpose. llama-env.sh is this repo's source of
    truth for serving configuration, and a tool that rewrote it would be
    application code in a repo that deliberately holds none.
    """
    overrides = json.loads(winner["overrides"] or "{}")
    con.rule("adopting this")
    con.say("  " + " ".join(f"{k}={v}" for k, v in sorted(overrides.items()))
            + f"  llama-serve   # config {winner['config_id'] or '?'}")
    if any(k in overrides for k in ("LLAMA_CTX",)):
        con.warn("  this winner reduces the context window. A smaller -c is "
                 "strictly faster and strictly reduces what the server can "
                 "serve, so it is a capability trade and not a free speedup.")
    con.note("  edit scripts/llama-env.sh by hand and log the decision; "
             "nothing here writes that file.")


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------
def cmd_dry_run(sweep: Sweep) -> int:
    """Plan and print; launch nothing, write nothing.

    This is where the tier arithmetic and every grid constraint are checked,
    and it costs seconds rather than the hours a real sweep does. A search
    whose schedule is wrong fails slowly and expensively, so the fast way to
    find that out is a first-class command rather than a debugging flag.
    """
    con = sweep.con
    s = sweep.schedule
    con.rule(f"plan - {sweep.profile_name} / {sweep.o.tier}")
    con.note(f"grid {sweep.grid.path} ({sweep.grid.sha}), "
             f"{len(sweep.grid.knobs)} knobs, "
             f"{len(sweep.grid.constraints)} constraints")
    con.note(f"tier {sweep.suite['id']}: {len(sweep.items)} items, "
             f"order {sweep.order_sha}")
    con.table(["round", "items", "count", "candidates", "item-visits"], s.rows())

    item_s = sweep.o.assume_item_seconds
    load_s = sweep.o.assume_load_seconds
    reloads = sum(s.survivors)
    wall = s.item_visits * item_s + reloads * load_s
    con.note(f"{s.item_visits} item-visits and {reloads} reloads: about "
             f"{wall / 3600:.1f} h at {item_s:.0f} s/item and "
             f"{load_s:.0f} s/load, of which "
             f"{reloads * load_s / wall:.0%} is reload overhead")
    con.note(f"the survivor accumulates {s.winner_items} items, which is what "
             f"the correctness guard gets")

    cands, rejected = sample_candidates(sweep.grid, sweep.profile_json,
                                        sweep.budget.candidates, sweep.o.seed)
    con.table(["candidate", "config", "overrides"],
              [[c.label, c.predicted_config_id or "-", c.flags()] for c in cands])
    if rejected:
        con.table(["rejected", "why"],
                  [[c.sha[:8], why] for c, why in rejected])
    if len(cands) < sweep.budget.candidates:
        con.warn(f"only {len(cands)} of {sweep.budget.candidates} candidates "
                 f"are legal under this grid's constraints; the search will "
                 f"run narrower than the budget allows")
    return 0


def cmd_run(args) -> int:
    con = console()
    sweep = Sweep(args, con)
    if args.dry_run:
        return cmd_dry_run(sweep)
    return sweep.execute()


def cmd_resume(args) -> int:
    con = console()
    dbc = db.connect()
    sweep_id = args.sweep_id or db.latest_sweep(dbc)
    if not sweep_id:
        raise refuse("llama-tune: no sweep to resume")
    row = db.sweep(dbc, sweep_id)
    if not row:
        raise refuse(f"llama-tune: no sweep '{sweep_id}'")

    # Only the parameters that define the search space itself are persisted
    # on tune_sweep and restored below; everything operational (cooldown
    # timing, drift tolerance, load timeout, the assume-*-seconds estimates,
    # ...) has no column and a resumed sweep runs it at this invocation's
    # defaults instead -- the same stance budget_seconds already takes
    # (resuming does not hand back the time already spent). Without this,
    # `opts` was simply missing those attributes and the first thing to touch
    # one (e.g. Server reading `load_timeout`) raised AttributeError.
    defaults = vars(parse_args(["run"]))
    opts = Args(**{**defaults, **vars(args),
                   "profile": row["profile"], "tier": row["tier"],
                   "benchmark": row["benchmark"], "system": row["system_name"],
                   "grid": row["grid_path"], "budget": row["budget_mode"],
                   "max_visits": row["budget_visits"], "max_hours": None,
                   "eta": row["eta"], "round_items": row["round_items"],
                   "candidates": row["candidates"],
                   "stages": row["stages"].split(","), "alpha": row["alpha"],
                   "on_drift": row["on_drift"], "seed": row["seed"],
                   "sweep_id": sweep_id, "dry_run": False})
    sweep = Sweep(opts, con)
    # The grid is the search space, and a search space edited mid-sweep makes
    # the finished rounds measurements of a different experiment. Refuse and
    # name both, rather than resuming into a silent discontinuity.
    if sweep.grid.sha != row["grid_sha"]:
        raise refuse(
            f"llama-tune: {row['grid_path']} has changed since this sweep "
            f"started ({row['grid_sha']} then, {sweep.grid.sha} now). The "
            f"rounds already run measured the old space. Restore the file, or "
            f"start a new sweep.")
    if sweep.order_sha != row["item_order_sha"]:
        raise refuse(
            f"llama-tune: the tier no longer resolves to the same items "
            f"({row['item_order_sha']} then, {sweep.order_sha} now). A dataset "
            f"or a calibration changed underneath this sweep.")
    if row["budget_seconds"]:
        # Resuming does not hand back the time already spent; the mode's promise
        # is about wall clock, and a resumed multiday sweep is why the budget is
        # None for that mode rather than large.
        sweep.budget.seconds = row["budget_seconds"]

    sweep.started = time.time()
    for c in db.sweep_candidates(dbc, sweep_id):
        cand = Candidate(row["profile"], json.loads(c["overrides"] or "{}"),
                         stage=c["stage"], baseline=bool(c["is_baseline"]))
        cand.config_id = c["config_id"]
        cand.status = c["status"]
        sweep.candidates[cand.sha] = cand
        if cand.baseline:
            sweep.baseline = cand
    done = db.sweep_rounds(dbc, sweep_id)
    if done and done[0]["baseline_gen_tps"]:
        sweep.baseline_tps = done[0]["baseline_gen_tps"]

    con.note(f"resuming {sweep_id} after {len(done)} rounds")
    # Re-probe before serving. A kill -9 during a cooldown leaves an open pause
    # and no evidence about the card: the sweep was waiting on it precisely
    # because it could not be trusted, and nothing was watching in between.
    stale = [p for p in db.sweep_pauses(dbc, sweep_id)
             if p["resolution"] == "abandoned"]
    if stale:
        con.warn(f"{len(stale)} pause(s) were abandoned by a crash; re-probing "
                 f"before measuring anything")
        sweep.cool.run(trigger="drift", rnd=len(done) or 1, visit_id=None,
                       drift_ratio=None)

    alive = [c for c in sweep.candidates.values()
             if c.status in ("pending", "active", "marginal", "winner")]
    sweep.guard_port()
    # A round row whose own `ended_at` is still NULL means the budget ran out
    # mid-round last time -- run_round() withholds close_round() for exactly
    # that reason, leaving nobody eliminated. rnd/cursor are rewound to that
    # round's own start (its item_from, not item_to) so the loops below
    # re-enter and finish *that* round under its original slice bounds,
    # rather than reading its partial visits as a finished round and moving
    # the schedule on to a slice it never intended.
    unfinished = done[-1] if done and done[-1]["ended_at"] is None else None
    closed = done[:-1] if unfinished else done
    last = unfinished or (closed[-1] if closed else None)
    # A round row's own stage says where the sweep actually was, not the
    # cursor arithmetic below -- and it is what tells this resume whether to
    # continue explore (and possibly fall into refine after) or to re-enter
    # refine directly with the refine candidates already loaded above.
    last_stage = last["stage"] if last else "explore"
    cursor = (unfinished["item_from"] if unfinished
              else closed[-1]["item_to"] if closed else 0)
    rnd = len(closed)
    try:
        if last_stage == "explore":
            for i, (lo, hi) in enumerate(sweep.schedule.slices, 1):
                if i <= rnd:
                    continue
                if sweep.spent():
                    sweep.ended_reason = sweep.spent()
                    break
                rnd = i
                alive = sweep.run_round(rnd, "explore", alive, lo, hi)
                if sweep.ended_reason != "complete":
                    break
            else:
                cursor = (sweep.schedule.slices[-1][1]
                          if sweep.schedule.slices else cursor)
            if "refine" in sweep.o.stages and not sweep.stopped():
                rnd, alive, cursor = sweep.refine(rnd, alive, cursor)
        else:
            rnd, alive, cursor = sweep.run_refine_rounds(rnd, alive, cursor)
    except KeyboardInterrupt:
        sweep.ended_reason = "interrupted"
        sweep.con.warn(f"interrupted. resume with: "
                       f"llama-tune resume {sweep_id}")
    return sweep.finish(alive)


def cmd_status(args) -> int:
    con = console()
    dbc = db.connect()
    sweep_id = args.sweep_id or db.latest_sweep(dbc)
    if not sweep_id:
        raise refuse("llama-tune: no sweeps recorded")
    report_sweep(con, dbc, sweep_id, fmt=args.format)
    return 0


def cmd_list(args) -> int:
    con = console()
    dbc = db.connect()
    rows = db.sweeps(dbc)
    if not rows:
        con.note("no sweeps recorded")
        return 0
    con.table(["sweep", "started", "profile", "tier", "budget", "verdict",
               "winner"],
              [[r["sweep_id"], r["started_at"], r["profile"], r["tier"],
                r["budget_mode"], r["verdict"] or (r["ended_reason"] or "running"),
                (r["winner_candidate"] or "-")[:8]] for r in rows])
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="llama-tune",
        description="Search serving configurations: rank on throughput, "
                    "guard on correctness.")
    sub = p.add_subparsers(dest="command")

    def common(q):
        q.add_argument("--format", choices=("table", "markdown"),
                       default="table")
        q.add_argument("--db", metavar="PATH")

    run = sub.add_parser("run", help="start a sweep")
    run.add_argument("profile", nargs="?", default=None)
    run.add_argument("--tier", default="smoke",
                     help="suite to draw items from (default smoke)")
    run.add_argument("--benchmark", default=None)
    run.add_argument("--system", default=None)
    run.add_argument("--grid", default=None,
                     help="search space TOML (default tests/tuning/<profile>.toml)")
    run.add_argument("--budget", choices=tuple(MODES), default="interactive")
    run.add_argument("--max-visits", type=int, default=None)
    run.add_argument("--max-hours", type=float, default=None)
    run.add_argument("--stages", default="explore,refine")
    run.add_argument("--candidates", type=int, default=None)
    run.add_argument("--round-items", type=int, default=None)
    run.add_argument("--eta", type=int, default=2)
    run.add_argument("--alpha", type=float, default=0.05)
    run.add_argument("--drift-tolerance", type=float, default=0.15)
    run.add_argument("--cliff-ratio", type=float, default=0.5)
    run.add_argument("--on-drift", choices=("cooldown", "segment", "halt"),
                     default="cooldown")
    run.add_argument("--cooldown-poll", type=float, default=20.0)
    run.add_argument("--cooldown-hold", type=float, default=90.0)
    run.add_argument("--cooldown-temp", type=float, default=None,
                     help="target temperature (default: 8 C under the "
                          "throttling sample, floored at 55)")
    run.add_argument("--cooldown-max", type=float, default=900.0)
    run.add_argument("--cooldown-attempts", type=int, default=4)
    run.add_argument("--cooldown-probe", type=int, default=4)
    run.add_argument("--max-cooldown-share", type=float, default=0.35)
    run.add_argument("--reject-marginal", action="store_true")
    run.add_argument("--load-timeout", type=float, default=420.0)
    run.add_argument("--seed", type=int, default=0)
    run.add_argument("--dry-run", action="store_true",
                     help="print the schedule and the legal candidates; "
                          "launch nothing, write nothing")
    run.add_argument("--assume-item-seconds", type=float, default=42.0)
    run.add_argument("--assume-load-seconds", type=float, default=120.0)
    run.add_argument("--sweep-id", default=None)
    common(run)

    for name, help_text in (("resume", "continue the last (or named) sweep"),
                            ("status", "print one sweep's tables"),
                            ("report", "alias of status")):
        q = sub.add_parser(name, help=help_text)
        q.add_argument("sweep_id", nargs="?", default=None)
        common(q)
    common(sub.add_parser("list", help="every sweep, newest first"))

    # `llama-tune qwen36 --tier standard` with no subcommand is the shape
    # llama-test taught, so it is accepted rather than corrected.
    if argv and argv[0] not in {"run", "resume", "status", "report", "list",
                                "-h", "--help"}:
        argv = ["run"] + argv
    if not argv:
        argv = ["run"]
    args = p.parse_args(argv)
    if args.command == "run":
        args.stages = [s.strip() for s in args.stages.split(",") if s.strip()]
        if "explore" not in args.stages:
            raise refuse("llama-tune: --stages must include explore; "
                             "refine descends from the explore winner and has "
                             "nothing to start from without it")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(list(sys.argv[1:] if argv is None else argv))
    if getattr(args, "db", None):
        os.environ["LLAMA_DB"] = args.db
    return {"run": cmd_run, "resume": cmd_resume, "status": cmd_status,
            "report": cmd_status, "list": cmd_list}[args.command](args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
