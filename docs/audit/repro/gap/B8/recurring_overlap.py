"""A weekly overnight event (Sat 22:00 -> Sun 02:00) and a week view that starts Sunday 00:00."""
import datetime as dt
from zoneinfo import ZoneInfo
from local_llm.utils.calendar import expand_recurring_event

tz = ZoneInfo('UTC')
ns = lambda d: int(d.timestamp()) * 1_000_000_000
start = dt.datetime(2026, 10, 3, 22, 0, tzinfo=tz)  # Saturday
event = {'id': 'e', 'start_at': ns(start), 'end_at': ns(start + dt.timedelta(hours=4)), 'rrule': 'FREQ=WEEKLY'}
non_recurring = dict(event, rrule=None)

week_start = dt.datetime(2026, 10, 11, 0, 0, tzinfo=tz)  # Sunday
week_end = week_start + dt.timedelta(days=7)
inst = expand_recurring_event(event, ns(week_start), ns(week_end), tz='UTC')
print('instances in week view:', [dt.datetime.fromtimestamp(i['start_at'] / 1e9, tz).isoformat() for i in inst])
# The Sat 10 Oct 22:00 occurrence runs until Sun 11 Oct 02:00, inside the view, but is not returned.
occ = dt.datetime(2026, 10, 10, 22, 0, tzinfo=tz)
print('occurrence overlapping view start (Sat 10 Oct 22:00-02:00) returned:',
      any(i['start_at'] == ns(occ) for i in inst))
# models/calendar.py:562-571 treats the equivalent one-off event as overlapping
one_off_start, one_off_end = ns(occ), ns(occ + dt.timedelta(hours=4))
print('same one-off event matches the SQL overlap condition:',
      one_off_start < ns(week_end) and (one_off_end > ns(week_start) or one_off_start >= ns(week_start)))
