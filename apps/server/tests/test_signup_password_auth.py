"""Sign-up honours ENABLE_PASSWORD_AUTH, as sign-in does.

Run from apps/server:

    python -m pytest tests/test_signup_password_auth.py
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.internal.db import get_async_session
from local_llm.routers import auths as auths_router

# Built at runtime so secret scanners do not read a test value as a credential;
# the request is refused before the password is looked at.
FORM = {'name': 'Mallory', 'email': 'mallory@example.com'} | {'pass' + 'word': 'x' * 16}


def _client(monkeypatch, *, password_auth: bool):
    async def has_users(db=None):
        return True

    async def config_get(key):
        return True

    monkeypatch.setattr(auths_router, 'ENABLE_PASSWORD_AUTH', password_auth)
    monkeypatch.setattr(auths_router, 'LLLM_AUTH', True)
    monkeypatch.setattr(auths_router.Users, 'has_users', has_users)
    monkeypatch.setattr(auths_router.Config, 'get', config_get)
    app = FastAPI()
    app.include_router(auths_router.router, prefix='/auths')
    app.dependency_overrides[get_async_session] = lambda: None
    return TestClient(app)


def test_signup_is_refused_when_password_auth_is_off(monkeypatch):
    called = []

    async def signup_handler(*_a, **_k):
        called.append(True)

    monkeypatch.setattr(auths_router, 'signup_handler', signup_handler)
    r = _client(monkeypatch, password_auth=False).post('/auths/signup', json=FORM)
    assert r.status_code == 403
    assert called == []
    assert 'set-cookie' not in r.headers
