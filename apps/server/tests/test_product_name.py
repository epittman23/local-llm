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
