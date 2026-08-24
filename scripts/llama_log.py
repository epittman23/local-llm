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

# Appended to, never reordered: a row written under an older layout keeps every
# cell it has under the heading it was written for, and render_table pads the
# missing tail. Percentiles sit beside the means rather than replacing them
# because a mean over a run that was idle between requests is not the busy figure
# and not the idle one; p50 says which of the two the run mostly was.
GPU_SUMMARY_COLUMNS = [
    "started (UTC)", "duration", "samples", "build", "temp avg/max (C)",
    "util avg/max (%)", "mem.used avg/max (MiB)", "power avg/max (W)",
    "sm avg (MHz)",
    "util p50/p95 (%)", "util active avg (%)", "power p50/p95 (W)",
    "sm p50/p95/max (MHz)", "vram headroom (MiB)", "throttle",
]

# The raw llama.cpp timings field names are kept as headers so a row can be traced
# back to the response it came from without a translation table.
REQUEST_COLUMNS = [
    "timestamp (UTC)", "prompt", "model", "cache_n", "prompt_n", "prompt_ms",
    "prompt_per_token_ms", "prompt_per_second", "predicted_n", "predicted_ms",
    "predicted_per_token_ms", "predicted_per_second", "draft_n",
    "draft_n_accepted", "wall_ms", "acceptance", "mean_len",
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
    "e2e s total", "e2e s avg", "acceptance", "mean_len",
]

# Rows written before 2026-08-23 have these twelve cells and blended cold with warm.
# Mapping them into the columns above keeps every recorded number under a heading
# that still means what it meant, and leaves the cells that format never held empty.
LEGACY_REQUEST_SUMMARY = {0: 0, 1: 1, 2: 4, 3: 5, 4: 6, 5: 7,
                          6: 12, 7: 13, 8: 14, 9: 15, 10: 16, 11: 17}

SERVER_SUMMARY_COLUMNS = [
    "started (UTC)", "prompt tok", "cached tok", "prompt s", "prompt t/s",
    "output tok", "output s", "output t/s", "draft tok", "draft accepted",
    "drafts", "acceptance", "mean_len",
]

# Counter names scraped from /metrics, in the order the delta row uses them.
SERVER_COUNTERS = [
    "prompt_tokens_total", "prompt_tokens_cached_total", "prompt_seconds_total",
    "tokens_predicted_total", "tokens_predicted_seconds_total",
    "spec_decode_num_draft_tokens_total", "spec_decode_num_accepted_tokens_total",
    "spec_decode_num_drafts_total",
]


# ---------------------------------------------------------------------------
# markdown tables
# ---------------------------------------------------------------------------
def is_number(cell: str) -> bool:
    """A cell that should be right-aligned: a number, a ratio, or empty."""
    return cell == "" or bool(re.fullmatch(r"\d+(\.\d+)?(/\d+(\.\d+)?)*\*?", cell))


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


def percentile(values: list[float], p: float) -> float:
    """Linear interpolation between the closest ranks (numpy's default method).

    Sampling is every LLAMA_VRAM_INTERVAL seconds, so a run has tens of samples,
    not thousands: p95 of 18 samples is nearly the maximum, and is reported as
    such rather than pretending to a precision the sample count cannot support.
    """
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    k = (len(ordered) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)


# nvmlClocksThrottleReasons, the bits nvidia-smi reports in
# clocks_throttle_reasons.active. Only the documented ones are decoded; anything
# else is printed as hex rather than guessed at.
#
# GpuIdle is not a fault: it is set whenever the GPU has nothing to do, which on
# this workload is most of a run, since generation is bound by CPU-resident
# weights. SwPowerCap and the thermal bits are the ones that mean a measurement
# was taken under a limit and is not comparable with one that was not.
THROTTLE_BITS = [
    (0x0000000000000001, "GpuIdle"),
    (0x0000000000000002, "AppClocksSetting"),
    (0x0000000000000004, "SwPowerCap"),
    (0x0000000000000008, "HwSlowdown"),
    (0x0000000000000010, "SyncBoost"),
    (0x0000000000000020, "SwThermalSlowdown"),
    (0x0000000000000040, "HwThermalSlowdown"),
    (0x0000000000000080, "HwPowerBrakeSlowdown"),
    (0x0000000000000100, "DisplayClockSetting"),
]


