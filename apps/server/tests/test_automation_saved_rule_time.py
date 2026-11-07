"""Every way of saving an automation writes down the time a rule takes from when it is saved (#670).

A daily rule that does not state its hour and minute takes them from when
it is read; `pin_rule_time` writes that time down as a DTSTART, so a time the
clocks skip does not move the rule for good. These tests go through the four
places a rule is saved, the router's create and update and the assistant's
`create_automation` and `update_automation` tools, against the test run's
migrated SQLite database, as an admin (who skips the per-user limits); only
the feature switch and the event publisher are faked. A rule the schedule
picker writes, which states its time, is saved as given.

Run from apps/server:

    python -m pytest tests/test_automation_saved_rule_time.py
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import uuid
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.config import run_migrations
from local_llm.models.automations import Automations
from local_llm.models.config import Config
from local_llm.models.users import Users
from local_llm.routers import automations as automations_router
from local_llm.tools import builtin
from local_llm.utils.auth import create_token

UNSTATED = 'RRULE:FREQ=DAILY'
PICKER = 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0'


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(scope='module')
def admin():
    run_migrations()
    uid = f'rule-time-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, 'rule time', f'{uid}@example.com', role='admin'))
    token = create_token({'id': uid}, dt.timedelta(minutes=30))
    return SimpleNamespace(id=uid, headers={'Authorization': f'Bearer {token}'})


@pytest.fixture
def client(monkeypatch):
    real_get_many = Config.get_many

    async def get_many(*keys):
        values = await real_get_many(*keys)
        return {**values, 'automations.enable': True} if 'automations.enable' in keys else values

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(Config, 'get_many', get_many)
    monkeypatch.setattr(automations_router, 'publish_event', nothing)
    app = FastAPI()
    app.include_router(automations_router.router, prefix='/automations')
    return TestClient(app)


def _form(rrule: str) -> dict:
    return {'name': 'rule time', 'data': {'prompt': 'p', 'model_id': 'm', 'rrule': rrule}}


def _stored(automation_id: str) -> str:
    return _run(Automations.get_by_id(automation_id)).data['rrule']


def _assert_pinned(rrule: str, saved: str) -> None:
    first, rest = saved.split('\n', 1)
    assert first.startswith('DTSTART:') and first.endswith('00') and len(first) == len('DTSTART:20270313T023000')
    assert rest == rrule


def test_the_router_pins_an_unstated_time_on_create_and_update(client, admin):
    r = client.post('/automations/create', json=_form(UNSTATED), headers=admin.headers)
    assert r.status_code == 200, r.text
    automation_id = r.json()['id']
    _assert_pinned(UNSTATED, r.json()['data']['rrule'])
    _assert_pinned(UNSTATED, _stored(automation_id))

    r = client.post(f'/automations/{automation_id}/update', json=_form('RRULE:FREQ=WEEKLY'), headers=admin.headers)
    assert r.status_code == 200, r.text
    _assert_pinned('RRULE:FREQ=WEEKLY', _stored(automation_id))


def test_the_router_saves_a_picker_rule_as_given(client, admin):
    r = client.post('/automations/create', json=_form(PICKER), headers=admin.headers)
    assert r.status_code == 200, r.text
    automation_id = r.json()['id']
    assert r.json()['data']['rrule'] == PICKER

    r = client.post(f'/automations/{automation_id}/update', json=_form(PICKER), headers=admin.headers)
    assert r.status_code == 200, r.text
    assert _stored(automation_id) == PICKER


def _tool(fn, *args, **kwargs) -> dict:
    out = json.loads(_run(fn(*args, __request__=object(), **kwargs)))
    assert out.get('status') == 'success', out
    return out


def test_the_assistants_tools_pin_an_unstated_time_on_create_and_update(admin):
    user = {'id': admin.id, 'role': 'admin'}
    created = _tool(
        builtin.create_automation, 'rule time', 'p', UNSTATED, __user__=user, __metadata__={'model_id': 'm'}
    )
    _assert_pinned(UNSTATED, _stored(created['id']))

    _tool(builtin.update_automation, created['id'], rrule='RRULE:FREQ=WEEKLY', __user__=user)
    _assert_pinned('RRULE:FREQ=WEEKLY', _stored(created['id']))


def test_the_assistants_tools_save_a_picker_rule_as_given(admin):
    user = {'id': admin.id, 'role': 'admin'}
    created = _tool(builtin.create_automation, 'rule time', 'p', PICKER, __user__=user, __metadata__={'model_id': 'm'})
    assert _stored(created['id']) == PICKER

    _tool(builtin.update_automation, created['id'], name='renamed', __user__=user)
    assert _stored(created['id']) == PICKER
