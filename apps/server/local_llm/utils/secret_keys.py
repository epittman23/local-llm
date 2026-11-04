"""One Fernet key from a configured secret, the same way everywhere (#287)."""

import base64
import hashlib

from cryptography.fernet import Fernet


def fernet_from_secret(secret: str) -> Fernet:
    """A Fernet for `secret`: the secret itself when it is a Fernet key, else one derived from it.

    A Fernet key is 32 bytes, url-safe base64-encoded, so 44 characters. Any
    other secret is hashed with SHA-256 into one. The length alone used to
    decide, so a 44-character secret that is not a Fernet key (a 44-character
    passphrase, or `openssl rand -hex 22`) raised at import and the backend
    could not start; it is now hashed like any other. A real Fernet key is
    used exactly as before, so what it encrypted still decrypts.
    """
    if len(secret) == 44:
        try:
            return Fernet(secret.encode())
        except ValueError:
            pass
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest()))
