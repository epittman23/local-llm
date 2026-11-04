"""Profile edits that race each other end in a clean refusal (#152, #153).

`BenchmarkProfiles` (models/benchmarks/profiles.py) keeps two rules that two
admin requests can break by interleaving (a double click, two tabs):

- the default profile is never archived (#152). `archive` read `is_default`
  and then wrote `archived_at`, and `set_default` read `archived_at` and then
  wrote `is_default`, so interleaved they left a profile both default and
  archived, and `get_default()` found none. Each is now one UPDATE whose WHERE
  carries the other flag, which Postgres re-checks against the committed row;
  when it matches nothing, the transaction rolls back and a read says why.
- a name is taken once, and a version number once (#153). The insert that
  loses the race on the unique constraint raised IntegrityError, which the
  router did not map, so the loser got a 500. It is now ProfileConflict, which
  the router answers with 409.

The benchmark tables live in Postgres only, so the model is run against a
fake session that records each statement; the router is run with the model
stubbed, as test_profiles_router.py does.

Run from apps/server:

    python -m pytest tests/test_profile_concurrency.py
"""

from __future__ import annotations

import asyncio
import contextlib
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError

from local_llm.benchmarks.serving.profiles import ProfileConflict, ProfileError
from local_llm.models.benchmarks import profiles as profiles_model
from local_llm.routers.benchmarks import profiles as profiles_router
from local_llm.utils.auth import get_admin_user

DEFINITION = {
    'arch': 'dense',
    'alias': 'qwen2.5-coder-7b',
    'model_path': '{LLAMA_MODELS}/qwen25-coder-7b/x.gguf',
    'ctx': 16384,
    'threads': 6,
    'ngl': 99,
}


class FakeSession:
    """Records statements; UPDATEs match `updated` rows; a SELECT returns `row`."""

    def __init__(
        self,
        *,
        row=None,
        updated=1,
        commit_error: Exception | None = None,
        flush_error: Exception | None = None,
        execute_error: Exception | None = None,
        max_version=1,
    ):
        self.row, self.updated, self.commit_error, self.max_version = row, updated, commit_error, max_version
        self.flush_error, self.execute_error = flush_error, execute_error
        self.statements: list[str] = []
        self.added: list = []
        self.committed = self.rolled_back = False

    async def execute(self, statement):
        sql = str(statement.compile(compile_kwargs={'literal_binds': True}))
        self.statements.append(sql)
        if self.execute_error and 'is_default=true' in sql.replace(' ', ''):
            raise self.execute_error
        if sql.lstrip().upper().startswith('UPDATE'):
            return SimpleNamespace(rowcount=self.updated)
        return SimpleNamespace(scalars=lambda: SimpleNamespace(first=lambda: self.row), scalar=lambda: self.max_version)

    def add(self, obj):
        self.added.append(obj)

    async def flush(self):
        if self.flush_error:
            raise self.flush_error
        for obj in self.added:
            if getattr(obj, 'profile_id', None) is None:
                obj.profile_id = 7

    async def commit(self):
        if self.commit_error:
            raise self.commit_error
        self.committed = True

    async def rollback(self):
        self.rolled_back = True

    async def refresh(self, obj):
        return None


@pytest.fixture
def session(monkeypatch):
    holder = {}

    def use(**kwargs):
        holder['session'] = FakeSession(**kwargs)
        return holder['session']

    @contextlib.asynccontextmanager
    async def context(db=None):
        yield holder['session']

    monkeypatch.setattr(profiles_model, 'get_async_db_context', context)
    return use


def _updates(s: FakeSession) -> list[str]:
    return [sql for sql in s.statements if sql.lstrip().upper().startswith('UPDATE')]


# --- archive and set_default (#152) -------------------------------------------


def test_archive_writes_only_while_the_profile_is_not_the_default(session):
    s = session(updated=1)

    asyncio.run(profiles_model.BenchmarkProfiles.archive(3))

    (archive,) = _updates(s)
    assert 'archived_at' in archive
    assert 'is_default IS false' in archive or 'is_default = false' in archive
    assert s.committed


def test_archive_refuses_a_profile_that_became_the_default_first(session):
    s = session(updated=0, row=SimpleNamespace(is_default=True, archived_at=None))

    with pytest.raises(ProfileError, match='default profile cannot be archived'):
        asyncio.run(profiles_model.BenchmarkProfiles.archive(3))

    assert s.rolled_back and not s.committed


def test_archive_of_a_missing_profile_says_so(session):
    session(updated=0, row=None)

    with pytest.raises(ProfileError, match='no benchmark profile with id 3'):
        asyncio.run(profiles_model.BenchmarkProfiles.archive(3))


