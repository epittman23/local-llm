"""benchmarks/analysis/compare.py and the /compare router's response shapes.

The grouping and row builders are pure, so they are tested on fixture dicts;
the router is tested with its database reads monkeypatched, so nothing here
needs Postgres.

Run from apps/server:

    python -m pytest tests/test_compare.py
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.benchmarks.analysis import compare
from local_llm.routers.benchmarks import compare as compare_router
from local_llm.utils.auth import get_admin_user

ADMIN = SimpleNamespace(id='admin-1', email='admin@example.com')

CONFIG_A = [
    'arch: dense | ngl: 20 | ctx: 16384 (total) | parallel: 1 | threads: 12 | moe: n/a',
    'override-tensors: n/a',
    'speculative: off',
    'cache: k=q8_0 v=q8_0 | fa: on | batch: 512 | ubatch: 512',
    'reasoning effort: medium',
    'samplers: llama.cpp defaults',
]
CONFIG_B = [line.replace('fa: on', 'fa: off') for line in CONFIG_A]
CONFIG_C = [line.replace('ngl: 20', 'ngl: 24').replace('batch: 512 |', 'batch: 1024 |') for line in CONFIG_A]


def rec(config, item, outcome, *, benchmark='ds1000', tier='smoke', window=None, cluster=None, wall_ms=60000, at=1):
    return {
        'model': 'm',
        'config_id': config,
        'tier': tier,
        'benchmark': benchmark,
        'item_id': item,
        'outcome': outcome,
        'system_sha': None,
        'adapter_sha': f'{benchmark}-sha',
        'dataset_revision': f'{benchmark}-rev',
        'item_window': window,
        'cluster': cluster,
        'wall_ms': wall_ms,
        'at': at,
        'timings': {'predicted_n': 100, 'predicted_ms': 10000},
        'params': {},
    }


def run(config, outcomes, **kw):
    return [rec(config, str(i), 'pass' if o else 'fail_assert', **kw) for i, o in enumerate(outcomes)]


# ---------------------------------------------------------------------------
# flags
# ---------------------------------------------------------------------------
def test_fa_is_extracted_so_a_two_flag_difference_is_seen():
    # #131: configs differing only in fa used to compare as identical.
    assert compare.flags_of(CONFIG_A)['fa'] == 'on'
    assert compare.differing(compare.flags_of(CONFIG_A), compare.flags_of(CONFIG_B)) == ['fa']


# ---------------------------------------------------------------------------
# blocks
# ---------------------------------------------------------------------------
def test_groups_split_by_tier_benchmark_and_window():
    records = (
        run('aaaa', [1, 0])
        + run('aaaa', [1, 1], tier='full')
        + run('aaaa', [1], benchmark='humanevalplus')
        + run('aaaa', [1], window='2025-01-01..')
        + run('aaaa', [0], window='2025-02-01..')
    )
    groups = compare.group_records(records)
    assert len(groups) == 5
    assert len(compare.blocks_of(groups)) == 5


def test_rows_are_ordered_within_blocks_never_across_them():
    # #132: a full-tier row must not be ranked against a smoke-tier one.
    records = run('aaaa', [1, 1, 1, 0]) + run('bbbb', [1, 0, 0, 0]) + run('cccc', [1, 1], tier='full')
    rows, blocks = compare.rows_for(compare.group_records(records), {})
    assert [r['tier'] for r in rows] == ['full', 'smoke', 'smoke']
    assert [r['config_id'] for r in rows if r['tier'] == 'smoke'] == ['aaaa', 'bbbb']
    assert len(blocks) == 2


def test_baseline_delta_is_per_block():
    records = (
        run('aaaa', [1, 1, 0, 0])
        + run('bbbb', [1, 1, 1, 0])
        + run('aaaa', [1, 0], tier='full')
        + run('bbbb', [1, 1], tier='full')
        + run('cccc', [1], tier='standard')
    )
    rows, _ = compare.rows_for(compare.group_records(records), {}, baseline='aaaa')
    by = {(r['tier'], r['config_id']): r for r in rows}
    assert by[('smoke', 'bbbb')]['vs_baseline'] == pytest.approx(0.25)
    assert by[('full', 'bbbb')]['vs_baseline'] == pytest.approx(0.5)
    assert by[('standard', 'cccc')]['vs_baseline'] is None
    assert by[('standard', 'cccc')]['vs_baseline_note'] == 'baseline not measured on this block'


def test_row_carries_interval_counts_and_group():
    rows, blocks = compare.rows_for(compare.group_records(run('aaaa', [1] * 8)), {'aaaa': CONFIG_A})
    row = rows[0]
    assert (row['passed'], row['attempted'], row['n_problems'], row['n_samples']) == (8, 8, 8, 8)
    assert row['pass_rate'] == 1.0
    assert row['pass_rate_ci'][0] == pytest.approx(0.675592, abs=1e-6)
    assert row['se_kind'] == 'iid' and row['n_clusters'] is None
    assert row['group'] == 'a'
    assert row['flags']['fa'] == 'on'
    assert row['passes_per_minute'] == pytest.approx(1.0)
    assert blocks[0]['pairs'] == []


def test_repeated_runs_are_averaged_within_a_problem():
    records = run('aaaa', [1, 0]) + run('aaaa', [1, 1], at=2)
    row = compare.rows_for(compare.group_records(records), {})[0][0]
    assert (row['passed'], row['attempted']) == (3, 4)
    assert row['n_problems'] == 2 and row['n_samples'] == 4
    assert row['pass_rate'] == pytest.approx(0.75)


def test_clusters_make_the_error_cluster_robust():
    records = [rec('aaaa', str(i), 'pass' if i % 3 else 'fail_assert', cluster=f'Pandas/{i // 2}') for i in range(12)]
    row = compare.rows_for(compare.group_records(records), {})[0][0]
    assert row['se_kind'] == 'cluster' and row['n_clusters'] == 6
    assert 'few clusters' in row['note']


def test_pairs_holm_and_letters():
    # Three configurations on the same 30 problems: a clearly better than c.
    a = [1] * 30
    b = [1] * 22 + [0] * 8
    c = [1] * 5 + [0] * 25
    records = run('aaaa', a) + run('bbbb', b) + run('cccc', c)
    rows, blocks = compare.rows_for(compare.group_records(records), {})
    block = blocks[0]
    assert block['holm_m'] == 3
    pairs = {(p['a'], p['b']): p for p in block['pairs']}
    ac = pairs[('m @ aaaa', 'm @ cccc')]
    assert ac['test'] == 'exact McNemar' and ac['discordant'] == [25, 0]
    assert ac['significant'] and ac['p_holm'] >= ac['p']
    assert block['letters']['m @ aaaa'] != block['letters']['m @ cccc']
    assert {r['config_id']: r['group'] for r in rows}['aaaa'].startswith('a')


def test_a_pair_with_no_shared_problems_is_left_out_of_holm():
    records = [rec('aaaa', 'x', 'pass'), rec('bbbb', 'y', 'fail_assert')]
    block = compare.rows_for(compare.group_records(records), {})[1][0]
    assert block['holm_m'] == 0
    assert block['pairs'][0]['p'] is None and block['pairs'][0]['note'] == 'n/a (no shared problems)'
    assert set(block['letters'].values()) == {'a'}


def test_underpowered_is_flagged_when_the_difference_is_below_the_mde():
    a = [1, 1, 1, 1, 0, 1, 1, 0]
    b = [1, 1, 1, 0, 1, 1, 0, 0]
    pair = compare.rows_for(compare.group_records(run('aaaa', a) + run('bbbb', b)), {})[1][0]['pairs'][0]
    assert not pair['significant'] and pair['underpowered'] is True
    assert pair['mde_holm'] > abs(pair['mean_diff'])


def test_benchmark_view_is_flat():
    # #130: per-benchmark values at the top level, as the page reads them.
    records = run('aaaa', [1, 0]) + run('aaaa', [1, 1], benchmark='humanevalplus')
    columns, rows = compare.benchmark_rows(compare.group_records(records))
    assert columns == ['model', 'config_id', 'tier', 'system', 'ds1000_passed', 'ds1000_pass_rate'] + [
        'humanevalplus_passed',
        'humanevalplus_pass_rate',
    ]
    assert rows[0]['ds1000_passed'] == '1/2' and rows[0]['ds1000_pass_rate'] == 0.5
    assert rows[0]['humanevalplus_pass_rate'] == 1.0


def test_multi_flag_warning_within_a_block():
    records = run('aaaa', [1, 0]) + run('cccc', [1, 1])
    notes = compare.caveats(compare.group_records(records), {'aaaa': CONFIG_A, 'cccc': CONFIG_C})
    assert any('differ in 2 flags (batch, ngl)' in n for n in notes)


# ---------------------------------------------------------------------------
# the router's response shapes
# ---------------------------------------------------------------------------
@pytest.fixture
def client(monkeypatch):
    records = run('aaaa', [1, 1, 0]) + run('bbbb', [1, 0, 0])

    async def fetch_results(tier=None, model=None):
        return [r for r in records if not tier or r['tier'] == tier]

    async def fetch_config_blocks():
        return {'aaaa': CONFIG_A, 'bbbb': CONFIG_B}

    async def exclusion_note():
        return []

    async def serving_summary():
        return [{'config_id': 'aaaa', 'config_text': '\n'.join(CONFIG_A), 'gen_tps': 5.0, 'model': 'm'}]

    monkeypatch.setattr(compare, 'fetch_results', fetch_results)
    monkeypatch.setattr(compare, 'fetch_config_blocks', fetch_config_blocks)
    monkeypatch.setattr(compare, 'exclusion_note', exclusion_note)
    monkeypatch.setattr(compare, 'serving_summary', serving_summary)

    app = FastAPI()
    app.include_router(compare_router.router, prefix='/compare')
    app.dependency_overrides[get_admin_user] = lambda: ADMIN
    return TestClient(app)


def test_config_response_has_rows_blocks_and_notes(client):
    body = client.get('/compare/', params={'by': 'config', 'baseline': 'aaaa'}).json()
    assert set(body) == {'rows', 'blocks', 'notes'}
    assert body['rows'][0]['pass_rate_ci'] is not None
    assert body['blocks'][0]['levels'] == ['m @ aaaa', 'm @ bbbb']
    assert body['rows'][1]['vs_baseline'] == pytest.approx(-1 / 3)


def test_serving_response_puts_rows_under_rows(client):
    # #129: the rows used to arrive under `derived_columns`.
    body = client.get('/compare/', params={'by': 'serving'}).json()
    assert set(body) == {'rows', 'derived', 'notes'}
    assert body['rows'][0]['gen_tps'] == 5.0
    assert body['derived'][0]['config_id'] == 'aaaa'


def test_benchmark_response_has_columns(client):
    body = client.get('/compare/', params={'by': 'benchmark'}).json()
    assert body['columns'][:4] == ['model', 'config_id', 'tier', 'system']
    assert body['rows'][0]['ds1000_passed'] == '2/3'
