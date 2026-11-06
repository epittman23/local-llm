"""models/benchmarks/prescreen.py, against the test process's own migrated database.

The pre-screen's orchestration tests use in-memory stand-ins for these two
tables; this checks the real ones: what a sweep and a point store, that only
a running sweep is closed, and that an opened point's id comes back.
The migrations run on the test DATA_DIR's SQLite database (conftest.py)
first; importing local_llm.config already does, so a second run is a no-op. That the models match the migrations on
Postgres is test_schema_drift.py's.

Run from apps/server:

    python -m pytest tests/test_prescreen_models.py
"""

from __future__ import annotations

import asyncio

import pytest

from local_llm.config import run_migrations
from local_llm.models.benchmarks.prescreen import BenchmarkPrescreenPoints, BenchmarkPrescreenSweeps

SWEEP = {
    'profile': 'qwen38',
    'sampler': 'grid',
    'seed': 0,
    'objective': 'tg',
    'grid_path': 'data/prescreen/qwen38.toml',
    'grid_sha': 'abc123',
    'n_prompt': 512,
    'n_gen': 128,
    'reps': 5,
    'point_timeout': 900,
    'ctx_checks': 3,
    'model_file': 'Qwen3.8-27B-UD-Q3_K_XL.gguf',
    'model_bytes': 13142360064,
    'driver_version': '590.48.01',
    'vram_total_mib': 6144,
}


@pytest.fixture(autouse=True, scope='module')
def _migrated():
    run_migrations()


def test_a_sweep_and_its_points_round_trip():
    async def scenario():
        sweep_id = BenchmarkPrescreenSweeps.new_id()
        await BenchmarkPrescreenSweeps.open_sweep(sweep_id, pid=1234, study_name=f'prescreen-{sweep_id}', **SWEEP)
        await BenchmarkPrescreenSweeps.set_sweep(sweep_id, build_commit='f0fb5984b', build_number=11875, profile='x')
        first = await BenchmarkPrescreenPoints.open_point(
            sweep_id,
            phase='search',
            overrides={'LLAMA_NGL': '20'},
            is_baseline=True,
            optuna_trial_number=0,
            argv=['-ngl', '20'],
        )
        await BenchmarkPrescreenPoints.set_point(
            first, status='ok', tg_avg_ts=5.5, tg_samples_ts=[5.4, 5.6], pgid=999, sweep_id='elsewhere'
        )
        second = await BenchmarkPrescreenPoints.open_point(
            sweep_id, phase='search', overrides={'LLAMA_NGL': '24'}, status='pruned', pruned_by=first
        )
        again = await BenchmarkPrescreenPoints.open_point(
            sweep_id, phase='remeasure', overrides={'LLAMA_NGL': '20'}, remeasure_of=first
        )
        return sweep_id, first, second, again

    sweep_id, first, second, again = asyncio.run(scenario())
    assert second == first + 1 and again == second + 1

    sweep = asyncio.run(BenchmarkPrescreenSweeps.get_by_id(sweep_id))
    assert sweep.status == 'running' and sweep.ended_at is None
    assert (sweep.build_commit, sweep.build_number) == ('f0fb5984b', 11875)
    assert sweep.profile == 'qwen38'  # identity is fixed once the sweep is open

    points = asyncio.run(BenchmarkPrescreenPoints.sweep_points(sweep_id))
    assert [p.point_id for p in points] == [first, second, again]
    assert points[0].tg_samples_ts == [5.4, 5.6] and points[0].argv == ['-ngl', '20'] and points[0].pgid == 999
    assert points[0].sweep_id == sweep_id
    assert points[1].pruned_by == first and points[2].remeasure_of == first


def test_only_a_running_sweep_is_closed():
    async def scenario():
        sweep_id = BenchmarkPrescreenSweeps.new_id()
        await BenchmarkPrescreenSweeps.open_sweep(sweep_id, study_name='s', **SWEEP)
        await BenchmarkPrescreenSweeps.close_sweep(sweep_id, status='cancelled', reason='cancelled')
        await BenchmarkPrescreenSweeps.close_sweep(sweep_id, status='stale', reason='late reclaim')
        running = await BenchmarkPrescreenSweeps.list_sweeps(limit=1000, running_only=True)
        return await BenchmarkPrescreenSweeps.get_by_id(sweep_id), running

    sweep, running = asyncio.run(scenario())
    assert (sweep.status, sweep.status_reason) == ('cancelled', 'cancelled')
    assert sweep.ended_at is not None
    assert sweep.sweep_id not in {s.sweep_id for s in running}
