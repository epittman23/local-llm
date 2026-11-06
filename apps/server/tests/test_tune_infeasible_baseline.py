"""A sweep whose baseline cannot run ends at once, and says why (#139).

Every candidate is scored against the profile's defaults (the baseline) on
paired items. A baseline that fails to load (its defaults run out of memory,
say) has no items to pair with, so every other candidate counted as "thin",
was kept round after round, and the budget ran out for a verdict that never
named the cause. Now the round stops at the baseline's failure, closes with
that reason and no survivors, and the verdict is `indeterminate`, naming
why the defaults could not run.

Run from apps/server:

    python -m pytest tests/test_tune_infeasible_baseline.py
"""

from __future__ import annotations

import asyncio

from local_llm.benchmarks.tuning import tune
from local_llm.benchmarks.tuning.tune_schedule import Candidate


def _sweep(monkeypatch, infeasible: set[str]):
    sweep = tune.Sweep(tune.SweepOptions(), session=None)
    sweep.sweep_id = 'sweep-139'
    base = Candidate('p', {}, stage='explore', baseline=True)
    others = [Candidate('p', {'LLAMA_THREADS': str(n)}, stage='explore') for n in (4, 8)]
    # What register() sets, without its database rows.
    sweep.candidates = {c.sha: c for c in (base, *others)}
    sweep.baseline = base
    visited: list[str] = []
    closed: list[dict] = []

    async def visit(cand, rnd, lo, hi, *, attempt):
        visited.append(cand.label)
        if cand.label in infeasible:
            cand.status, cand.reason = 'infeasible', 'out of memory loading the model'
            return {'status': 'infeasible', 'items': 0, 'drift': None}
        return {'status': 'done', 'items': hi - lo, 'drift': None}

    async def nothing(*_a, **_k):
        return None

    async def no_visits(*_a, **_k):
        return []

    async def close_round(sweep_id, rnd, **kwargs):
        closed.append(kwargs)

    monkeypatch.setattr(sweep, 'visit', visit)
    monkeypatch.setattr(sweep, 'spent', lambda: None)
    monkeypatch.setattr(tune.BenchmarkTuneRounds, 'open_round', staticmethod(nothing))
    monkeypatch.setattr(tune.BenchmarkTuneRounds, 'close_round', staticmethod(close_round))
    monkeypatch.setattr(tune.BenchmarkTuneVisits, 'sweep_visits', staticmethod(no_visits))
    return sweep, [base, *others], visited, closed


def test_a_baseline_that_cannot_run_ends_the_sweep_after_its_round(monkeypatch):
    sweep, alive, visited, closed = _sweep(monkeypatch, infeasible={'baseline'})

    # Round 1's rotation puts the baseline last, so the others ran first.
    survivors = asyncio.run(sweep.run_round(1, 'explore', alive, 0, 10))

    assert survivors == []
    assert visited[-1] == 'baseline'
    assert sweep.ended_reason == 'baseline'
    assert sweep.stopped()
    assert closed and closed[0]['survivors'] == 0
    assert 'out of memory' in closed[0]['decision']


def test_a_round_stops_visiting_once_the_baseline_fails(monkeypatch):
    sweep, alive, visited, _closed = _sweep(monkeypatch, infeasible={'baseline'})

    # A round whose rotation reaches the baseline first visits nobody after it.
    asyncio.run(sweep.run_round(3, 'explore', alive, 0, 10))

    assert visited == ['baseline']


def test_a_resumed_sweep_whose_baseline_already_failed_visits_nobody(monkeypatch):
    sweep, alive, visited, closed = _sweep(monkeypatch, infeasible=set())
    # What resume_sweep() loads: the baseline infeasible, with its reason, and so not alive.
    sweep.baseline.status, sweep.baseline.reason = 'infeasible', 'out of memory loading the model'
    others = [c for c in alive if not c.baseline]

    survivors = asyncio.run(sweep.run_round(2, 'explore', others, 10, 20))

    assert survivors == []
    assert visited == []
    assert sweep.ended_reason == 'baseline'
    assert 'out of memory' in closed[0]['decision']


def test_a_baseline_that_fails_after_measuring_is_visited_again_not_the_end(monkeypatch):
    sweep, alive, _visited, closed = _sweep(monkeypatch, infeasible={'baseline'})
    sweep.baseline_tps = 41.0  # round 1 measured the defaults

    async def absolute_baseline(rnd):
        return None

    async def eliminate(rnd, alive_now):
        return [sweep.baseline, *alive_now], 'kept all'

    monkeypatch.setattr(sweep, 'absolute_baseline', absolute_baseline)
    monkeypatch.setattr(sweep, 'eliminate', eliminate)

    survivors = asyncio.run(sweep.run_round(3, 'explore', alive, 20, 30))

    assert sweep.ended_reason == 'complete'
    assert sweep.baseline in survivors
    assert closed[0]['decision'] == 'kept all'


def test_the_verdict_names_why_the_defaults_could_not_run(monkeypatch):
    sweep, _alive, _visited, _closed = _sweep(monkeypatch, infeasible=set())
    sweep.baseline.status, sweep.baseline.reason = 'infeasible', 'out of memory loading the model'
    sweep.ended_reason = 'baseline'

    verdict, reason = sweep.verdict_for(blocked=[], winner=None)

    assert verdict == 'indeterminate'
    assert "profile's defaults could not run" in reason
    assert 'out of memory loading the model' in reason


def test_the_other_verdicts_are_unchanged(monkeypatch):
    sweep, alive, _visited, _closed = _sweep(monkeypatch, infeasible=set())

    assert sweep.verdict_for(blocked=[], winner=alive[1]) == ('adopted', '')
    assert sweep.verdict_for(blocked=[], winner=None) == ('rejected', 'no candidate beat the profile defaults')
    assert sweep.verdict_for(blocked=['a', 'b'], winner=alive[1]) == ('indeterminate', 'a; b')
    sweep.ended_reason = 'budget'
    assert sweep.verdict_for(blocked=[], winner=None) == ('incomplete', 'the time budget ran out mid-sweep')
