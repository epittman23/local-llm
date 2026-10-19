"""HSTS and Permissions-Policy accept their standard spellings.

Run from apps/server:

    python -m pytest tests/test_security_headers.py
"""

from __future__ import annotations

import pytest

from local_llm.utils.security_headers import HSTS_FALLBACK, set_hsts, set_permissions_policy


@pytest.mark.parametrize(
    'value',
    [
        'max-age=63072000; includeSubDomains; preload',
        'max-age=63072000;includeSubDomains;preload',
        'max-age=300',
        'MAX-AGE=600; INCLUDESUBDOMAINS',
    ],
)
def test_hsts_keeps_valid_values(value):
    assert set_hsts(value) == {'Strict-Transport-Security': value}


def test_hsts_falls_back_on_garbage(caplog):
    assert set_hsts('forever') == {'Strict-Transport-Security': HSTS_FALLBACK}
    assert 'not a valid Strict-Transport-Security' in caplog.text


@pytest.mark.parametrize(
    'value, sent',
    [
        ('camera=(), microphone=()', 'camera=(), microphone=()'),
        ('camera=(),microphone=(self)', 'camera=(), microphone=(self)'),
        ('geolocation=(self "https://maps.example")', 'geolocation=(self "https://maps.example")'),
        ('browsing-topics=()', 'browsing-topics=()'),
        ('fullscreen=*', 'fullscreen=*'),
    ],
)
def test_permissions_policy_keeps_valid_values(value, sent):
    assert set_permissions_policy(value) == {'Permissions-Policy': sent}


@pytest.mark.parametrize('value', ['none', 'camera', 'camera=(evil', 'camera=(), ,'])
def test_permissions_policy_omits_an_invalid_value(value, caplog):
    assert set_permissions_policy(value) == {}
    assert 'not a valid Permissions-Policy' in caplog.text
