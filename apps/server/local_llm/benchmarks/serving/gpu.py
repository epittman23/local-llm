"""benchmarks/serving/gpu.py - one nvidia-smi reading.

Moved out of telemetry_recorder.py (2026-10-28) so the llama-bench
pre-screen (benchmarks/prescreen/) samples the card with the same query and
the same parsing the recorder uses. The recorder itself cannot be reused for
that: it waits for a server's port and scrapes `/metrics`, and llama-bench
has neither.

Synchronous on purpose: the recorder is a plain loop in its own process,
and an async caller runs this in a worker thread.
"""

from __future__ import annotations

import re
import subprocess
import time

SMI_FIELDS = (
    'temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,clocks.sm,clocks_throttle_reasons.active'
)


def sample_gpu(binary: str = 'nvidia-smi') -> dict | None:
    """One nvidia-smi row. None when the query fails, so a transient failure
    skips a sample rather than writing a row of nulls that would drag every
    average toward zero."""
    try:
        out = subprocess.run(
            [binary, f'--query-gpu={SMI_FIELDS}', '--format=csv,noheader,nounits'],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0 or not out.stdout.strip():
        return None
    fields = [f.strip() for f in out.stdout.strip().split('\n')[0].split(',')]
    if len(fields) < 7:
        return None

    def as_int(value: str):
        try:
            return int(float(value))
        except ValueError:
            return None  # "[N/A]" on a laptop without a sensor

    def as_float(value: str):
        try:
            return float(value)
        except ValueError:
            return None

    throttle = None
    if re.fullmatch(r'0x[0-9a-fA-F]+', fields[6]):
        throttle = int(fields[6], 16)
    return {
        'at': int(time.time()),
        'temp_c': as_int(fields[0]),
        'util_pct': as_int(fields[1]),
        'mem_used_mib': as_int(fields[2]),
        'mem_total_mib': as_int(fields[3]),
        'power_w': as_float(fields[4]),
        'sm_mhz': as_int(fields[5]),
        'throttle': throttle,
    }
