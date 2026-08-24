#!/usr/bin/env python3
"""llama_log.py - assemble the per-configuration serving logs.

Part of https://github.com/epittman23/local-llm

The shell scripts stay the interface: llama-serve starts llama-vram-log.sh, which
samples nvidia-smi and scrapes the server's /metrics endpoint, and llama-test posts
prompts. Both hand their data here, because the arithmetic (averages, totals,
retention) and the markdown formatting are easier to get right in Python than in awk.

COMMANDS
  request   append one request's llama.cpp timings to the active run
            (timings JSON on stdin; a no-op when no run is being recorded)
  merge     fold a finished run into logs/<model>-<quant>.log (payload on stdin)

A log file holds one block per serving configuration, identified by a config-id
fingerprint over the serving flags. Within a block:

  ### previous runs                one row per run: GPU telemetry avg/max
  ### previous runs - requests     one row per run: llama-test throughput stats
  ### previous runs - server totals one row per run: /metrics deltas, all clients
  ### latest run                   every GPU sample of the most recent run
  #### requests                    every llama-test request of the most recent run

The two throughput tables come from different places on purpose. The request table is
exact and per-request but only sees llama-test; the server totals cover every client
(Open WebUI included) but are cumulative counters, so they are totals and nothing else.
Keeping them apart makes the disagreement legible instead of confusing.

Only the most recent run of a configuration keeps its full tables; older runs survive
as their summary rows. The reason to keep old runs is comparison, not replay, and a
multi-hour session at 5 s intervals is thousands of rows.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

# The marker llama-vram-log.sh writes while it is recording. llama-test looks for it
# to decide whether its request belongs to a run; without one it does not record,
# which is the right outcome for a server someone started by hand.
ACTIVE_MARKER = ".active-run.json"

# Notes kept in every log file's header. A config-id is a hash of the configuration
# lines, so changing what those lines contain changes every id, and blocks recorded
# on either side of such a change are not the same configuration even when they look
# alike. Each entry here records one such change, so a log read months later says so
# on its face. Append; never edit or reorder.
HEADER_NOTES = [
    "note 2026-08-23: --parallel entered the config-id fingerprint (and the config "
    "lines). Before this, llama-serve passed it only as part of the speculative "
    "flags, so runs with speculation off omitted it entirely -- and omitting it is "
    "not 1 but auto, which llama-server resolves to 4 slots with kv_unified = true. "
    "Blocks without a 'parallel:' line therefore ran with an unrecorded slot count, "
    "and their config-ids are not comparable with ids recorded after this date.",
    "note 2026-08-23: prompt statistics in 'previous runs - requests' are now "
    "computed from cold prefills only (cache_n == 0), and llama-test now sends "
    "cache_prompt: false (llama-server's own default is true). Rows recorded "
    "before this date blended cold and "
    "warm prefills into the columns now labelled 'cold prompt ...', which "
    "understates prefill cost whenever a run repeated a prompt; their empty "
    "cold/warm counts are how those rows are recognised.",
]

GPU_SAMPLE_COLUMNS = [
    "timestamp (UTC)", "temp (C)", "util (%)", "mem.used (MiB)",
    "mem.total (MiB)", "power (W)", "sm (MHz)",
]

GPU_SUMMARY_COLUMNS = [
    "started (UTC)", "duration", "samples", "build", "temp avg/max (C)",
    "util avg/max (%)", "mem.used avg/max (MiB)", "power avg/max (W)",
    "sm avg (MHz)",
]

# The raw llama.cpp timings field names are kept as headers so a row can be traced
# back to the response it came from without a translation table.
REQUEST_COLUMNS = [
    "timestamp (UTC)", "prompt", "model", "cache_n", "prompt_n", "prompt_ms",
    "prompt_per_token_ms", "prompt_per_second", "predicted_n", "predicted_ms",
    "predicted_per_token_ms", "predicted_per_second", "draft_n",
    "draft_n_accepted", "wall_ms",
]

# Prompt statistics are cold-only: a request served from the prompt cache reports
# cache_n > 0 and reprocesses only the tokens that differ, so its prompt_n/prompt_ms
# describe the cache rather than the serving configuration. Warm requests are
# summarised in their own columns because a follow-up turn's prefill is a real cost,
# just not the same measurement. Output and end-to-end figures cover every request:
# generation speed does not depend on how the prefill was obtained.
REQUEST_SUMMARY_COLUMNS = [
    "started (UTC)", "requests", "cold reqs", "warm reqs",
    "cold prompt tok total", "cold prompt tok avg",
    "cold prompt s total", "cold prompt s avg", "cold prompt t/s",
    "warm cached tok avg", "warm prompt tok avg", "warm prompt s avg",
    "output tok total", "output tok avg", "output s total", "output s avg",
    "e2e s total", "e2e s avg",
]

# Rows written before 2026-08-23 have these twelve cells and blended cold with warm.
# Mapping them into the columns above keeps every recorded number under a heading
# that still means what it meant, and leaves the cells that format never held empty.
LEGACY_REQUEST_SUMMARY = {0: 0, 1: 1, 2: 4, 3: 5, 4: 6, 5: 7,
                          6: 12, 7: 13, 8: 14, 9: 15, 10: 16, 11: 17}

SERVER_SUMMARY_COLUMNS = [
    "started (UTC)", "prompt tok", "cached tok", "prompt s", "prompt t/s",
    "output tok", "output s", "output t/s", "draft tok", "draft accepted",
]

# Counter names scraped from /metrics, in the order the delta row uses them.
SERVER_COUNTERS = [
    "prompt_tokens_total", "prompt_tokens_cached_total", "prompt_seconds_total",
    "tokens_predicted_total", "tokens_predicted_seconds_total",
    "spec_decode_num_draft_tokens_total", "spec_decode_num_accepted_tokens_total",
]


# ---------------------------------------------------------------------------
# markdown tables
# ---------------------------------------------------------------------------
def is_number(cell: str) -> bool:
    """A cell that should be right-aligned: a number, a ratio, or empty."""
    return cell == "" or bool(re.fullmatch(r"\d+(\.\d+)?(/\d+(\.\d+)?)?", cell))


def render_table(columns: list[str], rows: list[list[str]]) -> list[str]:
    """One markdown table with every column padded to a uniform width."""
    cells = [[str(c) for c in columns]] + [[str(c) for c in r] for r in rows]
    ncol = len(columns)
    cells = [r + [""] * (ncol - len(r)) for r in cells]
    width = [max(3, max(len(r[i]) for r in cells)) for i in range(ncol)]
    # A column is right-aligned only if every data cell in it is numeric.
    numeric = [all(is_number(r[i]) for r in cells[1:]) if len(cells) > 1 else False
               for i in range(ncol)]

    def line(values: list[str]) -> str:
        return "| " + " | ".join(
            v.rjust(width[i]) if numeric[i] else v.ljust(width[i])
            for i, v in enumerate(values)
        ) + " |"

    return [line(cells[0]),
            "| " + " | ".join("-" * w for w in width) + " |",
            *[line(r) for r in cells[1:]]]


def align_tables(lines: list[str]) -> list[str]:
    """Re-pad every markdown table in the text.

    Applied to the whole file on write, so blocks left by earlier runs are
    reformatted too rather than staying ragged next to a freshly built table.
    """
    out: list[str] = []
    table: list[list[str]] = []

    def flush() -> None:
        if not table:
            return
        body = [r for r in table
                if not all(re.fullmatch(r":?-+:?", c) for c in r)]
        if body:
            width = max(len(r) for r in body)
            body = [r + [""] * (width - len(r)) for r in body]
            out.extend(render_table(body[0], body[1:]))
        table.clear()

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("|") and stripped.endswith("|") and len(stripped) > 1:
            table.append([c.strip() for c in stripped[1:-1].split("|")])
            continue
        flush()
        out.append(line)
    flush()
    return out


# ---------------------------------------------------------------------------
# statistics
# ---------------------------------------------------------------------------
def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def gpu_summary_row(samples: list[dict], started: str, duration: str,
                    build: str) -> list[str]:
    def avg_max(key: str, digits: int = 0) -> str:
        vals = [s[key] for s in samples]
        return f"{mean(vals):.{digits}f}/{max(vals):.{digits}f}"

    return [started, duration, str(len(samples)), build,
            avg_max("temp"), avg_max("util"), avg_max("mem_used"),
            avg_max("power", 1), f"{mean([s['sm'] for s in samples]):.0f}"]


def is_cold(rec: dict) -> bool:
    """A prefill that reused nothing. cache_n is llama.cpp's count of prompt tokens
    taken from the cache; absent means the server did not report one, which only
    happens on builds without the field, so it is read as no reuse."""
    return not (rec.get("timings", {}).get("cache_n") or 0)


def request_summary_row(requests: list[dict], started: str) -> list[str]:
    """The per-run request statistics.

    Prompt figures come from cold requests only (see REQUEST_SUMMARY_COLUMNS); warm
    ones get their own averages. end-to-end is the wall clock llama-test measured
    around the request rather than prompt_ms + predicted_ms: on a streamed response
    the difference is real, and the wall clock is what the user actually waited.
    """
    cold = [r for r in requests if is_cold(r)]
    warm = [r for r in requests if not is_cold(r)]

    def field(recs: list[dict], key: str) -> list[float]:
        return [r.get("timings", {}).get(key) or 0 for r in recs]

    c_tok, c_ms = field(cold, "prompt_n"), field(cold, "prompt_ms")
    w_cached = field(warm, "cache_n")
    w_tok, w_ms = field(warm, "prompt_n"), field(warm, "prompt_ms")
    out_tok, out_ms = field(requests, "predicted_n"), field(requests, "predicted_ms")
    e2e_ms = [r["wall_ms"] if r.get("wall_ms") is not None
              else (r.get("timings", {}).get("prompt_ms") or 0)
                   + (r.get("timings", {}).get("predicted_ms") or 0)
              for r in requests]

    def secs(ms: list[float], avg: bool = False) -> str:
        if not ms:
            return ""
        return f"{(mean(ms) if avg else sum(ms)) / 1000:.1f}"

    def toks(values: list[float], avg: bool = False) -> str:
        if not values:
            return ""
        return f"{mean(values) if avg else sum(values):.0f}"

    cold_rate = ""
    if sum(c_ms) > 0:
        cold_rate = f"{sum(c_tok) / (sum(c_ms) / 1000):.2f}"

    return [started, str(len(requests)), str(len(cold)), str(len(warm)),
            toks(c_tok), toks(c_tok, avg=True),
            secs(c_ms), secs(c_ms, avg=True), cold_rate,
            toks(w_cached, avg=True), toks(w_tok, avg=True), secs(w_ms, avg=True),
            toks(out_tok), toks(out_tok, avg=True),
            secs(out_ms), secs(out_ms, avg=True),
            secs(e2e_ms), secs(e2e_ms, avg=True)]


def request_row(rec: dict) -> list[str]:
    t = rec.get("timings", {})

    def num(key: str, digits: int = 2) -> str:
        v = t.get(key)
        if v is None:
            return "n/a"
        return f"{v:.{digits}f}" if isinstance(v, float) else str(v)

    wall = rec.get("wall_ms")
    return [rec.get("timestamp", "?"), rec.get("prompt", "?"), rec.get("model", "?"),
            num("cache_n"), num("prompt_n"), num("prompt_ms"),
            num("prompt_per_token_ms"), num("prompt_per_second"),
            num("predicted_n"), num("predicted_ms"),
            num("predicted_per_token_ms"), num("predicted_per_second"),
            num("draft_n"), num("draft_n_accepted"),
            f"{wall:.0f}" if isinstance(wall, (int, float)) else "n/a"]


def server_summary_row(delta: dict, started: str) -> list[str]:
    """One row of /metrics counter deltas over the run.

    There is no request counter in the endpoint (checked against the server source
    for build 10597), so the number of requests is deliberately absent here rather
    than inferred from n_decode_total, which counts decode calls, not requests.

    prompt t/s needs no cache correction: prompt_tokens_total counts only processed
    tokens. Checked in build 10597 rather than assumed - server-common.h:455 says
    "only processed tokens, cached ones are counted separately below",
    server-context.cpp:3938 feeds it n_prompt_queued, and cache hits go to
    add_prompt_cached() (:3296) which backs the separate cached-token counter shown
    in its own column. Unlike the llama-test table, these totals do mix cold and
    warm prefills, because the counters cannot tell them apart per request; the
    cached column is what says how much of the run was warm.
    """
    def rate(tok: float, sec: float) -> str:
        return f"{tok / sec:.2f}" if sec > 0 else "n/a"

    p_tok = delta["prompt_tokens_total"]
    p_sec = delta["prompt_seconds_total"]
    o_tok = delta["tokens_predicted_total"]
    o_sec = delta["tokens_predicted_seconds_total"]
    return [started, f"{p_tok:.0f}", f"{delta['prompt_tokens_cached_total']:.0f}",
            f"{p_sec:.1f}", rate(p_tok, p_sec),
            f"{o_tok:.0f}", f"{o_sec:.1f}", rate(o_tok, o_sec),
            f"{delta['spec_decode_num_draft_tokens_total']:.0f}",
            f"{delta['spec_decode_num_accepted_tokens_total']:.0f}"]


# ---------------------------------------------------------------------------
# log file structure
# ---------------------------------------------------------------------------
class Block:
    """One serving configuration's section of a log file."""

    def __init__(self, config_id: str, config_lines: list[str]):
        self.config_id = config_id
        self.config_lines = config_lines
        self.gpu_summary: list[list[str]] = []
        self.request_summary: list[list[str]] = []
        self.server_summary: list[list[str]] = []
        self.latest: list[str] = []      # rendered latest-run sections, verbatim

    def render(self, number: int) -> list[str]:
        out = [f"## config {number}", f"config-id: {self.config_id}"]
        out += self.config_lines
        out += ["", "### previous runs"]
        out += render_table(GPU_SUMMARY_COLUMNS, self.gpu_summary)
        if self.request_summary:
            out += ["", "### previous runs - requests"]
            out += render_table(REQUEST_SUMMARY_COLUMNS, self.request_summary)
        if self.server_summary:
            out += ["", "### previous runs - server totals"]
            out += render_table(SERVER_SUMMARY_COLUMNS, self.server_summary)
        if self.latest:
            out += [""] + self.latest
        return out


