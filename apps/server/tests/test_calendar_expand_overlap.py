"""A recurring occurrence already under way when a range starts is in it (#171).

expand_recurring_event kept only occurrences that start inside the range,
and looked back one day, while one-off events count when they overlap it.
A weekly Friday-to-Sunday event was missing from a Saturday view, and a
daily 23:00-01:00 event lost the occurrence running past midnight.

Run from apps/server:

    python -m pytest tests/test_calendar_expand_overlap.py
"""

import datetime as dt
from zoneinfo import ZoneInfo

from local_llm.utils.calendar import expand_recurring_event

TZ = 'Europe/Berlin'


def _ns(text: str) -> int:
    return int(dt.datetime.fromisoformat(text).replace(tzinfo=ZoneInfo(TZ)).timestamp()) * 1_000_000_000


def _event(start: str, end: str | None, rrule: str) -> dict:
    return {'id': 'e', 'start_at': _ns(start), 'end_at': _ns(end) if end else None, 'rrule': rrule}


def _starts(instances) -> list[int]:
    return [i['start_at'] for i in instances]


def test_a_weekend_long_occurrence_is_in_a_saturday_view():
    weekend = _event('2026-10-02 18:00', '2026-10-04 18:00', 'FREQ=WEEKLY')  # Friday to Sunday

    got = expand_recurring_event(weekend, _ns('2026-10-10 00:00'), _ns('2026-10-11 00:00'), tz=TZ)

    assert _starts(got) == [_ns('2026-10-09 18:00')]


def test_the_occurrence_running_past_midnight_is_in_the_next_day():
    late = _event('2026-10-01 23:00', '2026-10-02 01:00', 'FREQ=DAILY')

    got = expand_recurring_event(late, _ns('2026-10-15 00:00'), _ns('2026-10-16 00:00'), tz=TZ)

    assert _starts(got) == [_ns('2026-10-14 23:00'), _ns('2026-10-15 23:00')]


def test_an_occurrence_that_ended_before_the_range_or_has_no_end_is_not():
    morning = _event('2026-10-01 09:00', '2026-10-01 10:00', 'FREQ=DAILY')
    point = _event('2026-10-01 23:30', None, 'FREQ=DAILY')

    assert _starts(expand_recurring_event(morning, _ns('2026-10-15 12:00'), _ns('2026-10-15 18:00'), tz=TZ)) == []
    assert _starts(expand_recurring_event(point, _ns('2026-10-15 00:00'), _ns('2026-10-15 12:00'), tz=TZ)) == []


def test_a_long_occurrence_is_found_across_a_spring_forward_change():
    """The lookback runs in wall-clock time; a 23-hour day must not shorten it below the event's length."""
    long = _event('2026-03-07 23:30', '2026-03-08 23:30', 'FREQ=WEEKLY')  # Saturday, 24 h

    got = expand_recurring_event(long, _ns('2026-03-30 00:00'), _ns('2026-03-31 00:00'), tz=TZ)

    # The 28 March occurrence ends at 00:30 on Monday 30 March (CEST).
    assert _starts(got) == [_ns('2026-03-28 23:30')]


# --- #509: all-day ends across a DST change, and the instance cap -------------


def _all_day(start: str, end: str, rrule: str) -> dict:
    return {**_event(start, end, rrule), 'all_day': True}


def test_an_all_day_occurrence_ends_at_the_next_midnight_across_a_dst_change():
    """Its end was its start plus 24 hours, which is 23:00 on a 25-hour day and 01:00 the day after a 23-hour one."""
    day = _all_day('2026-10-20 00:00', '2026-10-21 00:00', 'FREQ=DAILY')

    fall = expand_recurring_event(day, _ns('2026-10-25 00:00'), _ns('2026-10-26 00:00'), tz=TZ)
    spring = expand_recurring_event(
        _all_day('2026-03-20 00:00', '2026-03-21 00:00', 'FREQ=DAILY'),
        _ns('2026-03-29 00:00'),
        _ns('2026-03-30 00:00'),
        tz=TZ,
    )

    assert [(i['start_at'], i['end_at']) for i in fall] == [(_ns('2026-10-25 00:00'), _ns('2026-10-26 00:00'))]
    assert [(i['start_at'], i['end_at']) for i in spring] == [(_ns('2026-03-29 00:00'), _ns('2026-03-30 00:00'))]


def test_a_timed_occurrence_keeps_its_exact_length_across_a_dst_change():
    meeting = _event('2026-10-20 09:00', '2026-10-20 10:00', 'FREQ=DAILY')

    got = expand_recurring_event(meeting, _ns('2026-10-25 00:00'), _ns('2026-10-26 00:00'), tz=TZ)

    assert [i['end_at'] - i['start_at'] for i in got] == [3600 * 1_000_000_000]


def test_the_instance_cap_counts_the_instances_kept_not_the_ones_walked_past():
    """The lookback walks the day before the range too; those once used up the cap before the range was reached."""
    hourly = _event('2026-10-01 00:00', '2026-10-01 02:00', 'FREQ=HOURLY')

    got = expand_recurring_event(hourly, _ns('2026-10-15 00:00'), _ns('2026-10-16 00:00'), tz=TZ, max_instances=30)

    # The one from 23:00 the evening before, still under way at midnight, then every hour of the day.
    assert len(got) == 25
    assert _starts(got)[0] == _ns('2026-10-14 23:00')
    assert _starts(got)[-1] == _ns('2026-10-15 23:00')
    capped = expand_recurring_event(hourly, _ns('2026-10-15 00:00'), _ns('2026-10-16 00:00'), tz=TZ, max_instances=10)
    assert len(capped) == 10