def throttle_reasons(samples: list[dict]) -> str:
    """The distinct set of reasons seen across the run, not per sample.

    Per sample it would be a column of near-identical hex; what a reader needs is
    whether the run ever ran under a cap. Empty when no sample carried the field,
    which is how runs recorded before 2026-08-23 read.
    """
    masks = [s["throttle"] for s in samples if s.get("throttle") is not None]
    if not masks:
        return ""
    seen: list[str] = []
    for mask in masks:
        rest = mask
        for bit, name in THROTTLE_BITS:
            if mask & bit:
                rest &= ~bit
                if name not in seen:
                    seen.append(name)
        if rest and f"0x{rest:x}" not in seen:
            seen.append(f"0x{rest:x}")
    return ", ".join(seen) if seen else "none"


def vram_headroom(samples: list[dict]) -> int | None:
    """MiB still free at the run's peak usage. The number -ngl is tuned against."""
    usable = [s for s in samples if s.get("mem_total")]
    if not usable:
        return None
    return min(s["mem_total"] - s["mem_used"] for s in usable)


def gpu_summary_row(samples: list[dict], started: str, duration: str,
                    build: str) -> list[str]:
    def avg_max(key: str, digits: int = 0) -> str:
        vals = [s[key] for s in samples]
        return f"{mean(vals):.{digits}f}/{max(vals):.{digits}f}"

    def pcts(key: str, digits: int = 0, with_max: bool = False) -> str:
        vals = [s[key] for s in samples]
        out = f"{percentile(vals, 0.50):.{digits}f}/{percentile(vals, 0.95):.{digits}f}"
        return (out + f"/{max(vals):.{digits}f}") if with_max else out

    # Utilization averaged over the samples that saw work. The plain average is
    # dominated by the idle gaps between requests -- a run can show 14% mean
    # utilization and still have been at 95% whenever it was answering.
    active = [s["util"] for s in samples if s["util"] > 0]
    headroom = vram_headroom(samples)

    return [started, duration, str(len(samples)), build,
            avg_max("temp"), avg_max("util"), avg_max("mem_used"),
            avg_max("power", 1), f"{mean([s['sm'] for s in samples]):.0f}",
            pcts("util"), f"{mean(active):.0f}" if active else "0",
            pcts("power", 1), pcts("sm", 0, with_max=True),
            "" if headroom is None else str(headroom),
            throttle_reasons(samples)]


def draft_depth(config_lines: list[str]) -> int | None:
    """--spec-draft-n-max from the serving flags, or None when not speculating.

    Needed because a request's timings carry draft_n and draft_n_accepted but not
    the number of verification steps (build 10597 keeps n_draft_verif_steps in
    server_slot_stats and exposes it only through /metrics, not through the
    per-request timings: tools/server/server-common.cpp:81-84).
    """
    spec = next((line.split(":", 1)[1] for line in config_lines
                 if line.strip().startswith("speculative:")), "")
    hit = re.search(r"--spec-draft-n-max\s+(\d+)", spec)
    return int(hit.group(1)) if hit else None


def acceptance(drafted: float, accepted: float) -> str:
    """Accepted fraction of the tokens the draft head proposed."""
    return f"{accepted / drafted:.3f}" if drafted else ""


def mean_len(drafted: float, accepted: float, n_max: int | None) -> str:
    """Mean accepted length per verification step: llama.cpp's 1 + accepted/steps.

    Derived, not reported: steps are inferred as drafted/n_max, which is exact
    while every step drafts the full depth. That holds for the profiles here
    (draft-mtp with p_min = 0 never returns a short draft), and is why the number
    is worth having; it stops being exact if a future profile sets --spec-p-min,
    and the /metrics row beside it carries the server's own exact figure.
    """
    if not drafted or not n_max:
        return ""
    steps = drafted / n_max
    return f"{1 + accepted / steps:.3f}" if steps else ""


def is_cold(rec: dict) -> bool:
    """A prefill that reused nothing. cache_n is llama.cpp's count of prompt tokens
    taken from the cache; absent means the server did not report one, which only
    happens on builds without the field, so it is read as no reuse."""
    return not (rec.get("timings", {}).get("cache_n") or 0)


def request_summary_row(requests: list[dict], started: str,
                        n_max: int | None = None) -> list[str]:
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

    drafted, accepted = sum(field(requests, "draft_n")), \
        sum(field(requests, "draft_n_accepted"))

    return [started, str(len(requests)), str(len(cold)), str(len(warm)),
            toks(c_tok), toks(c_tok, avg=True),
            secs(c_ms), secs(c_ms, avg=True), cold_rate,
            toks(w_cached, avg=True), toks(w_tok, avg=True), secs(w_ms, avg=True),
            toks(out_tok), toks(out_tok, avg=True),
            secs(out_ms), secs(out_ms, avg=True),
            secs(e2e_ms), secs(e2e_ms, avg=True),
            acceptance(drafted, accepted), mean_len(drafted, accepted, n_max)]


