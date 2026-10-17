"""Characterization tests for utils/models.py's get_all_models.

It was refactored for ruff's complexity limit with no tests of its own, so
these pin what it did before the refactor. Config, Redis, the base-model
fetch, custom (workspace) models, plugin functions, their modules and
valves, and the shared model cache are fakes that record what was asked of
them; chat-variable parsing and the arena default are real. Each case pins
the models returned, the app state left behind (MODELS, BASE_MODELS), the
cache and Redis traffic, and which function modules were warmed. Each case
was recorded from the untouched function into fixtures/get_all_models.json
and must not change.

The golden file is only ever written by hand, never by this test. To record
it again (only for an intended behaviour change, reviewed as such), run
`GET_ALL_MODELS_GOLDEN_RECORD=1 pytest tests/test_get_all_models.py`.
"""

import asyncio
import copy
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from local_llm.utils import models as models_util

GOLDEN = Path(__file__).parent / 'fixtures' / 'get_all_models.json'
RECORD = os.environ.get('GET_ALL_MODELS_GOLDEN_RECORD') == '1'

OPENAI_BASE = [
    {'id': 'gpt-x', 'name': 'GPT X', 'object': 'model', 'owned_by': 'openai', 'connection_type': 'external'},
    {
        'id': 'qwen',
        'name': 'Qwen',
        'object': 'model',
        'owned_by': 'openai',
        'provider': 'openrouter',
        'info': {'meta': {'description': 'base info'}},
    },
]
OLLAMA_BASE = [
    {
        'id': 'llama3:8b',
        'name': 'llama3:8b',
        'object': 'model',
        'owned_by': 'ollama',
        'loaded': True,
        'connection_type': 'local',
    },
    {
        'id': 'pipe-model',
        'name': 'Pipe',
        'object': 'model',
        'owned_by': 'function',
        'pipe': {'type': 'pipe'},
        'loaded': False,
    },
]
ALL_BASE = OPENAI_BASE + OLLAMA_BASE


def _custom(cid, base=None, *, active=True, name=None, system=None, meta=None, created_at=100):
    """A workspace model. meta None means no meta object at all."""
    params = {'system': system, 'temperature': 0.3} if system else {'temperature': 0.3}
    return {
        'id': cid,
        'base_model_id': base,
        'is_active': active,
        'name': name or f'Custom {cid}',
        'system': system,
        'params': params,
        'meta': meta,
        'created_at': created_at,
    }


FUNCTIONS = {
    'act1': {'name': 'Summarize', 'description': 'sum it up', 'manifest': {'icon_url': 'act1.png'}},
    'act2': {'name': 'Translate', 'description': 'translate', 'manifest': {}},
    'multi': {'name': 'Multi', 'description': 'several actions', 'manifest': {}},
    'flt1': {'name': 'Redact', 'description': 'redact pii', 'manifest': {}},
    'flt2': {'name': 'Quiet', 'description': 'no toggle', 'manifest': {}},
    'gflt': {'name': 'Global filter', 'description': 'everywhere', 'manifest': {'icon_url': 'g.png'}},
    'broken': {'name': 'Broken', 'description': 'module fails', 'manifest': {}},
    'broken_filter': {'name': 'Broken filter', 'description': 'module fails', 'manifest': {}},
}
MODULES = {
    'act1': {'valves_priority': 5},
    'act2': {'icon_url': 'module-icon.png', 'valves_priority': 'raise'},
    'multi': {'actions': [{'id': 'a', 'name': 'First'}, {'id': 'b', 'icon_url': 'b.png'}], 'icon': 'multi-icon'},
    'flt1': {'toggle': True, 'user_valves': True},
    'flt2': {},
    'gflt': {'toggle': True},
}

PLUGINS = {
    'enabled': True,
    'actions': [['act1', False], ['act2', True], ['multi', False], ['missing_action', False], ['broken', False]],
    'filters': [['flt1', False], ['flt2', False], ['gflt', True], ['missing_filter', False], ['broken_filter', False]],
    'valves': {'act1': {'priority': 5}},
}

