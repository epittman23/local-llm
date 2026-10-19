# Mirrors utils/oauth.py:201 and the expiry check at utils/oauth.py:1050-1053 / 1689-1692.
import datetime as dt, os, time
NON_EXPIRING_TOKEN_EXPIRES_AT = 253402300799
time.tzset()
print('TZ', os.environ.get('TZ'))
try:
    needs_refresh = dt.datetime.now() + dt.timedelta(minutes=5) >= dt.datetime.fromtimestamp(NON_EXPIRING_TOKEN_EXPIRES_AT)
    print('needs_refresh =', needs_refresh)
except Exception as e:
    print('raises', type(e).__name__, e)
