"""A save of a resource's grants is judged only on what it changes (#523, #335).

Editors send the whole grant list on every save, and the routes used to run
`filter_allowed_access_grants` over all of it, so a write-collaborator without
`sharing.public_<x>` stripped a stored `user:*` grant, and one without
`sharing.<x>` wiped every named grant, on a routine save. Given the stored
grants, a non-admin now keeps a grant they add only if they may set it, may
keep or remove a stored grant they may set, and cannot remove a stored grant
they could not have set. Admins are unaffected.

The helper is tested directly, then the note, model, prompt and skill routes
through the real router and auth dependency, against the test run's migrated
SQLite database; only the user permissions, the event publisher and the
note-room socket calls are faked.

Run from apps/server:

    python -m pytest tests/test_access_grant_changes.py
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
from local_llm.models.models import ModelForm, Models
from local_llm.models.notes import NoteForm, Notes
from local_llm.models.prompts import PromptForm, Prompts
from local_llm.models.skills import SkillForm, Skills
from local_llm.models.users import Users
from local_llm.routers import models as models_router
from local_llm.routers import notes as notes_router
from local_llm.routers import prompts as prompts_router
from local_llm.routers import skills as skills_router
from local_llm.utils.access_control import filter_allowed_access_grants
from local_llm.utils.auth import create_token

PUBLIC_READ = {'principal_type': 'user', 'principal_id': '*', 'permission': 'read'}
PUBLIC_WRITE = {'principal_type': 'user', 'principal_id': '*', 'permission': 'write'}
BOB_READ = {'principal_type': 'user', 'principal_id': 'bob', 'permission': 'read'}
GROUP_READ = {'principal_type': 'group', 'principal_id': 'g1', 'permission': 'read'}


def _run(coro):
    return asyncio.run(coro)


def _keys(grants):
    return sorted(
        (g['principal_type'], g['principal_id'], g['permission'])
        if isinstance(g, dict)
        else (g.principal_type, g.principal_id, g.permission)
        for g in grants
    )


def _user(role: str):
    uid = f'grants-{role}-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, uid, f'{uid}@example.com', role=role))
    token = create_token({'id': uid}, dt.timedelta(minutes=30))
    return SimpleNamespace(id=uid, headers={'Authorization': f'Bearer {token}'})


@pytest.fixture(scope='module')
def owner():
    return _user('user')


@pytest.fixture(scope='module')
def collaborator():
    return _user('user')


@pytest.fixture(scope='module')
def admin():
    return _user('admin')


@pytest.fixture
def permissions():
    perms = copy.deepcopy(DEFAULT_USER_PERMISSIONS)
    perms['features']['notes'] = True
    for name in ('notes', 'models', 'prompts', 'skills'):
        perms['sharing'][name] = False
        perms['sharing'][f'public_{name}'] = False
    perms['access_grants']['allow_users'] = True
    perms['access_grants']['allow_groups'] = True
    return perms


@pytest.fixture
def client(monkeypatch, permissions):
    real_get = Config.get

    async def get(key, default=None):
        return permissions if key == 'user.permissions' else await real_get(key, default)

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(Config, 'get', get)
    for router in (notes_router, models_router, prompts_router, skills_router):
        monkeypatch.setattr(router, 'publish_event', nothing)
    monkeypatch.setattr(notes_router.sio, 'emit', nothing)
    monkeypatch.setattr(notes_router, 'prune_note_room', nothing)
    app = FastAPI()
    app.include_router(notes_router.router, prefix='/notes')
    app.include_router(models_router.router, prefix='/models')
    app.include_router(prompts_router.router, prefix='/prompts')
    app.include_router(skills_router.router, prefix='/skills')
    return TestClient(app)


def _write(user):
    return {'principal_type': 'user', 'principal_id': user.id, 'permission': 'write'}


def _stored(resource_type, resource_id):
    return _keys(_run(AccessGrants.get_grants_by_resource(resource_type, resource_id)))


# --- the helper ---------------------------------------------------------------


def _filter(perms, grants, stored, role='user'):
    return _run(
        filter_allowed_access_grants(perms, 'u-helper', role, grants, 'sharing.public_notes', stored_grants=stored)
    )


def _perms(*, share: bool, public: bool) -> dict:
    return {
        'sharing': {'notes': share, 'public_notes': public},
        'access_grants': {'allow_users': True, 'allow_groups': True},
    }


def test_a_disallowed_added_grant_is_dropped():
    out = _filter(_perms(share=False, public=False), [BOB_READ, PUBLIC_READ], [BOB_READ])
    assert _keys(out) == _keys([BOB_READ])


def test_an_allowed_added_grant_is_kept():
    out = _filter(_perms(share=True, public=False), [GROUP_READ], [])
    assert _keys(out) == _keys([GROUP_READ])


def test_a_disallowed_stored_grant_survives_being_left_out():
    out = _filter(_perms(share=False, public=False), [], [PUBLIC_READ, BOB_READ])
    assert _keys(out) == _keys([PUBLIC_READ, BOB_READ])


def test_an_allowed_stored_grant_can_be_removed():
    out = _filter(_perms(share=True, public=False), [], [BOB_READ, PUBLIC_READ])
    assert _keys(out) == _keys([PUBLIC_READ])


def test_changing_a_disallowed_grants_permission_keeps_the_stored_one():
    out = _filter(_perms(share=False, public=False), [PUBLIC_WRITE], [PUBLIC_READ])
    assert _keys(out) == _keys([PUBLIC_READ])


def test_admins_are_judged_on_the_submitted_list():
    out = _filter(_perms(share=False, public=False), [GROUP_READ], [PUBLIC_READ, BOB_READ], role='admin')
    assert _keys(out) == _keys([GROUP_READ])


def test_a_grant_list_not_sent_stays_not_sent():
    assert _filter(_perms(share=False, public=False), None, [PUBLIC_READ]) is None


def test_without_stored_grants_the_whole_list_is_filtered():
    out = _filter(_perms(share=False, public=False), [PUBLIC_READ, BOB_READ], None)
    assert out == []


# --- notes ----------------------------------------------------------------------


def _note(owner, grants) -> str:
    note = _run(Notes.insert_new_note(owner.id, NoteForm(title='n', access_grants=grants)))
    return note.id


def test_a_collaborator_without_public_sharing_keeps_a_public_note_public(client, owner, collaborator):
    note_id = _note(owner, [PUBLIC_READ, _write(collaborator)])

    r = client.post(
        f'/notes/{note_id}/update',
        json={'title': 'n', 'access_grants': [_write(collaborator)]},
        headers=collaborator.headers,
    )

    assert r.status_code == 200, r.text
    assert _stored('note', note_id) == _keys([PUBLIC_READ, _write(collaborator)])


def test_a_collaborator_without_sharing_keeps_named_grants(client, owner, collaborator):
    note_id = _note(owner, [BOB_READ, GROUP_READ, _write(collaborator)])

    r = client.post(f'/notes/{note_id}/access/update', json={'access_grants': []}, headers=collaborator.headers)

    assert r.status_code == 200, r.text
    assert _stored('note', note_id) == _keys([BOB_READ, GROUP_READ, _write(collaborator)])


def test_a_collaborator_cannot_add_a_grant_they_may_not_set(client, owner, collaborator):
    note_id = _note(owner, [_write(collaborator)])

    r = client.post(
        f'/notes/{note_id}/access/update',
        json={'access_grants': [_write(collaborator), PUBLIC_READ, BOB_READ]},
        headers=collaborator.headers,
    )

    assert r.status_code == 200, r.text
    assert _stored('note', note_id) == _keys([_write(collaborator)])


def test_a_collaborator_may_remove_a_grant_they_may_set(client, permissions, owner, collaborator):
    permissions['sharing']['notes'] = True
    note_id = _note(owner, [PUBLIC_READ, BOB_READ, _write(collaborator)])

    r = client.post(
        f'/notes/{note_id}/access/update',
        json={'access_grants': [_write(collaborator)]},
        headers=collaborator.headers,
    )

    assert r.status_code == 200, r.text
    assert _stored('note', note_id) == _keys([PUBLIC_READ, _write(collaborator)])


def test_an_admin_save_replaces_the_grants_as_sent(client, owner, admin):
    note_id = _note(owner, [PUBLIC_READ, BOB_READ])

    r = client.post(f'/notes/{note_id}/access/update', json={'access_grants': [GROUP_READ]}, headers=admin.headers)

    assert r.status_code == 200, r.text
    assert _stored('note', note_id) == _keys([GROUP_READ])


# --- models, prompts and skills (#335) ------------------------------------------------


def test_a_model_save_keeps_grants_the_editor_could_not_set(client, owner, collaborator):
    model_id = f'm-{uuid.uuid4().hex[:10]}'
    form = ModelForm(
        id=model_id,
        base_model_id='llama3',
        name='Shared',
        meta={},
        params={},
        access_grants=[PUBLIC_READ, BOB_READ, _write(collaborator)],
    )
    assert _run(Models.insert_new_model(form, owner.id))

    r = client.post(
        '/models/model/update',
        json={
            'id': model_id,
            'base_model_id': 'llama3',
            'name': 'Renamed',
            'meta': {},
            'params': {},
            'access_grants': [_write(collaborator), GROUP_READ],
        },
        headers=collaborator.headers,
    )

    assert r.status_code == 200, r.text
    assert _stored('model', model_id) == _keys([PUBLIC_READ, BOB_READ, _write(collaborator)])


def test_a_prompt_save_keeps_grants_the_editor_could_not_set(client, owner, collaborator):
    command = f'p{uuid.uuid4().hex[:10]}'
    form = PromptForm(
        command=command,
        name='Shared',
        content='old',
        access_grants=[PUBLIC_READ, BOB_READ, _write(collaborator)],
    )
    prompt = _run(Prompts.insert_new_prompt(owner.id, form))
    assert prompt

    r = client.post(
        f'/prompts/id/{prompt.id}/update',
        json={'command': command, 'name': 'Shared', 'content': 'new', 'access_grants': [PUBLIC_WRITE]},
        headers=collaborator.headers,
    )

    assert r.status_code == 200, r.text
    assert _stored('prompt', prompt.id) == _keys([PUBLIC_READ, BOB_READ, _write(collaborator)])


def test_a_prompt_access_save_may_remove_a_grant_the_editor_may_set(client, permissions, owner, collaborator):
    permissions['sharing']['prompts'] = True
    form = PromptForm(
        command=f'p{uuid.uuid4().hex[:10]}',
        name='Shared',
        content='old',
        access_grants=[PUBLIC_READ, BOB_READ, _write(collaborator)],
    )
    prompt = _run(Prompts.insert_new_prompt(owner.id, form))
    assert prompt

    r = client.post(
        f'/prompts/id/{prompt.id}/access/update',
        json={'access_grants': [_write(collaborator)]},
        headers=collaborator.headers,
    )

    assert r.status_code == 200, r.text
    assert _stored('prompt', prompt.id) == _keys([PUBLIC_READ, _write(collaborator)])


def test_a_skill_save_keeps_grants_the_editor_could_not_set(client, owner, collaborator):
    skill_id = f's-{uuid.uuid4().hex[:10]}'
    form = SkillForm(
        id=skill_id,
        name=f'Skill {skill_id}',
        description='d',
        content='old',
        access_grants=[PUBLIC_READ, BOB_READ, _write(collaborator)],
    )
    assert _run(Skills.insert_new_skill(owner.id, form))

    r = client.post(
        f'/skills/id/{skill_id}/update',
        json={'id': skill_id, 'name': f'Skill {skill_id}', 'content': 'new', 'access_grants': []},
        headers=collaborator.headers,
    )

    assert r.status_code == 200, r.text
    assert _stored('skill', skill_id) == _keys([PUBLIC_READ, BOB_READ, _write(collaborator)])


def test_an_admin_skill_save_replaces_the_grants_as_sent(client, owner, admin):
    skill_id = f's-{uuid.uuid4().hex[:10]}'
    form = SkillForm(
        id=skill_id, name=f'Skill {skill_id}', description='d', content='old', access_grants=[PUBLIC_READ, BOB_READ]
    )
    assert _run(Skills.insert_new_skill(owner.id, form))

    r = client.post(
        f'/skills/id/{skill_id}/update',
        json={'id': skill_id, 'name': f'Skill {skill_id}', 'content': 'old', 'access_grants': []},
        headers=admin.headers,
    )

    assert r.status_code == 200, r.text
    assert _stored('skill', skill_id) == []
