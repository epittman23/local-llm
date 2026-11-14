"""The sandbox engine's admin settings: the config form, the defaults and GET /sandbox/status.

Requests carry real tokens through the real auth dependencies, against users
and config rows in the test run's migrated SQLite database.

Run from apps/server:

    python -m pytest tests/test_sandbox_settings.py
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.config import CODE_INTERPRETER_SANDBOX_PROMPT, DEFAULT_CONFIG
from local_llm.models.config import Config
from local_llm.models.users import Users
from local_llm.routers import configs as configs_router
from local_llm.routers import sandbox as sandbox_router
from local_llm.sandbox import limits
from local_llm.sandbox import manager as manager_module
from local_llm.sandbox.fake import FakeBackend
from local_llm.sandbox.manager import SETTING_KEYS, SandboxManager, SandboxSettings, settings_from_config
from local_llm.utils.auth import create_token

SANDBOX_FIELDS = {
    'CODE_INTERPRETER_SANDBOX_DEFAULT_IMAGE': 'code_interpreter.sandbox.default_image',
    'CODE_INTERPRETER_SANDBOX_TIMEOUT': 'code_interpreter.sandbox.timeout',
    'CODE_INTERPRETER_SANDBOX_MAX_RUNNING': 'code_interpreter.sandbox.max_running',
    'CODE_INTERPRETER_SANDBOX_IDLE_MINUTES': 'code_interpreter.sandbox.idle_minutes',
    'CODE_INTERPRETER_SANDBOX_RETENTION_DAYS': 'code_interpreter.sandbox.retention_days',
    'CODE_INTERPRETER_SANDBOX_MAX_WORKSPACES': 'code_interpreter.sandbox.max_workspaces',
}


def _run(coro):
    return asyncio.run(coro)


def _user(role: str) -> SimpleNamespace:
    uid = f'sbxset-{role}-{uuid.uuid4().hex[:10]}'
    _run(Users.insert_new_user(uid, f'{role} user', f'{uid}@example.com', role=role))
    token = create_token({'id': uid}, dt.timedelta(minutes=30))
    return SimpleNamespace(id=uid, headers={'Authorization': f'Bearer {token}'})


@pytest.fixture(scope='module')
def people():
    return SimpleNamespace(admin=_user('admin'), member=_user('user'))


@pytest.fixture
def app():
    app = FastAPI()
    app.state.redis = None
    app.include_router(configs_router.router, prefix='/configs')
    app.include_router(sandbox_router.router, prefix='/sandbox')
    return app


@pytest.fixture
def client(app):
    return TestClient(app)


def _form(**overrides) -> dict:
    """A complete form as the admin page posts it: switches, engines, prompt and the six sandbox settings."""
    form = {
        'ENABLE_CODE_EXECUTION': True,
        'CODE_EXECUTION_ENGINE': 'sandbox',
        'ENABLE_CODE_INTERPRETER': True,
        'CODE_INTERPRETER_ENGINE': 'sandbox',
        'CODE_INTERPRETER_PROMPT_TEMPLATE': None,
        'CODE_INTERPRETER_SANDBOX_DEFAULT_IMAGE': 'web',
        'CODE_INTERPRETER_SANDBOX_TIMEOUT': 120,
        'CODE_INTERPRETER_SANDBOX_MAX_RUNNING': 8,
        'CODE_INTERPRETER_SANDBOX_IDLE_MINUTES': 15,
        'CODE_INTERPRETER_SANDBOX_RETENTION_DAYS': 3,
        'CODE_INTERPRETER_SANDBOX_MAX_WORKSPACES': 12,
    }
    form.update(overrides)
    return form


class TestDefaults:
    def test_the_registered_defaults_match_the_manager_and_the_limits(self):
        settings = SandboxSettings()
        assert DEFAULT_CONFIG['code_interpreter.sandbox.default_image'] == settings.default_image
        assert DEFAULT_CONFIG['code_interpreter.sandbox.max_running'] == settings.max_running
        assert DEFAULT_CONFIG['code_interpreter.sandbox.idle_minutes'] == settings.idle_minutes
        assert DEFAULT_CONFIG['code_interpreter.sandbox.retention_days'] == settings.retention_days
        assert DEFAULT_CONFIG['code_interpreter.sandbox.max_workspaces'] == settings.max_workspaces == 20
        assert DEFAULT_CONFIG['code_interpreter.sandbox.timeout'] == limits.TIMEOUT_DEFAULT_S

    def test_the_form_maps_every_key_the_manager_reads(self):
        assert set(SETTING_KEYS) <= set(configs_router.CODE_EXECUTION_CONFIG_KEYS.values())
        for field, key in SANDBOX_FIELDS.items():
            assert configs_router.CODE_EXECUTION_CONFIG_KEYS[field] == key
            assert key in DEFAULT_CONFIG

    def test_the_prompt_names_the_tools_and_the_rules(self):
        for needle in (
            'bash',
            '`view`',
            'str_replace',
            'write_file',
            '/workspace/uploads',
            '/workspace/outputs',
            'plt.savefig',
            'no matching',
            '-halt-on-error -file-line-error',
            'Overfull',
            '`web`',
        ):
            assert needle in CODE_INTERPRETER_SANDBOX_PROMPT


class TestConfigForm:
    def test_a_valid_form_is_stored_under_the_config_keys(self, client, people):
        r = client.post('/configs/code_execution', json=_form(), headers=people.admin.headers)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body['CODE_INTERPRETER_ENGINE'] == 'sandbox'
        assert body['CODE_EXECUTION_ENGINE'] == 'sandbox'
        for field, key in SANDBOX_FIELDS.items():
            assert body[field] == _form()[field]
            assert _run(Config.get(key)) == _form()[field]
        # The manager reads the stored values back as it will at run time.
        assert _run(settings_from_config()) == SandboxSettings(
            default_image='web', max_running=8, idle_minutes=15, retention_days=3, max_workspaces=12
        )

    def test_a_form_without_the_sandbox_fields_keeps_what_is_stored(self, client, people):
        client.post('/configs/code_execution', json=_form(), headers=people.admin.headers)
        old = {k: v for k, v in _form().items() if k not in SANDBOX_FIELDS}
        r = client.post('/configs/code_execution', json=old, headers=people.admin.headers)
        assert r.status_code == 200, r.text
        assert r.json()['CODE_INTERPRETER_SANDBOX_MAX_RUNNING'] == 8
        assert r.json()['CODE_INTERPRETER_ENGINE'] == 'sandbox'

    @pytest.mark.parametrize(
        'field, value',
        [
            ('CODE_INTERPRETER_SANDBOX_DEFAULT_IMAGE', 'other'),
            ('CODE_INTERPRETER_SANDBOX_DEFAULT_IMAGE', ''),
            ('CODE_INTERPRETER_SANDBOX_TIMEOUT', 0),
            ('CODE_INTERPRETER_SANDBOX_TIMEOUT', limits.TIMEOUT_MAX_S + 1),
            ('CODE_INTERPRETER_SANDBOX_MAX_RUNNING', 0),
            ('CODE_INTERPRETER_SANDBOX_MAX_RUNNING', 17),
            ('CODE_INTERPRETER_SANDBOX_IDLE_MINUTES', 0),
            ('CODE_INTERPRETER_SANDBOX_RETENTION_DAYS', -1),
            ('CODE_INTERPRETER_SANDBOX_MAX_RUNNING', 'many'),
            ('CODE_INTERPRETER_SANDBOX_MAX_WORKSPACES', 0),
            ('CODE_INTERPRETER_SANDBOX_MAX_WORKSPACES', 2.5),
        ],
    )
    def test_a_value_outside_the_bounds_is_refused_and_nothing_is_stored(self, client, people, field, value):
        seeded = {
            'code_interpreter.sandbox.default_image': 'data',
            'code_interpreter.sandbox.timeout': 61,
            'code_interpreter.sandbox.max_running': 5,
            'code_interpreter.sandbox.idle_minutes': 31,
            'code_interpreter.sandbox.retention_days': 6,
            'code_interpreter.sandbox.max_workspaces': 9,
        }
        _run(Config.upsert(seeded))
        r = client.post('/configs/code_execution', json=_form(**{field: value}), headers=people.admin.headers)
        assert r.status_code == 422, r.text
        assert _run(Config.get_many(*seeded)) == seeded

    @pytest.mark.parametrize('field', [f for f in SANDBOX_FIELDS if not f.endswith('IMAGE')])
    def test_a_bool_is_refused_not_turned_into_1(self, client, people, field):
        r = client.post('/configs/code_execution', json=_form(**{field: True}), headers=people.admin.headers)
        assert r.status_code == 422, r.text

    def test_null_is_accepted_and_means_the_default(self, client, people):
        nulls = {field: None for field in SANDBOX_FIELDS}
        r = client.post('/configs/code_execution', json=_form(**nulls), headers=people.admin.headers)
        assert r.status_code == 200, r.text
        assert r.json()['CODE_INTERPRETER_SANDBOX_MAX_RUNNING'] is None
        assert _run(settings_from_config()) == SandboxSettings()

    def test_a_bad_stored_value_does_not_break_the_page(self, client, people):
        # A value an old import or a hand edit left behind: GET serves it as stored, and a save that leaves
        # the sandbox fields out still works.
        _run(Config.upsert({'code_interpreter.sandbox.max_running': 99}))
        r = client.get('/configs/code_execution', headers=people.admin.headers)
        assert r.status_code == 200, r.text
        assert r.json()['CODE_INTERPRETER_SANDBOX_MAX_RUNNING'] == 99
        old = {k: v for k, v in _form().items() if k not in SANDBOX_FIELDS}
        assert client.post('/configs/code_execution', json=old, headers=people.admin.headers).status_code == 200
        assert _run(settings_from_config()).max_running == SandboxSettings().max_running

    @pytest.mark.parametrize(
        'key, value',
        [
            ('code_interpreter.sandbox.max_running', 99),
            ('code_interpreter.sandbox.default_image', 'other'),
            ('code_interpreter.sandbox.timeout', 301),
            ('code_interpreter.sandbox.idle_minutes', 0),
            ('code_interpreter.sandbox.retention_days', True),
            ('code_interpreter.sandbox.max_workspaces', 0),
        ],
    )
    def test_the_config_import_refuses_what_the_form_would(self, client, people, key, value):
        _run(Config.upsert({key: DEFAULT_CONFIG[key]}))
        r = client.post('/configs/import', json={'config': {key: value}}, headers=people.admin.headers)
        assert r.status_code == 400, r.text
        assert key in r.json()['detail']
        assert _run(Config.get(key)) == DEFAULT_CONFIG[key]

    def test_the_config_import_accepts_good_values_and_null(self, client, people):
        config = {
            'code_interpreter.sandbox.max_running': 2,
            'code_interpreter.sandbox.timeout': None,
            'code_interpreter.sandbox.default_image': 'web',
        }
        r = client.post('/configs/import', json={'config': config}, headers=people.admin.headers)
        assert r.status_code == 200, r.text
        assert _run(Config.get('code_interpreter.sandbox.max_running')) == 2

    @pytest.mark.parametrize(
        'field, value',
        [
            ('CODE_INTERPRETER_SANDBOX_DEFAULT_IMAGE', 'data'),
            ('CODE_INTERPRETER_SANDBOX_TIMEOUT', limits.TIMEOUT_MIN_S),
            ('CODE_INTERPRETER_SANDBOX_TIMEOUT', limits.TIMEOUT_MAX_S),
            ('CODE_INTERPRETER_SANDBOX_MAX_RUNNING', 1),
            ('CODE_INTERPRETER_SANDBOX_MAX_RUNNING', 16),
            ('CODE_INTERPRETER_SANDBOX_IDLE_MINUTES', 1),
            ('CODE_INTERPRETER_SANDBOX_RETENTION_DAYS', 365),
            ('CODE_INTERPRETER_SANDBOX_MAX_WORKSPACES', 1),
            ('CODE_INTERPRETER_SANDBOX_MAX_WORKSPACES', 1000),
        ],
    )
    def test_the_bounds_themselves_are_accepted(self, client, people, field, value):
        r = client.post('/configs/code_execution', json=_form(**{field: value}), headers=people.admin.headers)
        assert r.status_code == 200, r.text

    @pytest.mark.parametrize('field', ['CODE_EXECUTION_ENGINE', 'CODE_INTERPRETER_ENGINE'])
    @pytest.mark.parametrize('engine', ['jupyter', 'pyodide', '', 'SANDBOX', 'other'])
    def test_an_engine_other_than_the_known_ones_is_refused_and_nothing_is_stored(self, client, people, field, engine):
        key = configs_router.CODE_EXECUTION_CONFIG_KEYS[field]
        _run(Config.upsert({key: 'sandbox'}))
        r = client.post('/configs/code_execution', json=_form(**{field: engine}), headers=people.admin.headers)
        assert r.status_code == 422, r.text
        assert _run(Config.get(key)) == 'sandbox'

    @pytest.mark.parametrize('field', ['CODE_EXECUTION_ENGINE', 'CODE_INTERPRETER_ENGINE'])
    def test_the_sandbox_engine_is_accepted_and_stored(self, client, people, field):
        r = client.post('/configs/code_execution', json=_form(**{field: 'sandbox'}), headers=people.admin.headers)
        assert r.status_code == 200, r.text
        assert r.json()[field] == 'sandbox'
        assert _run(Config.get(configs_router.CODE_EXECUTION_CONFIG_KEYS[field])) == 'sandbox'

    def test_the_form_ignores_the_jupyter_fields_an_older_page_posts(self, client, people):
        old = _form(CODE_INTERPRETER_JUPYTER_URL='http://jupyter.invalid', CODE_EXECUTION_JUPYTER_TIMEOUT=60)
        r = client.post('/configs/code_execution', json=old, headers=people.admin.headers)
        assert r.status_code == 200, r.text
        assert 'CODE_INTERPRETER_JUPYTER_URL' not in r.json()
        assert _run(Config.get('code_interpreter.jupyter.url')) is None

    @pytest.mark.parametrize('key', ['code_execution.engine', 'code_interpreter.engine'])
    @pytest.mark.parametrize('engine', ['jupyter', 'pyodide'])
    def test_the_get_still_serves_a_stored_legacy_engine(self, client, people, key, engine):
        _run(Config.upsert({key: engine}))
        r = client.get('/configs/code_execution', headers=people.admin.headers)
        assert r.status_code == 200, r.text
        field = {v: k for k, v in configs_router.CODE_EXECUTION_CONFIG_KEYS.items()}[key]
        assert r.json()[field] == engine

    @pytest.mark.parametrize('key', ['code_execution.engine', 'code_interpreter.engine'])
    @pytest.mark.parametrize('engine', ['jupyter', 'pyodide'])
    def test_the_config_import_refuses_a_legacy_engine(self, client, people, key, engine):
        _run(Config.upsert({key: 'sandbox'}))
        r = client.post('/configs/import', json={'config': {key: engine}}, headers=people.admin.headers)
        assert r.status_code == 422, r.text
        assert key in r.json()['detail']
        assert _run(Config.get(key)) == 'sandbox'

    @pytest.mark.parametrize('key', ['code_execution.engine', 'code_interpreter.engine'])
    def test_the_config_import_accepts_the_sandbox_engine(self, client, people, key):
        r = client.post('/configs/import', json={'config': {key: 'sandbox'}}, headers=people.admin.headers)
        assert r.status_code == 200, r.text
        assert _run(Config.get(key)) == 'sandbox'

    def test_the_config_import_drops_the_removed_jupyter_keys_and_keeps_the_rest(self, client, people, monkeypatch):
        events = []

        async def publish_event(request, name, **kwargs):
            events.append((name, kwargs))

        monkeypatch.setattr(configs_router, 'publish_event', publish_event)
        config = {
            'code_interpreter.jupyter.url': 'http://jupyter.invalid',
            'code_interpreter.jupyter.auth_token': 'secret',
            'code_execution.jupyter.timeout': 60,
            'code_interpreter.jupyterx': 'kept',
            'code_execution.jupyter_url': 'kept too',
            'code_interpreter.sandbox.max_running': 3,
        }
        r = client.post('/configs/import', json={'config': config}, headers=people.admin.headers)
        assert r.status_code == 200, r.text
        dropped = [k for k in config if k.startswith(configs_router.REMOVED_ENGINE_PREFIXES)]
        assert len(dropped) == 3
        for key in dropped:
            assert _run(Config.get(key)) is None
        assert _run(Config.get('code_interpreter.jupyterx')) == 'kept'
        assert _run(Config.get('code_execution.jupyter_url')) == 'kept too'
        assert _run(Config.get('code_interpreter.sandbox.max_running')) == 3
        ((_, kwargs),) = events
        assert sorted(kwargs['data']['keys']) == sorted(k for k in config if k not in dropped)

    def test_a_non_admin_cannot_read_or_write_it(self, client, people):
        assert client.get('/configs/code_execution', headers=people.member.headers).status_code == 401
        r = client.post('/configs/code_execution', json=_form(), headers=people.member.headers)
        assert r.status_code == 401


class TestStatusRoute:
    def test_a_non_admin_is_refused(self, client, people):
        assert client.get('/sandbox/status', headers=people.member.headers).status_code == 401

    def test_no_token_is_refused(self, client):
        assert client.get('/sandbox/status').status_code in (401, 403)

    def test_without_a_manager_it_says_so(self, client, people):
        r = client.get('/sandbox/status', headers=people.admin.headers)
        assert r.status_code == 200
        assert r.json() == {'ready': False, 'reason': 'The sandbox manager is not running'}

    def test_a_ready_backend_is_ready(self, app, client, people):
        app.state.sandbox = SandboxManager(FakeBackend())
        r = client.get('/sandbox/status', headers=people.admin.headers)
        assert r.json() == {'ready': True, 'reason': None}

    def test_a_backend_that_is_not_ready_gives_its_reason(self, app, client, people):
        backend = FakeBackend()
        backend.ready_reason = 'the kata-clh runtime is not registered with Docker'
        app.state.sandbox = SandboxManager(backend)
        r = client.get('/sandbox/status', headers=people.admin.headers)
        assert r.json() == {'ready': False, 'reason': 'the kata-clh runtime is not registered with Docker'}


class TestManagerReady:
    def test_it_passes_the_backend_answer_through(self):
        backend = FakeBackend()
        manager = SandboxManager(backend)
        assert _run(manager.ready()) is None
        backend.ready_reason = 'no Docker'
        assert _run(manager.ready()) == 'no Docker'

    def test_a_backend_that_raises_is_reported_not_raised(self):
        class Broken(FakeBackend):
            async def ready(self):
                raise RuntimeError('socket gone')

        reason = _run(SandboxManager(Broken()).ready())
        assert reason is not None
        assert 'RuntimeError' in reason
        assert 'socket gone' not in reason

    def test_a_backend_that_hangs_is_reported_after_the_deadline(self, monkeypatch):
        class Hung(FakeBackend):
            async def ready(self):
                await asyncio.sleep(60)

        monkeypatch.setattr(manager_module, 'READY_TIMEOUT_S', 0.05)
        reason = _run(SandboxManager(Hung()).ready())
        assert reason == 'The sandbox backend did not answer within 0.05 seconds'