def request_row(rec: dict, n_max: int | None = None) -> list[str]:
    t = rec.get("timings", {})

    def num(key: str, digits: int = 2) -> str:
        v = t.get(key)
        if v is None:
            return "n/a"
        return f"{v:.{digits}f}" if isinstance(v, float) else str(v)

    wall = rec.get("wall_ms")
    # Blank rather than zero when nothing was drafted: a run without speculative
    # decoding has no acceptance rate, and 0.000 would read as a bad one.
    drafted, accepted = t.get("draft_n") or 0, t.get("draft_n_accepted") or 0
    return [rec.get("timestamp", "?"), rec.get("prompt", "?"), rec.get("model", "?"),
            num("cache_n"), num("prompt_n"), num("prompt_ms"),
            num("prompt_per_token_ms"), num("prompt_per_second"),
            num("predicted_n"), num("predicted_ms"),
            num("predicted_per_token_ms"), num("predicted_per_second"),
            num("draft_n"), num("draft_n_accepted"),
            f"{wall:.0f}" if isinstance(wall, (int, float)) else "n/a",
            acceptance(drafted, accepted), mean_len(drafted, accepted, n_max)]


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
    # Unlike the llama-test table, mean_len here is the server's own arithmetic:
    # spec_decode_num_drafts_total counts verification steps
    # (tools/server/server-task.cpp:1560-1565), so nothing has to be inferred.
    drafted = delta["spec_decode_num_draft_tokens_total"]
    accepted = delta["spec_decode_num_accepted_tokens_total"]
    steps = delta["spec_decode_num_drafts_total"]
    return [started, f"{p_tok:.0f}", f"{delta['prompt_tokens_cached_total']:.0f}",
            f"{p_sec:.1f}", rate(p_tok, p_sec),
            f"{o_tok:.0f}", f"{o_sec:.1f}", rate(o_tok, o_sec),
            f"{drafted:.0f}", f"{accepted:.0f}",
            f"{steps:.0f}" if steps else "",
            acceptance(drafted, accepted),
            f"{1 + accepted / steps:.3f}" if steps else ""]


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


