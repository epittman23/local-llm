"""Text parsed out of user-controlled input stays linear-time (CodeQL py/polynomial-redos).

Before these fixes, `{{chat.variables.x|` followed by 8,000 spaces in a system
prompt took about four minutes (cubic), and a chat message of 8,000 unclosed
`<$a|` skill mentions took two seconds (quadratic). Each case below now runs
in milliseconds; the bound is loose so a slow CI machine can't flake it.
"""

import time

import pytest

from local_llm.utils.chat_variables import collect_chat_variable_fields, render_user_variables
from local_llm.utils.middleware import extract_skill_ids_from_messages, strip_skill_mentions
from local_llm.utils.misc import validate_email_format
from local_llm.utils.plugin import extract_frontmatter

N = 50_000


def _fast(fn, *args):
    start = time.perf_counter()
    result = fn(*args)
    assert time.perf_counter() - start < 1.0
    return result


@pytest.mark.parametrize(
    'prompt',
    [
        '{{chat.variables.x|' + ' ' * N,
        '{{chat.variables.x|' * (N // 20),
        '{{ chat.variables.x ' + ' ' * N,
    ],
)
def test_chat_variables_are_linear_on_adversarial_prompts(prompt):
    assert _fast(collect_chat_variable_fields, prompt) == {}
    assert _fast(render_user_variables, prompt.replace('chat.', 'user.'), {}) is not None


def test_chat_variables_still_parse():
    fields = collect_chat_variable_fields(
        'Hi {{ chat.variables.tone | select:options=["a","b"] }} and {{chat.variables.name}}'
    )
    assert fields['tone']['type'] == 'select'
    assert fields['tone']['options'] == ['a', 'b']
    assert fields['name']['type'] == 'text'


def test_user_variables_still_render():
    assert render_user_variables('Hello {{ user.variables.city }}!', {'city': 'Oslo'}) == 'Hello Oslo!'


@pytest.mark.parametrize('text', ['<$a|' * N, '</a|' * N, '<$' + 'a' * N])
def test_skill_mentions_are_linear_on_adversarial_messages(text):
    messages = [{'role': 'user', 'content': text}]
    assert _fast(extract_skill_ids_from_messages, messages) == set()
    _fast(strip_skill_mentions, messages)


def test_skill_mentions_still_parse_and_strip():
    messages = [{'role': 'user', 'content': 'use <$web-search|Web Search> and </summarize|Summary> now'}]
    assert extract_skill_ids_from_messages(messages) == {'web-search', 'summarize'}
    strip_skill_mentions(messages)
    assert messages[0]['content'] == 'use Web Search and Summary now'


def test_frontmatter_values_are_stripped():
    content = '"""\ntitle:   My Tool   \nrequirements: requests, httpx\n"""\nclass Tools: pass\n'
    assert extract_frontmatter(content) == {'title': 'My Tool', 'requirements': 'requests, httpx'}


@pytest.mark.parametrize(
    'email,ok',
    [
        ('a@b.c', True),
        ('first.last@example.co.uk', True),
        ('a@b..', True),  # as the old regex: any dot with text on both sides
        ('a@.b', False),
        ('a@b.', False),
        ('a@b@c.d', False),
        ('@b.c', False),
        ('admin@localhost', True),
        ('a' * N + '@' + 'b' * N, False),
    ],
)
def test_email_format(email, ok):
    assert _fast(validate_email_format, email) is ok
