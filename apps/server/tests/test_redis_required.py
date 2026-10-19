"""Redis is required, so sign-out and password changes actually revoke sessions.

Run from apps/server:

    python -m pytest tests/test_redis_required.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from local_llm import main
from local_llm.utils import auth


class FakeRedis:
    def __init__(self, up: bool = True):
        self.data: dict[str, str] = {}
        self.up = up

    async def ping(self):
        if not self.up:
            raise ConnectionError('connection refused')
        return True

    async def get(self, key):
        return self.data.get(key)

    async def set(self, key, value, ex=None):
        self.data[key] = value


def test_startup_refuses_without_redis():
    with pytest.raises(RuntimeError, match='REDIS_URL is not set'):
        asyncio.run(main.require_redis(None))


def test_startup_refuses_an_unreachable_redis():
    with pytest.raises(RuntimeError, match='not reachable'):
        asyncio.run(main.require_redis(FakeRedis(up=False), attempts=2, delay=0))


def test_a_reachable_redis_is_used():
    redis = FakeRedis()
    assert asyncio.run(main.require_redis(redis)) is redis


def test_signing_out_revokes_the_token(monkeypatch):
    redis = FakeRedis()
    token = SimpleNamespace(jti='j1', exp=4_102_444_800, id='u1', iat=1)
    monkeypatch.setattr(auth, 'decode_token', lambda _t: {'jti': token.jti, 'exp': token.exp})
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(redis=redis)))

    decoded = {'jti': 'j1', 'id': 'u1', 'iat': 1}
    assert asyncio.run(auth.is_valid_token(decoded, redis)) is True
    asyncio.run(auth.invalidate_token(request, 'token'))
    assert asyncio.run(auth.is_valid_token(decoded, redis)) is False
