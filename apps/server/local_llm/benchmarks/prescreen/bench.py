"""benchmarks/prescreen/bench.py - one llama-bench point: its command, its run, its outcome.

One llama-bench process per point, never one process over a list of
values. On a failed load or context llama-bench returns 1 and abandons
every remaining value, and docs/guides/llama-cpp.md records GPU allocations
retained across reloads within one process under WSL2.

`build_argv` maps a `ResolvedConfig`, the same object the launcher serves,
onto llama-bench's flags, so a point is a serving configuration minus what
llama-bench cannot measure (speculation, the reasoning budget, the context
size). `run_point` runs it in a process group of its own, samples the GPU
while it runs, and classifies how it ended. `parse_jsonl` reads the
`-o jsonl` output: one line per test, the prompt-processing test and the
generation test apart.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import platform
import signal
import subprocess
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

from local_llm.benchmarks.analysis import stats
from local_llm.benchmarks.prescreen import PrescreenRefused
from local_llm.benchmarks.serving.gpu import sample_gpu
from local_llm.benchmarks.serving.launcher import resolve_model_path
from local_llm.benchmarks.serving.profiles import ResolvedConfig
from local_llm.benchmarks.tuning.tune_probe import OOM_PATTERN

#: llama-bench's own messages for the two failures that end it early
#: (tools/llama-bench/llama-bench.cpp at f0fb5984b). Without OOM text beside
#: them they mean the configuration could not be loaded at all.
LOAD_ERROR_MARKERS = ('failed to load model', 'failed to create context')

#: What the pre-screen reads from each JSONL line, and the request flag each
#: one must agree with. A disagreement means llama-bench measured something
#: other than the point, so the point is not recorded as measured.
ECHOED = {
    'n_gpu_layers': '-ngl',
    'n_cpu_moe': '-ncmoe',
    'n_batch': '-b',
    'n_ubatch': '-ub',
    'n_threads': '-t',
    'type_k': '-ctk',
    'type_v': '-ctv',
}

STDERR_TAIL_LINES = 40


def llama_bench_path(llama_bin: str | None = None) -> Path:
    """`llama-bench` beside `llama-server`, in LLAMA_BIN, as the launcher finds it."""
    base = llama_bin or os.environ.get('LLAMA_BIN') or str(Path.home() / 'llama.cpp/build/bin')
    return Path(base) / 'llama-bench'


def bench_override_tensors(override_tensors: str) -> str:
    """llama-server's `-ot` value in llama-bench's spelling.

    llama-server separates overrides with `,`. llama-bench reads `,` as the
    start of another value to sweep and separates the overrides within one
    value with `;` (tools/llama-bench/llama-bench.cpp at f0fb5984b), so
    `qwen38`'s two pins passed verbatim would be two tests with one pin each.
    llama-server's own parser splits on every `,`, so no pattern a profile can
    hold contains one.
    """
    return override_tensors.replace(',', ';')


def build_argv(
    config: ResolvedConfig, *, n_prompt: int, n_gen: int, reps: int, llama_models: str | None = None
) -> list[str]:
    """The llama-bench arguments that measure this configuration.

    The fixed flags come from the resolved profile, so a point maps onto a
    configuration the Serve page can serve. `-p`, `-n` and `-r` are the
    sweep's own settings, recorded on its row.
    """
    if config.flash_attn.startswith('legacy '):
        raise PrescreenRefused('the legacy --flash-attn spelling has no llama-bench equivalent')
    model = resolve_model_path(config.model_path, llama_models=llama_models)
    if ',' in model:
        # llama-bench would read it as two models.
        raise PrescreenRefused(f'llama-bench cannot take a model path containing a comma: {model}')
    args = ['-m', model, '-ngl', str(config.ngl)]
    if config.moe is not None:
        args += ['-ncmoe', str(config.moe)]
    args += [
        '-b',
        str(config.batch),
        '-ub',
        str(config.ubatch),
        '-t',
        str(config.threads),
        '-ctk',
        config.cache_k,
        '-ctv',
        config.cache_v,
        '-fa',
        config.flash_attn,
    ]
    if config.override_tensors:
        args += ['-ot', bench_override_tensors(config.override_tensors)]
    args += ['-p', str(n_prompt), '-n', str(n_gen), '-r', str(reps), '-o', 'jsonl']
    return args


class ParseError(ValueError):
    pass


def _flag(argv: list[str], flag: str) -> str | None:
    try:
        return argv[argv.index(flag) + 1]
    except (ValueError, IndexError):
        return None


def parse_jsonl(text: str, argv: list[str] | None = None) -> dict:
    """llama-bench's `-o jsonl` output, as one dict for the point.

    `pp` and `tg` are the prompt-processing and generation tests, each with
    `avg_ts`, `stddev_ts` and `samples_ts` (tokens per second over the
    repetitions). The build, GPU and CPU are read from the first line. With
    `argv`, every flag the output echoes must match what was asked.
    """
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as e:
            raise ParseError(f'not JSON: {line[:120]}') from e
        if not isinstance(row, dict):
            raise ParseError(f'not a JSON object: {line[:120]}')
        rows.append(row)
    if not rows:
        raise ParseError('no output')

    tests: dict[str, dict] = {}
    for row in rows:
        try:
            n_prompt, n_gen = int(row['n_prompt']), int(row['n_gen'])
            avg, sd = float(row['avg_ts']), float(row['stddev_ts'])
            samples = [float(v) for v in row.get('samples_ts') or []]
        except (KeyError, TypeError, ValueError) as e:
            raise ParseError(f'missing or malformed field: {e}') from e
        kind = 'pp' if n_prompt > 0 and n_gen == 0 else 'tg' if n_gen > 0 and n_prompt == 0 else None
        if kind is None:
            raise ParseError(f'a test that is neither prompt processing nor generation (pp {n_prompt}, tg {n_gen})')
        if kind in tests:
            raise ParseError(f'two {kind} tests in one point')
        tests[kind] = {'avg_ts': avg, 'stddev_ts': sd, 'samples_ts': samples}
        if argv is not None:
            for key, flag in ECHOED.items():
                asked = _flag(argv, flag)
                if asked is None or key not in row:
                    continue
                if str(row[key]) != asked:
                    raise ParseError(f'llama-bench measured {key} {row[key]}, not the {asked} asked for')
    missing = [k for k in ('pp', 'tg') if k not in tests]
    if missing:
        raise ParseError(f'no {" or ".join(missing)} test in the output')

    first = rows[0]

    def as_int(value):
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    return {
        **tests,
        'build_commit': first.get('build_commit') or None,
        'build_number': as_int(first.get('build_number')),
        'gpu_info': first.get('gpu_info') or None,
        'cpu_info': first.get('cpu_info') or None,
    }


@dataclass
class PointResult:
    status: str
    reason: str | None = None
    returncode: int | None = None
    stdout: str = ''
    stderr_tail: str = ''
    parsed: dict | None = None
    peak_vram_mib: int | None = None
    peak_power_w: float | None = None
    peak_temp_c: int | None = None
    throttle_reasons: str | None = None
    samples: list[dict] = field(default_factory=list)


def classify(
    returncode: int | None, *, stdout: str, stderr: str, timed_out: bool, cancelled: bool, argv: list[str]
) -> tuple[str, str | None, dict | None]:
    """How a point ended, as (status, reason, parsed output).

    OOM is a recorded outcome, not an error: an OOM prunes a region of the
    grid, a load error is a bug in the grid or the build, a crash is the
    process dying of a signal, and a timeout may be a cold page cache. They
    are kept apart so a reader can tell "this does not fit" from "this was
    never actually tried".
    """
    tail = ' / '.join([ln for ln in stderr.strip().splitlines() if ln.strip()][-3:])[:400] or None
    if cancelled:
        return 'cancelled', 'cancelled', None
    if timed_out:
        return 'timeout', 'no result within the point timeout', None
    if returncode != 0 and OOM_PATTERN.search(stderr):
        return 'oom', tail, None
    if returncode is not None and returncode < 0:
        try:
            name = signal.Signals(-returncode).name
        except ValueError:
            name = f'signal {-returncode}'
        return 'crash', f'killed by {name}' + (f': {tail}' if tail else ''), None
    if returncode != 0:
        marker = next((m for m in LOAD_ERROR_MARKERS if m in stderr), None)
        return 'load_error', tail or (marker and f'llama-bench: {marker}') or f'exit {returncode}', None
    try:
        return 'ok', None, parse_jsonl(stdout, argv)
    except ParseError as e:
        return 'parse_error', str(e), None


def _kill_group(pgid: int, sig: int) -> None:
    with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
        os.killpg(pgid, sig)


async def _stop(proc: asyncio.subprocess.Process, grace: float) -> None:
    """SIGTERM to the whole group, then SIGKILL if it outlives `grace`."""
    _kill_group(proc.pid, signal.SIGTERM)
    try:
        await asyncio.wait_for(proc.wait(), timeout=grace)
    except TimeoutError:
        _kill_group(proc.pid, signal.SIGKILL)
        await proc.wait()
    # Anything the leader left behind in its group.
    _kill_group(proc.pid, signal.SIGKILL)


async def run_point(
    binary: Path,
    argv: list[str],
    *,
    point_timeout: float,
    cancel: asyncio.Event,
    on_spawn: Callable[[int], Awaitable[None]] | None = None,
    nvidia_smi: str = 'nvidia-smi',
    sample_interval: float = 1.0,
    grace: float = 5.0,
) -> PointResult:
    """Run one llama-bench command to its end, `point_timeout` seconds, or `cancel`.

    `start_new_session=True` gives the process a group of its own, so a
    cancel, a timeout or a backend shutdown signals the whole tree. The
    group is killed on every way out, a cancelled task included, so no point
    is left holding VRAM. `on_spawn` receives the group id as soon as it
    exists, for the point's row, so a later backend can find an orphan.
    """
    if not os.access(binary, os.X_OK):
        raise PrescreenRefused(f'llama-bench not found at {binary}')
    proc = await asyncio.create_subprocess_exec(
        str(binary),
        *argv,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    stdout, stderr = proc.stdout, proc.stderr
    if stdout is None or stderr is None:  # both are PIPE above
        raise RuntimeError('llama-bench started without its output pipes')
    result = PointResult(status='running')
    stderr_tail: deque[str] = deque(maxlen=STDERR_TAIL_LINES)
    # The OOM line can be far from the end, so markers are checked as lines
    # arrive rather than in the kept tail alone.
    seen: list[str] = []

    async def read_stdout() -> str:
        return (await stdout.read()).decode(errors='replace')

    async def read_stderr() -> None:
        async for raw in stderr:
            line = raw.decode(errors='replace').rstrip('\n')
            stderr_tail.append(line)
            if OOM_PATTERN.search(line) or any(m in line for m in LOAD_ERROR_MARKERS):
                seen.append(line)

    async def sample() -> None:
        while True:
            reading = await asyncio.to_thread(sample_gpu, nvidia_smi)
            if reading is not None:
                result.samples.append(reading)
            await asyncio.sleep(sample_interval)

    out_task = asyncio.create_task(read_stdout())
    err_task = asyncio.create_task(read_stderr())
    sampler = asyncio.create_task(sample())
    waiter = asyncio.create_task(proc.wait())
    stopper = asyncio.create_task(cancel.wait())
    timed_out = cancelled = False
    try:
        if on_spawn is not None:
            await on_spawn(proc.pid)
        done, _ = await asyncio.wait({waiter, stopper}, timeout=point_timeout, return_when=asyncio.FIRST_COMPLETED)
        if waiter not in done:
            cancelled = stopper in done
            timed_out = not cancelled
            await _stop(proc, grace)
        result.returncode = await waiter
        result.stdout = await out_task
        await err_task
    finally:
        sampler.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await sampler
        if proc.returncode is None:
            # Cancelled from outside (a backend shutdown): the group goes too.
            _kill_group(proc.pid, signal.SIGKILL)
            with contextlib.suppress(Exception):
                await proc.wait()
        for task in (stopper, out_task, err_task):
            task.cancel()

    stderr_text = '\n'.join([*seen, *stderr_tail])
    result.stderr_tail = '\n'.join(stderr_tail)
    result.status, result.reason, result.parsed = classify(
        result.returncode,
        stdout=result.stdout,
        stderr=stderr_text,
        timed_out=timed_out,
        cancelled=cancelled,
        argv=argv,
    )
    _peaks(result)
    return result


def _peaks(result: PointResult) -> None:
    samples = result.samples
    if not samples:
        return

    def peak(key):
        values = [s[key] for s in samples if s.get(key) is not None]
        return max(values) if values else None

    result.peak_vram_mib = peak('mem_used_mib')
    result.peak_power_w = peak('power_w')
    result.peak_temp_c = peak('temp_c')
    result.throttle_reasons = stats.throttle_reasons(samples) or None


# ---------------------------------------------------------------------------
# the host, recorded once per sweep
# ---------------------------------------------------------------------------
def host_info(nvidia_smi: str = 'nvidia-smi') -> dict:
    """Driver version, VRAM and RAM totals, and the kernel: what llama-bench's
    own output does not record. Each is None when it cannot be read."""
    info: dict = {'driver_version': None, 'vram_total_mib': None, 'ram_total_mib': None, 'kernel': platform.release()}
    try:
        out = subprocess.run(
            [nvidia_smi, '--query-gpu=driver_version,memory.total', '--format=csv,noheader,nounits'],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if out.returncode == 0 and out.stdout.strip():
            parts = [p.strip() for p in out.stdout.strip().splitlines()[0].split(',')]
            if len(parts) >= 2:
                info['driver_version'] = parts[0] or None
                with contextlib.suppress(ValueError):
                    info['vram_total_mib'] = int(float(parts[1]))
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        with open('/proc/meminfo') as fh:
            for line in fh:
                if line.startswith('MemTotal:'):
                    info['ram_total_mib'] = int(line.split()[1]) // 1024
                    break
    except (OSError, ValueError, IndexError):
        pass
    return info
