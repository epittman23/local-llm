#!/usr/bin/env python3
"""llama_compare.py - compare models and serving configurations on test results.

Part of https://github.com/epittman23/local-llm

The serving telemetry already ranks configurations by throughput. This ranks
them by whether they were *right*, which is the question that decides whether
local inference can replace OpenRouter -- a configuration that generates faster
and answers worse has not improved anything.

Groups results by (model, config-id, tier) and joins each group to the
configuration that produced it. That join used to mean globbing logs/*.log and
parsing every markdown block in every file to rebuild a config-id -> flags
dict; it is now result.config_id against the config table, which is most of
what the database was for. The flag columns are still built with
llama_stats.py's own helpers (short_spec, short_ot, config_value) rather than
reimplemented, so a row here reads the same as it always did.

Three rules the output obeys, each of them learned from a mistake recorded in
CLAUDE.md's decisions log:

  * Counts, never bare percentages. At the smoke tier one item is about four
    points, and `88%` invites a comparison that 24 items cannot support.
  * Tiers do not mix. A 24-item pass rate and a 164-item one are not comparable,
    so rows from different tiers are never ranked against each other.
  * A pair of configurations differing in more than one flag is flagged as
    such. This repo lost a measurement to exactly that (the 2026-08-23
    `--parallel` entry): three flags changed at once and the comparison meant
    nothing.

Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import llama_db as db
import llama_results as store
from llama_console import console
from llama_stats import (config_value, effective_bandwidth, headroom_in_layers,
                         headroom_warning, ngl_fit, render_table, short_ot,
                         short_spec)

REPO = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------------------
# joining test results to the serving configuration that produced them
# ---------------------------------------------------------------------------
FLAG_KEYS = ["ngl", "parallel", "context", "threads", "n-cpu-moe", "batch",
             "ubatch", "cache-type-k", "cache-type-v"]


def flags_of(config_lines: list[str]) -> dict[str, str]:
    """The flag values this comparison cares about, from a block's config lines."""
    out = {}
    for key in FLAG_KEYS:
        value = config_value(config_lines, key)
        if value is not None:
            out[key] = value
    out["spec"] = short_spec(config_value(config_lines, "speculative"))
    out["-ot"] = short_ot(config_value(config_lines, "override-tensors"))
    return out


def differing(a: dict, b: dict) -> list[str]:
    """Which flags two configurations disagree on."""
    return sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))


