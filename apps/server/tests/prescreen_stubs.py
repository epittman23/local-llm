"""Stand-ins for the pre-screen's tests: fake binaries, in-memory tables, a profile.

Nothing here loads a model or touches a GPU. The fake `llama-bench`,
`llama-server` and `nvidia-smi` are small Python scripts written into a
test's temporary directory and run as real subprocesses, so the pre-screen's
process handling (its own group, timeouts, cancellation, OOM text, a
signal) is exercised for real, in the spirit of Tune's LLAMA_TUNE_LAUNCH.

The JSONL the fake llama-bench prints comes from llama_bench_synthetic.py
and is synthetic, not recorded on this machine.
"""

from __future__ import annotations

import json
import os
import sys
import textwrap
import time
from pathlib import Path

from local_llm.benchmarks.serving.profiles import ServingProfile
from local_llm.models.benchmarks.prescreen import (
    POINT_UPDATABLE,
    SWEEP_UPDATABLE,
    BenchmarkPrescreenPointModel,
    BenchmarkPrescreenSweepModel,
)

# ---------------------------------------------------------------------------
# fake binaries
# ---------------------------------------------------------------------------
LLAMA_BENCH = '''\
"""Fake llama-bench. Behaviour comes from STUB_* environment variables:

STUB_LOG          a file each invocation's argv is appended to, as JSON
STUB_OOM_NGL      runs out of memory at -ngl >= this
STUB_OOM_MOE      runs out of memory at -ncmoe <= this
STUB_MODE         hang (sleep, with a child, until killed), crash (SIGSEGV),
                  garbage (unparseable output), load_error
STUB_SLOW         seconds to sleep before answering
"""
import json, os, signal, subprocess, sys, time
sys.path.insert(0, {stubs_dir!r})
from llama_bench_synthetic import jsonl_line

argv = sys.argv[1:]
def flag(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default

if os.environ.get('STUB_LOG'):
    with open(os.environ['STUB_LOG'], 'a') as fh:
        fh.write(json.dumps(argv) + '\\n')
ngl = int(flag('-ngl', '99')); moe = int(flag('-ncmoe', '0'))
mode = os.environ.get('STUB_MODE', '')
if os.environ.get('STUB_SLOW'):
    time.sleep(float(os.environ['STUB_SLOW']))
if mode == 'hang':
    subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)', 'llama-bench-stub-child'])
    time.sleep(600)
if mode == 'crash':
    os.kill(os.getpid(), signal.SIGSEGV)
if mode == 'load_error':
    print("main: error: failed to load model '/models/model.gguf'", file=sys.stderr); sys.exit(1)
oom_ngl = os.environ.get('STUB_OOM_NGL'); oom_moe = os.environ.get('STUB_OOM_MOE')
if (oom_ngl and ngl >= int(oom_ngl)) or (oom_moe and '-ncmoe' in argv and moe <= int(oom_moe)):
    print('ggml_backend_cuda_buffer_type_alloc_buffer: allocating 512.00 MiB on device 0: '
          'cudaMalloc failed: out of memory', file=sys.stderr)
    print("main: error: failed to create context with model '/models/model.gguf'", file=sys.stderr)
    sys.exit(1)
if mode == 'garbage':
    print('not json'); sys.exit(0)
batch = int(flag('-b')); ubatch = int(flag('-ub')); threads = int(flag('-t'))
common = dict(ngl=ngl, moe=moe, batch=batch, ubatch=ubatch, threads=threads,
              type_k=flag('-ctk'), type_v=flag('-ctv'))
pp = 100.0 + ubatch / 10 + ngl
tg = 5.0 + ngl / 10 + (40 - moe) / 10 - abs(threads - 7) / 20
print(jsonl_line(n_prompt=int(flag('-p')), n_gen=0, avg_ts=pp, **common))
print(jsonl_line(n_prompt=0, n_gen=int(flag('-n')), avg_ts=tg, **common))
'''

LLAMA_SERVER = '''\
"""Fake llama-server for the load check: /health answers 200 once "loaded".

Runs out of memory when -c exceeds STUB_SERVER_MAX_CTX.
"""
import http.server, os, sys
argv = sys.argv[1:]
def flag(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default
if '--version' in argv:
    print('version: 11875 (f0fb5984b)'); sys.exit(0)
ctx = int(flag('-c', '0'))
limit = os.environ.get('STUB_SERVER_MAX_CTX')
if limit and ctx > int(limit):
    print('cudaMalloc failed: out of memory', flush=True)
    print('llama_init_from_model: failed to initialize the context', flush=True)
    sys.exit(1)
print('main: model loaded', flush=True)

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == '/health' else 404)
        self.end_headers()
        self.wfile.write(b'{"status":"ok"}')
    def log_message(self, *args):
        pass

http.server.HTTPServer(('127.0.0.1', int(flag('--port'))), Handler).serve_forever()
'''

