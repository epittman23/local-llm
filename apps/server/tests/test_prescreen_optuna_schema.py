"""Optuna's studies stay in the `optuna` schema, and the app's migration history in `public`.

Optuna's RDB storage runs its own Alembic migrations against the default
`alembic_version` table, the name this app's history uses too. The
pre-screen confines Optuna to a schema of its own by putting
`search_path=optuna` in the storage URL (benchmarks/prescreen/study.py).
These tests migrate a fresh database the way the backend does, run a full
study, force an Optuna schema upgrade, and check that `public` never sees
any of it.

Needs TEST_DATABASE_URL, like test_schema_drift.py: a throwaway Postgres
with pgvector. CI provides one and fails rather than skips without it.
"""

import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from local_llm.benchmarks.prescreen import PrescreenRefused
from local_llm.benchmarks.prescreen import study as prescreen_study

SERVER_DIR = Path(__file__).resolve().parents[1]

# Optuna's tables, which must never appear in `public`.
OPTUNA_TABLES = {'studies', 'trials', 'version_info', 'trial_values', 'trial_params'}


@pytest.fixture
def migrated_database(tmp_path):
    """A new database on the TEST_DATABASE_URL server, migrated as the backend migrates it."""
    url = os.environ.get('TEST_DATABASE_URL')
    if not url:
        if os.environ.get('CI'):
            pytest.fail('TEST_DATABASE_URL is not set; CI must run this test')
        pytest.skip('set TEST_DATABASE_URL to a throwaway Postgres + pgvector database to run this test')
    name = f'lllm_optuna_{uuid.uuid4().hex[:12]}'
    admin = create_engine(url, isolation_level='AUTOCOMMIT')
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE {name}'))
    database_url = make_url(url).set(database=name).render_as_string(hide_password=False)
    try:
        migrate(database_url, tmp_path)
        yield database_url
    finally:
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS {name} WITH (FORCE)'))
        admin.dispose()


def migrate(database_url: str, data_dir: Path) -> None:
    """`alembic upgrade head` for the app, in a subprocess, as the backend runs it at startup."""
    env = {**os.environ, 'DATABASE_URL': database_url, 'DATA_DIR': str(data_dir), 'HF_HUB_OFFLINE': '1'}
    result = subprocess.run(
        [sys.executable, '-c', 'import local_llm.config'],
        cwd=SERVER_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert result.returncode == 0, result.stderr[-4000:]


def tables(engine, schema: str) -> set[str]:
    with engine.connect() as conn:
        rows = conn.execute(
            text('SELECT table_name FROM information_schema.tables WHERE table_schema = :s'), {'s': schema}
        )
        return {r[0] for r in rows}


def alembic_version(engine, schema: str) -> str:
    with engine.connect() as conn:
        return conn.execute(text(f'SELECT version_num FROM {schema}.alembic_version')).scalar_one()


def run_study(database_url: str, name: str) -> None:
    import optuna

    storage = prescreen_study.open_storage(prescreen_study.storage_url(database_url, None))
    try:
        study = optuna.create_study(
            study_name=name,
            storage=storage,
            sampler=prescreen_study.make_sampler('tpe', 0),
            directions=prescreen_study.directions('tg'),
        )
        dist = prescreen_study.distributions({'LLAMA_NGL': [16, 20, 24]}, {'LLAMA_NGL': 20})
        for value in (5.0, 6.5, 0.0):
            trial = study.ask(dist)
            prescreen_study.mark_feasible(trial, value > 0)
            study.tell(trial, prescreen_study.values('tg', None, value))
        assert len(study.trials) == 3
    finally:
        prescreen_study.close_storage(storage)


def test_a_study_lives_only_in_the_optuna_schema(migrated_database, tmp_path):
    engine = create_engine(migrated_database)
    try:
        app_head = alembic_version(engine, 'public')
        assert tables(engine, 'optuna') == set()  # the migration creates the schema, nothing in it

        run_study(migrated_database, 'prescreen-test')

        assert not OPTUNA_TABLES & tables(engine, 'public')
        assert OPTUNA_TABLES <= tables(engine, 'optuna')
        assert alembic_version(engine, 'public') == app_head

        import optuna

        storage = optuna.storages.RDBStorage(prescreen_study.storage_url(migrated_database, None))
        try:
            assert alembic_version(engine, 'optuna') == storage.get_head_version()
        finally:
            prescreen_study.close_storage(storage)

        # The app's migrations still run cleanly with Optuna's tables beside them.
        migrate(migrated_database, tmp_path)
        assert alembic_version(engine, 'public') == app_head
    finally:
        engine.dispose()


def test_an_older_optuna_schema_is_upgraded_in_its_own_schema(migrated_database):
    """The upgrade path is the one that would escape the schema, if the search path were not in the URL."""
    import optuna

    run_study(migrated_database, 'prescreen-before-upgrade')
    engine = create_engine(migrated_database)
    try:
        app_head = alembic_version(engine, 'public')
        storage = optuna.storages.RDBStorage(prescreen_study.storage_url(migrated_database, None))
        head = storage.get_head_version()
        older = storage._version_manager.get_all_versions()[1]
        prescreen_study.close_storage(storage)
        assert older != head
        with engine.begin() as conn:
            conn.execute(text('UPDATE optuna.alembic_version SET version_num = :v'), {'v': older})

        storage = prescreen_study.open_storage(prescreen_study.storage_url(migrated_database, None))
        try:
            assert storage.get_current_version() == head
            assert optuna.load_study(study_name='prescreen-before-upgrade', storage=storage).trials
        finally:
            prescreen_study.close_storage(storage)

        assert alembic_version(engine, 'optuna') == head
        assert alembic_version(engine, 'public') == app_head
        assert not OPTUNA_TABLES & tables(engine, 'public')
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    ('database_url', 'schema', 'refusal'),
    [
        ('sqlite:///webui.db', None, 'Postgres'),
        ('', None, 'Postgres'),
        ('postgresql://u:p@127.0.0.1/db', 'optuna', 'DATABASE_SCHEMA'),
        ('postgresql://u:p@127.0.0.1/db?options=-csearch_path%3Dpublic', None, 'search_path'),
    ],
)
def test_the_guards_refuse(database_url, schema, refusal):
    with pytest.raises(PrescreenRefused, match=refusal):
        prescreen_study.storage_url(database_url, schema)