def parse_server_log(path: Path | None, ngl: str | None,
                     headroom: int | None = None) -> list[str] | None:
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
    gpu_layers = None
    split = _first(msgs, r"load_tensors: offloaded (\d+)/(\d+) layers to GPU")
    if split:
        gpu, total = int(split.group(1)), int(split.group(2))
        gpu_layers = gpu
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
    cuda_mib = None
    for m in msgs:
        hit = re.search(r"load_tensors:\s+(\S+) model buffer size =\s+([\d.]+) MiB", m)
        if hit and hit.group(1) not in seen:
            seen.add(hit.group(1))
            bufs.append(f"{hit.group(1)} {hit.group(2)} MiB")
            if hit.group(1).startswith("CUDA") and cuda_mib is None:
                cuda_mib = float(hit.group(2))

    # What the headroom is worth in the unit -ngl is tuned in. The per-layer cost
    # is this model's own GPU-resident weights divided by the layers that got
    # there, so it needs no assumption about the file's layout -- but it is still
    # an average: the output head and the last block are not the size of a
    # repeating block, and the KV cache grows with them.
    if headroom is None:
        head_line = f"vram headroom: {UNAVAILABLE}"
    else:
        head_line = f"vram headroom: {headroom} MiB free at peak"
        if cuda_mib and gpu_layers:
            per_layer = cuda_mib / gpu_layers
            head_line += (f" | ~{headroom / per_layer:.1f} more layers"
                          f" at {per_layer:.1f} MiB/layer avg"
                          f" ({cuda_mib:.2f} MiB / {gpu_layers} layers)")

    verdict, warnings = fused_ops(msgs)
    deprecated = list(dict.fromkeys(m for m in msgs if "DEPRECATED" in m))

    out = [
        f"  layers: {layers} | offloaded: {offload}",
        f"  {slot_line}",
        f"  model buffers: {' | '.join(bufs) if bufs else UNAVAILABLE}",
        f"  {head_line}",
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
# MiB of VRAM that must stay free at a run's peak before the block says so. The
# cliff is one layer wide on this hardware: the run below the threshold still
# completed, and the next -ngl will not.
HEADROOM_WARN_MIB = int(os.environ.get("LLAMA_VRAM_HEADROOM_MIB", "300") or 300)


def headroom_warnings(rows: list[list[str]]) -> list[str]:
    """Runs of this configuration that finished close to full VRAM.

    Read back out of the rendered table rather than kept as state, so a block
    warns about every run it holds, including ones merged before the threshold
    was what it is now. Rows without the column -- anything recorded before
    2026-08-23 -- are silently skipped rather than assumed safe.
    """
    try:
        col = GPU_SUMMARY_COLUMNS.index("vram headroom (MiB)")
    except ValueError:                                  # pragma: no cover
        return []
    out = []
    for row in rows:
        if len(row) <= col or not row[col].strip().isdigit():
            continue
        free = int(row[col].strip())
        if free < HEADROOM_WARN_MIB:
            out.append(f"> warning: run {row[0]} peaked at {free} MiB of free "
                       f"VRAM, under the {HEADROOM_WARN_MIB} MiB threshold "
                       f"(LLAMA_VRAM_HEADROOM_MIB).")
    return out


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
        warnings = headroom_warnings(self.gpu_summary)
        if warnings:
            out += [""] + warnings
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
                  requests: list[dict], n_max: int | None = None) -> list[str]:
    out = [f"### latest run - {started} (build {build})"]
    out += render_table(GPU_SAMPLE_COLUMNS,
                        [[s["timestamp"], s["temp"], s["util"], s["mem_used"],
                          s["mem_total"], s["power"], s["sm"]] for s in samples])
    if requests:
        out += ["", f"#### requests - {started}"]
        out += render_table(REQUEST_COLUMNS,
                            [request_row(r, n_max) for r in requests])
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
            sample = {"timestamp": f[0], "temp": int(f[1]), "util": int(f[2]),
                      "mem_used": int(f[3]), "mem_total": int(f[4]),
                      "power": float(f[5]), "sm": int(f[6]), "throttle": None}
        except ValueError:
            continue
        # The throttle bitmask is the eighth field, added 2026-08-23. Samples
        # written before it have seven, and are read as before.
        if len(f) > 7:
            try:
                sample["throttle"] = int(f[7].strip(), 16)
            except ValueError:
                pass
        samples.append(sample)
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
# cross-configuration comparison
# ---------------------------------------------------------------------------
# Everything below is derived from the blocks in the file and is regenerated in
# full on every merge, so it is stripped before the header is re-rendered rather
# than parsed back. Nothing here is a measurement of its own: a cell is empty
# when the block it came from has no run that measured it.
COMPARISON_HEADING = "## comparison"

COMPARISON_COLUMNS = [
    "config-id", "ngl", "parallel", "spec", "-ot", "fused_gdn",
    "cold prefill t/s", "gen t/s", "acceptance", "vram max (MiB)",
    "headroom (MiB)", "runs",
]

DERIVED_COLUMNS = [
    "config-id", "cpu-resident layers", "ms/token", "cpu bandwidth (GiB/s)",
]

# A figure taken from /metrics rather than from llama-test: it covers every
# client of the server, including Open WebUI, and its prompts are whatever was
# typed. Marked so a row that was measured on the version-controlled prompt is
# never silently compared against one that was not.
METRICS_MARK = "*"


def _cell(row: list[str], columns: list[str], name: str) -> str:
    """One named cell of a summary row, or "" when the row predates the column."""
    try:
        i = columns.index(name)
    except ValueError:                                  # pragma: no cover
        return ""
    return row[i].strip() if len(row) > i else ""


def _num(cell: str) -> float | None:
    try:
        return float(cell.rstrip(METRICS_MARK))
    except (TypeError, ValueError):
        return None


def short_spec(value: str | None) -> str:
    """"--spec-type draft-mtp --spec-draft-n-max 2" -> "draft-mtp n=2"."""
    if not value or value.strip() in ("off", "n/a", ""):
        return "off"
    kind = re.search(r"--spec-type\s+(\S+)", value)
    depth = re.search(r"--spec-draft-n-max\s+(\d+)", value)
    out = kind.group(1) if kind else value.strip()
    return out + (f" n={depth.group(1)}" if depth else "")


