"""The backend's default paths, after apps/server/backend/ was flattened into apps/server/.

Flattening moved env.py one level up, and three of its defaults depend on that
depth. Each would fail silently, not with an error: VERSION falls back to
'0.0.0', FRONTEND_BUILD_DIR points at a directory that doesn't exist (so `/`
stops serving the app), and DATA_DIR starts the backend on an empty directory.
"""

from pathlib import Path

from open_webui import env

SERVER_DIR = Path(__file__).resolve().parents[1]  # apps/server/
REPO_ROOT = SERVER_DIR.parents[1]


def test_package_and_server_dirs():
    assert env.PACKAGE_DIR == SERVER_DIR / 'open_webui'
    assert env.SERVER_DIR == SERVER_DIR


def test_version_is_read_from_pyproject():
    assert env.VERSION != '0.0.0'


def test_frontend_build_dir_defaults_to_apps_web_dist():
    assert env.default_frontend_build_dir() == REPO_ROOT / 'apps' / 'web' / 'dist'


def test_data_dir_defaults_to_apps_server_data():
    # The default is computed, not created: this test must not leave an
    # apps/server/data/ behind (the suite runs with DATA_DIR set elsewhere).
    assert env.default_data_dir() == SERVER_DIR / 'data'
