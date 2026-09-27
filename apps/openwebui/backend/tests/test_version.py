"""The backend's version comes from pyproject.toml, and apps/web carries the same number.

Until Phase 11 the version was read from the SvelteKit app's package.json;
deleting that file would have silently turned it into '0.0.0', which the
About tab and plugin version checks compare against.
"""

import json
import tomllib
from pathlib import Path

from open_webui.env import VERSION

APP_DIR = Path(__file__).resolve().parents[2]  # apps/openwebui/


def test_version_is_read_from_pyproject():
    with open(APP_DIR / 'pyproject.toml', 'rb') as f:
        expected = tomllib.load(f)['project']['version']
    assert VERSION == expected
    assert VERSION != '0.0.0'


def test_web_app_carries_the_same_version():
    web = json.loads((APP_DIR.parent / 'web' / 'package.json').read_text())
    assert web['version'] == VERSION
