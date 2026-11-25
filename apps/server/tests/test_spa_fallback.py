"""The web app's page fallback answers the app's own pages, never an unknown backend route (#1131).

`SPAStaticFiles` is mounted at `/`, so every path no route matches reaches it. It answers an unknown page with
`index.html`, so client-side routes load on reload, but an unknown path under one of the backend's own prefixes
(`/api/...`, `/ollama/...`) is a missing route and stays a 404 with FastAPI's JSON body.
"""

import re
from pathlib import Path

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

from local_llm.main import SPAStaticFiles, backend_path_segments

WEB_ROUTES = Path(__file__).resolve().parents[3] / 'apps' / 'web' / 'src' / 'routes'
INDEX = '<!doctype html><title>app</title>'


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    (tmp_path / 'index.html').write_text(INDEX)
    (tmp_path / 'assets').mkdir()
    (tmp_path / 'assets' / 'app.js').write_text('export {}')
    app = FastAPI()
    api = APIRouter()

    @api.get('/chats/')
    async def chats() -> list[str]:
        return []

    app.include_router(api, prefix='/api/v1/chats-like')

    @app.get('/ollama/api/version')
    async def ollama_version() -> dict[str, str]:
        return {'version': '0'}

    app.mount('/', SPAStaticFiles(directory=tmp_path, html=True), name='spa-static-files')
    return TestClient(app)


@pytest.mark.parametrize('path', ['/api/v1/no-such-route', '/api/no-such', '/ollama/no-such', '/api'])
def test_an_unknown_backend_path_is_a_json_404(client: TestClient, path: str) -> None:
    response = client.get(path)
    assert response.status_code == 404
    assert response.headers['content-type'].startswith('application/json')
    assert response.json() == {'detail': 'Not Found'}


@pytest.mark.parametrize('path', ['/workspace/models', '/admin/settings/connections', '/c/123', '/'])
def test_an_app_page_is_the_web_app(client: TestClient, path: str) -> None:
    response = client.get(path)
    assert response.status_code == 200
    assert response.text == INDEX


def test_a_missing_script_is_a_404_and_a_present_one_is_served(client: TestClient) -> None:
    assert client.get('/assets/missing.js').status_code == 404
    assert client.get('/assets/app.js').text == 'export {}'


def test_real_routes_still_answer(client: TestClient) -> None:
    assert client.get('/api/v1/chats-like/chats/').json() == []
    assert client.get('/ollama/api/version').json() == {'version': '0'}


def test_the_real_apps_prefixes_cover_its_routers_and_no_page() -> None:
    """The prefixes come from the real app's route table; none of them may be one of the web app's pages."""
    from local_llm.main import app

    segments = backend_path_segments(app.router.routes)
    assert {'api', 'ollama', 'openai', 'oauth', 'ws', 'cache', 'static'} <= segments
    pages = set()
    for name in ('routePaths.ts', 'AppRouter.tsx'):
        source = (WEB_ROUTES / name).read_text()
        pages |= set(re.findall(r"'/([a-z][a-z0-9-]*)", source))
        pages |= set(re.findall(r"path: '([a-z][a-z0-9-]*)", source))
    assert {'workspace', 'admin', 'c', 'notes'} <= pages
    assert segments.isdisjoint(pages), segments & pages
