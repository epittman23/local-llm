"""A preset the caller cannot run is not listed to them (#835).

`get_filtered_models` listed a workspace preset shared with a member even when
its base model has no `model` row, which `check_model_access` (through
`has_base_model_access`) refuses for a non-admin with "Model not found". The
listing now walks the same base chain, so the list and the chat check agree.

Run from apps/server:

    python -m pytest tests/test_listed_presets_are_runnable.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from local_llm.models import models as models_table
from local_llm.utils import models as models_util

ADMIN = SimpleNamespace(id='admin-1', role='admin')
USER = SimpleNamespace(id='user-1', role='user')

# id -> (owner, base_model_id); 'orphan-base' has no row.
ROWS = {
    'open-base': ('someone', None),
    'closed-base': ('someone', None),
    'preset-on-open': ('someone', 'open-base'),
    'preset-on-closed': ('someone', 'closed-base'),
    'preset-on-orphan': ('someone', 'orphan-base'),
}
GRANTED = {'open-base', 'preset-on-open', 'preset-on-closed', 'preset-on-orphan'}


def _models():
    return [
        {'id': id, 'info': {'id': id, 'user_id': owner, 'base_model_id': base, 'meta': {}}}
        for id, (owner, base) in ROWS.items()
    ]


@pytest.fixture
def world(monkeypatch):
    async def groups(user_id, db=None):
        return []

    async def accessible(user_id, resource_type, resource_ids, permission, user_group_ids, db=None):
        return GRANTED & set(resource_ids)

    async def has_grant(user_id, resource_type, resource_id, permission='read', user_group_ids=None, db=None):
        return resource_id in GRANTED

    async def get_model_by_id(model_id, db=None):
        if model_id not in ROWS:
            return None
        owner, base = ROWS[model_id]
        return SimpleNamespace(id=model_id, user_id=owner, base_model_id=base)

    monkeypatch.setattr(models_util.Groups, 'get_groups_by_member_id', groups)
    monkeypatch.setattr(models_util.AccessGrants, 'get_accessible_resource_ids', accessible)
    monkeypatch.setattr(models_util.AccessGrants, 'has_access', has_grant)
    monkeypatch.setattr(models_util.Models, 'get_model_by_id', get_model_by_id)
    monkeypatch.setattr(models_table.Models, 'get_model_by_id', get_model_by_id)
    from local_llm.models.access_grants import AccessGrants

    monkeypatch.setattr(AccessGrants, 'has_access', has_grant)
    monkeypatch.setattr(models_util, 'BYPASS_ADMIN_ACCESS_CONTROL', False)
    monkeypatch.setattr(models_util, 'BYPASS_MODEL_ACCESS_CONTROL', False)


def _listed(user):
    return [m['id'] for m in asyncio.run(models_util.get_filtered_models(_models(), user))]


def _allowed(user, model):
    try:
        asyncio.run(models_util.check_model_access(user, model))
    except Exception as exc:
        assert str(exc) == 'Model not found'
        return False
    return True


def test_a_member_is_not_listed_a_preset_on_a_base_with_no_row(world):
    listed = _listed(USER)

    assert 'preset-on-orphan' not in listed
    assert not _allowed(USER, _models()[4])


def test_a_member_is_listed_a_preset_on_a_base_they_may_use(world):
    assert 'preset-on-open' in _listed(USER)
    assert _allowed(USER, _models()[2])


def test_a_member_is_not_listed_a_preset_on_a_base_they_may_not_use(world):
    assert 'preset-on-closed' not in _listed(USER)


def test_the_list_matches_the_chat_check(world):
    assert _listed(USER) == [m['id'] for m in _models() if _allowed(USER, m)]


def test_an_admin_sees_the_preset_on_a_base_with_no_row(world):
    assert 'preset-on-orphan' in _listed(ADMIN)
    assert 'preset-on-open' in _listed(ADMIN)
