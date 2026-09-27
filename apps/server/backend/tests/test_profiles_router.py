"""HTTP-layer tests for routers/benchmarks/profiles.py.

Database-free: BenchmarkProfiles (the module-level singleton the router
calls) is monkeypatched with async stubs, so these check the router's own
job -- status codes, 404/409/400 mapping, the immutable-name contract -- not
the model layer underneath it (that's models/benchmark_profiles.py's own
concern, exercised against real fingerprints in test_serving_profiles.py).
A minimal FastAPI app mounts only this router, with get_admin_user
overridden, so nothing here touches auth or a real database.

Run from the backend directory:

    python -m pytest tests/test_profiles_router.py
"""

from __future__ import annotations

import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from open_webui.benchmarks.serving.profiles import ProfileError
from open_webui.models.benchmark_profiles import (
    BenchmarkProfileEntry,
    BenchmarkProfileModel,
    BenchmarkProfileVersionModel,
)
from open_webui.routers.benchmarks import profiles as profiles_router
from open_webui.utils.auth import get_admin_user

ADMIN = SimpleNamespace(id='admin-1', email='admin@example.com')

VALID_DEFINITION = {
    'arch': 'dense',
    'alias': 'qwen2.5-coder-7b',
    'model_path': '{LLAMA_MODELS}/qwen25-coder-7b/x.gguf',
    'ctx': 16384,
    'threads': 6,
    'ngl': 99,
}


def _entry(name='qwen25c', profile_id=1, version=1, is_default=False, archived_at=None) -> BenchmarkProfileEntry:
    now = int(time.time())
    return BenchmarkProfileEntry(
        profile=BenchmarkProfileModel(
            profile_id=profile_id,
            name=name,
            display_name='Qwen2.5-Coder 7B',
            is_default=is_default,
            created_at=now,
            archived_at=archived_at,
        ),
        version=BenchmarkProfileVersionModel(
            version_id=profile_id * 10,
            profile_id=profile_id,
            version=version,
            created_at=now,
            spec=[],
            samplers=[],
            extra=[],
            **VALID_DEFINITION,
        ),
    )


@pytest.fixture
def client(monkeypatch):
    app = FastAPI()
    app.include_router(profiles_router.router)
    app.dependency_overrides[get_admin_user] = lambda: ADMIN
    return TestClient(app)


# ---------------------------------------------------------------------------
# list / get / versions
# ---------------------------------------------------------------------------


def test_list_profiles_passes_include_archived_through(client, monkeypatch):
    calls = []

    async def fake_list_profiles(*, include_archived=False, db=None):
        calls.append(include_archived)
        return [_entry()]

    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'list_profiles', fake_list_profiles)

    resp = client.get('/', params={'include_archived': 'true'})
    assert resp.status_code == 200
    assert calls == [True]
    assert resp.json()[0]['profile']['name'] == 'qwen25c'


