"""Characterization tests for routers/retrieval.py's search_web dispatch.

It was refactored for ruff's complexity limit with no tests of its own, so
these pin what it did before the refactor: for every engine, which provider
it calls, whether it awaits it or runs it in a worker thread, and with
exactly which arguments, and the error it raises when a required key is
missing or the engine is unknown. Every provider is a recorder, and every
config value is a distinct marker, so an argument mix-up would show. Each
case was recorded from the untouched function into
fixtures/search_web_dispatch.json and must not change.

The golden file is only ever written by hand, never by this test. To record
it again (only for an intended behaviour change, reviewed as such), run
`SEARCH_WEB_GOLDEN_RECORD=1 pytest tests/test_search_web_dispatch.py`.
"""

import asyncio
import inspect
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from local_llm.routers import retrieval

GOLDEN = Path(__file__).parent / 'fixtures' / 'search_web_dispatch.json'
RECORD = os.environ.get('SEARCH_WEB_GOLDEN_RECORD') == '1'

# engine -> config keys it requires (all must be set)
ENGINES = {
    'ollama_cloud': [],
    'perplexity_search': ['PERPLEXITY_API_KEY'],
    'searxng': ['SEARXNG_QUERY_URL'],
    'openserp': ['OPENSERP_BASE_URL'],
    'yacy': ['YACY_QUERY_URL'],
    'google_pse': ['GOOGLE_PSE_API_KEY', 'GOOGLE_PSE_ENGINE_ID'],
    'brave': ['BRAVE_SEARCH_API_KEY'],
    'brave_llm_context': ['BRAVE_SEARCH_API_KEY'],
    'kagi': ['KAGI_SEARCH_API_KEY'],
    'mojeek': ['MOJEEK_SEARCH_API_KEY'],
    'bocha': ['BOCHA_SEARCH_API_KEY'],
    'serpstack': ['SERPSTACK_API_KEY'],
    'serper': ['SERPER_API_KEY'],
    'serphouse': ['SERPHOUSE_API_KEY'],
    'serply': ['SERPLY_API_KEY'],
    'duckduckgo': [],
    'tavily': ['TAVILY_API_KEY'],
    'exa': ['EXA_API_KEY'],
    'searchapi': ['SEARCHAPI_API_KEY'],
    'serpapi': ['SERPAPI_API_KEY'],
    'jina': [],
    'bing': [],
    'azure': ['AZURE_AI_SEARCH_API_KEY', 'AZURE_AI_SEARCH_ENDPOINT', 'AZURE_AI_SEARCH_INDEX_NAME'],
    'perplexity': [],
    'microsoft_web_iq': ['MICROSOFT_WEB_IQ_API_KEY'],
    'sougou': ['SOUGOU_API_SID', 'SOUGOU_API_SK'],
    'firecrawl': [],
    'external': [],
    'yandex': [],
    'youcom': [],
    'linkup': ['LINKUP_API_KEY'],
}

CASES = [(engine, {'engine': engine, 'unset': []}) for engine in ENGINES]
CASES += [
    (f'{engine}_without_{key.lower()}', {'engine': engine, 'unset': [key]})
    for engine, keys in ENGINES.items()
    for key in keys
]
CASES += [
    ('unknown_engine', {'engine': 'altavista', 'unset': []}),
    ('empty_engine', {'engine': '', 'unset': []}),
]


class _MarkerConfig(SimpleNamespace):
    """Any setting not given explicitly reads as its own name, as a marker."""

    def __getattr__(self, name):
        if name.startswith('_'):
            raise AttributeError(name)
        return f'<{name}>'


def _describe(value):
    if isinstance(value, SimpleNamespace) and getattr(value, '_marker', None):
        return value._marker
    return value


def _run(spec: dict, monkeypatch) -> dict:
    calls = []
    config = _MarkerConfig()
    config.WEB_SEARCH_RESULT_COUNT = 5
    config.WEB_SEARCH_DOMAIN_FILTER_LIST = ['example.com']
    for key in spec['unset']:
        setattr(config, key, '')

    async def get_retrieval_config():
        return config

    in_thread = {'value': False}

    async def to_thread(func, *args, **kwargs):
        in_thread['value'] = True
        try:
            return func(*args, **kwargs)
        finally:
            in_thread['value'] = False

    def recorder(name, is_async):
        def record(args, kwargs):
            calls.append(
                {
                    'provider': name,
                    'via': 'thread' if in_thread['value'] else 'await',
                    'args': [_describe(a) for a in args],
                    'kwargs': {k: _describe(v) for k, v in kwargs.items()},
                }
            )
            return [{'link': f'https://{name}.example', 'title': name}]

        if is_async:

            async def provider(*args, **kwargs):
                return record(args, kwargs)
        else:

            def provider(*args, **kwargs):
                return record(args, kwargs)

        return provider

    for name in dir(retrieval):
        original = getattr(retrieval, name)
        if name.startswith('search_') and name != 'search_web' and callable(original):
            monkeypatch.setattr(retrieval, name, recorder(name, inspect.iscoroutinefunction(original)))
    monkeypatch.setattr(retrieval, 'get_retrieval_config', get_retrieval_config)
    monkeypatch.setattr(retrieval.asyncio, 'to_thread', to_thread)

    request = SimpleNamespace(_marker='<request>')
    user = SimpleNamespace(_marker='<user>')
    try:
        result = asyncio.run(retrieval.search_web(request, spec['engine'], 'the query', user=user))
        outcome = {'returned': result}
    except Exception as e:
        outcome = {'raised': type(e).__name__, 'message': str(e)}
    return {'calls': calls, **outcome}


def _golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding='utf-8'))


def test_case_ids_are_unique():
    ids = [case[0] for case in CASES]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize(('case_id', 'spec'), CASES, ids=[c[0] for c in CASES])
def test_dispatch_matches_golden(monkeypatch, case_id, spec):
    observed = _run(spec, monkeypatch)
    if RECORD:
        pytest.skip('recording')
    assert observed == _golden()[case_id]


def test_record_golden(monkeypatch):
    """Writes the golden file, only when SEARCH_WEB_GOLDEN_RECORD=1."""
    if not RECORD:
        pytest.skip('set SEARCH_WEB_GOLDEN_RECORD=1 to record the golden file')
    golden = {}
    for case_id, spec in CASES:
        with monkeypatch.context() as m:
            golden[case_id] = _run(spec, m)
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