# (case id, settings)
CASES = [
    ('no_models_at_all', {'base': [], 'state_base': []}),
    ('fetch_empty_uses_previous_base_models', {'base': [], 'state_base': OPENAI_BASE[:1]}),
    ('basic', {'base': OPENAI_BASE}),
    ('refresh_with_redis', {'refresh': True, 'redis': {}, 'base': OPENAI_BASE, 'state_base': OLLAMA_BASE}),
    ('refresh_without_redis', {'refresh': True, 'base': OPENAI_BASE, 'state_base': OLLAMA_BASE}),
    (
        'cache_hit_in_redis',
        {'config': {'models.base_models_cache': True}, 'redis': {'cached': OLLAMA_BASE}, 'base': OPENAI_BASE},
    ),
    ('cache_miss_in_redis', {'config': {'models.base_models_cache': True}, 'redis': {}, 'base': OPENAI_BASE}),
    ('cache_off_with_redis_does_not_store', {'redis': {}, 'base': OPENAI_BASE}),
    (
        'cache_in_process',
        {
            'config': {'models.base_models_cache': True},
            'state_models': {'old': {}},
            'state_base': OLLAMA_BASE,
            'base': OPENAI_BASE,
        },
    ),
    (
        'cache_in_process_without_models',
        {'config': {'models.base_models_cache': True}, 'state_base': OLLAMA_BASE, 'base': OPENAI_BASE},
    ),
    ('arena_default', {'config': {'evaluation.arena.enable': True}, 'base': OPENAI_BASE[:1]}),
    (
        'arena_configured',
        {
            'config': {
                'evaluation.arena.enable': True,
                'evaluation.arena.models': [{'id': 'arena-a', 'name': 'Arena A', 'meta': {'model_ids': ['gpt-x']}}],
            },
            'base': OPENAI_BASE[:1],
        },
    ),
    (
        'custom_overrides',
        {
            'base': ALL_BASE,
            'custom': [
                _custom(
                    'gpt-x', name='Renamed GPT', system='Hi {{chat.variables.topic}}', meta={'actionIds': ['act1']}
                ),
                _custom('qwen', active=False),
                _custom('llama3', name='Llama by base name'),
                _custom('not-a-base-model', name='Orphan override'),
            ],
        },
    ),
    (
        'custom_presets',
        {
            'base': ALL_BASE,
            'custom': [
                _custom(
                    'helper', 'qwen', system='You help with {{chat.variables.task | the task}}.', meta={'tags': []}
                ),
                _custom('llama-preset', 'llama3:latest'),
                _custom('piped', 'pipe-model', meta=None),
                _custom('nowhere', 'unknown-base'),
                _custom('qwen', 'gpt-x', name='Preset sharing a base id'),
                _custom('off', 'qwen', active=False),
            ],
        },
    ),
    (
        'plugins',
        {
            'plugins': PLUGINS,
            'base': OPENAI_BASE,
            'custom': [
                _custom(
                    'gpt-x',
                    meta={
                        'actionIds': ['act1', 'multi', 'missing_action', 'broken'],
                        'filterIds': ['flt1', 'flt2', 'missing_filter', 'broken_filter'],
                    },
                ),
                _custom('helper', 'qwen', meta={'actionIds': ['act1', 'not_enabled'], 'filterIds': ['flt1']}),
            ],
        },
    ),
    (
        'plugins_disabled_ignores_ids',
        {
            'plugins': {**PLUGINS, 'enabled': False},
            'base': OPENAI_BASE,
            'custom': [
                _custom('gpt-x', meta={'actionIds': ['act1'], 'filterIds': ['flt1']}),
                _custom('helper', 'qwen', meta={'actionIds': ['act1']}),
            ],
        },
    ),
    (
        'plugin_module_warm_up_fails',
        {
            'plugins': {**PLUGINS, 'warm_fail': ['act1']},
            'base': OPENAI_BASE[:1],
            'custom': [_custom('gpt-x', meta={'actionIds': ['act1']})],
        },
    ),
    (
        'default_metadata',
        {
            'config': {
                'models.default_metadata': {
                    'capabilities': {'vision': True, 'citations': True},
                    'description': 'default',
                    'tags': ['x'],
                }
            },
            'base': [
                {'id': 'bare', 'name': 'Bare', 'owned_by': 'openai'},
                {'id': 'with-info', 'name': 'Info', 'owned_by': 'openai', 'info': {'id': 'with-info'}},
                {
                    'id': 'with-meta',
                    'name': 'Meta',
                    'owned_by': 'openai',
                    'info': {'meta': {'capabilities': {'vision': False}, 'description': 'mine', 'tags': None}},
                },
                {
                    'id': 'caps-none',
                    'name': 'Caps none',
                    'owned_by': 'openai',
                    'info': {'meta': {'capabilities': None}},
                },
            ],
        },
    ),
    ('models_cache_is_redis_dict', {'base': OPENAI_BASE[:1], 'redis_dict': 'ok'}),
    ('models_cache_redis_dict_fails', {'base': OPENAI_BASE[:1], 'redis_dict': 'raise'}),
]


