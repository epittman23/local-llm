"""benchmarks/evaluation/livecodebench_data.py - LiveCodeBench's data: fetch, decode, read back, window.

LiveCodeBench is the one benchmark that is fetched (datasets.py says why the
others are vendored). Its six release files are pinned in the adapter's
`[fetch]`: the dataset commit, and per increment the LFS SHA-256, byte size,
item count and contest-date range. The user picks which increments to fetch.

Fetching one increment:

1. Stream the file from the pinned commit to disk, hashing as it goes, and
   refuse it if the hash differs from the pin. It is never held in memory:
   test.jsonl alone is 1.25 GB.
2. Decode it line by line, once:
   - `items.jsonl` gets each problem's metadata, prompt fields and public
     tests;
   - `tests/<platform>/<question_id>.json.gz` gets its private tests.
3. Delete the raw file, and rename the increment's directory into place.
   The manifest is written last, so a fetch that fails or is cancelled
   leaves the increments already there untouched.

Private tests are `base64(zlib(pickle(str)))`, where the str is JSON. They
are unpickled here, at fetch time, by an unpickler that refuses every global,
so a pickle can build only plain values, and nothing is ever unpickled when
an answer is graded.

    <base>/livecodebench/MANIFEST.json            increments present, and when
    <base>/livecodebench/<increment>/items.jsonl
    <base>/livecodebench/<increment>/tests/<platform>/<question_id>.json.gz
"""

from __future__ import annotations

import base64
import datetime as dt
import gzip
import hashlib
import io
import json
import os
import pickle
import re
import shutil
import time
import urllib.request
import zlib
from collections.abc import Callable
from pathlib import Path

from local_llm.benchmarks.evaluation.datasets import DatasetError, datasets_base_dir

UA = {'User-Agent': 'local-llm/benchmarks (https://github.com/epittman23/local-llm)'}

# Seconds to wait on a stalled connection; a slow one is fine.
TIMEOUT = 120
CHUNK = 4 << 20

# A platform or question id becomes part of a path, so only these.
_PLATFORM = re.compile(r'^[a-z]+$')
_QUESTION = re.compile(r'^[A-Za-z0-9_.-]{1,80}$')
# The largest decompressed private-test payload accepted: the biggest
# problems in release_v6 decompress to tens of MB.
MAX_TESTS_BYTES = 1 << 30


class Cancelled(Exception):
    """The fetch was cancelled between chunks; nothing of the increment was kept."""


# ---------------------------------------------------------------------------
# where things are
# ---------------------------------------------------------------------------
def bench_dir(adapter: dict, base: Path | None = None) -> Path:
    return (base or datasets_base_dir()) / adapter['id']


def increments(adapter: dict) -> list[dict]:
    """The pinned increments, in release order."""
    return list(adapter['fetch']['increment'])


def _stem(name: str) -> str:
    return name.removesuffix('.jsonl')


def read_manifest(adapter: dict, base: Path | None = None) -> dict | None:
    path = bench_dir(adapter, base) / 'MANIFEST.json'
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def present(adapter: dict, base: Path | None = None) -> dict[str, dict]:
    """name -> manifest entry, for each increment on disk."""
    manifest = read_manifest(adapter, base) or {}
    return dict(manifest.get('increments') or {})


def identity(adapter: dict, base: Path | None = None) -> dict | None:
    """What dataset_identity() reports: the pinned commit, and a hash over the increments present."""
    manifest = read_manifest(adapter, base)
    if not manifest or not manifest.get('increments'):
        return None
    shas = sorted(entry['sha256'] for entry in manifest['increments'].values())
    return {
        **{k: v for k, v in manifest.items() if k != 'increments'},
        'increments': manifest['increments'],
        'n_items': sum(entry['items'] for entry in manifest['increments'].values()),
        'content_sha256': hashlib.sha256('\n'.join(shas).encode()).hexdigest(),
    }


def read_items(adapter: dict, base: Path | None = None) -> list[dict]:
    """Every fetched problem, increment by increment in release order."""
    have = present(adapter, base)
    if not have:
        raise DatasetError(
            f'{adapter["id"]} is not downloaded yet: fetch an increment from the Tests page (Datasets, Fetch)'
        )
    out: list[dict] = []
    for inc in increments(adapter):
        if inc['name'] not in have:
            continue
        path = bench_dir(adapter, base) / _stem(inc['name']) / 'items.jsonl'
        for line in path.read_text().splitlines():
            if line.strip():
                out.append(json.loads(line))
    return out


