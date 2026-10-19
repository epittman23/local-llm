from local_llm.utils.automations import validate_rrule
try:
    validate_rrule('DTSTART:20261001T090000\nRRULE:FREQ=DAILY;COUNT=1', tz='America/New_York')
    print('accepted')
except ValueError as e:
    print('create would answer 400:', e)
