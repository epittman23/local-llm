"""benchmarks/evaluation/suites.py - suite TOML loading and seeded item selection.

Ported from local-llm's scripts/llama_tests.py (outer repo). A suite names a
tier (smoke/standard/full) as a list of (benchmark, n) pairs; build_suite()
resolves that into the concrete, seeded list of items a run will grade.

Parsed with stdlib tomllib (Python 3.11+), on purpose: no TOML dependency.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import random
import tomllib

from local_llm.benchmarks.evaluation import grading, livecodebench_data
from local_llm.benchmarks.evaluation.datasets import dotted, item_id, read_items
from local_llm.benchmarks.paths import SUITES_DIR


def suite_names() -> list[str]:
    return sorted(p.stem for p in SUITES_DIR.glob('*.toml'))


def load_suite(name: str) -> dict:
    # Only a name the suites directory lists, never a path built from the
    # request: `../../x` would otherwise read any .toml file the server can,
    # the same rule load_system() applies to system prompts.
    known = suite_names()
    if name not in known:
        raise SystemExit(f"benchmarks: no suite '{name}' (known: {', '.join(known)})")
    path = SUITES_DIR / f'{name}.toml'
    with open(path, 'rb') as fh:
        return tomllib.load(fh)


# ---------------------------------------------------------------------------
# filtering and sampling
# ---------------------------------------------------------------------------
def filter_items(adapter: dict, items: list[dict]) -> tuple[list[dict], list[dict]]:
    """Split into (runnable, skipped) by the adapter's library filter."""
    spec = adapter.get('filter')
    if not spec:
        return items, []
    field, wanted = spec['field'], set(spec['values'])
    keep, drop = [], []
    for it in items:
        (keep if dotted(it, field) in wanted else drop).append(it)
    return keep, drop


def sample(items: list[dict], n: int, seed: int, adapter: dict) -> list[dict]:
    """A seeded sample, stable across runs and across configurations.

    Sorted by the dataset's own id before sampling, so the selection does not
    depend on the order the rows happened to be written in. n <= 0 means every
    item -- that is what the `full` tier asks for.
    """
    ordered = sorted(items, key=lambda it: item_id(adapter, it))
    if n <= 0 or n >= len(ordered):
        return ordered
    return sorted(random.Random(seed).sample(ordered, n), key=lambda it: item_id(adapter, it))


# ---------------------------------------------------------------------------
# suite assembly
# ---------------------------------------------------------------------------
def build_suite(
    suite: dict,
    adapters: dict[str, dict],
    only: str | None = None,
    window: tuple[dt.date, dt.date | None] | None = None,
    notes: list[str] | None = None,
) -> tuple[list[dict], list[dict]]:
    """Resolve a tier into the concrete list of items to run.

    Returns (selected, skipped). Skipped entries carry their reason so a run
    records what it could not attempt rather than quietly shrinking.

    A windowed benchmark (an adapter with [window], LiveCodeBench) draws its
    pool from the release-date window given, and each of its rows carries
    `item_window`. Without a window it is left out, said in `notes`, before
    its data is read: Tune's sweeps and every run that has not fetched it
    pass no window. Asking for it by name without one is an error.
    """
    seed = int(suite.get('seed', 0))
    selected: list[dict] = []
    skipped: list[dict] = []
    notes = notes if notes is not None else []
    windowed_in_run = False

    for entry in suite.get('benchmark', []):
        bench = entry['id']
        if only and bench != only:
            continue
        adapter = adapters.get(bench)
        if adapter is None:
            raise SystemExit(f"benchmarks: suite '{suite['id']}' names unknown benchmark '{bench}'")
        item_window = None
        if adapter.get('window'):
            if window is None:
                if only == bench:
                    raise SystemExit(f'{bench} is drawn from a release-date window: give its first date (window_min)')
                notes.append(f'{bench} left out: no release-date window given')
                continue
            windowed_in_run = True
            _check_coverage(adapter, window)
            item_window = livecodebench_data.window_text(window)
        items = read_items(bench)
        if item_window is not None and window is not None:
            field, drawn = adapter['window']['field'], window
            items = [it for it in items if livecodebench_data.in_window(it, field, drawn)]
            if not items:
                raise SystemExit(f'{bench} has no problems in the window {item_window}')
        keep, dropped = filter_items(adapter, items)

        # "kind" separates the two reasons an item can be out of the pool,
        # because they are invalidated by different things: the library filter
        # by editing the adapter, the calibration by a dataset refetch or a
        # library upgrade on this box.
        for it in dropped:
            skipped.append(
                {
                    'benchmark': bench,
                    'item_id': item_id(adapter, it),
                    'kind': 'library_filter',
                    'reason': "outside the adapter's library filter",
                }
            )

        # Applied before sampling, not after. Dropping items from an already
        # drawn sample would give each benchmark a different effective n and
        # make the tier's advertised size a fiction; dropping them from the
        # pool keeps every tier exactly the size it says it is.
        blocked = grading.ungradeable(bench)
        if blocked:
            still = []
            for it in keep:
                iid = item_id(adapter, it)
                if iid in blocked:
                    skipped.append(
                        {
                            'benchmark': bench,
                            'item_id': iid,
                            'kind': 'ungradeable',
                            'reason': f'ungradeable here ({blocked[iid]})',
                        }
                    )
                else:
                    still.append(it)
            keep = still

        # The seed is offset per benchmark so the three do not draw parallel
        # index sequences, which would correlate the samples across benchmarks.
        n = int(entry.get('n', 0))
        chosen = sample(keep, n, seed + sum(map(ord, bench)), adapter)
        if item_window is not None and 0 < len(keep) < n:
            notes.append(f'{bench}: the window {item_window} holds {len(keep)} problems, fewer than {n}; using all')
        for it in chosen:
            row = {'benchmark': bench, 'adapter': adapter, 'item': it, 'item_id': item_id(adapter, it)}
            if item_window is not None:
                row['item_window'] = item_window
            selected.append(row)

    if window is not None and not windowed_in_run:
        raise SystemExit(
            'a release-date window applies only to a windowed benchmark (livecodebench), and this run has none'
        )
    return selected, skipped


