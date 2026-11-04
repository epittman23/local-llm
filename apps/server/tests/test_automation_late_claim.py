"""A late claim does not move an automation's time of day (#512).

A rule without DTSTART takes the time it does not state from the moment it
is read. Claiming a due run computed the next one from the claim itself, so
a claim 90 s late moved every later run of a daily rule by a minute. The
next run is now computed from the run's own due time.

Run from apps/server:

    python -m pytest tests/test_automation_late_claim.py
"""

from __future__ import annotations

import asyncio
import datetime as dt
import time
import uuid

from local_llm.utils.automations import next_run_ns

MINUTE_NS = 60 * 1_000_000_000


def _insert(automation_id: str, rrule: str, next_run_at: int) -> None:
    from local_llm.internal.db import get_async_db_context
    from local_llm.models.automations import Automation

    async def go():
        async with get_async_db_context() as db:
            now = time.time_ns()
            db.add(
                Automation(
                    id=automation_id, user_id='u-late', name=automation_id, data={'rrule': rrule},
                    is_active=True, next_run_at=next_run_at, created_at=now, updated_at=now,
                )
            )  # fmt: skip
            await db.commit()

    asyncio.run(go())


def _a_day_later(ns: int) -> int:
    """The same wall-clock time the next day, in the server's zone (as a rule without a zone runs)."""
    local = dt.datetime.fromtimestamp(ns / 1_000_000_000)
    return int((local + dt.timedelta(days=1)).timestamp() * 1_000_000_000)


def test_a_claim_90_s_late_keeps_a_daily_rule_at_its_time():
    from local_llm.models.automations import Automations

    now = time.time_ns()
    due = now - now % MINUTE_NS - 2 * MINUTE_NS  # on the minute, two minutes ago
    automation_id = f'late-{uuid.uuid4().hex[:8]}'
    _insert(automation_id, 'RRULE:FREQ=DAILY', next_run_at=due)

    claimed = asyncio.run(Automations.claim_due(time.time_ns()))

    row = next(a for a in claimed if a.id == automation_id)
    assert row.next_run_at == _a_day_later(due)


def test_next_run_ns_takes_an_unstated_time_from_its_anchor():
    now = time.time_ns()
    anchor = now - now % MINUTE_NS - 7 * MINUTE_NS

    assert next_run_ns('RRULE:FREQ=DAILY', anchor_ns=anchor) == _a_day_later(anchor)
    # A rule that states its time keeps it, anchor or not.
    stated = 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=30'
    assert next_run_ns(stated, anchor_ns=anchor) == next_run_ns(stated)


def _ns(local: dt.datetime, tz: str) -> int:
    from zoneinfo import ZoneInfo

    return int(local.replace(tzinfo=ZoneInfo(tz)).timestamp() * 1_000_000_000)


def test_the_anchor_is_read_in_the_users_zone_and_kept_after_days_down():
    tz = 'Pacific/Auckland'
    from zoneinfo import ZoneInfo

    today = dt.datetime.now(ZoneInfo(tz)).replace(tzinfo=None, second=0, microsecond=0)
    due = _ns((today - dt.timedelta(days=3)).replace(hour=9, minute=17), tz)

    when = dt.datetime.fromtimestamp(next_run_ns('RRULE:FREQ=DAILY', tz=tz, anchor_ns=due) / 1e9, ZoneInfo(tz))

    assert (when.hour, when.minute) == (9, 17)


def test_a_rule_that_states_only_its_hour_keeps_its_minute():
    now = time.time_ns()
    anchor = now - now % MINUTE_NS - 7 * MINUTE_NS
    minute = dt.datetime.fromtimestamp(anchor / 1e9).minute

    when = dt.datetime.fromtimestamp(next_run_ns('RRULE:FREQ=DAILY;BYHOUR=9', anchor_ns=anchor) / 1e9)

    assert (when.hour, when.minute) == (9, minute)


def test_a_sub_daily_rule_ignores_a_far_anchor_and_stays_on_its_grid():
    year_ago = time.time_ns() - 365 * 24 * 60 * MINUTE_NS

    started = time.perf_counter()
    anchored = next_run_ns('RRULE:FREQ=MINUTELY;INTERVAL=5', anchor_ns=year_ago)
    elapsed = time.perf_counter() - started

    assert anchored == next_run_ns('RRULE:FREQ=MINUTELY;INTERVAL=5')
    assert elapsed < 0.5
