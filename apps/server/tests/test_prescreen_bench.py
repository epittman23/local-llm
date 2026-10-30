"""benchmarks/prescreen/bench.py: llama-bench's command, its output, and how a point ends.

The command and the parsing are pure. `run_point` is run against the fake
llama-bench in prescreen_stubs.py, a real subprocess that succeeds, runs
out of memory, hangs or dies of a signal on request, so the process-group
handling is exercised for real without a GPU. The JSONL is synthetic (see
llama_bench_synthetic.py).

Run from apps/server:

    python -m pytest tests/test_prescreen_bench.py
"""

from __future__ import annotations

import asyncio
import dataclasses
import time

import pytest
from llama_bench_synthetic import FIELDS, jsonl_line
from prescreen_stubs import install_binaries, stub_processes

from local_llm.benchmarks.prescreen import PrescreenRefused, bench
from local_llm.benchmarks.serving.profiles import ServingProfile, resolve

QWEN38 = ServingProfile(
    name='qwen38',
    arch='dense',
    alias='qwen3.8-27b',
    model_path='{LLAMA_MODELS}/qwen38/Qwen3.8-27B-UD-Q3_K_XL.gguf',
    ctx=16384,
    threads=12,
    ngl=20,
    override_tensors=r'output\.weight=CUDA0,blk\.64\..*=CUDA0',
)
QWEN36 = ServingProfile(
    name='qwen36',
    arch='moe',
    alias='qwen3.6-35b-a3b',
    model_path='{LLAMA_MODELS}/qwen36/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf',
    ctx=65536,
    threads=6,
    ngl=99,
    moe=34,
)


def test_argv_for_a_dense_profile_with_tensor_pins():
    argv = bench.build_argv(resolve(QWEN38), n_prompt=512, n_gen=128, reps=5, llama_models='/m')
    assert argv == [
        '-m',
        '/m/qwen38/Qwen3.8-27B-UD-Q3_K_XL.gguf',
        '-ngl',
        '20',
        '-b',
        '512',
        '-ub',
        '512',
        '-t',
        '12',
        '-ctk',
        'q8_0',
        '-ctv',
        'q8_0',
        '-fa',
        'on',
        '-ot',
        r'output\.weight=CUDA0;blk\.64\..*=CUDA0',
        '-p',
        '512',
        '-n',
        '128',
        '-r',
        '5',
        '-o',
        'jsonl',
    ]


def test_argv_for_a_moe_profile_carries_n_cpu_moe():
    argv = bench.build_argv(resolve(QWEN36), n_prompt=256, n_gen=64, reps=3, llama_models='/m')
    assert argv[argv.index('-ngl') + 1] == '99'
    assert argv[argv.index('-ncmoe') + 1] == '34'
    assert '-ot' not in argv
    assert argv[-8:] == ['-p', '256', '-n', '64', '-r', '3', '-o', 'jsonl']


def test_tensor_pins_use_llama_benchs_separator():
    """A `,` would make llama-bench run one test per pin instead of one test with both."""
    assert bench.bench_override_tensors('a=CUDA0,b=CPU') == 'a=CUDA0;b=CPU'


def test_what_llama_bench_cannot_take_is_refused():
    legacy = dataclasses.replace(resolve(QWEN36), flash_attn='legacy --flash-attn 1')
    with pytest.raises(PrescreenRefused, match='legacy'):
        bench.build_argv(legacy, n_prompt=1, n_gen=1, reps=1)
    comma = dataclasses.replace(resolve(QWEN36), model_path='/m/a,b.gguf')
    with pytest.raises(PrescreenRefused, match='comma'):
        bench.build_argv(comma, n_prompt=1, n_gen=1, reps=1)


def test_the_synthetic_line_carries_every_field_llama_bench_prints():
    import json

    row = json.loads(jsonl_line(n_prompt=512, n_gen=0, avg_ts=100.0))
    assert list(row)[: len(FIELDS)] == FIELDS
    assert set(row) - set(FIELDS) == {'samples_ns', 'samples_ts'}


def _output(**kw) -> str:
    return (
        jsonl_line(n_prompt=512, n_gen=0, avg_ts=150.0, **kw)
        + '\n'
        + jsonl_line(n_prompt=0, n_gen=128, avg_ts=8.5, **kw)
    )


