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
