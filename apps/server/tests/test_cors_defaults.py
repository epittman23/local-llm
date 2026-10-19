"""CORS: no cross-origin grant by default, and never credentials with '*'.

Run from apps/server:

    python -m pytest tests/test_cors_defaults.py
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from local_llm import config
from local_llm.socket import main as socket_main


def _client(origins: list[str]) -> TestClient:
    # The same arguments main.py passes.
    app = FastAPI()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=bool(origins) and origins != ['*'],
        allow_methods=['*'],
        allow_headers=['*'],
    )

    @app.get('/api/x')
    def x():
        return {'ok': True}

    return TestClient(app)


def test_the_default_grants_no_origin(monkeypatch):
    monkeypatch.delenv('CORS_ALLOW_ORIGIN', raising=False)
    assert config.cors_origins('') == []
    assert config.CORS_ALLOW_ORIGIN == []
    r = _client([]).get('/api/x', headers={'Origin': 'http://localhost:9999'}, cookies={'token': 't'})
    assert not [h for h in r.headers if h.lower().startswith('access-control-')]


def test_listed_origins_get_credentialed_access_and_others_do_not():
    client = _client(config.cors_origins('http://localhost:5174; http://127.0.0.1:5174'))
    ok = client.get('/api/x', headers={'Origin': 'http://localhost:5174'})
    assert ok.headers['access-control-allow-origin'] == 'http://localhost:5174'
    assert ok.headers['access-control-allow-credentials'] == 'true'
    other = client.get('/api/x', headers={'Origin': 'http://evil.localhost:1'})
    assert 'access-control-allow-origin' not in other.headers


def test_a_wildcard_never_reflects_an_origin_with_credentials():
    r = _client(['*']).get('/api/x', headers={'Origin': 'http://evil.localhost:1'}, cookies={'token': 't'})
    assert r.headers['access-control-allow-origin'] == '*'
    assert 'access-control-allow-credentials' not in r.headers


def test_socketio_stays_same_origin_by_default():
    # A same-origin check, never [] (which python-socketio reads as no check).
    check = socket_main.socket_cors_origins([])
    assert check('http://lan-host:4000', {'HTTP_HOST': 'lan-host:4000'})
    assert not check('http://evil.localhost:1', {'HTTP_HOST': 'lan-host:4000'})
