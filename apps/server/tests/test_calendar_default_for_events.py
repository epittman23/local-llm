"""An event created without a calendar goes into the user's own default (#182).

get_calendars_by_user lists owned and shared calendars by creation, and
is_default is the owner's flag. The assistant's create_calendar_event took
the first calendar flagged default, which could be another user's earlier
"Personal" calendar shared with this one: read-only, the event failed with
"Access denied"; writable, it landed in someone else's calendar.

Runs against the suite's temporary SQLite database (migrated on import).

Run from apps/server:

    python -m pytest tests/test_calendar_default_for_events.py
"""

import asyncio
import json
import uuid
from types import SimpleNamespace

from local_llm.models.calendar import Calendars, CalendarUpdateForm
from local_llm.models.users import Users
from local_llm.tools import builtin

REQUEST = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))


def test_the_event_lands_in_the_users_own_default_not_a_shared_one():
    async def scenario():
        tag = uuid.uuid4().hex[:8]
        other = await Users.insert_new_user(f'o{tag}', 'Other', f'o{tag}@example.invalid', role='user')
        me = await Users.insert_new_user(f'm{tag}', 'Me', f'm{tag}@example.invalid', role='user')
        # The other user's default comes first by creation, and is shared with me read-only.
        theirs = (await Calendars.get_or_create_defaults(other.id))[0]
        await Calendars.update_calendar_by_id(
            theirs.id,
            CalendarUpdateForm(
                name=theirs.name,
                access_grants=[{'principal_type': 'user', 'principal_id': me.id, 'permission': 'read'}],
            ),
        )
        mine = (await Calendars.get_or_create_defaults(me.id))[0]
        out = json.loads(
            await builtin.create_calendar_event(
                'Dentist', '2026-10-15 14:00', __request__=REQUEST, __user__={'id': me.id, 'role': 'user'}
            )
        )
        return mine, out

    mine, out = asyncio.run(scenario())

    assert 'error' not in out, out
    assert out['calendar_id'] == mine.id
