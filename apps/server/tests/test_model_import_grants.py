"""/models/import keeps what a model leaves out when its id exists (#524).

Admin Settings > Models import (apps/web .../workspace/models/modelImport.ts,
importPayload) sends each model without `access_grants`, and without
`base_model_id` when the file names none, relying on the server to keep the
existing model's sharing and base model. Requests go through the real router
and auth dependency, against models and grants in the test run's migrated
SQLite database; only the event publisher is faked. Pinned:

- a model without `access_grants` or `base_model_id` keeps both, and its meta
  is merged over the stored meta;
- a model with `access_grants: []`, or a null base model, clears them, which is
  why the import leaves the keys out instead;
- a new model imported without grants starts with none.

Run from apps/server:

    python -m pytest tests/test_model_import_grants.py
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.models.access_grants import AccessGrants
from local_llm.models.groups import GroupForm, Groups
from local_llm.models.models import ModelForm, Models
from local_llm.models.users import Users
from local_llm.routers import models as models_router
from local_llm.utils.auth import create_token


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(scope='module')
def admin():
    uid = f'import-admin-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, 'import admin', f'{uid}@example.com', role='admin'))
    token = create_token({'id': uid}, dt.timedelta(minutes=30))
    return SimpleNamespace(id=uid, headers={'Authorization': f'Bearer {token}'})


@pytest.fixture(scope='module')
def group(admin):
    return _run(Groups.insert_new_group(admin.id, GroupForm(name=f'g-{uuid.uuid4().hex[:6]}', description='')))


@pytest.fixture
def client(monkeypatch):
    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(models_router, 'publish_event', nothing)
    app = FastAPI()
    app.include_router(models_router.router, prefix='/models')
    return TestClient(app)


def _shared_model(admin, group) -> str:
    model_id = f'm-{uuid.uuid4().hex[:10]}'
    form = ModelForm(
        id=model_id,
        base_model_id='llama3',
        name='Shared',
        meta={'description': 'old'},
        params={'system': 'old'},
        access_grants=[{'principal_type': 'group', 'principal_id': group.id, 'permission': 'read'}],
        is_active=False,
    )
    assert _run(Models.insert_new_model(form, admin.id))
    return model_id


def _grants(model_id):
    return [
        (g.principal_type, g.principal_id, g.permission)
        for g in _run(AccessGrants.get_grants_by_resource('model', model_id))
    ]


def _import(client, admin, *models):
    r = client.post('/models/import', json={'models': list(models)}, headers=admin.headers)
    assert r.status_code == 200, r.text
    assert r.json() is True


def test_a_model_without_grants_or_base_keeps_both(client, admin, group):
    model_id = _shared_model(admin, group)

    _import(client, admin, {'id': model_id, 'name': 'Imported', 'meta': {'tags': [{'name': 't'}]}, 'params': {}})

    assert _grants(model_id) == [('group', group.id, 'read')]
    model = _run(Models.get_model_by_id(model_id))
    assert model.name == 'Imported'
    assert model.base_model_id == 'llama3'
    assert model.is_active is False
    assert model.meta.model_dump(exclude_none=True) == {'description': 'old', 'tags': [{'name': 't'}]}


def test_an_empty_grant_list_or_a_null_base_clears_them(client, admin, group):
    model_id = _shared_model(admin, group)

    _import(client, admin, {'id': model_id, 'name': 'Shared', 'base_model_id': None, 'access_grants': []})

    assert _grants(model_id) == []
    assert _run(Models.get_model_by_id(model_id)).base_model_id is None


def test_a_new_model_imported_without_grants_has_none(client, admin):
    model_id = f'm-{uuid.uuid4().hex[:10]}'

    _import(client, admin, {'id': model_id, 'name': 'New', 'meta': {}, 'params': {}})

    assert _run(Models.get_model_by_id(model_id)).name == 'New'
    assert _grants(model_id) == []
