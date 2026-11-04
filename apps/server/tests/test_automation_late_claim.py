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
