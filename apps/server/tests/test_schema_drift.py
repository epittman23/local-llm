"""The models and the migrations describe the same schema, give or take a known list.

Migrations are what build the database (run at startup, append-only); the
SQLAlchemy models are what the code queries. A model change without a
migration passes every other test, because the suite builds its SQLite
schema from the same migrations and never compares, and then fails against
the real database. This migrates a fresh Postgres database, compares every
model against it with Alembic's autogenerate, and checks the differences
against `fixtures/schema_drift.json`.

That file is the drift inherited from upstream when this was added
(2026-10-23, 108 differences: unique flags on primary keys, indexes the
migrations create but the models don't declare, nullability, three legacy
tables). It may only shrink: fix a model to match its migration, or add a
migration, and remove the line. A new difference fails here. To rewrite the
file after such a fix, run with SCHEMA_DRIFT_RECORD=1. The PR gate lets it
shrink without approval and trips if it grows (SHRINK_ONLY in
.github/scripts/pr_gate.py).

Needs TEST_DATABASE_URL, like test_imports.py: a throwaway Postgres with
pgvector. CI provides one and fails rather than skips without it.
"""

import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

SERVER_DIR = Path(__file__).resolve().parents[1]
BASELINE = Path(__file__).parent / 'fixtures' / 'schema_drift.json'

# Runs in a subprocess, so the migrations and the model imports happen in a
# process with its own DATABASE_URL and DATA_DIR.
COMPARE = r"""
import importlib, json, pkgutil, re
import local_llm.config  # runs the migrations on DATABASE_URL
import local_llm.models as models
for module in pkgutil.walk_packages(models.__path__, 'local_llm.models.'):
    importlib.import_module(module.name)
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import create_engine
from local_llm.env import DATABASE_URL
from local_llm.internal.db import Base


def columns(item):
    return ','.join(sorted(c.name for c in getattr(item, 'columns', []) if hasattr(c, 'name')))


def table_of(item):
    table = getattr(item, 'table', None)
    return getattr(table, 'name', '?')


def describe(diff):
    if isinstance(diff, list):  # modify_* on one column
        kind, _, table, column, _, old, new = diff[0]
        if kind == 'modify_default':
            return f'{kind} {table}.{column}'
        return f'{kind} {table}.{column} {old} -> {new}'
    kind, obj = diff[0], diff[-1]
    if kind in ('add_table', 'remove_table'):
        return f'{kind} {obj.name}'
    if kind in ('add_column', 'remove_column'):
        return f'{kind} {diff[2]}.{obj.name}'
    if kind in ('add_index', 'remove_index'):
        unique = ' unique' if obj.unique else ''
        return f'{kind} {table_of(obj)}.{obj.name}({columns(obj)}){unique}'
    if kind in ('add_constraint', 'remove_constraint', 'add_fk', 'remove_fk'):
        return f'{kind} {table_of(obj)} {type(obj).__name__}({columns(obj)}) {obj.name or ""}'.rstrip()
    return re.sub(r' at 0x[0-9a-f]+', '', f'{kind} {obj!r}')


with create_engine(DATABASE_URL).connect() as connection:
    diffs = compare_metadata(MigrationContext.configure(connection), Base.metadata)
print('DRIFT ' + json.dumps(sorted(describe(d) for d in diffs)))
"""


@pytest.fixture
def fresh_database():
    """A new, empty database on the TEST_DATABASE_URL server, dropped afterwards."""
    url = os.environ.get('TEST_DATABASE_URL')
    if not url:
        if os.environ.get('CI'):
            pytest.fail('TEST_DATABASE_URL is not set; CI must run this test')
        pytest.skip('set TEST_DATABASE_URL to a throwaway Postgres + pgvector database to run this test')
    name = f'lllm_drift_{uuid.uuid4().hex[:12]}'
    admin = create_engine(url, isolation_level='AUTOCOMMIT')
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE {name}'))
    try:
        yield make_url(url).set(database=name).render_as_string(hide_password=False)
    finally:
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS {name} WITH (FORCE)'))
        admin.dispose()


def test_models_match_the_migrations(fresh_database, tmp_path):
    env = {**os.environ, 'DATABASE_URL': fresh_database, 'DATA_DIR': str(tmp_path), 'HF_HUB_OFFLINE': '1'}
    result = subprocess.run(
        [sys.executable, '-c', COMPARE], cwd=SERVER_DIR, env=env, capture_output=True, text=True, timeout=600
    )
    assert result.returncode == 0, result.stderr[-4000:]
    line = next(line for line in result.stdout.splitlines() if line.startswith('DRIFT '))
    drift = json.loads(line.removeprefix('DRIFT '))

    if os.environ.get('SCHEMA_DRIFT_RECORD') == '1':
        BASELINE.write_text(json.dumps(drift, indent=2) + '\n')
    baseline = json.loads(BASELINE.read_text())

    new = sorted(set(drift) - set(baseline))
    fixed = sorted(set(baseline) - set(drift))
    message = []
    if new:
        message.append(
            'The models and the migrations disagree in new ways. Add a migration for the model '
            'change, or change the model to match the migrations:\n  ' + '\n  '.join(new)
        )
    if fixed:
        message.append(
            'These known differences are gone; record the smaller baseline with '
            'SCHEMA_DRIFT_RECORD=1:\n  ' + '\n  '.join(fixed)
        )
    assert not message, '\n\n'.join(message)
    assert not re.search(r' at 0x[0-9a-f]+', line)  # descriptions are stable across runs
