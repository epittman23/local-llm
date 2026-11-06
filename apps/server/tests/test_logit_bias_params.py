"""A logit_bias from Advanced Params reaches the request as the object the API expects (#616).

`apply_params_to_form_data` (utils/payload.py) copied every parameter into
the request body before reaching its logit_bias conversion, which was
guarded by `'logit_bias' not in form_data` and so never ran: the raw text
(`123:5, 456:-10`) went on. The OpenAI router converts a text logit_bias
again before sending it upstream, so a provider got the object all the
same; but a pipe function's model, and any inlet filter, read the body
before the router and got the text. The conversion now runs here.

An empty value ('' or {}) is now left out where it was copied before, so a
model's own logit_bias applies instead of being hidden by it.

Run from apps/server:

    python -m pytest tests/test_logit_bias_params.py
"""

import logging

import pytest

from local_llm.utils.payload import apply_params_to_form_data

OPENAI_MODEL = {'id': 'm', 'owned_by': 'openai'}


def _apply(params, **body):
    return apply_params_to_form_data({'model': 'm', **body, 'params': params}, OPENAI_MODEL)


def test_the_text_form_becomes_an_object_of_token_ids_to_biases():
    assert _apply({'logit_bias': '123:5, 456:-10'})['logit_bias'] == {'123': 5, '456': -10}


def test_a_bias_beyond_100_is_clamped_as_before():
    assert _apply({'logit_bias': '1:500, 2:-500'})['logit_bias'] == {'1': 100, '2': -100}


def test_the_object_form_is_kept_as_an_object():
    assert _apply({'logit_bias': {'123': 5}})['logit_bias'] == {'123': 5}


@pytest.mark.parametrize('value', ['123', 'a:b', '123:1.5', 42, ['1:2']])
def test_an_unreadable_value_is_passed_on_as_given_with_a_warning(caplog, value):
    # So the OpenAI router refuses it with its own message, as it did before.
    with caplog.at_level(logging.WARNING, logger='local_llm.utils.payload'):
        payload = _apply({'logit_bias': value})

    assert payload['logit_bias'] == value
    assert 'logit_bias' in caplog.text


def test_the_request_bodys_own_logit_bias_is_kept():
    assert _apply({'logit_bias': '1:5'}, logit_bias={'9': 1})['logit_bias'] == {'9': 1}


@pytest.mark.parametrize('value', ['', None, {}])
def test_an_empty_logit_bias_is_left_out(value):
    assert 'logit_bias' not in _apply({'logit_bias': value})


def test_the_other_parameters_are_still_copied():
    payload = _apply({'logit_bias': '1:5', 'temperature': 0.3})

    assert payload['temperature'] == 0.3
    assert payload['logit_bias'] == {'1': 5}
