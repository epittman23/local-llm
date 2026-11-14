"""An empty or non-numeric numeric setting does not stop the backend starting (#630).

Many settings in `local_llm.env` and `local_llm.config` were parsed at import
with a bare `int(os.getenv(NAME, 'default'))` (or `float`), so a variable set
but empty, or not a number, raised ValueError and the backend did not start.
They now go through `int_env` / `float_env`, which read an empty or
whitespace-only value as unset and a bad value as the default, with a warning.

Run from apps/server:

    python -m pytest tests/test_numeric_env_settings.py
"""

import json
import logging
import os
import subprocess
import sys
from pathlib import Path

import pytest

from local_llm.env import _int_env, float_env, int_env

SERVER_DIR = Path(__file__).resolve().parents[1]


def _set(monkeypatch, value):
    if value is None:
        monkeypatch.delenv('LLLM_TEST_NUMBER', raising=False)
    else:
        monkeypatch.setenv('LLLM_TEST_NUMBER', value)


@pytest.mark.parametrize(
    ('value', 'expected'),
    [(None, 5), ('', 5), ('  ', 5), ('25', 25), (' 7 ', 7), ('0', 0), ('-3', -3)],
)
def test_int_env_reads_a_whole_number_or_the_default(monkeypatch, caplog, value, expected):
    _set(monkeypatch, value)

    with caplog.at_level(logging.WARNING, logger='local_llm.env'):
        assert int_env('LLLM_TEST_NUMBER', 5) == expected
    assert not caplog.records


@pytest.mark.parametrize('value', ['x', '0.5', '1e3'])
def test_int_env_warns_and_uses_the_default_for_a_bad_value(monkeypatch, caplog, value):
    _set(monkeypatch, value)

    with caplog.at_level(logging.WARNING, logger='local_llm.env'):
        assert int_env('LLLM_TEST_NUMBER', 5) == 5
    assert [r.levelno for r in caplog.records] == [logging.WARNING]
    assert 'LLLM_TEST_NUMBER' in caplog.text
    assert repr(value) in caplog.text


@pytest.mark.parametrize(('value', 'expected'), [(None, None), ('', None), ('x', None), ('12', 12)])
def test_int_env_with_no_default(monkeypatch, value, expected):
    _set(monkeypatch, value)

    assert int_env('LLLM_TEST_NUMBER', None) == expected


@pytest.mark.parametrize(
    ('value', 'expected'),
    [(None, 0.5), ('', 0.5), ('  ', 0.5), ('0.25', 0.25), (' 2 ', 2.0), ('-1.5', -1.5), ('1e-3', 0.001)],
)
def test_float_env_reads_a_number_or_the_default(monkeypatch, caplog, value, expected):
    _set(monkeypatch, value)

    with caplog.at_level(logging.WARNING, logger='local_llm.env'):
        assert float_env('LLLM_TEST_NUMBER', 0.5) == expected
    assert not caplog.records


@pytest.mark.parametrize('value', ['x', '0,5'])
def test_float_env_warns_and_uses_the_default_for_a_bad_value(monkeypatch, caplog, value):
    _set(monkeypatch, value)

    with caplog.at_level(logging.WARNING, logger='local_llm.env'):
        assert float_env('LLLM_TEST_NUMBER', 0.5) == 0.5
    assert [r.levelno for r in caplog.records] == [logging.WARNING]
    assert 'LLLM_TEST_NUMBER' in caplog.text
    assert repr(value) in caplog.text


@pytest.mark.parametrize(
    ('value', 'expected'),
    [(None, 30), ('', 30), (' ', 30), ('x', 30), ('12', 12), ('1', 1), ('0', 1), ('-5', 1)],
)
def test_int_env_with_a_floor_of_one(monkeypatch, value, expected):
    _set(monkeypatch, value)

    assert _int_env('LLLM_TEST_NUMBER', 30) == expected


