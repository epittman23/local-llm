"""
Usage logging.

Records one JSON line per query to logs/usage.jsonl: which model handled it,
how long it took, and token usage. This is the data source for comparing
REASONING_MODEL against REASONING_MODEL_ALT (or any other models) on real
queries, rather than relying on published benchmarks alone.
"""

import json
import time
from pathlib import Path

LOGS_DIR = Path(__file__).resolve().parent.parent / "logs"
LOGS_DIR.mkdir(exist_ok=True)
LOG_FILE = LOGS_DIR / "usage.jsonl"


def log_query(
    task: str,
    model: str,
    prompt: str,
    latency_seconds: float,
    prompt_tokens: int | None,
    completion_tokens: int | None,
) -> None:
    entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "task": task,
        "model": model,
        # Only a preview is stored, not the full prompt/response, to keep the
        # log file small and avoid duplicating potentially sensitive content.
        "prompt_preview": prompt[:80],
        "latency_seconds": round(latency_seconds, 3),
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
    }
    with LOG_FILE.open("a") as f:
        f.write(json.dumps(entry) + "\n")
