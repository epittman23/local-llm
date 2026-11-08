"""A rule whose time falls in a spring-forward gap goes back to it the day after (#670).

A daily rule that does not state its hour and minute takes them from when it
is read, and the scheduler reads it from each run's due time (#512). On the
day 02:30 does not exist the run is due at 03:30, so the rule stayed at 03:30
from then on. A saved rule that takes its time that way now has the time it
was saved at written down as its DTSTART.

Run from apps/server:

    python -m pytest tests/test_automation_dst_gap.py
"""

from __future__ import annotations

import datetime as dt
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from local_llm.utils import automations
from local_llm.utils.automations import next_run_ns, pin_rule_time

TZ = 'America/New_York'  # clocks go from 02:00 to 03:00 on 2027-03-14


def _ns(*parts: int, tz: str = TZ) -> int:
    """An instant given as a wall-clock time in `tz`; one in the gap reads as the time after it."""
    return int(dt.datetime(*parts, tzinfo=ZoneInfo(tz)).timestamp() * 1_000_000_000)


@pytest.fixture
def clock(monkeypatch):
    """The user's local now, for this module only: patching datetime itself would change dateutil's too."""
    now = {'at': None}

    class Clock(dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return now['at']

    monkeypatch.setattr(automations, 'dt', SimpleNamespace(datetime=Clock, timedelta=dt.timedelta, UTC=dt.UTC))

    def set_to(*parts: int) -> None:
        now['at'] = dt.datetime(*parts)

    return set_to


@pytest.mark.parametrize('rule', ['RRULE:FREQ=DAILY', 'FREQ=DAILY', 'RRULE:FREQ=WEEKLY;BYDAY=SU,MO'])
def test_a_rule_saved_at_02_30_runs_at_02_30_again_after_the_gap(clock, rule):
    clock(2027, 3, 13, 2, 30, 20)
    saved = pin_rule_time(rule, tz=TZ)
    due = next_run_ns(saved, tz=TZ)
    assert due == _ns(2027, 3, 14, 3, 30)  # 02:30 does not exist that day

    clock(2027, 3, 14, 3, 30, 5)  # the claim, which reads the rule from the due time
    assert next_run_ns(saved, tz=TZ, anchor_ns=due) == _ns(2027, 3, 15, 2, 30)


def test_a_rule_that_states_only_its_hour_keeps_its_minute_past_a_half_hour_gap(clock):
    tz = 'Australia/Lord_Howe'  # clocks go from 02:00 to 02:30 on 2026-10-04
    clock(2026, 10, 3, 2, 15, 40)
    saved = pin_rule_time('RRULE:FREQ=DAILY;BYHOUR=2', tz=tz)
    due = next_run_ns(saved, tz=tz)
    assert due == _ns(2026, 10, 4, 2, 45, tz=tz)

    clock(2026, 10, 4, 2, 45, 3)
    assert next_run_ns(saved, tz=tz, anchor_ns=due) == _ns(2026, 10, 5, 2, 15, tz=tz)


def test_the_saved_time_is_the_users_minute():
    now = dt.datetime(2027, 3, 13, 2, 30, 20)

    assert pin_rule_time('RRULE:FREQ=DAILY', now=now) == 'DTSTART:20270313T023000\nRRULE:FREQ=DAILY'


def test_a_rule_that_states_its_time_is_saved_as_given_and_keeps_it(clock):
    rule = 'RRULE:FREQ=DAILY;BYHOUR=2;BYMINUTE=30'
    clock(2027, 3, 13, 2, 30, 20)
    assert pin_rule_time(rule, tz=TZ) == rule  # the schedule picker shows a rule with a DTSTART as custom text
    due = next_run_ns(rule, tz=TZ)

    clock(2027, 3, 14, 3, 30, 5)
    assert next_run_ns(rule, tz=TZ, anchor_ns=due) == _ns(2027, 3, 15, 2, 30)


@pytest.mark.parametrize(
    'rule',
    [
        'DTSTART:20270101T023000\nRRULE:FREQ=DAILY',  # its own start
        'RRULE:FREQ=HOURLY',  # sub-daily, on its own grid
        'RRULE:FREQ=MINUTELY;INTERVAL=5',
        'RRULE:FREQ=WEEKLY;BYDAY=MO;BYMINUTE=0;BYHOUR=9',
    ],
)
def test_a_rule_that_takes_no_time_from_when_it_is_saved_is_kept_as_given(rule):
    assert pin_rule_time(rule, now=dt.datetime(2027, 3, 13, 2, 30, 20)) == rule