# ---------------------------------------------------------------------------
# grouping
# ---------------------------------------------------------------------------
class Group:
    """One (model, config-id, tier, system prompt, adapter)."""

    def __init__(self, model: str, config_id: str, tier: str, system: str,
                 adapter: str):
        self.model = model
        self.config_id = config_id
        self.tier = tier
        # The system prompt's sha, or "" for none. Part of the key rather than a
        # column alone: a prompt changes what the model was asked, so averaging
        # a run that carried one with a run that did not would hide exactly the
        # difference someone ran both to measure.
        self.system = system
        # The adapter fingerprint, or "" for a row recorded before adapters
        # were fingerprinted. Unlike `system`, "" here is genuinely unknown
        # rather than "none" -- see the note on migration 3 -- so an empty one
        # is labelled `?` and never silently pooled with a known adapter.
        self.adapter = adapter
        self.records: list[dict] = []

    @property
    def key(self):
        return (self.model, self.config_id, self.tier, self.system,
                self.adapter)

    def system_label(self) -> str:
        """name@sha for a prompt, "-" for none.

        The name comes from the records rather than the key because the key is
        the sha: two rows with the same name and different shas are a file that
        was edited between runs, and they must stay two rows.
        """
        if not self.system:
            return "-"
        names = {r.get("system_name") for r in self.records if r.get("system_name")}
        name = sorted(names)[0] if len(names) == 1 else "?"
        return f"{name}@{self.system}"

    def adapter_label(self) -> str:
        """The adapter sha, or `?` for a row that predates the fingerprint."""
        return self.adapter or "?"

    def graded(self):
        return store.graded(self.records)

    def rate(self):
        return store.pass_rate(self.records)

    def by_benchmark(self) -> dict[str, tuple[int, int, float | None]]:
        out = {}
        for name in sorted({r.get("benchmark", "") for r in self.records}):
            subset = [r for r in self.records if r.get("benchmark") == name]
            out[name] = store.pass_rate(subset)
        return out

    def timing(self, field: str) -> list[float]:
        vals = []
        for r in self.graded():
            t = r.get("timings") or {}
            if isinstance(t.get(field), (int, float)):
                vals.append(float(t[field]))
        return vals

    def gen_tps(self) -> float | None:
        n, ms = self.timing("predicted_n"), self.timing("predicted_ms")
        total = sum(ms)
        return (sum(n) / total) * 1000 if total else None

    def prefill_tps(self) -> float | None:
        """Cold prefill only. A cached prefill measures the cache, not the flags.

        cache_prompt is false by default in llama-test for exactly this reason;
        a request that ran with it on is excluded here rather than blended in.
        """
        n = ms = 0.0
        for r in self.graded():
            if (r.get("params") or {}).get("cache_prompt"):
                continue
            t = r.get("timings") or {}
            if isinstance(t.get("prompt_n"), (int, float)) and t.get("prompt_ms"):
                n += float(t["prompt_n"])
                ms += float(t["prompt_ms"])
        return (n / ms) * 1000 if ms else None

    def acceptance(self) -> float | None:
        drafted = sum(self.timing("draft_n"))
        accepted = sum(self.timing("draft_n_accepted"))
        return accepted / drafted if drafted else None

    def wall_minutes(self) -> float:
        return sum(float(r.get("wall_ms") or 0) for r in self.graded()) / 60000

    def passes_per_minute(self) -> float | None:
        """The honest combined metric on this hardware.

        Pass rate alone would rank a configuration that answers correctly at one
        token a second above a usable one; throughput alone is what the serving
        log already reports. This is the quantity being optimised: correct
        answers per unit of wall clock.
        """
        minutes = self.wall_minutes()
        if minutes <= 0:
            return None
        return self.rate()[0] / minutes

    def revision(self) -> str:
        revs = {r.get("dataset_revision", "") for r in self.records
                if r.get("dataset_revision")}
        return sorted(revs)[0][:12] if len(revs) == 1 else (
            "mixed" if revs else "-")

    def revision_map(self) -> dict[str, str]:
        """benchmark -> dataset revision, for the disagreement check.

        The `revision` column collapses to "mixed" whenever a row spans more
        than one benchmark, which every tier does. Comparing that collapsed
        string between rows would report a disagreement whenever a
        single-benchmark row sits beside a tier -- so the check is made per
        benchmark instead, and only fires when two rows asked the same
        benchmark at different revisions.
        """
        out: dict[str, str] = {}
        for r in self.records:
            rev = r.get("dataset_revision")
            if rev:
                out[r.get("benchmark", "")] = rev[:12]
        return out

    def when(self) -> str:
        stamps = [r.get("at", "") for r in self.records if r.get("at")]
        return max(stamps) if stamps else ""


def group_records(records: list[dict], by_benchmark: bool = False) -> list[Group]:
    groups: dict[tuple, Group] = {}
    for r in records:
        # A result whose server was started by hand has config_id NULL in the
        # database; "unrecorded" is the name it is given here, for display.
        # system_sha is NULL for a result measured without a system prompt,
        # which the database's schema note defines as "none sent" rather than
        # "unknown" -- so "" is a real group here, not a missing value.
        # adapter_sha is NULL only for rows written before migration 3, where
        # it means "not recorded" -- so it is its own group, and rows either
        # side of the fingerprint are never averaged together.
        key = (r.get("model", "?"), r.get("config_id") or "unrecorded",
               r.get("tier", "?"), r.get("system_sha") or "",
               r.get("adapter_sha") or "")
        groups.setdefault(key, Group(*key)).records.append(r)
    return list(groups.values())


# ---------------------------------------------------------------------------
# rendering
# ---------------------------------------------------------------------------
# `skipped` was a column here while every run re-recorded its own copy of the
# exclusion list. It is not one now: what a run could not attempt is a property
# of the benchmark, the calibration and this box's library versions, identical
# across every configuration, so a per-configuration column for it said nothing.
# It is reported once, under the table, by exclusion_note().
COLUMNS = ["model", "config-id", "tier", "system", "adapter", "ngl", "parallel", "spec",
           "-ot", "revision", "passed/attempted", "pass rate", "prefill t/s",
           "gen t/s", "acceptance", "passes/min", "last run"]


