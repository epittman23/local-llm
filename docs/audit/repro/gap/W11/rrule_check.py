from local_llm.utils.automations import validate_rrule, next_run_ns
import datetime as dt
for r in ['RRULE:FREQ=DAILY;BYHOUR=0;BYMINUTE=undefined', 'DTSTART:20261201T00\nRRULE:FREQ=DAILY;COUNT=1', 'DTSTART:T090000\nRRULE:FREQ=DAILY;COUNT=1']:
    try:
        validate_rrule(r, tz='America/New_York')
        n = next_run_ns(r, tz='America/New_York')
        print(repr(r), '-> accepted, next run', dt.datetime.fromtimestamp(n/1e9))
    except Exception as e:
        print(repr(r), '->', type(e).__name__, e)
