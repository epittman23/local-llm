"""An empty or fractional RAG_FILE_MAX_SIZE does not stop the backend starting (#301).

`local_llm.env` parsed it with `int(os.getenv('RAG_FILE_MAX_SIZE', '0'))`, so a
variable set but empty (or `0.5`) raised ValueError at import, while
`local_llm.config` already read empty as unset. Both now read a value that is
empty, or not a whole number, as unset (the latter with a warning).

Run from apps/server:

    python -m pytest tests/test_rag_file_max_size_env.py
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from local_llm.env import optional_int_env

SERVER_DIR = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize(
    ('value', 'expected'),
    [(None, None), ('', None), ('  ', None), ('0.5', None), ('ten', None), ('25', 25), (' 7 ', 7), ('0', 0)],
)
def test_optional_int_env(monkeypatch, value, expected):
    if value is None:
        monkeypatch.delenv('LLLM_TEST_INT', raising=False)
    else:
        monkeypatch.setenv('LLLM_TEST_INT', value)

    assert optional_int_env('LLLM_TEST_INT') == expected


@pytest.mark.parametrize(
    ('value', 'cap_setting', 'cap'),
    [
        ('', None, None),
        ('0.5', None, None),
        # Unset or empty, the cap is left to the upload size limit, read at use time (#629;
        # tests/test_metadata_cap_follows_upload_limit.py), not folded in at startup.
        ('2', None, None),
        # Its own setting is kept, a 0 included (a cap of 0, as before).
        ('2', '0', 0),
        ('2', '500', 500),
        ('2', '', None),
    ],
)
def test_the_settings_load_with_the_value(tmp_path, value, cap_setting, cap):
    env = {**os.environ, 'RAG_FILE_MAX_SIZE': value, 'DATA_DIR': str(tmp_path), 'HF_HUB_OFFLINE': '1'}
    env.pop('DATABASE_URL', None)
    env.pop('RAG_METADATA_MAX_VALUE_CHARS', None)
    if cap_setting is not None:
        env['RAG_METADATA_MAX_VALUE_CHARS'] = cap_setting
    script = (
        'import json, local_llm.env as e, local_llm.config as c;'
        'print("LOADED " + json.dumps([e.RAG_METADATA_MAX_VALUE_CHARS, c.RAG_FILE_MAX_SIZE]))'
    )
    result = subprocess.run(
        [sys.executable, '-c', script], cwd=SERVER_DIR, env=env, capture_output=True, text=True, timeout=600
    )

    assert result.returncode == 0, result.stderr[-3000:]
    line = next(line for line in result.stdout.splitlines() if line.startswith('LOADED '))
    assert json.loads(line.removeprefix('LOADED ')) == [cap, int(value) if value.isdigit() else None]
