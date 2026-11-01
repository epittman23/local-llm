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
import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]

pytestmark = pytest.mark.skipif(shutil.which('make') is None, reason='needs make')

# Every stub appends one JSON line, {"tool": ..., "argv": [...], "ci": ...},
# to $STUB_LOG, then exits with $STUB_EXIT_<TOOL>_<FIRST ARG> if set, else
# $STUB_EXIT_<TOOL> (default 0). A stub can also print $STUB_OUT_<TOOL> first.
STUB = """#!/bin/bash
tool="$(basename "$0")"
python3 - "$tool" "$@" <<'PY' >> "$STUB_LOG"
import json, os, sys
print(json.dumps({'tool': sys.argv[1], 'argv': sys.argv[2:], 'ci': os.environ.get('CI')}))
PY
upper="$(printf '%s' "$tool" | tr 'a-z' 'A-Z')"
sub="$(printf '%s' "${1:-}" | tr 'a-z' 'A-Z' | tr -c 'A-Z0-9_' '_')"
out_var="STUB_OUT_$upper"; exit_var="STUB_EXIT_$upper"; sub_var="STUB_EXIT_${upper}_$sub"
[ -z "${!out_var:-}" ] || printf '%s\\n' "${!out_var}"
exit "${!sub_var:-${!exit_var:-0}}"
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
    # What `make backend` reads: infra/.env with every key it checks, and the
    # backend venv's interpreter, here a stub that prints a database URL.
    (root / 'infra' / '.env').write_text(
        'OPENROUTER_API_KEY=stub\nPOSTGRES_PASSWORD=stub\nLLLM_SECRET_KEY=stub\nJUPYTER_TOKEN=stub\nSEARXNG_SECRET=stub\n'
    )
    bin_dir = tmp_path / 'bin'
    bin_dir.mkdir(exist_ok=True)
    venv_bin = root / 'apps' / 'server' / '.venv' / 'bin'
    venv_bin.mkdir(parents=True)
    for path in [bin_dir / tool for tool in STUB_TOOLS] + [venv_bin / 'python']:
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


# --- make test-e2e (#146) ---------------------------------------------------


def test_e2e_runs_ci_command_with_ci_set(tmp_path):
    """`make test-e2e` runs what CI runs (`bun run test:e2e`), with CI=1 as CI has CI=true."""
    root = _checkout(tmp_path)
    result, calls = _make(root, tmp_path, 'test-e2e')
    assert result.returncode == 0, result.stderr
    runs = [c for c in calls if c['tool'] == 'bun' and c['argv'][:1] == ['run']]
    assert [c['argv'] for c in runs] == [['run', 'test:e2e']]
    assert runs[0]['ci'] == '1'
    assert not any(c['tool'] == 'bunx' and c['argv'][:2] == ['playwright', 'test'] for c in calls)

    ci_job = (REPO_ROOT / '.github' / 'workflows' / 'ci.yml').read_text()
    assert '- run: bun run test:e2e' in ci_job


def test_playwright_worker_count_is_pinned_in_its_config():
    """The worker count lives in playwright.config.ts, so CI and `make test-e2e` share it."""
    config = (REPO_ROOT / 'apps' / 'web' / 'playwright.config.ts').read_text()
    assert re.search(r'^\s*workers:\s*2,', config, re.MULTILINE)


# --- the throwaway Postgres of make test-backend and make test-boot (#147) ---

LISTENER_ON_ALL_ADDRESSES = 'LISTEN 0 4096 0.0.0.0:{port} 0.0.0.0:*'


@pytest.mark.parametrize(('target', 'port'), [('test-backend', '55432'), ('test-boot', '55433')])
def test_port_check_sees_a_listener_on_any_address(tmp_path, target, port):
    """A port held on 0.0.0.0 or [::] is in use too, not only one held on 127.0.0.1."""
    root = _checkout(tmp_path)
    result, calls = _make(root, tmp_path, target, STUB_OUT_SS=LISTENER_ON_ALL_ADDRESSES.format(port=port))
    assert result.returncode != 0
    assert f'port {port} is in use' in result.stderr
    assert not any(c['tool'] == 'docker' and c['argv'][:1] == ['run'] for c in calls)


@pytest.mark.parametrize('target', ['test-backend', 'test-boot'])
def test_postgres_that_never_gets_ready_stops_the_recipe(tmp_path, target):
    """Running out of readiness probes is a failure, not a fall-through into the tests."""
    root = _checkout(tmp_path)
    result, calls = _make(root, tmp_path, target, STUB_EXIT_DOCKER_EXEC='2')
    assert result.returncode != 0
    assert 'did not accept connections' in result.stderr
    assert not any(c['tool'] == 'uv' and c['argv'][:1] == ['run'] for c in calls)


@pytest.mark.parametrize('target', ['test-backend', 'test-boot'])
def test_readiness_probe_uses_tcp_not_the_socket(tmp_path, target):
    """The image's init server listens on the Unix socket only, so probe over TCP."""
    root = _checkout(tmp_path)
    result, calls = _make(root, tmp_path, target)
    assert result.returncode == 0, result.stderr
    probes = [c['argv'] for c in calls if c['tool'] == 'docker' and c['argv'][:1] == ['exec']]
    assert probes, calls
    assert 'pg_isready' in probes[0]
    assert probes[0][probes[0].index('-h') + 1] == '127.0.0.1'


