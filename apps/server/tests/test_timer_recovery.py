"""A chat timer is never left "running" for good (#270).

Claiming a due timer marks it running and clears timer_at; it becomes
completed only once its messages are written. An error before that escaped
the unreferenced background task, and a restart mid-run left nothing to
pick it up, so the timer stayed running and never fired. Now an error marks
it as such, and a timer running for longer than a run takes is put back to
pending, so the next poll runs it. These run against the test run's
migrated database.

Run from apps/server:

    python -m pytest tests/test_timer_recovery.py
"""

from __future__ import annotations

import asyncio
import time
import uuid
from contextlib import asynccontextmanager

import pytest

from local_llm.config import run_migrations
from local_llm.models.chats import ChatForm, Chats
from local_llm.models.users import Users
from local_llm.utils import automations, timers

MIN = 60 * 1_000_000_000


@pytest.fixture(autouse=True, scope='module')
def _migrated():
    run_migrations()


def _run(coro):
    return asyncio.run(coro)


def _timer(status: str, started_ns: int | None, timer_at: int) -> str:
    uid = f'timers-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, 'user', f'{uid}@example.com', role='user'))
    chat_id = str(uuid.uuid4())
    meta = {'internal': True, 'type': 'timer', 'status': status, 'timer_at': timer_at, 'parent_chat_id': 'p'}
    if started_ns is not None:
        meta |= {'timer_started_at': started_ns, 'timer_claim_id': 'old-claim'}
    _run(
        Chats.insert_new_chat(
            chat_id,
            uid,
            ChatForm(chat={'id': chat_id, 'title': 'Timer', 'history': {'messages': {}}}),
            internal_meta=meta,
            timer_at=None if status == 'running' else timer_at,
        )
    )
    return chat_id


def _meta(chat_id: str) -> dict:
    return _run(Chats.get_chat_by_id(chat_id)).meta or {}


def test_a_timer_left_running_is_pending_again_and_is_claimed(monkeypatch):
    now = time.time_ns()
    due = now - 20 * MIN
    stuck = _timer('running', now - 15 * MIN, due)

    _run(timers.recover_stale_timers(now))

    meta = _meta(stuck)
    assert meta['status'] == 'pending'
    assert meta.get('timer_claim_id') is None
    assert stuck in [timer_id for timer_id, _ in _run(timers.claim_due_timers(now, limit=1000))]


def test_a_timer_claimed_moments_ago_is_left_running():
    now = time.time_ns()
    fresh = _timer('running', now - 5 * 1_000_000_000, now - MIN)

    _run(timers.recover_stale_timers(now))

    assert _meta(fresh)['status'] == 'running'
    assert _meta(fresh)['timer_claim_id'] == 'old-claim'


def test_an_error_while_running_marks_the_timer_failed(monkeypatch):
    now = time.time_ns()
    claimed = _timer('running', now, now - MIN)

    async def broken(*args, **kwargs):
        raise RuntimeError('database went away')

    monkeypatch.setattr(timers.Chats, 'get_chat_by_id_and_user_id', broken)

    _run(timers.execute_due_timer(None, claimed, 'old-claim'))

    meta = _meta(claimed)
    assert meta['status'] == 'error'
    assert 'database went away' in meta['timer_error']


def test_a_timer_whose_error_cannot_be_recorded_still_ends_quietly(monkeypatch, caplog):
    async def broken(*args, **kwargs):
        raise RuntimeError('database went away')

    monkeypatch.setattr(timers.Chats, 'get_chat_by_id', broken)
    monkeypatch.setattr(timers, '_record_timer_error', broken)

    _run(timers.execute_due_timer(None, 'any-timer', 'any-claim'))

    assert 'its error could not be recorded' in caplog.text


def test_the_scheduler_recovers_timers_and_survives_a_failure(monkeypatch, caplog):
    seen = []

    async def recover(now_ns):
        seen.append(now_ns)
        raise RuntimeError('no database')

    monkeypatch.setattr(timers, 'recover_stale_timers', recover)

    _run(automations._recover_stale_timers())

    assert len(seen) == 1
    assert 'timer recovery error' in caplog.text


