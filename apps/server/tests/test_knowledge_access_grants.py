"""The two knowledge-base routes the page's access dialog relies on (#522).

`KnowledgeBasePage.tsx` shows the grants `/knowledge/{id}/access/update`
answers with, and its name and description autosave sends no grants. Requests
go through the real router and auth dependency, against a knowledge base and
grants in the test run's migrated SQLite database; the user permissions, the
event publisher and the metadata embedding are faked. Pinned:

- `/access/update` answers with the grants it stored, without those this user
  may not set (here: public sharing);
- `/update` without `access_grants` leaves the stored grants alone.

Run from apps/server:

    python -m pytest tests/test_knowledge_access_grants.py
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
from local_llm.models.knowledge import KnowledgeForm, Knowledges
from local_llm.models.users import Users
from local_llm.routers import knowledge as knowledge_router
from local_llm.utils.auth import create_token


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(scope='module')
def owner():
    uid = f'kb-owner-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, 'kb owner', f'{uid}@example.com', role='user'))
    token = create_token({'id': uid}, dt.timedelta(minutes=30))
    return SimpleNamespace(id=uid, headers={'Authorization': f'Bearer {token}'})


@pytest.fixture(scope='module')
def group(owner):
    return _run(Groups.insert_new_group(owner.id, GroupForm(name=f'g-{uuid.uuid4().hex[:6]}', description='')))


@pytest.fixture
def client(monkeypatch):
    permissions = copy.deepcopy(DEFAULT_USER_PERMISSIONS)
    permissions['sharing']['knowledge'] = True
    permissions['sharing']['public_knowledge'] = False
    real_get = Config.get

    async def get(key, default=None):
        return permissions if key == 'user.permissions' else await real_get(key, default)

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(Config, 'get', get)
    monkeypatch.setattr(knowledge_router, 'publish_event', nothing)
    monkeypatch.setattr(knowledge_router, 'embed_knowledge_base_metadata', nothing)
    app = FastAPI()
    app.include_router(knowledge_router.router, prefix='/knowledge')
    return TestClient(app)


def _group_grant(group):
    return {'principal_type': 'group', 'principal_id': group.id, 'permission': 'read'}


PUBLIC = {'principal_type': 'user', 'principal_id': '*', 'permission': 'read'}


def _shared_base(owner, group) -> str:
    form = KnowledgeForm(name='Base', description='d', access_grants=[_group_grant(group)])
    knowledge = _run(Knowledges.insert_new_knowledge(owner.id, form))
    assert knowledge
    return knowledge.id


def _grants(knowledge_id):
    return sorted(
        (g.principal_type, g.principal_id, g.permission)
        for g in _run(AccessGrants.get_grants_by_resource('knowledge', knowledge_id))
    )


def test_access_update_answers_with_the_grants_it_stored(client, owner, group):
    knowledge_id = _shared_base(owner, group)

    r = client.post(
        f'/knowledge/{knowledge_id}/access/update',
        json={'access_grants': [_group_grant(group), PUBLIC]},
        headers=owner.headers,
    )

    assert r.status_code == 200, r.text
    answered = [(g['principal_type'], g['principal_id'], g['permission']) for g in r.json()['access_grants']]
    assert answered == [('group', group.id, 'read')]
    assert _grants(knowledge_id) == [('group', group.id, 'read')]


def test_an_update_without_grants_leaves_them_alone(client, owner, group):
    knowledge_id = _shared_base(owner, group)

    r = client.post(
        f'/knowledge/{knowledge_id}/update', json={'name': 'Renamed', 'description': 'd'}, headers=owner.headers
    )

    assert r.status_code == 200, r.text
    assert _run(Knowledges.get_knowledge_by_id(knowledge_id)).name == 'Renamed'
    assert _grants(knowledge_id) == [('group', group.id, 'read')]
