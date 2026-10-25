"""benchmarks/evaluation/datasets.py - benchmark datasets: vendored, fetched, and reading them back.

Ported from local-llm's scripts/llama_fetch.py and the dataset-reading half of
scripts/llama_tests.py (outer repo). An adapter's `[source]` says where its
rows come from:

    kind = "vendored"   a file committed under benchmarks/data/datasets/,
                        pinned by the SHA-256 of its decompressed bytes
    [fetch] kinds       downloaded once into DATA_DIR: FETCHERS for a small
                        dataset (none ship today), INCREMENTS_KIND for
                        LiveCodeBench (livecodebench_data.py)

HumanEval+, MBPP+ and DS-1000 are vendored (2026-10-25). Until then every
dataset was fetched, from branch heads that resolve to different content over
time, so a fresh DATA_DIR had no data until someone pressed Fetch, and what it
got was whatever upstream held that day. A vendored file is the same bytes on
every machine and every checkout, needs no network, and the hash is checked on
every read (hashed once per file version: a cache keyed by path, mtime and
size holds the verified bytes): an edited file is refused, never graded. The licenses that once
argued against vendoring are honoured in NOTICE instead, and each result still
traces to a citable release through `dataset_revision`
(`<release>@<sha256[:12]>`, or a `revision` the adapter pins verbatim).

Fetched datasets land as:

    <base>/<id>/items.jsonl     the rows, exactly as upstream published them
    <base>/<id>/MANIFEST.json   what was downloaded, and from which revision

Either way, dataset_identity() is what a result records: the revision and
content hash of the rows it was graded against. A pass rate is only
reproducible alongside them.

Base path for fetched data and calibrations: <DATA_DIR>/benchmarks/datasets,
where DATA_DIR is the fork's own data directory (local_llm.env.DATA_DIR).
Overridable with BENCHMARKS_DATA_DIR for an alternate deployment, and every
function additionally accepts an explicit `base` argument so a caller or a
test can point at a directory of its own without touching the environment.

Stdlib only (urllib + json + gzip + tomllib elsewhere in this package): no
`datasets`, no `pyarrow`, no network client beyond what Python ships.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import sys
import time
from pathlib import Path

from local_llm.benchmarks.paths import DATASETS_DIR
from local_llm.env import DATA_DIR


class DatasetError(Exception):
    """A dataset that is missing, malformed, or could not be fetched.

    An ordinary exception, not the SystemExit the CLI this came from raised:
    raised in a worker thread of the backend, a SystemExit would reach the
    event loop and stop the server.
    """


def datasets_base_dir() -> Path:
    """Where fetched datasets and calibrations live. Overridable so a run can point at a copy."""
    override = os.environ.get('BENCHMARKS_DATA_DIR')
    return Path(override) if override else DATA_DIR / 'benchmarks' / 'datasets'


# ---------------------------------------------------------------------------
# reading what was fetched
# ---------------------------------------------------------------------------
def items_path(bench: str, base: Path | None = None) -> Path:
    return (base or datasets_base_dir()) / bench / 'items.jsonl'


def manifest_path(bench: str, base: Path | None = None) -> Path:
    return (base or datasets_base_dir()) / bench / 'MANIFEST.json'


def read_manifest(bench: str, base: Path | None = None) -> dict | None:
    path = manifest_path(bench, base)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def read_items(bench: str, base: Path | None = None) -> list[dict]:
    source = _vendored_source(bench)
    if source is not None:
        return _parse_jsonl(_vendored_bytes(source))
    increments = _increments_adapter(bench)
    if increments is not None:
        from local_llm.benchmarks.evaluation import livecodebench_data

        return livecodebench_data.read_items(increments, base)
    path = items_path(bench, base)
    if not path.exists():
        raise DatasetError(f'{bench} is not downloaded yet: fetch it from the Tests page (Datasets, Fetch)')
    return _parse_jsonl(path.read_bytes())


def _parse_jsonl(raw: bytes) -> list[dict]:
    out = []
    for line in raw.decode('utf-8').splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def dataset_identity(bench: str, base: Path | None = None) -> dict | None:
    """What a result records about the rows it was graded against, or None when there are none.

    For a vendored dataset it is built from the adapter's `[source]`, after
    the file's hash has been checked; for a fetched one it is the manifest the
    fetch wrote. Both carry `revision`, `content_sha256` and `n_items`, which
    is what the runner, the calibration and the Tests page read.
    """
    source = _vendored_source(bench)
    if source is None:
        increments = _increments_adapter(bench)
        if increments is not None:
            from local_llm.benchmarks.evaluation import livecodebench_data

            return livecodebench_data.identity(increments, base)
        return read_manifest(bench, base)
    raw = _vendored_bytes(source)
    adapter = source['_adapter']
    return {
        'benchmark': bench,
        'name': adapter.get('name', bench),
        'license': adapter.get('license', 'unknown'),
        'homepage': adapter.get('homepage', ''),
        'citation': adapter.get('citation', ''),
        'source_url': source.get('url', ''),
        'revision': source.get('revision') or f'{source["release"]}@{source["sha256"][:12]}',
        'content_sha256': source['sha256'],
        'n_items': sum(1 for line in raw.splitlines() if line.strip()),
        'vendored': True,
    }


# ---------------------------------------------------------------------------
# vendored datasets
# ---------------------------------------------------------------------------
def _vendored_source(bench: str) -> dict | None:
    """The adapter's `[source]` when it is vendored, else None."""
    # Imported here: adapters imports dotted() from this module.
    from local_llm.benchmarks.evaluation.adapters import load_adapters

    adapter = load_adapters().get(bench)
    source = (adapter or {}).get('source')
    if not source or source.get('kind') != 'vendored':
        return None
    return {**source, '_adapter': adapter}


