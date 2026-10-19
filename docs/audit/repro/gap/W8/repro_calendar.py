"""W8 calendar repros: pure functions only (no DB)."""

import datetime as dt
import time

from local_llm.utils.automations import next_n_runs_ns, next_run_ns
from local_llm.utils.calendar import expand_recurring_event

NS = 1_000_000_000
TZ = 'UTC'


def ns(d: dt.datetime) -> int:
    return int(d.replace(tzinfo=dt.timezone.utc).timestamp() * NS)


def fmt(n: int) -> str:
    return dt.datetime.fromtimestamp(n / NS, tz=dt.timezone.utc).strftime('%Y-%m-%d %H:%M')


print('=== 1. Editing a recurring event from a later occurrence moves the series ===')
series = {
    'id': 'ev1',
    'calendar_id': 'c',
    'user_id': 'u',
    'title': 'Standup',
    'start_at': ns(dt.datetime(2026, 10, 5, 9, 0)),  # Monday Oct 5
    'end_at': ns(dt.datetime(2026, 10, 5, 9, 30)),
    'rrule': 'FREQ=WEEKLY',
}
rng = (ns(dt.datetime(2026, 10, 1)), ns(dt.datetime(2026, 11, 1)))
before = expand_recurring_event(series, *rng, tz=TZ)
print('before edit :', [fmt(i['start_at']) for i in before])
# The page opens the clicked instance (Oct 26) and eventPayload sends start_at = instance start_at.
clicked = [i for i in before if fmt(i['start_at']).startswith('2026-10-26')][0]
edited = {**series, 'title': 'Standup (renamed)', 'start_at': clicked['start_at'], 'end_at': clicked['end_at']}
after = expand_recurring_event(edited, *rng, tz=TZ)
print('after rename:', [fmt(i['start_at']) for i in after])

print()
print('=== 2. Scheduled Tasks calendar: COUNT re-anchored at next_run_at shows phantom runs ===')
now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None, second=0, microsecond=0)
dtstart = (now - dt.timedelta(days=2)).replace(hour=8, minute=0)
rule = f'DTSTART:{dtstart:%Y%m%dT%H%M%S}\nRRULE:FREQ=DAILY;COUNT=4'
real_remaining = next_n_runs_ns(rule, n=10, tz=TZ)
print('rule                     :', rule.replace('\n', ' | '))
print('scheduler: remaining runs:', [fmt(x) for x in real_remaining])
virtual = {
    'id': 'auto_a1',
    'calendar_id': '__scheduled_tasks__',
    'user_id': 'u',
    'title': 'Daily report',
    'start_at': next_run_ns(rule, tz=TZ),  # what claim_due stores as next_run_at
    'end_at': None,
    'rrule': rule,
}
now_ns = time.time_ns()
inst = expand_recurring_event(virtual, now_ns, now_ns + 30 * 86400 * NS, tz=TZ)
print('calendar: virtual runs   :', [fmt(i['start_at']) for i in inst])

print()