def test_parsing_reads_both_tests_and_the_build():
    parsed = bench.parse_jsonl(_output())
    assert parsed['pp']['avg_ts'] == 150.0
    assert parsed['tg']['avg_ts'] == 8.5
    assert parsed['tg']['samples_ts'] == pytest.approx([8.33, 8.5, 8.67])
    assert parsed['pp']['stddev_ts'] == pytest.approx(3.0)
    assert (parsed['build_commit'], parsed['build_number']) == ('f0fb5984b', 11875)
    assert parsed['gpu_info'] == 'Synthetic GPU 6GB'


@pytest.mark.parametrize(
    ('text', 'message'),
    [
        ('', 'no output'),
        ('not json', 'not JSON'),
        ('[1, 2]', 'not a JSON object'),
        (jsonl_line(n_prompt=512, n_gen=0, avg_ts=1.0), 'no tg'),
        (jsonl_line(n_prompt=512, n_gen=128, avg_ts=1.0), 'neither'),
        (
            jsonl_line(n_prompt=512, n_gen=0, avg_ts=1.0) + '\n' + jsonl_line(n_prompt=512, n_gen=0, avg_ts=1.0),
            'two pp',
        ),
        ('{"n_prompt": 1, "n_gen": 0}', 'missing or malformed'),
    ],
)
def test_parsing_refuses_what_is_not_one_point(text, message):
    with pytest.raises(bench.ParseError, match=message):
        bench.parse_jsonl(text)


def test_parsing_refuses_output_that_measured_another_configuration():
    argv = ['-ngl', '20', '-b', '512', '-ub', '512', '-t', '12', '-ctk', 'q8_0', '-ctv', 'q8_0']
    assert bench.parse_jsonl(_output(ngl=20, threads=12), argv)
    with pytest.raises(bench.ParseError, match='n_gpu_layers 99, not the 20'):
        bench.parse_jsonl(_output(ngl=99, threads=12), argv)


OOM_TEXT = 'cudaMalloc failed: out of memory\nmain: error: failed to create context with model'


@pytest.mark.parametrize(
    ('returncode', 'stderr', 'flags', 'status'),
    [
        (1, OOM_TEXT, {}, 'oom'),
        (-6, 'CUDA error: out of memory', {}, 'oom'),
        (1, "main: error: failed to load model '/m/x.gguf'", {}, 'load_error'),
        (2, 'error: invalid parameter for argument: -ngl', {}, 'load_error'),
        (-11, '', {}, 'crash'),
        (None, '', {'timed_out': True}, 'timeout'),
        (None, '', {'cancelled': True}, 'cancelled'),
        (0, '', {}, 'parse_error'),
    ],
)
def test_every_way_a_point_can_end(returncode, stderr, flags, status):
    got, reason, parsed = bench.classify(
        returncode,
        stdout='',
        stderr=stderr,
        timed_out=flags.get('timed_out', False),
        cancelled=flags.get('cancelled', False),
        argv=[],
    )
    assert got == status
    assert parsed is None
    if status == 'crash':
        assert reason == 'killed by SIGSEGV'


def test_a_clean_exit_with_output_is_measured():
    status, reason, parsed = bench.classify(0, stdout=_output(), stderr='', timed_out=False, cancelled=False, argv=[])
    assert (status, reason) == ('ok', None)
    assert parsed['tg']['avg_ts'] == 8.5


# ---------------------------------------------------------------------------
# run_point, against the fake llama-bench
# ---------------------------------------------------------------------------
@pytest.fixture
def binaries(tmp_path, monkeypatch):
    bin_dir = install_binaries(tmp_path / 'bin')
    for name in ('STUB_MODE', 'STUB_OOM_NGL', 'STUB_OOM_MOE', 'STUB_SLOW', 'STUB_LOG'):
        monkeypatch.delenv(name, raising=False)
    return bin_dir


ARGV = ['-m', '/m/x.gguf', '-ngl', '20', '-b', '512', '-ub', '256', '-t', '8', '-ctk', 'q8_0', '-ctv', 'q8_0']
ARGV += ['-fa', 'on', '-p', '512', '-n', '128', '-r', '5', '-o', 'jsonl']