def test_the_url_carries_the_search_path_for_optunas_own_alembic():
    url = make_url(prescreen_study.storage_url('postgres://u:p%40ss@127.0.0.1:5432/db?sslmode=disable', None))
    assert url.drivername == 'postgresql+psycopg'
    assert url.password == 'p@ss'
    assert url.query['options'] == '-csearch_path=optuna'
    assert url.query['sslmode'] == 'disable'


def test_the_dashboard_serves_the_studies_on_loopback_and_stops_cleanly(migrated_database, tmp_path):
    import asyncio
    import json
    import socket
    import time
    import urllib.request

    import psutil

    from local_llm.benchmarks.prescreen.dashboard import DashboardProcess

    run_study(migrated_database, 'prescreen-dashboard')
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
    handle = DashboardProcess(tmp_path / 'dash.pid', port=port, cwd=str(SERVER_DIR))

    def studies(port):
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/studies', timeout=2) as r:
            return json.loads(r.read())

    async def scenario():
        await handle.start({**os.environ, 'DATABASE_URL': migrated_database})
        pid = handle.pid()
        try:
            deadline = time.monotonic() + 60
            body = None
            while time.monotonic() < deadline:
                try:
                    body = await asyncio.to_thread(studies, port)
                    break
                except OSError:
                    await asyncio.sleep(0.5)
            assert body is not None, 'the dashboard never answered'
            assert [s['study_name'] for s in body['study_summaries']] == ['prescreen-dashboard']
            listening = [c.laddr for c in psutil.Process(pid).net_connections() if c.status == psutil.CONN_LISTEN]
            assert listening and all(addr.ip == '127.0.0.1' for addr in listening)
            # The password reaches it through the environment, not the command line.
            assert make_url(migrated_database).password not in ' '.join(psutil.Process(pid).cmdline())
        finally:
            assert await handle.stop() is True
        return pid

    pid = asyncio.run(scenario())
    assert not psutil.pid_exists(pid) or psutil.Process(pid).status() == psutil.STATUS_ZOMBIE
    assert not (tmp_path / 'dash.pid').exists()
