"""One automation whose next run cannot be computed does not stop the others being claimed (#670).

The claim computed every claimed row's next run in one transaction, so an
exception from one rolled the batch back, and the same rows came first on
every poll: one rule that could not be read stalled every due automation.
Such a row is now switched off, with a log line.

Run from apps/server:

    python -m pytest tests/test_automation_claim_bad_row.py
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid

import pytest

from local_llm.config import run_migrations

DAY_NS = 24 * 60 * 60 * 1_000_000_000
# Long before anything another test leaves due, so only these rows are claimed.
EPOCH_2000_NS = int(dt.datetime(2000, 1, 1, tzinfo=dt.UTC).timestamp() * 1_000_000_000)


@pytest.fixture(autouse=True, scope='module')
def _migrated():
    run_migrations()


def _insert(data: dict, next_run_at: int) -> str:
    from local_llm.internal.db import get_async_db_context
    from local_llm.models.automations import Automation

    automation_id = f'bad-row-{uuid.uuid4().hex[:8]}'

    async def go():
        async with get_async_db_context() as db:
            db.add(
                Automation(
                    id=automation_id,
                    user_id='u-bad-row',
                    name=automation_id,
                    data=data,
                    is_active=True,
                    next_run_at=next_run_at,
                    created_at=EPOCH_2000_NS,
                    updated_at=EPOCH_2000_NS,
                )
            )
            await db.commit()

    asyncio.run(go())
    return automation_id


def test_a_row_whose_next_run_cannot_be_computed_is_switched_off_and_the_rest_are_claimed(caplog):
    from local_llm.models.automations import Automations

    unreadable = _insert({'rrule': 'RRULE:FREQ=FORTNIGHTLY'}, EPOCH_2000_NS)
    missing = _insert({}, EPOCH_2000_NS)
    good = _insert({'rrule': 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0'}, EPOCH_2000_NS + DAY_NS)

    claimed = asyncio.run(Automations.claim_due(EPOCH_2000_NS + 2 * DAY_NS))

    assert [a.id for a in claimed] == [good]
    assert claimed[0].next_run_at is not None
    for automation_id in (unreadable, missing):
        row = asyncio.run(Automations.get_by_id(automation_id))
        assert (row.is_active, row.next_run_at, row.last_run_at) == (False, None, None)
        assert automation_id in caplog.text

    # Switched off, they are not claimed again.
    assert asyncio.run(Automations.claim_due(EPOCH_2000_NS + 2 * DAY_NS)) == []
