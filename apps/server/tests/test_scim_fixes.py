"""SCIM: filters, the PATCH formats real identity providers send, and validated writes.

Run from apps/server:

    python -m pytest tests/test_scim_fixes.py
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.internal.db import get_async_session
from local_llm.routers import scim

PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'


@pytest.mark.parametrize(
    'text, expected',
    [
        ('userName eq "bob@x.com"', ('email', 'bob@x.com')),
        ('USERNAME Eq "bob@x.com"', ('email', 'bob@x.com')),
        ('emails[value eq "bob@x.com"]', ('email', 'bob@x.com')),
        ('emails.value eq "bob@x.com"', ('email', 'bob@x.com')),
        ('externalId eq "abc"', ('externalId', 'abc')),
    ],
)
def test_supported_filters(text, expected):
    assert scim.parse_scim_filter(text, {'username': 'email', 'emails.value': 'email', 'externalid': 'externalId'}) == (
        expected
    )


@pytest.mark.parametrize('text', ['userName eq bob@x.com', 'displayName eq "Nobody"', 'userName sw "b"', ''])
def test_unsupported_filters_are_refused(text):
    with pytest.raises(scim.SCIMRequestError):
        scim.parse_scim_filter(text, {'username': 'email'})


@pytest.mark.parametrize('value, expected', [(True, True), ('False', False), ('true', True), (False, False)])
def test_scim_bool(value, expected):
    assert scim.scim_bool(value) is expected


@pytest.fixture
def world(monkeypatch):
    users = {'u1': SimpleNamespace(id='u1', email='bob@x.com', role='user', name='Bob')}
    groups = {'g1': {'u1', 'u2'}}
    writes = []

    async def get_user(user_id, db=None):
        return users.get(user_id)

    async def get_by_email(email, db=None):
        return next((u for u in users.values() if u.email == email), None)

    async def update_user(user_id, data, db=None):
        writes.append(data)
        for k, v in data.items():
            setattr(users[user_id], k, v)
        return users[user_id]

    async def update_auth_email(user_id, email, db=None):
        writes.append({'auth_email': email})

    meta = {'resourceType': 'User', 'created': 'x', 'lastModified': 'x'}

    async def to_scim(user, request, db=None):
        return {
            'id': user.id, 'userName': user.email, 'displayName': user.name, 'emails': [{'value': user.email}],
            'active': user.role != 'pending', 'meta': meta,
        }  # fmt: skip

    async def get_group(group_id, db=None):
        return SimpleNamespace(id=group_id, name='eng', description='') if group_id in groups else None

    async def group_ids(group_id, db=None):
        return sorted(groups[group_id])

    async def remove(group_id, ids, db=None):
        groups[group_id] -= set(ids)

    async def update_group(group_id, form, db=None):
        return SimpleNamespace(id=group_id, name=form.name)

    async def group_to_scim(group, request, db=None):
        return {
            'id': group.id, 'displayName': group.name, 'members': [{'value': m} for m in sorted(groups[group.id])],
            'meta': {**meta, 'resourceType': 'Group'},
        }  # fmt: skip

    async def publish(*_a, **_k):
        return None

    async def list_users(**_k):
        return {'users': list(users.values()), 'total': len(users)}

    monkeypatch.setattr(scim.Users, 'get_scim_user_by_id', get_user)
    monkeypatch.setattr(scim.Users, 'get_user_by_email', get_by_email)
    monkeypatch.setattr(scim.Users, 'update_user_by_id', update_user)
    monkeypatch.setattr(scim.Users, 'get_scim_users', list_users)
    monkeypatch.setattr(scim.Auths, 'update_email_by_id', update_auth_email)
    monkeypatch.setattr(scim, 'user_to_scim', to_scim)
    monkeypatch.setattr(scim.Groups, 'get_group_by_id', get_group)
    monkeypatch.setattr(scim.Groups, 'get_group_user_ids_by_id', group_ids)
    monkeypatch.setattr(scim.Groups, 'remove_users_from_group', remove)
    monkeypatch.setattr(scim.Groups, 'update_group_by_id', update_group)
    monkeypatch.setattr(scim, 'group_to_scim', group_to_scim)
    monkeypatch.setattr(scim, 'publish_event', publish)

    app = FastAPI()
    app.include_router(scim.router, prefix='/scim/v2')
    app.dependency_overrides[scim.get_scim_auth] = lambda: True
    app.dependency_overrides[get_async_session] = lambda: None
    client = TestClient(app)
    return SimpleNamespace(client=client, users=users, groups=groups, writes=writes)


def test_okta_pathless_deactivation(world):
    r = world.client.patch(
        '/scim/v2/Users/u1', json={'schemas': [PATCH], 'Operations': [{'op': 'replace', 'value': {'active': False}}]}
    )
    assert r.status_code == 200 and world.users['u1'].role == 'pending'


def test_entra_string_false_deactivates(world):
    r = world.client.patch(
        '/scim/v2/Users/u1',
        json={'schemas': [PATCH], 'Operations': [{'op': 'Replace', 'path': 'active', 'value': 'False'}]},
    )
    assert r.status_code == 200 and world.users['u1'].role == 'pending'


def test_unsupported_user_patch_is_a_400_not_a_silent_200(world):
    r = world.client.patch(
        '/scim/v2/Users/u1',
        json={'schemas': [PATCH], 'Operations': [{'op': 'replace', 'path': 'nickName', 'value': 'x'}]},
    )
    assert r.status_code == 400 and r.json()['scimType'] == 'invalidPath'


def test_entra_member_removal_by_value(world):
    r = world.client.patch(
        '/scim/v2/Groups/g1',
        json={
            'schemas': [PATCH],
            'Operations': [{'op': 'Remove', 'path': 'members', 'value': [{'value': 'u1'}, {'value': 'u2'}]}],
        },
    )
    assert r.status_code == 200 and world.groups['g1'] == set()


def test_put_lowercases_email_and_updates_sign_in(world):
    r = world.client.put('/scim/v2/Users/u1', json={'userName': 'Robert@X.com'})
    assert r.status_code == 200
    assert {'auth_email': 'robert@x.com'} in world.writes and world.users['u1'].email == 'robert@x.com'


def test_an_email_another_account_has_is_a_409(world):
    world.users['u2'] = SimpleNamespace(id='u2', email='taken@x.com', role='user', name='T')
    r = world.client.put('/scim/v2/Users/u1', json={'userName': 'TAKEN@x.com'})
    assert r.status_code == 409 and r.json()['scimType'] == 'uniqueness'


def test_an_svg_photo_is_refused(world):
    svg = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
    r = world.client.put('/scim/v2/Users/u1', json={'photos': [{'value': svg}]})
    assert r.status_code == 400 and r.json()['scimType'] == 'invalidValue'


def test_an_unsupported_list_filter_is_a_400_not_everyone(world):
    r = world.client.get('/scim/v2/Users', params={'filter': 'displayName eq "Nobody"'})
    assert r.status_code == 400 and r.json()['scimType'] == 'invalidFilter'
