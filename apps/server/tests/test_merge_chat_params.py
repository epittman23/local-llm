"""A cleared chat parameter ("") is not sent upstream as a value (#200).

Chat controls stored "" for a number box cleared back to Default. The web
client now leaves such parameters out, but chat rows saved before that
still hold "", and the tool-approval resume builds its request from the
stored params, so _merge_chat_params drops "" as it drops None.

Run from apps/server:

    python -m pytest tests/test_merge_chat_params.py
"""

import asyncio
from types import SimpleNamespace

from local_llm import main


def test_an_empty_request_param_is_dropped_and_the_models_value_kept(monkeypatch):
    async def no_defaults(key, default=None):
        return {}

    monkeypatch.setattr(main.Config, 'get', no_defaults)
    model = SimpleNamespace(params=SimpleNamespace(model_dump=lambda: {'temperature': 0.2}))
    form = {'params': {'temperature': '', 'seed': 7, 'top_p': None, 'presence_penalty': 0}}

    asyncio.run(main._merge_chat_params(form, model))

    assert form['params'] == {'temperature': 0.2, 'seed': 7, 'presence_penalty': 0}