# Every setting #630 names (plus LLLM_OPTUNA_DASHBOARD_PORT, the same pattern), by
# module, with its default and what it reads for the valid value '7'.
ENV_SETTINGS = {
    'LLLM_OPTUNA_DASHBOARD_PORT': (8091, 7),
    'OAUTH_MAX_SESSIONS_PER_USER': (10, 7),
    'OAUTH_TOKEN_EXCHANGE_RATE_LIMIT': (None, 7),
    'OAUTH_TOKEN_EXCHANGE_RATE_LIMIT_WINDOW': (180, 7),
    'OTEL_METRICS_EXPORT_INTERVAL_MILLIS': (10000, 7),
    'MINERU_MAX_MARKDOWN_BYTES': (None, 7),
    'PROFILE_IMAGE_MAX_DATA_URI_SIZE': (None, 7),
}
CONFIG_SETTINGS = {
    'MEMORIES_REVIEW_INTERVAL_TURNS': (10, 7),
    'MEMORIES_USER_CHAR_LIMIT': (2000, 7),
    'MEMORIES_CONTEXT_CHAR_LIMIT': (2000, 7),
    'PGVECTOR_INITIALIZE_MAX_VECTOR_LENGTH': (1536, 7),
    'RAG_TOP_K': (3, 7),
    'RAG_TOP_K_RERANKER': (3, 7),
    'RAG_RELEVANCE_THRESHOLD': (0.0, 7.0),
    'RAG_HYBRID_BM25_WEIGHT': (0.5, 7.0),
    'RAG_FILE_CONTENT_SEARCH_MAX_CHARS': (64 * 1024 * 1024, 7),
    'FILE_IMAGE_COMPRESSION_WIDTH': (None, 7),
    'FILE_IMAGE_COMPRESSION_HEIGHT': (None, 7),
    'RAG_EMBEDDING_BATCH_SIZE': (1, 7),
    'RAG_EMBEDDING_CONCURRENT_REQUESTS': (0, 7),
    'RAG_RERANKING_BATCH_SIZE': (32, 7),
    'CHUNK_SIZE': (1000, 7),
    'CHUNK_MIN_SIZE_TARGET': (0, 7),
    'CHUNK_OVERLAP': (100, 7),
    'WEB_SEARCH_RESULT_COUNT': (3, 7),
    'WEB_SEARCH_CONCURRENT_REQUESTS': (0, 7),
    'WEB_FETCH_MAX_CONTENT_LENGTH': (None, 7),
    'WEB_LOADER_CONCURRENT_REQUESTS': (10, 7),
    'BRAVE_SEARCH_CONTEXT_TOKENS': (8192, 7),
    'PLAYWRIGHT_TIMEOUT': (10000, 7),
    'IMAGE_STEPS': (50, 7),
    'SUBAGENTS_MAX_CONCURRENT': (20, 7),
    'SUBAGENTS_MAX_ASYNC': (20, 7),
    'SUBAGENTS_MAX_ITERATIONS': (30, 7),
    'SUBAGENTS_MAX_OUTPUT': (30000, 7),
    'CONTEXT_COMPACTION_TOKEN_THRESHOLD': (80000, 7),
    'CONTEXT_COMPACTION_TOKEN_CAP': (None, 7),
    # Clamped to 10..50, as before.
    'CONTEXT_COMPACTION_RETENTION_PERCENTAGE': (40, 10),
    'AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH': (-1, 7),
}
# Read when the setting above them is unset, so they are set to the same value.
FALLBACKS = ['RAG_EMBEDDING_OPENAI_BATCH_SIZE']

VALUES = {'empty': '', 'whitespace': '  ', 'not a number': 'x', 'valid': '7'}


@pytest.fixture(scope='module')
def loaded(tmp_path_factory):
    """The settings as a fresh import reads them, for each value in VALUES."""
    env = {**os.environ, 'HF_HUB_OFFLINE': '1'}
    env.pop('DATABASE_URL', None)
    script = (
        'import json, local_llm.env as e, local_llm.config as c;'
        f'print("LOADED " + json.dumps({{"file": e.__file__,'
        f' "env": {{n: getattr(e, n) for n in {list(ENV_SETTINGS)!r}}},'
        f' "config": {{n: getattr(c, n) for n in {list(CONFIG_SETTINGS)!r}}}}}))'
    )
    out = {}
    for label, value in VALUES.items():
        run_env = {**env, 'DATA_DIR': str(tmp_path_factory.mktemp('data'))}
        run_env.update(dict.fromkeys([*ENV_SETTINGS, *CONFIG_SETTINGS, *FALLBACKS], value))
        result = subprocess.run(
            [sys.executable, '-c', script], cwd=SERVER_DIR, env=run_env, capture_output=True, text=True, timeout=600
        )
        assert result.returncode == 0, f'{label}: {result.stderr[-3000:]}'
        line = next(line for line in result.stdout.splitlines() if line.startswith('LOADED '))
        out[label] = json.loads(line.removeprefix('LOADED '))
    return out


def test_the_settings_are_read_from_this_checkout(loaded):
    for settings in loaded.values():
        assert Path(settings['file']).resolve().is_relative_to(SERVER_DIR)


