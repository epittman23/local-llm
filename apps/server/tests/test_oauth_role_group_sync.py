"""OAuth role and group sync: a present claim is authoritative, and the allowed-roles gate always runs.

Run from apps/server:

    python -m pytest tests/test_oauth_role_group_sync.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.utils import oauth
from local_llm.utils.oauth import read_claim_values


@pytest.mark.parametrize(
    'data, expected',
    [
        ({'roles': ['a', 'b']}, (True, ['a', 'b'])),
        ({'roles': []}, (True, [])),
        ({}, (False, [])),
        ({'realm': {'roles': ['x']}}, (True, ['x'])),
        ({'roles': 'a,b'}, (True, ['a', 'b'])),
    ],
)
def test_read_claim_values(data, expected):
    claim = 'realm.roles' if 'realm' in data else 'roles'
    assert read_claim_values(data, claim, ',') == expected


def _config(allowed, admin):
    return SimpleNamespace(
        ENABLE_OAUTH_ROLE_MANAGEMENT=True,
        OAUTH_ROLES_CLAIM='roles',
        OAUTH_ALLOWED_ROLES=allowed,
        OAUTH_ADMIN_ROLES=admin,
        DEFAULT_USER_ROLE='pending',
    )


def _role(monkeypatch, cfg, user, user_data):
    async def runtime():
        return cfg

    async def num_users():
        return 5

    monkeypatch.setattr(oauth, 'get_oauth_runtime_config', runtime)
    monkeypatch.setattr(oauth.Users, 'get_num_users', num_users)
    return asyncio.run(oauth.OAuthManager(app=None).get_user_role(user, user_data))


ADMIN = SimpleNamespace(id='a', role='admin')
USER = SimpleNamespace(id='u', role='user')


def test_allowed_roles_gate_runs_without_admin_roles(monkeypatch):
    with pytest.raises(HTTPException) as exc:
        _role(monkeypatch, _config(['staff'], []), None, {'roles': ['intern']})
    assert exc.value.status_code == 403
    assert _role(monkeypatch, _config(['staff'], []), None, {'roles': ['staff']}) == 'user'


def test_an_empty_roles_claim_revokes_admin(monkeypatch):
    assert _role(monkeypatch, _config(['*'], ['admins']), ADMIN, {'roles': []}) == 'user'


def test_a_missing_claim_fails_a_configured_gate(monkeypatch):
    with pytest.raises(HTTPException):
        _role(monkeypatch, _config(['staff'], ['admins']), USER, {})


def test_a_missing_claim_without_a_gate_changes_nothing(monkeypatch):
    assert _role(monkeypatch, _config(['*'], ['admins']), ADMIN, {}) == 'admin'


def test_admin_status_is_untouched_when_no_admin_roles_are_configured(monkeypatch):
    assert _role(monkeypatch, _config(['staff'], []), ADMIN, {'roles': ['staff']}) == 'admin'


def test_admin_role_promotes(monkeypatch):
    assert _role(monkeypatch, _config(['staff'], ['admins']), USER, {'roles': ['admins']}) == 'admin'


def test_an_empty_groups_claim_removes_memberships(monkeypatch):
    removed = []
    group = SimpleNamespace(id='g1', name='engineering', description='', permissions={'x': 1})

    async def runtime():
        return SimpleNamespace(
            OAUTH_GROUPS_CLAIM='groups', OAUTH_BLOCKED_GROUPS='[]', ENABLE_OAUTH_GROUP_CREATION=False
        )

    async def current(user_id, db=None):
        return [group]

    async def all_groups(db=None):
        return [group]

    async def remove(group_id, user_ids, db=None):
        removed.append(group_id)
        return False

    async def update(**_k):
        return None

    monkeypatch.setattr(oauth, 'get_oauth_runtime_config', runtime)
    monkeypatch.setattr(oauth.Groups, 'get_groups_by_member_id', current)
    monkeypatch.setattr(oauth.Groups, 'get_all_groups', all_groups)
    monkeypatch.setattr(oauth.Groups, 'remove_users_from_group', remove)
    monkeypatch.setattr(oauth.Groups, 'update_group_by_id', update)
    manager = oauth.OAuthManager(app=None)

    asyncio.run(manager.update_user_groups(None, USER, {}, {}))
    assert removed == []  # claim missing: nothing changes
    asyncio.run(manager.update_user_groups(None, USER, {'groups': []}, {}))
    assert removed == ['g1']  # claim present and empty: membership revoked
