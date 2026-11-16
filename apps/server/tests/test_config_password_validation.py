"""/api/config tells a signed-in client the server's password rule (S5-D8, #1103).

Add User could not see ENABLE_PASSWORD_VALIDATION, so it accepted any
password and only the server's 400 said otherwise. The authenticated part
of `features` now carries `enable_password_validation` and
`password_validation_hint` (additive fields). A visitor who is not signed in
does not get them, like the rest of that block.

The handler is called directly with the user lookup and stored config
stubbed, as tests/test_admin_chat_access.py does.

Run from apps/server:

    python -m pytest tests/test_config_password_validation.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from local_llm import main

USER = SimpleNamespace(id='u1', role='admin')


@pytest.fixture(autouse=True)
def stored(monkeypatch):
    async def get_many(*keys):
        return {}

    async def get_user_by_id(user_id):
        return USER if user_id == 'u1' else None

    async def has_users():
        return True

    monkeypatch.setattr(main.Config, 'get_many', get_many)
    monkeypatch.setattr(main.Users, 'get_user_by_id', get_user_by_id)
    monkeypatch.setattr(main.Users, 'has_users', has_users)
    monkeypatch.setattr(main, 'decode_token', lambda token: {'id': 'u1'})


def _request(token: str | None):
    headers = {'Authorization': f'Bearer {token}'} if token else {}
    return SimpleNamespace(headers=headers, cookies={})


def test_a_signed_in_client_gets_the_rule(monkeypatch):
    monkeypatch.setattr(main, 'ENABLE_PASSWORD_VALIDATION', True)
    monkeypatch.setattr(main, 'PASSWORD_VALIDATION_HINT', 'At least 12 characters.')

    features = asyncio.run(main.get_app_config(_request('t')))['features']

    assert features['enable_password_validation'] is True
    assert features['password_validation_hint'] == 'At least 12 characters.'


def test_the_rule_reads_off_by_default(monkeypatch):
    monkeypatch.setattr(main, 'ENABLE_PASSWORD_VALIDATION', False)
    monkeypatch.setattr(main, 'PASSWORD_VALIDATION_HINT', '')

    features = asyncio.run(main.get_app_config(_request('t')))['features']

    assert features['enable_password_validation'] is False
    assert features['password_validation_hint'] == ''


def test_a_visitor_does_not_get_it():
    features = asyncio.run(main.get_app_config(_request(None)))['features']

    assert 'enable_password_validation' not in features
    assert 'password_validation_hint' not in features
