"""The root Makefile's recipes, run for real against stub tools.

The Makefile owns process lifecycle (AGENTS.md, "The Makefile stays thin"),
so its failure paths matter: a step that fails must stop the recipe, and a
trap must be set before the thing it cleans up is started. Each test copies
the Makefile into a temporary checkout, puts stub `docker`, `bun`, `bunx`,
`uv`, `uvx`, `ss` and `sleep` executables first on PATH, runs a target, and
reads back what the stubs were asked to do. Nothing real is started.
"""

import json
import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]

pytestmark = pytest.mark.skipif(shutil.which('make') is None, reason='needs make')

# Every stub appends one JSON line, {"tool": ..., "argv": [...], "ci": ...},
# to $STUB_LOG, then exits with $STUB_EXIT_<TOOL> (default 0). A stub can also
# print $STUB_OUT_<TOOL> first.
STUB = """#!/bin/bash
tool="$(basename "$0")"
python3 - "$tool" "$@" <<'PY' >> "$STUB_LOG"
import json, os, sys
print(json.dumps({'tool': sys.argv[1], 'argv': sys.argv[2:], 'ci': os.environ.get('CI')}))
PY
upper="$(printf '%s' "$tool" | tr 'a-z' 'A-Z')"
out_var="STUB_OUT_$upper"; exit_var="STUB_EXIT_$upper"
[ -z "${!out_var:-}" ] || printf '%s\\n' "${!out_var}"
exit "${!exit_var:-0}"
"""

STUB_TOOLS = ('docker', 'bun', 'bunx', 'uv', 'uvx', 'ss', 'sleep', 'openssl')


def _checkout(tmp_path: Path, name: str = 'repo') -> Path:
    """A temporary checkout: the real Makefile and compose file, stub tools."""
    root = tmp_path / name
    (root / 'infra').mkdir(parents=True)
    shutil.copy(REPO_ROOT / 'Makefile', root / 'Makefile')
    shutil.copy(REPO_ROOT / 'infra' / 'docker-compose.yml', root / 'infra' / 'docker-compose.yml')
    for sub in ('apps/web', 'apps/desktop', 'apps/server/tests'):
        (root / sub).mkdir(parents=True, exist_ok=True)
    bin_dir = tmp_path / 'bin'
    bin_dir.mkdir(exist_ok=True)
    for tool in STUB_TOOLS:
        path = bin_dir / tool
        path.write_text(STUB)
        path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return root


def _make(root: Path, tmp_path: Path, target: str, **env: str) -> tuple[subprocess.CompletedProcess[str], list[dict]]:
    log = tmp_path / 'calls.jsonl'
    log.write_text('')
    full_env = {
        'PATH': f'{tmp_path / "bin"}:{os.environ["PATH"]}',
        'HOME': str(tmp_path),
        'STUB_LOG': str(log),
        **env,
    }
    result = subprocess.run(
        ['make', '--no-print-directory', '-C', str(root), target],
        env=full_env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    calls = [json.loads(line) for line in log.read_text().splitlines() if line]
    return result, calls


def _bunx_astro(calls: list[dict]) -> list[list[str]]:
    return [c['argv'][1:] for c in calls if c['tool'] == 'bunx' and c['argv'][:1] == ['astro']]


# --- make frontend (#145) ---------------------------------------------------


def test_frontend_stops_when_bun_install_fails(tmp_path):
    """A failed install must fail the recipe, not start a dev server on stale deps."""
    root = _checkout(tmp_path)
    result, calls = _make(root, tmp_path, 'frontend', STUB_EXIT_BUN='1')
    assert result.returncode != 0
    assert ['dev', '--background'] not in _bunx_astro(calls)
    assert not any(c['tool'] == 'bunx' and '--background' in c['argv'] for c in calls)


def test_frontend_sets_its_stop_trap_before_starting_the_dev_server(tmp_path):
    """The daemon is stopped on exit, including when `logs --follow` fails."""
    root = _checkout(tmp_path)
    result, calls = _make(root, tmp_path, 'frontend', STUB_EXIT_BUNX='0')
    assert result.returncode == 0, result.stderr
    astro = _bunx_astro(calls)
    assert astro[0][:2] == ['dev', '--background']
    assert astro[-1] == ['dev', 'stop']

    # The daemon starts but `logs --follow` fails: the trap still stops it.
    result, calls = _make(root, tmp_path, 'frontend', STUB_EXIT_BUNX='3')
    assert result.returncode != 0
    assert _bunx_astro(calls)[-1] == ['dev', 'stop']
