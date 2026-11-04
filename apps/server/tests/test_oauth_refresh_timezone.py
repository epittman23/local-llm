"""A non-expiring OAuth token stays usable in every server time zone (#285).

A token response with neither `expires_in` nor a refresh token is stored
with the sentinel `expires_at = 253402300799` (9999-12-31 23:59:59 UTC).
`_needs_refresh` converted it with the naive `datetime.fromtimestamp`, a
local time: east of UTC that is in the year 10000, which is out of range, so
the check raised ValueError, the token was never returned, and the provider
stopped working there. The check now compares epoch seconds, with no
conversion, so the answer is the same in every zone.

Run from apps/server:

    python -m pytest tests/test_oauth_refresh_timezone.py
"""

from __future__ import annotations

import os
import time
from types import SimpleNamespace

import pytest

from local_llm.utils import oauth


@pytest.fixture(params=['UTC', 'America/Chicago', 'Europe/Berlin', 'Pacific/Kiritimati'])
def zone(request):
    """Runs the test with the process in each time zone, then puts the old one back."""
    old = os.environ.get('TZ')
    os.environ['TZ'] = request.param
    time.tzset()
    # tzset falls back to UTC for a zone it cannot find; then this test would
    # prove nothing. None of the other zones is ever at offset 0.
    assert (time.localtime().tm_gmtoff != 0) == (request.param != 'UTC')
    yield request.param
    if old is None:
        os.environ.pop('TZ', None)
    else:
        os.environ['TZ'] = old
    time.tzset()


def _session(expires_at):
    return SimpleNamespace(expires_at=expires_at)


def test_a_non_expiring_token_needs_no_refresh(zone):
    session = _session(oauth.NON_EXPIRING_TOKEN_EXPIRES_AT)

    assert oauth._needs_refresh(session, force_refresh=False) is False


def test_a_token_expiring_within_five_minutes_needs_a_refresh(zone):
    assert oauth._needs_refresh(_session(int(time.time()) + 60), force_refresh=False) is True
    assert oauth._needs_refresh(_session(int(time.time()) - 60), force_refresh=False) is True


def test_a_token_with_time_left_needs_no_refresh(zone):
    assert oauth._needs_refresh(_session(int(time.time()) + 3600), force_refresh=False) is False


def test_a_forced_refresh_or_no_expiry_still_refreshes():
    assert oauth._needs_refresh(_session(oauth.NON_EXPIRING_TOKEN_EXPIRES_AT), force_refresh=True) is True
    assert oauth._needs_refresh(_session(None), force_refresh=False) is True
