#!/usr/bin/env python3
"""llama_stats.py - the statistics and the parsing, with nothing left that writes.

Part of https://github.com/epittman23/local-llm

This is what survives of llama_log.py once logs/llama.db holds the data. What it
lost was everything that read a rendered markdown table back: parse_log,
parse_block, Block, the group split/join, the retention rules, the comparison
re-render, and the positional remap for rows written under an older column
layout. Those existed because the store *was* the rendering, so a column could
only ever be appended and every write had to re-render the file.

What it keeps is the part that was never about storage: the arithmetic, and the
parsers for text this repo does not control (llama.cpp's server log, and the
configuration lines the shell fingerprints). Those are unchanged on purpose --
reimplementing percentile() in SQL, or the throttle-bit decoding, would silently
move every recorded number. The rows moved; the statistics did not.

render_table() and align_tables() are still here and are now **terminal output
only**, for `--format markdown` when a measured table is being pasted into
README.md as the maintenance policy requires. Nothing in this repo reads their
output back.

Renamed from llama_log.py because a module called llama_log that no longer
writes a log is a trap for the next reader.

STDLIB ONLY: imported by llama_db.py, which the telemetry recorder runs under
bare python3.
"""

from __future__ import annotations

import os
import re

# ---------------------------------------------------------------------------
# markdown tables -- output only, never parsed back
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
    """Re-pad every markdown table in a block of text before printing it."""
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
#
# Unchanged from llama_log.py apart from the key names, which now match the
# gpu_sample columns. Deliberately still Python and not SQL: SQLite has no
# percentile function, and an approximation would change numbers that have
# already been recorded and quoted in README.md.
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
    whether the run ever ran under a cap.
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
    usable = [s for s in samples if s.get("mem_total_mib")]
    if not usable:
        return None
    return min(s["mem_total_mib"] - s["mem_used_mib"] for s in usable)


# MiB of VRAM that must stay free at a run's peak before a report says so. The
# cliff is one layer wide on this hardware: the run below the threshold still
# completed, and the next -ngl will not.
HEADROOM_WARN_MIB = int(os.environ.get("LLAMA_VRAM_HEADROOM_MIB", "300") or 300)


def gpu_stats(samples: list[dict]) -> dict:
    """Every GPU figure a run is summarised by, derived from the stored samples.

    Derived on read rather than computed once and recorded. The previous store
    kept only this summary and threw the samples away, so an error here was
    permanent; now it is a re-run of a query.

    Percentiles are here because the mean was misleading in a specific way:
    sampling covers the whole life of the server, so a run that spent 32 s of 92 s
    serving logged util avg/max = 1/9 and read as idle. `util_active_avg` -- the
    mean over samples that saw work -- is the number to compare between
    configurations; `util_avg` still measures how much of a session was spent
    waiting for a prompt, which is a different and also useful thing.
    """
    if not samples:
        return {}

    def col(key: str) -> list[float]:
        return [s[key] for s in samples if s.get(key) is not None]

    active = [s["util_pct"] for s in samples if (s.get("util_pct") or 0) > 0]
    util, power, sm = col("util_pct"), col("power_w"), col("sm_mhz")
    return {
        "samples": len(samples),
        "temp_avg": mean(col("temp_c")), "temp_max": max(col("temp_c") or [0]),
        "util_avg": mean(util), "util_max": max(util or [0]),
        "util_p50": percentile(util, 0.50), "util_p95": percentile(util, 0.95),
        "util_active_avg": mean(active),
        "mem_avg": mean(col("mem_used_mib")),
        "mem_max": max(col("mem_used_mib") or [0]),
        "power_avg": mean(power), "power_max": max(power or [0]),
        "power_p50": percentile(power, 0.50),
        "power_p95": percentile(power, 0.95),
        "sm_avg": mean(sm), "sm_p50": percentile(sm, 0.50),
        "sm_p95": percentile(sm, 0.95), "sm_max": max(sm or [0]),
        "vram_headroom_mib": vram_headroom(samples),
        "throttle": throttle_reasons(samples),
    }


def headroom_warning(run_label: str, headroom: int | None) -> str | None:
    """Said out loud because the whole point of the -ngl sweep on this card is
    finding the layer count just below the spill cliff, and a run that fit with
    40 MiB to spare is a result that will not reproduce after a context change."""
    if headroom is None or headroom >= HEADROOM_WARN_MIB:
        return None
    return (f"run {run_label} peaked at {headroom} MiB of free VRAM, under the "
            f"{HEADROOM_WARN_MIB} MiB threshold (LLAMA_VRAM_HEADROOM_MIB).")


