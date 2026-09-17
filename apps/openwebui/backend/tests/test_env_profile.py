"""Tests for benchmarks/env_profile.py's database-backed profile lookup.

Phase 2b: this module used to shell out to scripts/llama-env.sh; now it
reads BenchmarkProfiles (monkeypatched here, no real database) and resolves
through the same profiles.resolve() the launcher uses. These check the
"never a 500" failure posture and that the JSON shape callers
(tune_schedule.py's profile_key(), the Serve page) still expect is
preserved.

Run from the backend directory:

    python -m pytest tests/test_env_profile.py
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from open_webui.benchmarks import env_profile
from open_webui.benchmarks.serving.profiles import ProfileError
from open_webui.models.benchmark_profiles import (
    BenchmarkProfileEntry,
    BenchmarkProfileModel,
    BenchmarkProfiles,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
BASELINE_DIR = REPO_ROOT / 'docs' / 'serving-baseline'


def _seeded_entry(name: str) -> BenchmarkProfileEntry:
    from open_webui.models.benchmark_profiles import BenchmarkProfileVersionModel

    path = BASELINE_DIR / 'profiles.json'
    if not path.exists():  # pragma: no cover - only when run outside the repo
        pytest.skip(f'serving baseline not found at {path}')
    row = next(r for r in json.loads(path.read_text()) if r['name'] == name)
    now = int(time.time())
    return BenchmarkProfileEntry(
        profile=BenchmarkProfileModel(
            profile_id=1, name=name, display_name=name, is_default=(name == 'qwen38'), created_at=now
        ),
        version=BenchmarkProfileVersionModel(
            version_id=1,
            profile_id=1,
            version=1,
            created_at=now,
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
            spec=row['spec'],
            samplers=row['samplers'],
            extra=row.get('extra') or [],
            reasoning_effort_default=(
                'medium' if any('reasoning_effort' in a for a in row.get('extra') or ()) else None
            ),
        ),
    )


# ---------------------------------------------------------------------------
# profile_names
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_profile_names_lists_from_the_database(monkeypatch):
    async def fake_list_profiles(*, include_archived=False, db=None):
        return [_seeded_entry('qwen38'), _seeded_entry('qwen36')]

    monkeypatch.setattr(BenchmarkProfiles, 'list_profiles', fake_list_profiles)
    assert await env_profile.profile_names() == ['qwen38', 'qwen36']


@pytest.mark.asyncio
async def test_profile_names_never_raises(monkeypatch):
    async def fake_list_profiles(*, include_archived=False, db=None):
        raise RuntimeError('database is on fire')

    monkeypatch.setattr(BenchmarkProfiles, 'list_profiles', fake_list_profiles)
    assert await env_profile.profile_names() == []


# ---------------------------------------------------------------------------
# profile
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_profile_returns_empty_dict_when_missing(monkeypatch):
    async def fake_get_by_name(name, db=None):
        return None

    monkeypatch.setattr(BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    assert await env_profile.profile('no-such-profile') == {}


@pytest.mark.asyncio
async def test_profile_none_name_uses_the_default(monkeypatch):
    calls = []

    async def fake_get_default(db=None):
        calls.append('default')
        return _seeded_entry('qwen38')

    monkeypatch.setattr(BenchmarkProfiles, 'get_default', fake_get_default)
    result = await env_profile.profile(None)
    assert calls == ['default']
    assert result['name'] == 'qwen38'


@pytest.mark.asyncio
async def test_profile_never_raises_on_a_database_error(monkeypatch):
    async def fake_get_by_name(name, db=None):
        raise RuntimeError('connection refused')

    monkeypatch.setattr(BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    assert await env_profile.profile('qwen38') == {}


@pytest.mark.asyncio
async def test_profile_returns_empty_dict_on_profile_error(monkeypatch):
    async def fake_get_by_name(name, db=None):
        return _seeded_entry('qwen38')

    def fake_resolve(*a, **k):
        raise ProfileError('--parallel does not belong in a speculative override')

    monkeypatch.setattr(BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    monkeypatch.setattr(env_profile, 'resolve', fake_resolve)
    assert await env_profile.profile('qwen38') == {}


@pytest.mark.asyncio
async def test_profile_json_shape_matches_the_shell_contract(monkeypatch):
    async def fake_get_by_name(name, db=None):
        return _seeded_entry('qwen38')

    monkeypatch.setattr(BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    monkeypatch.setattr(env_profile, 'resolve_model_path', lambda *a, **k: '/models/x.gguf')

    prof = await env_profile.profile('qwen38')

    assert prof['name'] == 'qwen38'
    assert prof['arch'] == 'dense'
    assert prof['model'] == '/models/x.gguf'
    assert prof['alias'] == 'qwen3.8-27b'
    assert isinstance(prof['port'], int)
    # Numeric knobs are strings, matching jq's --arg output, since
    # tune_schedule.py's profile_key()/Grid.violated() still read them so.
    assert isinstance(prof['ctx'], str)
    assert isinstance(prof['ngl'], str)
    assert prof['moe'] == ''  # dense: no --n-cpu-moe
    assert prof['reasoning'] == 'medium'
    assert isinstance(prof['spec'], list)
    assert isinstance(prof['weights_present'], bool)
    assert prof['weights_present'] is False  # /models/x.gguf does not exist


# ---------------------------------------------------------------------------
# port
# ---------------------------------------------------------------------------


def test_port_prefers_the_env_var(monkeypatch):
    monkeypatch.setenv('LLAMA_PORT', '9999')
    assert env_profile.port({'port': 8090}) == 9999


def test_port_falls_back_to_the_profile_dict(monkeypatch):
    monkeypatch.delenv('LLAMA_PORT', raising=False)
    assert env_profile.port({'port': 8091}) == 8091


def test_port_default_when_neither_is_set(monkeypatch):
    monkeypatch.delenv('LLAMA_PORT', raising=False)
    assert env_profile.port({}) == 8090
