"""The rules in utils/access_control that decide who may read, write or share what.

Pins, with every database lookup faked so each rule is seen on its own:

- group permissions combine by OR, a missing permission denies, and the
  configured defaults fill in what a group leaves out;
- an in-memory grant list (`has_access`) is private when empty, matches the
  permission exactly, and admits a user by id, by the public wildcard or by
  group;
- a server connection with no grants is admin-only;
- legacy `access_control` dicts become the equivalent grant list;
- `filter_allowed_access_grants` drops each kind of grant the sharer lacks
  the permission for (test_sharing_permissions.py covers sharing.<x>);
- a model is readable only through ownership or a grant at every hop of its
  base-model chain, and an unregistered model is admin-only.

Run from apps/server:

    python -m pytest tests/test_access_control_rules.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import local_llm.config as config_module
from local_llm.models import access_grants as grants_model
from local_llm.models import models as models_model
from local_llm.utils import access_control
from local_llm.utils.access_control import (
    check_model_access,
    fill_missing_permissions,
    filter_allowed_access_grants,
    get_permissions,
    has_access,
    has_base_model_access,
    has_connection_access,
    has_permission,
    migrate_access_control,
)

ADMIN = SimpleNamespace(id='admin', role='admin')
ALICE = SimpleNamespace(id='alice', role='user')
PENDING = SimpleNamespace(id='pending', role='pending')

USER_READ = {'principal_type': 'user', 'principal_id': 'alice', 'permission': 'read'}
GROUP_READ = {'principal_type': 'group', 'principal_id': 'g-eng', 'permission': 'read'}
PUBLIC_READ = {'principal_type': 'user', 'principal_id': '*', 'permission': 'read'}
PUBLIC_WRITE = {'principal_type': 'user', 'principal_id': '*', 'permission': 'write'}
ANYONE_READ = {'principal_type': 'anyone', 'principal_id': '*', 'permission': 'read'}


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def groups(monkeypatch):
    """Group memberships by user id; a test fills it in."""
    by_user: dict[str, list] = {}

    async def get_groups_by_member_id(user_id, db=None):
        return by_user.get(user_id, [])

    monkeypatch.setattr(access_control.Groups, 'get_groups_by_member_id', get_groups_by_member_id)
    return by_user


def _group(id, permissions=None):
    return SimpleNamespace(id=id, permissions=permissions)


# --- permissions -----------------------------------------------------------


def test_fill_missing_permissions_keeps_set_values_and_adds_missing_ones():
    filled = fill_missing_permissions(
        {'chat': {'share': False}}, {'chat': {'share': True, 'export': True}, 'features': {'notes': True}}
    )
    assert filled == {'chat': {'share': False, 'export': True}, 'features': {'notes': True}}


def test_group_permissions_combine_by_granting_whichever_group_allows(groups):
    groups['alice'] = [
        _group('g1', {'chat': {'share': False, 'export': True}}),
        _group('g2', {'chat': {'share': True}, 'features': {'api_keys': True}}),
        _group('g3', None),
    ]
    defaults = {'chat': {'share': False, 'export': False, 'delete': True}, 'features': {'api_keys': False}}
    perms = _run(get_permissions('alice', defaults))
    assert perms == {'chat': {'share': True, 'export': True, 'delete': True}, 'features': {'api_keys': True}}
    # The defaults handed in are not changed by the merge.
    assert defaults['chat']['share'] is False and defaults['features']['api_keys'] is False


def test_without_groups_the_defaults_apply(groups):
    defaults = {'chat': {'share': False}}
    assert _run(get_permissions('nobody', defaults)) == {'chat': {'share': False}}


def test_has_permission_allows_through_any_group(groups):
    groups['alice'] = [_group('g1', {'features': {'api_keys': False}}), _group('g2', {'features': {'api_keys': True}})]
    assert _run(has_permission('alice', 'features.api_keys', {'features': {'api_keys': False}}))


def test_has_permission_falls_back_to_the_configured_default(groups):
    groups['alice'] = [_group('g1', {'features': {'api_keys': False}})]
    assert not _run(has_permission('alice', 'features.api_keys', {'features': {'api_keys': False}}))
    assert _run(has_permission('alice', 'features.api_keys', {'features': {'api_keys': True}}))


def test_an_unknown_permission_is_denied(groups):
    groups['alice'] = [_group('g1', {'features': {'api_keys': True}})]
    assert not _run(has_permission('alice', 'features.no_such_switch', {'features': {'api_keys': True}}))
    assert not _run(has_permission('alice', 'nothing.here.at_all', {}))


# --- in-memory grant lists ---------------------------------------------------


@pytest.mark.parametrize('grants', [None, []])
def test_no_grants_means_private(grants):
    assert not _run(has_access('alice', 'read', grants, user_group_ids=set()))


def test_a_grant_matches_its_permission_only():
    write_only = [{'principal_type': 'user', 'principal_id': 'alice', 'permission': 'write'}]
    assert not _run(has_access('alice', 'read', write_only, user_group_ids=set()))
    assert _run(has_access('alice', 'write', write_only, user_group_ids=set()))


def test_a_user_grant_admits_that_user_only():
    assert _run(has_access('alice', 'read', [USER_READ], user_group_ids=set()))
    assert not _run(has_access('mallory', 'read', [USER_READ], user_group_ids=set()))


def test_the_public_wildcard_admits_everyone():
    assert _run(has_access('mallory', 'read', [PUBLIC_READ], user_group_ids=set()))


def test_a_group_grant_admits_its_members_only(groups):
    groups['alice'] = [_group('g-eng')]
    assert _run(has_access('alice', 'read', [GROUP_READ]))
    assert not _run(has_access('mallory', 'read', [GROUP_READ]))
    assert not _run(has_access('alice', 'read', [GROUP_READ], user_group_ids={'g-sales'}))


def test_malformed_grants_admit_nobody():
    junk = ['user:*', None, {'principal_type': 'anyone', 'principal_id': '*', 'permission': 'read'}]
    assert not _run(has_access('alice', 'read', junk, user_group_ids={'g-eng'}))


@pytest.fixture
def bypass(monkeypatch):
    def set_bypass(value: bool):
        monkeypatch.setattr(config_module, 'BYPASS_ADMIN_ACCESS_CONTROL', value)

    return set_bypass


def test_a_connection_without_grants_is_admin_only(groups, bypass):
    bypass(False)
    for connection in ({}, {'config': None}, {'config': {'access_grants': []}}):
        assert _run(has_connection_access(ADMIN, connection))
        assert not _run(has_connection_access(ALICE, connection))


def test_a_connection_with_grants_admits_only_its_grantees(groups, bypass):
    bypass(False)
    connection = {'config': {'access_grants': [GROUP_READ]}}
    groups['alice'] = [_group('g-eng')]
    assert _run(has_connection_access(ALICE, connection))
    assert not _run(has_connection_access(SimpleNamespace(id='mallory', role='user'), connection))
    # Without the bypass an admin is held to the grants too.
    assert not _run(has_connection_access(ADMIN, connection))


def test_the_admin_bypass_opens_every_connection(groups, bypass):
    bypass(True)
    assert _run(has_connection_access(ADMIN, {'config': {'access_grants': [USER_READ]}}))
    assert not _run(has_connection_access(SimpleNamespace(id='mallory', role='user'), {'config': {}}))


# --- legacy access_control dicts --------------------------------------------


def test_legacy_access_control_becomes_grants():
    data = {
        'access_control': {
            'read': {'group_ids': ['g1'], 'user_ids': ['u1']},
            'write': {'group_ids': [], 'user_ids': ['u2']},
        }
    }
    migrate_access_control(data)
    assert 'access_control' not in data
    assert data['access_grants'] == [
        {'principal_type': 'group', 'principal_id': 'g1', 'permission': 'read'},
        {'principal_type': 'user', 'principal_id': 'u1', 'permission': 'read'},
        {'principal_type': 'user', 'principal_id': 'u2', 'permission': 'write'},
    ]


def test_a_legacy_null_access_control_becomes_private():
    # A null access_control converts to no grants: private, never public.
    data = {'access_control': None}
    migrate_access_control(data)
    assert data == {'access_grants': []}


def test_migration_leaves_existing_grants_and_absent_keys_alone():
    data = {'access_grants': [USER_READ], 'access_control': {'read': {'user_ids': ['mallory']}}}
    migrate_access_control(data)
    assert data['access_grants'] == [USER_READ]
    untouched = {'name': 'x'}
    migrate_access_control(untouched)
    assert untouched == {'name': 'x'}


# --- filtering what a sharer may grant --------------------------------------


def _sharing_perms(**overrides):
    perms = {
        'sharing': {'public_notes': False, 'open_chats': False, 'public_chats': False},
        'access_grants': {'allow_users': True, 'allow_groups': True},
    }
    for key, value in overrides.items():
        section, name = key.split('__')
        perms[section][name] = value
    return perms


def _filter(perms, grants, role='user', public_key='sharing.public_chats', anyone_key=None):
    return _run(filter_allowed_access_grants(perms, 'alice', role, grants, public_key, anyone_key))


def test_empty_grants_pass_through(groups):
    assert _filter(_sharing_perms(), []) == []
    assert _filter(_sharing_perms(), None) is None


def test_public_grants_need_the_public_permission(groups):
    grants = [PUBLIC_READ, PUBLIC_WRITE, USER_READ]
    assert _filter(_sharing_perms(), grants) == [USER_READ]
    assert _filter(_sharing_perms(sharing__public_chats=True), grants) == grants


def test_anyone_grants_need_their_own_permission(groups):
    perms = _sharing_perms(sharing__public_chats=True)
    assert _filter(perms, [ANYONE_READ, PUBLIC_READ], anyone_key='sharing.open_chats') == [PUBLIC_READ]
    perms = _sharing_perms(sharing__public_chats=True, sharing__open_chats=True)
    assert _filter(perms, [ANYONE_READ], anyone_key='sharing.open_chats') == [ANYONE_READ]


def test_anyone_grants_are_dropped_where_the_resource_has_no_anyone_switch(groups):
    # Even for an admin: without an anyone key the resource cannot be opened to the unauthenticated.
    assert _filter(_sharing_perms(), [ANYONE_READ], role='admin') == []


def test_an_admin_may_open_a_resource_to_anyone(groups):
    assert _filter(_sharing_perms(), [ANYONE_READ, PUBLIC_READ], role='admin', anyone_key='sharing.open_chats') == [
        ANYONE_READ,
        PUBLIC_READ,
    ]


def test_user_and_group_grants_need_their_switches(groups):
    grants = [USER_READ, GROUP_READ]
    assert _filter(_sharing_perms(access_grants__allow_users=False), grants) == [GROUP_READ]
    assert _filter(_sharing_perms(access_grants__allow_groups=False), grants) == [USER_READ]


def test_a_group_can_lend_a_sharing_permission(groups):
    groups['alice'] = [_group('g1', {'sharing': {'public_chats': True}})]
    assert _filter(_sharing_perms(), [PUBLIC_READ]) == [PUBLIC_READ]


# --- model access -----------------------------------------------------------


@pytest.fixture
def model_world(monkeypatch, groups):
    """Registered models by id, and (user, model) read grants."""
    models: dict[str, SimpleNamespace] = {}
    grants: set[tuple[str, str]] = set()

    async def get_model_by_id(model_id, db=None):
        return models.get(model_id)

    async def has_grant(user_id, resource_type, resource_id, permission='read', user_group_ids=None, db=None):
        assert resource_type == 'model' and permission == 'read'
        return (user_id, resource_id) in grants

    monkeypatch.setattr(models_model.Models, 'get_model_by_id', get_model_by_id)
    monkeypatch.setattr(grants_model.AccessGrants, 'has_access', has_grant)
    return models, grants


def _model(id, owner='owner', base=None):
    return SimpleNamespace(id=id, user_id=owner, base_model_id=base)


def test_a_model_without_a_base_needs_no_chain_check(model_world):
    assert _run(has_base_model_access('alice', _model('m'), user_role='user'))


def test_every_hop_of_the_base_chain_must_be_readable(model_world):
    models, grants = model_world
    models['base'] = _model('base', base='root')
    models['root'] = _model('root')
    preset = _model('preset', owner='alice', base='base')
    grants.add(('alice', 'base'))
    assert not _run(has_base_model_access('alice', preset, user_role='user'))
    grants.add(('alice', 'root'))
    assert _run(has_base_model_access('alice', preset, user_role='user'))


def test_an_owned_base_counts_as_readable(model_world):
    models, _ = model_world
    models['mine'] = _model('mine', owner='alice')
    assert _run(has_base_model_access('alice', _model('preset', base='mine'), user_role='user'))


def test_an_unregistered_base_is_admin_only(model_world):
    preset = _model('preset', base='raw-provider-model')
    assert not _run(has_base_model_access('alice', preset, user_role='user'))
    assert _run(has_base_model_access('admin', preset, user_role='admin'))


def test_a_base_chain_loop_ends(model_world):
    models, grants = model_world
    models['a'] = _model('a', base='b')
    models['b'] = _model('b', base='a')
    grants.update({('alice', 'a'), ('alice', 'b')})
    assert _run(has_base_model_access('alice', _model('a', base='b'), user_role='user'))


def _check(user, model, **kw):
    try:
        _run(check_model_access(user, model, **kw))
    except HTTPException as exc:
        assert exc.status_code == 403
        return False
    return True


def test_check_model_access_matrix(model_world):
    models, grants = model_world
    model = _model('m', owner='owner')
    assert _check(ADMIN, model)
    assert _check(SimpleNamespace(id='owner', role='user'), model)
    assert not _check(ALICE, model)
    assert not _check(PENDING, model)
    grants.add(('alice', 'm'))
    assert _check(ALICE, model)
    # The bypass is for internal callers only, and skips every check.
    assert _check(SimpleNamespace(id='mallory', role='user'), model, bypass_filter=True)


def test_a_readable_preset_does_not_open_its_base(model_world):
    models, grants = model_world
    models['secret-base'] = _model('secret-base', owner='admin')
    preset = _model('preset', owner='owner', base='secret-base')
    grants.add(('alice', 'preset'))
    assert not _check(ALICE, preset)
    grants.add(('alice', 'secret-base'))
    assert _check(ALICE, preset)


def test_an_unregistered_model_is_admin_only(model_world):
    assert _check(ADMIN, None)
    assert not _check(ALICE, None)
