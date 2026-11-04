"""Sending the same time zone again writes and announces nothing (#324).

The browser now sends its zone on every load, not only at sign-in. The
route wrote it and published a `user.updated` event each time, so every
page load told webhooks and event functions the user had changed.

Run from apps/server:

    python -m pytest tests/test_update_timezone_unchanged.py
"""

import asyncio
from types import SimpleNamespace

from local_llm.routers import auths as auths_router


def _update(monkeypatch, stored, sent):
    calls: list[str] = []

    async def update(user_id, values, db=None):
        calls.append(f'update {values["timezone"]}')

    async def publish(*_a, **_k):
        calls.append('event')

    monkeypatch.setattr(auths_router.Users, 'update_user_by_id', update)
    monkeypatch.setattr(auths_router, 'publish_event', publish)
    result = asyncio.run(
        auths_router.update_timezone(
            None,
            auths_router.UpdateTimezoneForm(timezone=sent),
            session_user=SimpleNamespace(id='u1', timezone=stored),
            db=None,
        )
    )
    return result, calls


def test_the_same_zone_again_changes_nothing(monkeypatch):
    assert _update(monkeypatch, 'Europe/Paris', 'Europe/Paris') == ({'status': True}, [])


def test_a_new_zone_is_written_and_announced(monkeypatch):
    assert _update(monkeypatch, 'Europe/Paris', 'America/Chicago') == (
        {'status': True},
        ['update America/Chicago', 'event'],
    )
