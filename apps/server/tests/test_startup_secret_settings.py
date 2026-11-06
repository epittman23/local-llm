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


@pytest.mark.parametrize('expiry', ['4w', '1d12h', '-1', '0', '1d 12h', '30min', '1week'])
def test_a_usable_jwt_expiry_starts(tmp_path, expiry):
    # The last three are forms the admin settings refuse, but sign-in reads them
    # (with parse_duration), so a deployment that set one keeps starting.
    started = _import('local_llm.config', tmp_path, JWT_EXPIRES_IN=expiry)

    assert started.returncode == 0, started.stderr[-2000:]


# --- The same checks, read directly ------------------------------------------------


@pytest.mark.parametrize(
    ('secret', 'says'),
    [('short', 'is 5 bytes'), ('x' * 31, 'is 31 bytes'), (f' {GOOD_SECRET}', 'whitespace'), ('é' * 15, 'is 30 bytes')],
)
def test_secret_key_problem_says_why(secret, says):
    from local_llm.env import secret_key_problem

    problem = secret_key_problem(secret)

    assert problem and says in problem
    assert secret.strip() not in problem


def test_secret_key_problem_accepts_32_bytes_or_more():
    from local_llm.env import secret_key_problem

    assert secret_key_problem('A' * 32) is None
    assert secret_key_problem(GOOD_SECRET) is None


def test_jwt_expiry_startup_error_names_the_variable_and_value():
    from local_llm.utils.misc import jwt_expiry_startup_error

    assert jwt_expiry_startup_error('4w') is None
    assert jwt_expiry_startup_error('-1') is None
    assert jwt_expiry_startup_error('1d 12h') is None
    assert jwt_expiry_startup_error('20s') is not None  # under a minute: every session would expire at once
    assert jwt_expiry_startup_error('100000000w') is not None  # past any date sign-in can add it to
    problem = jwt_expiry_startup_error('4 weeks')
    assert problem and problem.startswith("JWT_EXPIRES_IN='4 weeks' cannot be used.")
