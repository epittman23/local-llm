"""A rule without a DTSTART reads the same whatever minute it is checked at (#801).

The rule was first parsed with no start of its own, so dateutil started it at
the real now. A sub-daily rule with BY filters only some starts can reach,
such as every 2 minutes at :02 and :46, then raised dateutil's "byxxx
generates an empty set" at an odd minute and not at an even one: it was
accepted one minute and refused the next, and a saved one could fail to
schedule. It is now first parsed from the same fixed epoch it runs from.

Run from apps/server:

    python -m pytest tests/test_automation_rrule_fixed_anchor.py
"""

from __future__ import annotations

import datetime as dt
from types import SimpleNamespace
from typing import Any

import pytest
from dateutil import rrule as rrule_module

from local_llm.utils import automations

RULE = 'RRULE:FREQ=MINUTELY;INTERVAL=2;BYMINUTE=2,46'


def _clock_at(monkeypatch, now: dt.datetime) -> None:
    """Fix the clock dateutil starts a rule at, and this module's own, at `now`."""
    original = rrule_module.rrule.__init__

    def started(self, *args: Any, **kwargs: Any) -> None:
        if kwargs.get('dtstart') is None:
            kwargs['dtstart'] = now
        original(self, *args, **kwargs)

    class Clock(dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return now

    # Only these clocks: patching the datetime module itself would change dateutil's isinstance checks too.
    monkeypatch.setattr(rrule_module.rrule, '__init__', started)
    monkeypatch.setattr(automations, 'dt', SimpleNamespace(datetime=Clock, timedelta=dt.timedelta, UTC=dt.UTC))


@pytest.mark.parametrize('now', [dt.datetime(2024, 3, 10, 12, 0, 30), dt.datetime(2024, 3, 10, 12, 1, 30)])
def test_a_filtered_sub_daily_rule_reads_the_same_at_any_minute(monkeypatch, now):
    _clock_at(monkeypatch, now)
    expected = dt.datetime(2024, 3, 10, 12, 2, 0)

    automations.validate_rrule(RULE)
    assert automations.pin_rule_time(RULE) == RULE
    assert automations._parse_rule(RULE, now).after(now) == expected
    assert automations.next_run_ns(RULE, anchor_ns=0) == int(expected.timestamp() * 1_000_000_000)
