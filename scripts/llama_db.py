#!/usr/bin/env python3
"""llama_db.py - logs/llama.db: the one store this repo keeps.

Part of https://github.com/epittman23/local-llm

Everything measured here used to land in nine hand-rolled file formats under
logs/: markdown tables, jsonl, json markers, pipe-separated tmpfiles and
Prometheus text. The markdown ones were the problem, because they were *parsed
back* -- statistics were read out of rendered table cells on every merge, which
forced a rule that columns could only ever be appended, a positional remap for
rows written under an older layout, and a full re-render of every block on every
write. The retention rule followed from the same place: a multi-hour run at 5 s
intervals is thousands of markdown rows nobody can read, so the raw samples were
discarded and only the already-computed summary survived. A statistic computed
wrongly could never be recomputed.

This file replaces all of that. The rules it keeps:

  * Nothing rendered is ever read back. Markdown survives only as terminal
    output (`--format markdown`, for pasting a measured table into README.md);
    every number in it is derived from rows that are still here.
  * Raw rows are kept, summaries are derived. Every GPU sample, every /metrics
    scrape, every request. Deriving a mean is cheap; recovering a discarded
    sample is impossible.
  * Text that was fingerprinted stays authoritative. config.config_text is the
    exact string the config-id hashes; the typed columns beside it are parsed
    out of that text on insert, so a column cannot disagree with the hash.
  * A rule better expressed as a constraint is a constraint. `skipped` is out of
    every pass rate because v_pass_rate says so, not because every caller
    remembers to filter.

STDLIB ONLY, and deliberately so: the telemetry recorder runs under bare python3
for the life of every server and must not depend on <repo>/.venv. sqlite3 ships
with Python, so this costs nothing.

CONCURRENCY. Two writers overlap in normal use -- the recorder appending a
sample every LLAMA_VRAM_INTERVAL seconds, and llama-test committing a result per
item. WAL lets them proceed without blocking each other, and busy_timeout covers
the moments they collide on the write lock.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

BUSY_TIMEOUT_MS = 10_000


def logdir() -> Path:
    return Path(os.environ.get("LLAMA_VRAM_LOGDIR", REPO / "logs"))


def db_path() -> Path:
    return Path(os.environ.get("LLAMA_DB", logdir() / "llama.db"))


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ---------------------------------------------------------------------------
# schema
#
# Migrations are append-only and are never edited once applied -- the same rule
# CLAUDE.md's decisions log and the schema_note table below follow, and for the
# same reason: an edited history is not a history. PRAGMA user_version holds the
# count applied.
# ---------------------------------------------------------------------------
SCHEMA_1 = """
CREATE TABLE config (
    config_id        TEXT PRIMARY KEY,
    alias            TEXT NOT NULL,
    config_text      TEXT NOT NULL,
    arch             TEXT,
    ngl              INTEGER,
    ctx              INTEGER,
    parallel         INTEGER,
    threads          INTEGER,
    moe              INTEGER,
    override_tensors TEXT,
    speculative      TEXT,
    spec_draft_n_max INTEGER,
    cache_k          TEXT,
    cache_v          TEXT,
    flash_attn       TEXT,
    batch            INTEGER,
    ubatch           INTEGER,
    reasoning_effort TEXT,
    samplers         TEXT,
    first_seen       TEXT NOT NULL
) STRICT;

CREATE TABLE run (
    run_id        INTEGER PRIMARY KEY,
    config_id     TEXT NOT NULL REFERENCES config(config_id),
    model         TEXT NOT NULL,
    quant         TEXT NOT NULL,
    build         TEXT NOT NULL,
    port          INTEGER NOT NULL,
    pid           INTEGER,
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    ended_reason  TEXT
) STRICT;

CREATE INDEX run_config ON run(config_id, started_at);
CREATE INDEX run_active ON run(port) WHERE ended_at IS NULL;

CREATE TABLE gpu_sample (
    sample_id     INTEGER PRIMARY KEY,
    run_id        INTEGER NOT NULL REFERENCES run(run_id) ON DELETE CASCADE,
    at            TEXT NOT NULL,
    temp_c        INTEGER,
    util_pct      INTEGER,
    mem_used_mib  INTEGER,
    mem_total_mib INTEGER,
    power_w       REAL,
    sm_mhz        INTEGER,
    throttle      INTEGER
) STRICT;

CREATE INDEX gpu_sample_run ON gpu_sample(run_id, at);

CREATE TABLE metrics_scrape (
    run_id  INTEGER NOT NULL REFERENCES run(run_id) ON DELETE CASCADE,
    at      TEXT NOT NULL,
    counter TEXT NOT NULL,
    value   REAL NOT NULL,
    PRIMARY KEY (run_id, at, counter)
) STRICT;

CREATE TABLE run_load_info (
    run_id           INTEGER PRIMARY KEY REFERENCES run(run_id) ON DELETE CASCADE,
    n_layer          INTEGER,
    n_layer_all      INTEGER,
    layers_gpu       INTEGER,
    layers_total     INTEGER,
    layers_derived   INTEGER,
    n_slots          INTEGER,
    n_ctx_slot       INTEGER,
    kv_unified       TEXT,
    fused_gdn        TEXT,
    mtp_head         TEXT,
    buffers          TEXT,
    cpu_buffer_mib   REAL,
    gpu_buffer_mib   REAL,
    unused_tensors   INTEGER,
    unused_prefixes  TEXT,
    warnings         TEXT,
    deprecated       TEXT
) STRICT;

