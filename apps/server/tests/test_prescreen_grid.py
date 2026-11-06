"""benchmarks/prescreen/grid.py: the grids, their constraints, and monotone pruning.

Run from apps/server:

    python -m pytest tests/test_prescreen_grid.py
"""

from __future__ import annotations

import dataclasses
from pathlib import Path

import pytest

from local_llm.benchmarks.prescreen import PrescreenRefused
from local_llm.benchmarks.prescreen import grid as prescreen_grid
from local_llm.benchmarks.serving.profiles import Overrides, ServingProfile, resolve

MOE = ServingProfile(name='qwen36', arch='moe', alias='a', model_path='/m/x.gguf', ctx=65536, threads=6, ngl=99, moe=34)
DENSE = ServingProfile(name='qwen38', arch='dense', alias='a', model_path='/m/y.gguf', ctx=16384, threads=12, ngl=20)


def _config(profile, **overrides):
    return resolve(profile, Overrides.from_env({k: str(v) for k, v in overrides.items()}))


def test_every_shipped_grid_loads_and_fits_the_grid_sampler_limit():
    from local_llm.benchmarks.prescreen import study

    names = prescreen_grid.grid_names()
    assert set(names) >= {'qwen25c', 'qwen36', 'qwen38', 'qwen3c'}
    for name in names:
        grid = prescreen_grid.load_grid(name)
        assert grid.profile == name
        assert set(grid.knobs) <= prescreen_grid.KNOBS
        assert grid.size() <= study.GRID_LIMIT


def test_a_knob_llama_bench_cannot_measure_is_refused(tmp_path):
    data = {'profile': 'qwen38', 'knob': {'LLAMA_SPEC': {'values': ['off']}}}
    with pytest.raises(PrescreenRefused, match='llama-bench cannot measure LLAMA_SPEC'):
        prescreen_grid.PrescreenGrid(tmp_path / 'qwen38.toml', data)


def test_a_grid_is_named_never_a_path():
    with pytest.raises(PrescreenRefused, match="no pre-screen grid '../tuning/qwen36'"):
        prescreen_grid.load_grid('../tuning/qwen36')


def test_tunes_parse_errors_read_as_the_pre_screens():
    with pytest.raises(PrescreenRefused, match='declares no knobs') as info:
        prescreen_grid.PrescreenGrid(Path('x.toml'), {'profile': 'x'})
    assert 'llama-tune' not in str(info.value)


def test_constraints_read_profile_values_for_knobs_not_swept():
    grid = prescreen_grid.PrescreenGrid(
        Path('qwen36.toml'),
        {
            'profile': 'qwen36',
            'knob': {'LLAMA_UBATCH': {'values': [256, 1024]}},
            'constraint': [{'expr': 'LLAMA_UBATCH <= LLAMA_BATCH'}],
        },
    )
    config = resolve(MOE)  # batch 512
    assert grid.violated({'LLAMA_UBATCH': '256'}, config) is None
    assert grid.violated({'LLAMA_UBATCH': '1024'}, config) == 'LLAMA_UBATCH <= LLAMA_BATCH'


def test_baseline_params_are_the_profiles_own_values():
    grid = prescreen_grid.load_grid('qwen36')
    assert prescreen_grid.baseline_params(grid, resolve(MOE)) == {
        'LLAMA_BATCH': 512,
        'LLAMA_MOE': 34,
        'LLAMA_THREADS': 6,
        'LLAMA_UBATCH': 512,
    }


def test_more_layers_on_the_card_needs_more_vram():
    oom = _config(DENSE, LLAMA_NGL=20)
    assert prescreen_grid.needs_more_vram(_config(DENSE, LLAMA_NGL=24), oom)
    assert prescreen_grid.needs_more_vram(_config(DENSE, LLAMA_NGL=20, LLAMA_THREADS=8), oom)  # threads are CPU only
    assert not prescreen_grid.needs_more_vram(_config(DENSE, LLAMA_NGL=18), oom)


def test_fewer_layers_experts_in_ram_needs_more_vram():
    oom = _config(MOE, LLAMA_MOE=30)
    assert prescreen_grid.needs_more_vram(_config(MOE, LLAMA_MOE=28), oom)
    assert not prescreen_grid.needs_more_vram(_config(MOE, LLAMA_MOE=32), oom)


@pytest.mark.parametrize(
    'other',
    [
        {'LLAMA_BATCH': 1024},
        {'LLAMA_UBATCH': 256},
        {'LLAMA_CACHE_K': 'f16'},
        {'LLAMA_FA': 'off'},
    ],
)
def test_a_different_vram_group_is_never_pruned(other):
    """A larger batch or another cache type changes the buffers, so one OOM says nothing about the other."""
    oom = _config(DENSE, LLAMA_NGL=20)
    assert not prescreen_grid.needs_more_vram(_config(DENSE, LLAMA_NGL=24, **other), oom)


def test_pruned_by_names_the_oom_that_implies_it():
    ooms = [(11, _config(MOE, LLAMA_MOE=32, LLAMA_BATCH=1024)), (12, _config(MOE, LLAMA_MOE=30))]
    assert prescreen_grid.pruned_by(_config(MOE, LLAMA_MOE=28), ooms) == 12
    assert prescreen_grid.pruned_by(_config(MOE, LLAMA_MOE=28, LLAMA_BATCH=1024), ooms) == 11
    assert prescreen_grid.pruned_by(_config(MOE, LLAMA_MOE=34), ooms) is None


def test_the_order_puts_each_groups_least_vram_first():
    configs = [_config(DENSE, LLAMA_NGL=n, LLAMA_BATCH=b) for b in (1024, 512) for n in (24, 16, 20)]
    ordered = sorted(configs, key=prescreen_grid.pruning_order)
    assert [(c.batch, c.ngl) for c in ordered] == [(1024, 16), (1024, 20), (1024, 24), (512, 16), (512, 20), (512, 24)]
    moe = sorted([_config(MOE, LLAMA_MOE=m) for m in (30, 36, 28)], key=prescreen_grid.pruning_order)
    assert [c.moe for c in moe] == [36, 30, 28]


def test_a_dense_profile_never_compares_with_moe_values():
    dense = resolve(DENSE)
    assert not prescreen_grid.needs_more_vram(dataclasses.replace(dense, moe=30), dense)
