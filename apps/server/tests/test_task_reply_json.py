"""A task model's JSON is read whole with the decoder, so braces inside strings survive (#168).

The web search, image prompt and retrieval handlers took the JSON from the
reply's last `{`, so a generated query such as "python {set} comprehension
syntax" cut the object short, failed to parse, and the fallback then searched
for the cut fragment. They now read the reply's objects whole with the JSON
decoder and take the last one, as before.

Run from apps/server:

    python -m pytest tests/test_task_reply_json.py
"""

import asyncio
import time
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
        # The template's example echoed first: the answer is the last object.
        ('Format: {"queries": []}. Answer: {"queries": ["x {y}"]}', {'queries': ['x {y}']}),
        ('{}', {}),
    ],
)
def test_the_last_json_object_is_read_whole(text, expected):
    assert middleware._last_json_object(text) == expected


@pytest.mark.parametrize(
    'text',
    ['', 'no json here', '{not json', '["a"]', '{"a": 1', '{"queries": ["a", "b"'],
)
def test_no_json_object_is_none(text):
    assert middleware._last_json_object(text) is None


def test_nesting_past_the_recursion_limit_ends_the_search_quickly():
    started = time.perf_counter()

    assert middleware._last_json_object('{"a": 1} ' + '{"a":' * 20000) == {'a': 1}
    assert time.perf_counter() - started < 5


def test_a_reply_full_of_code_braces_is_read_quickly():
    code = 'for (i = 0; i < n; i++) { if (a[i]) { b(); } }\n' * 20000  # ~1 MB, 80,000 braces
    started = time.perf_counter()

    assert middleware._last_json_object(code + '{"queries": ["loops"]}') == {'queries': ['loops']}
    # Decoding at every brace took about 45 s for this; skipping the ones that
    # cannot open an object takes milliseconds.
    assert time.perf_counter() - started < 5


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


@pytest.mark.parametrize(
    ('reply', 'expected'),
    [
        # No braces at all: the reply is the query.
        ('set comprehension syntax', ['set comprehension syntax']),
        # JSON that does not parse (cut short, say): the user's message, not the fragment.
        ('{"queries": ["set compre', ['q']),
        ('set comprehension {syntax', ['q']),
    ],
)
def test_web_search_fallbacks(monkeypatch, reply, expected):
    searched = []

    async def generate_queries(request, form, user):
        return {'choices': [{'message': {'content': reply}}]}

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

    assert searched == [expected]


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
