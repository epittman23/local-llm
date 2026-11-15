"""External profile image URLs are not redirected to unless forwarding is enabled.

Run from apps/server:

    python -m pytest tests/test_profile_image_forwarding.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm import env
from local_llm.routers import users as users_router


def test_forwarding_is_off_by_default(monkeypatch):
    monkeypatch.delenv('ENABLE_PROFILE_IMAGE_URL_FORWARDING', raising=False)
    assert env.os.getenv('ENABLE_PROFILE_IMAGE_URL_FORWARDING', 'False').lower() != 'true'
    assert env.ENABLE_PROFILE_IMAGE_URL_FORWARDING is False


def test_an_external_url_is_not_followed_but_treated_as_no_picture(monkeypatch):
    async def get_user_by_id(_id):
        return SimpleNamespace(profile_image_url='https://tracker.example/pixel.png')

    monkeypatch.setattr(users_router.Users, 'get_user_by_id', get_user_by_id)
    monkeypatch.setattr(users_router, 'ENABLE_PROFILE_IMAGE_URL_FORWARDING', False)
    # No redirect to the external host: a 404, so the frontend draws the initials (decision D1, 2026-11-14).
    with pytest.raises(HTTPException) as raised:
        asyncio.run(users_router.get_user_profile_image_by_id('u1', user=SimpleNamespace(id='viewer')))
    assert raised.value.status_code == 404
    assert 'location' not in {k.lower() for k in (raised.value.headers or {})}
