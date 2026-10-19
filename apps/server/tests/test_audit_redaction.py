"""The audit log never records credentials.

Run from apps/server:

    python -m pytest tests/test_audit_redaction.py
"""

from __future__ import annotations

import json

import pytest

from local_llm.utils.audit import REDACTED, is_sensitive_key, redact_body

# Assembled at runtime so secret scanners do not mistake the test value for a key.
SECRET = '-'.join(['canary', 'value', '42'])


@pytest.mark.parametrize(
    'body',
    [
        {'email': 'a@b.c', 'password': SECRET},
        {'password': 'x', 'new_password': SECRET},
        {'password': 'has "quotes" in it ' + SECRET},
        {'OPENAI_API_KEYS': [SECRET, SECRET], 'OPENAI_API_BASE_URLS': ['https://openrouter.ai/api/v1']},
        {'token': SECRET, 'token_type': 'Bearer', 'name': 'Ann'},
        {'api_key': SECRET},
        {'config': {'client_secret': SECRET, 'nested': [{'key': SECRET}]}},
    ],
)
def test_json_bodies_lose_every_sensitive_value(body):
    out = redact_body(json.dumps(body))
    assert SECRET not in out
    assert REDACTED in out


def test_non_sensitive_values_survive():
    out = json.loads(redact_body(json.dumps({'email': 'a@b.c', 'name': 'Ann', 'password': 'x'})))
    assert out == {'email': 'a@b.c', 'name': 'Ann', 'password': REDACTED}


def test_a_truncated_body_is_still_redacted():
    # Cut by the body size limit before the value's closing quote.
    text = json.dumps({'email': 'a@b.c', 'password': SECRET + 'x' * 5000})[:300]
    out = redact_body(text)
    assert SECRET not in out and REDACTED in out
    assert 'a@b.c' in out


def test_a_truncated_body_with_an_escaped_quote_is_still_redacted():
    text = '{"new_password": "ab\\"cd' + SECRET
    assert SECRET not in redact_body(text)


def test_form_encoded_bodies():
    out = redact_body(f'username=ann&password={SECRET}&remember=1')
    assert SECRET not in out and 'username=ann' in out and 'remember=1' in out


@pytest.mark.parametrize(
    'key', ['password', 'new_password', 'token', 'api_key', 'OPENAI_API_KEYS', 'key', 'client_secret']
)
def test_sensitive_keys(key):
    assert is_sensitive_key(key)


@pytest.mark.parametrize('key', ['email', 'name', 'model', 'keyboard_shortcut', 'monkey'])
def test_ordinary_keys(key):
    assert not is_sensitive_key(key)
