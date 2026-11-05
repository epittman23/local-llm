"""The Scheduled Tasks calendar shows the runs the scheduler will make (#356).

The calendar re-anchored an automation's rule at its next run, so a COUNT
started over from there, and it showed runs that never come: a daily rule
with COUNT=4 and one run left showed four. Future runs are now read from
the rule as the scheduler reads it.

Run from apps/server:

    python -m pytest tests/test_calendar_automation_runs.py
"""

from __future__ import annotations

import asyncio
import datetime as dt
import time
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from local_llm.utils.automations import next_n_runs_ns, next_run_ns, runs_between_ns

DAY_NS = 86_400 * 1_000_000_000


def _count_rule(days_ago: int = 2, count: int = 4) -> str:
    now = dt.datetime.now(dt.UTC).replace(tzinfo=None, second=0, microsecond=0)
    start = (now - dt.timedelta(days=days_ago)).replace(hour=8, minute=0)
    return f'DTSTART:{start:%Y%m%dT%H%M%S}\nRRULE:FREQ=DAILY;COUNT={count}'


def test_a_count_rule_shows_only_the_runs_left():
    rule = _count_rule()
    now = time.time_ns()

    runs = runs_between_ns(rule, next_run_ns(rule, tz='UTC'), now, now + 30 * DAY_NS, tz='UTC')

    assert runs == next_n_runs_ns(rule, n=10, tz='UTC')
    assert 1 <= len(runs) <= 2  # two of four ran on the two days before today


def test_a_rule_without_dtstart_keeps_the_time_of_its_next_run():
    now = time.time_ns()
    next_run = now + DAY_NS + 17 * 60 * 1_000_000_000

    runs = runs_between_ns('RRULE:FREQ=DAILY', next_run - next_run % 60_000_000_000, now, now + 5 * DAY_NS, tz='UTC')

    assert len(runs) in (4, 5)
    assert runs[0] == next_run - next_run % 60_000_000_000
    assert all(b - a == DAY_NS for a, b in zip(runs, runs[1:], strict=False))


def test_a_range_far_ahead_is_reached_whatever_the_rule_runs_before_it():
    now = time.time_ns()
    start = now + 60 * DAY_NS

    runs = runs_between_ns('RRULE:FREQ=MINUTELY;INTERVAL=5', now, start, start + DAY_NS, tz='UTC')

    assert len(runs) == 288
    assert all(start <= run < start + DAY_NS for run in runs)


def test_a_daily_rule_across_a_dst_change_matches_the_scheduler():
    rule = 'DTSTART:20270310T023000\nRRULE:FREQ=DAILY;COUNT=10'
    tz = 'America/New_York'
    now = time.time_ns()

    runs = runs_between_ns(rule, next_run_ns(rule, tz=tz), now, now + 400 * DAY_NS, tz=tz)

    assert runs == next_n_runs_ns(rule, n=10, tz=tz)


def test_a_time_the_clocks_skip_is_listed_once():
    tz = 'America/New_York'
    start = int(dt.datetime(2027, 3, 14, tzinfo=ZoneInfo(tz)).timestamp() * 1_000_000_000)
    end = int(dt.datetime(2027, 3, 14, 6, tzinfo=ZoneInfo(tz)).timestamp() * 1_000_000_000)

    runs = runs_between_ns('RRULE:FREQ=MINUTELY;INTERVAL=30', start, start, end, tz=tz)

    # Five hours pass between midnight and 06:00 that day: ten half-hours.
    assert len(runs) == 10
    assert runs == sorted(set(runs))


def test_a_sub_daily_count_rule_from_long_ago_matches_the_scheduler():
    start = dt.datetime(2015, 1, 1)
    elapsed = int((dt.datetime.now(dt.UTC).replace(tzinfo=None) - start) / dt.timedelta(minutes=30))
    rule = f'DTSTART:{start:%Y%m%dT%H%M%S}\nRRULE:FREQ=MINUTELY;INTERVAL=30;COUNT={elapsed + 6}'
    now = time.time_ns()

    runs = runs_between_ns(rule, next_run_ns(rule, tz='UTC'), now, now + DAY_NS, tz='UTC')

    assert runs == next_n_runs_ns(rule, n=10, tz='UTC')
    assert 4 <= len(runs) <= 6


def test_the_runs_are_capped_and_a_range_before_now_walks_nothing():
    now = time.time_ns()

    assert len(runs_between_ns('RRULE:FREQ=MINUTELY', now, now, now + DAY_NS, tz='UTC', limit=7)) == 7
    assert runs_between_ns('RRULE:FREQ=MINUTELY', now, now, now - DAY_NS, tz='UTC') == []


def test_the_calendar_shows_a_count_rule_s_remaining_runs(monkeypatch):
    from local_llm.models import automations as automations_model
    from local_llm.routers import calendar as calendar_router

    rule = _count_rule()
    automation = SimpleNamespace(
        id='a1', name='Daily report', data={'rrule': rule, 'prompt': 'p'}, next_run_at=next_run_ns(rule, tz='UTC'),
        created_at=1, updated_at=1,
    )  # fmt: skip

    async def check(*_a, **_k):
        return None

    async def yes(*_a, **_k):
        return True

    async def no_events(**_k):
        return []

    broken = SimpleNamespace(
        id='a2', name='Unreadable', data={'rrule': 'RRULE:FREQ=DAILY\nEXRULE:FREQ=WEEKLY'}, next_run_at=1,
        created_at=1, updated_at=1,
    )  # fmt: skip

    async def active(_uid):
        return [broken, automation]

    async def no_runs(*_a, **_k):
        return []

    monkeypatch.setattr(calendar_router, 'check_calendar_permission', check)
    monkeypatch.setattr(calendar_router, '_user_has_automations', yes)
    monkeypatch.setattr(calendar_router.CalendarEvents, 'get_events_by_range', no_events)
    monkeypatch.setattr(automations_model.Automations, 'get_active_by_user', active)
    monkeypatch.setattr(automations_model.AutomationRuns, 'get_runs_by_user_range', no_runs)

    today = dt.datetime.now(dt.UTC).date()
    events = asyncio.run(
        calendar_router.get_events(
            request=None,
            start=f'{today - dt.timedelta(days=3)}T00:00:00Z',
            end=f'{today + dt.timedelta(days=30)}T00:00:00Z',
            calendar_ids=None,
            user=SimpleNamespace(id='u1', timezone='UTC'),
        )
    )

    shown = [event['start_at'] for event in events if event['id'] == 'auto_a1']
    assert shown == next_n_runs_ns(rule, n=10, tz='UTC')
    assert all(event['instance_id'] == f'auto_a1_{event["start_at"]}' for event in events if event['id'] == 'auto_a1')
