"""Each column of a multi-model chat runs with its own model's settings (#359).

chat_completion merged only the first model's workspace params into the
request, and the fan-out shallow-copied that request for every model, so each
later column ran with the first model's temperature, max_tokens, system
prompt and stream settings, all sharing one params dict that the first
column's pipeline then popped `system` and `custom_params` from. Each column
now gets its own copy of the request, merged with its own model's params;
params set on the chat itself still apply to every column, over each model's
own.

This drives chat_completion through test_chat_completion's harness (its
world of fake models and pipeline) without touching its golden file.

Run from apps/server (any LLLM_SECRET_KEY of 32 characters or more):

    LLLM_SECRET_KEY=... python -m pytest tests/test_fan_out_params.py
"""

import copy

from test_chat_completion import FOLLOW_UP, _run

from local_llm import main

TWO_MODELS = {
    **FOLLOW_UP,
    'model': 'm1',
    'message_ids': [{'model_id': 'm1', 'message_id': 'a1'}, {'model_id': 'm2', 'message_id': 'a2'}],
}

WORKSPACE = {
    'model_infos': {
        'm1': {
            'params': {
                'temperature': 0.2,
                'max_tokens': 512,
                'system': 'You are A.',
                'stream_response': True,
                'stream_delta_chunk_size': 4,
            }
        },
        'm2': {
            'params': {
                'temperature': 0.7,
                'max_tokens': 2048,
                'system': 'You are B.',
                'stream_response': False,
                'function_calling': 'legacy',
            }
        },
    }
}


def _payloads(observed: dict) -> dict[str, dict]:
    """The form data each answering model's pipeline received, by model id."""
    return {call[2]: call[1] for call in observed['calls'] if call[0] == 'process_chat_payload'}


def test_each_column_runs_with_its_own_models_params_and_system_prompt(monkeypatch):
    payloads = _payloads(_run(TWO_MODELS, WORKSPACE, monkeypatch))

    assert payloads['m1']['params'] == {
        'temperature': 0.2,
        'max_tokens': 512,
        'system': 'You are A.',
        'stream_response': True,
        'stream_delta_chunk_size': 4,
    }
    assert payloads['m2']['params'] == {
        'temperature': 0.7,
        'max_tokens': 2048,
        'system': 'You are B.',
        'stream_response': False,
        'function_calling': 'legacy',
    }


def test_each_column_streams_by_its_own_model(monkeypatch):
    payloads = _payloads(_run(TWO_MODELS, WORKSPACE, monkeypatch))

    # m1 streams and reports usage (its capability); m2 is set not to stream.
    assert payloads['m1']['stream'] is True
    assert payloads['m1']['stream_options'] == {'include_usage': True}
    assert payloads['m2']['stream'] is False
    assert 'stream_options' not in payloads['m2']
    assert payloads['m1']['metadata']['params']['stream_delta_chunk_size'] == 4
    assert payloads['m1']['metadata']['params']['function_calling'] == 'native'
    assert payloads['m2']['metadata']['params']['stream_delta_chunk_size'] is None
    assert payloads['m2']['metadata']['params']['function_calling'] == 'legacy'


def test_chat_level_params_apply_to_every_column_over_each_models_own(monkeypatch):
    form = {**TWO_MODELS, 'params': {'temperature': 1.1, 'seed': 7}}

    payloads = _payloads(_run(form, WORKSPACE, monkeypatch))

    for model_id, max_tokens, system in (('m1', 512, 'You are A.'), ('m2', 2048, 'You are B.')):
        params = payloads[model_id]['params']
        assert params['temperature'] == 1.1
        assert params['seed'] == 7
        assert params['max_tokens'] == max_tokens
        assert params['system'] == system


def test_a_column_does_not_change_what_the_next_one_runs_with(monkeypatch):
    received = []

    async def process_chat(request, form_data, user, metadata, model, tasks=None):
        # What each model ran with, as it started; then what apply_params_to_form_data
        # does to the params it is handed, and a pipeline changing its metadata.
        received.append((form_data, metadata, copy.deepcopy(form_data['params']), dict(metadata['params'])))
        params = form_data.get('params') or {}
        params.pop('system', None)
        params.pop('custom_params', None)
        metadata['params']['function_calling'] = 'changed by the first column'
        return {'status': True}

    monkeypatch.setattr(main, '_process_chat', process_chat)
    form = {**TWO_MODELS, 'params': {'custom_params': {'top_a': 1}}, 'files': [{'id': 'f1'}], 'tool_ids': ['t1']}

    _run(form, WORKSPACE, monkeypatch)

    (first, first_metadata, _, _), (second, second_metadata, second_params, second_metadata_params) = received
    assert [first['model'], second['model']] == ['m1', 'm2']
    assert first['params'] is not second['params']
    assert first_metadata['params'] is not second_metadata['params']
    assert second_params['system'] == 'You are B.'
    assert second_params['custom_params'] == {'top_a': 1}
    assert second_metadata_params['function_calling'] == 'legacy'
    assert first['files'] is not second['files']
    # Within one model's request, what its form data and metadata share stays shared.
    for form_data, metadata, _, _ in received:
        assert form_data['files'] is metadata['files']
        assert form_data['tool_ids'] is metadata['tool_ids']
