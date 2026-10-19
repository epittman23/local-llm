"""B6 calendar repros: range search does not expand recurring events; default calendar may be another user's."""

import asyncio
import json
from types import SimpleNamespace as NS

import local_llm.models.calendar as cal
import local_llm.tools.builtin as b

USER = {'id': 'u1', 'role': 'user', 'timezone': 'UTC'}
REQ = NS(app=NS(state=NS()))
NS_PER_S = 1_000_000_000


def ev(id, start_s, rrule=None, title='x'):
    return NS(id=id, calendar_id='c1', title=title, description='', start_at=start_s * NS_PER_S,
              end_at=(start_s + 3600) * NS_PER_S, all_day=False, location='', meta={}, color=None,
              is_cancelled=False, rrule=rrule)


async def main():
    # get_events_by_range returns every recurring event regardless of range (sorted by start_at asc),
    # the router expands them with expand_recurring_event; the tool does not.
    events = [ev(f'weekly{i}', 1_600_000_000 + i, 'FREQ=WEEKLY', f'weekly {i} (started 2020)') for i in range(10)]
    events.append(ev('dentist', 1_792_000_000, None, 'dentist (in range)'))

    async def get_events_by_range(user_id, start, end):
        return events

    cal.CalendarEvents.get_events_by_range = get_events_by_range
    r = json.loads(await b.search_calendar_events(start='2026-10-14 00:00', end='2026-10-21 00:00',
                                                  __request__=REQ, __user__=USER))
    print('total =', r['total'])
    for e in r['events']:
        print('  ', e['start'], e['title'])

    # default calendar: owned + shared calendars ordered by created_at; first is_default wins
    calendars = [NS(id='b-personal', user_id='u2', is_default=True), NS(id='a-personal', user_id='u1', is_default=True)]

    async def get_calendars_by_user(user_id):
        return calendars

    async def get_calendar_by_id(cid):
        return next(c for c in calendars if c.id == cid)

    async def has_access(**kw):
        return False  # u1 only has read on u2's calendar

    async def no_groups(*a, **k):
        return []

    import local_llm.models.access_grants as ag
    import local_llm.models.groups as g

    cal.Calendars.get_calendars_by_user = get_calendars_by_user
    cal.Calendars.get_calendar_by_id = get_calendar_by_id
    ag.AccessGrants.has_access = has_access
    g.Groups.get_groups_by_member_id = no_groups
    r = json.loads(await b.create_calendar_event(title='call mom', start='2026-10-20 17:00', __request__=REQ, __user__=USER))
    print('create_calendar_event without calendar_id ->', r)


asyncio.run(main())
