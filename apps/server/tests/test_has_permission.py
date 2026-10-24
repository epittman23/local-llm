"""has_permission's default permissions (ruff B006).

It once defaulted default_permissions to a shared `{}` and filled that, and
any dict a caller passed (often the live config), with
DEFAULT_USER_PERMISSIONS in place. It now fills a copy.

Run from apps/server:

    python -m pytest tests/test_has_permission.py
"""

from __future__ import annotations

import asyncio
import copy

import pytest

from local_llm.config import DEFAULT_USER_PERMISSIONS
from local_llm.utils import access_control


@pytest.fixture
def no_groups(monkeypatch):
    async def none(*_a, **_k):
        return []

    monkeypatch.setattr(access_control.Groups, 'get_groups_by_member_id', none)


def test_has_permission_leaves_the_callers_defaults_alone(no_groups):
    defaults = {'chat': {'controls': True}}
    before = copy.deepcopy(defaults)

    assert asyncio.run(access_control.has_permission('u1', 'chat.controls', defaults)) is True

    assert defaults == before


def test_has_permission_falls_back_to_the_built_in_defaults(no_groups):
    snapshot = copy.deepcopy(DEFAULT_USER_PERMISSIONS)
    key = next(f'{group}.{name}' for group, perms in snapshot.items() if isinstance(perms, dict) for name in perms)
    group, name = key.split('.')

    first = asyncio.run(access_control.has_permission('u1', key))
    # A second call gets the same answer: nothing it filled in was kept.
    second = asyncio.run(access_control.has_permission('u1', key))

    assert first is second is bool(snapshot[group][name])
    assert DEFAULT_USER_PERMISSIONS == snapshot


def test_has_permission_denies_a_key_nowhere_defined(no_groups):
    assert asyncio.run(access_control.has_permission('u1', 'no_such_group.no_such_key', {})) is False
