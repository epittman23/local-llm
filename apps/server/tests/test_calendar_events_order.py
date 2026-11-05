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
        self.user = None

    def model_dump(self):
        return dict(self.data)


def test_events_come_back_in_start_order(monkeypatch):
    """Stored events come sorted; a repeating one's instances were appended after them."""

    async def allowed(*_a, **_k):
        return None

    async def stored(**_kwargs):
        return [Event('daily', 500, rrule='FREQ=DAILY'), Event('early', 1_000), Event('late', 3_000)]

    def expand(event, start, end, tz=None):
        return [{**event, 'id': 'daily_2', 'start_at': 2_000, 'rrule': None, 'user': None}]

    async def no_automations(*_a, **_k):
        return False

    monkeypatch.setattr(calendar_router, 'check_calendar_permission', allowed)
    monkeypatch.setattr(calendar_router.CalendarEvents, 'get_events_by_range', stored)
    monkeypatch.setattr(calendar_router, '_user_has_automations', no_automations)
    monkeypatch.setattr(calendar_router, 'expand_recurring_event', expand)
    monkeypatch.setattr(calendar_router, 'CalendarEventUserResponse', lambda **kw: Event(kw['id'], kw['start_at']))

    events = asyncio.run(
        calendar_router.get_events(
            None,
            start='2026-11-01T00:00:00',
            end='2026-12-01T00:00:00',
            user=SimpleNamespace(id='u1', timezone='UTC'),
        )
    )

    assert [e['id'] for e in events] == ['early', 'daily_2', 'late']
