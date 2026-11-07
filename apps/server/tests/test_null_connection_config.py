"""An OpenAI or Ollama connection config stored as null does not break its requests (#632).

`openai.api_configs` and `ollama.api_configs` map a connection's index to its
settings. The config saves and the config import stored them as given, so an
entry sent as null (`{"0": null}`) was kept, and every reader that looked the
connection up called `.get(...)` on None: chat completions, model lists, the
Ollama routes and the unified unload failed with an AttributeError for as
long as the null was stored. A save or an import now stores `{}` for a null
entry, and the readers read one already stored as empty.

Config is faked in the routers and in main, so nothing is written to the
test run's database.

Run from apps/server:

    python -m pytest tests/test_null_connection_config.py
"""

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from local_llm.routers import ollama, openai

ADMIN = SimpleNamespace(id='admin', role='admin')


class _Config:
    """Config with the given stored values; records what is upserted."""

    def __init__(self, values: dict):
        self.values = dict(values)
        self.upserted: dict = {}

    async def get(self, key, default=None):
        return self.values.get(key, default)

    async def get_many(self, *keys):
        return {key: self.values[key] for key in keys if key in self.values}

    async def upsert(self, updates):
        self.upserted.update(updates)
        self.values.update(updates)


def _admin_client(router, prefix, monkeypatch, config: _Config) -> TestClient:
    from local_llm.utils.auth import get_admin_user

    async def publish(*_a, **_k):
        return None

    monkeypatch.setattr(router, 'Config', config)
    monkeypatch.setattr(router, 'publish_event', publish)
    app = FastAPI()
    app.include_router(router.router, prefix=prefix)
    app.dependency_overrides[get_admin_user] = lambda: ADMIN
    return TestClient(app)


# ── Saving ──────────────────────────────────────────────────────────────────


def test_an_openai_connection_saved_with_a_null_config_stores_an_empty_one(monkeypatch):
    config = _Config({})
    r = _admin_client(openai, '/openai', monkeypatch, config).post(
        '/openai/config/update',
        json={
            'ENABLE_OPENAI_API': True,
            'OPENAI_API_BASE_URLS': ['http://a.invalid/v1', 'http://b.invalid/v1'],
            'OPENAI_API_KEYS': ['', ''],
            'OPENAI_API_CONFIGS': {'0': None, '1': {'prefix_id': 'b'}},
        },
    )

    assert r.status_code == 200, r.text
    assert config.upserted['openai.api_configs'] == {'0': {}, '1': {'prefix_id': 'b'}}
    assert r.json()['OPENAI_API_CONFIGS'] == {'0': {}, '1': {'prefix_id': 'b'}}


def test_an_ollama_connection_saved_with_a_null_config_stores_an_empty_one(monkeypatch):
    config = _Config({})
    r = _admin_client(ollama, '/ollama', monkeypatch, config).post(
        '/ollama/config/update',
        json={
            'ENABLE_OLLAMA_API': True,
            'OLLAMA_BASE_URLS': ['http://a.invalid', 'http://b.invalid'],
            'OLLAMA_API_CONFIGS': {'0': None, '1': {'prefix_id': 'b'}},
        },
    )

    assert r.status_code == 200, r.text
    assert config.upserted['ollama.api_configs'] == {'0': {}, '1': {'prefix_id': 'b'}}
    assert r.json()['OLLAMA_API_CONFIGS'] == {'0': {}, '1': {'prefix_id': 'b'}}


def test_an_imported_null_connection_config_is_stored_as_empty():
    from local_llm.routers.configs import without_null_settings

    imported = without_null_settings(
        {
            'openai.api_configs': {'0': None, '1': {'enable': False}},
            'ollama.api_configs': {'0': None},
            'openai.enable': True,
        }
    )

    assert imported == {
        'openai.api_configs': {'0': {}, '1': {'enable': False}},
        'ollama.api_configs': {'0': {}},
        'openai.enable': True,
    }


# ── Reading a null already stored ───────────────────────────────────────────