def fmt(value, spec: str = "{:.2f}", dash: str = "-") -> str:
    return dash if value is None else spec.format(value)


def rows_for(groups: list[Group], blocks: dict[str, list[str]]) -> list[list[str]]:
    """One row per group, ranked. Groups with nothing graded sort last.

    Sorting them last rather than as zero matches the serving comparison: a
    configuration
    with no measurement is not a configuration that scored nothing.
    """
    def sort_key(g: Group):
        passed, attempted, rate = g.rate()
        if attempted == 0:
            return (1, 0.0, 0.0)
        return (0, -(rate or 0), -(g.gen_tps() or 0))

    rows = []
    for g in sorted(groups, key=sort_key):
        flags = flags_of(blocks.get(g.config_id, []))
        passed, attempted, rate = g.rate()
        rows.append([
            g.model, g.config_id, g.tier, g.system_label(),
            g.adapter_label(), flags.get("ngl", "-"), flags.get("parallel", "-"),
            flags.get("spec", "-"), flags.get("-ot", "-"),
            g.revision(),
            f"{passed}/{attempted}",
            "-" if rate is None else f"{rate * 100:.1f}%",
            fmt(g.prefill_tps()), fmt(g.gen_tps()),
            fmt(g.acceptance(), "{:.3f}"), fmt(g.passes_per_minute()),
            g.when()[:19],
        ])
    return rows


def benchmark_rows(groups: list[Group]) -> tuple[list[str], list[list[str]]]:
    names = sorted({r.get("benchmark", "")
                    for g in groups for r in g.records if r.get("benchmark")})
    columns = ["model", "config-id", "tier", "system"] + names + ["all"]
    rows = []
    for g in sorted(groups, key=lambda x: -(x.rate()[2] or 0)):
        cells = [g.model, g.config_id, g.tier, g.system_label(),
                 g.adapter_label()]
        per = g.by_benchmark()
        for name in names:
            passed, attempted, rate = per.get(name, (0, 0, None))
            cells.append("-" if attempted == 0
                         else f"{passed}/{attempted} ({rate * 100:.0f}%)")
        passed, attempted, rate = g.rate()
        cells.append("-" if attempted == 0
                     else f"{passed}/{attempted} ({rate * 100:.0f}%)")
        rows.append(cells)
    return columns, rows


def caveats(groups: list[Group], blocks: dict[str, list[str]]) -> list[str]:
    """The warnings that keep a table from being read as more than it is."""
    out: list[str] = []
    tiers = {g.tier for g in groups}
    if len(tiers) > 1:
        out.append(f"> note: rows span {len(tiers)} tiers ({', '.join(sorted(tiers))}). "
                   f"Pass rates are only comparable within a tier -- the tiers "
                   f"ask different questions of different item counts.")

    by_name: dict[str, set] = {}
    for g in groups:
        if g.system:
            names = {r.get("system_name") for r in g.records
                     if r.get("system_name")}
            for name in names:
                by_name.setdefault(name, set()).add(g.system)
    edited = sorted(n for n, shas in by_name.items() if len(shas) > 1)
    if edited:
        out.append(f"> note: {', '.join(edited)} appears with more than one "
                   f"sha, so prompts/system/ was edited between these runs. "
                   f"They are separate rows because they are separate prompts; "
                   f"the file's current text is only the most recent one.")

    small = sorted({g.tier for g in groups if 0 < g.rate()[1] < 50})
    if small:
        out.append(f"> note: {', '.join(small)} has fewer than 50 graded items, "
                   f"so one item moves the rate by more than two points. Read "
                   f"the counts, not the percentage.")

    seen: dict[str, set[str]] = {}
    for g in groups:
        for b, rev in g.revision_map().items():
            seen.setdefault(b, set()).add(rev)
    split = sorted(f"{b} ({', '.join(sorted(revs))})"
                   for b, revs in seen.items() if len(revs) > 1)
    if split:
        out.append("> warning: rows were measured against different dataset "
                   "revisions of " + "; ".join(split) + ". They are not the "
                   "same test.")

    # Within one tier, two rows can still have been asked different questions:
    # `--benchmark humaneval` records tier "smoke" while covering a third of
    # it. The tier label alone would hide that, so the benchmark sets are
    # compared too.
    for tier in sorted(tiers):
        peers = [g for g in groups if g.tier == tier and g.rate()[1] > 0]
        sets = {frozenset(g.revision_map()) for g in peers}
        if len(sets) > 1:
            shown = sorted("/".join(sorted(s_)) or "none" for s_ in sets)
            out.append(f"> warning: rows in tier `{tier}` cover different "
                       f"benchmarks ({'; '.join(shown)}), so their pass rates "
                       f"are over different items. Use --by benchmark.")

    # The multi-flag warning, per tier: a comparison is only a comparison when
    # one thing changed.
    for tier in sorted(tiers):
        peers = [g for g in groups if g.tier == tier and g.rate()[1] > 0]
        for i, a in enumerate(peers):
            for b in peers[i + 1:]:
                if a.config_id == b.config_id:
                    continue
                diff = differing(flags_of(blocks.get(a.config_id, [])),
                                 flags_of(blocks.get(b.config_id, [])))
                if len(diff) > 1:
                    out.append(
                        f"> warning: `{a.config_id}` and `{b.config_id}` differ "
                        f"in {len(diff)} flags ({', '.join(diff)}). A difference "
                        f"between them cannot be attributed to any one of them.")
    unknown = sorted({g.config_id for g in groups
                      if g.config_id not in blocks and g.config_id != "unrecorded"})
    if unknown:
        out.append(f"> note: no config row for "
                   f"{', '.join('`' + c + '`' for c in unknown)}, so their flag "
                   f"columns are blank. The results are still valid; the flags "
                   f"are simply not recorded in this database.")
    if any(g.config_id == "unrecorded" for g in groups):
        out.append("> note: `unrecorded` means the server was started by hand, "
                   "outside llama-serve, so no telemetry run was active and the "
                   "flags in force were never captured.")
    return out


