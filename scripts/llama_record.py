#!/usr/bin/env python3
"""llama_record.py - record one serving run into logs/llama.db.

Part of https://github.com/epittman23/local-llm

Started by llama-serve through scripts/llama-vram-log.sh, which stays the
interface and stays the source of truth for the config-id: it resolves the
profile, builds the six configuration lines from the same LLAMA_P_* variables
llama-serve builds its argv from, hashes them, and hands the result here. This
file does the loop.

    wait for the port      a model this size takes minutes to load, and samples
                           taken before it is up describe nothing
    open a run row         ended_at IS NULL is the active-run marker llama-test
                           looks for; the pid on the row is what makes a dead
                           recorder detectable
    sample nvidia-smi      every LLAMA_VRAM_INTERVAL seconds, committed as taken
    scrape /metrics        every pass, all of them kept, not just first and last
    parse the server log   what llama.cpp said about the model it loaded
    close the run          on SIGTERM from llama-serve, or when the port stops
                           answering, or from the exit handler

WHAT CHANGED, AND WHY IT MATTERS. The shell version accumulated samples in a
tmpfile and folded the whole run into a markdown log from an EXIT trap, so a
kill -9 of the recorder lost every sample it had taken, and the marker file that
same trap removed was left behind for later results to be filed under. Here each
sample is its own committed row and the run is closed by a sweep that checks the
recorded pid. jq is gone from this path with the JSON payload it built.

STDLIB ONLY, and not negotiable: this runs under bare python3 for the life of
every server and must never depend on <repo>/.venv.
"""

from __future__ import annotations

import argparse
import errno
import os
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import llama_db as db          # noqa: E402
import llama_stats as stats    # noqa: E402

# Consecutive failed port probes before concluding the server is gone. This is
# the fallback stop condition; the normal one is a SIGTERM from llama-serve.
MISS_LIMIT = 3

SMI_FIELDS = ("temperature.gpu,utilization.gpu,memory.used,memory.total,"
              "power.draw,clocks.sm,clocks_throttle_reasons.active")

# The /metrics counters worth a row. llama.cpp exposes more, but these are the
# ones a serving configuration is judged on; anything else would be noise at one
# row per counter per pass.
COUNTERS = [
    "llamacpp:prompt_tokens_total",
    "llamacpp:prompt_tokens_cached_total",
    "llamacpp:prompt_seconds_total",
    "llamacpp:tokens_predicted_total",
    "llamacpp:tokens_predicted_seconds_total",
    "llamacpp:spec_decode_num_draft_tokens_total",
    "llamacpp:spec_decode_num_accepted_tokens_total",
    "llamacpp:spec_decode_num_drafts_total",
]

_stop = False


def _signal(_signum, _frame) -> None:
    global _stop
    _stop = True


