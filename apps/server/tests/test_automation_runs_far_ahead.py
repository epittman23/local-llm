"""The Scheduled Tasks calendar reaches a range far ahead without walking every run before it (#667).

The calendar read an automation's rule from its next run and walked it to
the range shown, one step at a time: about five seconds for a SECONDLY
automation viewed a month ahead. A sub-daily rule is now read from the
range's start, its start moved forward by whole steps as the scheduler moves
an old one (#267), so its phase, COUNT and UNTIL are kept. Each case is
checked against the rule walked from its own DTSTART.

Run from apps/server:

    python -m pytest tests/test_automation_runs_far_ahead.py
"""

import datetime as dt
from zoneinfo import ZoneInfo

from dateutil import rrule as rrule_module
from dateutil.rrule import rrulestr

from local_llm.utils.automations import runs_between_ns

TZ = 'America/New_York'


def _ns(*parts: int) -> int:
    return int(dt.datetime(*parts, tzinfo=ZoneInfo(TZ)).timestamp() * 1_000_000_000)


def _walked(s: str, start_ns: int, end_ns: int) -> list[int]:
    """The runs in [start_ns, end_ns), walking the rule from its own DTSTART."""
    runs: list[int] = []
    for when in rrulestr(s, ignoretz=True):
        when_ns = int(when.replace(tzinfo=ZoneInfo(TZ)).timestamp() * 1_000_000_000)
        if when_ns >= end_ns:
            break
        if when_ns >= start_ns and (not runs or when_ns > runs[-1]):
            runs.append(when_ns)
    return runs


def _count_steps(monkeypatch) -> list[int]:
    """Count the occurrences dateutil generates from here on."""
    steps = [0]
    original = rrule_module.rrule._iter

    def counted(self):
        for when in original(self):
            steps[0] += 1
            yield when

    monkeypatch.setattr(rrule_module.rrule, '_iter', counted)
    return steps


def test_a_secondly_rule_viewed_days_ahead_walks_only_near_the_range(monkeypatch):
    anchor = _ns(2027, 1, 4, 12)
    start = anchor + 2 * 86_400 * 1_000_000_000
    end = start + 3_600 * 1_000_000_000
    steps = _count_steps(monkeypatch)

    runs = runs_between_ns('RRULE:FREQ=SECONDLY', anchor, start, end, tz=TZ)

    assert len(runs) == 3_600
    # From two days ahead: about 176,000 steps walked from the next run.
    assert 0 < steps[0] <= 20_000


def test_a_recent_secondly_rule_with_a_dtstart_walks_only_near_the_range(monkeypatch):
    # An hour old at its next run, so short of the threshold that moves its start.
    rule = 'DTSTART:20270104T110000\nRRULE:FREQ=SECONDLY'
    anchor = _ns(2027, 1, 4, 12)
    start = anchor + 2 * 86_400 * 1_000_000_000
    end = start + 3_600 * 1_000_000_000
    steps = _count_steps(monkeypatch)

    runs = runs_between_ns(rule, anchor, start, end, tz=TZ)

    assert runs == list(range(start, end, 1_000_000_000))
    assert 0 < steps[0] <= 20_000


def test_an_old_rule_keeps_its_phase_a_month_ahead():
    rule = 'DTSTART:20250101T100730\nRRULE:FREQ=MINUTELY;INTERVAL=5'
    start, end = _ns(2027, 2, 1), _ns(2027, 2, 2)

    runs = runs_between_ns(rule, _ns(2027, 1, 4, 12, 2, 30), start, end, tz=TZ)

    assert runs == _walked(rule, start, end)
    first = dt.datetime.fromtimestamp(runs[0] / 1_000_000_000, tz=ZoneInfo(TZ))
    assert (first.hour, first.minute, first.second) == (0, 2, 30)


def test_a_count_that_ends_in_the_range_ends_there():
    # 129,600 minutes from DTSTART to the range: ten runs are left in it.
    rule = 'DTSTART:20270101T000000\nRRULE:FREQ=MINUTELY;COUNT=129610'
    start, end = _ns(2027, 4, 1), _ns(2027, 4, 2)

    runs = runs_between_ns(rule, _ns(2027, 1, 2), start, end, tz=TZ)

    assert runs == [_ns(2027, 4, 1, 0, minute) for minute in range(10)]
    assert runs == _walked(rule, start, end)


def test_a_count_that_ran_out_before_the_range_shows_nothing():
    rule = 'DTSTART:20270101T000000\nRRULE:FREQ=MINUTELY;COUNT=129600'

    assert runs_between_ns(rule, _ns(2027, 1, 2), _ns(2027, 4, 1), _ns(2027, 4, 2), tz=TZ) == []


def test_an_until_in_the_range_ends_there_and_one_before_it_shows_nothing():
    start, end = _ns(2027, 4, 1), _ns(2027, 4, 2)
    inside = 'DTSTART:20270101T000000\nRRULE:FREQ=MINUTELY;UNTIL=20270401T000500'
    before = 'DTSTART:20270101T000000\nRRULE:FREQ=MINUTELY;UNTIL=20270331T235959'

    runs = runs_between_ns(inside, _ns(2027, 1, 2), start, end, tz=TZ)

    assert runs == [_ns(2027, 4, 1, 0, minute) for minute in range(6)]
    assert runs == _walked(inside, start, end)
    assert runs_between_ns(before, _ns(2027, 1, 2), start, end, tz=TZ) == []


def test_a_range_across_a_dst_change_matches_the_walk_from_dtstart():
    rule = 'DTSTART:20261101T000700\nRRULE:FREQ=MINUTELY;INTERVAL=1'
    start, end = _ns(2027, 3, 14), _ns(2027, 3, 14, 6)

    runs = runs_between_ns(rule, _ns(2026, 11, 2), start, end, tz=TZ)

    assert runs == _walked(rule, start, end)
    assert len(runs) == 300  # five hours pass between midnight and 06:00 that day


def test_a_daily_rule_keeps_the_time_of_its_next_run_far_ahead():
    anchor = _ns(2027, 1, 4, 8, 17)
    start, end = _ns(2027, 3, 1), _ns(2027, 3, 8)

    runs = runs_between_ns('RRULE:FREQ=DAILY', anchor, start, end, tz=TZ)

    assert runs == [_ns(2027, 3, day, 8, 17) for day in range(1, 8)]


def test_a_weekly_rule_far_ahead_matches_the_walk_from_dtstart():
    rule = 'DTSTART:20250106T093000\nRRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=220'
    start, end = _ns(2027, 1, 1), _ns(2027, 3, 1)

    runs = runs_between_ns(rule, _ns(2025, 1, 6, 9, 30), start, end, tz=TZ)

    assert runs == _walked(rule, start, end)
    assert len(runs) == 12  # 208 of its 220 runs came before the range