SECTIONS = [
    ("### previous runs - requests", "request_summary"),
    ("### previous runs - server totals", "server_summary"),
    ("### previous runs", "gpu_summary"),
]


def parse_log(path: Path) -> tuple[list[str], list[Block]]:
    """Read an existing log into its header and per-configuration blocks."""
    header: list[str] = []
    chunks: list[list[str]] = []
    current: list[str] | None = None

    for line in path.read_text().split("\n"):
        if line.strip() == "---":
            current = []
            chunks.append(current)
            continue
        (current if current is not None else header).append(line)

    blocks = [b for b in (parse_block(c) for c in chunks) if b]
    return [h for h in header if h.strip()], blocks


def parse_block(lines: list[str]) -> Block | None:
    section = ""
    block: Block | None = None

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("config-id:"):
            block = Block(stripped.split(":", 1)[1].strip(), [])
            section = "config"
            continue
        if block is None:
            continue

        if stripped.startswith("###"):
            section = next((s for h, s in SECTIONS if stripped.startswith(h)),
                           "latest")
            if section == "latest":
                block.latest.append(line)
            continue
        if section == "latest":
            block.latest.append(line)
            continue
        if section == "config":
            if stripped:
                block.config_lines.append(line)
            continue

        if not stripped.startswith("|"):
            continue
        cells = [c.strip() for c in stripped[1:-1].split("|")]
        if all(re.fullmatch(r":?-+:?", c) for c in cells):
            continue
        if cells[0].startswith("started"):          # the table's header row
            continue
        if section == "request_summary" and len(cells) == len(LEGACY_REQUEST_SUMMARY):
            row = [""] * len(REQUEST_SUMMARY_COLUMNS)
            for old, new in LEGACY_REQUEST_SUMMARY.items():
                row[new] = cells[old]
            cells = row
        getattr(block, section).append(cells)

    if block:
        # Trailing blank lines inside a retained latest-run section would
        # otherwise accumulate on every merge.
        while block.latest and not block.latest[-1].strip():
            block.latest.pop()
    return block


