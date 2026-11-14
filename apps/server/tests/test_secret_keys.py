"""A 44-character secret that is not a Fernet key no longer stops the backend (#287).

The OAuth session store, the OAuth client-info encryption and valve
encryption each turned a configured secret into a Fernet key the same way:
a secret of exactly 44 characters was taken to be a Fernet key and used
as-is, and anything else was hashed with SHA-256. So a 44-character secret
that is not one (a passphrase, or `openssl rand -hex 22`) raised
"Fernet key must be 32 url-safe base64-encoded bytes" at import, and the
backend could not start. `fernet_from_secret` now tries the secret as a
Fernet key and hashes it when it is not one. A real Fernet key, and any
other secret, gives exactly the key it gave before, so stored data still
decrypts.

Run from apps/server:

    python -m pytest tests/test_secret_keys.py
"""

from __future__ import annotations

import base64
import hashlib

import pytest
from cryptography.fernet import Fernet

from local_llm.models import oauth_sessions
from local_llm.utils import valves
from local_llm.utils.secret_keys import fernet_from_secret


def _hashed(secret: str) -> Fernet:
    """The key the old code derived for a secret that was not 44 characters long."""
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest()))


NOT_FERNET_44 = [
    'a' * 44,
    '0123456789abcdef0123456789abcdef0123456789ab',
    'correct horse battery staple, said the admin',
]


@pytest.mark.parametrize('secret', NOT_FERNET_44)
def test_a_44_character_secret_that_is_not_a_fernet_key_is_hashed(secret):
    assert len(secret) == 44
    with pytest.raises(ValueError):
        Fernet(secret.encode())

    token = fernet_from_secret(secret).encrypt(b'x')

    assert _hashed(secret).decrypt(token) == b'x'


@pytest.mark.parametrize(
    'key',
    [
        Fernet.generate_key().decode(),
        # `openssl rand -base64 32`: the standard alphabet, which Fernet accepts too.
        base64.b64encode(bytes(range(200, 232))).decode(),
    ],
    # Fixed ids: a generated key differs per process, and pytest-xdist needs
    # every worker to collect the same test ids.
    ids=['generated', 'standard-alphabet'],
)
def test_a_real_fernet_key_is_used_as_it_is(key):
    assert len(key) == 44

    token = fernet_from_secret(key).encrypt(b'x')

    assert Fernet(key.encode()).decrypt(token) == b'x'


@pytest.mark.parametrize('secret', ['short', 'x' * 43, 'x' * 45, 'test-only-not-a-secret-' + '0' * 40])
def test_any_other_secret_is_hashed_as_before(secret):
    token = _hashed(secret).encrypt(b'x')

    assert fernet_from_secret(secret).decrypt(token) == b'x'


def test_the_oauth_session_store_starts_with_such_a_secret(monkeypatch):
    monkeypatch.setattr(oauth_sessions, 'OAUTH_SESSION_TOKEN_ENCRYPTION_KEY', 'a' * 44)

    table = oauth_sessions.OAuthSessionTable()

    assert _hashed('a' * 44).decrypt(table.fernet.encrypt(b'x')) == b'x'


def test_valve_encryption_works_with_such_a_secret(monkeypatch):
    monkeypatch.setattr(valves, 'LLLM_SECRET_KEY', 'a' * 44)
    valves._fernet.cache_clear()
    try:
        assert _hashed('a' * 44).decrypt(valves._fernet().encrypt(b'x')) == b'x'
    finally:
        valves._fernet.cache_clear()