def private_tests(adapter: dict, item: dict, base: Path | None = None) -> list[dict]:
    """A problem's private tests, decoded at fetch time."""
    platform, question = item['platform'], item['question_id']
    if not _PLATFORM.match(platform) or not _QUESTION.match(question):
        raise DatasetError(f'not a LiveCodeBench problem id: {platform}/{question}')
    path = bench_dir(adapter, base) / _stem(item['increment']) / 'tests' / platform / f'{question}.json.gz'
    try:
        return json.loads(gzip.decompress(path.read_bytes()))
    except OSError as exc:
        raise DatasetError(f'the private tests of {platform}/{question} are missing: {exc}') from exc


# ---------------------------------------------------------------------------
# decoding
# ---------------------------------------------------------------------------
class _NoGlobals(pickle.Unpickler):
    """Builds plain values only: any class or function a pickle names is refused."""

    def find_class(self, module, name):
        raise pickle.UnpicklingError(f'refusing to load {module}.{name} from a LiveCodeBench test payload')


def decode_private_tests(encoded: str) -> list[dict]:
    """LiveCodeBench's private_test_cases: plain JSON, or base64(zlib(pickle(json str)))."""
    try:
        value = json.loads(encoded)
    except ValueError:
        packed = base64.b64decode(encoded.encode('utf-8'))
        inflater = zlib.decompressobj()
        raw = inflater.decompress(packed, MAX_TESTS_BYTES)
        if inflater.unconsumed_tail:
            raise DatasetError('a private-test payload decompresses past the size limit') from None
        text = _NoGlobals(io.BytesIO(raw)).load()
        if not isinstance(text, str):
            raise DatasetError(f'a private-test payload holds a {type(text).__name__}, not a string') from None
        value = json.loads(text)
    if not isinstance(value, list) or not all(isinstance(t, dict) for t in value):
        raise DatasetError('private tests are not a list of tests')
    return [{'input': t['input'], 'output': t['output'], 'testtype': t['testtype']} for t in value]


def decode_row(row: dict, increment: str) -> tuple[dict, list[dict]]:
    """(the items.jsonl row, its private tests) for one line of a release file."""
    platform, question = row['platform'], str(row['question_id'])
    if not _PLATFORM.match(platform) or not _QUESTION.match(question):
        raise DatasetError(f'not a LiveCodeBench problem id: {platform}/{question}')
    public = json.loads(row['public_test_cases'])
    item = {
        'id': f'{platform}/{question}',
        'question_title': row['question_title'],
        'question_content': row['question_content'],
        'platform': platform,
        'question_id': question,
        'contest_id': row['contest_id'],
        'contest_date': row['contest_date'],
        'starter_code': row['starter_code'],
        'difficulty': row['difficulty'],
        'metadata': json.loads(row['metadata'] or '{}'),
        'public_test_cases': [{'input': t['input'], 'output': t['output'], 'testtype': t['testtype']} for t in public],
        'increment': increment,
    }
    return item, decode_private_tests(row['private_test_cases'])


# ---------------------------------------------------------------------------
# fetching
# ---------------------------------------------------------------------------
def _url(adapter: dict, name: str) -> str:
    spec = adapter['fetch']
    return f'https://huggingface.co/datasets/{spec["dataset"]}/resolve/{spec["revision"]}/{name}'


def _download(url: str, dest: Path, inc: dict, progress, should_stop) -> None:
    digest = hashlib.sha256()
    done = 0
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp, open(dest, 'wb') as out:
        last = 0.0
        while True:
            if should_stop():
                raise Cancelled()
            chunk = resp.read(CHUNK)
            if not chunk:
                break
            digest.update(chunk)
            out.write(chunk)
            done += len(chunk)
            if time.monotonic() - last > 1.0:
                last = time.monotonic()
                progress(f'{inc["name"]}: {done / 2**20:.0f} of {inc["bytes"] / 2**20:.0f} MiB')
    actual = digest.hexdigest()
    if actual != inc['sha256']:
        raise DatasetError(
            f'{inc["name"]} does not match its pinned hash (sha256 {actual[:12]}, expected {inc["sha256"][:12]})'
        )