# The fetch kind whose increments the user picks, decoded by livecodebench_data.
INCREMENTS_KIND = 'hf_lfs_files'


def _increments_adapter(bench: str) -> dict | None:
    """The adapter when its data comes in increments the user picks (LiveCodeBench), else None."""
    from local_llm.benchmarks.evaluation.adapters import load_adapters

    adapter = load_adapters().get(bench)
    return adapter if (adapter or {}).get('fetch', {}).get('kind') == INCREMENTS_KIND else None


# Verified bytes, keyed by the file's identity on disk and the pinned hash, so
# a run that reads a dataset a dozen times hashes and decompresses it once.
_VERIFIED: dict[tuple, bytes] = {}


def vendored_path(source: dict) -> Path:
    """The vendored file a `[source]` names, refusing anything outside DATASETS_DIR."""
    path = (DATASETS_DIR / source['path']).resolve()
    if not path.is_relative_to(DATASETS_DIR.resolve()):
        raise DatasetError(f'vendored path {source["path"]!r} is outside {DATASETS_DIR}')
    return path


def _vendored_bytes(source: dict) -> bytes:
    """The decompressed rows of a vendored file, after checking them against the pinned hash."""
    path = vendored_path(source)
    try:
        stat = path.stat()
    except OSError as exc:
        raise DatasetError(f'the vendored file {source["path"]} is missing: {exc}') from exc
    key = (str(path), stat.st_mtime_ns, stat.st_size, source['sha256'])
    cached = _VERIFIED.get(key)
    if cached is not None:
        return cached
    packed = path.read_bytes()
    raw = gzip.decompress(packed) if path.suffix == '.gz' else packed
    actual = hashlib.sha256(raw).hexdigest()
    if actual != source['sha256']:
        raise DatasetError(
            f'the vendored file {source["path"]} does not match its pinned hash '
            f'(sha256 {actual[:12]}, expected {source["sha256"][:12]}); refusing to grade against it'
        )
    _VERIFIED[key] = raw
    return raw


def short_revision(revision: str) -> str:
    """A dataset revision short enough to show: a bare sha cut to 12, a vendored `<release>@<sha12>` whole."""
    return revision if '@' in revision else revision[:12]


