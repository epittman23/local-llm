"""rrule_interval_seconds reads COUNT from the rule and measures the real gap.

Run from apps/server:

    python -m pytest tests/test_rrule_interval.py
"""

from __future__ import annotations

import pytest

from local_llm.models.calendar import CalendarEventForm
from local_llm.utils.automations import rrule_interval_seconds


@pytest.mark.parametrize(
    'rule, seconds',
    [
        ('FREQ=MINUTELY;INTERVAL=5', 300),
        ('FREQ=HOURLY', 3600),
        ('FREQ=DAILY', 86400),
        ('DTSTART:20260101T000000\nRRULE:FREQ=MINUTELY;COUNT=1440', 60),
        ('DTSTART:20260101T000000\nRRULE:FREQ=HOURLY;COUNT=10', 3600),
        ('DTSTART:20260101T000000\nRRULE:FREQ=MINUTELY;COUNT=100', 60),
        ('FREQ=DAILY;BYHOUR=9,10;BYMINUTE=0;BYSECOND=0', 3600),
    ],
)
def test_interval_is_the_shortest_gap(rule, seconds):
    assert rrule_interval_seconds(rule) == seconds


def test_a_true_one_shot_has_no_interval():
    assert rrule_interval_seconds('DTSTART:20270101T090000\nRRULE:FREQ=DAILY;COUNT=1') is None


def test_calendar_refuses_sub_daily_rules_with_counts_starting_with_one():
    with pytest.raises(ValueError):
        CalendarEventForm(calendar_id='c', title='t', start_at=1, rrule='FREQ=HOURLY;COUNT=10')
    with pytest.raises(ValueError):
        CalendarEventForm(calendar_id='c', title='t', start_at=1, rrule='FREQ=HOURLY')
    assert CalendarEventForm(calendar_id='c', title='t', start_at=1, rrule='FREQ=DAILY;COUNT=10').rrule