def short_ot(value: str | None) -> str:
    """The first -ot pattern plus a count of the rest; the full text is in the block."""
    if not value or value.strip() in ("n/a", ""):
        return "none"
    patterns = [p for p in value.split(",") if p.strip()]
    head = patterns[0].strip()
    if len(head) > 22:
        head = head[:21] + "\u2026"
    return head + (f" +{len(patterns) - 1}" if len(patterns) > 1 else "")


def block_facts(block: "Block") -> dict:
    """What one configuration's most recent run says, for the comparison tables.

    The most recent run, not an average over the block's history: earlier runs of
    a configuration may predate a llama.cpp rebuild or a machine that was busy
    with something else, and averaging them would hide exactly the change being
    looked for.
    """
    _, groups = split_groups(block.config_lines)
    flags = groups.get(GROUP_SERVER) or block.config_lines
    load = groups.get(GROUP_LOAD, [])
    gpu = block.gpu_summary[-1] if block.gpu_summary else []
    req = block.request_summary[-1] if block.request_summary else []
    srv = block.server_summary[-1] if block.server_summary else []

    prefill = _cell(req, REQUEST_SUMMARY_COLUMNS, "cold prompt t/s")
    if not prefill and srv:
        prefill = _cell(srv, SERVER_SUMMARY_COLUMNS, "prompt t/s")
        prefill += METRICS_MARK if prefill else ""

    # Generation rate from the llama-test rows is output tokens over the time
    # llama.cpp spent predicting them -- not wall clock, which includes prefill.
    out_tok = _num(_cell(req, REQUEST_SUMMARY_COLUMNS, "output tok total"))
    out_s = _num(_cell(req, REQUEST_SUMMARY_COLUMNS, "output s total"))
    gen = f"{out_tok / out_s:.2f}" if out_tok and out_s else ""
    if not gen and srv:
        gen = _cell(srv, SERVER_SUMMARY_COLUMNS, "output t/s")
        gen += METRICS_MARK if gen else ""

    accept = _cell(req, REQUEST_SUMMARY_COLUMNS, "acceptance")
    if not accept and srv:
        accept = _cell(srv, SERVER_SUMMARY_COLUMNS, "acceptance")
        accept += METRICS_MARK if accept else ""

    vram = _cell(gpu, GPU_SUMMARY_COLUMNS, "mem.used avg/max (MiB)")
    fused = next((line.split(":", 1)[1].strip() for line in load
                  if line.strip().startswith("fused_gdn:")), "")
    resident = next((m.group(1) for m in
                     (re.search(r"cpu-resident: (\d+)", line) for line in load) if m), "")

    return {
        "config_id": block.config_id,
        "ngl": config_value(flags, "ngl") or "",
        "parallel": config_value(flags, "parallel") or "",
        "spec": short_spec(config_value(flags, "speculative")),
        "ot": short_ot(config_value(flags, "override-tensors")),
        "arch": config_value(flags, "arch") or "",
        "fused": fused,
        "prefill": prefill,
        "gen": gen,
        "accept": accept,
        "vram_max": vram.split("/")[-1] if vram else "",
        "headroom": _cell(gpu, GPU_SUMMARY_COLUMNS, "vram headroom (MiB)"),
        "runs": str(len(block.gpu_summary)),
        "cpu_layers": resident,
        "cpu_mib": cpu_buffer_mib(load),
        "flags": [line.strip() for line in flags],
    }


def cpu_buffer_mib(load: list[str]) -> float | None:
    """MiB of model weights the loader left in system RAM, per the load log."""
    for line in load:
        if not line.strip().startswith("model buffers:"):
            continue
        hit = re.search(r"CPU\S*\s+([\d.]+) MiB", line)
        return float(hit.group(1)) if hit else None
    return None


def derived_row(facts: dict) -> list[str] | None:
    """Per-token cost and what it implies about memory bandwidth.

    ms/token is the reciprocal of the generation rate. The bandwidth figure is
    the CPU-resident weights divided by that time: on a dense model every
    resident weight is read once per token, so it is close to the real effective
    bandwidth and is the number that says whether a configuration is bandwidth
    bound. On an MoE it is not computed at all -- only the routed experts are
    read per token, so dividing by all of them would produce a figure several
    times below the truth and invite the wrong conclusion.
    """
    gen = _num(facts["gen"])
    if not gen:
        return None
    ms = 1000.0 / gen
    band = ""
    if facts["arch"] == "moe":
        band = "n/a (moe)"
    elif facts["cpu_mib"]:
        band = f"{(facts['cpu_mib'] / 1024) / (ms / 1000):.1f}"
    return [facts["config_id"], facts["cpu_layers"], f"{ms:.1f}", band]