@pytest.mark.parametrize('label', ['empty', 'whitespace', 'not a number'])
@pytest.mark.parametrize(
    ('module', 'name'), [('env', n) for n in ENV_SETTINGS] + [('config', n) for n in CONFIG_SETTINGS]
)
def test_a_bad_value_loads_as_the_default(loaded, label, module, name):
    default = (ENV_SETTINGS if module == 'env' else CONFIG_SETTINGS)[name][0]

    assert loaded[label][module][name] == default
    assert type(loaded[label][module][name]) is type(default)


@pytest.mark.parametrize(
    ('module', 'name'), [('env', n) for n in ENV_SETTINGS] + [('config', n) for n in CONFIG_SETTINGS]
)
def test_a_valid_value_is_read(loaded, module, name):
    expected = (ENV_SETTINGS if module == 'env' else CONFIG_SETTINGS)[name][1]

    assert loaded['valid'][module][name] == expected
    assert type(loaded['valid'][module][name]) is type(expected)


def _load_one(tmp_path, settings: dict, names: list[str]) -> tuple[dict, str]:
    """The named config settings as a fresh import reads them with `settings` set, and its stderr."""
    env = {**os.environ, 'HF_HUB_OFFLINE': '1', 'DATA_DIR': str(tmp_path)}
    env.pop('DATABASE_URL', None)
    for name in [*ENV_SETTINGS, *CONFIG_SETTINGS, *FALLBACKS]:
        env.pop(name, None)
    env.update(settings)
    script = (
        'import json, local_llm.env as e, local_llm.config as c;'
        f'print("LOADED " + json.dumps({{n: getattr(c, n, getattr(e, n, None)) for n in {names!r}}}))'
    )
    result = subprocess.run(
        [sys.executable, '-c', script], cwd=SERVER_DIR, env=env, capture_output=True, text=True, timeout=600
    )
    assert result.returncode == 0, result.stderr[-3000:]
    line = next(line for line in result.stdout.splitlines() if line.startswith('LOADED '))
    return json.loads(line.removeprefix('LOADED ')), result.stderr


@pytest.mark.parametrize(
    ('settings', 'name', 'expected'),
    [
        # A setting that falls back to another reads the other when it is empty or bad.
        ({'RAG_EMBEDDING_BATCH_SIZE': '', 'RAG_EMBEDDING_OPENAI_BATCH_SIZE': '9'}, 'RAG_EMBEDDING_BATCH_SIZE', 9),
        ({'RAG_EMBEDDING_BATCH_SIZE': '8', 'RAG_EMBEDDING_OPENAI_BATCH_SIZE': '9'}, 'RAG_EMBEDDING_BATCH_SIZE', 8),
        # "none", in any case and with spaces, is no limit, as before.
        ({'OAUTH_TOKEN_EXCHANGE_RATE_LIMIT': ' None '}, 'OAUTH_TOKEN_EXCHANGE_RATE_LIMIT', None),
        ({'OAUTH_TOKEN_EXCHANGE_RATE_LIMIT': 'none'}, 'OAUTH_TOKEN_EXCHANGE_RATE_LIMIT', None),
    ],
)
def test_a_setting_that_falls_back_to_another(tmp_path, settings, name, expected):
    values, _ = _load_one(tmp_path, settings, [name])

    assert values[name] == expected


def test_a_legacy_value_beside_a_current_one_is_not_read(tmp_path):
    settings = {'RAG_EMBEDDING_BATCH_SIZE': '8', 'RAG_EMBEDDING_OPENAI_BATCH_SIZE': 'x'}

    values, stderr = _load_one(tmp_path, settings, ['RAG_EMBEDDING_BATCH_SIZE'])

    assert values['RAG_EMBEDDING_BATCH_SIZE'] == 8
    assert 'RAG_EMBEDDING_OPENAI_BATCH_SIZE' not in stderr


@pytest.mark.parametrize('name', ['CODE_INTERPRETER_ENGINE', 'CODE_EXECUTION_ENGINE'])
@pytest.mark.parametrize(
    ('value', 'expected', 'warned'),
    [
        (None, 'sandbox', False),
        ('sandbox', 'sandbox', False),
        ('pyodide', 'sandbox', True),
        ('jupyter', 'sandbox', True),
    ],
)
def test_a_code_engine_setting_names_a_live_engine_or_falls_back_to_the_sandbox(
    monkeypatch, tmp_path, name, value, expected, warned
):
    monkeypatch.delenv('CODE_INTERPRETER_ENGINE', raising=False)
    monkeypatch.delenv('CODE_EXECUTION_ENGINE', raising=False)
    values, stderr = _load_one(tmp_path, {} if value is None else {name: value}, [name])

    assert values[name] == expected
    assert (f'{name}={value!r} is not a code engine' in stderr) is warned
