"""B4 pure-function repros. Run from apps/server with the brief's env."""

import asyncio
import datetime as dt
import time
from unittest import mock

print('=== 3. Recurring calendar events vs range overlap ===')
from local_llm.utils.calendar import expand_recurring_event

def ns(y, m, d, h=0):
    return int(dt.datetime(y, m, d, h, tzinfo=dt.timezone.utc).timestamp()) * 1_000_000_000

# Weekly Fri 18:00 -> Sun 18:00 (UTC user). View: Saturday 2026-10-17.
ev = {'id': 'e1', 'rrule': 'FREQ=WEEKLY', 'start_at': ns(2026, 10, 9, 18), 'end_at': ns(2026, 10, 11, 18)}
inst = expand_recurring_event(ev, ns(2026, 10, 17), ns(2026, 10, 18), tz='UTC')
print('weekly Fri18-Sun18, Saturday view, instances:', len(inst))
ev1 = {'id': 'e2', 'rrule': None, 'start_at': ns(2026, 10, 16, 18), 'end_at': ns(2026, 10, 18, 18)}
print('same span as a one-off event: DB query keeps it since end_at > start and start_at < end:',
      ev1['end_at'] > ns(2026, 10, 17) and ev1['start_at'] < ns(2026, 10, 18))
# Daily 23:00 -> 01:00, view: day 2026-10-17 00:00-24:00
ev2 = {'id': 'e3', 'rrule': 'FREQ=DAILY', 'start_at': ns(2026, 10, 1, 23), 'end_at': ns(2026, 10, 2, 1)}
inst = expand_recurring_event(ev2, ns(2026, 10, 17), ns(2026, 10, 18), tz='UTC')
print('daily 23:00-01:00, day view: starts =',
      [dt.datetime.fromtimestamp(i['start_at'] / 1e9, dt.timezone.utc).strftime('%m-%d %H:%M') for i in inst],
      '(16th 23:00 instance overlapping 00:00-01:00 missing)')

print()
print('=== 4. render_chat_variables: one bad value blanks every variable ===')
from local_llm.utils.chat_variables import render_chat_variables

prompt = 'Name: {{chat.variables.name}}; Level: {{chat.variables.level | select:options=["a","b"]}}'
print(repr(render_chat_variables(prompt, {'name': 'Ada', 'level': 'a'}, required=False)))
print(repr(render_chat_variables(prompt, {'name': 'Ada', 'level': 'c'}, required=False)))

print()
print('=== 6. Filter user valves leak across filters ===')
from local_llm.utils import filter as flt


class FA:
    class UserValves:
        def __init__(self, **kw):
            self.secret = 'A-user-secret'

    @staticmethod
    def inlet(body, __user__):
        return body


class FB:
    seen = None

    @staticmethod
    def inlet(body, __user__):
        FB.seen = __user__.get('valves')
        return body


class Fn:
    def __init__(self, id):
        self.id = id


modules = {'a': FA, 'b': FB}


async def fake_module(request, fid, load_from_db=True, function=None):
    return modules[fid]


async def fake_user_valves(fid, uid):
    return {}


async def run6():
    with mock.patch.object(flt, 'get_function_module', fake_module), \
            mock.patch.object(flt.Functions, 'get_user_valves_by_id_and_user_id', fake_user_valves), \
            mock.patch.object(flt.Functions, 'get_function_valves_by_ids', mock.AsyncMock(return_value={})), \
            mock.patch.object(flt, 'ENABLE_PLUGINS', True):
        await flt.process_filter_functions(None, None, [Fn('a'), Fn('b')], 'inlet', {'messages': []},
                                           {'__user__': {'id': 'u1'}})
    print("filter B (no UserValves) saw __user__['valves'] =", type(FB.seen).__name__,
          getattr(FB.seen, 'secret', None))

asyncio.run(run6())
