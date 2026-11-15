"""Revision c17c2aeb2577 turns the Arena model and message rating off (#990, #995).

Migrates a fresh Postgres database to the revision before it (52b5a00a0e74),
inserts `config` rows the way the app stores them (JSON values), upgrades,
and reads the rows back. The config defaults themselves are checked in a
subprocess, so the environment they read is the test's own.

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
BEFORE = '52b5a00a0e74'
REVISION = 'c17c2aeb2577'
ARENA = 'evaluation.arena.enable'
RATING = 'ui.enable_message_rating'
OLD_TIME = 1_000_000

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

DEFAULTS = r"""
import json
from local_llm import config
print(json.dumps([
    config.ENABLE_EVALUATION_ARENA_MODELS,
    config.DEFAULT_CONFIG['evaluation.arena.enable'],
    config.ENABLE_MESSAGE_RATING,
    config.DEFAULT_CONFIG['ui.enable_message_rating'],
]))
"""


def _defaults(tmp_path, **env_overrides) -> list:
    env = {k: v for k, v in os.environ.items() if k not in ('ENABLE_EVALUATION_ARENA_MODELS', 'ENABLE_MESSAGE_RATING')}
    env.update({'DATA_DIR': str(tmp_path), 'HF_HUB_OFFLINE': '1', 'ENABLE_DB_MIGRATIONS': 'false', **env_overrides})
    env.setdefault('LLLM_SECRET_KEY', 'test-only-not-a-secret-0123456789abcdef')
    result = subprocess.run(
        [sys.executable, '-c', DEFAULTS],
        cwd=SERVER_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert result.returncode == 0, result.stderr[-4000:]
    return json.loads(result.stdout.strip().splitlines()[-1])


def test_both_default_to_off(tmp_path):
    assert _defaults(tmp_path) == [False, False, False, False]


def test_the_environment_still_turns_them_on(tmp_path):
    on = _defaults(tmp_path, ENABLE_EVALUATION_ARENA_MODELS='true', ENABLE_MESSAGE_RATING='True')
    assert on == [True, True, True, True]


@pytest.fixture
def database_url():
    """A new database on the TEST_DATABASE_URL server, dropped afterwards."""
    url = os.environ.get('TEST_DATABASE_URL')
    if not url:
        if os.environ.get('CI'):
            pytest.fail('TEST_DATABASE_URL is not set; CI must run this test')
        pytest.skip('set TEST_DATABASE_URL to a throwaway Postgres + pgvector database to run this test')
    name = f'lllm_arena_rating_{uuid.uuid4().hex[:12]}'
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


def put(engine, values: dict) -> None:
    with engine.begin() as conn:
        for key, value in values.items():
            conn.execute(
                text('INSERT INTO config (key, value, updated_at) VALUES (:k, CAST(:v AS json), :t)'),
                {'k': key, 'v': json.dumps(value), 't': OLD_TIME},
            )


def rows(engine) -> dict:
    with engine.connect() as conn:
        return {k: (v, t) for k, v, t in conn.execute(text('SELECT key, value, updated_at FROM config'))}


def test_both_are_cleared_when_on_so_they_reseed_off(engine, alembic):
    put(engine, {ARENA: True, RATING: True, 'ui.enable_signup': True})
    alembic('upgrade', REVISION)
    assert rows(engine) == {'ui.enable_signup': (True, OLD_TIME)}


def test_one_on_and_one_off(engine, alembic):
    put(engine, {ARENA: False, RATING: True})
    alembic('upgrade', REVISION)
    assert rows(engine) == {ARENA: (False, OLD_TIME)}


@pytest.mark.parametrize('kept', [False, None, 'true', 1])
def test_anything_but_true_is_kept(engine, alembic, kept):
    put(engine, {ARENA: kept, RATING: kept})
    alembic('upgrade', REVISION)
    assert rows(engine) == {ARENA: (kept, OLD_TIME), RATING: (kept, OLD_TIME)}


def test_a_database_without_the_rows_is_left_alone(engine, alembic):
    put(engine, {'ui.enable_signup': False})
    alembic('upgrade', REVISION)
    assert rows(engine) == {'ui.enable_signup': (False, OLD_TIME)}


def test_running_the_upgrade_again_changes_nothing(engine, alembic):
    put(engine, {ARENA: True, RATING: True})
    alembic('upgrade', REVISION)
    alembic('stamp', BEFORE)
    put(engine, {ARENA: False})
    alembic('upgrade', REVISION)
    assert rows(engine) == {ARENA: (False, OLD_TIME)}


def test_downgrade_restores_nothing(engine, alembic):
    put(engine, {ARENA: True, RATING: True})
    alembic('upgrade', REVISION)
    alembic('downgrade', BEFORE)
    assert rows(engine) == {}
