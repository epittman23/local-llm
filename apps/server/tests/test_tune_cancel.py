"""Stopping a sweep mid-teardown or mid-cooldown leaves nothing running (#138).

`/stop` cancels the sweep's task. A cancellation that landed while a visit
was tearing its server down interrupted `Server.stop()` (so `ServeProcess.stop`
never stopped the telemetry recorder or removed the temp log) and skipped
the visit's `close_visit`. One that landed while cooling left the pause row
open. `finish()` then closed the sweep, and `reclaim_stale_sweeps()` skips
closed sweeps, so those rows stayed "running" forever.

Run from apps/server:

    python -m pytest tests/test_tune_cancel.py
"""

from __future__ import annotations

import asyncio
import types

import pytest

from local_llm.benchmarks.tuning import tune
from local_llm.benchmarks.tuning.tune_schedule import Candidate

CAND = Candidate('p', {'LLAMA_THREADS': '4'}, stage='explore')


def _sweep() -> tune.Sweep:
    sweep = tune.Sweep(tune.SweepOptions(), session=None)
    sweep.sweep_id = 'sweep-138'
    sweep.suite = {'id': 'tier', 'seed': 0}
    return sweep


def _record_visit_rows(monkeypatch) -> list[tuple]:
    calls: list[tuple] = []

    async def open_visit(*args, **kwargs):
        return 7

    async def set_visit(*args, **kwargs):
        return None

    async def close_visit(visit_id, **kwargs):
        calls.append((visit_id, kwargs))

    monkeypatch.setattr(tune.BenchmarkTuneVisits, 'open_visit', staticmethod(open_visit))
    monkeypatch.setattr(tune.BenchmarkTuneVisits, 'set_visit', staticmethod(set_visit))
    monkeypatch.setattr(tune.BenchmarkTuneVisits, 'close_visit', staticmethod(close_visit))
    return calls


def test_a_cancel_during_teardown_still_stops_the_server(monkeypatch):
    """The server's teardown runs to the end, and the cancellation still propagates."""
    events: list[str] = []

    async def scenario():
        stopping = asyncio.Event()
        release = asyncio.Event()

        class FakeServer:
            def __init__(self, *args, **kwargs):
                self.n_gen = 0
                self.tokens_per_second = None

            async def start(self):
                events.append('start')

            async def wait(self):
                return 10.0

            def pgid(self):
                return None

            async def stop(self):
                events.append('stop started')
                stopping.set()
                await release.wait()
                events.append('stop finished')

        async def context(*args, **kwargs):
            return {'config_id': None, 'run_id': 1}

        async def run_items(*args, **kwargs):
            return None

        async def rows_for(lo, hi, cand):
            return [{'benchmark': 'b', 'item_id': 'i'}]

        monkeypatch.setattr(tune, 'Server', FakeServer)
        monkeypatch.setattr(tune.runner, 'context', context)
        monkeypatch.setattr(tune.runner, 'run_items', run_items)
        sweep = _sweep()
        sweep.rows_for = rows_for
        rows = _record_visit_rows(monkeypatch)

        task = asyncio.create_task(sweep.visit(CAND, 1, 0, 1))
        await stopping.wait()
        task.cancel()  # what /stop does
        await asyncio.sleep(0)
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        return sweep, rows

    sweep, rows = asyncio.run(scenario())

    assert events == ['start', 'stop started', 'stop finished']
    # The visit's own bookkeeping still ran; its row is closed by finish(),
    # which an interrupted sweep always reaches (see the finish test below).
    assert sweep.sweep_id not in tune._current_visits
    assert sweep.serve_seconds >= 0.0
    assert rows == []


