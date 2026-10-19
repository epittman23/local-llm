"""B3 repros for utils/automations.py RRULE helpers.

Run with TZ=UTC so the server-local clock differs from the user's timezone.
"""

import datetime as dt
import os
import time
from zoneinfo import ZoneInfo

from local_llm.utils.automations import next_n_runs_ns, next_run_ns, rrule_interval_seconds, validate_rrule

print('server TZ env:', os.environ.get('TZ'), 'server local now:', dt.datetime.now().replace(microsecond=0))

# --- 1. Daily/weekly rule without DTSTART skips the next run when the user's tz is behind the server's.
user_tz = 'Etc/GMT+6'  # UTC-6, i.e. 6 hours behind a UTC server
zi = ZoneInfo(user_tz)
user_now = dt.datetime.now(zi)
target_hour = (user_now.hour + 2) % 24  # a run ~2 hours from now in the user's local time
rule = f'RRULE:FREQ=DAILY;BYHOUR={target_hour};BYMINUTE=0'
validate_rrule(rule, tz=user_tz)
ns = next_run_ns(rule, tz=user_tz)
got = dt.datetime.fromtimestamp(ns / 1e9, zi)
expected = user_now.replace(hour=target_hour, minute=0, second=0, microsecond=0)
if expected <= user_now:
    expected += dt.timedelta(days=1)
print('\n[1] rule:', rule, 'user tz:', user_tz)
print('    user now      :', user_now.replace(microsecond=0))
print('    expected next :', expected)
print('    next_run_ns   :', got, f'(hours from now: {(ns / 1e9 - time.time()) / 3600:.2f})')
print('    next_n_runs_ns:', [str(dt.datetime.fromtimestamp(x / 1e9, zi)) for x in next_n_runs_ns(rule, 2, tz=user_tz)])

wk = user_now + dt.timedelta(hours=2)
wday = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][wk.weekday()]
rule_w = f'RRULE:FREQ=WEEKLY;BYDAY={wday};BYHOUR={wk.hour};BYMINUTE=0'
ns_w = next_run_ns(rule_w, tz=user_tz)
print('    weekly', rule_w, '-> next run in', f'{(ns_w / 1e9 - time.time()) / 86400:.2f} days')

# --- 1b. Seconds component inherited from the parse-time clock.
print('\n[1b] seconds of next run (same rule, user tz == server tz):',
      dt.datetime.fromtimestamp(next_run_ns('RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0') / 1e9).second)

