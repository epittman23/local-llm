"""A daily, weekly or monthly automation rule runs at its times in the user's clock (#266).

The schedule picker writes rules without a DTSTART. dateutil then starts
the rule at the server's local now, while the next run is asked for after
the user's local now. With the user behind the server, today's later runs
fell before that start and were skipped, and every run inherited the
parse time's seconds.

Run from apps/server:

    python -m pytest tests/test_automation_rrule_anchor.py
"""

import datetime as dt

from local_llm.utils.automations import _parse_rule

# A user clock far from the server's: whatever the server's now, the rule
# must start from the user's.
USER_NOW = dt.datetime(2020, 1, 6, 8, 3, 36)  # a Monday


def test_a_daily_rule_runs_today_at_its_time():
    rule = _parse_rule('RRULE:FREQ=DAILY;BYHOUR=10;BYMINUTE=0', USER_NOW)

    assert rule.after(USER_NOW) == dt.datetime(2020, 1, 6, 10, 0, 0)


def test_a_weekly_rule_for_today_runs_today_not_next_week():
    rule = _parse_rule('RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=17;BYMINUTE=30', USER_NOW)

    assert rule.after(USER_NOW) == dt.datetime(2020, 1, 6, 17, 30, 0)


def test_a_monthly_rule_runs_on_its_day_on_the_minute():
    rule = _parse_rule('RRULE:FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0', USER_NOW)

    assert rule.after(USER_NOW) == dt.datetime(2020, 1, 15, 9, 0, 0)


def test_a_rule_with_its_own_dtstart_is_unchanged():
    rule = _parse_rule('DTSTART:20200101T120000\nRRULE:FREQ=DAILY', USER_NOW)

    assert rule.after(USER_NOW) == dt.datetime(2020, 1, 6, 12, 0, 0)