def test_get_profile_404_when_missing(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return None

    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    resp = client.get('/no-such-profile')
    assert resp.status_code == 404


def test_get_profile_200_when_present(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return _entry(name=name)

    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    resp = client.get('/qwen25c')
    assert resp.status_code == 200
    assert resp.json()['profile']['name'] == 'qwen25c'


def test_get_default_profile_404_when_none_set(client, monkeypatch):
    async def fake_get_default(db=None):
        return None

    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'get_default', fake_get_default)
    resp = client.get('/default')
    assert resp.status_code == 404


def test_list_versions_uses_the_profile_id(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return _entry(name=name, profile_id=7)

    seen_ids = []

    async def fake_list_versions(profile_id, db=None):
        seen_ids.append(profile_id)
        return []

    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'list_versions', fake_list_versions)
    resp = client.get('/qwen25c/versions')
    assert resp.status_code == 200
    assert seen_ids == [7]


# ---------------------------------------------------------------------------
# create
# ---------------------------------------------------------------------------


def test_create_profile_409_when_name_taken(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return _entry(name=name)

    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    resp = client.post('/', json={'name': 'qwen25c', 'display_name': 'x', 'definition': VALID_DEFINITION})
    assert resp.status_code == 409


def test_create_profile_201_and_passes_created_by(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return None

    captured = {}

    async def fake_create(*, name, display_name, definition, created_by=None, note=None, db=None):
        captured.update(name=name, display_name=display_name, created_by=created_by, note=note)
        return _entry(name=name)

    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'create', fake_create)

    resp = client.post(
        '/', json={'name': 'new-profile', 'display_name': 'New', 'definition': VALID_DEFINITION, 'note': 'hi'}
    )
    assert resp.status_code == 201
    assert captured == {'name': 'new-profile', 'display_name': 'New', 'created_by': 'admin-1', 'note': 'hi'}


def test_create_profile_400_on_profile_error(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return None

    async def fake_create(**kwargs):
        raise ProfileError('missing profile fields: ctx')

    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'create', fake_create)

    resp = client.post('/', json={'name': 'bad', 'display_name': 'x', 'definition': VALID_DEFINITION})
    assert resp.status_code == 400
    assert 'missing profile fields' in resp.json()['detail']


def test_create_profile_rejects_unknown_definition_fields(client):
    resp = client.post(
        '/',
        json={
            'name': 'x',
            'display_name': 'x',
            'definition': {**VALID_DEFINITION, 'name': 'sneaky-rename'},
        },
    )
    assert resp.status_code == 422


def test_create_profile_rejects_unknown_top_level_fields(client):
    resp = client.post(
        '/',
        json={'name': 'x', 'display_name': 'x', 'definition': VALID_DEFINITION, 'is_default': True},
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# clone
# ---------------------------------------------------------------------------


def test_clone_profile_404_when_source_missing(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return None

    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    resp = client.post('/no-such-source/clone', json={'name': 'copy', 'display_name': 'Copy'})
    assert resp.status_code == 404


def test_clone_profile_409_when_new_name_taken(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return _entry(name=name)  # both the source lookup and the taken-name check resolve

    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    resp = client.post('/source/clone', json={'name': 'taken', 'display_name': 'x'})
    assert resp.status_code == 409


def test_clone_profile_copies_the_source_definition_not_the_client_body(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        if name == 'source':
            return _entry(name='source', profile_id=3, version=2)
        return None  # the new name is free

    captured = {}

    async def fake_create(*, name, display_name, definition, created_by=None, note=None, db=None):
        captured.update(name=name, display_name=display_name, definition=definition, note=note)
        return _entry(name=name)

    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'create', fake_create)

    resp = client.post('/source/clone', json={'name': 'clone-of-source', 'display_name': 'Clone'})
    assert resp.status_code == 201
    assert captured['name'] == 'clone-of-source'
    assert captured['definition']['alias'] == VALID_DEFINITION['alias']
    # identity/version-history fields must not leak into the new profile's
    # first version
    assert set(captured['definition']) & {'version_id', 'profile_id', 'version', 'created_at', 'created_by'} == set()
    assert "cloned from 'source'" in captured['note']
    assert 'version 2' in captured['note']


# ---------------------------------------------------------------------------
# add_version (edit)
# ---------------------------------------------------------------------------


def test_add_version_404_when_profile_missing(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return None

    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    resp = client.post('/no-such-profile/versions', json={'definition': VALID_DEFINITION})
    assert resp.status_code == 404


def test_add_version_rejects_a_name_field_in_the_definition(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return _entry(name=name)

    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    resp = client.post(
        '/qwen25c/versions',
        json={'definition': {**VALID_DEFINITION, 'name': 'renamed'}},
    )
    assert resp.status_code == 422


def test_add_version_400_on_profile_error(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return _entry(name=name, profile_id=5)

    async def fake_add_version(profile_id, *, definition, created_by=None, note=None, db=None):
        raise ProfileError('--n-cpu-moe is not applicable to a dense model; leave moe empty')

    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'add_version', fake_add_version)

    resp = client.post('/qwen25c/versions', json={'definition': VALID_DEFINITION})
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# default / archive / unarchive
# ---------------------------------------------------------------------------


def test_set_default_400_when_archived(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return _entry(name=name, profile_id=2)

    async def fake_set_default(profile_id, db=None):
        raise ProfileError('an archived profile cannot be the default')

    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'set_default', fake_set_default)

    resp = client.post('/qwen25c/default')
    assert resp.status_code == 400


def test_archive_400_when_default(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return _entry(name=name, profile_id=2, is_default=True)

    async def fake_archive(profile_id, db=None):
        raise ProfileError('the default profile cannot be archived; set another default first')

    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'archive', fake_archive)

    resp = client.post('/qwen25c/archive')
    assert resp.status_code == 400


def test_unarchive_200(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return _entry(name=name, profile_id=2)

    calls = []

    async def fake_unarchive(profile_id, db=None):
        calls.append(profile_id)

    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'unarchive', fake_unarchive)

    resp = client.post('/qwen25c/unarchive')
    assert resp.status_code == 200
    assert calls == [2]


def test_set_display_name_updates_and_returns_fresh_entry(client, monkeypatch):
    async def fake_get_by_name(name, db=None):
        return _entry(name=name, profile_id=2)

    calls = []

    async def fake_set_display_name(profile_id, display_name, db=None):
        calls.append((profile_id, display_name))

    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    monkeypatch.setattr(profiles_router.BenchmarkProfiles, 'set_display_name', fake_set_display_name)

    resp = client.post('/qwen25c/display-name', json={'display_name': 'New Display Name'})
    assert resp.status_code == 200
    assert calls == [(2, 'New Display Name')]