CREATE TABLE request (
    request_id          INTEGER PRIMARY KEY,
    run_id              INTEGER REFERENCES run(run_id) ON DELETE CASCADE,
    at                  TEXT NOT NULL,
    model               TEXT,
    label               TEXT,
    wall_ms             REAL,
    params              TEXT,
    cache_n             INTEGER,
    prompt_n            INTEGER,
    prompt_ms           REAL,
    prompt_per_token_ms REAL,
    prompt_per_second   REAL,
    predicted_n         INTEGER,
    predicted_ms        REAL,
    predicted_per_token_ms REAL,
    predicted_per_second   REAL,
    draft_n             INTEGER,
    draft_n_accepted    INTEGER,
    timings             TEXT
) STRICT;

CREATE INDEX request_run ON request(run_id, at);

CREATE TABLE result (
    result_id        INTEGER PRIMARY KEY,
    suite_run_id     TEXT NOT NULL,
    run_id           INTEGER REFERENCES run(run_id) ON DELETE SET NULL,
    request_id       INTEGER REFERENCES request(request_id) ON DELETE SET NULL,
    -- Denormalised on purpose: a result keeps its configuration identity even
    -- if its run row is pruned. NULL means the server was started by hand and
    -- no configuration was recorded, which is why the sentinel is NULL rather
    -- than a string -- a string would have to be exempt from this constraint,
    -- and then the constraint would guarantee nothing.
    config_id        TEXT REFERENCES config(config_id),
    at               TEXT NOT NULL,
    model            TEXT NOT NULL,
    profile          TEXT,
    benchmark        TEXT NOT NULL,
    item_id          TEXT NOT NULL,
    dataset_revision TEXT NOT NULL,
    tier             TEXT NOT NULL,
    seed             INTEGER NOT NULL,
    outcome          TEXT NOT NULL CHECK (outcome IN
                       ('pass','fail_assert','fail_error','fail_timeout',
                        'no_code','skipped')),
    reason           TEXT NOT NULL DEFAULT '',
    reasoning_chars  INTEGER,
    wall_ms          REAL,
    params           TEXT,
    timings          TEXT
) STRICT;

CREATE UNIQUE INDEX result_item ON result(suite_run_id, benchmark, item_id);
CREATE INDEX result_group ON result(model, config_id, tier, benchmark);

CREATE TABLE answer (
    result_id INTEGER PRIMARY KEY REFERENCES result(result_id) ON DELETE CASCADE,
    prompt    TEXT NOT NULL,
    content   TEXT NOT NULL,
    reasoning TEXT NOT NULL
) STRICT;

CREATE TABLE suite_exclusion (
    benchmark        TEXT NOT NULL,
    item_id          TEXT NOT NULL,
    dataset_revision TEXT NOT NULL,
    kind             TEXT NOT NULL,
    reason           TEXT NOT NULL,
    recorded_at      TEXT NOT NULL,
    PRIMARY KEY (benchmark, item_id, dataset_revision)
) STRICT;

CREATE TABLE schema_note (
    note_id  INTEGER PRIMARY KEY,
    noted_on TEXT NOT NULL,
    note     TEXT NOT NULL UNIQUE
) STRICT;

CREATE VIEW v_request AS
SELECT r.*,
       (r.cache_n IS NULL OR r.cache_n = 0) AS is_cold,
       CASE WHEN r.draft_n > 0
            THEN CAST(r.draft_n_accepted AS REAL) / r.draft_n END AS acceptance,
       CASE WHEN r.draft_n > 0 AND c.spec_draft_n_max > 0
            THEN 1 + CAST(r.draft_n_accepted AS REAL)
                     / (CAST(r.draft_n AS REAL) / c.spec_draft_n_max) END AS mean_len,
       run.config_id AS config_id
FROM request r
LEFT JOIN run ON run.run_id = r.run_id
LEFT JOIN config c ON c.config_id = run.config_id;

CREATE VIEW v_pass_rate AS
SELECT model, config_id, tier, benchmark,
       SUM(outcome = 'pass') AS passed,
       COUNT(*)              AS attempted,
       CAST(SUM(outcome = 'pass') AS REAL) / COUNT(*) AS pass_rate
FROM result
WHERE outcome <> 'skipped'
GROUP BY model, config_id, tier, benchmark;

CREATE VIEW v_run_gpu AS
SELECT run_id,
       COUNT(*)                       AS samples,
       AVG(temp_c)                    AS temp_avg,
       MAX(temp_c)                    AS temp_max,
       AVG(util_pct)                  AS util_avg,
       MAX(util_pct)                  AS util_max,
       AVG(mem_used_mib)              AS mem_avg,
       MAX(mem_used_mib)              AS mem_max,
       AVG(power_w)                   AS power_avg,
       MAX(power_w)                   AS power_max,
       AVG(sm_mhz)                    AS sm_avg,
       MIN(mem_total_mib - mem_used_mib) AS vram_headroom_mib
FROM gpu_sample
GROUP BY run_id;

CREATE VIEW v_run_metrics AS
SELECT run_id, counter,
       MAX(value) - MIN(value) AS delta,
       COUNT(*)                AS scrapes
