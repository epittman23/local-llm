"""Stopping a sweep mid-teardown or mid-cooldown leaves nothing running (#138).

`/stop` cancels the sweep's task. A cancellation that landed while a visit
was tearing its server down interrupted `Server.stop()` (so `ServeProcess.stop`
never stopped the telemetry recorder or removed the temp log) and skipped
the visit's `close_visit`. One that landed while cooling left the pause row
open. `finish()` then closed the sweep, and `reclaim_stale_sweeps()` skips
closed sweeps, so those rows stayed "running" forever.

A visit that measured to the end still closes as 'done' and counts, since
its items are graded and committed; closing it as aborted would drop them
from the round's statistic for good.

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


def _fake_server(events: list[str], stopping: asyncio.Event, release: asyncio.Event):
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

    return FakeServer


def _visit_in_teardown(monkeypatch, *, same_tick: bool):
    """Cancel a visit whose items all ran, while its server is being stopped."""
    events: list[str] = []

    async def scenario():
        stopping = asyncio.Event()
        release = asyncio.Event()

        async def context(*args, **kwargs):
            return {'config_id': None, 'run_id': 1}

        async def run_items(*args, **kwargs):
            return None

        async def rows_for(lo, hi, cand):
            return [{'benchmark': 'b', 'item_id': 'i'}]

        monkeypatch.setattr(tune, 'Server', _fake_server(events, stopping, release))
        monkeypatch.setattr(tune.runner, 'context', context)
        monkeypatch.setattr(tune.runner, 'run_items', run_items)
        sweep = _sweep()
        sweep.rows_for = rows_for
        rows = _record_visit_rows(monkeypatch)

        task = asyncio.create_task(sweep.visit(CAND, 1, 0, 1))
        await stopping.wait()
        if same_tick:
            # The teardown's last await resolves in the tick /stop lands.
            release.set()
            task.cancel()
        else:
            task.cancel()  # what /stop does
            await asyncio.sleep(0)
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        return sweep, rows

    sweep, rows = asyncio.run(scenario())
    return events, sweep, rows


DONE = (7, {'status': 'done', 'items_done': 0, 'counts_toward_round': True, 'reason': ''})


def test_a_cancel_during_teardown_still_stops_the_server(monkeypatch):
    """The teardown runs to the end, the visit closes as measured, and the cancel propagates."""
    events, sweep, rows = _visit_in_teardown(monkeypatch, same_tick=False)

    assert events == ['start', 'stop started', 'stop finished']
    assert sweep.sweep_id not in tune._current_visits
    assert sweep.serve_seconds > 0.0
    assert rows == [DONE]


def test_a_visit_that_is_not_stopped_closes_as_done(monkeypatch):
    events: list[str] = []

    async def scenario():
        release = asyncio.Event()
        release.set()

        async def context(*args, **kwargs):
            return {'config_id': None, 'run_id': 1}

        async def run_items(*args, **kwargs):
            return None

        async def rows_for(lo, hi, cand):
            return [{'benchmark': 'b', 'item_id': 'i'}]

        monkeypatch.setattr(tune, 'Server', _fake_server(events, asyncio.Event(), release))
        monkeypatch.setattr(tune.runner, 'context', context)
        monkeypatch.setattr(tune.runner, 'run_items', run_items)
        sweep = _sweep()
        sweep.rows_for = rows_for
        rows = _record_visit_rows(monkeypatch)
        return await sweep.visit(CAND, 1, 0, 1), rows

    summary, rows = asyncio.run(scenario())

    assert summary == {'status': 'done', 'items': 0, 'drift': None, 'visit_id': 7}
    assert events == ['start', 'stop started', 'stop finished']
    assert rows == [DONE]


def test_a_cancel_in_the_tick_the_teardown_ends_is_not_lost(monkeypatch):
    events, sweep, rows = _visit_in_teardown(monkeypatch, same_tick=True)

    assert events == ['start', 'stop started', 'stop finished']
    assert rows == [DONE]


def test_uncancellable_returns_and_raises_like_its_awaitable_without_a_cancel():
    async def fine():
        return None

    async def broken():
        raise OSError('log file')

    asyncio.run(tune._uncancellable(fine()))
    with pytest.raises(OSError):
        asyncio.run(tune._uncancellable(broken()))


def test_a_teardown_that_fails_after_a_cancel_still_reports_the_cancel():
    """execute() catches only CancelledError, so the cancel must win or finish() is skipped."""

    async def scenario():
        started = asyncio.Event()
        release = asyncio.Event()

        async def failing_teardown():
            started.set()
            await release.wait()
            raise OSError('log file')

        task = asyncio.create_task(tune._uncancellable(failing_teardown()))
        await started.wait()
        task.cancel()
        await asyncio.sleep(0)
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())


def test_a_cancel_during_the_probe_teardown_still_stops_the_server(monkeypatch):
    events: list[str] = []

    async def served_model(*args, **kwargs):
        return 'm'

    async def ask(*args, **kwargs):
        return types.SimpleNamespace(gone=False, error=None, timings={})

    async def scenario():
        stopping = asyncio.Event()
        release = asyncio.Event()
        monkeypatch.setattr(tune, 'Server', _fake_server(events, stopping, release))
        monkeypatch.setattr(tune.env_profile, 'served_model', served_model)
        monkeypatch.setattr(tune.runner, 'ask', ask)
        monkeypatch.setattr(tune, 'render_prompt', lambda adapter, item: 'prompt')
        sweep = _sweep()
        sweep.baseline = Candidate('p', {}, stage='explore', baseline=True)
        sweep.probe_rows = lambda: [{'adapter': None, 'item': None}]
        task = asyncio.create_task(sweep.cool._probe())
        await stopping.wait()
        task.cancel()
        await asyncio.sleep(0)
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())

    assert events == ['start', 'stop started', 'stop finished']


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
    assert cool.total_seconds > 0.0


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

    assert visits == [(2, {'status': 'aborted', 'reason': tune.LEFT_OPEN})]
    assert pauses == [(6, 'abandoned')]


def test_a_sweep_that_ended_normally_leaves_its_rows_alone(monkeypatch):
    visits, pauses = _finish_with_open_rows(monkeypatch, 'complete')

    assert visits == []
    assert pauses == []


def test_a_resume_re_probes_only_when_the_latest_pause_was_abandoned():
    abandoned = {'resolution': 'abandoned'}
    recovered = {'resolution': 'recovered'}

    assert tune.latest_pause_abandoned([recovered, abandoned])
    # An abandoned pause a later one resolved says nothing about the card now.
    assert not tune.latest_pause_abandoned([abandoned, recovered])
    assert not tune.latest_pause_abandoned([])
