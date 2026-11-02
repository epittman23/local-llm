"""/models/model/update leaves a model's grants alone when the body has none.

The Workspace > Models import (apps/web .../workspace/models/modelImport.ts,
importUpdate) updates an existing model with a body that omits
`access_grants`, relying on the server to keep the model's sharing; it sends
`is_active` and the merged meta explicitly. Requests go through the real
router and auth dependency, against a model and grants in the test run's
migrated SQLite database; only the event publisher is faked. Pinned:

- a body without `access_grants` keeps the existing grants, and writes
  `is_active`, `meta`, `params` and `base_model_id` as sent;
- a body with `access_grants: []` clears them, which is why the import must
  leave the key out rather than send an empty list.

Run from apps/server:

    python -m pytest tests/test_model_update_grants.py
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
from local_llm.models.models import ModelForm, Models
from local_llm.models.users import Users
from local_llm.routers import models as models_router
from local_llm.utils.auth import create_token


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(scope='module')
def owner():
    uid = f'model-owner-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, 'model owner', f'{uid}@example.com', role='user'))
    token = create_token({'id': uid}, dt.timedelta(minutes=30))
    return SimpleNamespace(id=uid, headers={'Authorization': f'Bearer {token}'})


@pytest.fixture(scope='module')
def group(owner):
    return _run(Groups.insert_new_group(owner.id, GroupForm(name=f'g-{uuid.uuid4().hex[:6]}', description='')))


@pytest.fixture
def client(monkeypatch):
    permissions = copy.deepcopy(DEFAULT_USER_PERMISSIONS)
    real_get = Config.get

    async def get(key, default=None):
        return permissions if key == 'user.permissions' else await real_get(key, default)

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(Config, 'get', get)
    monkeypatch.setattr(models_router, 'publish_event', nothing)
    app = FastAPI()
    app.include_router(models_router.router, prefix='/models')
    return TestClient(app)


def _shared_model(owner, group) -> str:
    model_id = f'm-{uuid.uuid4().hex[:10]}'
    form = ModelForm(
        id=model_id,
        base_model_id='llama3',
        name='Shared',
        meta={'description': 'old'},
        params={'system': 'old'},
        access_grants=[{'principal_type': 'group', 'principal_id': group.id, 'permission': 'read'}],
        is_active=True,
    )
    assert _run(Models.insert_new_model(form, owner.id))
    return model_id


def _grants(model_id):
    return [
        (g.principal_type, g.principal_id, g.permission)
        for g in _run(AccessGrants.get_grants_by_resource('model', model_id))
    ]


def test_an_update_without_grants_keeps_them_and_writes_the_rest_as_sent(client, owner, group):
    model_id = _shared_model(owner, group)
    body = {
        'id': model_id,
        'base_model_id': 'llama3',
        'name': 'Imported',
        'meta': {'description': 'old', 'tags': [{'name': 'imported'}]},
        'params': {'system': 'new'},
        'is_active': False,
    }
    r = client.post('/models/model/update', json=body, headers=owner.headers)
    assert r.status_code == 200, r.text

    assert _grants(model_id) == [('group', group.id, 'read')]
    model = _run(Models.get_model_by_id(model_id))
    assert model.name == 'Imported'
    assert model.is_active is False
    assert model.base_model_id == 'llama3'
    assert model.params.model_dump(exclude_none=True) == {'system': 'new'}
    assert model.meta.model_dump(exclude_none=True) == body['meta']


def test_an_update_with_an_empty_grant_list_clears_them(client, owner, group):
    model_id = _shared_model(owner, group)
    body = {
        'id': model_id,
        'base_model_id': 'llama3',
        'name': 'Shared',
        'meta': {},
        'params': {},
        'access_grants': [],
    }
    r = client.post('/models/model/update', json=body, headers=owner.headers)
    assert r.status_code == 200, r.text
    assert _grants(model_id) == []