def _decode_file(raw: Path, work: Path, inc: dict, progress, should_stop) -> int:
    n = 0
    with open(raw, encoding='utf-8') as src, open(work / 'items.jsonl', 'w') as items:
        for line in src:
            if not line.strip():
                continue
            if should_stop():
                raise Cancelled()
            item, tests = decode_row(json.loads(line), inc['name'])
            folder = work / 'tests' / item['platform']
            folder.mkdir(parents=True, exist_ok=True)
            (folder / f'{item["question_id"]}.json.gz').write_bytes(gzip.compress(json.dumps(tests).encode(), 6))
            items.write(json.dumps(item, sort_keys=True) + '\n')
            n += 1
            if n % 25 == 0:
                progress(f'{inc["name"]}: decoded {n} of {inc["items"]} problems')
    if n != inc['items']:
        raise DatasetError(f'{inc["name"]} holds {n} problems, not the {inc["items"]} pinned')
    return n


def fetch(
    adapter: dict,
    names: list[str],
    *,
    force: bool = False,
    base: Path | None = None,
    progress: Callable[[str], None] = lambda message: None,
    should_stop: Callable[[], bool] = lambda: False,
) -> dict:
    """Fetch these increments, skipping the ones present unless forced. Returns the identity."""
    pinned = {inc['name']: inc for inc in increments(adapter)}
    unknown = [n for n in names if n not in pinned]
    if unknown:
        raise DatasetError(f'{adapter["id"]} has no increment {", ".join(map(repr, unknown))}')
    root = bench_dir(adapter, base)
    root.mkdir(parents=True, exist_ok=True)
    for name in names:
        inc = pinned[name]
        if name in present(adapter, base) and not force:
            progress(f'{name}: already downloaded')
            continue
        work = root / f'.{_stem(name)}.partial'
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir()
        try:
            raw = work / name
            progress(f'{name}: downloading {inc["bytes"] / 2**20:.0f} MiB')
            _download(_url(adapter, name), raw, inc, progress, should_stop)
            _decode_file(raw, work, inc, progress, should_stop)
            raw.unlink()
            final = root / _stem(name)
            shutil.rmtree(final, ignore_errors=True)
            os.replace(work, final)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        _record(adapter, base, inc)
        progress(f'{name}: {inc["items"]} problems from {inc["first"]} to {inc["last"]}')
    return identity(adapter, base) or {}


def _record(adapter: dict, base: Path | None, inc: dict) -> None:
    manifest = read_manifest(adapter, base) or {
        'benchmark': adapter['id'],
        'name': adapter.get('name', adapter['id']),
        'license': adapter.get('license', 'unknown'),
        'homepage': adapter.get('homepage', ''),
        'citation': adapter.get('citation', ''),
        'source_url': f'https://huggingface.co/datasets/{adapter["fetch"]["dataset"]}',
        'revision': adapter['fetch']['revision'],
        'increments': {},
    }
    manifest['increments'][inc['name']] = {
        'sha256': inc['sha256'],
        'items': inc['items'],
        'first': inc['first'],
        'last': inc['last'],
        'fetched_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    manifest['fetched_at'] = manifest['increments'][inc['name']]['fetched_at']
    path = bench_dir(adapter, base) / 'MANIFEST.json'
    tmp = path.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(manifest, indent=2) + '\n')
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# the release-date window
# ---------------------------------------------------------------------------
def parse_window(window_min: str | None, window_max: str | None) -> tuple[dt.date, dt.date | None] | None:
    """(min, max or None) from the run form's two dates, or None when neither is given."""
    if not window_min:
        if window_max:
            raise ValueError('a release-date window needs its first date (window_min)')
        return None
    lo = dt.date.fromisoformat(window_min)
    hi = dt.date.fromisoformat(window_max) if window_max else None
    if hi is not None and hi < lo:
        raise ValueError(f'the window ends ({hi}) before it starts ({lo})')
    return lo, hi


def window_text(window: tuple[dt.date, dt.date | None]) -> str:
    """The form recorded in benchmark_result.item_window."""
    lo, hi = window
    return f'{lo.isoformat()}..{hi.isoformat() if hi else ""}'


def needed(adapter: dict, window: tuple[dt.date, dt.date | None]) -> list[str]:
    """Every increment whose pinned date range touches the window.

    All of them, not just enough to span it: the ranges overlap (test4 reaches
    back to 2023-08-26), so a window can draw problems from several, and the
    pool must not depend on which increments happen to be fetched.
    """
    lo, hi = window
    out = []
    for inc in increments(adapter):
        first, last = dt.date.fromisoformat(inc['first']), dt.date.fromisoformat(inc['last'])
        if last >= lo and (hi is None or first <= hi):
            out.append(inc['name'])
    return out


def in_window(item: dict, field: str, window: tuple[dt.date, dt.date | None]) -> bool:
    day = dt.date.fromisoformat(str(item[field])[:10])
    lo, hi = window
    return lo <= day and (hi is None or day <= hi)