def note(message: str) -> None:
    print(f"llama-record: {message}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# probes
# ---------------------------------------------------------------------------
def port_open(port: int) -> bool:
    """Connect rather than shell out to `ss`.

    Same question as before -- is anything serving on this port -- with one
    fewer external command in a loop that runs every five seconds.
    """
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def sample_gpu() -> dict | None:
    """One nvidia-smi row. None when the query fails, so a transient failure
    skips a sample rather than writing a row of nulls that would drag every
    average toward zero."""
    try:
        out = subprocess.run(
            ["nvidia-smi", f"--query-gpu={SMI_FIELDS}",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0 or not out.stdout.strip():
        return None
    fields = [f.strip() for f in out.stdout.strip().split("\n")[0].split(",")]
    if len(fields) < 7:
        return None

    def as_int(value: str):
        try:
            return int(float(value))
        except ValueError:
            return None                    # "[N/A]" on a laptop without a sensor

    def as_float(value: str):
        try:
            return float(value)
        except ValueError:
            return None

    throttle = None
    if re.fullmatch(r"0x[0-9a-fA-F]+", fields[6]):
        throttle = int(fields[6], 16)
    return {"at": db.now(), "temp_c": as_int(fields[0]),
            "util_pct": as_int(fields[1]), "mem_used_mib": as_int(fields[2]),
            "mem_total_mib": as_int(fields[3]), "power_w": as_float(fields[4]),
            "sm_mhz": as_int(fields[5]), "throttle": throttle}


def scrape_metrics(port: int) -> dict | None:
    """The server's cumulative counters, or None when /metrics is not answering.

    It only exists if llama-serve passed --metrics, and it answers later than the
    port opens because the model has to finish loading first, so a failure early
    in a run is expected and is simply retried on the next pass.
    """
    try:
        with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/metrics", timeout=5) as response:
            body = response.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError, ValueError):
        return None
    if not body.startswith("#"):
        return None                        # a JSON error means --metrics is off

    out: dict[str, float] = {}
    for line in body.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 2 or parts[0] not in COUNTERS:
            continue
        try:
            out[parts[0].split(":", 1)[1]] = float(parts[1])
        except ValueError:
            continue
    return out or None


# ---------------------------------------------------------------------------
# the run
# ---------------------------------------------------------------------------
def record(args: argparse.Namespace) -> int:
    con = db.connect()
    db.upsert_config(con, args.config_id, args.alias, args.config_line)

    # Wait for the server to bind its port before opening the run, so a run that
    # never came up leaves no row at all rather than an empty one.
    waited = 0
    while not port_open(args.port):
        if _stop:
            note("stopped before the server came up")
            return 0
        if waited >= args.wait:
            note(f"no server on port {args.port} after {args.wait}s; giving up")
            return 0
        time.sleep(1)
        waited += 1

    run_id = db.open_run(con, args.config_id, model=args.model,
                         quant=args.quant, build=args.build, port=args.port,
                         pid=os.getpid())
    note(f"recording run {run_id} (config {args.config_id}) into {db.db_path()}")

    server_log = Path(args.server_log) if args.server_log else None
    load_seen = False
    misses = 0
    try:
        while not _stop:
            # Probe before sampling, so telemetry from after the server exited is
            # never attributed to the run.
            if port_open(args.port):
                misses = 0
            else:
                misses += 1
                if misses >= MISS_LIMIT:
                    break
                time.sleep(1)
                continue

            sample = sample_gpu()
            if sample:
                db.add_sample(con, run_id, sample)

            counters = scrape_metrics(args.port)
            if counters:
                db.add_metrics(con, run_id, db.now(), counters)
                if not load_seen:
                    # /metrics answering means the model finished loading, so the
                    # log now has everything worth reading. Recorded here as well
                    # as at close so a kill -9 does not lose it.
                    load_seen = store_load_info(con, run_id, server_log, args.ngl)

            slept = 0.0
            while slept < args.interval and not _stop:
                time.sleep(min(0.5, args.interval - slept))
                slept += 0.5
    finally:
        finish(con, run_id, server_log, args.ngl)
        con.close()
    return 0


def store_load_info(con, run_id: int, server_log: Path | None,
                    ngl: str | None) -> bool:
    info = stats.parse_server_log(server_log, ngl)
    if not info:
        return False
    db.set_load_info(con, run_id, info)
    return True


def finish(con, run_id: int, server_log: Path | None, ngl: str | None) -> None:
    store_load_info(con, run_id, server_log, ngl)
    db.close_run(con, run_id, "clean")

    samples = db.samples(con, run_id)
    if not samples:
        note(f"run {run_id} recorded no samples")
        return
    figures = stats.gpu_stats(samples)
    headroom = figures.get("vram_headroom_mib")
    note(f"run {run_id} closed: {figures['samples']} samples, "
         f"util active avg {figures['util_active_avg']:.0f}%, "
         f"peak {figures['mem_max']} MiB used"
         + (f", {headroom} MiB free" if headroom is not None else ""))
    warning = stats.headroom_warning(str(run_id), headroom)
    if warning:
        note("warning: " + warning)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config-id", required=True)
    ap.add_argument("--alias", required=True)
    ap.add_argument("--config-line", action="append", default=[],
                    help="one fingerprinted configuration line; repeat in order")
    ap.add_argument("--model", required=True)
    ap.add_argument("--quant", required=True)
    ap.add_argument("--build", default="unknown")
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--ngl", default=None,
                    help="the requested layer count, used only to derive the "
                         "split when the load log does not report one")
    ap.add_argument("--server-log", default=os.environ.get("LLAMA_SERVER_LOG", ""))
    ap.add_argument("--interval", type=float,
                    default=float(os.environ.get("LLAMA_VRAM_INTERVAL", "5")))
    ap.add_argument("--wait", type=int,
                    default=int(os.environ.get("LLAMA_VRAM_WAIT", "600")))
    args = ap.parse_args()

    signal.signal(signal.SIGTERM, _signal)
    signal.signal(signal.SIGINT, _signal)
    try:
        return record(args)
    except OSError as exc:                              # pragma: no cover
        if exc.errno == errno.EINTR:
            return 0
        raise


if __name__ == "__main__":
    sys.exit(main())