# --- make backend waits for Postgres (#148) -----------------------------------


def _compose_up_calls(calls: list[dict]) -> list[tuple[int, list[str]]]:
    return [(i, c['argv']) for i, c in enumerate(calls) if c['tool'] == 'docker' and 'up' in c['argv']]


def test_backend_waits_for_postgres_before_starting_the_app(tmp_path):
    """Migrations run when the app is imported, so Postgres must be accepting connections first."""
    root = _checkout(tmp_path)
    result, calls = _make(root, tmp_path, 'backend', STUB_OUT_PYTHON='postgresql://stub')
    assert result.returncode == 0, result.stderr
    uvicorn = next(i for i, c in enumerate(calls) if c['tool'] == 'python' and 'uvicorn' in c['argv'])
    waits = [(i, argv) for i, argv in _compose_up_calls(calls) if '--wait' in argv and 'postgres' in argv]
    assert waits, _compose_up_calls(calls)
    assert waits[0][0] < uvicorn


def test_postgres_healthcheck_probes_over_tcp():
    """What `up --wait` waits on: pg_isready over TCP, since the init server is socket-only."""
    compose = yaml.safe_load((REPO_ROOT / 'infra' / 'docker-compose.yml').read_text())
    test = compose['services']['postgres']['healthcheck']['test']
    assert test[:2] == ['CMD', 'pg_isready']
    assert test[test.index('-h') + 1] == '127.0.0.1'


# --- a checkout path with a space or a quote (#428) ---------------------------


@pytest.mark.parametrize('name', ['local llm', "eli's checkout"])
def test_backend_keeps_a_spaced_or_quoted_checkout_path_whole(tmp_path, name):
    """`make -C '<path>' backend`, as the desktop app runs it, starts and stops the services."""
    root = _checkout(tmp_path, name)
    result, calls = _make(root, tmp_path, 'backend', STUB_OUT_PYTHON='postgresql://stub')
    assert result.returncode == 0, result.stderr
    compose_file = str(root / 'infra' / 'docker-compose.yml')
    compose = [c['argv'] for c in calls if c['tool'] == 'docker' and c['argv'][:1] == ['compose']]
    assert [argv[argv.index('-f') + 1] for argv in compose] == [compose_file] * len(compose)
    assert 'up' in compose[0]
    assert compose[-1][-1] == 'down'
    assert '==> Stopping Postgres and Redis, Jupyter and SearXNG' in result.stdout
