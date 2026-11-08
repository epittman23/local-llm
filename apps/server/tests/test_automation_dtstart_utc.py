"""A DTSTART or UNTIL ending in Z is a UTC instant, run at that instant (#837).

`_parse_rule` reads a rule in the user's wall-clock time and drops the zone
with `ignoretz`, so `DTSTART:20271106T002800Z` ran at 00:28 local time, six
hours late for a user in America/Chicago. A Z time is now converted to the
user's zone first; a time without Z is read as local, as before.

Run from apps/server:

    python -m pytest tests/test_automation_dtstart_utc.py
"""

from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

import pytest

from local_llm.utils.automations import next_n_runs_ns, next_run_ns, pin_rule_time, runs_between_ns, validate_rrule

TZ = 'America/Chicago'  # CST (UTC-6) until 2027-03-14, CDT (UTC-5) after, until 2027-11-07


def _ns(*parts: int, tz: str = TZ) -> int:
    return int(dt.datetime(*parts, tzinfo=ZoneInfo(tz)).timestamp() * 1_000_000_000)


def _utc_ns(*parts: int) -> int:
    return int(dt.datetime(*parts, tzinfo=dt.UTC).timestamp() * 1_000_000_000)


def test_a_utc_start_runs_at_that_instant_for_a_user_behind_utc():
    rule = 'DTSTART:20271106T002800Z\nRRULE:FREQ=DAILY'
    assert next_run_ns(rule, tz=TZ) == _utc_ns(2027, 11, 6, 0, 28)
    assert next_run_ns(rule, tz=TZ) == _ns(2027, 11, 5, 19, 28)


def test_a_start_without_z_is_still_local_time():
    rule = 'DTSTART:20271106T002800\nRRULE:FREQ=DAILY'
    assert next_run_ns(rule, tz=TZ) == _ns(2027, 11, 6, 0, 28)


def test_a_utc_start_follows_the_zone_at_that_instant_across_a_dst_change():
    # 12:00 UTC is 06:00 CST on 2027-03-01 and, the rule being a daily wall-clock time, 06:00 CDT after the change.
    rule = 'DTSTART:20270301T120000Z\nRRULE:FREQ=DAILY;COUNT=20'
    runs = runs_between_ns(rule, _utc_ns(2027, 3, 1, 12), _utc_ns(2027, 3, 1), _utc_ns(2027, 3, 30), tz=TZ)
    assert runs[0] == _ns(2027, 3, 1, 6, 0)
    assert runs[0] == _utc_ns(2027, 3, 1, 12)
    assert _ns(2027, 3, 15, 6, 0) in runs


def test_a_utc_start_in_summer_time_uses_the_summer_offset():
    rule = 'DTSTART:20270701T120000Z\nRRULE:FREQ=DAILY'
    assert next_run_ns(rule, tz=TZ) == _utc_ns(2027, 7, 1, 12)
    assert _utc_ns(2027, 7, 1, 12) == _ns(2027, 7, 1, 7, 0)


def test_a_utc_until_is_honoured_as_that_instant():
    # 13:00 UTC on the 4th is 07:00 CST: the 08:00 run that day is past UNTIL.
    rule = 'DTSTART:20271201T080000\nRRULE:FREQ=DAILY;UNTIL=20271204T130000Z'
    runs = runs_between_ns(rule, _ns(2027, 12, 1, 8), _ns(2027, 12, 1), _ns(2027, 12, 20), tz=TZ)
    assert runs == [_ns(2027, 12, d, 8) for d in (1, 2, 3)]


def test_the_preview_lists_utc_start_runs_at_the_instant():
    rule = 'DTSTART:20271106T002800Z\nRRULE:FREQ=DAILY'
    assert next_n_runs_ns(rule, n=1, tz=TZ) == [_utc_ns(2027, 11, 6, 0, 28)]


@pytest.mark.parametrize('rule', ['DTSTART:20271106T002800Z\nRRULE:FREQ=DAILY;UNTIL=20271231T000000Z'])
def test_a_z_rule_validates_and_is_saved_as_given(rule):
    validate_rrule(rule, tz=TZ)
    assert pin_rule_time(rule, tz=TZ) == rule
