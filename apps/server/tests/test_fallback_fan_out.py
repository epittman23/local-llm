"""The custom-model fallback reaches the model a UI chat actually runs (#360).

With ENABLE_CUSTOM_MODEL_FALLBACK, chat_completion swapped a preset whose
base model is gone for the default model, but a UI chat (session and chat
ids, so the fan-out path) then set each answering copy back to the preset's
own id from message_ids, which still resolves, and the request failed with
"model not found". Only the legacy no-session path honoured the fallback.
The fan-out now runs the fallback; the stored chat still records the model
the user chose.

This drives chat_completion through test_chat_completion's harness (its
world of fake models and pipeline) without touching its golden file.

Run from apps/server (any LLLM_SECRET_KEY of 32 characters or more):

    LLLM_SECRET_KEY=... python -m pytest tests/test_fallback_fan_out.py
"""

from test_chat_completion import NEW_CHAT, _run

FALLBACK_ON = {'env': {'ENABLE_CUSTOM_MODEL_FALLBACK': True}, 'config': {'ui.default_models': 'fallback'}}


def _handled_models(observed: dict) -> list[str]:
    """The model each answering copy was sent to, in the order they ran."""
    return [call[1] for call in observed['calls'] if call[0] == 'chat_completion_handler']


def test_a_ui_chat_with_a_broken_preset_runs_the_fallback(monkeypatch):
    form = {**NEW_CHAT, 'model': 'custom', 'message_ids': [{'model_id': 'custom', 'message_id': 'a1'}]}

    observed = _run(form, FALLBACK_ON, monkeypatch)

    assert _handled_models(observed) == ['fallback']


def test_other_models_in_the_same_chat_are_left_alone(monkeypatch):
    form = {
        **NEW_CHAT,
        'model': 'custom',
        'message_ids': [{'model_id': 'custom', 'message_id': 'a1'}, {'model_id': 'm1', 'message_id': 'a2'}],
    }

    observed = _run(form, FALLBACK_ON, monkeypatch)

    assert _handled_models(observed) == ['fallback', 'm1']


def test_without_the_setting_a_broken_preset_still_fails(monkeypatch):
    form = {**NEW_CHAT, 'model': 'custom', 'message_ids': [{'model_id': 'custom', 'message_id': 'a1'}]}

    observed = _run(form, {}, monkeypatch)

    assert _handled_models(observed) == []
    assert observed.get('http_error', [None])[0] == 400