class _FakeRedis:
    def __init__(self, cached, log):
        self.store = {models_util.BASE_MODELS_CACHE_KEY: json.dumps(cached)} if cached is not None else {}
        self.log = log

    async def get(self, key):
        self.log.append(['get', key])
        return self.store.get(key)

    async def set(self, key, value):
        self.log.append(['set', key, json.loads(value)])
        self.store[key] = value

    async def delete(self, key):
        self.log.append(['delete', key])
        self.store.pop(key, None)


class _FakeRedisDict:
    def __init__(self, mode, log):
        self.mode = mode
        self.log = log

    def set(self, value):
        if self.mode == 'raise':
            raise RuntimeError('redis unavailable')
        self.log.append(['redis_dict_set', sorted(value)])


def _module(spec: dict):
    module = SimpleNamespace()
    for key in ('actions', 'icon_url', 'icon', 'toggle'):
        if key in spec:
            setattr(module, key, copy.deepcopy(spec[key]))
    if spec.get('user_valves'):
        module.UserValves = object
    if 'valves_priority' in spec:
        priority = spec['valves_priority']

        class Valves:
            def __init__(self, **kwargs):
                if priority == 'raise':
                    raise ValueError('bad valves')
                self.priority = kwargs.get('priority', 0)

        module.Valves = Valves
    return module


def _custom_object(spec: dict):
    meta = spec['meta']
    dump = {
        'id': spec['id'],
        'base_model_id': spec['base_model_id'],
        'name': spec['name'],
        'params': copy.deepcopy(spec['params']),
        'meta': copy.deepcopy(meta) if meta is not None else {},
        'is_active': spec['is_active'],
        'created_at': spec['created_at'],
    }
    return SimpleNamespace(
        id=spec['id'],
        base_model_id=spec['base_model_id'],
        is_active=spec['is_active'],
        name=spec['name'],
        created_at=spec['created_at'],
        params=SimpleNamespace(model_dump=lambda: copy.deepcopy(spec['params'])),
        meta=SimpleNamespace(model_dump=lambda: copy.deepcopy(meta)) if meta is not None else None,
        model_dump=lambda: copy.deepcopy(dump),
    )


