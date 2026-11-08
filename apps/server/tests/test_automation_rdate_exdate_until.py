"""validate_rrule refuses RDATE and EXDATE, and an incomplete UNTIL, instead of reading them as midnight (#789).

Run from apps/server:

    python -m pytest tests/test_automation_rdate_exdate_until.py
"""

from __future__ import annotations

import pytest


@pytest.mark.parametrize(
    'rule',
    [
        # The issue's case: a second run at 2099-12-02 00:00.
        'DTSTART:20991201T090000\nRRULE:FREQ=DAILY;COUNT=1\nRDATE:20991202T00',
        'DTSTART:20991201T090000\nRRULE:FREQ=DAILY;COUNT=1\nRDATE:20991202T090000',
        'DTSTART:20991201T090000\nRRULE:FREQ=DAILY;COUNT=1\nRDATE;VALUE=DATE-TIME:20991202T090000',
        'DTSTART:20991201T090000\nRRULE:FREQ=DAILY;COUNT=3\nEXDATE:20991202T00',
        'DTSTART:20991201T090000\nRRULE:FREQ=DAILY;COUNT=3\nEXDATE:20991202T090000',
        'DTSTART:20991201T090000 RRULE:FREQ=DAILY;COUNT=1 rdate:20991202T090000',
    ],
)
def test_rdate_and_exdate_are_rejected(rule):
    from local_llm.constants import ERROR_MESSAGES
    from local_llm.utils.automations import validate_rrule

    with pytest.raises(ValueError) as err:
        validate_rrule(rule)
    assert str(err.value).startswith(ERROR_MESSAGES.AUTOMATION_INVALID_RRULE('')[:20])
    assert 'not supported' in str(err.value)


@pytest.mark.parametrize(
    'rule',
    [
        'DTSTART:20991201T090000\nRRULE:FREQ=DAILY;UNTIL=20991203T00',
        'DTSTART:20991201T090000\nRRULE:FREQ=DAILY;UNTIL=20991203T',
        'DTSTART:20991201T090000\nRRULE:FREQ=DAILY;UNTIL=20991203T0900',
        'DTSTART:20991201T090000\nRRULE:FREQ=DAILY;until=20991203T00',
        'DTSTART:20991201T090000 RRULE:FREQ=DAILY;UNTIL=20991203T00',
        # dateutil reads a part without a colon as an RRULE.
        'DTSTART:20991201T090000\nFREQ=DAILY;UNTIL=20991203T00',
        'RRULE:FREQ=HOURLY;UNTIL=20991203T00',
        'FREQ=HOURLY;UNTIL=20991203T00',
    ],
)
def test_an_incomplete_until_is_rejected(rule):
    from local_llm.utils.automations import validate_rrule

    with pytest.raises(ValueError, match='UNTIL must be YYYYMMDD or YYYYMMDDTHHMMSS'):
        validate_rrule(rule)


@pytest.mark.parametrize('until', ['20991203', '20991203T090000', '20991203T090000Z'])
def test_a_whole_until_is_accepted(until):
    from local_llm.utils.automations import validate_rrule

    validate_rrule(f'DTSTART:20991201T090000\nRRULE:FREQ=DAILY;UNTIL={until}')
    validate_rrule(f'RRULE:FREQ=HOURLY;UNTIL={until}')
