"""The SQLite-only database download is gone (#961, S5-D5).

GET /utils/db/download sent the raw SQLite file and answered every other
database with a 400 "This feature is only available with SQLite
databases." This app runs only on Postgres, so the route could never
succeed, and Admin > Database's "Database" button, its only caller, always
failed. The tab now shows the pg_dump command instead, and the route was
removed with it. This keeps it from coming back.

A minimal app mounts only the utils router as main.py does, with an admin
signed in.

Run from apps/server:

    python -m pytest tests/test_db_download_gone.py
"""

from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.constants import ERROR_MESSAGES
from local_llm.routers import utils as utils_router
from local_llm.utils.auth import get_current_user


def test_the_database_download_route_is_gone():
    app = FastAPI()
    app.include_router(utils_router.router, prefix='/api/v1/utils')
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id='u1', role='admin')

    assert TestClient(app).get('/api/v1/utils/db/download').status_code == 404
    assert not any(getattr(route, 'path', '').endswith('/db/download') for route in app.routes)


def test_its_sqlite_only_message_went_with_it():
    assert 'DB_NOT_SQLITE' not in ERROR_MESSAGES.__members__
