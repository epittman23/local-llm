"""Setting the password of a SCIM-created user takes effect (#296).

SCIM created users without the credentials row every other way of creating a
user makes, so an admin's password reset for one wrote nothing, and the route
still said it had (and announced AUTH_PASSWORD_CHANGED). SCIM now creates the
credentials, with a random password nobody knows, as an OAuth sign-up does;
setting a password creates them for a user who has none (one SCIM created
before this); and the route refuses when the write changes nothing. A
migration gives every user who still has no credentials row one, with a
random password nobody knows (#627).

Runs against the test run's migrated SQLite database.

Run from apps/server:

    python -m pytest tests/test_scim_user_password.py
"""

import asyncio
import importlib
import importlib.util
import uuid
from functools import partial
from pathlib import Path
from types import SimpleNamespace

import bcrypt
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from local_llm.internal.db import engine, get_async_db, get_async_session
from local_llm.models.auths import Auth, Auths
from local_llm.models.users import Users
from local_llm.routers import scim
from local_llm.utils.auth import get_password_hash

# Importing the config runs the migrations on the test run's database.
importlib.import_module('local_llm.config')


def _run(coro):
    return asyncio.run(coro)


async def _credentials(user_id):
    async with get_async_db() as db:
        return await db.get(Auth, user_id)


def test_a_user_without_credentials_gets_them_when_a_password_is_set():
    tag = uuid.uuid4().hex[:8]
    email = f'scim-old-{tag}@example.invalid'
    # As SCIM created users before this fix: a user row only.
    user = _run(Users.insert_new_user(f'scim-old-{tag}', 'Old', email, role='user'))
    assert _run(_credentials(user.id)) is None

    assert _run(Auths.update_user_password_by_id(user.id, _run(get_password_hash('a-new-one-1')))) is True

    credentials = _run(_credentials(user.id))
    assert credentials is not None and credentials.email == email and credentials.active


def test_setting_the_password_of_no_user_reports_it():
    assert _run(Auths.update_user_password_by_id(f'nobody-{uuid.uuid4().hex[:8]}', 'x')) is False


def test_scim_creates_the_users_credentials(monkeypatch):
    async def publish(*_a, **_k):
        return None

    monkeypatch.setattr(scim, 'publish_event', publish)
    monkeypatch.setattr(scim, 'SCIM_AUTH_PROVIDER', 'oidc')
    app = FastAPI()
    app.include_router(scim.router, prefix='/scim/v2')
    app.dependency_overrides[scim.get_scim_auth] = lambda: True
    app.dependency_overrides[get_async_session] = lambda: None
    tag = uuid.uuid4().hex[:8]

    r = TestClient(app).post(
        '/scim/v2/Users',
        json={'userName': f'scim-{tag}@example.invalid', 'displayName': 'Sam', 'emails': []},
    )

    assert r.status_code == 201, r.text
    credentials = _run(_credentials(r.json()['id']))
    assert credentials is not None and credentials.email == f'scim-{tag}@example.invalid'


def test_a_row_made_meanwhile_by_another_request_gets_the_password(monkeypatch):
    """Two resets at once for a user with no credentials: the second sets the first's row."""
    tag = uuid.uuid4().hex[:8]
    user = _run(Users.insert_new_user(f'scim-race-{tag}', 'Race', f'scim-race-{tag}@example.invalid', role='user'))
    real_get = AsyncSession.get
    raced = []

    async def get_after_a_competing_reset(self, model, ident, *args, **kwargs):
        found = await real_get(self, model, ident, *args, **kwargs)
        if model is Auth and found is None and not raced:
            # Another reset creates the row between this read and this commit.
            raced.append(True)
            await Auths.update_user_password_by_id(user.id, 'first-hash')
        return found

    monkeypatch.setattr(AsyncSession, 'get', get_after_a_competing_reset)

    assert _run(Auths.update_user_password_by_id(user.id, 'second-hash')) is True
    monkeypatch.undo()
    assert _run(_credentials(user.id)).password == 'second-hash'


MIGRATION = (
    Path(__file__).resolve().parents[1]
    / 'local_llm'
    / 'migrations'
    / 'versions'
    / '6d9f8d9d38f6_add_missing_user_credentials.py'
)


def _upgrade_with_the_credentials_migration():
    """Run the revision's upgrade on the test run's database, already migrated before these users existed."""
    spec = importlib.util.spec_from_file_location('add_missing_user_credentials', MIGRATION)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    # The run's database holds every user the earlier tests made, many without
    # credentials, and each gets a hash: the fewest bcrypt rounds keep this quick.
    migration.bcrypt = SimpleNamespace(hashpw=bcrypt.hashpw, gensalt=partial(bcrypt.gensalt, rounds=4))
    with engine.begin() as connection, Operations.context(MigrationContext.configure(connection)):
        migration.upgrade()


def test_the_migration_gives_a_user_without_credentials_them_with_a_password_nobody_knows():
    tag = uuid.uuid4().hex[:8]
    email = f'scim-pre-296-{tag}@example.invalid'
    # As SCIM created users before #296 was fixed: a user row only.
    user = _run(Users.insert_new_user(f'scim-pre-296-{tag}', 'Old', email, role='user'))
    assert _run(_credentials(user.id)) is None

    _upgrade_with_the_credentials_migration()

    credentials = _run(_credentials(user.id))
    assert credentials is not None
    assert credentials.email == email and credentials.active
    assert credentials.password.startswith('$2')
    assert _run(Auths.authenticate_user_by_email(email)) is not None


def test_the_migration_leaves_existing_credentials_alone_and_changes_nothing_when_run_again():
    tag = uuid.uuid4().hex[:8]
    user = _run(Users.insert_new_user(f'has-auth-{tag}', 'Has', f'has-auth-{tag}@example.invalid', role='user'))
    _run(Auths.update_user_password_by_id(user.id, 'a-known-hash'))
    bare = _run(Users.insert_new_user(f'bare-{tag}', 'Bare', f'bare-{tag}@example.invalid', role='user'))

    _upgrade_with_the_credentials_migration()
    made = _run(_credentials(bare.id)).password
    _upgrade_with_the_credentials_migration()

    assert _run(_credentials(user.id)).password == 'a-known-hash'
    assert _run(_credentials(bare.id)).password == made
