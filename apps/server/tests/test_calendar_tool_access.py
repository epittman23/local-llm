"""The calendar event tools apply the router's write rule.

Run from apps/server:

    python -m pytest tests/test_calendar_tool_access.py
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from local_llm.tools import builtin

CAL = SimpleNamespace(id='cal-owner', user_id='owner')


@pytest.fixture
def world(monkeypatch):
    from local_llm.models import access_grants, calendar, groups

    state = {'grant': False, 'deleted': []}

    async def get_event(event_id):
        # Created by a collaborator, in the owner's calendar.
        return SimpleNamespace(id=event_id, calendar_id='cal-owner', user_id='collaborator', title='Standup')

    async def get_calendar(cal_id):
        return CAL if cal_id == 'cal-owner' else None

    async def get_groups(_uid):
        return []

    async def has_access(**_k):
        return state['grant']

    async def delete(event_id):
        state['deleted'].append(event_id)
        return True

    monkeypatch.setattr(calendar.CalendarEvents, 'get_event_by_id', get_event)
    monkeypatch.setattr(calendar.CalendarEvents, 'delete_event_by_id', delete)
    monkeypatch.setattr(calendar.Calendars, 'get_calendar_by_id', get_calendar)
    monkeypatch.setattr(groups.Groups, 'get_groups_by_member_id', get_groups)
    monkeypatch.setattr(access_grants.AccessGrants, 'has_access', has_access)
    return state


def _delete(user_id: str, role: str = 'user') -> dict:
    out = asyncio.run(builtin.delete_calendar_event('e1', __request__=object(), __user__={'id': user_id, 'role': role}))
    return json.loads(out)


def test_a_collaborator_whose_grant_was_revoked_cannot_delete_their_event(world):
    world['grant'] = False
    assert _delete('collaborator') == {'error': 'Access denied'}
    assert world['deleted'] == []


def test_the_calendar_owner_can_delete_a_collaborators_event(world):
    assert _delete('owner')['status'] == 'success'
    assert world['deleted'] == ['e1']


def test_a_current_write_grant_still_works(world):
    world['grant'] = True
    assert _delete('collaborator')['status'] == 'success'


def test_update_uses_the_same_rule(world):
    out = asyncio.run(
        builtin.update_calendar_event(
            'e1', title='x', __request__=object(), __user__={'id': 'collaborator', 'role': 'user'}
        )
    )
    assert json.loads(out) == {'error': 'Access denied'}