def test_a_cancel_that_comes_back_as_an_error_still_stops_the_scheduler(monkeypatch, caplog):
    # #817: cancelled twice inside the pool pre-ping, psycopg leaves the
    # connection ACTIVE and resetting autocommit raises ProgrammingError over
    # the CancelledError. The loop swallowed it and ran on, so asyncio.run
    # waited forever for it at exit.
    entered = asyncio.Event()
    calls = []

    async def claim(now_ns, limit=10):
        calls.append(now_ns)
        entered.set()
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            raise RuntimeError("can't change 'autocommit' now: connection in transaction status ACTIVE") from None
        return []

    async def untouched(*args, **kwargs):
        raise AssertionError('the scheduler went on after it was cancelled')

    monkeypatch.setattr(timers, 'claim_due_timers', claim)
    monkeypatch.setattr(automations, '_recover_stale_timers', untouched)
    monkeypatch.setattr(automations.Config, 'get', untouched)

    async def scenario():
        task = asyncio.create_task(automations.scheduler_worker_loop(None))
        await asyncio.wait_for(entered.wait(), timeout=2)
        task.cancel()
        done, _ = await asyncio.wait({task}, timeout=2)
        if not done:
            task.cancel()
        return task, bool(done)

    task, done = _run(scenario())

    assert done, 'the scheduler kept running after it was cancelled'
    assert task.cancelled()
    assert len(calls) == 1
    assert 'timer error' not in caplog.text


def test_a_cancel_that_comes_back_as_an_error_in_the_automation_claim_stops_the_scheduler(monkeypatch, caplog):
    # The automation claim checks a connection out the same way (#817).
    entered = asyncio.Event()
    after_cancel = []

    async def no_timers(now_ns, limit=10):
        return []

    async def recover():
        return None

    async def config_get(key):
        if key != 'automations.enable':
            after_cancel.append(key)
        return True

    async def claim_due(now_ns, limit=10, db=None):
        entered.set()
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            raise RuntimeError("can't change 'autocommit' now: connection in transaction status ACTIVE") from None
        return []

    async def calendar_alerts(app):
        after_cancel.append('calendar alerts')

    @asynccontextmanager
    async def no_db():
        yield None

    monkeypatch.setattr(timers, 'claim_due_timers', no_timers)
    monkeypatch.setattr(automations, '_recover_stale_timers', recover)
    monkeypatch.setattr(automations.Config, 'get', config_get)
    monkeypatch.setattr(automations, 'get_async_db', no_db)
    monkeypatch.setattr(automations.Automations, 'claim_due', claim_due)
    monkeypatch.setattr(automations, '_check_calendar_alerts', calendar_alerts)

    async def scenario():
        task = asyncio.create_task(automations.scheduler_worker_loop(None))
        await asyncio.wait_for(entered.wait(), timeout=2)
        task.cancel()
        done, _ = await asyncio.wait({task}, timeout=2)
        if not done:
            task.cancel()
        return task, bool(done)

    task, done = _run(scenario())

    assert done, 'the scheduler kept running after it was cancelled'
    assert task.cancelled()
    assert after_cancel == []
    assert 'automation error' not in caplog.text


def _cancel_once_entered(entered: asyncio.Event):
    async def scenario():
        task = asyncio.create_task(automations.scheduler_worker_loop(None))
        await asyncio.wait_for(entered.wait(), timeout=2)
        task.cancel()
        done, _ = await asyncio.wait({task}, timeout=2)
        if not done:
            task.cancel()
        return task, bool(done)

    return _run(scenario())


async def _hang_then_fail(entered: asyncio.Event):
    # A cancelled DB call whose cleanup raises over the CancelledError (#817).
    entered.set()
    try:
        await asyncio.sleep(10)
    except asyncio.CancelledError:
        raise RuntimeError("can't change 'autocommit' now: connection in transaction status ACTIVE") from None


def _no_timers(monkeypatch):
    async def no_timers(now_ns, limit=10):
        return []

    monkeypatch.setattr(timers, 'claim_due_timers', no_timers)


