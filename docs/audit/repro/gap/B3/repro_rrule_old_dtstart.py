"""B3: sub-daily rules whose DTSTART is far enough in the past lose DTSTART (phase and COUNT window)."""

import datetime as dt

from dateutil.rrule import rrulestr

from local_llm.utils.automations import next_n_runs_ns, next_run_ns, validate_rrule

now = dt.datetime.now()
for rule in [
    'DTSTART:20240101T000000\nRRULE:FREQ=MINUTELY;COUNT=10',  # exhausted on 2024-01-01 00:09
    'DTSTART:20260801T000730\nRRULE:FREQ=MINUTELY;INTERVAL=5',  # phase :07:30, :12:30, ...
    'DTSTART:20261001T000730\nRRULE:FREQ=MINUTELY;INTERVAL=5',  # same phase, recent DTSTART
]:
    plain = rrulestr(rule, ignoretz=True).after(now)
    try:
        validate_rrule(rule)
        v = 'accepted'
    except ValueError as e:
        v = f'rejected: {e}'
    nxt = next_run_ns(rule)
    print(repr(rule))
    print('   dateutil next occurrence:', plain)
    print('   validate_rrule          :', v)
    print('   next_run_ns             :', dt.datetime.fromtimestamp(nxt / 1e9) if nxt else None)
    print('   next_n_runs_ns(3)       :', [str(dt.datetime.fromtimestamp(x / 1e9)) for x in next_n_runs_ns(rule, 3)])
