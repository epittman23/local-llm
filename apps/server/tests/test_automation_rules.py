"""Finished automations: inactive, never expanded from the epoch.

Run from apps/server:

    python -m pytest tests/test_automation_rules.py
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace


def test_the_calendar_skips_finished_automations(monkeypatch):
    from local_llm.models import automations as automations_model
    from local_llm.routers import calendar as calendar_router

    finished = SimpleNamespace(
        id='a1', name='done', data={'rrule': 'FREQ=MINUTELY;INTERVAL=5'}, next_run_at=None,
        created_at=1, updated_at=1,
    )  # fmt: skip

    async def check(*_a, **_k):
        return None

    async def yes(*_a, **_k):
        return True

    async def no_events(**_k):
        return []

    async def active(_uid):
        return [finished]

    async def no_runs(*_a, **_k):
        return []

    expanded = []

    def expand(event, *_a, **_k):
        expanded.append(event)
        return []

    monkeypatch.setattr(calendar_router, 'check_calendar_permission', check)
    monkeypatch.setattr(calendar_router, '_user_has_automations', yes)
    monkeypatch.setattr(calendar_router.CalendarEvents, 'get_events_by_range', no_events)
    monkeypatch.setattr(automations_model.Automations, 'get_active_by_user', active)
    monkeypatch.setattr(automations_model.AutomationRuns, 'get_runs_by_user_range', no_runs)
    monkeypatch.setattr(calendar_router, 'expand_recurring_event', expand)

    user = SimpleNamespace(id='u1', timezone=None)
    started = time.monotonic()
    asyncio.run(
        calendar_router.get_events(
            request=None, start='2026-10-01T00:00:00', end='2026-11-01T00:00:00', calendar_ids=None, user=user
        )
    )
    assert expanded == []
    assert time.monotonic() - started < 5


# ---------------------------------------------------------------------------
# finished automations go inactive (against the test run's migrated SQLite)
# ---------------------------------------------------------------------------
def _insert(automation_id: str, rrule: str, *, active: bool, next_run_at: int | None):
    from local_llm.internal.db import get_async_db_context
    from local_llm.models.automations import Automation

    async def go():
        async with get_async_db_context() as db:
            now = time.time_ns()
            db.add(
                Automation(
                    id=automation_id, user_id='u-auto', name=automation_id, data={'rrule': rrule},
                    is_active=active, next_run_at=next_run_at, created_at=now, updated_at=now,
                )
            )  # fmt: skip
            await db.commit()

    asyncio.run(go())


def test_claiming_the_last_run_deactivates_the_automation():
    from local_llm.models.automations import Automations

    # Its only occurrence is in the past, so after this run there is no next one.
    _insert('finished-1', 'DTSTART:20200101T090000\nRRULE:FREQ=DAILY;COUNT=1', active=True, next_run_at=1)
    claimed = asyncio.run(Automations.claim_due(time.time_ns()))
    row = next(a for a in claimed if a.id == 'finished-1')
    assert row.next_run_at is None and row.is_active is False


def test_a_finished_rule_cannot_be_toggled_back_on():
    from local_llm.models.automations import Automations

    _insert('finished-2', 'DTSTART:20200101T090000\nRRULE:FREQ=DAILY;COUNT=1', active=False, next_run_at=None)
    toggled = asyncio.run(Automations.toggle('finished-2', next_run_at=None))
    assert toggled.is_active is False
