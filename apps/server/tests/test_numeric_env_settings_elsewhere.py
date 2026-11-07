"""The numeric settings outside env.py and config.py read leniently too (#795).

#630 gave `int_env` / `float_env` to the settings in env.py and config.py. The
automations scheduler's three intervals, the OAuth client timeout and the
benchmarks' `LLAMA_*` reads still used a bare `int(...)` / `float(...)`, so a
variable set but empty, or not a number, stopped startup (or failed at call
time). They read through the helpers now, with their old defaults.

Run from apps/server:

    python -m pytest tests/test_numeric_env_settings_elsewhere.py
"""

import json
import logging
import os
import subprocess
import sys
from pathlib import Path

import pytest

from local_llm import config

SERVER_DIR = Path(__file__).resolve().parents[1]

# name -> (module, attribute, default, value for '7')
IMPORT_TIME = {
    'SCHEDULER_POLL_INTERVAL': ('local_llm.utils.automations', 'SCHEDULER_POLL_INTERVAL', 10, 7),
    'TIMER_POLL_INTERVAL': ('local_llm.utils.automations', 'TIMER_POLL_INTERVAL', 1, 7),
    'CALENDAR_ALERT_LOOKAHEAD_MINUTES': ('local_llm.utils.automations', 'CALENDAR_ALERT_LOOKAHEAD_MINUTES', 10, 7),
    'LLAMA_VRAM_HEADROOM_MIB': ('local_llm.benchmarks.analysis.stats', 'HEADROOM_WARN_MIB', 300, 7),
}
VALUES = {
    'empty': ('', 'default'),
    'whitespace': ('  ', 'default'),
    'not a number': ('x', 'default'),
    'valid': ('7', 'set'),
}


def _load(settings: dict[str, str], data_dir: Path) -> dict:
    env = {**os.environ, 'HF_HUB_OFFLINE': '1', 'DATA_DIR': str(data_dir), **settings}
    env.pop('DATABASE_URL', None)
    for name in ('AUTOMATION_POLL_INTERVAL', *IMPORT_TIME):
        if name not in settings:
            env.pop(name, None)
    script = (
        'import importlib, json;'
        f'spec = {[(k, *v[:2]) for k, v in IMPORT_TIME.items()]!r};'
        'print("LOADED " + json.dumps({k: getattr(importlib.import_module(m), a) for k, m, a in spec}))'
    )
    result = subprocess.run(
        [sys.executable, '-c', script], cwd=SERVER_DIR, env=env, capture_output=True, text=True, timeout=600
    )
    assert result.returncode == 0, result.stderr[-3000:]
    line = next(line for line in result.stdout.splitlines() if line.startswith('LOADED '))
    return json.loads(line.removeprefix('LOADED '))


@pytest.fixture(scope='module')
def loaded(tmp_path_factory):
    return {
        label: _load(dict.fromkeys(IMPORT_TIME, value), tmp_path_factory.mktemp('data'))
        for label, (value, _) in VALUES.items()
    }


@pytest.mark.parametrize('label', VALUES)
@pytest.mark.parametrize('name', IMPORT_TIME)
def test_an_import_time_setting_reads_leniently(loaded, label, name):
    _, _, default, seven = IMPORT_TIME[name]
    expected = default if VALUES[label][1] == 'default' else seven

    assert loaded[label][name] == expected
    assert type(loaded[label][name]) is int


def test_the_defaults_are_unchanged_when_unset(tmp_path):
    out = _load({}, tmp_path)

    assert out == {name: default for name, (_, _, default, _) in IMPORT_TIME.items()}


@pytest.mark.parametrize(
    ('settings', 'expected'),
    [
        ({'AUTOMATION_POLL_INTERVAL': '4'}, 4),
        ({'SCHEDULER_POLL_INTERVAL': '', 'AUTOMATION_POLL_INTERVAL': '4'}, 4),
        ({'SCHEDULER_POLL_INTERVAL': '6', 'AUTOMATION_POLL_INTERVAL': '4'}, 6),
        ({'SCHEDULER_POLL_INTERVAL': '6', 'AUTOMATION_POLL_INTERVAL': 'x'}, 6),
        ({'AUTOMATION_POLL_INTERVAL': 'x'}, 10),
    ],
)
def test_the_legacy_scheduler_interval_is_the_fallback(tmp_path, settings, expected):
    env = {**os.environ, 'HF_HUB_OFFLINE': '1', 'DATA_DIR': str(tmp_path), **settings}
    env.pop('DATABASE_URL', None)
    for name in ('SCHEDULER_POLL_INTERVAL', 'AUTOMATION_POLL_INTERVAL'):
        if name not in settings:
            env.pop(name, None)
    result = subprocess.run(
        [sys.executable, '-c', 'from local_llm.utils.automations import SCHEDULER_POLL_INTERVAL as v; print("V", v)'],
        cwd=SERVER_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert result.returncode == 0, result.stderr[-3000:]
    assert f'V {expected}' in result.stdout.splitlines()


@pytest.mark.parametrize(
    ('value', 'expected'),
    [('', {}), ('  ', {}), ('x', {}), ('0.5', {}), ('30', {'timeout': 30}), (' 30 ', {'timeout': 30}), (None, {})],
)
def test_oauth_timeout_is_read_at_call_time_without_failing(monkeypatch, value, expected):
    monkeypatch.setattr(config, 'OAUTH_TIMEOUT', value)

    assert config.oauth_client_kwargs('openid').get('timeout') == expected.get('timeout')
    assert ('timeout' in config.oauth_client_kwargs('openid')) == bool(expected)


def test_a_bad_oauth_timeout_is_warned_about(monkeypatch, caplog):
    monkeypatch.setattr(config, 'OAUTH_TIMEOUT', 'x')

    with caplog.at_level(logging.WARNING):
        config.oauth_client_kwargs('openid')
    assert 'OAUTH_TIMEOUT' in caplog.text


@pytest.mark.parametrize(
    ('value', 'profile', 'expected'),
    [
        (None, {}, 8090),
        ('', {}, 8090),
        ('x', {}, 8090),
        ('x', {'port': 9000}, 9000),
        ('', {'port': 9000}, 9000),
        ('9001', {'port': 9000}, 9001),
    ],
)
def test_llama_port_reads_leniently(monkeypatch, value, profile, expected):
    from local_llm.benchmarks.serving import env_profile

    if value is None:
        monkeypatch.delenv('LLAMA_PORT', raising=False)
    else:
        monkeypatch.setenv('LLAMA_PORT', value)

    assert env_profile.port(profile) == expected
