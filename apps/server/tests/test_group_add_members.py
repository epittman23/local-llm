"""Adding several users to a group keeps every new member when one is already in it (#279).

`add_users_to_group` inserted one member at a time and flushed each. When one
was already a member, the unique violation's rollback undid the whole
transaction, earlier new members included, yet the group came back and the
route said all were added: adding alice, an existing member and bob left only
bob. It now inserts only the users not yet in the group, each once. SCIM's
replace (`set_group_user_ids_by_id`) had no de-duplication either, so a
repeated id failed the whole replace; it now keeps one of each.

Runs against the test run's migrated SQLite database.

Run from apps/server:

    python -m pytest tests/test_group_add_members.py
"""

import asyncio
import importlib
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from local_llm.models.groups import GroupForm, Groups, UserIdsForm
from local_llm.models.users import Users
from local_llm.routers import groups as groups_router

# Importing the config runs the migrations on the test run's database.
importlib.import_module('local_llm.config')


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def people():
    tag = uuid.uuid4().hex[:8]
    ids = {name: f'{name}-{tag}' for name in ('owner', 'alice', 'existing', 'bob', 'carol', 'dave')}
    for name, uid in ids.items():
        _run(Users.insert_new_user(uid, name, f'{uid}@example.invalid', role='user'))
    group = _run(Groups.insert_new_group(ids['owner'], GroupForm(name=f'g-{tag}', description='')))
    _run(Groups.add_users_to_group(group.id, [ids['existing']]))
    return group.id, ids


def _members(group_id):
    return sorted(_run(Groups.get_group_user_ids_by_id(group_id)))


def test_new_members_are_kept_beside_an_existing_one(people):
    group_id, ids = people

    group = _run(Groups.add_users_to_group(group_id, [ids['alice'], ids['existing'], ids['bob']]))

    assert group is not None
    assert _members(group_id) == sorted([ids['alice'], ids['existing'], ids['bob']])


def test_a_user_listed_twice_is_added_once(people):
    group_id, ids = people

    assert _run(Groups.add_users_to_group(group_id, [ids['alice'], ids['alice']])) is not None
    assert _members(group_id) == sorted([ids['alice'], ids['existing']])


def test_adding_only_existing_members_changes_nothing(people):
    group_id, ids = people

    assert _run(Groups.add_users_to_group(group_id, [ids['existing']])) is not None
    assert _members(group_id) == [ids['existing']]


def test_a_replace_with_a_repeated_id_keeps_one_of_each(people):
    group_id, ids = people

    _run(Groups.set_group_user_ids_by_id(group_id, [ids['alice'], ids['bob'], ids['alice']]))

    assert _members(group_id) == sorted([ids['alice'], ids['bob']])


def test_a_user_added_meanwhile_by_another_request_does_not_drop_the_rest(people, monkeypatch):
    group_id, ids = people
    real_commit = AsyncSession.commit
    raced = []

    async def commit_after_a_competing_add(self):
        # Another request adds dave between this call's read and its commit.
        if not raced:
            raced.append(True)
            await Groups.add_users_to_group(group_id, [ids['dave']])
        await real_commit(self)

    monkeypatch.setattr(AsyncSession, 'commit', commit_after_a_competing_add)

    group = _run(Groups.add_users_to_group(group_id, [ids['carol'], ids['dave']]))

    assert group is not None
    assert _members(group_id) == sorted([ids['carol'], ids['dave'], ids['existing']])


def test_the_route_announces_only_the_users_it_added(people, monkeypatch):
    group_id, ids = people
    published = []

    async def publish(request, event, **kwargs):
        published.append(kwargs['data'])

    monkeypatch.setattr(groups_router, 'publish_event', publish)
    admin = SimpleNamespace(id=ids['owner'], role='admin')

    def add(*user_ids):
        return _run(
            groups_router.add_user_to_group(
                request=None, id=group_id, form_data=UserIdsForm(user_ids=list(user_ids)), user=admin, db=None
            )
        )

    response = add(ids['alice'], ids['existing'], ids['alice'])
    assert response.member_count == 2
    assert published == [{'user_ids': [ids['alice']]}]

    add(ids['existing'])
    assert published == [{'user_ids': [ids['alice']]}]
