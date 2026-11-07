"""Numeric settings read from the environment, leniently (#630, #795).

Standard library only, on purpose: `local_llm.env` has side effects at import
(it exits without `LLLM_SECRET_KEY`, creates `DATA_DIR`, loads `.env`, sets up
logging), which a separate process such as the benchmarks' telemetry recorder
must not trigger just to read a number. `local_llm.env` re-exports both
helpers.
"""

import logging
import os

# Kept as `local_llm.env`, the name these warnings were logged under there.
log = logging.getLogger('local_llm.env')


def int_env[D](name: str, default: D) -> int | D:
    """A whole-number setting from the environment, or `default` when unset, empty or not a whole number.

    A bare `int(os.getenv(name, '0'))` raised at import for a variable set but
    empty (or `0.5`), so the backend did not start at all (#301, #630).
    """
    value = (os.getenv(name) or '').strip()
    if not value:
        return default
    try:
        return int(value)
    except ValueError:
        log.warning('%s=%r is not a whole number; %r is used', name, value, default)
        return default


def float_env[D](name: str, default: D) -> float | D:
    """A number setting from the environment, or `default` when unset, empty or not a number (#630)."""
    value = (os.getenv(name) or '').strip()
    if not value:
        return default
    try:
        return float(value)
    except ValueError:
        log.warning('%s=%r is not a number; %r is used', name, value, default)
        return default