def render_latest(started: str, build: str, samples: list[dict],
                  requests: list[dict]) -> list[str]:
    out = [f"### latest run - {started} (build {build})"]
    out += render_table(GPU_SAMPLE_COLUMNS,
                        [[s["timestamp"], s["temp"], s["util"], s["mem_used"],
                          s["mem_total"], s["power"], s["sm"]] for s in samples])
    if requests:
        out += ["", f"#### requests - {started}"]
        out += render_table(REQUEST_COLUMNS, [request_row(r) for r in requests])
    return out


# ---------------------------------------------------------------------------
# inputs
# ---------------------------------------------------------------------------
def read_samples(path: Path) -> list[dict]:
    """Parse the recorder's pipe-separated nvidia-smi samples."""
    samples = []
    for line in path.read_text().split("\n"):
        if not line.strip() or line.startswith("#"):
            continue
        f = line.split("|")
        if len(f) < 7:
            continue
        try:
            samples.append({"timestamp": f[0], "temp": int(f[1]), "util": int(f[2]),
                            "mem_used": int(f[3]), "mem_total": int(f[4]),
                            "power": float(f[5]), "sm": int(f[6])})
        except ValueError:
            continue
    return samples


def read_requests(path: Path | None) -> list[dict]:
    if not path or not path.exists():
        return []
    out = []
    for line in path.read_text().split("\n"):
        if line.strip():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def read_metrics(path: Path | None) -> dict[str, float] | None:
    """Parse a Prometheus scrape into {counter: value}."""
    if not path or not path.exists():
        return None
    values = {}
    for line in path.read_text().split("\n"):
        if not line.startswith("llamacpp:"):
            continue
        name, _, value = line[len("llamacpp:"):].partition(" ")
        try:
            values[name] = float(value)
        except ValueError:
            continue
    return values or None


