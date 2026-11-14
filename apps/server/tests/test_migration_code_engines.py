"""Revision 807e3e98e4af moves the code engines to `sandbox` and drops the Jupyter keys.

Migrates a fresh Postgres database to the revision before it (2c8cdc04929d),
inserts `config` rows the way the app stores them (a JSON value), upgrades,
and reads the rows back. See docs/plans/sandbox-implementation.md, T43.

Needs TEST_DATABASE_URL, like test_schema_drift.py: a throwaway Postgres
with pgvector. CI provides one and fails rather than skips without it.
"""

import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

SERVER_DIR = Path(__file__).resolve().parents[1]
BEFORE = '2c8cdc04929d'
REVISION = '807e3e98e4af'
OLD_TIME = 1_000_000
ENGINE_KEYS = ('code_interpreter.engine', 'code_execution.engine')

# Runs in a subprocess, so the migrations run in a process with its own DATABASE_URL.
ALEMBIC = r"""
import sys
from alembic import command
from alembic.config import Config
from local_llm.env import PACKAGE_DIR

cfg = Config(str(PACKAGE_DIR / 'alembic.ini'))
cfg.set_main_option('script_location', str(PACKAGE_DIR / 'migrations'))
action, revision = sys.argv[1:3]
getattr(command, action)(cfg, revision)
"""


@pytest.fixture
def database_url():
    """A new database on the TEST_DATABASE_URL server, dropped afterwards."""
    url = os.environ.get('TEST_DATABASE_URL')
    if not url:
        if os.environ.get('CI'):
            pytest.fail('TEST_DATABASE_URL is not set; CI must run this test')
        pytest.skip('set TEST_DATABASE_URL to a throwaway Postgres + pgvector database to run this test')
    name = f'lllm_engines_{uuid.uuid4().hex[:12]}'
    admin = create_engine(url, isolation_level='AUTOCOMMIT')
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE {name}'))
    try:
        yield make_url(url).set(database=name).render_as_string(hide_password=False)
    finally:
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS {name} WITH (FORCE)'))
        admin.dispose()


@pytest.fixture
def alembic(database_url, tmp_path):
    def run(action: str, revision: str) -> None:
        env = {
            **os.environ,
            'DATABASE_URL': database_url,
            'DATA_DIR': str(tmp_path),
            'HF_HUB_OFFLINE': '1',
            'ENABLE_DB_MIGRATIONS': 'false',
        }
        result = subprocess.run(
            [sys.executable, '-c', ALEMBIC, action, revision],
            cwd=SERVER_DIR,
            env=env,
            capture_output=True,
            text=True,
            timeout=600,
        )
        assert result.returncode == 0, result.stderr[-4000:]

    return run


@pytest.fixture
def engine(database_url, alembic):
    alembic('upgrade', BEFORE)
    engine = create_engine(database_url)
    yield engine
    engine.dispose()


def put(engine, rows: dict) -> None:
    with engine.begin() as conn:
        for key, value in rows.items():
            conn.execute(
                text('INSERT INTO config (key, value, updated_at) VALUES (:k, CAST(:v AS json), :t)'),
                {'k': key, 'v': json.dumps(value), 't': OLD_TIME},
            )


def rows(engine) -> dict:
    with engine.connect() as conn:
        return {k: (v, t) for k, v, t in conn.execute(text('SELECT key, value, updated_at FROM config'))}


def values(engine) -> dict:
    return {k: v for k, (v, _) in rows(engine).items()}


@pytest.mark.parametrize('key', ENGINE_KEYS)
@pytest.mark.parametrize('old', ['jupyter', 'pyodide'])
def test_removed_engine_becomes_sandbox(engine, alembic, key, old):
    put(engine, {key: old})
    alembic('upgrade', REVISION)
    assert values(engine) == {key: 'sandbox'}


@pytest.mark.parametrize('key', ENGINE_KEYS)
@pytest.mark.parametrize('kept', ['sandbox', 'other', ''])
def test_other_engine_value_is_unchanged(engine, alembic, key, kept):
    put(engine, {key: kept})
    alembic('upgrade', REVISION)
    assert rows(engine) == {key: (kept, OLD_TIME)}


def test_absent_engine_key_is_not_created(engine, alembic):
    put(engine, {'code_interpreter.enable': True})
    alembic('upgrade', REVISION)
    assert values(engine) == {'code_interpreter.enable': True}


@pytest.mark.parametrize('prefix', ['code_interpreter', 'code_execution'])
@pytest.mark.parametrize('suffix', ['url', 'auth', 'auth_token', 'auth_password', 'timeout'])
def test_jupyter_key_is_deleted(engine, alembic, prefix, suffix):
    put(engine, {f'{prefix}.jupyter.{suffix}': 'x', f'{prefix}.engine': 'sandbox'})
    alembic('upgrade', REVISION)
    assert values(engine) == {f'{prefix}.engine': 'sandbox'}


def test_keys_that_only_resemble_the_jupyter_prefixes_are_kept(engine, alembic):
    near_misses = {
        'code_interpreter.jupyterx': 1,
        'code_interpreter.jupyterx.url': 2,
        'codeXinterpreter.jupyter.url': 3,
        'code_executionX.jupyter.url': 4,
        'code_interpreter.sandbox.image': 5,
        'xcode_interpreter.jupyter.url': 6,
        'code_interpreter%jupyter.url': 7,
        'code_execution.jupyter': 8,
    }
    put(engine, near_misses)
    alembic('upgrade', REVISION)
    assert values(engine) == near_misses


def test_updated_at_changes_only_on_rows_the_upgrade_updates(engine, alembic):
    put(
        engine,
        {
            'code_interpreter.engine': 'jupyter',
            'code_execution.engine': 'other',
            'code_interpreter.sandbox.image': 'img',
        },
    )
    alembic('upgrade', REVISION)
    after = rows(engine)
    assert after['code_interpreter.engine'][1] > OLD_TIME
    assert after['code_execution.engine'] == ('other', OLD_TIME)
    assert after['code_interpreter.sandbox.image'] == ('img', OLD_TIME)


def test_running_the_upgrade_again_changes_nothing(engine, alembic):
    put(
        engine,
        {
            'code_interpreter.engine': 'jupyter',
            'code_execution.engine': 'pyodide',
            'code_interpreter.jupyter.url': 'http://j',
            'code_execution.jupyter.timeout': 60,
            'code_interpreter.sandbox.image': 'img',
        },
    )
    alembic('upgrade', REVISION)
    first = rows(engine)
    alembic('stamp', BEFORE)
    alembic('upgrade', REVISION)
    assert rows(engine) == first
    assert set(first) == {'code_interpreter.engine', 'code_execution.engine', 'code_interpreter.sandbox.image'}


@pytest.mark.parametrize('key', ENGINE_KEYS)
def test_downgrade_sets_sandbox_engine_back_to_jupyter(engine, alembic, key):
    put(engine, {key: 'jupyter'})
    alembic('upgrade', REVISION)
    alembic('downgrade', BEFORE)
    assert values(engine) == {key: 'jupyter'}


@pytest.mark.parametrize('kept', ['other', 'pyodide', 'jupyter'])
def test_downgrade_leaves_other_values_alone(engine, alembic, kept):
    alembic('upgrade', REVISION)
    put(engine, {'code_interpreter.engine': kept, 'code_interpreter.sandbox.image': 'img'})
    alembic('downgrade', BEFORE)
    assert rows(engine) == {
        'code_interpreter.engine': (kept, OLD_TIME),
        'code_interpreter.sandbox.image': ('img', OLD_TIME),
    }
