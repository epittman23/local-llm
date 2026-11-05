"""The memory review prompt says a replace keeps its path when path is left out (#530).

Since #282, a replace without `path` keeps the memory's path, and `""` clears
it. The background review prompt still showed `"path":"..."` in its replace
example and said to leave path empty when there was no clear place, so a
model could send `""` on a replace and clear a path it meant to keep.

Run from apps/server:

    python -m pytest tests/test_memory_review_prompt_path.py
"""

from __future__ import annotations

import asyncio
import json

from local_llm.utils import chat as chat_utils
from local_llm.utils import memory


def _review_prompt(monkeypatch) -> str:
    sent = {}

    async def completion(_request, form_data, user=None, **_kwargs):
        sent['prompt'] = form_data['messages'][1]['content']
        return {'choices': [{'message': {'content': '{"operations": []}'}}]}

    monkeypatch.setattr(chat_utils, 'generate_chat_completion', completion)
    asyncio.run(
        memory._generate_memory_operations(
            request=None, user=None, model_id='m', metadata={}, existing_text='(none)', transcript='USER: hi'
        )
    )
    return sent['prompt']


def test_the_prompt_says_a_replace_keeps_its_path_when_path_is_left_out(monkeypatch):
    prompt = _review_prompt(monkeypatch)

    assert "On replace, leave path out to keep the memory's current path" in prompt
    assert 'an empty path clears it' in prompt


def test_the_replace_example_leaves_path_out(monkeypatch):
    prompt = _review_prompt(monkeypatch)
    replace = next(line for line in prompt.splitlines() if '"action":"replace"' in line)

    assert '"path"' not in replace
    assert json.loads(replace.strip().rstrip(','))['action'] == 'replace'
