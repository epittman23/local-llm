"""An automation runs once at a time (S6-D13).

Run now started a run in the background whatever else was going on, so it
could overlap a scheduled run of the same automation. With "Same chat every
time" the second run's prompt went under the first run's still-empty reply
(the chat forked), and a same-chat automation with no chat yet got two,
since a run's chat is recorded only when the run ends. Now a run already
under way in this process makes Run now a 409 and the scheduler skip that
occurrence (claim_due has already moved the automation to its next run).

Run from apps/server:

    python -m pytest tests/test_automation_one_run_at_a_time.py
"""

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.routers import automations as automations_router
from local_llm.utils import automations


@pytest.fixture
def runs(monkeypatch):
    """execute_automation replaced by one that waits until the test lets it end; records the ids it ran."""
    monkeypatch.setattr(automations, '_running_automations', set())
    state = SimpleNamespace(started=[], release=None, fail=False)

    async def execute(app, automation):
        state.started.append(automation.id)
        await state.release.wait()
        if state.fail:
            raise RuntimeError('the model went away')

    monkeypatch.setattr(automations, 'execute_automation', execute)
    return state


async def _settle():
    for _ in range(5):
        await asyncio.sleep(0)


def test_a_second_run_waits_for_the_first_to_end(runs):
    a, b = SimpleNamespace(id='a1'), SimpleNamespace(id='b1')

    async def scenario():
        runs.release = asyncio.Event()
        first = automations.start_automation_run(None, a)
        again = automations.start_automation_run(None, a)
        other = automations.start_automation_run(None, b)
        await _settle()
        runs.release.set()
        await _settle()
        after = automations.start_automation_run(None, a)
        await _settle()
        return first, again, other, after

    assert asyncio.run(scenario()) == (True, False, True, True)
    assert runs.started == ['a1', 'b1', 'a1']
    assert automations._running_automations == set()


def test_a_run_that_fails_still_lets_the_next_one_start(runs):
    runs.fail = True
    a = SimpleNamespace(id='a1')

    async def scenario():
        runs.release = asyncio.Event()
        runs.release.set()
        loop = asyncio.get_running_loop()
        loop.set_exception_handler(lambda *_: None)
        assert automations.start_automation_run(None, a)
        await _settle()
        return automations.start_automation_run(None, a)

    assert asyncio.run(scenario()) is True


def test_run_now_during_a_run_is_a_409(monkeypatch):
    monkeypatch.setattr(automations, '_running_automations', {'a1'})
    automation = SimpleNamespace(id='a1', user_id='u1', name='Digest')

    async def allowed(*_a, **_k):
        return None

    async def get_by_id(id, db=None):
        return automation

    monkeypatch.setattr(automations_router, 'check_automations_permission', allowed)
    monkeypatch.setattr(automations_router.Automations, 'get_by_id', get_by_id)
    monkeypatch.setattr(automations_router, 'check_automation_access', lambda *_a: None)
    request = SimpleNamespace(app=None)

    with pytest.raises(HTTPException) as refused:
        asyncio.run(automations_router.run_automation_by_id(request, 'a1', user=SimpleNamespace(id='u1'), db=None))

    assert refused.value.status_code == 409
    assert 'already running' in refused.value.detail


def test_run_now_starts_a_run_when_none_is_going(monkeypatch, runs):
    automation = SimpleNamespace(id='a1', user_id='u1', name='Digest')

    async def allowed(*_a, **_k):
        return None

    async def get_by_id(id, db=None):
        return automation

    async def enrich(a, db, tz=None):
        return {'id': a.id}

    monkeypatch.setattr(automations_router, 'check_automations_permission', allowed)
    monkeypatch.setattr(automations_router.Automations, 'get_by_id', get_by_id)
    monkeypatch.setattr(automations_router, 'check_automation_access', lambda *_a: None)
    monkeypatch.setattr(automations_router, 'enrich_automation', enrich)

    async def scenario():
        runs.release = asyncio.Event()
        res = await automations_router.run_automation_by_id(
            SimpleNamespace(app=None), 'a1', user=SimpleNamespace(id='u1', timezone=None), db=None
        )
        await _settle()
        running = set(automations._running_automations)
        runs.release.set()
        await _settle()
        return res, running

    assert asyncio.run(scenario()) == ({'id': 'a1'}, {'a1'})
    assert runs.started == ['a1']


def test_the_scheduler_skips_an_automation_still_running(monkeypatch, caplog, runs):
    monkeypatch.setattr(automations, '_running_automations', {'busy'})
    claimed = asyncio.Event()

    async def no_timers(now_ns, limit=10):
        return []

    async def nothing(*_a, **_k):
        return None

    async def config_get(key):
        return key == 'automations.enable'

    async def claim_due(now_ns, limit=10, db=None):
        claimed.set()
        return [SimpleNamespace(id='busy'), SimpleNamespace(id='idle')]

    @asynccontextmanager
    async def no_db():
        yield None

    from local_llm.utils import timers

    monkeypatch.setattr(timers, 'claim_due_timers', no_timers)
    monkeypatch.setattr(automations, '_recover_stale_timers', nothing)
    monkeypatch.setattr(automations.Config, 'get', config_get)
    monkeypatch.setattr(automations, 'get_async_db', no_db)
    monkeypatch.setattr(automations.Automations, 'claim_due', claim_due)

    async def scenario():
        runs.release = asyncio.Event()
        task = asyncio.create_task(automations.scheduler_worker_loop(None))
        await asyncio.wait_for(claimed.wait(), timeout=2)
        await _settle()
        task.cancel()
        await asyncio.wait({task}, timeout=2)
        runs.release.set()
        await _settle()

    with caplog.at_level('INFO', logger=automations.log.name):
        asyncio.run(scenario())

    assert runs.started == ['idle']
    assert 'Automation busy is still running; skipping this run' in caplog.text
