"""Stored OAuth client redirect URIs never come from a client-chosen Host header.

Run from apps/server:

    python -m pytest tests/test_oauth_client_redirect.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.utils import oauth


def _request(base: str):
    from urllib.parse import urlsplit

    return SimpleNamespace(base_url=base + '/', url=SimpleNamespace(hostname=urlsplit(base).hostname))


@pytest.fixture
def webui_url(monkeypatch):
    value = {'url': ''}

    async def get(key):
        return value['url'] if key == 'webui.url' else None

    monkeypatch.setattr(oauth.Config, 'get', get)
    return value


def test_the_configured_app_url_wins(webui_url):
    webui_url['url'] = 'https://llm.home.example/'
    base = asyncio.run(oauth.stored_redirect_base_url(_request('http://attacker.example')))
    assert base == 'https://llm.home.example'


def test_a_forged_host_is_refused_without_an_app_url(webui_url):
    with pytest.raises(HTTPException) as exc:
        asyncio.run(oauth.stored_redirect_base_url(_request('http://attacker.example')))
    assert exc.value.status_code == 400


def test_loopback_is_accepted_without_an_app_url(webui_url):
    assert asyncio.run(oauth.stored_redirect_base_url(_request('http://localhost:4000'))) == 'http://localhost:4000'


def test_a_non_admin_cannot_trigger_re_registration(monkeypatch):
    from local_llm import main

    async def get_client(_id):
        return object()

    async def preflight(*_a):
        return False

    registered = []

    async def register(*_a):
        registered.append(True)
        return True

    monkeypatch.setattr(main.oauth_client_manager, 'get_client', get_client)
    monkeypatch.setattr(main.oauth_client_manager, 'get_client_info', get_client)
    monkeypatch.setattr(main.oauth_client_manager, '_preflight_authorization_url', preflight)
    monkeypatch.setattr(main, 'register_client', register)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            main.oauth_client_authorize('mcp:x', request=None, response=None, user=SimpleNamespace(id='u', role='user'))
        )
    assert exc.value.status_code == 409 and registered == []