def test_an_openai_connection_stored_with_a_null_config_is_read_as_empty(monkeypatch):
    monkeypatch.setattr(
        openai,
        'Config',
        _Config(
            {
                'openai.enable': True,
                'openai.api_base_urls': ['http://a.invalid/v1'],
                'openai.api_keys': ['sk-a'],
                'openai.api_configs': {'0': None},
            }
        ),
    )

    assert asyncio.run(openai.get_openai_connection(0)) == ('http://a.invalid/v1', 'sk-a', {})


def test_the_openai_model_list_reads_a_null_connection_config_as_empty(monkeypatch):
    monkeypatch.setattr(
        openai,
        'Config',
        _Config(
            {
                'openai.enable': True,
                'openai.api_base_urls': ['http://a.invalid/v1'],
                'openai.api_keys': ['sk-a'],
                'openai.api_configs': {'0': None},
            }
        ),
    )
    asked = []

    async def get_models_request(request, url, key=None, user=None, config=None):
        asked.append((url, key, config))
        return {'data': [{'id': 'm'}]}

    monkeypatch.setattr(openai, 'get_models_request', get_models_request)

    responses = asyncio.run(openai.get_all_models_responses(SimpleNamespace(), ADMIN))

    assert asked == [('http://a.invalid/v1', 'sk-a', {})]
    assert responses[0]['data'][0]['id'] == 'm'


def test_an_ollama_connection_stored_with_a_null_config_is_read_as_empty(monkeypatch):
    monkeypatch.setattr(
        ollama,
        'Config',
        _Config(
            {
                'ollama.enable': True,
                'ollama.base_urls': ['http://a.invalid'],
                'ollama.api_configs': {'0': None},
            }
        ),
    )
    asked = []

    async def send_get_request(url, key=None, user=None):
        asked.append((url, key))
        return {'version': '0.5.1'}

    monkeypatch.setattr(ollama, 'send_get_request', send_get_request)

    assert asyncio.run(ollama.get_ollama_connection(0)) == ('http://a.invalid', {}, None)
    assert asyncio.run(ollama.get_ollama_versions(SimpleNamespace(), ADMIN)) == {'version': '0.5.1'}
    assert asked == [('http://a.invalid/api/version', None)]


def _unload_request(**state) -> SimpleNamespace:
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(**state)))


def test_unloading_from_an_openai_connection_with_a_null_config_reads_it_as_empty(monkeypatch):
    from local_llm import main

    monkeypatch.setattr(
        main,
        'Config',
        _Config(
            {
                'openai.api_base_urls': ['http://a.invalid/v1'],
                'openai.api_keys': [''],
                'openai.api_configs': {'0': None},
            }
        ),
    )
    request = _unload_request(OLLAMA_MODELS={}, OPENAI_MODELS={'m': {'urlIdx': 0}})

    with pytest.raises(HTTPException) as raised:
        asyncio.run(main.unload_model(request, main.ModelUnloadForm(model='m'), ADMIN))

    # Not a llama.cpp connection: refused as one that cannot unload, as with no config.
    assert raised.value.status_code == 400
    assert 'default' in raised.value.detail


def test_unloading_from_an_ollama_connection_with_a_null_config_reads_it_as_empty(monkeypatch):
    from local_llm import main

    monkeypatch.setattr(
        main,
        'Config',
        _Config({'ollama.base_urls': ['http://a.invalid'], 'ollama.api_configs': {'0': None}}),
    )
    tried = []

    def session(*_a, **_k):
        tried.append(True)
        raise OSError('no network in this test')

    monkeypatch.setattr(main.aiohttp, 'ClientSession', session)
    request = _unload_request(OLLAMA_MODELS={'m': {'urls': [0]}}, OPENAI_MODELS={})

    with pytest.raises(HTTPException) as raised:
        asyncio.run(main.unload_model(request, main.ModelUnloadForm(model='m'), ADMIN))

    # The unload was tried, and its failure reported, instead of an AttributeError first.
    assert tried == [True]
    assert raised.value.status_code == 500
