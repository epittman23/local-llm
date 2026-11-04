"""One invalid chat variable blanks only itself in the system prompt (#172).

Rendering validated the chat's variables as a set and, on any error, used
none of them, with nothing logged, so a select value the model no longer
offers emptied every `{{chat.variables.*}}` in the prompt and the model ran
on a degraded prompt without anyone knowing. Each variable is now checked on
its own: an invalid one renders empty and is logged, and the rest render.

Run from apps/server:

    python -m pytest tests/test_chat_variables_render.py
"""

import logging

import pytest

from local_llm.utils.chat_variables import ChatVariablesError, render_chat_variables, validate_chat_variables

PROMPT = (
    'Name: {{chat.variables.name}}; '
    'Level: {{chat.variables.level | select:options=["a","b"]}}; '
    'Goal: {{chat.variables.goal | text:required}}'
)


def test_a_valid_set_renders_every_variable():
    rendered = render_chat_variables(PROMPT, {'name': 'Ada', 'level': 'a', 'goal': 'proofs'})

    assert rendered == 'Name: Ada; Level: a; Goal: proofs'


def test_an_option_the_model_no_longer_offers_blanks_only_its_own_variable(caplog):
    with caplog.at_level(logging.WARNING, logger='local_llm.utils.chat_variables'):
        rendered = render_chat_variables(PROMPT, {'name': 'Ada', 'level': 'c', 'goal': 'proofs'})

    assert rendered == 'Name: Ada; Level: ; Goal: proofs'
    assert 'level' in caplog.text


def test_a_missing_required_variable_blanks_only_itself():
    rendered = render_chat_variables(PROMPT, {'name': 'Ada', 'level': 'b'}, required=True)

    assert rendered == 'Name: Ada; Level: b; Goal: '


def test_a_value_too_long_blanks_only_itself():
    rendered = render_chat_variables(PROMPT, {'name': 'x' * 20_001, 'level': 'a', 'goal': 'proofs'})

    assert rendered == 'Name: ; Level: a; Goal: proofs'


def test_an_unusable_set_renders_none_and_says_so(caplog):
    with caplog.at_level(logging.WARNING, logger='local_llm.utils.chat_variables'):
        rendered = render_chat_variables(PROMPT, {'name': 'x' * 60_000, 'goal': 'y' * 60_000})

    assert rendered == 'Name: ; Level: ; Goal: '
    assert 'too large' in caplog.text


def test_validating_a_set_still_refuses_any_invalid_value():
    """Saving variables is still all or nothing."""
    with pytest.raises(ChatVariablesError, match='Invalid value'):
        validate_chat_variables(PROMPT, {'name': 'Ada', 'level': 'c', 'goal': 'proofs'})

    assert validate_chat_variables(PROMPT, {'name': 'Ada', 'level': 'a', 'goal': 'proofs'}) == {
        'name': 'Ada',
        'level': 'a',
        'goal': 'proofs',
    }
