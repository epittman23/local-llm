"""/skills/id/{id}/update writes only the fields a request sends (#527).

`SkillForm` defaults `is_active` to true and `meta` to empty, and the route
wrote the whole form, so a client that left them out re-enabled the skill and
cleared its tags; the editor, which sent the values it loaded, could also put
back an enabled state changed elsewhere meanwhile. Requests go through the real
router and auth dependency, against a skill and grants in the test run's
migrated SQLite database; only the user permissions and the event publisher
are faked. Pinned:

- an update that leaves out `is_active`, `meta` and `access_grants` keeps them;
- an update that sends them writes them;
- grants sent are still filtered: a public grant this user may not set is dropped.

Run from apps/server:

    python -m pytest tests/test_skill_update_partial.py
"""

from __future__ import annotations

import asyncio
import copy
import datetime as dt
import uuid
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.config import DEFAULT_USER_PERMISSIONS
from local_llm.models.access_grants import AccessGrants
from local_llm.models.config import Config
from local_llm.models.groups import GroupForm, Groups
from local_llm.models.skills import SkillForm, Skills
from local_llm.models.users import Users
from local_llm.routers import skills as skills_router
from local_llm.utils.auth import create_token


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(scope='module')
def owner():
    uid = f'skill-owner-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, 'skill owner', f'{uid}@example.com', role='user'))
    token = create_token({'id': uid}, dt.timedelta(minutes=30))
    return SimpleNamespace(id=uid, headers={'Authorization': f'Bearer {token}'})


@pytest.fixture(scope='module')
def group(owner):
    return _run(Groups.insert_new_group(owner.id, GroupForm(name=f'g-{uuid.uuid4().hex[:6]}', description='')))


@pytest.fixture
def client(monkeypatch):
    permissions = copy.deepcopy(DEFAULT_USER_PERMISSIONS)
    permissions['sharing']['skills'] = True
    permissions['sharing']['public_skills'] = False
    real_get = Config.get

    async def get(key, default=None):
        return permissions if key == 'user.permissions' else await real_get(key, default)

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(Config, 'get', get)
    monkeypatch.setattr(skills_router, 'publish_event', nothing)
    app = FastAPI()
    app.include_router(skills_router.router, prefix='/skills')
    return TestClient(app)


def _grant(group):
    return {'principal_type': 'group', 'principal_id': group.id, 'permission': 'read'}


def _disabled_tagged_skill(owner, group) -> str:
    skill_id = f's-{uuid.uuid4().hex[:10]}'
    form = SkillForm(
        id=skill_id,
        name=f'Review {skill_id}',
        description='d',
        content='old',
        meta={'tags': ['imported']},
        is_active=False,
        access_grants=[_grant(group)],
    )
    assert _run(Skills.insert_new_skill(owner.id, form))
    return skill_id


def _grants(skill_id):
    return sorted(
        (g.principal_type, g.principal_id, g.permission)
        for g in _run(AccessGrants.get_grants_by_resource('skill', skill_id))
    )


def test_an_update_that_leaves_fields_out_keeps_them(client, owner, group):
    skill_id = _disabled_tagged_skill(owner, group)

    r = client.post(
        f'/skills/id/{skill_id}/update',
        json={'id': skill_id, 'name': f'Renamed {skill_id}', 'content': 'new'},
        headers=owner.headers,
    )

    assert r.status_code == 200, r.text
    skill = _run(Skills.get_skill_by_id(skill_id))
    assert (skill.name, skill.content) == (f'Renamed {skill_id}', 'new')
    assert skill.is_active is False
    assert skill.meta.tags == ['imported']
    assert _grants(skill_id) == [('group', group.id, 'read')]


def test_an_update_that_sends_fields_writes_them(client, owner, group):
    skill_id = _disabled_tagged_skill(owner, group)

    r = client.post(
        f'/skills/id/{skill_id}/update',
        json={
            'id': skill_id,
            'name': f'Review {skill_id}',
            'content': 'old',
            'is_active': True,
            'meta': {'tags': []},
            'access_grants': [],
        },
        headers=owner.headers,
    )

    assert r.status_code == 200, r.text
    skill = _run(Skills.get_skill_by_id(skill_id))
    assert skill.is_active is True
    assert skill.meta.tags == []
    assert _grants(skill_id) == []


def test_grants_sent_are_still_filtered(client, owner, group):
    skill_id = _disabled_tagged_skill(owner, group)
    public = {'principal_type': 'user', 'principal_id': '*', 'permission': 'read'}

    r = client.post(
        f'/skills/id/{skill_id}/update',
        json={
            'id': skill_id,
            'name': f'Review {skill_id}',
            'content': 'old',
            'access_grants': [_grant(group), public],
        },
        headers=owner.headers,
    )

    assert r.status_code == 200, r.text
    assert _grants(skill_id) == [('group', group.id, 'read')]
