"""Service detection by parsed hostname, not substring (CodeQL py/incomplete-url-substring-sanitization)."""

import pytest

from local_llm.utils.anthropic import is_anthropic_url
from local_llm.utils.misc import url_host_matches


@pytest.mark.parametrize(
    'url,expected',
    [
        ('https://api.openai.com/v1', True),
        ('https://API.OpenAI.com./v1', True),
        ('https://eu.api.openai.com/v1', True),
        ('https://api.openai.com.evil.example/v1', False),
        ('https://evil.example/?u=https://api.openai.com', False),
        ('https://evil.example/api.openai.com', False),
        ('https://notapi.openai.com.example/', False),
        ('not a url', False),
        ('', False),
    ],
)
def test_url_host_matches(url, expected):
    assert url_host_matches(url, 'api.openai.com') is expected


def test_scheme_is_checked_when_given():
    assert url_host_matches('https://hooks.slack.com/services/x', 'hooks.slack.com', scheme='https')
    assert not url_host_matches('http://hooks.slack.com/services/x', 'hooks.slack.com', scheme='https')


def test_anthropic_detection():
    assert is_anthropic_url('https://api.anthropic.com/v1')
    assert not is_anthropic_url('https://proxy.example/v1?upstream=api.anthropic.com')


class _FakeResponse:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def text(self):
        return 'ok'

    def raise_for_status(self):
        pass


class _FakeSession:
    def __init__(self, sent):
        self.sent = sent

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def post(self, url, json=None, **kwargs):
        self.sent.append((url, json))
        return _FakeResponse()


@pytest.mark.parametrize(
    'url,shape',
    [
        ('https://hooks.slack.com/services/T/B/X', 'text'),
        ('https://chat.googleapis.com/v1/spaces/x/messages', 'text'),
        ('https://discord.com/api/webhooks/1/abc', 'content'),
        ('https://acme.webhook.office.com/webhookb2/x', 'card'),
        # Substring look-alikes get the generic payload, not a service's format.
        ('https://evil.example/hooks.slack.com', 'raw'),
        ('https://evil.example/?u=https://discord.com/api/webhooks', 'raw'),
    ],
)
def test_webhook_payload_follows_the_real_host(monkeypatch, url, shape):
    import asyncio

    from local_llm.utils import webhook

    sent = []
    monkeypatch.setattr(webhook, 'validate_url', lambda u: True)
    monkeypatch.setattr(webhook, 'get_ssrf_safe_session', lambda: _FakeSession(sent))
    assert asyncio.run(webhook.post_webhook('WebUI', url, 'hello', {'event': 'x', 'user': {'name': 'a'}}))
    payload = sent[0][1]
    expected = {
        'text': lambda p: p == {'text': webhook._event_text('hello', None, {'event': 'x', 'user': {'name': 'a'}})},
        'content': lambda p: set(p) == {'content'},
        'card': lambda p: p.get('@type') == 'MessageCard',
        'raw': lambda p: p == {'event': 'x', 'user': {'name': 'a'}},
    }[shape]
    assert expected(payload), payload
