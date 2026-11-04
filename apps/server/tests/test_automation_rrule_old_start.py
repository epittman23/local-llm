"""A sub-daily rule whose DTSTART is long past keeps its phase and its COUNT (#267).

To avoid walking hundreds of thousands of steps, a SECONDLY, MINUTELY or
HOURLY rule more than 100,000 steps past its DTSTART was rebuilt from a
dtstart aligned to 2000-01-01. That dropped the rule's own phase (every 5
minutes from 10:07 ran at :05, :10, ... instead of :07, :12, ...) and
restarted its COUNT, so an automation that had finished ran again. The rule
is now moved forward by whole steps from its own DTSTART, a COUNT rule with
what is left of its COUNT, or, when its steps are filtered, from its own
DTSTART.

Run from apps/server:

    python -m pytest tests/test_automation_rrule_old_start.py
"""

import datetime as dt
from types import SimpleNamespace

from local_llm.utils import automations
from local_llm.utils.automations import _parse_rule

NOW = dt.datetime(2024, 3, 10, 12, 0, 30)


def test_an_old_minutely_rule_keeps_its_phase():
    # Two years of 5-minute steps: over 200,000.
    rule = _parse_rule('DTSTART:20220101T100700\nRRULE:FREQ=MINUTELY;INTERVAL=5', NOW)

    assert rule.after(NOW) == dt.datetime(2024, 3, 10, 12, 2, 0)
    assert rule.after(dt.datetime(2024, 3, 10, 12, 2, 0)) == dt.datetime(2024, 3, 10, 12, 7, 0)


def test_an_old_rule_whose_count_ran_out_stays_finished():
    rule = _parse_rule('DTSTART:20220101T100700\nRRULE:FREQ=MINUTELY;INTERVAL=5;COUNT=3', NOW)

    assert rule.after(NOW) is None


def test_an_old_rule_with_a_count_left_keeps_its_runs():
    # Every 2 seconds for ten days (over 400,000 steps), 10 million times: still running.
    rule = _parse_rule('DTSTART:20240301T000001\nRRULE:FREQ=SECONDLY;INTERVAL=2;COUNT=10000000', NOW)

    assert rule.after(NOW) == dt.datetime(2024, 3, 10, 12, 0, 31)


def test_an_old_count_rule_ends_when_its_last_run_comes():
    # Over 400,000 two-second steps have passed; two runs are left.
    start = dt.datetime(2024, 3, 1, 0, 0, 0)
    steps = int((NOW - start).total_seconds()) // 2
    rule = _parse_rule(f'DTSTART:20240301T000000\nRRULE:FREQ=SECONDLY;INTERVAL=2;COUNT={steps + 2}', NOW)

    first = rule.after(NOW)
    assert first == dt.datetime(2024, 3, 10, 12, 0, 32)
    assert rule.after(first) is None


def test_an_old_count_rule_with_a_filter_keeps_its_dtstart():
    # 5-minutely in the 9 o'clock hour, three runs: all on 2022-01-02, long gone.
    rule = _parse_rule('DTSTART:20220101T100700\nRRULE:FREQ=MINUTELY;INTERVAL=5;BYHOUR=9;COUNT=3', NOW)

    assert rule.after(NOW) is None


def test_an_old_hourly_rule_keeps_its_minute():
    rule = _parse_rule('DTSTART:20000101T004500\nRRULE:FREQ=HOURLY', NOW)

    assert rule.after(NOW) == dt.datetime(2024, 3, 10, 12, 45, 0)


def test_an_old_count_rule_with_a_signed_count_still_ends():
    start = dt.datetime(2024, 3, 1, 0, 0, 0)
    steps = int((NOW - start).total_seconds()) // 2
    rule = _parse_rule(f'DTSTART:20240301T000000\nRRULE:FREQ=SECONDLY;INTERVAL=2;COUNT=+{steps + 2}', NOW)

    first = rule.after(NOW)
    assert first == dt.datetime(2024, 3, 10, 12, 0, 32)
    assert rule.after(first) is None


def test_a_recent_rule_with_a_zoned_dtstart_keeps_its_clock_time():
    # Under the threshold: the rule is used as written, its zone dropped.
    rule = _parse_rule('DTSTART;TZID=Europe/Paris:20240310T110700\nRRULE:FREQ=MINUTELY;INTERVAL=5', NOW)

    assert rule.after(NOW) == dt.datetime(2024, 3, 10, 12, 2, 0)


def test_a_sub_daily_rule_without_a_dtstart_snaps_to_the_clock():
    rule = _parse_rule('RRULE:FREQ=MINUTELY;INTERVAL=15', NOW)

    assert rule.after(NOW) == dt.datetime(2024, 3, 10, 12, 15, 0)


def test_the_preview_lists_the_next_runs_in_one_walk(monkeypatch):
    class Clock(dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW

    # Only this module's clock: patching the datetime module itself would change dateutil's too.
    monkeypatch.setattr(automations, 'dt', SimpleNamespace(datetime=Clock, timedelta=dt.timedelta, UTC=dt.UTC))
    runs = automations.next_n_runs_ns('DTSTART:20220101T100700\nRRULE:FREQ=MINUTELY;INTERVAL=5', n=3)

    expected = [dt.datetime(2024, 3, 10, 12, m, 0) for m in (2, 7, 12)]
    assert runs == [int(e.timestamp() * 1_000_000_000) for e in expected]