FROM metrics_scrape
GROUP BY run_id, counter;

CREATE VIEW v_config_latest AS
SELECT c.config_id, c.alias, c.config_text, r.run_id, r.model, r.quant,
       r.build, r.started_at, r.ended_at
FROM config c
JOIN run r ON r.run_id = (
    SELECT run_id FROM run WHERE run.config_id = c.config_id
    ORDER BY started_at DESC, run_id DESC LIMIT 1);
"""

# Why a note exists at all: a config-id is a hash of the configuration lines, so
# changing what those lines contain changes every id, and rows either side of
# such a change are not the same configuration even when they look alike.
NOTES_1 = [
    ("2026-08-30",
     "This database starts empty. The markdown serving logs and tests.jsonl "
     "that preceded it were deliberately not imported, so nothing here "
     "predates 2026-08-30. Those files remain in logs/ as a historical "
     "reference and are read by no code. Config-ids are unchanged: the "
     "fingerprint is still computed by _vramlog_config in "
     "scripts/llama-vram-log.sh over the same six lines, so an id quoted in "
     "an older log names the same serving configuration it always did."),
    ("2026-08-30",
     "Every GPU sample and /metrics scrape is retained. The previous store "
     "kept only the most recent run's samples and collapsed older runs to a "
     "summary row computed when they finished, which meant a statistic "
     "computed wrongly could never be recomputed. Summaries here are derived "
     "on read from rows that are still present."),
]

# ---------------------------------------------------------------------------
# 2: the system prompt a result was measured under
#
# A system prompt changes what the model is asked, so two runs that differ by
# one are different measurements -- exactly the thing this store exists to keep
# apart. It is deliberately NOT part of config_id: that fingerprint covers the
# serving flags, computed by _vramlog_config before any request is made, and a
# system prompt is a property of the request. So it is recorded on the result
# and joins the grouping key beside config_id, in v_pass_rate here and in
# llama_compare.group_records.
#
# Two columns rather than one: the sha is the identity that makes rows
# comparable (a file edited under the same name is a different prompt), and the
# name is what a person reads in a table and passes back to --system.
SCHEMA_2 = """
ALTER TABLE result ADD COLUMN system_name TEXT;
ALTER TABLE result ADD COLUMN system_sha TEXT;

DROP VIEW v_pass_rate;

CREATE VIEW v_pass_rate AS
SELECT model, config_id, tier, benchmark, system_sha,
       SUM(outcome = 'pass') AS passed,
       COUNT(*)              AS attempted,
       CAST(SUM(outcome = 'pass') AS REAL) / COUNT(*) AS pass_rate
FROM result
WHERE outcome <> 'skipped'
GROUP BY model, config_id, tier, benchmark, system_sha;
"""

NOTES_2 = [
    ("2026-09-04",
     "result.system_name and result.system_sha record the system prompt a "
     "result was measured under. NULL means no system prompt was sent, not "
     "that it is unknown: llama-test had no way to send one before this "
     "migration, so every row that predates it is a genuine no-system-prompt "
     "measurement and stays comparable to a new run made without --system. "
     "config_id is unchanged and does not cover the system prompt -- that "
     "fingerprint is over the serving flags, and a system prompt is part of "
     "the request -- so system_sha is a second grouping key beside it, in "
     "v_pass_rate and in llama-test compare."),
]

# ---------------------------------------------------------------------------
# 3: the adapter a result was measured under
#
# dataset_revision pins the published items, and nothing pinned the wrapper this
# repo puts around them. So the adapter's prompt_template -- the text that turns
# a completion-style stub into a chat turn, and the only part of the request the
# benchmark itself does not author -- could be edited and every old result would
# silently keep sitting in the same group as every new one. That is the failure
# config_id and system_sha exist to prevent, applied to the third input.
#
# It joins the grouping key for the same reason system_sha did: without it, runs
# made under two different prompts average into one pass rate, and the number
# looks fine while answering a question nobody asked.
SCHEMA_3 = """
ALTER TABLE result ADD COLUMN adapter_sha TEXT;

DROP VIEW v_pass_rate;

CREATE VIEW v_pass_rate AS
SELECT model, config_id, tier, benchmark, system_sha, adapter_sha,
       SUM(outcome = 'pass') AS passed,
       COUNT(*)              AS attempted,
       CAST(SUM(outcome = 'pass') AS REAL) / COUNT(*) AS pass_rate