def test_a_cancel_that_comes_back_as_an_error_in_the_calendar_alerts_stops_the_scheduler(monkeypatch, caplog):
    entered = asyncio.Event()
    _no_timers(monkeypatch)

    async def recover():
        return None

    async def config_get(key):
        return key == 'calendar.enable'

    async def calendar_alerts(app):
        await _hang_then_fail(entered)

    monkeypatch.setattr(automations, '_recover_stale_timers', recover)
    monkeypatch.setattr(automations.Config, 'get', config_get)
    monkeypatch.setattr(automations, '_check_calendar_alerts', calendar_alerts)

    task, done = _cancel_once_entered(entered)

    assert done, 'the scheduler kept running after it was cancelled'
    assert task.cancelled()
    assert 'calendar alert error' not in caplog.text


def test_a_cancel_swallowed_by_timer_recovery_stops_the_scheduler_before_it_sleeps(monkeypatch):
    # _recover_stale_timers logs and swallows its own errors, so only the
    # check before the loop's sleep sees the cancel.
    entered = asyncio.Event()
    claims = []

    async def claim(now_ns, limit=10):
        claims.append(now_ns)
        return []

    async def recover(now_ns):
        await _hang_then_fail(entered)

    async def config_get(key):
        return False

    monkeypatch.setattr(timers, 'claim_due_timers', claim)
    monkeypatch.setattr(timers, 'recover_stale_timers', recover)
    monkeypatch.setattr(automations.Config, 'get', config_get)

    task, done = _cancel_once_entered(entered)

    assert done, 'the scheduler kept running after it was cancelled'
    assert task.cancelled()
    assert len(claims) == 1


def test_the_scheduler_polls_timers_between_scheduler_polls_until_cancelled(monkeypatch):
    # Between scheduler polls an iteration only claims timers, then sleeps.
    entered = asyncio.Event()
    claims = []
    recoveries = []
    real_sleep = asyncio.sleep

    async def claim(now_ns, limit=10):
        claims.append(now_ns)
        if len(claims) == 3:
            entered.set()
            await asyncio.Event().wait()
        return []

    async def recover():
        recoveries.append(1)

    async def config_get(key):
        return False

    async def fast_sleep(seconds):
        await real_sleep(0)

    monkeypatch.setattr(timers, 'claim_due_timers', claim)
    monkeypatch.setattr(automations, '_recover_stale_timers', recover)
    monkeypatch.setattr(automations.Config, 'get', config_get)
    monkeypatch.setattr(automations.asyncio, 'sleep', fast_sleep)

    task, done = _cancel_once_entered(entered)

    assert done, 'the scheduler kept running after it was cancelled'
    assert task.cancelled()
    assert len(claims) == 3
    assert recoveries == [1]


def test_a_chat_that_only_looks_like_a_running_timer_is_left_alone():
    """An imported chat can carry any meta; only internal timer chats are recovered."""
    uid = f'timers-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, 'user', f'{uid}@example.com', role='user'))
    chat_id = str(uuid.uuid4())
    _run(
        Chats.insert_new_chat(
            chat_id,
            uid,
            ChatForm(chat={'id': chat_id, 'title': 'Imported', 'history': {'messages': {}}}),
            internal_meta={'status': 'running', 'note': 'from an export'},
        )
    )

    recovered = _run(timers.recover_stale_timers(time.time_ns()))

    assert chat_id not in recovered
    assert _meta(chat_id)['status'] == 'running'


def test_a_run_that_outlived_recovery_does_not_fail_the_new_claim(monkeypatch):
    now = time.time_ns()
    claimed = _timer('running', now, now - MIN)
    # Recovered and claimed again while the old run hung.
    _run(timers._set_timer_state(claimed, 'running', timer_claim_id='new-claim'))

    async def unlocked(*args, **kwargs):
        raise RuntimeError('redis timed out')

    monkeypatch.setattr(timers, '_execute_due_timer', unlocked)

    _run(timers.execute_due_timer(None, claimed, 'old-claim'))

    meta = _meta(claimed)
    assert meta['status'] == 'running'
    assert meta['timer_claim_id'] == 'new-claim'
