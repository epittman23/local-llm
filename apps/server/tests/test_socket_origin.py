"""Socket.IO accepts the page's own origin as well as the configured ones (#297).

`make backend` lists only loopback origins in CORS_ALLOW_ORIGIN, so with
LLLM_BACKEND_HOST=0.0.0.0 a page opened from the LAN had every socket refused.
These are real engine.io handshakes, over both transports.

Run from apps/server:

    python -m pytest tests/test_socket_origin.py
"""

from __future__ import annotations

import pytest
import socketio
from starlette.testclient import TestClient

from local_llm.socket.main import socket_cors_origins

MAKEFILE_ORIGINS = ['http://localhost:4000', 'http://127.0.0.1:4000', 'http://localhost:5174', 'http://127.0.0.1:5174']
LAN = '192.168.1.20:4000'


def _client(configured):
    sio = socketio.AsyncServer(async_mode='asgi', cors_allowed_origins=socket_cors_origins(configured))
    return TestClient(socketio.ASGIApp(sio), base_url=f'http://{LAN}')


def _polling(client, origin, host=LAN):
    return client.get('/socket.io/?EIO=4&transport=polling', headers={'Origin': origin, 'Host': host})


def _websocket_opens(client, origin, host=LAN) -> bool:
    try:
        with client.websocket_connect(
            '/socket.io/?EIO=4&transport=websocket',
            # A browser's upgrade request; the test client's scope carries no Upgrade header.
            headers={'Origin': origin, 'Host': host, 'Upgrade': 'websocket', 'Connection': 'Upgrade'},
        ) as ws:
            return ws.receive_text().startswith('0{')
    except Exception:
        return False


@pytest.mark.parametrize('scheme', ['http', 'https'])
def test_a_lan_page_reaches_its_own_socket(scheme):
    client = _client(MAKEFILE_ORIGINS)
    r = _polling(client, f'{scheme}://{LAN}')
    assert r.status_code == 200 and r.text.startswith('0{'), r.text
    assert _websocket_opens(client, f'{scheme}://{LAN}')


def test_the_configured_origins_still_pass():
    client = _client(MAKEFILE_ORIGINS)
    assert _polling(client, 'http://localhost:5174').status_code == 200
    assert _websocket_opens(client, 'http://localhost:5174')


@pytest.mark.parametrize(
    'origin, host',
    [
        ('http://evil.example:4000', LAN),  # another site
        ('http://192.168.1.20:4001', LAN),  # another port on the same machine
        ('http://192.168.1.20:4000', f'{LAN},evil.example'),  # two Host headers
        ('null', LAN),  # sandboxed frame or file:// page
        ('file://', LAN),
    ],
)
def test_other_origins_are_refused(origin, host):
    client = _client(MAKEFILE_ORIGINS)
    r = _polling(client, origin, host)
    assert r.status_code == 400 and 'not an accepted origin' in r.text, r.text
    assert not _websocket_opens(client, origin, host)


def test_forwarded_headers_do_not_make_an_origin_same_origin():
    client = _client(MAKEFILE_ORIGINS)
    r = client.get(
        '/socket.io/?EIO=4&transport=polling',
        headers={'Origin': 'http://evil.example', 'Host': LAN, 'X-Forwarded-Host': 'evil.example'},
    )
    assert r.status_code == 400


def test_a_wildcard_is_passed_through():
    assert socket_cors_origins(['*']) == '*'


def test_the_check_never_raises():
    check = socket_cors_origins(MAKEFILE_ORIGINS)
    assert check(None, None) is False
    assert check('http://[::1', {'HTTP_HOST': '[::1'}) is False
    assert check('http://localhost:4000') is True