def metrics_delta(start: dict | None, end: dict | None) -> dict | None:
    """Counters accumulated during the run.

    A missing start scrape (the recorder attached to an already-busy server) means
    the whole delta is unknowable, so no row is written rather than a wrong one.
    """
    if not end or start is None:
        return None
    delta = {k: end.get(k, 0.0) - start.get(k, 0.0) for k in SERVER_COUNTERS}
    if any(v < 0 for v in delta.values()):   # the server restarted under us
        return None
    if delta["prompt_tokens_total"] == 0 and delta["tokens_predicted_total"] == 0:
        return None                          # nothing was served; an empty row lies
    return delta


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------
def cmd_request(args: argparse.Namespace) -> int:
    """Append one request to the active run, if a run is being recorded."""
    marker = Path(args.logdir) / ACTIVE_MARKER
    if not marker.exists():
        return 0
    try:
        active = json.loads(marker.read_text())
    except (OSError, json.JSONDecodeError):
        return 0
    # A request against some other server is not part of this run.
    if args.port and str(active.get("port")) != str(args.port):
        return 0

    raw = sys.stdin.read().strip()
    try:
        timings = json.loads(raw) if raw else None
    except json.JSONDecodeError:
        return 0
    if not isinstance(timings, dict):
        return 0

    record = {"timestamp": args.timestamp, "model": args.model,
              "prompt": args.prompt, "wall_ms": args.wall_ms, "timings": timings}
    with open(active["requests"], "a") as fh:
        fh.write(json.dumps(record) + "\n")
    return 0


