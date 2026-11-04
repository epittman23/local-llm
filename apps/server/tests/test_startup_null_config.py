"""A tool-server connection or arena model stored with a null config does not stop startup (#363).

The startup migration of legacy `access_control` read each tool-server
connection's `c.get('config', {})`, which is None when the key is stored as
null (an API save or a config import can store it), and `'access_control' in
None` raised in the lifespan: the backend did not start. Arena models' `meta`
had the same pattern. A null is now read as empty, and stored back as `{}`,
so the readers that run later (tool listings, tool calls) do not meet it
either. A save normalises a null config to `{}` too.

Runs against the test run's migrated SQLite database.

Run from apps/server:

    python -m pytest tests/test_startup_null_config.py
"""

import asyncio
import importlib

from local_llm.models.config import Config

# Importing the config runs the migrations on the test run's database.
importlib.import_module('local_llm.config')


def test_the_startup_migration_reads_and_repairs_a_null_config():
    from local_llm.main import migrate_legacy_access_control

    async def run():
        await Config.upsert(
            {
                'tool_server.connections': [
                    {'url': 'http://a', 'path': 'openapi.json', 'config': None},
                    {'url': 'http://b', 'path': 'openapi.json', 'config': {'access_control': None}},
                ],
                'evaluation.arena.models': [{'id': 'arena', 'meta': None}],
            }
        )
        await migrate_legacy_access_control()
        return await Config.get('tool_server.connections'), await Config.get('evaluation.arena.models')

    connections, arena = asyncio.run(run())

    assert connections[0]['config'] == {}
    assert connections[1]['config'] == {'access_grants': []}
    assert arena[0]['meta'] == {}


def test_saving_a_tool_server_with_a_null_config_stores_an_empty_one():
    from local_llm.routers.configs import ToolServerConnection

    connection = ToolServerConnection(url='http://a', path='openapi.json', auth_type=None, key=None, config=None)

    assert connection.config == {}


def _admin_client(router, prefix, monkeypatch):
    from types import SimpleNamespace

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from local_llm.utils.auth import get_admin_user

    async def publish(*_a, **_k):
        return None

    monkeypatch.setattr(router, 'publish_event', publish)
    app = FastAPI()
    app.include_router(router.router, prefix=prefix)
    app.dependency_overrides[get_admin_user] = lambda: SimpleNamespace(id='admin', role='admin')
    return TestClient(app)


def test_an_imported_null_config_or_meta_is_stored_as_empty(monkeypatch):
    from local_llm.routers import configs

    r = _admin_client(configs, '/configs', monkeypatch).post(
        '/configs/import',
        json={
            'config': {
                'tool_server.connections': [{'url': 'http://a', 'path': 'openapi.json', 'config': None}],
                'evaluation.arena.models': [{'id': 'arena', 'meta': None}],
            }
        },
    )

    assert r.status_code == 200, r.text
    assert asyncio.run(Config.get('tool_server.connections'))[0]['config'] == {}
    assert asyncio.run(Config.get('evaluation.arena.models'))[0]['meta'] == {}


def test_arena_models_saved_with_a_null_meta_store_an_empty_one(monkeypatch):
    from local_llm.routers import evaluations

    r = _admin_client(evaluations, '/evaluations', monkeypatch).post(
        '/evaluations/config', json={'EVALUATION_ARENA_MODELS': [{'id': 'arena', 'name': 'Arena', 'meta': None}]}
    )

    assert r.status_code == 200, r.text
    assert asyncio.run(Config.get('evaluation.arena.models'))[0]['meta'] == {}