FROM result
WHERE outcome <> 'skipped'
GROUP BY model, config_id, tier, benchmark, system_sha, adapter_sha;
"""

NOTES_3 = [
    ("2026-09-04",
     "result.adapter_sha fingerprints the benchmark adapter a result was "
     "measured under: sha1 of the prompt_template, [item], [filter] and "
     "[check] of tests/adapters/<bench>.toml, first 12 hex, computed by "
     "llama_tests.adapter_sha. Unlike system_sha's NULL, a NULL here means "
     "UNKNOWN, not none: rows predating this migration were recorded before "
     "anything fingerprinted the adapter, and the adapter they ran under is "
     "not recoverable from the row."),
    ("2026-09-04",
     "The ds1000 adapter's prompt_template was corrected in the same change, "
     "so ds1000 rows with a NULL adapter_sha were measured under a prompt "
     "that told every item to 'Assign the answer to `result`'. That was false "
     "for 194 of the 511 in-filter items -- DS-1000 items name their own "
     "output variable -- and a model that obeyed it was graded NameError on a "
     "correct answer. Those rows understate ds1000 by an unknown amount and "
     "are not comparable to rows carrying an adapter_sha. Grader calibration "
     "could not have caught it: calibration runs the reference solutions, "
     "which use the variable each problem actually names."),
]

MIGRATIONS: list[tuple[int, str, list[tuple[str, str]]]] = [
    (1, SCHEMA_1, NOTES_1),
    (2, SCHEMA_2, NOTES_2),
    (3, SCHEMA_3, NOTES_3),
]


def _statements(script: str) -> list[str]:
    """Split a schema script into statements.

    Naive on purpose -- these scripts contain no semicolon inside a string
    literal, and keeping them as separate statements is what lets a migration
    run inside one explicit transaction. executescript() would commit first.
    """
    return [s.strip() for s in script.split(";") if s.strip()]


def migrate(con: sqlite3.Connection) -> int:
    """Apply every migration past the recorded version. Returns how many ran."""
    applied = 0
    for version, script, notes in MIGRATIONS:
        con.execute("BEGIN IMMEDIATE")
        try:
            # Re-read inside the transaction: another process may have applied
            # this migration while we waited for the write lock.
            current = con.execute("PRAGMA user_version").fetchone()[0]
            if current >= version:
                con.execute("ROLLBACK")
                continue
            for statement in _statements(script):
                con.execute(statement)
            for noted_on, text in notes:
                con.execute("INSERT OR IGNORE INTO schema_note (noted_on, note) "
                            "VALUES (?, ?)", (noted_on, text))
            con.execute(f"PRAGMA user_version = {version}")
            con.execute("COMMIT")
            applied += 1
        except Exception:
            con.execute("ROLLBACK")
            raise
    return applied


# ---------------------------------------------------------------------------
# connections
# ---------------------------------------------------------------------------
def connect(path: Path | None = None, *, sweep: bool = True) -> sqlite3.Connection:
    """Open logs/llama.db, applying any pending migrations.

    isolation_level=None puts the connection in autocommit mode, so every
    statement lands immediately unless an explicit BEGIN is open. That is what
    makes a sample durable the moment it is taken -- the previous recorder
    accumulated samples in a tmpfile and folded them in from an EXIT trap, so a
    kill -9 lost the whole run.
    """
    path = Path(path) if path else db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path), timeout=BUSY_TIMEOUT_MS / 1000,
                          isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
    try:
        con.execute("PRAGMA journal_mode = WAL")
    except sqlite3.DatabaseError:                      # pragma: no cover
        pass                                           # a filesystem without WAL
    # FULL rather than NORMAL: llama_results promises that an interrupted suite
    # leaves a valid partial record set, and that promise is the reason a `full`
    # run of many hours is worth starting at all.
    con.execute("PRAGMA synchronous = FULL")
    con.execute("PRAGMA foreign_keys = ON")
    migrate(con)
    if sweep:
        sweep_stale_runs(con)
    return con


def sweep_stale_runs(con: sqlite3.Connection) -> int:
    """Close runs whose recorder is gone.

    An open run (ended_at IS NULL) is the active-run marker llama-test attaches
    its requests to. The previous marker was a file removed by an EXIT trap,
    which a kill -9 skips, so a crashed recorder left a stale marker that later
    results were filed under. Here the run carries the recorder's pid, so a dead
    recorder is detectable rather than merely likely.

    The close time is the run's last observation, not the moment of the sweep:
    nothing was measured between the recorder dying and someone noticing.
    """
    closed = 0
    for row in con.execute("SELECT run_id, pid, started_at FROM run "
                           "WHERE ended_at IS NULL").fetchall():
        pid = row["pid"]
        if pid and _alive(pid):
            continue
        last = con.execute("SELECT MAX(at) FROM gpu_sample WHERE run_id = ?",
                           (row["run_id"],)).fetchone()[0]
        con.execute("UPDATE run SET ended_at = ?, ended_reason = 'stale' "
                    "WHERE run_id = ?", (last or row["started_at"], row["run_id"]))
        closed += 1
    return closed


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:                            # someone else's process
        return True
    except OSError:                                    # pragma: no cover
        return True
    return True


# ---------------------------------------------------------------------------
# serving: configurations and runs
# ---------------------------------------------------------------------------
def upsert_config(con: sqlite3.Connection, config_id: str, alias: str,
                  config_lines: "list[str] | str") -> None:
    """Record a serving configuration, keyed by its fingerprint.

    config_text is stored verbatim because it is what the fingerprint covers.
    The typed columns are parsed out of that same text rather than passed in
    separately, so no column can disagree with the hash that identifies the row.

    A single newline-joined string is accepted as well as the list of lines the
    recorder passes. Without that a caller handing over the joined text got a
    row whose every parsed column was NULL rather than an error, because
    iterating a str yields characters.
    """
    import llama_stats as stats

    if isinstance(config_lines, str):
        config_lines = config_lines.split("\n")
    text = "\n".join(line.strip() for line in config_lines)
    fields = stats.parse_config_text(text)
    con.execute(
        "INSERT INTO config (config_id, alias, config_text, arch, ngl, ctx, "
        " parallel, threads, moe, override_tensors, speculative, "
        " spec_draft_n_max, cache_k, cache_v, flash_attn, batch, ubatch, "
        " reasoning_effort, samplers, first_seen) "
        "VALUES (:config_id, :alias, :config_text, :arch, :ngl, :ctx, "
        " :parallel, :threads, :moe, :override_tensors, :speculative, "
        " :spec_draft_n_max, :cache_k, :cache_v, :flash_attn, :batch, :ubatch, "
        " :reasoning_effort, :samplers, :first_seen) "
        "ON CONFLICT(config_id) DO NOTHING",
        {"config_id": config_id, "alias": alias, "config_text": text,
         "first_seen": now(), **fields})


def open_run(con: sqlite3.Connection, config_id: str, *, model: str, quant: str,
             build: str, port: int, pid: int) -> int:
    con.execute("BEGIN IMMEDIATE")
    try:
        cur = con.execute(
            "INSERT INTO run (config_id, model, quant, build, port, pid, "
            " started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (config_id, model, quant, build, int(port), int(pid), now()))
        run_id = cur.lastrowid
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return int(run_id)


def close_run(con: sqlite3.Connection, run_id: int, reason: str = "clean") -> None:
    con.execute("UPDATE run SET ended_at = ?, ended_reason = ? "
                "WHERE run_id = ? AND ended_at IS NULL",
                (now(), reason, run_id))


def active_run(con: sqlite3.Connection, port: int) -> dict | None:
    """The run the recorder is currently writing on this port, if any.

    Replaces logs/.active-run.json. A hand-started server has no open run, and
    that is recorded as "unrecorded" rather than guessed at -- the same choice
    the file-based marker made.
    """
    row = con.execute(
        "SELECT r.run_id, r.config_id, r.model, r.quant, r.build, r.started_at "
        "FROM run r WHERE r.ended_at IS NULL AND r.port = ? "
        "ORDER BY r.started_at DESC, r.run_id DESC LIMIT 1", (int(port),)
    ).fetchone()
    return dict(row) if row else None


def add_sample(con: sqlite3.Connection, run_id: int, sample: dict) -> None:
    con.execute(
        "INSERT INTO gpu_sample (run_id, at, temp_c, util_pct, mem_used_mib, "
        " mem_total_mib, power_w, sm_mhz, throttle) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (run_id, sample["at"], sample.get("temp_c"), sample.get("util_pct"),
         sample.get("mem_used_mib"), sample.get("mem_total_mib"),
         sample.get("power_w"), sample.get("sm_mhz"), sample.get("throttle")))


def add_metrics(con: sqlite3.Connection, run_id: int, at: str,
                values: dict) -> None:
    """One /metrics scrape, stored whole rather than as a start/end pair.

    The previous store kept only the first and last scrape and reported one
    delta, which had a documented defect: llama.cpp updates its prompt counters
    when a prompt is processed but its generation counters when the task
    completes, so a scrape taken as the server stops holds the prompt half and
    not the generation half. Keeping the series means the delta can be taken to
    the last scrape after the final completion instead.
    """
    con.executemany(
        "INSERT OR REPLACE INTO metrics_scrape (run_id, at, counter, value) "
        "VALUES (?, ?, ?, ?)",
        [(run_id, at, name, float(value)) for name, value in values.items()])


def set_load_info(con: sqlite3.Connection, run_id: int, info: dict) -> None:
    """What the server said about the model it loaded, per run.

    Never fingerprinted: llama.cpp resolves the fused Gated Delta Net kernels
    per context at load time by checking the fused node landed on the same
    device as its layer, so two runs with an identical fingerprint can execute
    different operations. Observed, therefore recorded against the run.
    """
    keys = ["n_layer", "n_layer_all", "layers_gpu", "layers_total",
            "layers_derived", "n_slots", "n_ctx_slot", "kv_unified",
            "fused_gdn", "mtp_head", "buffers", "cpu_buffer_mib",
            "gpu_buffer_mib", "unused_tensors", "unused_prefixes",
            "warnings", "deprecated"]
    values = {k: info.get(k) for k in keys}
    for name in ("buffers", "warnings", "deprecated", "unused_prefixes"):
        if isinstance(values[name], (list, dict)):
            values[name] = json.dumps(values[name])
    columns = ", ".join(keys)
    holders = ", ".join(f":{k}" for k in keys)
    con.execute(f"INSERT OR REPLACE INTO run_load_info (run_id, {columns}) "
                f"VALUES (:run_id, {holders})", {"run_id": run_id, **values})


# ---------------------------------------------------------------------------
# requests and results
# ---------------------------------------------------------------------------
TIMING_COLUMNS = ["cache_n", "prompt_n", "prompt_ms", "prompt_per_token_ms",
                  "prompt_per_second", "predicted_n", "predicted_ms",
                  "predicted_per_token_ms", "predicted_per_second",
                  "draft_n", "draft_n_accepted"]


def add_request(con: sqlite3.Connection, run_id: int | None, *, at: str,
                model: str, label: str, wall_ms: float | None,
                params: dict, timings: dict) -> int:
    """One request's llama.cpp timings.

    The raw field names are kept as columns so a row traces back to the
    response it came from without a translation table, and the whole timings
    object is kept alongside them: the columns are what gets queried, the JSON
    is the guarantee that a field a later llama.cpp build adds is not silently
    dropped before anyone notices it exists.
    """
    values = {k: timings.get(k) for k in TIMING_COLUMNS}
    columns = ", ".join(TIMING_COLUMNS)
    holders = ", ".join(f":{k}" for k in TIMING_COLUMNS)
    cur = con.execute(
        f"INSERT INTO request (run_id, at, model, label, wall_ms, params, "
        f" {columns}, timings) "
        f"VALUES (:run_id, :at, :model, :label, :wall_ms, :params, "
        f" {holders}, :timings)",
        {"run_id": run_id, "at": at, "model": model, "label": label,
         "wall_ms": wall_ms, "params": json.dumps(params, sort_keys=True),
         "timings": json.dumps(timings, sort_keys=True), **values})
    return int(cur.lastrowid)


def add_result(con: sqlite3.Connection, record: dict,
               answer: dict | None = None) -> int:
    """One graded item, and its request and answer, in one transaction.

    The same call used to be written to two independent stores -- the serving
    log for how fast it answered, tests.jsonl for whether it was right -- with
    nothing linking the two rows. Here they are one commit and one foreign key.

    Committed per item, not per suite. A `full` run is many hours on this
    hardware and will be interrupted; holding results in memory would mean the
    run whose partial results are most worth having produced none.
    """
    con.execute("BEGIN IMMEDIATE")
    try:
        request_id = None
        if record.get("timings"):
            request_id = add_request(
                con, record.get("run_id"), at=record["at"],
                model=record["model"],
                label=f"{record['benchmark']}/{record['item_id']}",
                wall_ms=record.get("wall_ms"), params=record.get("params") or {},
                timings=record["timings"])

        cur = con.execute(
            "INSERT INTO result (suite_run_id, run_id, request_id, config_id, "
            " at, model, profile, benchmark, item_id, dataset_revision, tier, "
            " seed, outcome, reason, reasoning_chars, wall_ms, params, timings, "
            " system_name, system_sha, adapter_sha) "
            "VALUES (:suite_run_id, :run_id, :request_id, :config_id, :at, "
            " :model, :profile, :benchmark, :item_id, :dataset_revision, :tier, "
            " :seed, :outcome, :reason, :reasoning_chars, :wall_ms, :params, "
            " :timings, :system_name, :system_sha, :adapter_sha) "
            "ON CONFLICT(suite_run_id, benchmark, item_id) DO UPDATE SET "
            " request_id = excluded.request_id, at = excluded.at, "
            " outcome = excluded.outcome, reason = excluded.reason, "
            " reasoning_chars = excluded.reasoning_chars, "
            " wall_ms = excluded.wall_ms, params = excluded.params, "
            " timings = excluded.timings, "
            # Re-running an item under a different --system must not leave the
            # row claiming the prompt the first attempt used.
            " system_name = excluded.system_name, "
            " system_sha = excluded.system_sha, "
            " adapter_sha = excluded.adapter_sha "
            "RETURNING result_id",
            {"suite_run_id": record["suite_run_id"],
             "run_id": record.get("run_id"), "request_id": request_id,
             "config_id": record.get("config_id"), "at": record["at"],
             "model": record["model"], "profile": record.get("profile", ""),
             "benchmark": record["benchmark"], "item_id": record["item_id"],
             "dataset_revision": record.get("dataset_revision", ""),
             "tier": record["tier"], "seed": int(record.get("seed") or 0),
             "outcome": record["outcome"], "reason": record.get("reason", ""),
             "reasoning_chars": record.get("reasoning_chars"),
             "wall_ms": record.get("wall_ms"),
             "params": json.dumps(record.get("params") or {}, sort_keys=True),
             "timings": json.dumps(record.get("timings") or {}, sort_keys=True),
             # NULL, not "", for no system prompt: the note on migration 2 says
             # NULL means none was sent, and "" would be a third state meaning
             # the same thing while grouping separately.
             "system_name": record.get("system_name") or None,
             "system_sha": record.get("system_sha") or None,
             # NULL means the adapter was not fingerprinted, which is a real
             # unknown rather than a default -- see the note on migration 3.
             "adapter_sha": record.get("adapter_sha") or None})
        result_id = int(cur.fetchone()[0])

        if answer is not None:
            con.execute(
                "INSERT OR REPLACE INTO answer (result_id, prompt, content, "
                " reasoning) VALUES (?, ?, ?, ?)",
                (result_id, answer.get("prompt", ""), answer.get("content", ""),
                 answer.get("reasoning", "")))
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return result_id


def record_exclusions(con: sqlite3.Connection, rows: list[dict]) -> int:
    """Items a suite could not attempt, recorded once rather than once per run.

    These are a property of the adapter's filter, the calibration and the
    libraries installed here -- not of any serving run. Recording them per run
    made a 24-item smoke suite write 569 rows, 545 of them exclusions, and made
    a count of a suite's rows mean nothing. Keyed by dataset revision so a
    refetch that changes the items invalidates them.
    """
    stamp = now()
    con.executemany(
        "INSERT INTO suite_exclusion (benchmark, item_id, dataset_revision, "
        " kind, reason, recorded_at) VALUES (?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(benchmark, item_id, dataset_revision) DO UPDATE SET "
        " kind = excluded.kind, reason = excluded.reason, "
        " recorded_at = excluded.recorded_at",
        [(r["benchmark"], str(r["item_id"]), r.get("dataset_revision", ""),
          r.get("kind", "excluded"), r.get("reason", "")[:400], stamp)
         for r in rows])
    return len(rows)


# ---------------------------------------------------------------------------
# reading
# ---------------------------------------------------------------------------
def _loads(value, default):
    if not value:
        return default
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return default


def results(con: sqlite3.Connection, *, tier: str | None = None,
            model: str | None = None) -> list[dict]:
    """Every result, shaped like the records the comparison already understands."""
    sql = "SELECT * FROM result"
    where, args = [], []
    if tier:
        where.append("tier = ?")
        args.append(tier)
    if model:
        where.append("model = ?")
        args.append(model)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY at, result_id"
    out = []
    for row in con.execute(sql, args).fetchall():
        record = dict(row)
        record["params"] = _loads(record.get("params"), {})
        record["timings"] = _loads(record.get("timings"), {})
        out.append(record)
    return out


def exclusions(con: sqlite3.Connection) -> list[dict]:
    return [dict(r) for r in con.execute(
        "SELECT * FROM suite_exclusion ORDER BY benchmark, item_id").fetchall()]


def configs(con: sqlite3.Connection) -> dict[str, list[str]]:
    """config-id -> its configuration lines.

    Replaces globbing logs/*.log and parsing every markdown block in every file
    to rebuild the same mapping. This is the join the whole move was for.
    """
    return {row["config_id"]: row["config_text"].split("\n")
            for row in con.execute(
                "SELECT config_id, config_text FROM config").fetchall()}


def completed(con: sqlite3.Connection, suite_run_id: str) -> set[tuple[str, str]]:
    return {(r["benchmark"], r["item_id"]) for r in con.execute(
        "SELECT benchmark, item_id FROM result WHERE suite_run_id = ?",
        (suite_run_id,)).fetchall()}


def latest_suite_run(con: sqlite3.Connection, model: str | None = None,
                     tier: str | None = None) -> str | None:
    sql = "SELECT suite_run_id FROM result"
    where, args = [], []
    if model:
        where.append("model = ?")
        args.append(model)
    if tier:
        where.append("tier = ?")
        args.append(tier)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY at DESC, result_id DESC LIMIT 1"
    row = con.execute(sql, args).fetchone()
    return row["suite_run_id"] if row else None


def suite_runs(con: sqlite3.Connection, limit: int = 20) -> list[dict]:
    """Recent suite runs, newest first, with what each of them scored.

    `skipped` is left out of the denominator here for the same reason
    v_pass_rate leaves it out: an item nobody attempted is not an item anybody
    failed. Exists so a reader can pick a run without knowing its coined id,
    which is a timestamp and six hex characters.
    """
    return [dict(r) for r in con.execute("""
        SELECT suite_run_id,
               MIN(at) AS started_at, MAX(at) AS ended_at,
               model, tier,
               COUNT(*) FILTER (WHERE outcome <> 'skipped') AS attempted,
               COUNT(*) FILTER (WHERE outcome = 'pass')     AS passed
        FROM result
        GROUP BY suite_run_id
        ORDER BY started_at DESC
        LIMIT ?""", (limit,)).fetchall()]


def answer_for(con: sqlite3.Connection, benchmark: str, item_id: str,
               suite_run_id: str | None = None) -> dict | None:
    sql = ("SELECT r.*, a.prompt, a.content, a.reasoning "
           "FROM result r JOIN answer a ON a.result_id = r.result_id "
           "WHERE r.benchmark = ? AND r.item_id = ?")
    args: list = [benchmark, item_id]
    if suite_run_id:
        sql += " AND r.suite_run_id = ?"
        args.append(suite_run_id)
    sql += " ORDER BY r.at DESC, r.result_id DESC LIMIT 1"
    row = con.execute(sql, args).fetchone()
    if not row:
        return None
    # Decoded the same way results() decodes them, so every reader of a result
    # row gets the same shape. Handing one caller a dict and another the raw
    # JSON string is how a renderer ends up calling .get() on a str.
    record = dict(row)
    record["params"] = _loads(record.get("params"), {})
    record["timings"] = _loads(record.get("timings"), {})
    return record


def notes(con: sqlite3.Connection) -> list[dict]:
    return [dict(r) for r in con.execute(
        "SELECT noted_on, note FROM schema_note ORDER BY note_id").fetchall()]


def samples(con: sqlite3.Connection, run_id: int) -> list[dict]:
    return [dict(r) for r in con.execute(
        "SELECT * FROM gpu_sample WHERE run_id = ? ORDER BY at, sample_id",
        (run_id,)).fetchall()]


def metrics_delta(con: sqlite3.Connection, run_id: int) -> dict[str, float]:
    """Counters accumulated over the run: the last scrape minus the first.

    Only the counters actually seen are returned. A counter that went backwards
    means the server restarted under the recorder, and the whole delta is
    unknowable rather than negative, so it is dropped.
    """
    out: dict[str, float] = {}
    for row in con.execute(
            "SELECT counter, MIN(at) AS first_at, MAX(at) AS last_at "
            "FROM metrics_scrape WHERE run_id = ? GROUP BY counter",
            (run_id,)).fetchall():
        first = con.execute("SELECT value FROM metrics_scrape WHERE run_id = ? "
                            "AND counter = ? AND at = ?",
                            (run_id, row["counter"], row["first_at"])).fetchone()
        last = con.execute("SELECT value FROM metrics_scrape WHERE run_id = ? "
                           "AND counter = ? AND at = ?",
                           (run_id, row["counter"], row["last_at"])).fetchone()
        if first is None or last is None:
            continue
        delta = last[0] - first[0]
        if delta >= 0:
            out[row["counter"]] = delta
    return out


def runs(con: sqlite3.Connection, *, limit: int = 20,
         active_only: bool = False) -> list[dict]:
    """The most recent serving runs, newest first.

    Ordered by run_id rather than started_at: the id is monotonic within this
    database and the timestamp is a string that two runs starting in the same
    second would tie on.
    """
    sql = ("SELECT r.*, c.alias, c.ngl, c.parallel, c.speculative "
           "FROM run r LEFT JOIN config c ON c.config_id = r.config_id")
    if active_only:
        sql += " WHERE r.ended_at IS NULL"
    sql += " ORDER BY r.run_id DESC LIMIT ?"
    return [dict(row) for row in con.execute(sql, (int(limit),)).fetchall()]


def request_count(con: sqlite3.Connection, run_id: int) -> int:
    row = con.execute("SELECT count(*) FROM request WHERE run_id = ?",
                      (run_id,)).fetchone()
    return int(row[0]) if row else 0


def serving_summary(con: sqlite3.Connection) -> list[dict]:
    """One row per configuration: its most recent run, and what that run measured.

    This is the `## comparison` section the markdown log used to rebuild on
    every write, as a query instead. Each row is the configuration's *latest*
    run rather than an average over its history, for the reason recorded on
    2026-08-23: an older run may predate a llama.cpp rebuild or have shared the
    machine with something else, and averaging would hide the change being
    looked for.

    Cold and warm prefills are aggregated separately. A request whose prompt was
    partly in a slot processed only the remainder, so its prompt_per_second
    measures a handful of tokens against fixed overhead; blending the two
    produces a prefill figure that belongs to no configuration.

    `source` says where the throughput came from: "requests" for the exact
    per-request timings llama-test recorded, "metrics" for the server's own
    counters, which cover every client and whatever prompts they sent. The
    fallback is worth having and is not the same measurement, so it is labelled
    rather than silently mixed in.
    """
    out: list[dict] = []
    for row in con.execute(
            "SELECT * FROM v_config_latest ORDER BY started_at DESC").fetchall():
        facts = dict(row)
        run_id = facts["run_id"]

        agg = con.execute("""
            SELECT COUNT(*) AS requests,
                   SUM(cache_n IS NULL OR cache_n = 0)       AS cold_reqs,
                   SUM(cache_n > 0)                          AS warm_reqs,
                   SUM(CASE WHEN cache_n IS NULL OR cache_n = 0
                            THEN prompt_n END)               AS cold_prompt_n,
                   SUM(CASE WHEN cache_n IS NULL OR cache_n = 0
                            THEN prompt_ms END)              AS cold_prompt_ms,
                   SUM(predicted_n)                          AS predicted_n,
                   SUM(predicted_ms)                         AS predicted_ms,
                   SUM(draft_n)                              AS draft_n,
                   SUM(draft_n_accepted)                     AS draft_n_accepted
            FROM request WHERE run_id = ?""", (run_id,)).fetchone()
        facts.update(dict(agg) if agg else {})

        gpu = con.execute("SELECT * FROM v_run_gpu WHERE run_id = ?",
                          (run_id,)).fetchone()
        if gpu:
            facts.update({k: gpu[k] for k in gpu.keys() if k != "run_id"})

        info = con.execute("SELECT * FROM run_load_info WHERE run_id = ?",
                           (run_id,)).fetchone()
        if info:
            facts.update({k: info[k] for k in info.keys() if k != "run_id"})

        cold_n, cold_ms = facts.get("cold_prompt_n"), facts.get("cold_prompt_ms")
        pred_n, pred_ms = facts.get("predicted_n"), facts.get("predicted_ms")
        facts["prefill_tps"] = (cold_n / cold_ms * 1000) if cold_n and cold_ms else None
        facts["gen_tps"] = (pred_n / pred_ms * 1000) if pred_n and pred_ms else None
        drafted = facts.get("draft_n") or 0
        facts["acceptance"] = ((facts.get("draft_n_accepted") or 0) / drafted
                               if drafted else None)
        facts["source"] = "requests" if facts["gen_tps"] else None

        if facts["gen_tps"] is None:
            delta = metrics_delta(con, run_id)
            gen_n = delta.get("llamacpp:tokens_predicted_total")
            gen_s = delta.get("llamacpp:tokens_predicted_seconds_total")
            pp_n = delta.get("llamacpp:prompt_tokens_total")
            pp_s = delta.get("llamacpp:prompt_seconds_total")
            if gen_n and gen_s:
                facts["gen_tps"] = gen_n / gen_s
                facts["source"] = "metrics"
            if pp_n and pp_s and not facts["prefill_tps"]:
                facts["prefill_tps"] = pp_n / pp_s
        out.append(facts)
    return out