NVIDIA_SMI = """\
import sys
query = next(a for a in sys.argv if a.startswith('--query-gpu='))
if 'driver_version' in query:
    print('590.48.01, 6144')
else:
    print('55, 80, 4100, 6144, 60.5, 1500, 0x0000000000000004')
"""


def _script(path: Path, body: str) -> Path:
    path.write_text(f'#!{sys.executable}\n' + textwrap.dedent(body))
    path.chmod(0o755)
    return path


def install_binaries(bin_dir: Path) -> Path:
    """Fake llama-bench, llama-server and nvidia-smi in `bin_dir`."""
    bin_dir.mkdir(parents=True, exist_ok=True)
    stubs_dir = str(Path(__file__).resolve().parent)
    _script(bin_dir / 'llama-bench', LLAMA_BENCH.format(stubs_dir=stubs_dir))
    _script(bin_dir / 'llama-server', LLAMA_SERVER)
    _script(bin_dir / 'nvidia-smi', NVIDIA_SMI)
    return bin_dir


def invocations(log: Path) -> list[list[str]]:
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text().splitlines() if line.strip()]


def stub_processes(marker: str = 'llama-bench') -> list[int]:
    """Pids of live processes whose command line mentions `marker`, this test's stubs among them."""
    pids = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        try:
            cmdline = (entry / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
            state = (entry / 'stat').read_text().split()[2]
        except OSError:
            continue
        if marker in cmdline and state != 'Z':
            pids.append(int(entry.name))
    return pids


# ---------------------------------------------------------------------------
# a profile, and the two tables, in memory
# ---------------------------------------------------------------------------
class Entry:
    """Enough of BenchmarkProfileEntry for the pre-screen."""

    def __init__(self, profile: ServingProfile, version_id: int = 7):
        self._profile = profile
        self.profile = type('P', (), {'name': profile.name})()
        self.version = type('V', (), {'version_id': version_id})()

    def to_serving_profile(self) -> ServingProfile:
        return self._profile


class Profiles:
    def __init__(self, *entries: Entry):
        self.entries = {e.profile.name: e for e in entries}

    async def get_by_name(self, name):
        return self.entries.get(name)

    async def get_default(self):
        return next(iter(self.entries.values()), None)


class Sweeps:
    def __init__(self):
        self.rows: dict[str, dict] = {}

    @staticmethod
    def new_id() -> str:
        return f'{int(time.time())}-{os.urandom(3).hex()}'

    async def open_sweep(self, sweep_id, **fields):
        self.rows[sweep_id] = {'sweep_id': sweep_id, 'started_at': int(time.time()), 'status': 'running', **fields}
        return sweep_id

    async def set_sweep(self, sweep_id, **fields):
        self.rows[sweep_id].update({k: v for k, v in fields.items() if k in SWEEP_UPDATABLE})

    async def close_sweep(self, sweep_id, *, status, reason=None):
        row = self.rows.get(sweep_id)
        if row and row['status'] == 'running':
            row.update(status=status, status_reason=reason, ended_at=int(time.time()))

    async def get_by_id(self, sweep_id):
        row = self.rows.get(sweep_id)
        return BenchmarkPrescreenSweepModel(**row) if row else None

    async def list_sweeps(self, limit=20, *, running_only=False):
        rows = [r for r in self.rows.values() if not running_only or r['status'] == 'running']
        return [BenchmarkPrescreenSweepModel(**r) for r in rows][:limit]


class Points:
    def __init__(self):
        self.rows: dict[int, dict] = {}

    async def open_point(
        self,
        sweep_id,
        *,
        phase,
        overrides,
        is_baseline=False,
        optuna_trial_number=None,
        remeasure_of=None,
        config_id=None,
        status='running',
        **fields,
    ):
        point_id = len(self.rows) + 1
        self.rows[point_id] = {
            'point_id': point_id,
            'sweep_id': sweep_id,
            'phase': phase,
            'overrides': overrides,
            'is_baseline': is_baseline,
            'optuna_trial_number': optuna_trial_number,
            'remeasure_of': remeasure_of,
            'config_id': config_id,
            'status': status,
            'started_at': int(time.time()),
            **{k: v for k, v in fields.items() if k in POINT_UPDATABLE},
        }
        return point_id

    async def set_point(self, point_id, **fields):
        self.rows[point_id].update({k: v for k, v in fields.items() if k in POINT_UPDATABLE})

    async def sweep_points(self, sweep_id):
        return [BenchmarkPrescreenPointModel(**r) for r in self.rows.values() if r['sweep_id'] == sweep_id]

    def by_status(self, status: str) -> list[dict]:
        return [r for r in self.rows.values() if r['status'] == status]
