"""The Playground's parameters, sent under `params`, reach the provider as the chat page's do (#208).

The Playground spread its parameters at the top level of the request. The
backend only reads `form_data['params']`: from it, `apply_params_to_form_data`
sets the provider's parameters, decodes `custom_params`, and leaves out this
app's own settings. Spread at the top level, a custom parameter went upstream
as an unknown nested `custom_params` field, and settings such as
`function_calling` reached the provider raw. These tests take the body the
Playground now sends (`playgroundModel.ts`'s `chatRequest`).

Run from apps/server:

    python -m pytest tests/test_playground_request_params.py
"""

from local_llm.utils.payload import apply_params_to_form_data

OPENAI_MODEL = {'id': 'm', 'owned_by': 'openai'}


def _playground_body(params):
    return {'model': 'm', 'stream': True, 'messages': [{'role': 'user', 'content': 'Hi'}], 'params': params}


def test_provider_parameters_are_applied_and_app_settings_left_out():
    payload = apply_params_to_form_data(
        _playground_body({'temperature': 0.2, 'function_calling': 'native', 'reasoning_tags': ['<t>', '</t>']}),
        OPENAI_MODEL,
    )

    assert payload['temperature'] == 0.2
    for key in ('params', 'function_calling', 'reasoning_tags', 'custom_params'):
        assert key not in payload


def test_custom_parameters_are_applied_decoded():
    payload = apply_params_to_form_data(
        _playground_body({'custom_params': {'top_k': '40', 'reasoning': '{"effort": "low"}'}}), OPENAI_MODEL
    )

    assert payload['top_k'] == 40
    assert payload['reasoning'] == {'effort': 'low'}
    assert 'custom_params' not in payload


def test_the_request_body_keeps_its_own_fields():
    payload = apply_params_to_form_data(_playground_body({'stream': False, 'temperature': 0.5}), OPENAI_MODEL)

    # A parameter never overwrites what the body already sets.
    assert payload['stream'] is True
    assert payload['messages'] == [{'role': 'user', 'content': 'Hi'}]


def test_an_ollama_model_gets_them_as_options():
    payload = apply_params_to_form_data(
        _playground_body({'temperature': 0.2, 'custom_params': {'num_ctx': '8192'}}),
        {'id': 'm', 'owned_by': 'ollama'},
    )

    assert payload['options'] == {'temperature': 0.2, 'num_ctx': 8192}
