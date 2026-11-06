"""The sign-in settings read from the environment are checked when the backend starts (#508).

LLLM_SECRET_KEY was refused only when empty, and JWT_EXPIRES_IN not at
all, so a malformed value was found only when the first token was issued
or checked. Both are read at import, so each case imports the module in a
fresh interpreter and reads its exit.

Run from apps/server:

    python -m pytest tests/test_startup_secret_settings.py
"""

from __future__ import annotations

import os
import subprocess
import sys

import pytest

GOOD_SECRET = 'startup-test-only-0123456789abcdef0123456789'


def _import(module: str, tmp_path, **env: str) -> subprocess.CompletedProcess:
    environment = {
        **os.environ,
        'LLLM_SECRET_KEY': GOOD_SECRET,
        'DATA_DIR': str(tmp_path),
        'DATABASE_URL': f'sqlite:///{tmp_path}/startup.db',
        **env,
    }
    return subprocess.run(
        [sys.executable, '-c', f'import {module}'],
        env=environment,
        capture_output=True,
        text=True,
        timeout=120,
    )


@pytest.mark.parametrize(
    ('secret', 'says'),
    [
        ('short', 'at least 32'),
        ('x' * 31, 'at least 32'),
        (f' {GOOD_SECRET}', 'whitespace'),
        (f'{GOOD_SECRET}\n', 'whitespace'),
        (' ' * 40, 'whitespace'),
    ],
    ids=['short', '31_bytes', 'leading_space', 'trailing_newline', 'only_spaces'],
)
def test_a_secret_key_that_cannot_sign_sessions_stops_the_start(tmp_path, secret, says):
    started = _import('local_llm.env', tmp_path, LLLM_SECRET_KEY=secret)

    assert started.returncode != 0
    assert 'LLLM_SECRET_KEY' in started.stderr
    assert says in started.stderr
    # The message never repeats the secret itself.
    if secret.strip():
        assert secret.strip() not in started.stderr


def test_the_readmes_secret_length_starts(tmp_path):
    # `openssl rand -base64 24`, as the README says, gives 32 characters.
    started = _import('local_llm.env', tmp_path, LLLM_SECRET_KEY='A' * 32)

    assert started.returncode == 0, started.stderr


@pytest.mark.parametrize('expiry', ['4 weeks', '-5m', '30', 'soon'])
def test_a_jwt_expiry_that_cannot_be_used_stops_the_start(tmp_path, expiry):
    started = _import('local_llm.config', tmp_path, JWT_EXPIRES_IN=expiry)

    assert started.returncode != 0
    assert 'JWT_EXPIRES_IN' in started.stderr
    assert repr(expiry) in started.stderr


@pytest.mark.parametrize('expiry', ['4w', '1d12h', '-1', '0'])
def test_a_usable_jwt_expiry_starts(tmp_path, expiry):
    started = _import('local_llm.config', tmp_path, JWT_EXPIRES_IN=expiry)

    assert started.returncode == 0, started.stderr[-2000:]