def _run(bin_dir, *, point_timeout=30.0, cancel_after=None, **kw):
    async def scenario():
        cancel = asyncio.Event()
        spawned = []

        async def on_spawn(pgid):
            spawned.append(pgid)

        if cancel_after is not None:
            asyncio.get_running_loop().call_later(cancel_after, cancel.set)
        result = await bench.run_point(
            bin_dir / 'llama-bench',
            ARGV,
            point_timeout=point_timeout,
            cancel=cancel,
            on_spawn=on_spawn,
            nvidia_smi=str(bin_dir / 'nvidia-smi'),
            sample_interval=0.1,
            grace=1.0,
            **kw,
        )
        return result, spawned

    return asyncio.run(scenario())


def test_a_point_that_runs(binaries):
    result, spawned = _run(binaries)
    assert result.status == 'ok', result.reason
    assert result.parsed['tg']['avg_ts'] > 0
    assert len(spawned) == 1
    assert result.peak_vram_mib == 4100
    assert result.peak_temp_c == 55
    assert result.throttle_reasons == 'SwPowerCap'


def test_a_point_that_runs_out_of_memory(binaries, monkeypatch):
    monkeypatch.setenv('STUB_OOM_NGL', '20')
    result, _ = _run(binaries)
    assert result.status == 'oom'
    assert 'failed to create context' in result.reason
    assert 'out of memory' in result.stderr_tail


def test_a_point_that_dies_of_a_signal(binaries, monkeypatch):
    monkeypatch.setenv('STUB_MODE', 'crash')
    result, _ = _run(binaries)
    assert result.status == 'crash'
    assert result.reason.startswith('killed by SIGSEGV')


def test_unparseable_output(binaries, monkeypatch):
    monkeypatch.setenv('STUB_MODE', 'garbage')
    result, _ = _run(binaries)
    assert result.status == 'parse_error'


def test_a_timeout_kills_the_whole_tree(binaries, monkeypatch):
    monkeypatch.setenv('STUB_MODE', 'hang')
    started = time.monotonic()
    result, _ = _run(binaries, point_timeout=1.5)
    assert result.status == 'timeout'
    assert time.monotonic() - started < 15
    assert stub_processes('llama-bench-stub-child') == []


def test_cancel_kills_the_whole_tree(binaries, monkeypatch):
    monkeypatch.setenv('STUB_MODE', 'hang')
    result, _ = _run(binaries, cancel_after=1.5)
    assert result.status == 'cancelled'
    assert stub_processes('llama-bench-stub-child') == []


def test_a_cancelled_task_kills_the_whole_tree(binaries, monkeypatch):
    """A backend shutdown cancels the task itself; the point's group still goes."""
    monkeypatch.setenv('STUB_MODE', 'hang')

    async def scenario():
        task = asyncio.create_task(
            bench.run_point(
                binaries / 'llama-bench',
                ARGV,
                point_timeout=60,
                cancel=asyncio.Event(),
                nvidia_smi=str(binaries / 'nvidia-smi'),
            )
        )
        await asyncio.sleep(1.5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    deadline = time.monotonic() + 5
    while stub_processes('llama-bench-stub-child') and time.monotonic() < deadline:
        time.sleep(0.1)
    assert stub_processes('llama-bench-stub-child') == []


def test_a_missing_binary_is_refused(tmp_path):
    with pytest.raises(PrescreenRefused, match='llama-bench not found'):
        asyncio.run(bench.run_point(tmp_path / 'llama-bench', ARGV, point_timeout=1, cancel=asyncio.Event()))


def test_host_info_reads_the_driver_and_totals(binaries):
    info = bench.host_info(str(binaries / 'nvidia-smi'))
    assert info['driver_version'] == '590.48.01'
    assert info['vram_total_mib'] == 6144
    assert info['ram_total_mib'] and info['ram_total_mib'] > 0
    assert info['kernel']


def test_host_info_without_a_gpu(tmp_path):
    info = bench.host_info(str(tmp_path / 'no-nvidia-smi'))
    assert info['driver_version'] is None and info['vram_total_mib'] is None
