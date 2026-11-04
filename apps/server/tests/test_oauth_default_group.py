"""OAuth group sync does not take a user out of the default group (#275).

Sign-up adds every new user to the configured default group
(`ui.default_group_id`). With OAuth group management on, the same callback
then ran `update_user_groups`, which removed the user from every group the
IdP's groups claim did not list, the default group included, so a new user
never stayed in it (and nor did anyone else, at their next login). The
default group is the app's own, not the IdP's: the claim no longer removes
it. Other groups the claim does not list are still removed. The
trusted-header login had the same bug: its groups header goes through
`Groups.sync_groups_by_group_names`, which now keeps the groups it is told
to, and the login passes the default group.

Run from apps/server:

    python -m pytest tests/test_oauth_default_group.py
"""

from __future__ import annotations

import asyncio
import uuid
from types import SimpleNamespace

import pytest

from local_llm.models.groups import GroupForm, Groups
from local_llm.utils import oauth

USER = SimpleNamespace(id='u', role='user')
DEFAULT = SimpleNamespace(id='g-default', name='Everyone', description='', permissions={'x': 1})
ENGINEERING = SimpleNamespace(id='g-eng', name='engineering', description='', permissions={'x': 1})
STAFF = SimpleNamespace(id='g-staff', name='staff', description='', permissions={'x': 1})


@pytest.fixture
def sync(monkeypatch):
    """Runs the group sync for USER, a member of all three groups; returns the ids removed."""
    removed = []
    config = {'ui.default_group_id': DEFAULT.id}

    async def runtime():
        return SimpleNamespace(
            OAUTH_GROUPS_CLAIM='groups', OAUTH_BLOCKED_GROUPS='[]', ENABLE_OAUTH_GROUP_CREATION=False
        )

    async def config_get(key, default=None):
        return config.get(key, default)

    async def current(user_id, db=None):
        return [DEFAULT, ENGINEERING, STAFF]

    async def all_groups(db=None):
        return [DEFAULT, ENGINEERING, STAFF]

    async def remove(group_id, user_ids, db=None):
        removed.append(group_id)
        return True

    async def add(group_id, user_ids, db=None):
        return True

    async def update(**_k):
        return None

    async def publish(*_a, **_k):
        return None

    monkeypatch.setattr(oauth, 'get_oauth_runtime_config', runtime)
    monkeypatch.setattr(oauth.Config, 'get', config_get)
    monkeypatch.setattr(oauth.Groups, 'get_groups_by_member_id', current)
    monkeypatch.setattr(oauth.Groups, 'get_all_groups', all_groups)
    monkeypatch.setattr(oauth.Groups, 'remove_users_from_group', remove)
    monkeypatch.setattr(oauth.Groups, 'add_users_to_group', add)
    monkeypatch.setattr(oauth.Groups, 'update_group_by_id', update)
    monkeypatch.setattr(oauth, 'publish_event', publish)

    def run(claim, default_group_id=DEFAULT.id):
        config['ui.default_group_id'] = default_group_id
        removed.clear()
        asyncio.run(oauth.OAuthManager(app=None).update_user_groups(None, USER, {'groups': claim}, {}))
        return list(removed)

    return run


def test_the_default_group_is_kept_when_the_claim_does_not_list_it(sync):
    assert sync(['staff']) == ['g-eng']


def test_an_empty_claim_still_keeps_the_default_group(sync):
    assert sorted(sync([])) == ['g-eng', 'g-staff']


def test_without_a_default_group_every_unlisted_group_is_removed(sync):
    assert sorted(sync(['staff'], default_group_id='')) == ['g-default', 'g-eng']
    assert sorted(sync(['staff'], default_group_id=None)) == ['g-default', 'g-eng']


def test_a_claim_with_no_groups_key_reads_no_setting(sync, monkeypatch):
    read = []

    async def config_get(key, default=None):
        read.append(key)
        return default

    monkeypatch.setattr(oauth.Config, 'get', config_get)
    asyncio.run(oauth.OAuthManager(app=None).update_user_groups(None, USER, {}, {}))

    assert read == []


def _membership_after_header_sync(header_groups, keep):
    """Puts a fresh user in three fresh groups, syncs to the header's names, and returns what is left."""
    tag = uuid.uuid4().hex[:8]
    user_id = f'user-{tag}'

    async def run():
        ids = {}
        for name in ('Everyone', 'engineering', 'staff'):
            group = await Groups.insert_new_group('admin', GroupForm(name=f'{name}-{tag}', description=''))
            assert group is not None
            ids[name] = group.id
            await Groups.add_users_to_group(group.id, [user_id])
        await Groups.sync_groups_by_group_names(
            user_id, [f'{name}-{tag}' for name in header_groups], keep_group_ids=[ids[name] for name in keep]
        )
        left = {group.id for group in await Groups.get_groups_by_member_id(user_id)}
        return {name for name, group_id in ids.items() if group_id in left}

    return asyncio.run(run())


def test_the_trusted_groups_header_keeps_the_default_group():
    assert _membership_after_header_sync(['staff'], keep=['Everyone']) == {'Everyone', 'staff'}


def test_the_trusted_groups_header_still_removes_other_groups():
    assert _membership_after_header_sync(['staff'], keep=[]) == {'staff'}
