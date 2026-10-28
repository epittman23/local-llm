"""benchmarks/prescreen/sweep.py: a whole pre-screen, against fake binaries.

The two benchmark_prescreen_* tables and the profile lookup are in-memory
stand-ins (prescreen_stubs.py), and Optuna's study is in memory too, so
these check the orchestration: trial 0 is the baseline, the grid visits
every feasible point once, an OOM prunes and teaches the sampler, the
leaders are measured again and load-checked, a seeded TPE repeats itself,
and a cancel or a dead backend leaves nothing running. llama-bench,
llama-server and nvidia-smi are real subprocesses (fakes, see
prescreen_stubs.py); nothing loads a model. That the study lands in the
`optuna` schema of a real Postgres is test_prescreen_optuna_schema.py's.

Run from apps/server:

    python -m pytest tests/test_prescreen_sweep.py
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import subprocess
import sys
import time

import optuna
import pytest
from prescreen_stubs import Entry, Points, Profiles, Sweeps, install_binaries, invocations, stub_processes

from local_llm.benchmarks.prescreen import PrescreenRefused
from local_llm.benchmarks.prescreen import study as prescreen_study
from local_llm.benchmarks.prescreen import sweep as prescreen_sweep
from local_llm.benchmarks.serving.profiles import ServingProfile

optuna.logging.set_verbosity(optuna.logging.WARNING)


class Env:
    def __init__(self, tmp_path):
        self.tmp = tmp_path
        self.bin = install_binaries(tmp_path / 'bin')
        self.model = tmp_path / 'models' / 'model.gguf'
        self.model.parent.mkdir()
        self.model.write_bytes(b'GGUF')
        self.log = tmp_path / 'invocations.jsonl'
        self.sweeps = Sweeps()
        self.points = Points()
        self.storages: list = []


@pytest.fixture
def env(tmp_path, monkeypatch):
    e = Env(tmp_path)
    profiles = Profiles(
        Entry(
            ServingProfile(
                name='qwen38', arch='dense', alias='d', model_path=str(e.model), ctx=16384, threads=12, ngl=20
            )
        ),
        Entry(
            ServingProfile(
                name='qwen36', arch='moe', alias='m', model_path=str(e.model), ctx=65536, threads=6, ngl=99, moe=34
            )
        ),
    )
    monkeypatch.setattr(prescreen_sweep, 'BenchmarkProfiles', profiles)
    monkeypatch.setattr(prescreen_sweep, 'BenchmarkPrescreenSweeps', e.sweeps)
    monkeypatch.setattr(prescreen_sweep, 'BenchmarkPrescreenPoints', e.points)

    def open_storage(url):
        storage = optuna.storages.InMemoryStorage()
        e.storages.append(storage)
        return storage

    monkeypatch.setattr(prescreen_study, 'open_storage', open_storage)
    monkeypatch.setattr(prescreen_study, 'close_storage', lambda storage: None)
    monkeypatch.setenv('LLAMA_BIN', str(e.bin))
    monkeypatch.setenv('LLAMA_TUNE_NVIDIA_SMI', str(e.bin / 'nvidia-smi'))
    monkeypatch.setenv('LLAMA_PORT', str(_free_port()))
    monkeypatch.setenv('STUB_LOG', str(e.log))
    for name in ('STUB_MODE', 'STUB_OOM_NGL', 'STUB_OOM_MOE', 'STUB_SLOW', 'STUB_SERVER_MAX_CTX'):
        monkeypatch.delenv(name, raising=False)
    return e


def _free_port() -> int:
    import socket

    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


DB = 'postgresql://u:p@127.0.0.1:5432/db'


def _run(opts, *, cancel_after=None):
    async def scenario():
        ps = prescreen_sweep.Prescreen(opts, database_url=DB, database_schema=None)
        await ps.prepare()
        if cancel_after is not None:
            asyncio.get_running_loop().call_later(cancel_after, ps.cancel.set)
        status = await ps.run()
        return ps, status

    return asyncio.run(scenario())


def _trials(ps):
    return optuna.load_study(study_name=ps.study.study_name, storage=ps.study._storage).trials


def test_trial_0_is_the_baseline_and_the_grid_runs_every_point_once(env):
    ps, status = _run(prescreen_sweep.PrescreenOptions(profile='qwen38', ctx_checks=0))
    assert status == 'done'
    assert ps.sampler == 'grid'  # 40 points is under the limit

    search = [p for p in env.points.rows.values() if p['phase'] == 'search']
    assert search[0]['is_baseline'] and search[0]['optuna_trial_number'] == 0
    assert search[0]['overrides'] == {
        'LLAMA_BATCH': '512',
        'LLAMA_NGL': '20',
        'LLAMA_THREADS': '12',
        'LLAMA_UBATCH': '512',
    }
    # The baseline is not one of the grid's 40 points (threads 12 is, ubatch 512 is,
    # but batch 512 with ngl 20 is), so it is measured once, as trial 0, and every
    # grid point once after it.
    distinct = {tuple(sorted(p['overrides'].items())) for p in search}
    assert len(distinct) == len(search)
    assert len(search) == len(ps.plan) + 1
    commands = [tuple(a) for a in invocations(env.log)]
    assert len(commands) == len(set(commands)) + 3  # each point once, the top three twice
    assert all(p['status'] == 'ok' for p in search)
    trials = _trials(ps)
    assert [t.number for t in trials] == [p['optuna_trial_number'] for p in search]
    assert all(t.state == optuna.trial.TrialState.COMPLETE for t in trials)


def test_the_sweep_row_carries_the_context_its_numbers_need(env):
    ps, _ = _run(prescreen_sweep.PrescreenOptions(profile='qwen38', ctx_checks=0))
    row = env.sweeps.rows[ps.sweep_id]
    assert row['status'] == 'done'
    assert row['model_file'] == 'model.gguf' and row['model_bytes'] == 4
    assert (row['build_commit'], row['build_number']) == ('f0fb5984b', 11875)
    assert row['gpu_info'] == 'Synthetic GPU 6GB' and row['driver_version'] == '590.48.01'
    assert row['vram_total_mib'] == 6144 and row['kernel']
    assert row['grid_path'] == 'data/prescreen/qwen38.toml' and row['grid_sha']
    assert (row['n_prompt'], row['n_gen'], row['reps']) == (512, 128, 5)
    assert row['pid'] == os.getpid()
    assert row['study_name'] == f'prescreen-{ps.sweep_id}'


def test_an_oom_prunes_the_points_that_need_more_vram(env, monkeypatch):
    monkeypatch.setenv('STUB_OOM_NGL', '22')
    ps, _ = _run(prescreen_sweep.PrescreenOptions(profile='qwen38', ctx_checks=0))
    ooms = env.points.by_status('oom')
    pruned = env.points.by_status('pruned')
    # One OOM per VRAM group, (batch, ubatch); threads allocate nothing on the
    # card, so the first OOM in a group prunes ngl 22 at the other thread count
    # as well as every ngl 24.
    assert {p['overrides']['LLAMA_NGL'] for p in ooms} == {'22'}
    assert len(ooms) == 4
    assert sorted(p['overrides']['LLAMA_NGL'] for p in pruned) == ['22'] * 4 + ['24'] * 8
    for p in pruned:
        cause = env.points.rows[p['pruned_by']]
        assert cause['status'] == 'oom'
        same = ('LLAMA_BATCH', 'LLAMA_UBATCH')
        assert [cause['overrides'][k] for k in same] == [p['overrides'][k] for k in same]
    ran = {a[a.index('-ngl') + 1] for a in invocations(env.log)}
    assert '24' not in ran  # pruned points never start a process

    # An OOM or a pruned point completes as infeasible with throughput 0, not FAIL.
    by_number = {t.number: t for t in _trials(ps)}
    for p in ooms + pruned:
        trial = by_number[p['optuna_trial_number']]
        assert trial.state == optuna.trial.TrialState.COMPLETE
        assert trial.values == [0.0]
        assert trial.constraints == {prescreen_study.CONSTRAINT: 1.0}
    ok = next(p for p in env.points.rows.values() if p['status'] == 'ok' and p['phase'] == 'search')
    assert by_number[ok['optuna_trial_number']].constraints == {prescreen_study.CONSTRAINT: 0.0}


def test_a_moe_grid_prunes_downwards_in_n_cpu_moe(env, monkeypatch):
    monkeypatch.setenv('STUB_OOM_MOE', '30')
    _run(prescreen_sweep.PrescreenOptions(profile='qwen36', ctx_checks=0))
    assert {p['overrides']['LLAMA_MOE'] for p in env.points.by_status('oom')} == {'30'}
    # The other thread count at 30, and every 28.
    assert sorted(p['overrides']['LLAMA_MOE'] for p in env.points.by_status('pruned')) == ['28'] * 8 + ['30'] * 4


def test_the_leaders_are_measured_again_and_ranked_on_the_mean(env):
    ps, _ = _run(prescreen_sweep.PrescreenOptions(profile='qwen38', ctx_checks=0))
    again = [p for p in env.points.rows.values() if p['phase'] == 'remeasure']
    assert len(again) == prescreen_sweep.REMEASURE
    for p in again:
        first = env.points.rows[p['remeasure_of']]
        assert p['overrides'] == first['overrides'] and p['argv'] == first['argv']
        assert p['optuna_trial_number'] is None
    ranked = asyncio.run(ps._ranked())
    assert [r['measurements'] for r in ranked[:3]] == [2, 2, 2]
    assert ranked[0]['tg'] == pytest.approx(sum(ranked[0]['tg_runs']) / 2)
    # The fake's generation speed rises with -ngl and peaks at 7 threads.
    assert ranked[0]['changes']['ngl'] == '24' and ranked[0]['changes']['threads'] == '8'
    assert [r['rank'] for r in ranked] == list(range(1, len(ranked) + 1))


def test_the_leaders_are_load_checked_at_the_profiles_context(env, monkeypatch):
    ps, status = _run(prescreen_sweep.PrescreenOptions(profile='qwen38', ctx_checks=2, load_timeout=30))
    assert status == 'done'
    checked = [p for p in env.points.rows.values() if p.get('ctx_check')]
    assert len(checked) == 2
    assert all(p['ctx_check'] == 'ok' and p['ctx_check_free_mib'] == 6144 - 4100 for p in checked)
    assert stub_processes('llama-server') == []


def test_a_load_check_that_runs_out_of_memory_at_context(env, monkeypatch):
    monkeypatch.setenv('STUB_SERVER_MAX_CTX', '8192')  # the profile serves 16K
    _run(prescreen_sweep.PrescreenOptions(profile='qwen38', ctx_checks=1, load_timeout=30))
    (checked,) = [p for p in env.points.rows.values() if p.get('ctx_check')]
    assert checked['ctx_check'] == 'oom_at_ctx'
    assert 'out of memory' in checked['ctx_check_reason']


def test_a_seeded_tpe_study_repeats_itself(env):
    def proposals():
        env.points.rows.clear()
        _run(prescreen_sweep.PrescreenOptions(profile='qwen38', sampler='tpe', trials=8, seed=3, ctx_checks=0))
        return [p['overrides'] for p in env.points.rows.values() if p['phase'] == 'search']

    first, second = proposals(), proposals()
    assert len(first) == 8
    assert first == second
    assert first[0] == {'LLAMA_BATCH': '512', 'LLAMA_NGL': '20', 'LLAMA_THREADS': '12', 'LLAMA_UBATCH': '512'}


def test_a_repeated_proposal_is_not_run_twice(env):
    _run(prescreen_sweep.PrescreenOptions(profile='qwen38', sampler='tpe', trials=40, seed=0, ctx_checks=0))
    repeats = env.points.by_status('repeat')
    search_commands = [tuple(a) for a in invocations(env.log)][: -prescreen_sweep.REMEASURE]
    assert len(search_commands) == len(set(search_commands))
    for p in repeats:
        assert p['reason'].startswith('the same command as point ')


def test_a_constraint_breaking_proposal_is_never_run(env):
    _run(prescreen_sweep.PrescreenOptions(profile='qwen38', sampler='tpe', trials=30, seed=1, ctx_checks=0))
    for p in env.points.by_status('invalid'):
        assert int(p['overrides']['LLAMA_UBATCH']) > int(p['overrides']['LLAMA_BATCH'])
    for argv in invocations(env.log):
        assert int(argv[argv.index('-ub') + 1]) <= int(argv[argv.index('-b') + 1])


def test_a_cancelled_sweep_stops_the_point_and_leaves_its_study_readable(env, monkeypatch):
    monkeypatch.setenv('STUB_MODE', 'hang')
    ps, status = _run(prescreen_sweep.PrescreenOptions(profile='qwen38', ctx_checks=0), cancel_after=1.5)
    assert status == 'cancelled'
    assert env.sweeps.rows[ps.sweep_id]['status'] == 'cancelled'
    (point,) = env.points.rows.values()
    assert point['status'] == 'cancelled' and point['pgid']
    assert stub_processes('llama-bench-stub-child') == []
    (trial,) = _trials(ps)
    assert trial.state == optuna.trial.TrialState.FAIL


def test_a_point_timeout_is_recorded_and_the_sweep_goes_on(env, monkeypatch):
    monkeypatch.setenv('STUB_MODE', 'hang')
    ps, status = _run(
        prescreen_sweep.PrescreenOptions(profile='qwen38', sampler='tpe', trials=2, point_timeout=1, ctx_checks=0)
    )
    assert status == 'done'
    assert [p['status'] for p in env.points.rows.values()] == ['timeout', 'timeout']
    assert stub_processes('llama-bench-stub-child') == []


@pytest.mark.parametrize(
    ('opts', 'message'),
    [
        ({'profile': 'nope'}, "no profile 'nope'"),
        ({'profile': 'qwen38', 'grid': 'qwen36'}, "grid 'qwen36' is for profile 'qwen36'"),
        ({'profile': 'qwen38', 'objective': 'speed'}, 'objective must be'),
        ({'profile': 'qwen38', 'sampler': 'random'}, 'sampler must be'),
        ({'profile': 'qwen38', 'reps': 0}, 'reps must be at least 1'),
    ],
)
def test_prepare_refuses_before_touching_anything(env, opts, message):
    with pytest.raises(PrescreenRefused, match=message):
        asyncio.run(prescreen_sweep.Prescreen(prescreen_sweep.PrescreenOptions(**opts), database_url=DB).prepare())
    assert env.sweeps.rows == {}


def test_prepare_refuses_without_the_binary_or_the_weights(env):
    env.model.unlink()
    with pytest.raises(PrescreenRefused, match='model not found'):
        asyncio.run(
            prescreen_sweep.Prescreen(prescreen_sweep.PrescreenOptions(profile='qwen38'), database_url=DB).prepare()
        )
    (env.bin / 'llama-bench').unlink()
    with pytest.raises(PrescreenRefused, match='llama-bench not found'):
        asyncio.run(
            prescreen_sweep.Prescreen(prescreen_sweep.PrescreenOptions(profile='qwen38'), database_url=DB).prepare()
        )


def test_prepare_refuses_sqlite(env):
    with pytest.raises(PrescreenRefused, match='Postgres'):
        asyncio.run(
            prescreen_sweep.Prescreen(
                prescreen_sweep.PrescreenOptions(profile='qwen38'), database_url='sqlite:///x.db'
            ).prepare()
        )


# ---------------------------------------------------------------------------
# a sweep whose backend is gone
# ---------------------------------------------------------------------------
OLD_SWEEP = {
    'profile': 'qwen38',
    'sampler': 'grid',
    'seed': 0,
    'objective': 'tg',
    'study_name': 'prescreen-old',
    'grid_path': 'data/prescreen/qwen38.toml',
    'grid_sha': 'x',
    'n_prompt': 512,
    'n_gen': 128,
    'reps': 5,
    'point_timeout': 900,
    'ctx_checks': 3,
    'model_file': 'model.gguf',
}


def _open_old(env, sweep_id, pid):
    asyncio.run(env.sweeps.open_sweep(sweep_id, pid=pid, **OLD_SWEEP))


def _dead_pid() -> int:
    proc = subprocess.Popen([sys.executable, '-c', 'pass'])
    proc.wait()
    return proc.pid


def test_a_stale_sweep_is_closed_and_its_orphan_stopped(env):
    orphan = subprocess.Popen(
        [str(env.bin / 'llama-bench')], env={**os.environ, 'STUB_MODE': 'hang'}, start_new_session=True
    )
    try:
        _open_old(env, 'old', _dead_pid())
        point = asyncio.run(env.points.open_point('old', phase='search', overrides={}, pgid=orphan.pid))
        closed = asyncio.run(prescreen_sweep.reclaim_stale())
        assert closed == 1
        assert env.sweeps.rows['old']['status'] == 'stale'
        assert env.points.rows[point]['status'] == 'cancelled'
        assert orphan.wait(timeout=10) is not None
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(orphan.pid, signal.SIGKILL)


def test_an_unrelated_process_with_a_recorded_pgid_is_left_alone(env):
    bystander = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
    try:
        _open_old(env, 'old', _dead_pid())
        asyncio.run(env.points.open_point('old', phase='search', overrides={}, pgid=bystander.pid, status='ok'))
        asyncio.run(prescreen_sweep.reclaim_stale())
        time.sleep(0.5)
        assert bystander.poll() is None
    finally:
        bystander.kill()


def test_a_sweep_running_under_another_live_backend_is_refused(env):
    other = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
    try:
        _open_old(env, 'elsewhere', other.pid)
        with pytest.raises(PrescreenRefused, match='another backend process'):
            asyncio.run(prescreen_sweep.reclaim_stale())
        assert env.sweeps.rows['elsewhere']['status'] == 'running'
    finally:
        other.kill()


def test_both_objectives_rank_by_pareto_layer():
    from local_llm.models.benchmarks.prescreen import BenchmarkPrescreenPointModel

    def point(pid, pp, tg):
        return BenchmarkPrescreenPointModel(
            point_id=pid,
            sweep_id='s',
            phase='search',
            is_baseline=False,
            overrides={'LLAMA_NGL': str(pid)},
            status='ok',
            started_at=0,
            pp_avg_ts=pp,
            tg_avg_ts=tg,
        )

    ranked = prescreen_sweep.rank([point(1, 100, 5), point(2, 200, 4), point(3, 90, 4.5), point(4, 150, 6)], 'both')
    assert [(r['point_id'], r['pareto_layer']) for r in ranked] == [(4, 0), (2, 0), (1, 1), (3, 2)]
