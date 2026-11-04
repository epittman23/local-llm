"""The calendar's event listing is in time order (#324).

`GET /calendar/events` returned stored events, recurring instances and
automation runs in the order it gathered them. A month cell shows its first
few events and "+N more", so an earlier event could be hidden behind later
ones. The listing is now sorted by start.

Run from apps/server:

    python -m pytest tests/test_calendar_events_order.py
"""

import asyncio
from types import SimpleNamespace

from local_llm.routers import calendar as calendar_router


class Event:
    def __init__(self, id, start_at, rrule=None):
        self.data = {'id': id, 'start_at': start_at, 'rrule': rrule}

    def model_dump(self):
        return dict(self.data)


def test_events_come_back_in_start_order(monkeypatch):
    async def allowed(*_a, **_k):
        return None

    async def stored(**_kwargs):
        return [Event('late', 3_000), Event('early', 1_000), Event('middle', 2_000)]

    async def no_automations(*_a, **_k):
        return False

    monkeypatch.setattr(calendar_router, 'check_calendar_permission', allowed)
    monkeypatch.setattr(calendar_router.CalendarEvents, 'get_events_by_range', stored)
    monkeypatch.setattr(calendar_router, '_user_has_automations', no_automations)

    events = asyncio.run(
        calendar_router.get_events(
            None,
            start='2026-11-01T00:00:00',
            end='2026-12-01T00:00:00',
            user=SimpleNamespace(id='u1', timezone='UTC'),
        )
    )

    assert [e['id'] for e in events] == ['early', 'middle', 'late']
