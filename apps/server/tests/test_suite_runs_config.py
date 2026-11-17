"""The Answers run picker can tell two runs of one model and tier apart by their configuration (#1111).

Runs against the test run's migrated database, like the other model tests.
"""

import asyncio
import importlib
import uuid

from local_llm.models.benchmarks.configs import BenchmarkConfigs
from local_llm.models.benchmarks.tests import BenchmarkResults

# Importing the config runs the migrations on the test run's database.
importlib.import_module('local_llm.config')


def _record(run: str, item: str, outcome: str, at: int, config_id: str | None) -> dict:
    return {
        'suite_run_id': run,
        'config_id': config_id,
        'at': at,
        'model': 'm-suite-runs',
        'benchmark': 'mbpp',
        'item_id': item,
        'tier': 'smoke',
        'outcome': outcome,
    }


def test_suite_runs_name_each_runs_configuration_without_splitting_it():
    tag = uuid.uuid4().hex[:8]
    first, second = f'smoke-{tag}-a', f'smoke-{tag}-b'

    cfg_a, cfg_b = f'a{tag}', f'b{tag}'

    async def scenario():
        for cfg in (cfg_a, cfg_b):
            await BenchmarkConfigs.upsert(cfg, 'm-suite-runs', f'config {cfg}', {})
        await BenchmarkResults.add_result(_record(first, '1', 'pass', 4_000_000_001, cfg_a))
        await BenchmarkResults.add_result(_record(first, '2', 'fail_assert', 4_000_000_002, cfg_a))
        await BenchmarkResults.add_result(_record(second, '1', 'pass', 4_000_000_003, cfg_b))
        await BenchmarkResults.add_result(_record(second, '2', 'skipped', 4_000_000_004, cfg_b))
        return await BenchmarkResults.suite_runs(limit=500)

    runs = {r['suite_run_id']: r for r in asyncio.run(scenario()) if r['suite_run_id'] in (first, second)}

    assert set(runs) == {first, second}
    assert runs[first]['config_id'] == cfg_a
    assert runs[second]['config_id'] == cfg_b
    assert runs[first]['passed'] == 1 and runs[first]['attempted'] == 2
    assert runs[second]['passed'] == 1 and runs[second]['attempted'] == 1
