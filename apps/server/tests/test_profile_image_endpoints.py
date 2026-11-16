"""A model or user without a picture of its own gets a 404 (#924, decision D1).

The picture endpoints used to answer with Open WebUI's 'OI' favicon or its grey
silhouette, which the frontend could not tell from a real picture; now they
answer 404, and the frontend's avatar draws the initials. "No picture" covers
an empty value, the stored defaults (/user.png, /favicon.png,
/static/favicon.png: left in the rows as they are) and an unusable one. A real
picture is still served as before. A webhook without a picture keeps its
status (the owner approved the 404 for models and users only) and gets the
product's mark in place of Open WebUI's favicon.

Run from apps/server:

    python -m pytest tests/test_profile_image_endpoints.py
"""

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.config import WEBHOOK_FALLBACK_IMAGE
from local_llm.internal.db import get_async_session
from local_llm.routers import channels as channels_router
from local_llm.routers import models as models_router
from local_llm.routers import users as users_router
from local_llm.utils.auth import get_verified_user
from local_llm.utils.validate import is_default_profile_image

PNG = 'data:image/png;base64,iVBORw0KGgo='
WEB_PUBLIC = Path(__file__).resolve().parents[2] / 'web' / 'public'
DEFAULTS = ['', None, '/user.png', '/favicon.png', '/static/favicon.png']


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(models_router.router, prefix='/models')
    app.include_router(users_router.router, prefix='/users')
    app.include_router(channels_router.router, prefix='/channels')
    app.dependency_overrides[get_verified_user] = lambda: SimpleNamespace(id='me', role='user')

    async def no_session():
        yield None

    app.dependency_overrides[get_async_session] = no_session
    return TestClient(app, follow_redirects=False)


def model_with(monkeypatch, url):
    async def meta(_id, db=None):
        return ({'profile_image_url': url}, 7)

    async def config(_key, default=None):
        return []

    monkeypatch.setattr(models_router.Models, 'get_model_meta_by_id', meta)
    monkeypatch.setattr(models_router.Config, 'get', config)


def user_with(monkeypatch, url):
    async def get(_id):
        return SimpleNamespace(id='u1', profile_image_url=url)

    monkeypatch.setattr(users_router.Users, 'get_user_by_id', get)


def webhook_with(monkeypatch, url, exists=True):
    async def get(_id):
        return SimpleNamespace(id='w1', profile_image_url=url) if exists else None

    monkeypatch.setattr(channels_router.Channels, 'get_webhook_by_id', get)


@pytest.mark.parametrize('url', DEFAULTS)
def test_a_value_that_means_no_picture_is_recognised(url):
    assert is_default_profile_image(url)


@pytest.mark.parametrize('url', [PNG, 'https://example.com/user.png', '/api/v1/users/u1/profile/image'])
def test_a_picture_of_its_own_is_not_a_default(url):
    assert not is_default_profile_image(url)


@pytest.mark.parametrize('url', [*DEFAULTS, 'data:image/svg+xml;base64,PHN2Zy8+'])
def test_a_model_without_a_picture_of_its_own_is_a_404(client, monkeypatch, url):
    model_with(monkeypatch, url)
    response = client.get('/models/model/profile/image', params={'id': 'm1'})
    assert response.status_code == 404
    assert response.json() == {'detail': 'No profile image'}


def test_a_models_picture_is_still_served(client, monkeypatch):
    model_with(monkeypatch, PNG)
    response = client.get('/models/model/profile/image', params={'id': 'm1'})
    assert response.status_code == 200
    assert response.headers['content-type'] == 'image/png'


def test_a_models_own_static_picture_is_still_a_redirect(client, monkeypatch):
    model_with(monkeypatch, '/static/models/coder.png')
    response = client.get('/models/model/profile/image', params={'id': 'm1'})
    assert response.status_code == 302
    assert response.headers['location'] == '/static/models/coder.png'


@pytest.mark.parametrize('url', [*DEFAULTS, '/api/v1/users/u1/profile/image', 'data:image/svg+xml;base64,PHN2Zy8+'])
def test_a_user_without_a_picture_of_their_own_is_a_404(client, monkeypatch, url):
    user_with(monkeypatch, url)
    response = client.get('/users/u1/profile/image')
    assert response.status_code == 404
    assert response.json() == {'detail': 'No profile image'}


def test_a_users_picture_is_still_served(client, monkeypatch):
    user_with(monkeypatch, PNG)
    response = client.get('/users/u1/profile/image')
    assert response.status_code == 200
    assert response.headers['content-type'] == 'image/png'


def test_the_mark_is_in_the_static_directory_for_webhooks():
    assert WEBHOOK_FALLBACK_IMAGE.name == 'icon-512.png'
    assert WEBHOOK_FALLBACK_IMAGE.read_bytes() == (WEB_PUBLIC / 'icon-512.png').read_bytes()


@pytest.mark.parametrize('url', ['', None])
def test_a_webhook_without_a_picture_gets_the_mark(client, monkeypatch, url):
    webhook_with(monkeypatch, url)
    response = client.get('/channels/webhooks/w1/profile/image')
    assert response.status_code == 200
    assert response.content == (WEB_PUBLIC / 'icon-512.png').read_bytes()


def test_a_missing_webhook_gets_the_mark(client, monkeypatch):
    webhook_with(monkeypatch, None, exists=False)
    response = client.get('/channels/webhooks/w1/profile/image')
    assert response.status_code == 200
    assert response.content == (WEB_PUBLIC / 'icon-512.png').read_bytes()


def test_a_webhooks_picture_is_still_served(client, monkeypatch):
    webhook_with(monkeypatch, PNG)
    response = client.get('/channels/webhooks/w1/profile/image')
    assert response.status_code == 200
    assert response.headers['content-type'] == 'image/png'


def test_a_missing_mark_file_is_a_404_not_a_500(client, monkeypatch, tmp_path):
    monkeypatch.setattr(channels_router, 'WEBHOOK_FALLBACK_IMAGE', tmp_path / 'icon-512.png')
    webhook_with(monkeypatch, None)
    response = client.get('/channels/webhooks/w1/profile/image')
    assert response.status_code == 404
    assert response.json() == {'detail': 'No profile image'}
    webhook_with(monkeypatch, None, exists=False)
    assert client.get('/channels/webhooks/w1/profile/image').status_code == 404
