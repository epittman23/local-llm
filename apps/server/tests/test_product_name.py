"""The product is "local-llm" (docs/guides/ui-standard.md WRD-3).

The default instance name is what the sign-in page, the tab title and the
installable manifest show when LLLM_NAME is not set, so it must be the
product's own name and carry nothing inherited from Open WebUI.
"""

import asyncio
import os
import subprocess
import sys
from pathlib import Path

from local_llm import main


def test_the_default_instance_name_is_local_llm():
    # A fresh interpreter with LLLM_NAME unset, so a name set for this test run
    # cannot hide the default.
    env = {k: v for k, v in os.environ.items() if k != 'LLLM_NAME'}
    env.setdefault('LLLM_SECRET_KEY', 'test-only-not-a-secret-0123456789abcdef')
    result = subprocess.run(
        [sys.executable, '-c', 'from local_llm.env import LLLM_NAME; print(LLLM_NAME)'],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.strip().splitlines()[-1] == 'local-llm'


def test_the_manifest_describes_the_product_in_its_own_words(monkeypatch):
    monkeypatch.setattr(main.app.state, 'LLLM_NAME', 'local-llm')
    monkeypatch.setattr(main.app.state, 'EXTERNAL_PWA_MANIFEST_URL', None, raising=False)
    manifest = asyncio.run(main.get_manifest_json())
    assert manifest['name'] == 'local-llm'
    assert manifest['description'] == 'local-llm: a private assistant for mathematics, statistics, data and code.'
    assert 'extensible' not in manifest['description']
    assert main.app.title == 'local-llm'


WEB_PUBLIC = Path(__file__).resolve().parents[2] / 'web' / 'public'


def test_the_manifest_shows_the_mark_on_the_page_colour(monkeypatch):
    # Decision D1 (2026-11-14, #924): lucide's Sigma, not Open WebUI's 'OI' logo,
    # on the dark theme's --page, not Open WebUI's grey.
    monkeypatch.setattr(main.app.state, 'LLLM_NAME', 'local-llm', raising=False)
    monkeypatch.setattr(main.app.state, 'EXTERNAL_PWA_MANIFEST_URL', None, raising=False)
    manifest = asyncio.run(main.get_manifest_json())
    assert manifest['background_color'] == '#121916'
    assert [(icon['src'], icon['sizes']) for icon in manifest['icons']] == [
        ('/icon-512.png', '512x512'),
        ('/apple-touch-icon.png', '180x180'),
    ]
    for icon in manifest['icons']:
        # The frontend's public/ files are served at the root of its build.
        assert (WEB_PUBLIC / icon['src'].lstrip('/')).is_file(), icon['src']


def test_opensearch_names_the_mark(monkeypatch):
    async def webui_url(_key, default=None):
        return 'http://localhost:4000'

    monkeypatch.setattr(main.app.state, 'LLLM_NAME', 'local-llm', raising=False)
    monkeypatch.setattr(main.Config, 'get', webui_url)
    xml = asyncio.run(main.get_opensearch_xml()).body.decode()
    assert '<Image width="32" height="32" type="image/x-icon">http://localhost:4000/favicon.ico</Image>' in xml
    assert (WEB_PUBLIC / 'favicon.ico').is_file()
