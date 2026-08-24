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
fingerprint over the serving flags. A block opens with three groups of context:

  server flags:                what llama-serve passed; these lines ARE the config-id
  request params (llama-test): what llama-test actually put in the request body
  load log:                    what the server said about the model it loaded

Only the first is fingerprinted. The other two are observations of a run rather
than settings, and fingerprinting them would make a run that served no llama-test
request a different configuration from one that did. They are still worth
recording: the server's sampler defaults are not what a llama-test request runs
under, and two runs of identical flags are not comparable if the server resolved
fused kernels differently. Then:

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

# The named groups of a block's header. Order is the rendering order; anything
# else found in an existing block is preserved after them, so a group added later
# by some other hand is not silently dropped.
GROUP_SERVER = "server flags:"
GROUP_REQUEST = "request params (llama-test):"
GROUP_LOAD = "load log:"
GROUP_ORDER = [GROUP_SERVER, GROUP_REQUEST, GROUP_LOAD]

# Request-body fields worth recording, in rendering order. llama-test reads them
# back out of the body it sent rather than from the variables it built the body
# from, so what appears here is what the server was actually asked for.
PARAM_ORDER = ["temperature", "top_p", "top_k", "max_tokens", "cache_prompt",
               "stream", "chat_template_kwargs"]

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
# the server's own load log
#
# llama-serve tees llama-server's output to a file and hands the path here. What
# the server says about the model it loaded is not derivable from the flags: -ngl
# is a request, the layer split is the answer; fused kernels are resolved per
# context against the device the layers landed on; an MTP head is either used or
# quietly ignored. Two runs with identical flags and different answers here are
# not the same measurement.
#
# Nothing is inferred. A field the log does not state is written "unavailable",
# because a plausible default here would be indistinguishable from an observation.
# ---------------------------------------------------------------------------
UNAVAILABLE = "unavailable"

# "0.03.336.929 I print_info: n_layer = 64" -> "print_info: n_layer = 64".
# The timestamp and level are per-run noise; the message is what is quoted.
LOG_PREFIX = re.compile(r"^\s*\d+(\.\d+)*\s+[A-Z]\s+")


def log_messages(path: Path) -> list[str]:
    try:
        raw = path.read_text(errors="replace")
    except OSError:
        return []
    return [LOG_PREFIX.sub("", line).rstrip() for line in raw.split("\n")]


def _first(msgs: list[str], pattern: str):
    """The first match of pattern, or None. First rather than last on purpose:
    with speculative decoding the server builds a second context and repeats much
    of this, and the target model's answer is the one being described."""
    rx = re.compile(pattern)
    for m in msgs:
        hit = rx.search(m)
        if hit:
            return hit
    return None


def _int(msgs: list[str], pattern: str):
    hit = _first(msgs, pattern)
    return int(hit.group(1)) if hit else None


def fused_ops(msgs: list[str]) -> tuple[str, list[str]]:
    """The verdict on the fused Gated Delta Net kernels, plus any warning verbatim.

    Matched on the "resolve_fused_ops:" prefix rather than on the probe's name, so
    a renamed or added probe still lands in the right bucket (llama.cpp build 10597
    resolves four families through the same function: flash attention, Gated Delta
    Net, Lightning Indexer, DeepSeek V4 HC). The disabled path logs a device
    mismatch and then "<probe> not supported, set to disabled"
    (src/llama-context.cpp:536-547); the enabled path logs "<probe> enabled".
    """
    lines = [m for m in msgs if m.startswith("resolve_fused_ops:")]
    gdn = [m for m in lines if "Gated Delta Net" in m and not m.endswith("support:")]
    if not gdn:
        return UNAVAILABLE, []

    enabled = [m for m in gdn if m.endswith(" enabled")]
    disabled = [m for m in gdn if "set to disabled" in m]
    if disabled and enabled:
        verdict = "mixed"
    elif disabled:
        verdict = "disabled"
    elif enabled:
        verdict = "enabled"
    else:
        verdict = UNAVAILABLE

    # Every warning of the group, not just the GDN ones: a mismatch reported
    # against another probe is the same device split and explains this one.
    warnings = [m for m in lines
                if "set to disabled" in m or "assigned to device" in m]
    return verdict, list(dict.fromkeys(warnings))


def unused_tensors(msgs: list[str]) -> str:
    """Tensors the loader found in the file and did not use.

    Collapsed to a count and the distinct names minus their last component, which
    is what makes a family legible ("blk.64.nextn.*" for an MTP head the loader
    ignored) without pasting one line per tensor.
    """
    names = [h.group(1) for h in
             (re.search(r"model has unused tensor (\S+)", m) for m in msgs) if h]
    if not names:
        return "none"
    prefixes = sorted({n.rsplit(".", 1)[0] for n in names})
    shown = ", ".join(prefixes[:6])
    if len(prefixes) > 6:
        shown += f", +{len(prefixes) - 6} more"
    return f"{len(names)} ({shown})"


