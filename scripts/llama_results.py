#!/usr/bin/env python3
"""llama_results.py - the test result store, now a view onto logs/llama.db.

Part of https://github.com/epittman23/local-llm

One store for every model and every configuration. That was already true of
tests.jsonl and it is more true now: the serving telemetry that used to sit in a
per-model markdown file is in the same database, so the question this store
exists to answer -- does the configuration that ran faster also answer correctly
-- is a join rather than a glob over log files.

    result           one row per attempted item
    answer           the full response, keyed by result
    request          the llama.cpp timings for the same call, linked by request_id
    suite_exclusion  items no run could attempt, recorded once, not per run

What this module keeps from the jsonl version is its vocabulary -- PASS, GRADED,
pass_rate() returning its denominator -- and its durability promise. The
per-item fsync is now one committed transaction per item under
synchronous=FULL, which is the same guarantee arrived at the same way: an
interrupted `full` run is many hours of results, and that is exactly the run
whose partial results are most worth having.

Two rules moved from convention into the schema. `outcome` is a CHECK
constraint, so an unknown outcome is unwritable rather than merely discouraged.
`skipped` is excluded from every pass rate by v_pass_rate, so it no longer
depends on each caller remembering to route through graded().

Stdlib only, like llama_db.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import llama_db as db          # noqa: E402

logdir = db.logdir
db_path = db.db_path
connect = db.connect

PASS = "pass"
SKIPPED = "skipped"
# Kept in sync with llama_tests.py, but not imported from it: this module has to
# stay readable by a comparison run on a box with no tests/data/ at all.
FAILURES = {"fail_assert", "fail_error", "fail_timeout", "no_code"}
GRADED = FAILURES | {PASS}

OUTCOME_ORDER = [PASS, "fail_assert", "fail_error", "fail_timeout", "no_code",
                 SKIPPED]


# ---------------------------------------------------------------------------
# writing
# ---------------------------------------------------------------------------
def append(con, record: dict, answer: dict | None = None) -> int:
    """Record one graded item, its request timings and its answer, together.

    One transaction, committed per item. The same call used to write two rows to
    two independent stores -- the markdown serving log for how fast it
    answered, tests.jsonl
    for whether it was right -- with nothing connecting them; now the result
    carries the request's id.
    """
    return db.add_result(con, record, answer)


def exclusions(con, rows: list[dict]) -> int:
    """Items a suite cannot attempt: outside the adapter's library filter, or
    marked ungradeable by calibration.

    Recorded once against (benchmark, item_id, dataset_revision) rather than once
    per run. As per-run rows a 24-item smoke suite wrote 569 records, 545 of them
    exclusions, which made the store 23x the tier it described and made a count of
    a suite's rows meaningless. The exclusion set is a property of the adapter,
    the calibration and the libraries on this box -- not of any serving run -- and
    is keyed by dataset revision so a refetch that changes the items invalidates
    it.
    """
    return db.record_exclusions(con, rows)


# ---------------------------------------------------------------------------
# reading
# ---------------------------------------------------------------------------
def read_all(con, **kwargs) -> list[dict]:
    return db.results(con, **kwargs)


def excluded(con) -> list[dict]:
    return db.exclusions(con)


def excluded_counts(con) -> dict[str, int]:
    """Per benchmark, how many items are out of the pool. Reported beside a rate
    so a denominator smaller than the benchmark's published size is explained
    rather than left to be noticed."""
    out: dict[str, int] = {}
    for row in db.exclusions(con):
        out[row["benchmark"]] = out.get(row["benchmark"], 0) + 1
    return out


def answer_for(con, benchmark: str, item_id: str,
               suite_run_id: str | None = None) -> dict | None:
    return db.answer_for(con, benchmark, item_id, suite_run_id)


# ---------------------------------------------------------------------------
# resume
# ---------------------------------------------------------------------------
def completed(con, suite_run_id: str) -> set[tuple[str, str]]:
    """(benchmark, item_id) already recorded under this suite run.

    Keyed on the suite run id rather than on (model, config), because two runs of
    the same suite under the same configuration are a deliberate repeat and must
    not silently collapse into one. The unique index on
    (suite_run_id, benchmark, item_id) makes a resumed run idempotent even if
    this check is skipped.
    """
    return db.completed(con, suite_run_id)


def latest_run(con, model: str | None = None,
               suite: str | None = None) -> str | None:
    """The most recent suite run id, optionally restricted -- what --resume picks."""
    return db.latest_suite_run(con, model=model, tier=suite)


# ---------------------------------------------------------------------------
# summarising
# ---------------------------------------------------------------------------
def counts(records: list[dict]) -> dict[str, int]:
    out = {k: 0 for k in OUTCOME_ORDER}
    for r in records:
        out[r.get("outcome", "fail_error")] = \
            out.get(r.get("outcome", "fail_error"), 0) + 1
    return out


def graded(records: list[dict]) -> list[dict]:
    """Only the items that were actually attempted and judged.

    With exclusions held in their own table this is now nearly the identity
    function over result rows, and it is kept anyway: it is the one place that
    states the rule, and a skipped row written by some future path would still be
    caught here rather than silently entering a denominator.
    """
    return [r for r in records if r.get("outcome") in GRADED]


def pass_rate(records: list[dict]) -> tuple[int, int, float | None]:
    """(passed, attempted, rate) -- always returned together.

    Never a bare rate. At the smoke tier one item is about four points, and a
    percentage printed without its denominator invites a comparison the sample
    size does not support.
    """
    g = graded(records)
    passed = sum(1 for r in g if r.get("outcome") == PASS)
    return passed, len(g), (passed / len(g) if g else None)