def _check_coverage(adapter: dict, window: tuple[dt.date, dt.date | None]) -> None:
    """Refuse a window unless every increment it touches is fetched, naming the ones missing."""
    have = livecodebench_data.present(adapter)
    missing = [name for name in livecodebench_data.needed(adapter, window) if name not in have]
    if missing:
        raise SystemExit(
            f'{adapter["id"]}: the window {livecodebench_data.window_text(window)} needs '
            f'{", ".join(missing)}, not fetched yet (Tests page, Datasets)'
        )


def interleave(selected: list[dict]) -> list[dict]:
    """Round-robin the selected items across benchmarks, each in item order.

    Exists for llama-tune, which measures a candidate over a prefix of the
    tier and lengthens that prefix each round. A contiguous prefix of the
    natural order would make round 1 a HumanEval-only measurement and a later
    round a DS-1000 one, confounding the round with prompt length and
    difficulty -- which is the same confound the interleaved *candidate*
    order exists to avoid, one level down.

    Ordering within a benchmark is the sample's own, not sorted: `sample` is
    seeded so every configuration draws the same items in the same sequence,
    and re-sorting here would throw that away for no gain.
    """
    by_bench: dict[str, list[dict]] = {}
    for row in selected:
        by_bench.setdefault(row['benchmark'], []).append(row)
    names = sorted(by_bench)
    out: list[dict] = []
    for i in range(max((len(v) for v in by_bench.values()), default=0)):
        for name in names:
            if i < len(by_bench[name]):
                out.append(by_bench[name][i])
    return out


def order_sha(selected: list[dict]) -> str:
    """A fingerprint of an item order, so a resume can prove it got the same one.

    Over (benchmark, item_id) pairs in sequence: the identity of the items and
    the order they run in are both part of what a sweep's rounds mean, since a
    round is a slice of this list.
    """
    text = '\n'.join(f'{r["benchmark"]}/{r["item_id"]}' for r in selected)
    return hashlib.sha1(text.encode()).hexdigest()[:12]


def missing_libraries(selected: list[dict]) -> dict[str, str]:
    """Item ids that cannot be graded here, mapped to why.

    Checked once up front rather than per item: importing pandas costs about a
    second, and a `full` DS-1000 run would otherwise pay it 510 times to learn
    the same fact.
    """
    needs = {
        'ds1000': {
            'Pandas': 'pandas',
            'Numpy': 'numpy',
            'Scipy': 'scipy',
            'Sklearn': 'sklearn',
            'Matplotlib': 'matplotlib',
            'Tensorflow': 'tensorflow',
            'Pytorch': 'torch',
        }
    }
    wanted: set[str] = set()
    for row in selected:
        table = needs.get(row['benchmark'])
        if table:
            lib = dotted(row['item'], 'metadata.library')
            if lib in table:
                wanted.add(table[lib])
    if not wanted:
        return {}
    have = {n.lower() for n in grading.libraries_available(sorted(wanted))}

    out: dict[str, str] = {}
    for row in selected:
        table = needs.get(row['benchmark'])
        if not table:
            continue
        module = table.get(dotted(row['item'], 'metadata.library'))
        if module and module.lower() not in have:
            out[f'{row["benchmark"]}/{row["item_id"]}'] = f'{module} is not installed in the grading environment'
    return out