def mtp_head(msgs: list[str]) -> str:
    """Whether the model carries a multi-token-prediction head and whether it ran.

    Presence is the GGUF key (Qwen names it "<arch>.nextn_predict_layers"); use is
    the server building a draft context for it. A head that is present and unused
    is worth saying out loud: it is loaded weights doing nothing, and it is the
    difference between a speculative run and a run that only asked for one.
    """
    hit = _first(msgs, r"\.nextn_predict_layers\s+\S*\s*=\s*(\d+)")
    present = hit is not None and int(hit.group(1)) > 0
    used = any("MTP draft context" in m for m in msgs) or \
        any("adding speculative implementation 'draft-mtp'" in m for m in msgs)
    if not present:
        # No key at all is not the same as a key saying zero, but neither is a head.
        return "absent" if any("nextn_predict_layers" in m for m in msgs) or \
            any(m.startswith("print_info:") for m in msgs) else UNAVAILABLE
    layers = int(hit.group(1))
    return (f"present (nextn_predict_layers = {layers}), "
            f"{'used by draft-mtp' if used else 'ignored'}")


def parse_server_log(path: Path | None, ngl: str | None) -> list[str] | None:
    """The "load log:" group, or None when there is no log to read.

    None means the run was recorded without one -- a hand-started server, or
    LLAMA_SERVER_LOG unset -- and the caller then leaves whatever the block already
    had in place. That is the same discipline as the rest of this file: no data
    writes nothing, rather than writing a row of "unavailable" over an older run's
    observations of the same configuration.
    """
    if not path or not path.exists():
        return None
    msgs = log_messages(path)
    if not msgs:
        return None

    n_layer = _int(msgs, r"print_info: n_layer\s+=\s+(\d+)")
    n_layer_all = _int(msgs, r"print_info: n_layer_all\s+=\s+(\d+)")
    layers = UNAVAILABLE
    if n_layer is not None:
        layers = str(n_layer)
        if n_layer_all is not None and n_layer_all != n_layer:
            layers += f" (all {n_layer_all})"

    # The split the loader reports, not the one -ngl asked for. -ngl is a ceiling:
    # it is clamped to what fits and counts the output layer, so the two disagree.
    split = _first(msgs, r"load_tensors: offloaded (\d+)/(\d+) layers to GPU")
    if split:
        gpu, total = int(split.group(1)), int(split.group(2))
        offload = f"{gpu}/{total} on GPU | cpu-resident: {total - gpu}"
    elif n_layer is not None and ngl and ngl.isdigit():
        # llama.cpp counts the output layer alongside the blocks, so its
        # denominator is one more than the block count it reports.
        total = (n_layer_all if n_layer_all is not None else n_layer) + 1
        gpu = min(int(ngl), total)
        offload = (f"{gpu}/{total} on GPU | cpu-resident: {total - gpu}"
                   " (derived from -ngl, not reported)")
    else:
        offload = UNAVAILABLE

    slots = _first(msgs, r"n_slots = (\d+), n_ctx_slot = (\d+), kv_unified = '(\w+)'")
    if slots:
        slot_line = (f"n_slots: {slots.group(1)} | n_ctx_slot: {slots.group(2)}"
                     f" | kv_unified: {slots.group(3)}")
    else:
        # The server's one-line summary is the preferred source; the context's own
        # lines are the fallback, and each field falls back independently.
        n_seq = _int(msgs, r"llama_context: n_seq_max\s+=\s+(\d+)")
        n_ctx_seq = _int(msgs, r"llama_context: n_ctx_seq\s+=\s+(\d+)")
        kvu = _first(msgs, r"llama_context: kv_unified\s+=\s+(\w+)")
        slot_line = (f"n_slots: {n_seq if n_seq is not None else UNAVAILABLE}"
                     f" | n_ctx_slot: {n_ctx_seq if n_ctx_seq is not None else UNAVAILABLE}"
                     f" | kv_unified: {kvu.group(1) if kvu else UNAVAILABLE}")

    bufs = []
    seen = set()
    for m in msgs:
        hit = re.search(r"load_tensors:\s+(\S+) model buffer size =\s+([\d.]+) MiB", m)
        if hit and hit.group(1) not in seen:
            seen.add(hit.group(1))
            bufs.append(f"{hit.group(1)} {hit.group(2)} MiB")

    verdict, warnings = fused_ops(msgs)
    deprecated = list(dict.fromkeys(m for m in msgs if "DEPRECATED" in m))

    out = [
        f"  layers: {layers} | offloaded: {offload}",
        f"  {slot_line}",
        f"  model buffers: {' | '.join(bufs) if bufs else UNAVAILABLE}",
        f"  fused_gdn: {verdict}",
        f"  mtp head: {mtp_head(msgs)}",
        f"  unused tensors: {unused_tensors(msgs)}",
    ]
    # Warnings verbatim, one per line, because the wording is the evidence.
    out += [f"  warning: {w}" for w in warnings]
    out += [f"  {d}" for d in deprecated]
    return out