def dotted(obj: dict, path: str):
    """Read "metadata.problem_id" out of a nested record."""
    cur = obj
    for part in path.split('.'):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def item_id(adapter: dict, item: dict) -> str:
    """The dataset's own identifier for an item, never a positional index.

    Positional ids would silently change meaning when the upstream dataset
    gains or loses a row, and a result file outlives the dataset revision
    that made it.
    """
    raw = dotted(item, adapter['item']['id_field'])
    return str(raw)


# ---------------------------------------------------------------------------
# fetch kind -> fetcher(spec) returning (rows, revision, source_url, raw bytes),
# for a dataset small enough to hold in memory. Empty since HumanEval+, MBPP+
# and DS-1000 were vendored (2026-10-25). LiveCodeBench, too large for this,
# is INCREMENTS_KIND, fetched by livecodebench_data.fetch().
FETCHERS: dict = {}


def fetch_one(adapter: dict, force: bool = False, base: Path | None = None) -> dict:
    bench = adapter['id']
    if (adapter.get('source') or {}).get('kind') == 'vendored':
        # Nothing to download: the rows are in the repository. Returning the
        # identity reports them, and verifies the file on the way.
        return dataset_identity(bench, base) or {}
    if (adapter.get('fetch') or {}).get('kind') == INCREMENTS_KIND:
        raise DatasetError(f'{bench} is fetched by increment: pick the increments to fetch')
    out = (base or datasets_base_dir()) / bench
    manifest = out / 'MANIFEST.json'

    if manifest.exists() and not force:
        current = json.loads(manifest.read_text())
        print(
            f'{bench}: already downloaded '
            f'({current["n_items"]} items, revision '
            f'{(current.get("revision") or current["content_sha256"])[:12]}); '
            f'--force to refetch',
            file=sys.stderr,
        )
        return current

    spec = adapter.get('fetch')
    if not spec:
        raise DatasetError(f'{bench} has neither a vendored [source] nor a [fetch]')
    fetcher = FETCHERS.get(spec['kind'])
    if fetcher is None:
        raise DatasetError(f"unknown fetch kind '{spec['kind']}'")

    print(f'{bench}: downloading', file=sys.stderr)
    rows, revision, url, raw = fetcher(spec)
    if not rows:
        raise DatasetError(f'{bench} returned no rows')

    # Written beside the old files and swapped in with os.replace, items first
    # and the manifest last: the manifest is the commit point, so a fetch that
    # fails partway leaves the previous dataset whole, and the directory's
    # other files (CALIBRATION.json) are kept.
    out.mkdir(parents=True, exist_ok=True)
    items_tmp = out / 'items.jsonl.tmp'
    manifest_tmp = out / 'MANIFEST.json.tmp'
    try:
        items_tmp.write_text(''.join(json.dumps(r, sort_keys=True) + '\n' for r in rows))

        # Recorded even though nothing filters at fetch time: the filter is applied
        # when a suite is built, so widening it later must not require a refetch.
        counts: dict[str, int] = {}
        spec_filter = adapter.get('filter')
        if spec_filter:
            for row in rows:
                key = str(dotted(row, spec_filter['field']))
                counts[key] = counts.get(key, 0) + 1

        record = {
            'benchmark': bench,
            'name': adapter.get('name', bench),
            'license': adapter.get('license', 'unknown'),
            'homepage': adapter.get('homepage', ''),
            'citation': adapter.get('citation', ''),
            'source_url': url,
            'revision': revision,
            'content_sha256': hashlib.sha256(raw).hexdigest(),
            'fetched_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'n_items': len(rows),
        }
        if counts:
            record['by_' + spec_filter['field'].split('.')[-1]] = dict(sorted(counts.items()))

        manifest_tmp.write_text(json.dumps(record, indent=2) + '\n')
        os.replace(items_tmp, out / 'items.jsonl')
        os.replace(manifest_tmp, manifest)
    finally:
        # Only left behind by a failure: the old files are untouched then.
        items_tmp.unlink(missing_ok=True)
        manifest_tmp.unlink(missing_ok=True)
    print(f'{bench}: {len(rows)} items -> {out}', file=sys.stderr)
    return record
