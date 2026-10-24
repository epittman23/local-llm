"""Hold a linter's inherited findings to a baseline that may only shrink.

basedpyright (the backend's types) and Biome's linter (apps/web) each found
too many problems in inherited code to fix before turning them on, so their
findings on 2026-10-23 are recorded in a baseline: per file, per rule, how
many. A check fails if any file has more findings of a rule than its
baseline allows, so new code is held to the full rule set and old code can't
get worse. Fewer findings than the baseline pass with a notice; record them
with `update` (`make baselines`), which refuses to grow a baseline.

This is a rollout stage, not a resting place: the baselines are meant to
reach zero, at which point the tool runs without one. The PR gate lets a
pull request shrink a baseline but trips on one that grows.

    python3 lint_ratchet.py check|update basedpyright|biome REPORT BASELINE [--prefix DIR]

REPORT is the tool's JSON output (`basedpyright --outputjson`,
`biome lint --reporter=json --max-diagnostics=none`). --prefix makes the
report's paths repo-relative (Biome's are relative to apps/web).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
Counts = dict[str, dict[str, int]]


def _repo_relative(path: str, prefix: str) -> str:
    if os.path.isabs(path):
        return os.path.relpath(path, REPO)
    return os.path.normpath(os.path.join(prefix, path))


def findings(tool: str, report: dict, prefix: str = '') -> list[tuple[str, str, str]]:
    """(file, rule, message) for every finding that counts."""
    out = []
    if tool == 'basedpyright':
        for d in report.get('generalDiagnostics', []):
            if d.get('severity') in ('error', 'warning'):
                out.append((_repo_relative(d['file'], prefix), d.get('rule', 'unknown'), d.get('message', '')))
    elif tool == 'biome':
        for d in report.get('diagnostics', []):
            path = (d.get('location') or {}).get('path')
            category = d.get('category') or ''
            if d.get('severity') in ('error', 'warning') and isinstance(path, str) and category.startswith('lint/'):
                out.append((_repo_relative(path, prefix), category, d.get('message', '')))
    else:
        raise ValueError(f'unknown tool {tool!r}')
    return out


def count(found: list[tuple[str, str, str]]) -> Counts:
    totals = Counter((f, r) for f, r, _ in found)
    counts: Counts = {}
    for (f, r), n in sorted(totals.items()):
        counts.setdefault(f, {})[r] = n
    return counts


def compare(baseline: Counts, current: Counts) -> tuple[list[str], list[str]]:
    """(lines over the baseline, lines under it)."""
    over, under = [], []
    for f in sorted(set(baseline) | set(current)):
        for r in sorted(set(baseline.get(f, {})) | set(current.get(f, {}))):
            was, now = baseline.get(f, {}).get(r, 0), current.get(f, {}).get(r, 0)
            if now > was:
                over.append(f'{f}: {r}: {now} (baseline {was})')
            elif now < was:
                under.append(f'{f}: {r}: {now} (baseline {was})')
    return over, under


def load_baseline(path: Path) -> Counts:
    return json.loads(path.read_text())['counts'] if path.exists() else {}


def write_baseline(path: Path, tool: str, counts: Counts) -> None:
    total = sum(n for rules in counts.values() for n in rules.values())
    doc = {
        '_comment': f'{tool} findings allowed per file and rule; may only shrink. See .github/scripts/lint_ratchet.py.',
        'total': total,
        'counts': counts,
    }
    # Tabs: Biome formats apps/web's JSON that way, so its hook leaves this alone.
    path.write_text(json.dumps(doc, indent='\t') + '\n')


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('mode', choices=['check', 'update'])
    parser.add_argument('tool', choices=['basedpyright', 'biome'])
    parser.add_argument('report', type=Path)
    parser.add_argument('baseline', type=Path)
    parser.add_argument('--prefix', default='')
    args = parser.parse_args(argv)

    found = findings(args.tool, json.loads(args.report.read_text()), args.prefix)
    current = count(found)
    if args.mode == 'update' and not args.baseline.exists():
        write_baseline(args.baseline, args.tool, current)
        print(f'{args.baseline}: created with {sum(n for r in current.values() for n in r.values())} findings.')
        return 0
    baseline = load_baseline(args.baseline)
    over, under = compare(baseline, current)

    if over:
        print(f'{args.tool}: more findings than {args.baseline} allows. Fix the new ones:\n')
        offending = {line.split(': ')[0] + ': ' + line.split(': ')[1] for line in over}
        for line in over:
            print(f'  {line}')
        print('\nFindings in those files and rules (the new ones are among them):\n')
        for f, r, message in found:
            if f'{f}: {r}' in offending:
                print(f'  {f}: {r}: {message.splitlines()[0][:200]}')
        if args.mode == 'update':
            print('\nThe baseline only shrinks; it was not updated.')
        return 1
    if args.mode == 'update':
        write_baseline(args.baseline, args.tool, current)
        print(f'{args.baseline}: recorded {sum(n for r in current.values() for n in r.values())} findings.')
        return 0
    if under:
        print(f'{args.tool}: fewer findings than the baseline; record them with `make baselines`:')
        for line in under:
            print(f'  {line}')
    print(f'{args.tool}: no new findings.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
