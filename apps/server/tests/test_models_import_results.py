"""POST /models/import says what it imported and what it skipped, and why (#337).

It answered true whatever happened: entries it skipped (no write access, an
invalid id, ...) were left out silently, a save that failed was still
counted, and one entry that failed validation made the whole request a 500
after earlier entries had been saved. Requests go through the real router
and auth dependency, against the test run's migrated SQLite database; only
the event publisher is faked.

Run from apps/server:

    python -m pytest tests/test_models_import_results.py
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
from local_llm.models.config import Config
from local_llm.models.models import ModelForm, Models
from local_llm.models.users import Users
from local_llm.routers import models as models_router
from local_llm.utils.auth import create_token


def _run(coro):
    return asyncio.run(coro)


def _user(role: str):
    uid = f'import-{role}-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, f'import {role}', f'{uid}@example.com', role=role))
    token = create_token({'id': uid}, dt.timedelta(minutes=30))
    return SimpleNamespace(id=uid, headers={'Authorization': f'Bearer {token}'})


@pytest.fixture(scope='module')
def admin():
    return _user('admin')


@pytest.fixture(scope='module')
def member():
    return _user('user')


@pytest.fixture
def client(monkeypatch):
    permissions = copy.deepcopy(DEFAULT_USER_PERMISSIONS)
    permissions.setdefault('workspace', {})['models_import'] = True
    real_get = Config.get

    async def get(key, default=None):
        return permissions if key == 'user.permissions' else await real_get(key, default)

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(Config, 'get', get)
    monkeypatch.setattr(models_router, 'publish_event', nothing)
    app = FastAPI()
    app.include_router(models_router.router, prefix='/models')
    # The connections' own models, as get_all_models leaves them: an Ollama one and a preset.
    app.state.MODELS = {
        'llama3:8b': {'id': 'llama3:8b', 'owned_by': 'ollama'},
        'gpt-4o': {'id': 'gpt-4o', 'owned_by': 'openai'},
        'a-preset': {'id': 'a-preset', 'preset': True},
    }
    return TestClient(app)


def _id() -> str:
    return f'm-{uuid.uuid4().hex[:10]}'


def _entry(model_id: str, **fields) -> dict:
    return {'id': model_id, 'base_model_id': 'llama3', 'name': 'Imported', 'meta': {}, 'params': {}, **fields}


def test_each_skipped_entry_is_named_with_its_reason_and_the_rest_are_saved(client, admin):
    first, second, invalid, bad_meta = _id(), _id(), _id(), _id()

    response = client.post(
        '/models/import',
        headers=admin.headers,
        json={
            'models': [
                _entry(first),
                _entry(first, name='Again'),
                {'name': 'no id'},
                _entry(invalid, name=None),
                _entry(bad_meta, meta='not an object'),
                _entry(second),
            ]
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body['imported'] == [first, second]
    assert [(skip['id'], skip['reason'].split(':')[0]) for skip in body['skipped']] == [
        (first, 'listed more than once'),
        (None, 'no valid id'),
        (invalid, 'invalid'),
        (bad_meta, 'invalid'),
    ]
    assert _run(Models.get_model_by_id(first)).name == 'Imported'
    assert _run(Models.get_model_by_id(second)) is not None
    assert _run(Models.get_model_by_id(invalid)) is None


def test_a_save_that_fails_is_reported_not_counted(client, admin, monkeypatch):
    async def fail(*_a, **_k):
        return None

    monkeypatch.setattr(models_router.Models, 'insert_new_model', fail)
    model_id = _id()

    response = client.post('/models/import', headers=admin.headers, json={'models': [_entry(model_id)]})

    assert response.json() == {'imported': [], 'skipped': [{'id': model_id, 'reason': 'could not be saved'}]}


def test_a_failed_update_is_reported_too(client, admin, monkeypatch):
    model_id = _id()
    assert _run(Models.insert_new_model(ModelForm(**_entry(model_id)), admin.id))

    async def fail(*_a, **_k):
        return None

    monkeypatch.setattr(models_router.Models, 'update_model_by_id', fail)

    response = client.post('/models/import', headers=admin.headers, json={'models': [_entry(model_id, name='New')]})

    assert response.json() == {'imported': [], 'skipped': [{'id': model_id, 'reason': 'could not be saved'}]}


def test_a_model_the_importer_cannot_write_is_skipped_by_name(client, admin, member):
    model_id = _id()
    assert _run(Models.insert_new_model(ModelForm(**_entry(model_id)), admin.id))

    response = client.post(
        '/models/import', headers=member.headers, json={'models': [_entry(model_id, name='Taken over')]}
    )

    assert response.json() == {'imported': [], 'skipped': [{'id': model_id, 'reason': 'no write access'}]}
    assert _run(Models.get_model_by_id(model_id)).name == 'Imported'


def test_a_member_s_entries_are_each_skipped_for_their_own_reason(client, member):
    mine, cleared, invalid, fine = _id(), _id(), _id(), _id()
    for model_id in (mine, cleared, invalid):
        assert _run(Models.insert_new_model(ModelForm(**_entry(model_id)), member.id))
    knowledge = {'knowledge': [{'type': 'file', 'id': f'not-a-file-{uuid.uuid4().hex[:8]}'}]}

    response = client.post(
        '/models/import',
        headers=member.headers,
        json={
            'models': [
                _entry(mine, meta=knowledge),
                _entry(cleared, base_model_id=None),
                _entry(invalid, name=None),
                _entry(_id(), base_model_id=None),
                _entry('llama3', base_model_id='gpt-4o'),
                _entry('gpt-4o', base_model_id='llama3:8b'),
                _entry(fine, name='Mine'),
            ]
        },
    )

    body = response.json()
    assert body['imported'] == [fine]
    assert [(skip['id'], skip['reason'].split(':')[0]) for skip in body['skipped']] == [
        (mine, 'knowledge file access denied'),
        (cleared, 'cannot clear base model'),
        (invalid, 'invalid'),
        (body['skipped'][3]['id'], 'no base model set'),
        ('llama3', 'id belongs to a base model'),
        ('gpt-4o', 'id belongs to a base model'),
    ]
    assert _run(Models.get_model_by_id(fine)).name == 'Mine'


def test_a_repeated_id_is_skipped_only_once_a_copy_of_it_was_imported(client, admin):
    model_id = _id()

    response = client.post(
        '/models/import',
        headers=admin.headers,
        json={'models': [_entry(model_id, name=None), _entry(model_id), _entry(model_id, name='Third')]},
    )

    body = response.json()
    assert body['imported'] == [model_id]
    assert [skip['reason'] for skip in body['skipped']] == [
        'invalid: name: Input should be a valid string',
        'listed more than once',
    ]
    assert _run(Models.get_model_by_id(model_id)).name == 'Imported'


def test_an_update_heals_a_self_base_and_takes_the_grants_it_is_given(client, admin):
    model_id = _id()
    assert _run(Models.insert_new_model(ModelForm(**_entry(model_id)), admin.id))

    response = client.post(
        '/models/import',
        headers=admin.headers,
        json={'models': [_entry(model_id, base_model_id=model_id, access_grants=[])]},
    )

    assert response.json() == {'imported': [model_id], 'skipped': []}
    assert _run(Models.get_model_by_id(model_id)).base_model_id is None


def test_knowledge_that_is_not_a_list_is_skipped_not_a_500(client, member):
    model_id = _id()

    response = client.post(
        '/models/import', headers=member.headers, json={'models': [_entry(model_id, meta={'knowledge': 5})]}
    )

    assert response.status_code == 200
    assert response.json()['skipped'] == [{'id': model_id, 'reason': 'invalid: meta.knowledge must be a list'}]
