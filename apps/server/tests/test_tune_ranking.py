"""A tune sweep adopts only a candidate that beat the profile's own defaults.

A candidate's score is its median paired log-ratio against the baseline
(Sweep.scores()), so a score of 0 means "as fast as the defaults" and a
negative one means slower. Sweep.best() once returned the top-scoring
candidate whatever its score, so a sweep where the defaults were already
fastest adopted a slower configuration, and refine() descended around it.

Run from apps/server:

    python -m pytest tests/test_tune_ranking.py
"""

from __future__ import annotations

import asyncio
import math
import types

from local_llm.benchmarks.tuning import tune
from local_llm.benchmarks.tuning.tune_schedule import Candidate

BASE = Candidate('p', {}, stage='explore', baseline=True)
FAST = Candidate('p', {'LLAMA_THREADS': '4'}, stage='explore')
SLOW = Candidate('p', {'LLAMA_THREADS': '6'}, stage='explore')
SLOWER = Candidate('p', {'LLAMA_THREADS': '8'}, stage='explore')
TIED = Candidate('p', {'LLAMA_THREADS': '10'}, stage='explore')


def _sweep(scores: dict[str, float]) -> tune.Sweep:
    sweep = tune.Sweep.__new__(tune.Sweep)
    sweep.sweep_id = 'sweep'
    sweep.baseline = BASE
    sweep.ended_reason = 'complete'

    async def fake_scores(rnd):
        return {sha: (score, 6) for sha, score in scores.items()}

    sweep.scores = fake_scores
    return sweep


def test_best_is_none_when_every_candidate_is_slower_than_the_defaults():
    sweep = _sweep({BASE.sha: 0.0, SLOW.sha: math.log(0.5), SLOWER.sha: math.log(0.4)})

    assert asyncio.run(sweep.best([BASE, SLOW, SLOWER])) is None


def test_best_is_none_when_the_leader_only_ties_the_defaults():
    sweep = _sweep({BASE.sha: 0.0, TIED.sha: 0.0, SLOW.sha: math.log(0.5)})

    assert asyncio.run(sweep.best([BASE, TIED, SLOW])) is None


def test_best_is_the_fastest_candidate_that_beat_the_defaults():
    sweep = _sweep({BASE.sha: 0.0, FAST.sha: math.log(1.2), SLOW.sha: math.log(0.5)})

    assert asyncio.run(sweep.best([BASE, SLOW, FAST])) is FAST


def _finish(monkeypatch, sweep: tune.Sweep, alive: list[Candidate], regressed: set[str]) -> dict:
    """Run finish() with the database and the guard replaced by records."""
    closed: dict = {}
    guarded: list[str] = []

    async def fake_audit():
        return 'design', types.SimpleNamespace(blocked=lambda key: []), []

    async def fake_guard(cand):
        guarded.append(cand.sha)
        return {'regressed': cand.sha in regressed, 'p': 0.01}

    async def fake_set_candidate(*args, **kwargs):
        return None

    async def fake_close_sweep(sweep_id, **kwargs):
        closed.update(kwargs)

    async def fake_report(sweep_id, **kwargs):
        return {'closed': closed, 'guarded': guarded}

    sweep.audit = fake_audit
    sweep.guard = fake_guard
    monkeypatch.setattr(tune.BenchmarkTuneCandidates, 'set_candidate', staticmethod(fake_set_candidate))
    monkeypatch.setattr(tune.BenchmarkTuneSweeps, 'close_sweep', staticmethod(fake_close_sweep))
    monkeypatch.setattr(tune, 'sweep_report', fake_report)
    return asyncio.run(sweep.finish(alive))


def test_finish_rejects_when_every_candidate_is_slower(monkeypatch):
    sweep = _sweep({BASE.sha: 0.0, SLOW.sha: math.log(0.5), SLOWER.sha: math.log(0.4)})

    got = _finish(monkeypatch, sweep, [BASE, SLOW, SLOWER], regressed=set())

    assert got['closed']['verdict'] == 'rejected'
    assert got['closed']['winner'] is None
    assert got['guarded'] == []


def test_finish_never_falls_back_to_a_slower_candidate(monkeypatch):
    """When the one faster candidate regresses, the slower ones are not next in line."""
    sweep = _sweep({BASE.sha: 0.0, FAST.sha: math.log(1.2), SLOW.sha: math.log(0.5)})

    got = _finish(monkeypatch, sweep, [BASE, FAST, SLOW], regressed={FAST.sha})

    assert got['closed']['verdict'] == 'rejected'
    assert got['closed']['winner'] is None
    assert got['guarded'] == [FAST.sha]


def test_finish_adopts_the_fastest_candidate_that_beat_the_defaults(monkeypatch):
    sweep = _sweep({BASE.sha: 0.0, FAST.sha: math.log(1.2), SLOW.sha: math.log(0.5)})

    got = _finish(monkeypatch, sweep, [BASE, FAST, SLOW], regressed=set())

    assert got['closed']['verdict'] == 'adopted'
    assert got['closed']['winner'] == FAST.sha


def test_refine_does_not_descend_around_a_slower_leader(monkeypatch):
    sweep = _sweep({BASE.sha: 0.0, SLOW.sha: math.log(0.5)})
    sweep.items = [('b', str(i)) for i in range(100)]
    sweep.budget = types.SimpleNamespace(round_items=10)

    async def must_not_run(*args, **kwargs):
        raise AssertionError('refine generated candidates around a slower leader')

    monkeypatch.setattr(tune, 'refine_candidates', must_not_run)

    assert asyncio.run(sweep.refine(3, [BASE, SLOW], 20)) == (3, [BASE, SLOW], 20)
