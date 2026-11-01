"""A scheduled run fired before the model list is loaded still gets the model's defaults (#265).

_resolve_model_defaults read app.state.MODELS, which is empty until a user
request loads the models (the startup prefetch is off by default) and is
cleared on connection changes, so an overdue run fired right after a
restart went out without the model's tools, filters and features.

Run from apps/server:

    python -m pytest tests/test_automation_model_defaults.py
"""

import asyncio
from types import SimpleNamespace

from local_llm.utils import automations
from local_llm.utils import models as models_util

MODEL = {
    'id': 'm1',
    'info': {'meta': {'toolIds': ['web_tool'], 'defaultFilterIds': ['f1'], 'terminalId': 't1'}},
}


def test_an_empty_model_list_is_loaded_before_reading_the_defaults(monkeypatch):
    app = SimpleNamespace(state=SimpleNamespace(MODELS={}))
    loaded = []

    async def get_all_models(request, refresh=False, user=None):
        loaded.append(user)
        request.app.state.MODELS = {'m1': MODEL}
        return [MODEL]

    monkeypatch.setattr(models_util, 'get_all_models', get_all_models)

    tool_ids, features, filter_ids, terminal_id = asyncio.run(
        automations._resolve_model_defaults(app, 'm1', user='owner', token='tok')
    )

    assert (tool_ids, features, filter_ids, terminal_id) == (['web_tool'], {}, ['f1'], 't1')
    assert loaded == ['owner']


def test_a_loaded_model_list_is_not_reloaded(monkeypatch):
    app = SimpleNamespace(state=SimpleNamespace(MODELS={'m1': MODEL}))

    async def must_not_run(*_a, **_k):
        raise AssertionError('reloaded')

    monkeypatch.setattr(models_util, 'get_all_models', must_not_run)

    assert asyncio.run(automations._resolve_model_defaults(app, 'm1'))[0] == ['web_tool']