def _run(settings: dict, monkeypatch) -> dict:
    log = {
        'cache_clears': [],
        'redis': [],
        'base_fetches': 0,
        'warmed': [],
        'function_lookups': [],
        'valves_lookups': [],
    }
    config = {
        'models.base_models_cache': False,
        'evaluation.arena.enable': False,
        'evaluation.arena.models': None,
        'models.default_metadata': None,
        **settings.get('config', {}),
    }
    plugins = settings.get('plugins', {'enabled': False, 'actions': [], 'filters': [], 'valves': {}})

    async def get_many(*keys):
        return {key: copy.deepcopy(config.get(key)) for key in keys}

    def cache_clearer(name):
        async def clear():
            log['cache_clears'].append(name)

        return SimpleNamespace(clear=clear)

    async def get_all_base_models(request, user=None):
        log['base_fetches'] += 1
        return copy.deepcopy(settings.get('base', []))

    async def active_function_ids(kind):
        return [tuple(row) for row in plugins['actions' if kind == 'action' else 'filters']]

    async def all_custom_models():
        return [_custom_object(spec) for spec in settings.get('custom', [])]

    async def functions_by_ids(ids):
        ids = sorted(ids)
        log['function_lookups'].append(ids)
        return [
            SimpleNamespace(
                id=fid,
                name=FUNCTIONS[fid]['name'],
                meta=SimpleNamespace(**{k: v for k, v in FUNCTIONS[fid].items() if k != 'name'}),
            )
            for fid in ids
            if fid in FUNCTIONS
        ]

    async def warm(request, function_id, function=None):
        log['warmed'].append(function_id)
        if function_id in plugins.get('warm_fail', []):
            raise RuntimeError('cannot load')

    async def valves_by_ids(ids):
        log['valves_lookups'].append(sorted(ids))
        return copy.deepcopy(plugins.get('valves', {}))

    modules = {fid: _module(spec) for fid, spec in MODULES.items()}

    monkeypatch.setattr(models_util.Config, 'get_many', get_many)
    monkeypatch.setattr(models_util.openai.get_all_models, 'cache', cache_clearer('openai'), raising=False)
    monkeypatch.setattr(models_util.ollama.get_all_models, 'cache', cache_clearer('ollama'), raising=False)
    monkeypatch.setattr(models_util, 'get_all_base_models', get_all_base_models)
    monkeypatch.setattr(models_util, 'ENABLE_PLUGINS', plugins['enabled'])
    monkeypatch.setattr(models_util.Functions, 'get_active_function_ids_by_type', active_function_ids)
    monkeypatch.setattr(models_util.Models, 'get_all_models', all_custom_models)
    monkeypatch.setattr(models_util.Functions, 'get_functions_by_ids', functions_by_ids)
    monkeypatch.setattr(models_util, 'get_function_module_from_cache', warm)
    monkeypatch.setattr(models_util.Functions, 'get_function_valves_by_ids', valves_by_ids)
    monkeypatch.setattr(models_util, 'get_functions_cache', lambda request: modules)
    monkeypatch.setattr(models_util, 'RedisDict', _FakeRedisDict)

    redis = _FakeRedis(settings['redis'].get('cached'), log['redis']) if 'redis' in settings else None
    if settings.get('redis_dict'):
        state_models = _FakeRedisDict(settings['redis_dict'], log['redis'])
    else:
        state_models = copy.deepcopy(settings.get('state_models', {}))
    state = SimpleNamespace(
        redis=redis,
        MODELS=state_models,
        BASE_MODELS=copy.deepcopy(settings.get('state_base', [])),
    )
    request = SimpleNamespace(app=SimpleNamespace(state=state))

    returned = asyncio.run(models_util.get_all_models(request, refresh=settings.get('refresh', False), user=None))
    models_state = state.MODELS if isinstance(state.MODELS, dict) else f'<{type(state.MODELS).__name__}>'
    return json.loads(
        json.dumps({'returned': returned, 'state_models': models_state, 'state_base_models': state.BASE_MODELS, **log})
    )


def _golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding='utf-8'))


def test_case_ids_are_unique():
    ids = [case[0] for case in CASES]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize(('case_id', 'settings'), CASES, ids=[c[0] for c in CASES])
def test_get_all_models_matches_golden(monkeypatch, case_id, settings):
    observed = _run(settings, monkeypatch)
    if RECORD:
        pytest.skip('recording')
    assert observed == _golden()[case_id]


def test_record_golden(monkeypatch):
    """Writes the golden file, only when GET_ALL_MODELS_GOLDEN_RECORD=1."""
    if not RECORD:
        pytest.skip('set GET_ALL_MODELS_GOLDEN_RECORD=1 to record the golden file')
    golden = {}
    for case_id, settings in CASES:
        with monkeypatch.context() as m:
            golden[case_id] = _run(settings, m)
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