def exclusion_note(conn) -> list[str]:
    """What no configuration could attempt, said once rather than per row.

    An item is excluded when it falls outside its adapter's library filter, when
    its library is not installed here, or when the benchmark's own reference
    solution does not pass in this environment (see `llama-test selfcheck`).
    Counting any of those as a model failure would measure the box rather than
    the model -- on DS-1000 it would have understated every model by about 14
    points forever -- so they are dropped from the pool before sampling, and the
    denominator beside every rate is the number of items actually asked.
    """
    counts = store.excluded_counts(conn)
    if not counts:
        return []
    shown = ", ".join(f"{name} {n}" for name, n in sorted(counts.items()))

    # Split by kind, because the two are invalidated by different things: the
    # library filter by editing an adapter, the calibration by a dataset
    # refetch or a library upgrade on this box.
    kinds: dict[str, int] = {}
    for row in store.excluded(conn):
        kinds[row.get("kind") or "unattemptable"] = \
            kinds.get(row.get("kind") or "unattemptable", 0) + 1
    why = ", ".join(f"{n} {k.replace('_', ' ')}"
                    for k, n in sorted(kinds.items(), key=lambda kv: -kv[1]))
    return [f"> note: {sum(counts.values())} items are excluded from the pool "
            f"before sampling ({shown}): {why}. They are not in any "
            f"denominator above."]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="llama-test compare",
        description="compare models and serving configurations on test results")
    parser.add_argument("--by",
                        choices=["config", "benchmark", "failures", "serving"],
                        default="config",
                        help="config: one row per (model, config-id, tier). "
                             "benchmark: pass rate per benchmark. "
                             "failures: the items that did not pass. "
                             "serving: throughput and GPU telemetry per "
                             "configuration, independent of any test run.")
    parser.add_argument("--tier", help="only rows from this tier")
    parser.add_argument("--model", help="only rows for this model")
    parser.add_argument("--baseline", help="config-id to show deltas against")
    parser.add_argument("--format", choices=["table", "markdown", "json"],
                        default="table",
                        help="markdown is for pasting a measured table into "
                             "README.md; nothing reads it back")
    args = parser.parse_args(argv)

    con = console()
    conn = db.connect()

    if args.by == "serving":
        # Deliberately before the results check: a serving run is measurable
        # on its own, and "no test results yet" must not hide the telemetry of
        # the server that is running right now.
        if args.format == "json":
            json.dump(db.serving_summary(conn), sys.stdout, indent=2,
                      default=str)
            sys.stdout.write("\n")
            return 0
        rows, derived, notes = serving_rows(conn)
        if not rows:
            con.note(f"no serving runs recorded in {store.db_path()}")
            con.note("run: llama-serve qwen38")
            return 0
        if args.format == "markdown":
            print("\n".join(render_table(SERVING_COLUMNS, rows)))
            print()
            print("\n".join(render_table(DERIVED_COLUMNS, derived)))
            return 0
        con.table(SERVING_COLUMNS, rows, title="serving configurations")
        con.table(DERIVED_COLUMNS, derived, title="derived")
        for note in notes:
            text = note.lstrip("> ")
            if text.startswith("warning: "):
                con.warn(text[len("warning: "):])
            else:
                con.note(text.removeprefix("note: "))
        return 0

    records = store.read_all(conn, tier=args.tier, model=args.model)

    if not records:
        con.note(f"no test results in {store.db_path()}"
                 + (" matching that filter" if (args.tier or args.model) else ""))
        con.note("run: llama-test --suite smoke")
        return 0

    groups = group_records(records)
    # The join the move to SQLite was for: one query instead of globbing every
    # log file and parsing every markdown block in it.
    blocks = db.configs(conn)

    if args.format == "json":
        payload = []
        for g in groups:
            passed, attempted, rate = g.rate()
            payload.append({
                "model": g.model, "config_id": g.config_id, "tier": g.tier,
                "flags": flags_of(blocks.get(g.config_id, [])),
                "dataset_revision": g.revision(),
                "passed": passed, "attempted": attempted, "pass_rate": rate,
                "per_benchmark": {k: {"passed": v[0], "attempted": v[1],
                                      "pass_rate": v[2]}
                                  for k, v in g.by_benchmark().items()},
                "prefill_tps": g.prefill_tps(), "gen_tps": g.gen_tps(),
                "acceptance": g.acceptance(),
                "passes_per_minute": g.passes_per_minute(),
                "last_run": g.when(),
            })
        json.dump(payload, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    if args.by == "benchmark":
        columns, rows = benchmark_rows(groups)
        title = "test results by benchmark"
    elif args.by == "failures":
        columns, rows = failure_rows(groups)
        title = "failures"
    else:
        columns, rows = COLUMNS, rows_for(groups, blocks)
        title = "test results by configuration"

    if args.by == "config" and args.baseline:
        rows = _with_deltas(groups, blocks, args.baseline, rows, con)
        # _with_deltas leaves the rows untouched when the baseline config-id
        # has no results, so the header follows the rows rather than the flag.
        if rows and len(rows[0]) > len(columns):
            columns = columns + ["vs baseline"]

    if args.format == "markdown":
        print("\n".join(render_table(columns, rows)))
        return 0

    con.table(columns, rows, title=title)
    notes = (caveats(groups, blocks) + exclusion_note(conn)
             if args.by != "failures" else [])
    for note in notes:
        # The caveats carry their own "note: "/"warning: " label, and con.warn
        # adds one of its own; strip it here rather than emitting
        # "warning: warning:".
        text = note.lstrip("> ")
        if text.startswith("warning: "):
            con.warn(text[len("warning: "):])
        else:
            con.note(text)
    return 0


DERIVED_COLUMNS = ["config-id", "cpu-resident layers", "ms/token",
                   "cpu bandwidth (GiB/s)", "headroom in layers"]

SERVING_COLUMNS = ["config-id", "alias", "model", "ngl", "parallel", "spec",
                   "-ot", "fused_gdn", "cold prefill t/s", "gen t/s",
                   "acceptance", "peak VRAM", "headroom", "build", "last run"]


def serving_rows(conn) -> tuple[list[list[str]], list[list[str]], list[str]]:
    """The serving-side comparison: one row per configuration, fastest first.

    What the markdown log rendered at the head of every file, as a query. Rows
    are sorted by generation throughput; a configuration that has never been
    measured sorts last rather than as zero, because it is unknown, not slow.
    A figure marked `*` came from the server's own /metrics counters instead of
    from llama-test requests -- it covers every client and whatever prompts they
    sent, so it answers a looser question than a row measured on the
    version-controlled prompt at temperature 0.
    """
    facts = db.serving_summary(conn)

    def star(value, row, spec="{:.2f}"):
        if value is None:
            return "-"
        return fmt(value, spec) + ("*" if row.get("source") == "metrics" else "")

    facts.sort(key=lambda r: (r.get("gen_tps") is None, -(r.get("gen_tps") or 0)))

    rows = []
    for r in facts:
        lines = (r.get("config_text") or "").split("\n")
        rows.append([
            r.get("config_id", ""), r.get("alias", ""), r.get("model", ""),
            config_value(lines, "ngl") or "-",
            config_value(lines, "parallel") or "-",
            short_spec(config_value(lines, "speculative")),
            short_ot(config_value(lines, "override-tensors")),
            r.get("fused_gdn") or "-",
            star(r.get("prefill_tps"), r),
            star(r.get("gen_tps"), r),
            fmt(r.get("acceptance"), "{:.3f}", dash=""),
            fmt(r.get("mem_max"), "{:.0f}"),
            fmt(r.get("vram_headroom_mib"), "{:.0f}"),
            (r.get("build") or "")[:12],
            (r.get("started_at") or "")[:19],
        ])

    derived = []
    fit_input = []
    for r in facts:
        lines = (r.get("config_text") or "").split("\n")
        arch = config_value(lines, "arch")
        gen = r.get("gen_tps")
        # Derived rather than stored: the load log reports the split it
        # actually made, and the remainder is what generation speed on this
        # hardware tracks.
        cpu_layers = None
        if r.get("layers_total") is not None and r.get("layers_gpu") is not None:
            cpu_layers = r["layers_total"] - r["layers_gpu"]
        derived.append([
            r.get("config_id", ""),
            "" if cpu_layers is None else str(cpu_layers),
            fmt(1000.0 / gen if gen else None, "{:.0f}"),
            effective_bandwidth(arch, r.get("cpu_buffer_mib"), gen),
            headroom_in_layers(r, r.get("vram_headroom_mib")) or "",
        ])
        fit_input.append({"config_text": r.get("config_text", ""),
                          "gen": gen, "cpu_layers": cpu_layers})

    notes = ["> note: " + line for line in ngl_fit(fit_input)]
    # A run that fit with almost nothing to spare is a result that will not
    # reproduce after a context-size change, which is the whole point of the
    # -ngl sweep on a 6 GB card -- so it is called out rather than left to be
    # read off the headroom column.
    for r in facts:
        warning = headroom_warning(
            f"{r.get('config_id', '?')} ({(r.get('started_at') or '')[:19]})",
            r.get("vram_headroom_mib"))
        if warning:
            notes.append(warning)
    return rows, derived, notes


def failure_rows(groups: list[Group]) -> tuple[list[str], list[list[str]]]:
    """Every item that did not pass, newest group first.

    This is what the per-group sections of logs/tests.log carried, and it is the
    part of that file worth keeping: passes are not listed individually because
    the count is the result, while the failures are the list of things to go and
    look at. `llama-test answer <benchmark>/<item>` prints one in full.
    """
    rows = []
    for g in sorted(groups, key=lambda x: x.when(), reverse=True):
        for r in g.records:
            if r.get("outcome") not in store.FAILURES:
                continue
            rows.append([g.config_id, r.get("benchmark", ""),
                         str(r.get("item_id", "")), r.get("outcome", ""),
                         (r.get("reason") or "")[:110],
                         str(r.get("reasoning_chars") or "")])
    return (["config-id", "benchmark", "item", "outcome", "reason",
             "reasoning chars"], rows)


def _with_deltas(groups: list[Group], blocks: dict, baseline: str,
                 rows: list[list[str]], con) -> list[list[str]]:
    """Append a delta column against one config-id.

    Deltas are only computed within a tier. Across tiers the difference of two
    pass rates is not a delta, it is a category error.
    """
    base = next((g for g in groups if g.config_id == baseline), None)
    if base is None:
        con.warn(f"no results for baseline config-id '{baseline}'")
        return rows
    brate = base.rate()[2]
    out = []
    ordered = sorted(groups, key=lambda g: (g.rate()[1] == 0,
                                            -(g.rate()[2] or 0),
                                            -(g.gen_tps() or 0)))
    for row, g in zip(rows, ordered):
        rate = g.rate()[2]
        if g.tier != base.tier:
            out.append(row + ["n/a (different tier)"])
        elif rate is None or brate is None:
            out.append(row + ["-"])
        else:
            out.append(row + [f"{(rate - brate) * 100:+.1f}pp"])
    return out


if __name__ == "__main__":
    sys.exit(main())