def cmd_merge(args: argparse.Namespace) -> int:
    payload = json.load(sys.stdin)
    log = Path(payload["log"])

    samples = read_samples(Path(payload["samples"]))
    if not samples:
        return 1
    requests = read_requests(_path(payload.get("requests")))
    delta = metrics_delta(read_metrics(_path(payload.get("metrics_start"))),
                          read_metrics(_path(payload.get("metrics_end"))))

    started, build = payload["started"], payload["build"]

    if log.exists():
        header, blocks = parse_log(log)
    else:
        header, blocks = [payload["model"], payload["quant"]], []

    block = next((b for b in blocks if b.config_id == payload["config_id"]), None)
    if block is None:
        block = Block(payload["config_id"], payload["config_lines"])
        blocks.append(block)
    else:
        # The flags are the block's identity, but rewriting them keeps a block
        # current if their human-readable rendering ever changes.
        block.config_lines = payload["config_lines"]

    block.gpu_summary.append(
        gpu_summary_row(samples, started, payload["duration"], build))
    if requests:
        block.request_summary.append(request_summary_row(requests, started))
    if delta:
        block.server_summary.append(server_summary_row(delta, started))
    block.latest = render_latest(started, build, samples, requests)

    # Header notes sort below the model/quant title lines and survive re-parsing,
    # which strips the blank line between them.
    notes = [h for h in header if h.startswith("note ")]
    notes += [n for n in HEADER_NOTES if n not in notes]
    out = [h for h in header if not h.startswith("note ")]
    if notes:
        out += [""] + notes
    for i, b in enumerate(blocks, start=1):
        out += ["", "---", ""] + b.render(i)

    tmp = log.with_name(log.name + f".tmp.{os.getpid()}")
    tmp.write_text("\n".join(align_tables(out)).rstrip("\n") + "\n")
    tmp.replace(log)
    return 0


def _path(value) -> Path | None:
    return Path(value) if value else None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="assemble the llama.cpp serving logs")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("request", help="record one request's timings")
    p.add_argument("--logdir", required=True)
    p.add_argument("--model", default="?")
    p.add_argument("--prompt", default="?")
    p.add_argument("--timestamp", default="?")
    p.add_argument("--wall-ms", type=float, default=None)
    p.add_argument("--port", default="")
    p.set_defaults(func=cmd_request)

    p = sub.add_parser("merge", help="fold a finished run into its log file")
    p.set_defaults(func=cmd_merge)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