def test_set_default_writes_only_while_the_profile_is_not_archived(session):
    s = session(updated=1)

    asyncio.run(profiles_model.BenchmarkProfiles.set_default(3))

    clear, make_default = _updates(s)
    assert 'is_default=false' in clear.replace(' ', '')
    assert 'archived_at IS NULL' in make_default
    assert s.committed


def test_set_default_refuses_a_profile_archived_first_and_keeps_the_old_default(session):
    s = session(updated=0, row=SimpleNamespace(is_default=False, archived_at=1_800_000_000))

    with pytest.raises(ProfileError, match='archived profile cannot be the default'):
        asyncio.run(profiles_model.BenchmarkProfiles.set_default(3))

    # The rollback undoes clearing the old default too.
    assert s.rolled_back and not s.committed


def test_set_default_of_a_missing_profile_says_so(session):
    session(updated=0, row=None)

    with pytest.raises(ProfileError, match='no benchmark profile with id 3'):
        asyncio.run(profiles_model.BenchmarkProfiles.set_default(3))


# --- create and add_version (#153) ---------------------------------------------


class _DbError(Exception):
    def __init__(self, message: str, sqlstate: str):
        super().__init__(message)
        self.sqlstate = sqlstate


def _integrity_error(sqlstate: str = '23505') -> IntegrityError:
    return IntegrityError('INSERT', {}, _DbError('duplicate key value violates unique constraint', sqlstate))


def test_a_create_that_loses_the_race_for_its_name_is_a_conflict(session):
    # The unique name fails on the profile's own INSERT, at flush.
    s = session(flush_error=_integrity_error())

    with pytest.raises(ProfileConflict, match="'qwen25c' already exists"):
        asyncio.run(profiles_model.BenchmarkProfiles.create(name='qwen25c', display_name='Q', definition=DEFINITION))

    assert s.rolled_back


def test_an_edit_that_loses_the_race_for_its_version_number_is_a_conflict(session):
    s = session(commit_error=_integrity_error())

    with pytest.raises(ProfileConflict, match='another edit'):
        asyncio.run(profiles_model.BenchmarkProfiles.add_version(3, definition=DEFINITION))

    assert s.rolled_back


def test_a_failure_that_is_not_a_unique_violation_is_not_called_a_conflict(session):
    check_violation = _integrity_error(sqlstate='23514')
    s = session(commit_error=check_violation)

    with pytest.raises(IntegrityError) as raised:
        asyncio.run(profiles_model.BenchmarkProfiles.add_version(3, definition=DEFINITION))

    assert raised.value is check_violation
    assert s.rolled_back


def test_a_set_default_that_loses_the_race_to_another_is_a_conflict(session):
    s = session(execute_error=_integrity_error())

    with pytest.raises(ProfileConflict, match='made the default at the same time'):
        asyncio.run(profiles_model.BenchmarkProfiles.set_default(3))

    assert s.rolled_back and not s.committed


def test_a_set_default_failing_otherwise_is_raised_as_it_is(session):
    session(execute_error=_integrity_error(sqlstate='23503'))

    with pytest.raises(IntegrityError):
        asyncio.run(profiles_model.BenchmarkProfiles.set_default(3))


def test_the_router_answers_a_conflict_with_409(monkeypatch):
    app = FastAPI()
    app.include_router(profiles_router.router)
    app.dependency_overrides[get_admin_user] = lambda: SimpleNamespace(id='admin-1')
    entry = SimpleNamespace(profile=SimpleNamespace(profile_id=3))

    async def no_profile(name):
        return None

    async def existing(name):
        return entry

    async def conflict(*_a, **_k):
        raise ProfileConflict('another edit of this profile was saved first; reload it and try again')

    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'create', conflict)
    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'add_version', conflict)
    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'set_default', conflict)
    client = TestClient(app)

    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'get_by_name', no_profile)
    created = client.post('/', json={'name': 'qwen25c', 'display_name': 'Q', 'definition': DEFINITION})
    assert created.status_code == 409

    monkeypatch.setattr(profiles_router, '_get_or_404', existing)
    edited = client.post('/qwen25c/versions', json={'definition': DEFINITION})
    assert edited.status_code == 409
    assert 'another edit' in edited.json()['detail']

    entry.version = SimpleNamespace(version=1, model_dump=lambda exclude=None: dict(DEFINITION))
    cloned = client.post('/qwen25c/clone', json={'name': 'qwen25c-copy', 'display_name': 'Q copy'})
    assert cloned.status_code == 409

    assert client.post('/qwen25c/default').status_code == 409
