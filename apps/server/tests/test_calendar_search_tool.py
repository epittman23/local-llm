"""search_calendar_events over a date range expands recurring events (tools/builtin.py).

CalendarEvents.get_events_by_range returns every recurring event whatever
its dates and leaves expansion to the caller, as the calendar router does.
The tool did not expand them, so each series came back at its first-ever
start, counted in `total` and pushed the real in-range events past `count`
(#176).

Runs against the suite's temporary SQLite database (tests/conftest.py points
DATA_DIR at a temp directory, and DATABASE_URL defaults to a file in it).

Run from apps/server:

    python -m pytest tests/test_calendar_search_tool.py
"""

import asyncio
import datetime as dt
import importlib
import json
import pkgutil
import uuid
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import local_llm.models as models_pkg
from local_llm.internal.db import Base, async_engine
from local_llm.models.calendar import CalendarEventForm, CalendarEvents, CalendarForm, Calendars
from local_llm.models.users import Users
from local_llm.tools import builtin

for module in pkgutil.iter_modules(models_pkg.__path__):
    importlib.import_module(f'local_llm.models.{module.name}')

TZ = 'Europe/Berlin'
REQUEST = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))


def _ns(text: str) -> int:
    return int(dt.datetime.fromisoformat(text).replace(tzinfo=ZoneInfo(TZ)).timestamp()) * 1_000_000_000


def _search(events: list[dict], **kwargs) -> dict:
    async def go():
        async with async_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        tag = uuid.uuid4().hex[:8]
        user = await Users.insert_new_user(f'u{tag}', 'Ada', f'u{tag}@example.invalid', role='user')
        cal = await Calendars.insert_new_calendar(user.id, CalendarForm(name='Mine'))
        for event in events:
            await CalendarEvents.insert_new_event(user.id, CalendarEventForm(calendar_id=cal.id, **event))
        user_dict = {'id': user.id, 'timezone': TZ}
        return json.loads(await builtin.search_calendar_events(__request__=REQUEST, __user__=user_dict, **kwargs))

    return asyncio.run(go())


def _weekly(title: str) -> dict:
    return {
        'title': title,
        'start_at': _ns('2020-01-06 09:00'),
        'end_at': _ns('2020-01-06 09:30'),
        'rrule': 'FREQ=WEEKLY;BYDAY=MO',
    }


def test_recurring_events_appear_at_their_occurrences_in_the_range():
    one_off = {'title': 'Dentist', 'start_at': _ns('2026-10-15 14:00'), 'end_at': _ns('2026-10-15 15:00')}

    got = _search(
        [*(_weekly(f'Standup {i}') for i in range(10)), one_off], start='2026-10-14 00:00', end='2026-10-21 00:00'
    )

    assert got['total'] == 11
    starts = [(e['title'], e['start']) for e in got['events']]
    assert starts[0] == ('Dentist', '2026-10-15 14:00')
    assert len(starts) == 10
    assert all(title.startswith('Standup') and start == '2026-10-19 09:00' for title, start in starts[1:])
    standup = got['events'][1]
    assert standup['end'] == '2026-10-19 09:30'
    assert standup['rrule'] == 'FREQ=WEEKLY;BYDAY=MO'


def test_a_series_with_no_occurrence_in_the_range_is_left_out():
    ended = {**_weekly('Old class'), 'rrule': 'FREQ=WEEKLY;BYDAY=MO;COUNT=3'}

    got = _search([ended], start='2026-10-14 00:00', end='2026-10-21 00:00')

    assert got == {'events': [], 'total': 0}


def test_every_occurrence_in_the_range_is_listed_in_order():
    got = _search([_weekly('Standup')], start='2026-10-01 00:00', end='2026-10-20 00:00')

    assert [e['start'] for e in got['events']] == ['2026-10-05 09:00', '2026-10-12 09:00', '2026-10-19 09:00']
