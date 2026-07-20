"""
Summarize logs/usage.jsonl per model: query count, average latency, and
average token usage. Run this periodically to see which model is performing
better on your actual queries, most relevantly the reasoning model vs. its
alternative (QwQ-32B).

Usage:
    python scripts/analyze_logs.py
"""

import json
import statistics
from pathlib import Path

LOG_FILE = Path(__file__).resolve().parent.parent / "logs" / "usage.jsonl"


def main():
    if not LOG_FILE.exists():
        print("No log file found yet. Run some queries first.")
        return

    by_model: dict[str, list[dict]] = {}
    with LOG_FILE.open() as f:
        for line in f:
            entry = json.loads(line)
            by_model.setdefault(entry["model"], []).append(entry)

    if not by_model:
        print("Log file is empty.")
        return

    print(f"{'Model':<45} {'Count':>6} {'Avg latency (s)':>16} {'Avg total tokens':>18}")
    print("-" * 88)
    for model, entries in sorted(by_model.items()):
        count = len(entries)
        avg_latency = statistics.mean(e["latency_seconds"] for e in entries)

        token_totals = [
            (e["prompt_tokens"] or 0) + (e["completion_tokens"] or 0)
            for e in entries
            if e["prompt_tokens"] is not None and e["completion_tokens"] is not None
        ]
        avg_tokens = statistics.mean(token_totals) if token_totals else float("nan")

        print(f"{model:<45} {count:>6} {avg_latency:>16.2f} {avg_tokens:>18.1f}")


if __name__ == "__main__":
    main()
