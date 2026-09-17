"""Tests for the launcher's argv assembly, warnings and telemetry wiring.

Mostly database-free and subprocess-free: these exercise the pure functions
in benchmarks/serving/launcher.py against the same resolved configurations
test_serving_fingerprint.py checks, plus the golden cases in
docs/serving-baseline/fingerprints.json, so a change here that silently
changes what gets passed to llama-server shows up as a failing test rather
than as a server that starts with the wrong flags. The ServeProcess tests at
the bottom spawn a small local stub script standing in for llama-server --
never the real binary, never the GPU -- to exercise start()/lines()/stop()
end to end.

Run from the backend directory:

    python -m pytest tests/test_launcher.py
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from open_webui.benchmarks.serving.build_info import parse_build
from open_webui.benchmarks.serving.launcher import (
    LauncherError,
    ServeProcess,
    build_argv,
    build_database_url,
    dense_partial_offload_warning,
    flash_attn_args,
    percent_encode_password,
    resolve_model_path,
    telemetry_argv,
)
from open_webui.benchmarks.serving.model_name import split_model
from open_webui.benchmarks.serving.profiles import ARCH_DENSE, ARCH_MOE, Overrides, ServingProfile, resolve

#: backend/tests/ -> backend/ -> apps/openwebui/ -> apps/ -> repo root
REPO_ROOT = Path(__file__).resolve().parents[4]
BASELINE_DIR = REPO_ROOT / 'docs' / 'serving-baseline'


def _load(name: str):
    path = BASELINE_DIR / name
    if not path.exists():  # pragma: no cover - only when run outside the repo
        pytest.skip(f'serving baseline not found at {path}')
    return json.loads(path.read_text())


@pytest.fixture(scope='module')
def profiles() -> dict[str, ServingProfile]:
    out = {}
    for row in _load('profiles.json'):
        extra = tuple(row.get('extra') or ())
        reasoning_default = 'medium' if any('reasoning_effort' in arg for arg in extra) else None
        out[row['name']] = ServingProfile(
            name=row['name'],
            arch=row['arch'],
            alias=row['alias'],
            model_path=row['model_path'],
            hf_repo=row['hf_repo'],
            hf_pattern=row['hf_pattern'],
            ctx=row['ctx'],
            threads=row['threads'],
            ngl=row['ngl'],
            moe=row['moe'],
            override_tensors=row['override_tensors'],
            parallel=row['parallel'],
            cache_k=row['cache_k'],
            cache_v=row['cache_v'],
            batch=row['batch'],
            ubatch=row['ubatch'],
            spec=tuple(row['spec']),
            samplers=tuple(row['samplers']),
            extra=extra,
            reasoning_effort_default=reasoning_default,
        )
    return out


def _cases():
    return _load('fingerprints.json')['cases']


def _resolved(case, profiles):
    return resolve(profiles[case['profile']], Overrides.from_env(case['env']))


# ---------------------------------------------------------------------------
# resolve_model_path
# ---------------------------------------------------------------------------


def test_resolve_model_path_substitutes_template():
    assert (
        resolve_model_path('{LLAMA_MODELS}/qwen38-27b/x.gguf', llama_models='/mnt/models')
        == '/mnt/models/qwen38-27b/x.gguf'
    )


def test_resolve_model_path_falls_back_to_env(monkeypatch):
    monkeypatch.setenv('LLAMA_MODELS', '/env/models')
    assert resolve_model_path('{LLAMA_MODELS}/x.gguf') == '/env/models/x.gguf'


def test_resolve_model_path_falls_back_to_home(monkeypatch):
    monkeypatch.delenv('LLAMA_MODELS', raising=False)
    assert resolve_model_path('{LLAMA_MODELS}/x.gguf') == str(Path.home() / 'models' / 'x.gguf')


def test_resolve_model_path_is_a_noop_without_the_template():
    assert resolve_model_path('/already/resolved/x.gguf') == '/already/resolved/x.gguf'


# ---------------------------------------------------------------------------
# flash_attn_args
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ('value', 'expected'),
    [
        ('on', ['-fa', 'on']),
        ('off', ['-fa', 'off']),
        ('auto', ['-fa', 'auto']),
        ('legacy --flash-attn 1', ['--flash-attn', '1']),
    ],
)
def test_flash_attn_args(value, expected):
    assert flash_attn_args(value) == expected


# ---------------------------------------------------------------------------
# build_argv, against the golden cases
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('case', _cases(), ids=lambda c: c['case'])
def test_build_argv_matches_resolved_config(case, profiles):
    config = _resolved(case, profiles)
    argv = build_argv(config, host='127.0.0.1', port=8090, llama_models='/models')

    def value_after(flag):
        return argv[argv.index(flag) + 1]

    assert value_after('-ngl') == str(config.ngl)
    assert value_after('-c') == str(config.ctx)
    assert value_after('-t') == str(config.threads)
    assert value_after('--cache-type-k') == config.cache_k
    assert value_after('--cache-type-v') == config.cache_v
    assert value_after('-b') == str(config.batch)
    assert value_after('--ubatch-size') == str(config.ubatch)
    assert value_after('--parallel') == str(config.parallel)
    assert value_after('--alias') == config.alias
    assert value_after('--host') == '127.0.0.1'
    assert value_after('--port') == '8090'
    assert '--jinja' in argv
    assert '--metrics' in argv

    if config.flash_attn.startswith('legacy '):
        assert value_after('--flash-attn') == '1'
        assert '-fa' not in argv
    else:
        assert value_after('-fa') == config.flash_attn
        assert '--flash-attn' not in argv

    if config.moe is not None:
        assert value_after('--n-cpu-moe') == str(config.moe)
    else:
        assert '--n-cpu-moe' not in argv

    if config.override_tensors:
        assert value_after('-ot') == config.override_tensors
    else:
        assert '-ot' not in argv

    if config.reasoning_effort is not None:
        kwargs = value_after('--chat-template-kwargs')
        assert json.loads(kwargs) == {'reasoning_effort': config.reasoning_effort}
    else:
        assert '--chat-template-kwargs' not in argv


def test_build_argv_moe_on_dense_never_emits_n_cpu_moe(profiles):
    """moe-on-dense: resolve() already dropped the override with a warning;
    build_argv must not resurrect it from anywhere else."""
    case = next(c for c in _cases() if c['case'] == 'moe-on-dense')
    config = _resolved(case, profiles)
    assert config.arch == ARCH_DENSE
    assert config.moe is None
    assert '--n-cpu-moe' not in build_argv(config)


def test_build_argv_qwen36_base_has_no_reasoning_flag(profiles):
    config = _resolved(next(c for c in _cases() if c['case'] == 'base-qwen36'), profiles)
    assert config.reasoning_effort is None
    assert '--chat-template-kwargs' not in build_argv(config)


def test_build_argv_qwen38_base_sets_medium_reasoning(profiles):
    config = _resolved(next(c for c in _cases() if c['case'] == 'base-qwen38'), profiles)
    argv = build_argv(config)
    idx = argv.index('--chat-template-kwargs')
    assert json.loads(argv[idx + 1]) == {'reasoning_effort': 'medium'}


def test_build_argv_uses_resolved_model_path(profiles):
    config = _resolved(next(c for c in _cases() if c['case'] == 'base-qwen38'), profiles)
    argv = build_argv(config, llama_models='/mnt/models')
    model = argv[argv.index('-m') + 1]
    assert model == '/mnt/models/qwen38-27b/Qwen3.8-27B-UD-Q3_K_XL.gguf'
    assert '{LLAMA_MODELS}' not in model


# ---------------------------------------------------------------------------
# dense_partial_offload_warning
# ---------------------------------------------------------------------------


def test_dense_partial_offload_warning_fires_for_qwen38(profiles):
    config = _resolved(next(c for c in _cases() if c['case'] == 'base-qwen38'), profiles)
    assert config.arch == ARCH_DENSE
    assert config.ngl != 99
    warning = dense_partial_offload_warning(config)
    assert warning is not None
    assert 'partial offload' in warning


@pytest.mark.parametrize('case_name', ['base-qwen36', 'base-qwen25c', 'base-qwen3c'])
def test_dense_partial_offload_warning_silent_at_ngl_99(case_name, profiles):
    config = _resolved(next(c for c in _cases() if c['case'] == case_name), profiles)
    assert config.ngl == 99
    assert dense_partial_offload_warning(config) is None


def test_dense_partial_offload_warning_silent_for_moe(profiles):
    config = _resolved(next(c for c in _cases() if c['case'] == 'threads-override'), profiles)
    assert config.arch == ARCH_MOE
    assert dense_partial_offload_warning(config) is None


# ---------------------------------------------------------------------------
# percent_encode_password / build_database_url
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ('raw', 'encoded'),
    [
        ('simple', 'simple'),
        ('has/slash', 'has%2Fslash'),
        ('has+plus', 'has%2Bplus'),
        ('has:colon@at', 'has%3Acolon%40at'),
    ],
)
def test_percent_encode_password(raw, encoded):
    assert percent_encode_password(raw) == encoded


def test_build_database_url_encodes_the_password():
    url = build_database_url('p/w+d', host='localhost', port=5432, database='openwebui', user='openwebui')
    assert url == 'postgresql://openwebui:p%2Fw%2Bd@localhost:5432/openwebui'


# ---------------------------------------------------------------------------
# telemetry_argv
# ---------------------------------------------------------------------------


def test_telemetry_argv_carries_the_fingerprint_and_model_split(profiles):
    case = next(c for c in _cases() if c['case'] == 'base-qwen38')
    config = _resolved(case, profiles)
    model_path = resolve_model_path(config.model_path, llama_models='/models')
    argv = telemetry_argv(
        config,
        resolved_model_path=model_path,
        port=8090,
        llama_build=parse_build('version: 0.2.0-dev (build 10597, commit 95b8e33e1)'),
        server_log='/tmp/does-not-matter.log',
    )

    def value_after(flag):
        return argv[argv.index(flag) + 1]

    assert argv[0] == '-m'
    assert argv[1] == 'open_webui.benchmarks.telemetry_recorder'
    assert value_after('--config-id') == case['config_id']
    assert value_after('--alias') == config.alias
    name, quant = split_model('Qwen3.8-27B-UD-Q3_K_XL')
    assert value_after('--model') == name
    assert value_after('--quant') == quant
    assert value_after('--build') == '95b8e33e1 (10597)'
    assert value_after('--port') == '8090'
    assert value_after('--ngl') == str(config.ngl)
    assert value_after('--server-log') == '/tmp/does-not-matter.log'
    assert argv.count('--config-line') == len(case['lines'])


# ---------------------------------------------------------------------------
# ServeProcess error paths -- no real llama-server or GPU involved: these
# check that start() fails loudly, and before spawning anything, on the two
# preconditions main.sh:310-320 checked before assembling its argv.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_serve_process_rejects_missing_binary(tmp_path, profiles):
    config = _resolved(next(c for c in _cases() if c['case'] == 'base-qwen25c'), profiles)
    proc = ServeProcess(config=config, llama_bin=str(tmp_path / 'no-such-dir'))
    with pytest.raises(LauncherError, match='llama-server not found'):
        await proc.start()
    assert proc.server_proc is None


@pytest.mark.asyncio
async def test_serve_process_rejects_missing_model(tmp_path, monkeypatch, profiles):
    config = _resolved(next(c for c in _cases() if c['case'] == 'base-qwen25c'), profiles)
    stub = tmp_path / 'llama-server'
    stub.write_text('#!/bin/sh\nexit 0\n')
    stub.chmod(0o755)
    monkeypatch.setenv('LLAMA_MODELS', str(tmp_path / 'nonexistent'))
    proc = ServeProcess(config=config, llama_bin=str(tmp_path))
    with pytest.raises(LauncherError, match='model not found'):
        await proc.start()
    assert proc.server_proc is None


# ---------------------------------------------------------------------------
# ServeProcess end to end, against a stub standing in for llama-server --
# never the real binary, never the GPU. The stub prints a few lines and
# sleeps briefly so there is something to drain and something to stop.
# ---------------------------------------------------------------------------


def _write_stub_server(tmp_path) -> tuple[Path, Path]:
    model = tmp_path / 'weights.gguf'
    model.write_text('not a real gguf, just needs to exist')
    stub = tmp_path / 'llama-server'
    stub.write_text(
        '#!/bin/sh\n'
        'echo "starting"\n'
        'echo "load_tensors: layer 0 assigned to device CPU"\n'
        'sleep 5\n'
        'echo "should not print: killed before this"\n'
    )
    stub.chmod(0o755)
    return stub, model


@pytest.mark.asyncio
async def test_serve_process_lines_tees_to_the_server_log(tmp_path, monkeypatch, profiles):
    stub, model = _write_stub_server(tmp_path)
    config = _resolved(next(c for c in _cases() if c['case'] == 'base-qwen25c'), profiles)
    monkeypatch.setenv('DATABASE_URL', 'postgresql://openwebui:test@localhost:5432/openwebui')

    proc = ServeProcess(config=config, llama_bin=str(tmp_path), record_telemetry=False)
    monkeypatch.setattr('open_webui.benchmarks.serving.launcher.resolve_model_path', lambda *a, **k: str(model))
    await proc.start()
    try:
        lines = []
        async for line in proc.lines():
            lines.append(line)
            if len(lines) == 2:
                break
    finally:
        rc = await proc.stop(grace=2.0)

    assert lines == ['starting', 'load_tensors: layer 0 assigned to device CPU']
    assert rc != 0 or rc is not None  # terminated, not left running
    assert proc.running is False


@pytest.mark.asyncio
async def test_serve_process_with_telemetry_writes_the_log_file_and_unlinks_it(tmp_path, monkeypatch, profiles):
    stub, model = _write_stub_server(tmp_path)
    config = _resolved(next(c for c in _cases() if c['case'] == 'base-qwen25c'), profiles)
    monkeypatch.delenv('DATABASE_URL', raising=False)  # no recorder subprocess actually spawns

    proc = ServeProcess(config=config, llama_bin=str(tmp_path), record_telemetry=True)
    monkeypatch.setattr('open_webui.benchmarks.serving.launcher.resolve_model_path', lambda *a, **k: str(model))
    await proc.start()
    seen_path = proc.server_log_path
    assert seen_path is not None

    lines = []
    async for line in proc.lines():
        lines.append(line)
        if len(lines) == 2:
            break
    await proc.stop(grace=2.0)

    # DATABASE_URL was missing, so telemetry warned rather than starting --
    # and, crucially, still did not block serving or draining the log.
    assert proc.telemetry_proc is None
    assert proc.telemetry_warning is not None
    assert 'DATABASE_URL' in proc.telemetry_warning
    # Deleted only after stop(), which is after the (skipped) recorder would
    # have had its chance to read it.
    assert not seen_path.exists()


@pytest.mark.asyncio
async def test_serve_process_warning_set_for_dense_partial_offload(tmp_path, monkeypatch, profiles):
    stub, model = _write_stub_server(tmp_path)
    config = _resolved(next(c for c in _cases() if c['case'] == 'base-qwen38'), profiles)
    monkeypatch.delenv('DATABASE_URL', raising=False)

    proc = ServeProcess(config=config, llama_bin=str(tmp_path), record_telemetry=False)
    monkeypatch.setattr('open_webui.benchmarks.serving.launcher.resolve_model_path', lambda *a, **k: str(model))
    await proc.start()
    try:
        assert proc.warning is not None
        assert 'partial offload' in proc.warning
    finally:
        await proc.stop(grace=2.0)
