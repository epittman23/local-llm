"""Non-public sharing permissions (sharing.notes, sharing.models, ...) are enforced server-side.

Run from apps/server:

    python -m pytest tests/test_sharing_permissions.py
"""

from __future__ import annotations

import asyncio

import pytest

from local_llm.utils import access_control
from local_llm.utils.access_control import filter_allowed_access_grants

USER_GRANT = {'principal_type': 'user', 'principal_id': 'bob', 'permission': 'read'}
GROUP_GRANT = {'principal_type': 'group', 'principal_id': 'g1', 'permission': 'read'}
PUBLIC_GRANT = {'principal_type': 'user', 'principal_id': '*', 'permission': 'read'}


def _perms(*, share: bool, public: bool) -> dict:
    return {
        'sharing': {'notes': share, 'public_notes': public, 'folders': share},
        'access_grants': {'allow_users': True, 'allow_groups': True},
    }


@pytest.fixture(autouse=True)
def no_groups(monkeypatch):
    async def none(*_a, **_k):
        return []

    monkeypatch.setattr(access_control.Groups, 'get_groups_by_member_id', none)


def _filter(perms, grants, role='user', public_key='sharing.public_notes', **kw):
    return asyncio.run(filter_allowed_access_grants(perms, 'u1', role, grants, public_key, **kw))


def test_without_sharing_named_grants_are_dropped():
    out = _filter(_perms(share=False, public=True), [USER_GRANT, GROUP_GRANT, PUBLIC_GRANT])
    assert out == [PUBLIC_GRANT]


def test_with_sharing_named_grants_are_kept():
    out = _filter(_perms(share=True, public=False), [USER_GRANT, GROUP_GRANT, PUBLIC_GRANT])
    assert out == [USER_GRANT, GROUP_GRANT]


def test_admins_are_not_restricted():
    grants = [USER_GRANT, GROUP_GRANT]
    assert _filter(_perms(share=False, public=False), grants, role='admin') == grants


def test_an_explicit_key_covers_resources_without_a_public_twin():
    out = _filter(
        _perms(share=False, public=False), [USER_GRANT], public_key=None, sharing_permission_key='sharing.folders'
    )
    assert out == []


def test_resources_with_no_sharing_key_are_unaffected():
    # sharing.public_chats has no sharing.chats twin.
    assert _filter(_perms(share=False, public=False), [USER_GRANT], public_key='sharing.public_chats') == [USER_GRANT]