def render_params(requests: list[dict]) -> list[str] | None:
    """The "request params (llama-test):" group, or None when the run served none.

    Distinct parameter sets are listed separately with the number of requests that
    used each: a run that changed max_tokens halfway through did not measure one
    thing, and averaging its requests without saying so would hide that.
    """
    counts: dict[str, int] = {}
    for rec in requests:
        params = rec.get("params")
        if not isinstance(params, dict) or not params:
            continue
        parts = []
        for key in PARAM_ORDER:
            if key not in params:
                continue
            # json.dumps rather than str: these are the body's values, so they
            # should read as they were sent (false, not False).
            parts.append(f"{key}: {json.dumps(params[key], separators=(',', ':'))}")
        for key in sorted(k for k in params if k not in PARAM_ORDER):
            parts.append(f"{key}: {json.dumps(params[key], separators=(',', ':'))}")
        line = " | ".join(parts)
        counts[line] = counts.get(line, 0) + 1
    if not counts:
        return None
    if len(counts) == 1:
        return [f"  {next(iter(counts))}"]
    return [f"  x{n}: {line}" for line, n in counts.items()]


# ---------------------------------------------------------------------------
# log file structure
# ---------------------------------------------------------------------------
def split_groups(lines: list[str]) -> tuple[list[str], dict[str, list[str]]]:
    """A block's header lines as (ungrouped, {group header: indented lines}).

    A group header is an unindented line ending in a colon with nothing after it.
    Ungrouped lines are how blocks written before the grouping look; they are kept
    as they are unless the block is merged into, so old logs stay readable.
    """
    pre: list[str] = []
    groups: dict[str, list[str]] = {}
    current: str | None = None
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if not line[:1].isspace() and stripped.endswith(":"):
            current = stripped
            groups.setdefault(current, [])
            continue
        (groups[current] if current is not None else pre).append(line)
    return pre, groups


def join_groups(pre: list[str], groups: dict[str, list[str]]) -> list[str]:
    out = list(pre)
    for name in GROUP_ORDER:
        if groups.get(name):
            out += [name] + groups[name]
    for name, lines in groups.items():
        if name not in GROUP_ORDER and lines:
            out += [name] + lines
    return out


def config_value(lines: list[str], key: str) -> str | None:
    """Read one "key: value" out of the pipe-separated configuration lines."""
    for line in lines:
        hit = re.search(rf"(?:^|\| ){re.escape(key)}: (.*?)(?: \||$)", line.strip())
        if hit:
            return hit.group(1).strip()
    return None


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

    # What was actually asked for, as read back from the request body. Malformed
    # or absent means the request is still recorded, just without its parameters.
    try:
        params = json.loads(args.params) if args.params else {}
    except json.JSONDecodeError:
        params = {}

    record = {"timestamp": args.timestamp, "model": args.model,
              "prompt": args.prompt, "wall_ms": args.wall_ms,
              "params": params if isinstance(params, dict) else {},
              "timings": timings}
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
        block = Block(payload["config_id"], [])
        blocks.append(block)

    # The flags are the block's identity, so rewriting them changes nothing; the
    # other two groups are this run's observations and do replace the previous
    # run's. Each is left alone when this run has nothing to say: a run that served
    # no llama-test request, or was recorded without the server's output, should
    # not erase what an earlier run of the same configuration observed.
    _, groups = split_groups(block.config_lines)
    groups[GROUP_SERVER] = ["  " + line.strip() for line in payload["config_lines"]]
    params = render_params(requests)
    if params:
        groups[GROUP_REQUEST] = params
    load = parse_server_log(_path(payload.get("server_log")),
                            config_value(payload["config_lines"], "ngl"))
    if load:
        groups[GROUP_LOAD] = load
    # pre is dropped rather than carried: a block written before the grouping has
    # its flat lines re-rendered under "server flags:", which is where they belong.
    block.config_lines = join_groups([], groups)

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
    p.add_argument("--params", default="", help="the request body's parameters, JSON")
    p.set_defaults(func=cmd_request)

    p = sub.add_parser("merge", help="fold a finished run into its log file")
    p.set_defaults(func=cmd_merge)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