# ---------------------------------------------------------------------------
# speculative decoding
# ---------------------------------------------------------------------------
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
    """Accepted fraction of the tokens the draft head proposed.

    Blank rather than zero when nothing was drafted, so a non-speculative
    configuration is visibly not a 0% one.
    """
    return f"{accepted / drafted:.3f}" if drafted else ""


def mean_len(drafted: float, accepted: float, n_max: int | None) -> str:
    """Mean accepted length per verification step: llama.cpp's 1 + accepted/steps.

    Derived, not reported: steps are inferred as drafted/n_max, which is exact
    while every step drafts the full depth. That holds for the profiles here
    (draft-mtp with p_min = 0 never returns a short draft), and is why the number
    is worth having; it stops being exact if a future profile sets --spec-p-min,
    and the /metrics figure beside it carries the server's own exact count.
    """
    if not drafted or not n_max:
        return ""
    steps = drafted / n_max
    return f"{1 + accepted / steps:.3f}" if steps else ""


def is_cold(rec: dict) -> bool:
    """A prefill that reused nothing. cache_n is llama.cpp's count of prompt tokens
    taken from the cache; absent means the server did not report one, which only
    happens on builds without the field, so it is read as no reuse."""
    timings = rec.get("timings") or {}
    return not (rec.get("cache_n") or timings.get("cache_n") or 0)


# ---------------------------------------------------------------------------
# the configuration lines
#
# scripts/llama-vram-log.sh builds six lines from the profile and hashes them
# into the config-id. They are stored verbatim in config.config_text because that
# text is what the hash covers; these parsers fill the typed columns beside it so
# a query can filter on ngl without a LIKE.
# ---------------------------------------------------------------------------
def config_value(lines: list[str], key: str) -> str | None:
    """Read one "key: value" out of the pipe-separated configuration lines."""
    for line in lines:
        hit = re.search(rf"(?:^|\| ){re.escape(key)}: (.*?)(?: \||$)", line.strip())
        if hit:
            return hit.group(1).strip()
    return None


def _as_int(value: str | None) -> int | None:
    if not value:
        return None
    hit = re.search(r"-?\d+", value)
    return int(hit.group(0)) if hit else None


def _clean(value: str | None) -> str | None:
    """"n/a" and "off" are recorded as themselves, not as NULL.

    The distinction matters: a configuration that explicitly ran without
    speculative decoding is not one whose speculative setting went unrecorded,
    and the comparison prints them differently.
    """
    if value is None:
        return None
    value = value.strip()
    return value or None


def parse_config_text(text: str) -> dict:
    """The six fingerprinted lines, as typed columns.

    Never the other direction: config_text is authoritative and these are read
    out of it, so a column cannot disagree with the hash that names the row.
    """
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    spec = _clean(config_value(lines, "speculative"))
    cache = config_value(lines, "cache") or ""
    k = re.search(r"k=(\S+)", cache)
    v = re.search(r"v=(\S+)", cache)
    return {
        "arch": _clean(config_value(lines, "arch")),
        "ngl": _as_int(config_value(lines, "ngl")),
        "ctx": _as_int(config_value(lines, "ctx")),
        "parallel": _as_int(config_value(lines, "parallel")),
        "threads": _as_int(config_value(lines, "threads")),
        "moe": _as_int(config_value(lines, "moe")),
        "override_tensors": _clean(config_value(lines, "override-tensors")),
        "speculative": spec,
        "spec_draft_n_max": draft_depth(lines),
        "cache_k": k.group(1) if k else None,
        "cache_v": v.group(1) if v else None,
        "flash_attn": _clean(config_value(lines, "fa")),
        "batch": _as_int(config_value(lines, "batch")),
        "ubatch": _as_int(config_value(lines, "ubatch")),
        "reasoning_effort": _clean(config_value(lines, "reasoning effort")),
        "samplers": _clean(config_value(lines, "samplers")),
    }


def short_spec(value: str | None) -> str:
    """"--spec-type draft-mtp --spec-draft-n-max 2" -> "draft-mtp n=2"."""
    if not value or value.strip() in ("off", "n/a", ""):
        return "off"
    kind = re.search(r"--spec-type\s+(\S+)", value)
    depth = re.search(r"--spec-draft-n-max\s+(\d+)", value)
    out = kind.group(1) if kind else value.strip()
    return out + (f" n={depth.group(1)}" if depth else "")


