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


def test_rows_built_the_way_the_model_list_builds_them(visible):
    # The rule depends on a workspace row's info carrying the row's id, so
    # build the list as get_all_models does: base models, then workspace rows
    # (an override and a preset), then the default metadata.
    from local_llm.models.models import ModelMeta, ModelModel, ModelParams

    def row(id, user_id, base_model_id=None):
        return ModelModel(
            id=id,
            user_id=user_id,
            base_model_id=base_model_id,
            name=id,
            params=ModelParams(),
            meta=ModelMeta(),
            is_active=True,
            updated_at=0,
            created_at=0,
        )

    base = [
        {'id': 'provider-model', 'name': 'p', 'owned_by': 'openai'},
        {'id': 'mine', 'name': 'm', 'owned_by': 'openai'},
    ]
    models = models_util._apply_workspace_models(
        base, [row('mine', USER.id), row('shared', 'someone', base_model_id='provider-model')]
    )
    models_util._apply_default_metadata(models, {'capabilities': {'vision': True}})
    assert [model['info']['meta']['capabilities'] for model in models] == [{'vision': True}] * 3

    async def run(user):
        return [model['id'] for model in await models_util.get_filtered_models(models, user)]

    assert asyncio.run(run(ADMIN)) == ['provider-model', 'shared']
    assert asyncio.run(run(USER)) == ['mine', 'shared']
