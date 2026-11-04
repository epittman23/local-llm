"""A task model's JSON is read from its first object, so braces inside strings survive (#168).

The web search, image prompt and retrieval handlers took the JSON from the
reply's last `{`, so a generated query such as "python {set} comprehension
syntax" cut the object short, failed to parse, and the fallback then searched
for the cut fragment. They now read the first JSON object in the reply with
the JSON decoder.

Run from apps/server:

    python -m pytest tests/test_task_reply_json.py
"""

import asyncio
from types import SimpleNamespace

import pytest

from local_llm.utils import middleware


@pytest.mark.parametrize(
    ('text', 'expected'),
    [
        ('{"queries": ["python {set} comprehension syntax"]}', {'queries': ['python {set} comprehension syntax']}),
        ('Sure! {"queries": ["a"]} Hope that helps.', {'queries': ['a']}),
        ('{"queries": ["a"], "meta": {"n": 1}}', {'queries': ['a'], 'meta': {'n': 1}}),
        ('{"prompt": "a cat in a {box}"}', {'prompt': 'a cat in a {box}'}),
        ('```json\n{"queries": ["a } b"]}\n```', {'queries': ['a } b']}),
        # A stray brace before the object is skipped.
        ('Use {curly} braces: {"queries": ["x"]}', {'queries': ['x']}),
    ],
)
def test_the_first_json_object_is_read_whole(text, expected):
    assert middleware._first_json_object(text) == expected


@pytest.mark.parametrize('text', ['', 'no json here', '{not json', '["a"]', '{"a": 1'])
def test_no_json_object_is_none(text):
    assert middleware._first_json_object(text) is None


def test_web_search_sends_a_query_containing_braces_whole(monkeypatch):
    searched = []

    async def generate_queries(request, form, user):
        return {'choices': [{'message': {'content': '{"queries": ["python {set} comprehension syntax"]}'}}]}

    async def process_web_search(request, form, user=None):
        searched.append(form.queries)
        return None

    async def emit(event):
        pass

    monkeypatch.setattr(middleware, 'generate_queries', generate_queries)
    monkeypatch.setattr(middleware, 'process_web_search', process_web_search)
    monkeypatch.setattr(middleware, 'ENABLE_QUERIES_CACHE', False)
    form = {'model': 'm', 'messages': [{'role': 'user', 'content': 'how do set comprehensions work'}]}

    asyncio.run(
        middleware.chat_web_search_handler(
            SimpleNamespace(state=SimpleNamespace()),
            form,
            {'__event_emitter__': emit, '__chat_id__': 'c1'},
            None,
        )
    )

    assert searched == [['python {set} comprehension syntax']]


def test_web_search_falls_back_to_the_whole_reply_without_json(monkeypatch):
    searched = []

    async def generate_queries(request, form, user):
        return {'choices': [{'message': {'content': 'set comprehension {syntax'}}]}

    async def process_web_search(request, form, user=None):
        searched.append(form.queries)
        return None

    async def emit(event):
        pass

    monkeypatch.setattr(middleware, 'generate_queries', generate_queries)
    monkeypatch.setattr(middleware, 'process_web_search', process_web_search)
    monkeypatch.setattr(middleware, 'ENABLE_QUERIES_CACHE', False)
    form = {'model': 'm', 'messages': [{'role': 'user', 'content': 'q'}]}

    asyncio.run(
        middleware.chat_web_search_handler(
            SimpleNamespace(state=SimpleNamespace()),
            form,
            {'__event_emitter__': emit, '__chat_id__': 'c1'},
            None,
        )
    )

    # Not a fragment cut at the brace.
    assert searched == [['set comprehension {syntax']]


class _Stop(Exception):
    pass


def test_retrieval_queries_keep_a_brace(monkeypatch):
    queries = []

    async def generate_queries(request, form, user):
        return {'choices': [{'message': {'content': 'Here: {"queries": ["dict {key: value} syntax"]}'}}]}

    async def emit(event):
        if event['data'].get('action') == 'queries_generated':
            queries.append(event['data']['queries'])
            raise _Stop

    monkeypatch.setattr(middleware, 'generate_queries', generate_queries)
    body = {
        'model': 'm',
        'messages': [{'role': 'user', 'content': 'q'}],
        'metadata': {'files': [{'type': 'file', 'id': 'f1'}]},
    }

    with pytest.raises(_Stop):
        asyncio.run(middleware.chat_completion_files_handler(None, body, {'__event_emitter__': emit}, None))

    assert queries == [['dict {key: value} syntax']]


@pytest.mark.parametrize(
    ('reply', 'expected'),
    [
        ('{"prompt": "a cat in a {box}, watercolour"}', 'a cat in a {box}, watercolour'),
        ('no json at all', 'draw a cat'),  # the user's message, as before
    ],
)
def test_image_prompt_keeps_a_brace(monkeypatch, reply, expected):
    prompts = []

    class FakeConfig:
        @staticmethod
        async def get(key):
            return True

    async def generate_image_prompt(request, form, user):
        return {'choices': [{'message': {'content': reply}}]}

    async def image_generations(request, form_data, metadata, user):
        prompts.append(form_data.prompt)
        raise _Stop

    async def emit(event):
        pass

    monkeypatch.setattr(middleware, 'Config', FakeConfig)
    monkeypatch.setattr(middleware, 'generate_image_prompt', generate_image_prompt)
    monkeypatch.setattr(middleware, 'image_generations', image_generations)
    form = {'model': 'm', 'messages': [{'role': 'user', 'content': 'draw a cat'}]}
    extra = {'__metadata__': {'chat_id': 'local:c1'}, '__event_emitter__': emit}

    try:
        asyncio.run(middleware.chat_image_generation_handler(None, form, extra, None))
    except _Stop:
        pass

    assert prompts == [expected]