def short_ot(value: str | None) -> str:
    """The first -ot pattern plus a count of the rest; the full text is in the DB."""
    if not value or value.strip() in ("n/a", ""):
        return "none"
    patterns = [p for p in value.split(",") if p.strip()]
    head = patterns[0].strip()
    if len(head) > 22:
        head = head[:21] + "…"
    return head + (f" +{len(patterns) - 1}" if len(patterns) > 1 else "")


# ---------------------------------------------------------------------------
# the server's own load log
#
# What llama.cpp says about the model it loaded, as distinct from what it was
# asked to load. Observed per run, never fingerprinted: llama.cpp resolves the
# fused Gated Delta Net kernels per context at load time by checking the fused
# node landed on the same device as its layer (src/llama-context.cpp:504), so two
# runs with an identical fingerprint can execute different operations at
# different speeds. -ngl is a ceiling, not a result. An MTP head is either used
# or quietly ignored.
#
# Nothing is inferred. A field the log does not state is left None, because a
# plausible default here would be indistinguishable from an observation.
# ---------------------------------------------------------------------------
UNAVAILABLE = "unavailable"

# "0.03.336.929 I print_info: n_layer = 64" -> "print_info: n_layer = 64".
# The timestamp and level are per-run noise; the message is what is quoted.
LOG_PREFIX = re.compile(r"^\s*\d+(\.\d+)*\s+[A-Z]\s+")


def log_messages(path) -> list[str]:
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


def unused_tensors(msgs: list[str]) -> tuple[int, list[str]]:
    """Tensors the loader found in the file and did not use.

    Returned as a count and the distinct names minus their last component, which
    is what makes a family legible ("blk.64.nextn.*" for an MTP head the loader
    ignored) without storing one row per tensor.
    """
    names = [h.group(1) for h in
             (re.search(r"model has unused tensor (\S+)", m) for m in msgs) if h]
    if not names:
        return 0, []
    return len(names), sorted({n.rsplit(".", 1)[0] for n in names})


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


def parse_server_log(path, ngl: str | int | None = None) -> dict | None:
    """What the server said at load, as a dict, or None when there is no log.

    None means the run was recorded without one -- a hand-started server, or
    LLAMA_SERVER_LOG unset -- and no run_load_info row is written. That is the
    same discipline the markdown had, and the per-run row now gives it for free:
    an absent row cannot overwrite an earlier run's observations, where the
    rendered block needed a special case to avoid writing "unavailable" over them.
    """
    if not path or not path.exists():
        return None
    msgs = log_messages(path)
    if not msgs:
        return None

    n_layer = _int(msgs, r"print_info: n_layer\s+=\s+(\d+)")
    n_layer_all = _int(msgs, r"print_info: n_layer_all\s+=\s+(\d+)")

    # The split the loader reports, not the one -ngl asked for. -ngl is a ceiling:
    # it is clamped to what fits and counts the output layer, so the two disagree.
    layers_gpu = layers_total = None
    derived = 0
    split = _first(msgs, r"load_tensors: offloaded (\d+)/(\d+) layers to GPU")
    if split:
        layers_gpu, layers_total = int(split.group(1)), int(split.group(2))
    elif n_layer is not None and ngl is not None and str(ngl).isdigit():
        # llama.cpp counts the output layer alongside the blocks, so its
        # denominator is one more than the block count it reports.
        layers_total = (n_layer_all if n_layer_all is not None else n_layer) + 1
        layers_gpu = min(int(ngl), layers_total)
        derived = 1

    slots = _first(msgs, r"n_slots = (\d+), n_ctx_slot = (\d+), kv_unified = '(\w+)'")
    if slots:
        n_slots, n_ctx_slot = int(slots.group(1)), int(slots.group(2))
        kv_unified = slots.group(3)
    else:
        # The server's one-line summary is the preferred source; the context's own
        # lines are the fallback, and each field falls back independently.
        n_slots = _int(msgs, r"llama_context: n_seq_max\s+=\s+(\d+)")
        n_ctx_slot = _int(msgs, r"llama_context: n_ctx_seq\s+=\s+(\d+)")
        kvu = _first(msgs, r"llama_context: kv_unified\s+=\s+(\w+)")
        kv_unified = kvu.group(1) if kvu else None

    buffers: dict[str, float] = {}
    for m in msgs:
        hit = re.search(r"load_tensors:\s+(\S+) model buffer size =\s+([\d.]+) MiB", m)
        if hit and hit.group(1) not in buffers:
            buffers[hit.group(1)] = float(hit.group(2))
    cpu_mib = next((v for k, v in buffers.items() if k.startswith("CPU")), None)
    gpu_mib = next((v for k, v in buffers.items() if k.startswith("CUDA")), None)

    verdict, warnings = fused_ops(msgs)
    n_unused, prefixes = unused_tensors(msgs)
    return {
        "n_layer": n_layer, "n_layer_all": n_layer_all,
        "layers_gpu": layers_gpu, "layers_total": layers_total,
        "layers_derived": derived,
        "n_slots": n_slots, "n_ctx_slot": n_ctx_slot, "kv_unified": kv_unified,
        "fused_gdn": verdict, "mtp_head": mtp_head(msgs),
        "buffers": buffers, "cpu_buffer_mib": cpu_mib, "gpu_buffer_mib": gpu_mib,
        "unused_tensors": n_unused, "unused_prefixes": prefixes,
        "warnings": warnings,
        "deprecated": list(dict.fromkeys(m for m in msgs if "DEPRECATED" in m)),
    }


