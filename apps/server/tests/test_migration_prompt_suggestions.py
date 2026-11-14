"""Revision 52b5a00a0e74 clears Open WebUI's stock prompt suggestions, and only those (#1065).

Migrates a fresh Postgres database to the revision before it (807e3e98e4af),
inserts a `ui.prompt_suggestions` row the way the app stores it (a JSON
value), upgrades, and reads the rows back. The config default itself is
checked in a subprocess, so the environment it reads is the test's own.

Needs TEST_DATABASE_URL, like test_schema_drift.py: a throwaway Postgres
with pgvector. CI provides one and fails rather than skips without it.
"""

import copy
import importlib.util
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
BEFORE = '807e3e98e4af'
REVISION = '52b5a00a0e74'
KEY = 'ui.prompt_suggestions'
OLD_TIME = 1_000_000

_spec = importlib.util.spec_from_file_location(
    'clear_stock_prompt_suggestions',
    SERVER_DIR / 'local_llm' / 'migrations' / 'versions' / f'{REVISION}_clear_stock_prompt_suggestions.py',
)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
STOCK = _module.STOCK_PROMPT_SUGGESTIONS

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
print(json.dumps([config.DEFAULT_PROMPT_SUGGESTIONS, config.DEFAULT_CONFIG['ui.prompt_suggestions']]))
"""


def test_the_stock_list_is_the_one_open_webui_shipped():
    assert len(STOCK) == 6
    assert STOCK[0]['title'] == ['Help me study', 'vocabulary for a college entrance exam']
    assert STOCK[2]['content'] == 'Tell me a random fun fact about the Roman Empire'


def _defaults(tmp_path, **env_overrides) -> list:
    env = {k: v for k, v in os.environ.items() if k != 'DEFAULT_PROMPT_SUGGESTIONS'}
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


def test_the_default_is_no_suggestions(tmp_path):
    assert _defaults(tmp_path) == [[], []]


def test_an_explicit_empty_list_stays_empty(tmp_path):
    assert _defaults(tmp_path, DEFAULT_PROMPT_SUGGESTIONS='[]') == [[], []]


def test_the_environment_still_sets_suggestions(tmp_path):
    mine = [{'title': ['Fit a regression', 'to this CSV'], 'content': 'Fit a regression to this CSV.'}]
    assert _defaults(tmp_path, DEFAULT_PROMPT_SUGGESTIONS=json.dumps(mine)) == [mine, mine]


@pytest.fixture
def database_url():
    """A new database on the TEST_DATABASE_URL server, dropped afterwards."""
    url = os.environ.get('TEST_DATABASE_URL')
    if not url:
        if os.environ.get('CI'):
            pytest.fail('TEST_DATABASE_URL is not set; CI must run this test')
        pytest.skip('set TEST_DATABASE_URL to a throwaway Postgres + pgvector database to run this test')
    name = f'lllm_suggestions_{uuid.uuid4().hex[:12]}'
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


def put(engine, rows: dict, spelling=json.dumps) -> None:
    with engine.begin() as conn:
        for key, value in rows.items():
            conn.execute(
                text('INSERT INTO config (key, value, updated_at) VALUES (:k, CAST(:v AS json), :t)'),
                {'k': key, 'v': spelling(value), 't': OLD_TIME},
            )


def rows(engine) -> dict:
    with engine.connect() as conn:
        return {k: (v, t) for k, v, t in conn.execute(text('SELECT key, value, updated_at FROM config'))}


def test_the_stock_list_is_cleared(engine, alembic):
    put(engine, {KEY: STOCK, 'ui.enable_signup': False})
    alembic('upgrade', REVISION)
    assert rows(engine) == {'ui.enable_signup': (False, OLD_TIME)}


def test_the_stock_list_is_cleared_whatever_its_json_spelling(engine, alembic):
    put(engine, {KEY: STOCK}, spelling=lambda v: json.dumps(v, indent=2, ensure_ascii=True, sort_keys=True))
    alembic('upgrade', REVISION)
    assert rows(engine) == {}


def _edited_lists():
    reordered = list(reversed(STOCK))
    one_removed = STOCK[:-1]
    one_added = [*STOCK, {'title': ['Fit a regression', 'to this CSV'], 'content': 'Fit a regression.'}]
    one_word = copy.deepcopy(STOCK)
    one_word[0]['content'] += ' Please.'
    return {'reordered': reordered, 'one removed': one_removed, 'one added': one_added, 'one word': one_word}


@pytest.mark.parametrize('name', list(_edited_lists()))
def test_an_edited_list_is_kept(engine, alembic, name):
    edited = _edited_lists()[name]
    put(engine, {KEY: edited})
    alembic('upgrade', REVISION)
    assert rows(engine) == {KEY: (edited, OLD_TIME)}


@pytest.mark.parametrize('kept', [[], None, 'text'])
def test_other_values_are_kept(engine, alembic, kept):
    put(engine, {KEY: kept})
    alembic('upgrade', REVISION)
    assert rows(engine) == {KEY: (kept, OLD_TIME)}


def test_a_database_without_the_row_is_left_alone(engine, alembic):
    put(engine, {'ui.enable_signup': True})
    alembic('upgrade', REVISION)
    assert rows(engine) == {'ui.enable_signup': (True, OLD_TIME)}


def test_running_the_upgrade_again_changes_nothing(engine, alembic):
    put(engine, {KEY: STOCK})
    alembic('upgrade', REVISION)
    alembic('stamp', BEFORE)
    put(engine, {'ui.enable_signup': True})
    alembic('upgrade', REVISION)
    assert rows(engine) == {'ui.enable_signup': (True, OLD_TIME)}


def test_downgrade_restores_nothing(engine, alembic):
    put(engine, {KEY: STOCK})
    alembic('upgrade', REVISION)
    alembic('downgrade', BEFORE)
    assert rows(engine) == {}
