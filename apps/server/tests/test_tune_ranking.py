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
import time
import types

from local_llm.benchmarks.tuning import tune
from local_llm.benchmarks.tuning.tune_schedule import Budget, Candidate

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
    assert got['closed']['verdict_reason'] == 'no candidate beat the profile defaults'
    assert got['closed']['winner'] is None
    assert got['guarded'] == []


def test_finish_never_falls_back_to_a_slower_candidate(monkeypatch):
    """When the one faster candidate regresses, the slower ones are not next in line."""
    sweep = _sweep({BASE.sha: 0.0, FAST.sha: math.log(1.2), SLOW.sha: math.log(0.5)})

    got = _finish(monkeypatch, sweep, [BASE, FAST, SLOW], regressed={FAST.sha})

    assert got['closed']['verdict'] == 'rejected'
    assert got['closed']['verdict_reason'] == 'every faster candidate showed a correctness regression'
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
    sweep.grid = sweep.profile_json = None
    sweep.candidates = {}

    async def must_not_run(*args, **kwargs):
        raise AssertionError('refine generated candidates around a slower leader')

    monkeypatch.setattr(tune, 'refine_candidates', must_not_run)

    assert asyncio.run(sweep.refine(3, [BASE, SLOW], 20)) == (3, [BASE, SLOW], 20)


# --- elimination (#135, #136) ----------------------------------------------------


def _eliminate(
    monkeypatch, scores: dict[str, float], alive: list[Candidate], matrix: dict | None = None
) -> tuple[list[Candidate], str]:
    sweep = _sweep(scores)
    sweep.o = tune.SweepOptions()

    async def no_matrix(sweep_id, rnd=None):
        return matrix or {}

    async def fake_set_candidate(*args, **kwargs):
        return None

    monkeypatch.setattr(tune, 'tune_matrix', no_matrix)
    monkeypatch.setattr(tune.BenchmarkTuneCandidates, 'set_candidate', staticmethod(fake_set_candidate))
    return asyncio.run(sweep.eliminate(1, alive))


def test_a_candidate_tied_with_the_defaults_outranks_slower_ones(monkeypatch):
    """A score of exactly 0.0 was read as missing and ranked below everything (#135)."""
    scores = {BASE.sha: 0.0, TIED.sha: 0.0, SLOW.sha: math.log(0.5), SLOWER.sha: math.log(0.4)}

    survivors, _ = _eliminate(monkeypatch, scores, [BASE, SLOW, SLOWER, TIED])

    assert survivors[:2] == [BASE, TIED]
    assert SLOWER not in survivors


def test_a_cut_with_no_paired_differences_is_recorded_as_uncertain(monkeypatch):
    """n = 0 pairs is no evidence for the cut, not support for it (#136)."""
    scores = {BASE.sha: 0.0, FAST.sha: math.log(1.2), SLOW.sha: math.log(0.5), SLOWER.sha: math.log(0.4)}

    _, decision = _eliminate(monkeypatch, scores, [BASE, FAST, SLOW, SLOWER])

    assert decision == 'uncertain'


# --- cooldown budget (#137) ------------------------------------------------------


def test_cooling_counts_earlier_pauses_against_the_cooldown_share(monkeypatch):
    """A retry inside a pause overwrote the running total with that pause's own time (#137)."""
    clock = [0.0]
    waits: list[float] = []

    class FakeTime:
        @staticmethod
        def time():
            return clock[0]

    async def fake_wait(target, window):
        waits.append(window)
        clock[0] += 1000.0

    async def slow_probe():
        return 5.0

    async def nothing(*args, **kwargs):
        return None

    async def no_gpu():
        return None

    sweep = types.SimpleNamespace(
        sweep_id='sweep',
        baseline_tps=10.0,
        budget=types.SimpleNamespace(seconds=10_000),
        started=0.0,
        last_pause_at=None,
    )
    cool = tune.Cooldown(sweep, tune.SweepOptions(cooldown_attempts=5, max_cooldown_share=0.5))
    cool.total_seconds = 3000.0  # earlier pauses
    cool.gpu = types.SimpleNamespace(read=no_gpu)
    cool._wait = fake_wait
    cool._probe = slow_probe
    monkeypatch.setattr(tune, 'time', FakeTime)
    monkeypatch.setattr(tune.BenchmarkTunePauses, 'open_pause', staticmethod(nothing))
    monkeypatch.setattr(tune.BenchmarkTunePauses, 'close_pause', staticmethod(nothing))

    resolution = asyncio.run(cool.run(trigger='drift', rnd=1, visit_id=None, drift_ratio=0.5))

    # The share is 5,000 s: 3,000 s earlier plus a third 1,000 s attempt exceeds it.
    assert resolution == 'timeout'
    assert len(waits) == 3
    assert cool.total_seconds == 6000.0