def headroom_in_layers(info: dict, headroom: int | None) -> str | None:
    """What the free VRAM is worth in the unit -ngl is tuned in.

    The per-layer cost is this model's own GPU-resident weights divided by the
    layers that got there, so it needs no assumption about the file's layout --
    but it is still an average over unequal layers: the output head and the last
    block are pinned by -ot and are not block-sized, and the KV cache grows
    alongside them. A hypothesis to test with a run, not a number to plan around.
    """
    gpu_mib, layers = info.get("gpu_buffer_mib"), info.get("layers_gpu")
    if headroom is None or not gpu_mib or not layers:
        return None
    per_layer = gpu_mib / layers
    return (f"~{headroom / per_layer:.1f} more layers at {per_layer:.1f} "
            f"MiB/layer avg ({gpu_mib:.2f} MiB / {layers} layers)")


# ---------------------------------------------------------------------------
# derived comparison figures
# ---------------------------------------------------------------------------
def num(value) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out


def effective_bandwidth(arch: str | None, cpu_mib: float | None,
                        gen_tps: float | None) -> str:
    """CPU-resident weights divided by the time one token takes.

    On a dense model every resident weight is read once per token, so this is
    close to the real effective bandwidth and is the number that says whether a
    configuration is bandwidth bound. On an MoE it is not computed at all -- only
    the routed experts are read per token, so dividing by all of them would
    produce a figure several times below the truth and invite the wrong
    conclusion.
    """
    if arch == "moe":
        return "n/a (moe)"
    if not gen_tps or not cpu_mib:
        return ""
    return f"{(cpu_mib / 1024) / (1.0 / gen_tps):.1f}"


def ngl_family(config_text: str) -> str:
    """The serving flags with the layer count removed: configs that differ only in -ngl."""
    return "\n".join(re.sub(r"ngl: \S+", "ngl: *", line)
                     for line in config_text.split("\n"))


def ngl_fit(rows: list[dict]) -> list[str]:
    """Least squares of ms/token against CPU-resident layers, per -ngl family.

    Reported as slope and intercept, never as ms_per_token / cpu_resident_layers:
    that ratio charges the whole per-token cost to the resident layers and reads
    as a much larger per-layer penalty than moving one layer actually costs. The
    intercept is the part that does not move with -ngl (the GPU-resident layers,
    sampling, the draft head), and it is most of the time on this hardware.

    Each row needs "config_text", "gen" (tokens/s) and "cpu_layers".
    """
    families: dict[str, list[tuple[float, float]]] = {}
    for facts in rows:
        gen, layers = num(facts.get("gen")), num(facts.get("cpu_layers"))
        if gen and layers is not None:
            families.setdefault(ngl_family(facts.get("config_text", "")), []).append(
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
        out.append(f"ms/token vs cpu-resident layers over {n} configurations "
                   f"({min(xs):.0f} to {max(xs):.0f} layers): {slope:.1f} ms per "
                   f"layer + {intercept:.0f} ms fixed.")
    return out
