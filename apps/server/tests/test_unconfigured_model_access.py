"""Default model metadata does not make a model "configured" for access control (#272).

`get_filtered_models` treats a model with a workspace row as configured
(shown to its owner and to whoever it is shared with) and one without as
unconfigured (shown to admins only). It decided that by `info` being truthy.
But the admin's default model metadata gives every model without a row
`info = {'meta': ...}`, so with defaults set and BYPASS_ADMIN_ACCESS_CONTROL
off, an admin lost every provider model that had no workspace row: it looked
configured, had no owner and was shared with nobody. "Configured" now means
that `info` is the model's workspace row, which carries the model's id.

Run from apps/server:

    python -m pytest tests/test_unconfigured_model_access.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from local_llm.utils import models as models_util

ADMIN = SimpleNamespace(id='admin-1', role='admin')
USER = SimpleNamespace(id='user-1', role='user')


def _models():
    return [
        # A provider model with no workspace row, given only the default metadata.
        {'id': 'provider-model', 'info': {'meta': {'capabilities': {'vision': True}}}},
        # A provider model with no workspace row and no defaults.
        {'id': 'bare-model'},
        # A workspace model owned by the user.
        {'id': 'mine', 'info': {'id': 'mine', 'user_id': USER.id, 'meta': {}}},
        # A workspace model owned by someone else and shared with nobody.
        {'id': 'private', 'info': {'id': 'private', 'user_id': 'someone', 'meta': {}}},
        # A workspace model shared with the user.
        {'id': 'shared', 'info': {'id': 'shared', 'user_id': 'someone', 'meta': {}}},
    ]


@pytest.fixture
def visible(monkeypatch):
    asked = []

    async def groups(user_id, db=None):
        return []

    async def accessible(user_id, resource_type, resource_ids, permission, user_group_ids, db=None):
        asked.append(sorted(resource_ids))
        return {'shared'} & set(resource_ids)

    monkeypatch.setattr(models_util.Groups, 'get_groups_by_member_id', groups)
    monkeypatch.setattr(models_util.AccessGrants, 'get_accessible_resource_ids', accessible)
    monkeypatch.setattr(models_util, 'BYPASS_ADMIN_ACCESS_CONTROL', False)
    monkeypatch.setattr(models_util, 'BYPASS_MODEL_ACCESS_CONTROL', False)

    def run(user):
        return [model['id'] for model in asyncio.run(models_util.get_filtered_models(_models(), user))], asked

    return run


def test_an_admin_sees_unconfigured_models_even_with_default_metadata(visible):
    ids, asked = visible(ADMIN)

    assert ids == ['provider-model', 'bare-model', 'shared']
    # Only workspace models are looked up as access-controlled resources.
    assert asked == [['mine', 'private', 'shared']]


def test_a_user_sees_only_their_own_and_shared_models(visible):
    ids, _ = visible(USER)

    assert ids == ['mine', 'shared']
