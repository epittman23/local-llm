"""validate_rrule refuses an incomplete DTSTART instead of reading it as midnight (#642).

Run from apps/server:

    python -m pytest tests/test_automation_dtstart_strict.py
"""

from __future__ import annotations

import pytest

RRULE = 'RRULE:FREQ=DAILY;COUNT=1'


@pytest.mark.parametrize(
    'dtstart',
    [
        'DTSTART:20991201T00',
        'DTSTART:20991201T',
        'DTSTART:20991201T0900',
        'DTSTART:20991201T09000',
        'DTSTART:T090000',
        'DTSTART;TZID=Europe/Paris:20991201T00',
    ],
)
def test_an_incomplete_dtstart_is_rejected(dtstart):
    from local_llm.constants import ERROR_MESSAGES
    from local_llm.utils.automations import validate_rrule

    with pytest.raises(ValueError) as err:
        validate_rrule(f'{dtstart}\n{RRULE}')
    assert str(err.value).startswith(ERROR_MESSAGES.AUTOMATION_INVALID_RRULE('')[:20])


@pytest.mark.parametrize(
    'dtstart',
    [
        'DTSTART:20991201',
        'DTSTART:20991201T090000',
        'DTSTART:20991201T090000Z',
        'DTSTART;TZID=Europe/Paris:20991201T090000',
        'DTSTART;VALUE=DATE:20991201',
    ],
)
def test_a_whole_dtstart_is_accepted(dtstart):
    from local_llm.utils.automations import validate_rrule

    validate_rrule(f'{dtstart}\n{RRULE}')