def _cool_with_spent_budget(monkeypatch, *, now: float, earlier: float):
    """A Cooldown on a 10,000 s budget with a 5,000 s cooling share, at `now` seconds in."""
    clock = [now]
    calls: list[str] = []

    class FakeTime:
        @staticmethod
        def time():
            return clock[0]

    async def fake_wait(target, window):
        calls.append('wait')
        clock[0] += 1000.0

    async def slow_probe():
        calls.append('probe')
        return 5.0

    async def open_pause(*args, **kwargs):
        calls.append('open_pause')

    async def close_pause(*args, **kwargs):
        calls.append('close_pause')

    async def no_gpu():
        return None

    sweep = types.SimpleNamespace(
        sweep_id='sweep',
        baseline_tps=10.0,
        budget=types.SimpleNamespace(seconds=10_000),
        started=0.0,
        last_pause_at=None,
    )
    cool = tune.Cooldown(sweep, tune.SweepOptions(cooldown_attempts=5, max_cooldown_share=0.5))
    cool.total_seconds = earlier
    cool.gpu = types.SimpleNamespace(read=no_gpu)
    cool._wait = fake_wait
    cool._probe = slow_probe
    monkeypatch.setattr(tune, 'time', FakeTime)
    monkeypatch.setattr(tune.BenchmarkTunePauses, 'open_pause', staticmethod(open_pause))
    monkeypatch.setattr(tune.BenchmarkTunePauses, 'close_pause', staticmethod(close_pause))

    resolution = asyncio.run(cool.run(trigger='drift', rnd=1, visit_id=None, drift_ratio=0.5))
    return resolution, calls, cool, sweep


def test_a_spent_cooling_share_starts_no_cooldown(monkeypatch):
    """Earlier pauses already used the 5,000 s share: no wait, no probe, no pause row (#511)."""
    resolution, calls, cool, sweep = _cool_with_spent_budget(monkeypatch, now=1000.0, earlier=6000.0)

    assert resolution == 'timeout'
    assert calls == []
    assert cool.count == 0
    assert cool.total_seconds == 6000.0
    assert sweep.last_pause_at is None


def test_a_spent_wall_clock_budget_starts_no_cooldown(monkeypatch):
    """The 10,000 s budget has run out with no cooling spent: no wait, no probe, no pause row (#511)."""
    resolution, calls, cool, sweep = _cool_with_spent_budget(monkeypatch, now=10_000.0, earlier=0.0)

    assert resolution == 'timeout'
    assert calls == []
    assert cool.count == 0
    assert cool.total_seconds == 0.0
    assert sweep.last_pause_at is None


def _interactive_sweep(elapsed: float) -> tune.Sweep:
    """An interactive sweep (fall_back halts it) `elapsed` seconds into its 7,200 s budget."""
    sweep = tune.Sweep(tune.SweepOptions(), session=None)
    sweep.budget = Budget('interactive', seconds=7200, visits=None, candidates=6, round_items=6)
    sweep.started = time.time() - elapsed
    return sweep


def test_a_halt_on_a_spent_budget_ends_for_the_budget():
    """Cooling was skipped because time ran out, so the sweep ended on its budget, not on drift (#511)."""
    sweep = _interactive_sweep(elapsed=7200.0)

    assert sweep.fall_back(1) is False
    assert sweep.ended_reason == 'budget'


def test_a_halt_within_the_budget_still_ends_for_drift():
    """Time is left and the card did not recover: drift is the reason the sweep ended."""
    sweep = _interactive_sweep(elapsed=60.0)

    assert sweep.fall_back(1) is False
    assert sweep.ended_reason == 'drift'


def test_a_cut_the_items_agree_on_is_still_supported(monkeypatch):
    """Six items, every one faster on the kept side: p = 0.03, so the cut stands."""
    scores = {BASE.sha: 0.0, FAST.sha: math.log(1.2), SLOW.sha: math.log(0.5), SLOWER.sha: math.log(0.4)}
    matrix = {}
    for i in range(6):
        for cand, tps in ((BASE, 10.0), (FAST, 12.0), (SLOW, 5.0), (SLOWER, 4.0)):
            matrix[('b', str(i), cand.sha)] = {'gen_tps': tps}

    survivors, decision = _eliminate(monkeypatch, scores, [BASE, FAST, SLOW, SLOWER], matrix)

    assert decision == 'kept 2 of 4'
    assert survivors == [BASE, FAST]


def test_cooling_spent_sums_the_stored_pauses():
    """A resume rebuilds the cooling total from the sweep's pauses (#511)."""
    opts = tune.SweepOptions()
    assert tune.cooling_spent([], opts) == 0.0
    assert tune.cooling_spent([{'seconds': 120}, {'seconds': 300}], opts) == 420.0


def test_cooling_spent_caps_a_pause_a_crash_left_open():
    """A crashed tuner's pause closes at reclaim time; it counts at most the longest cooldown (#511)."""
    opts = tune.SweepOptions(cooldown_max=900.0, cooldown_attempts=4)
    assert tune.cooling_spent([{'seconds': 86_400}], opts) == 900.0 * 15


def test_a_resumed_sweep_keeps_the_cooling_it_spent(monkeypatch):
    """Resuming after 4,000 of a 5,000 s share leaves 1,000 s; a fresh sweep has all 5,000 s (#511)."""
    opts = tune.SweepOptions(max_cooldown_share=0.5)
    sweep = types.SimpleNamespace(budget=types.SimpleNamespace(seconds=10_000), started=0.0)

    fresh = tune.Cooldown(sweep, opts)
    assert not fresh.budget_exhausted(4_999.0)
    assert fresh.budget_exhausted(5_001.0)

    resumed = tune.Cooldown(sweep, opts)
    resumed.total_seconds = tune.cooling_spent([{'seconds': 1500}, {'seconds': 2500}], opts)
    assert resumed.total_seconds == 4000.0
    assert not resumed.budget_exhausted(999.0)
    assert resumed.budget_exhausted(1_001.0)