def ngl_family(flags: list[str]) -> str:
    """The serving flags with the layer count removed: configs that differ only in -ngl."""
    return "\n".join(re.sub(r"ngl: \S+", "ngl: *", line) for line in flags)


def ngl_fit(rows: list[dict]) -> list[str]:
    """Least squares of ms/token against CPU-resident layers, per -ngl family.

    Reported as slope and intercept, never as ms_per_token / cpu_resident_layers:
    that ratio charges the whole per-token cost to the resident layers and reads
    as a much larger per-layer penalty than moving one layer actually costs. The
    intercept is the part that does not move with -ngl (the GPU-resident layers,
    sampling, the draft head), and it is most of the time on this hardware.
    """
    families: dict[str, list[tuple[float, float]]] = {}
    for facts in rows:
        gen, layers = _num(facts["gen"]), _num(facts["cpu_layers"])
        if gen and layers is not None:
            families.setdefault(ngl_family(facts["flags"]), []).append(
                (layers, 1000.0 / gen))

    out: list[str] = []
    for points in families.values():
        xs = sorted({x for x, _ in points})
        if len(points) < 2 or len(xs) < 2:
            continue                      # a line through one x is not a fit
        n = len(points)
        mx = sum(x for x, _ in points) / n
        my = sum(y for _, y in points) / n
        denom = sum((x - mx) ** 2 for x, _ in points)
        slope = sum((x - mx) * (y - my) for x, y in points) / denom
        intercept = my - slope * mx
        out.append(f"> ms/token vs cpu-resident layers over {n} configurations "
                   f"({min(xs):.0f} to {max(xs):.0f} layers): {slope:.1f} ms per "
                   f"layer + {intercept:.0f} ms fixed.")
    return out


def render_comparison(blocks: list["Block"]) -> list[str]:
    """The whole-file summary: one row per configuration, best generation first."""
    facts = [block_facts(b) for b in blocks]
    rows = [[f["config_id"], f["ngl"], f["parallel"], f["spec"], f["ot"],
             f["fused"], f["prefill"], f["gen"], f["accept"], f["vram_max"],
             f["headroom"], f["runs"]] for f in facts]
    # Unmeasured configurations sort last rather than as zero: they are unknown,
    # not slow.
    rows.sort(key=lambda r: _num(r[COMPARISON_COLUMNS.index("gen t/s")]) or -1.0,
              reverse=True)

    out = [COMPARISON_HEADING, ""]
    out += render_table(COMPARISON_COLUMNS, rows)
    if any(METRICS_MARK in c for r in rows for c in r):
        out += ["", f"> {METRICS_MARK} from /metrics (every client of the server, "
                    "whatever prompts they sent), not from llama-test."]

    derived = [row for row in (derived_row(f) for f in facts) if row]
    if derived:
        out += ["", "### derived", ""]
        out += render_table(DERIVED_COLUMNS, derived)
    fit = ngl_fit(facts)
    if fit:
        out += [""] + fit
    return out


def strip_comparison(header: list[str]) -> list[str]:
    """Drop a previously rendered comparison; it is derived, so it is rebuilt."""
    if COMPARISON_HEADING not in header:
        return header
    return header[:header.index(COMPARISON_HEADING)]


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
        header = strip_comparison(header)
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
                            config_value(payload["config_lines"], "ngl"),
                            vram_headroom(samples))
    if load:
        groups[GROUP_LOAD] = load
    # pre is dropped rather than carried: a block written before the grouping has
    # its flat lines re-rendered under "server flags:", which is where they belong.
    block.config_lines = join_groups([], groups)

    n_max = draft_depth(payload["config_lines"])
    block.gpu_summary.append(
        gpu_summary_row(samples, started, payload["duration"], build))
    if requests:
        block.request_summary.append(request_summary_row(requests, started, n_max))
    if delta:
        block.server_summary.append(server_summary_row(delta, started))
    block.latest = render_latest(started, build, samples, requests, n_max)

    # Header notes sort below the model/quant title lines and survive re-parsing,
    # which strips the blank line between them.
    notes = [h for h in header if h.startswith("note ")]
    notes += [n for n in HEADER_NOTES if n not in notes]
    out = [h for h in header if not h.startswith("note ")]
    if notes:
        out += [""] + notes
    out += [""] + render_comparison(blocks)
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