def test_a_cancel_during_cooling_closes_the_pause(monkeypatch):
    closed: list[tuple] = []

    async def open_pause(*args, **kwargs):
        return 11

    async def close_pause(pause_id, **kwargs):
        closed.append((pause_id, kwargs['resolution']))

    async def no_gpu():
        return None

    async def scenario():
        waiting = asyncio.Event()

        async def endless_wait(target, window):
            waiting.set()
            await asyncio.Event().wait()

        sweep = types.SimpleNamespace(
            sweep_id='sweep-138', baseline_tps=10.0, budget=types.SimpleNamespace(seconds=None), last_pause_at=None
        )
        cool = tune.Cooldown(sweep, tune.SweepOptions())
        cool.gpu = types.SimpleNamespace(read=no_gpu)
        cool._wait = endless_wait
        task = asyncio.create_task(cool.run(trigger='drift', rnd=1, visit_id=None, drift_ratio=0.5))
        await waiting.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return cool

    monkeypatch.setattr(tune.BenchmarkTunePauses, 'open_pause', staticmethod(open_pause))
    monkeypatch.setattr(tune.BenchmarkTunePauses, 'close_pause', staticmethod(close_pause))

    cool = asyncio.run(scenario())

    # 'abandoned': nobody watched the card to the end, so a resume re-probes.
    assert closed == [(11, 'abandoned')]
    assert cool.total_seconds >= 0.0


def _finish_with_open_rows(monkeypatch, ended_reason: str) -> tuple[list, list]:
    visits_closed: list[tuple] = []
    pauses_closed: list[tuple] = []

    async def sweep_visits(sweep_id, **kwargs):
        return [
            types.SimpleNamespace(visit_id=1, status='done'),
            types.SimpleNamespace(visit_id=2, status='running'),
        ]

    async def sweep_pauses(sweep_id, **kwargs):
        return [{'pause_id': 5, 'resolution': 'recovered'}, {'pause_id': 6, 'resolution': None}]

    async def close_visit(visit_id, **kwargs):
        visits_closed.append((visit_id, kwargs))

    async def close_pause(pause_id, **kwargs):
        pauses_closed.append((pause_id, kwargs['resolution']))

    async def fake_audit():
        return 'design', types.SimpleNamespace(blocked=lambda key: []), []

    async def fake_scores(rnd):
        return {}

    async def nothing(*args, **kwargs):
        return None

    async def fake_report(sweep_id, **kwargs):
        return {}

    sweep = _sweep()
    sweep.baseline = Candidate('p', {}, stage='explore', baseline=True)
    sweep.ended_reason = ended_reason
    sweep.audit = fake_audit
    sweep.scores = fake_scores
    monkeypatch.setattr(tune.BenchmarkTuneVisits, 'sweep_visits', staticmethod(sweep_visits))
    monkeypatch.setattr(tune.BenchmarkTunePauses, 'sweep_pauses', staticmethod(sweep_pauses))
    monkeypatch.setattr(tune.BenchmarkTuneVisits, 'close_visit', staticmethod(close_visit))
    monkeypatch.setattr(tune.BenchmarkTunePauses, 'close_pause', staticmethod(close_pause))
    monkeypatch.setattr(tune.BenchmarkTuneCandidates, 'set_candidate', staticmethod(nothing))
    monkeypatch.setattr(tune.BenchmarkTuneSweeps, 'close_sweep', staticmethod(nothing))
    monkeypatch.setattr(tune, 'sweep_report', fake_report)
    asyncio.run(sweep.finish([]))
    return visits_closed, pauses_closed


def test_an_interrupted_sweep_closes_the_rows_it_left_open(monkeypatch):
    visits, pauses = _finish_with_open_rows(monkeypatch, 'interrupted')

    assert visits == [
        (2, {'status': 'aborted', 'reason': 'interrupted', 'counts_toward_round': False}),
    ]
    assert pauses == [(6, 'abandoned')]


def test_a_sweep_that_ended_normally_leaves_its_rows_alone(monkeypatch):
    visits, pauses = _finish_with_open_rows(monkeypatch, 'complete')

    assert visits == []
    assert pauses == []
