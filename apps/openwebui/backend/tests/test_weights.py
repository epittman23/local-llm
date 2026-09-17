"""Tests for the model-weights fetch helper (lllm-fetch's Python port).

Database-free and network-free: fetch_argv is checked against the seeded
profiles' real hf_repo/hf_pattern values, and FetchProcess's precondition
checks (no 'hf' CLI, start() never called) are exercised directly. Nothing
here downloads anything.

Run from the backend directory:

    python -m pytest tests/test_weights.py
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from open_webui.benchmarks.serving.profiles import ServingProfile
from open_webui.benchmarks.serving.weights import FetchProcess, WeightsError, fetch_argv

#: backend/tests/ -> backend/ -> apps/openwebui/ -> apps/ -> repo root
REPO_ROOT = Path(__file__).resolve().parents[4]
BASELINE_DIR = REPO_ROOT / 'docs' / 'serving-baseline'


def _load_profiles() -> dict[str, ServingProfile]:
    path = BASELINE_DIR / 'profiles.json'
    if not path.exists():  # pragma: no cover - only when run outside the repo
        pytest.skip(f'serving baseline not found at {path}')
    out = {}
    for row in json.loads(path.read_text()):
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
            extra=tuple(row.get('extra') or ()),
        )
    return out


@pytest.fixture(scope='module')
def profiles() -> dict[str, ServingProfile]:
    return _load_profiles()


@pytest.mark.parametrize('name', ['qwen38', 'qwen36', 'qwen25c', 'qwen3c'])
def test_fetch_argv_matches_the_seeded_repo_and_pattern(name, profiles):
    profile = profiles[name]
    argv = fetch_argv(profile, llama_models='/models')

    assert argv[0] == 'download'
    assert argv[1] == profile.hf_repo

    def value_after(flag):
        return argv[argv.index(flag) + 1]

    assert value_after('--include') == profile.hf_pattern
    target_dir = value_after('--local-dir')
    assert target_dir == str(Path(profile.model_path.replace('{LLAMA_MODELS}', '/models')).parent)
    assert '{LLAMA_MODELS}' not in target_dir


def test_fetch_argv_targets_llama_models_not_mnt_c(profiles):
    """The whole point of resolving through LLAMA_MODELS: on WSL2 a /mnt/c
    target would cross the 9p filesystem. Confirm the resolved directory
    follows whatever LLAMA_MODELS is set to, not some other default."""
    profile = profiles['qwen25c']
    argv = fetch_argv(profile, llama_models='/mnt/c/models')
    target_dir = argv[argv.index('--local-dir') + 1]
    assert target_dir.startswith('/mnt/c/models')

    argv = fetch_argv(profile, llama_models='/home/user/models')
    target_dir = argv[argv.index('--local-dir') + 1]
    assert target_dir.startswith('/home/user/models')
    assert '/mnt/c' not in target_dir


def test_fetch_argv_rejects_a_profile_with_no_hf_repo():
    profile = ServingProfile(
        name='hand-started',
        arch='dense',
        alias='hand-started',
        model_path='/models/whatever.gguf',
        ctx=4096,
        threads=4,
        ngl=99,
    )
    with pytest.raises(WeightsError, match='no hf_repo'):
        fetch_argv(profile)


@pytest.mark.asyncio
async def test_fetch_process_rejects_missing_hf_cli(monkeypatch, profiles):
    monkeypatch.setattr('shutil.which', lambda name: None)
    proc = FetchProcess(profile=profiles['qwen25c'])
    with pytest.raises(WeightsError, match="'hf' CLI not found"):
        await proc.start()
    assert proc.proc is None


@pytest.mark.asyncio
async def test_fetch_process_wait_without_start_raises(profiles):
    proc = FetchProcess(profile=profiles['qwen25c'])
    with pytest.raises(WeightsError, match='start\\(\\) was never called'):
        await proc.wait()


@pytest.mark.asyncio
async def test_fetch_process_lines_without_start_is_empty(profiles):
    proc = FetchProcess(profile=profiles['qwen25c'])
    lines = [line async for line in proc.lines()]
    assert lines == []


def test_fetch_process_running_is_false_before_start(profiles):
    proc = FetchProcess(profile=profiles['qwen25c'])
    assert proc.running is False
