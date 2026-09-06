#!/usr/bin/env python3
"""A fake `nvidia-smi --query-gpu=...` for the llama-tune checks.

Pointed at by LLAMA_TUNE_NVIDIA_SMI. It reads the same state and config files
the stub server writes, so the card it describes and the card that is serving
are the same card -- otherwise a check could pass by having the cooldown wait
out a hot GPU that was never slow, or resume onto a slow GPU that never looked
hot, and neither would be testing anything.

The schedule it implements is the one property of real hardware that makes the
cooldown design non-obvious: **an idle GPU clears its own throttle bits.**
`smi_hot_seconds` is how long after the cap begins this fake card still admits
to being throttled; `cap_seconds` (in the stub's config) is how long it is
actually slow. Setting the first much shorter than the second reproduces the
case the loaded baseline probe exists for -- telemetry says recovered, the card
is not -- and a tuner that resumed on the idle signal alone would be caught by
exactly that gap.
"""
from __future__ import annotations

import json
import os
import sys
import time

HOT_MASK = 0x24        # SwPowerCap | SwThermalSlowdown, the 2026-09-05 word
IDLE_MASK = 0x1        # GpuIdle, which is expected and is not a fault


def _json(path: str | None, default: dict) -> dict:
    if not path or not os.path.exists(path):
        return default
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return default


def main(argv: list[str]) -> int:
    cfg = _json(os.environ.get("LLAMA_TUNE_STUB_CONFIG"), {})
    state = _json(os.environ.get("LLAMA_TUNE_STUB_STATE"), {})
    capped_at = state.get("capped_at")

    hot = False
    if capped_at is not None:
        hot = (time.time() - float(capped_at)) < float(
            cfg.get("smi_hot_seconds", 30.0))

    if hot:
        temp, power, mask = float(cfg.get("hot_temp", 87.0)), 51.2, HOT_MASK
    else:
        temp, power, mask = float(cfg.get("cool_temp", 52.0)), 12.4, IDLE_MASK

    # csv,noheader,nounits: three fields, no units, which is what the caller
    # asks for and therefore what it parses.
    sys.stdout.write(f"{temp:.0f}, {power:.2f}, 0x{mask:016X}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
