"""The calendar of automation runs is called "Automations", as the page is (S6-D10, #936, #1040).

It was "Scheduled Tasks", the one place the app used that name, in a fixed
violet (#8b5cf6) that no theme token matches. It is a virtual calendar (no
stored row, the id `__scheduled_tasks__` is unchanged): its name comes from
here, and with no stored colour the frontend draws it in a series token, as
it does a new default calendar (D1b).

Run from apps/server:

    python -m pytest tests/test_calendar_automations_name.py
"""

import asyncio
from types import SimpleNamespace

from local_llm.routers import calendar as calendar_router


def _calendars(monkeypatch, has_automations: bool):
    async def allowed(*_a, **_k):
        return None

    async def stored(_user_id):
        return []

    async def automations(*_a, **_k):
        return has_automations

    monkeypatch.setattr(calendar_router, 'check_calendar_permission', allowed)
    monkeypatch.setattr(calendar_router.Calendars, 'get_calendars_by_user', stored)
    monkeypatch.setattr(calendar_router, '_user_has_automations', automations)
    return asyncio.run(calendar_router.get_calendars(None, user=SimpleNamespace(id='u1')))


def test_the_virtual_calendar_is_named_automations_with_no_stored_colour(monkeypatch):
    calendars = _calendars(monkeypatch, has_automations=True)

    assert [(c.id, c.name, c.color, c.is_system) for c in calendars] == [
        (calendar_router.SCHEDULED_TASKS_CALENDAR_ID, 'Automations', None, True)
    ]


def test_without_automations_there_is_no_virtual_calendar(monkeypatch):
    assert _calendars(monkeypatch, has_automations=False) == []
