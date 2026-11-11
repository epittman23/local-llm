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

    # The daemon fails to start: the trap, set before it, still runs
    # `astro dev stop`, and the recipe does not go on to follow the logs.
    result, calls = _make(root, tmp_path, 'frontend', STUB_EXIT_BUNX='3')
    assert result.returncode != 0
    assert ['dev', 'logs', '--follow'] not in _bunx_astro(calls)
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
    assert re.search(r'^\s*workers:\s*4,', config, re.MULTILINE)


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
    # The first asks what already runs (#422), the next brings the services up.
    assert compose[0][-4:] == ['ps', '--services', '--status', 'running']
    assert 'up' in compose[1]
    assert compose[-1][-1] == 'down'
    assert '==> Stopping Postgres and Redis, Jupyter and SearXNG' in result.stdout


# --- make backend stops only what it started (#422) ---------------------------


def _compose_after_uvicorn(calls: list[dict]) -> list[list[str]]:
    """The compose calls the EXIT trap made: everything after uvicorn ran."""
    uvicorn = next(i for i, c in enumerate(calls) if c['tool'] == 'python' and 'uvicorn' in c['argv'])
    return [c['argv'][c['argv'].index('-f') + 2 :] for c in calls[uvicorn:] if c['tool'] == 'docker']


def test_backend_asks_what_runs_before_bringing_the_services_up(tmp_path):
    root = _checkout(tmp_path)
    result, calls = _make(root, tmp_path, 'backend', STUB_OUT_PYTHON='postgresql://stub')
    assert result.returncode == 0, result.stderr
    docker = [c['argv'] for c in calls if c['tool'] == 'docker']
    ps = next(i for i, argv in enumerate(docker) if argv[-4:] == ['ps', '--services', '--status', 'running'])
    up = next(i for i, argv in enumerate(docker) if 'up' in argv)
    assert ps < up


def test_backend_brings_everything_down_when_nothing_ran_before(tmp_path):
    root = _checkout(tmp_path)
    result, calls = _make(root, tmp_path, 'backend', STUB_OUT_PYTHON='postgresql://stub')
    assert result.returncode == 0, result.stderr
    assert _compose_after_uvicorn(calls) == [['down']]
    assert '==> Stopping Postgres and Redis, Jupyter and SearXNG' in result.stdout


def test_backend_leaves_services_that_ran_before_it_up(tmp_path):
    """Another `make backend` (starting, reloading) owns them: this run's exit must not take them down."""
    root = _checkout(tmp_path)
    every = 'postgres\nredis\njupyter\nsearxng'
    result, calls = _make(root, tmp_path, 'backend', STUB_OUT_PYTHON='postgresql://stub', STUB_OUT_DOCKER=every)
    assert result.returncode == 0, result.stderr
    assert _compose_after_uvicorn(calls) == []
    assert '==> Stopping Postgres' not in result.stdout
    assert 'leaving Postgres, Redis, Jupyter and SearXNG running' in result.stdout


def test_backend_stops_only_the_services_it_started(tmp_path):
    root = _checkout(tmp_path)
    result, calls = _make(
        root, tmp_path, 'backend', STUB_OUT_PYTHON='postgresql://stub', STUB_OUT_DOCKER='redis\npostgres'
    )
    assert result.returncode == 0, result.stderr
    assert _compose_after_uvicorn(calls) == [['rm', '-f', '-s', 'jupyter', 'searxng']]
    assert '==> Stopping Postgres' not in result.stdout


def test_backend_that_cannot_ask_compose_goes_on_and_brings_everything_down(tmp_path):
    """A failed `ps` counts as nothing running: the recipe goes on to `up`, and its trap runs `down`."""
    root = _checkout(tmp_path)
    result, calls = _make(root, tmp_path, 'backend', STUB_OUT_PYTHON='postgresql://stub', STUB_EXIT_DOCKER_COMPOSE='1')
    assert result.returncode != 0
    compose = [c['argv'][c['argv'].index('-f') + 2 :] for c in calls if c['tool'] == 'docker']
    assert compose[0] == ['ps', '--services', '--status', 'running']
    assert compose[1][:1] == ['up']
    assert compose[-1] == ['down']
    assert '==> Stopping Postgres and Redis, Jupyter and SearXNG' in result.stdout


# --- make secrets (#518) ----------------------------------------------------


def _git(cwd: Path, *args: str) -> None:
    ident = {'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'}
    subprocess.run(['git', *args], cwd=cwd, env={**os.environ, **ident}, check=True, capture_output=True)


def _gitleaks_mounts(calls: list[dict]) -> list[str]:
    (run,) = [c for c in calls if c['tool'] == 'docker' and c['argv'][:1] == ['run']]
    argv = run['argv']
    return [argv[i + 1] for i, arg in enumerate(argv) if arg == '-v']


def test_secrets_mounts_only_the_checkout_in_the_main_checkout(tmp_path):
    """The common git dir is inside the checkout, so no second mount is added."""
    root = _checkout(tmp_path)
    _git(root, 'init', '-q')
    result, calls = _make(root, tmp_path, 'secrets')
    assert result.returncode == 0, result.stderr
    assert _gitleaks_mounts(calls) == [f'{root}:/repo:ro']


def test_secrets_mounts_the_common_git_dir_from_a_linked_worktree(tmp_path):
    """In a linked worktree `.git` is a file; the history lives in the main checkout's .git."""
    main = _checkout(tmp_path, 'main')
    _git(main, 'init', '-q')
    _git(main, 'commit', '-q', '--allow-empty', '-m', 'init')
    linked = tmp_path / 'wt'
    _git(main, 'worktree', 'add', '-q', '--detach', str(linked))
    shutil.copy(main / 'Makefile', linked / 'Makefile')
    result, calls = _make(linked, tmp_path, 'secrets')
    assert result.returncode == 0, result.stderr
    common = str((main / '.git').resolve())
    assert _gitleaks_mounts(calls) == [f'{linked}:/repo:ro', f'{common}:{common}:ro']


# --- make sandbox-images ----------------------------------------------------


def _sandbox_checkout(tmp_path: Path) -> tuple[Path, Path]:
    root = _checkout(tmp_path)
    sandbox = root / 'infra' / 'sandbox'
    sandbox.mkdir()
    (sandbox / 'TAG').write_text('2030-01-01.1\n')
    return root, sandbox


def test_sandbox_images_builds_both_images_at_the_tag_and_records_the_freezes(tmp_path):
    """One TAG file names both images; the data image's Python and R packages are committed."""
    root, sandbox = _sandbox_checkout(tmp_path)
    result, calls = _make(root, tmp_path, 'sandbox-images', STUB_OUT_DOCKER='pandas==9.9.9')
    assert result.returncode == 0, result.stderr
    image = 'local-llm/sandbox-data:2030-01-01.1'
    docker = [c['argv'] for c in calls if c['tool'] == 'docker']
    assert docker[:2] == [
        ['build', '-f', f'{sandbox}/Dockerfile.data', '-t', image, str(sandbox)],
        ['build', '-f', f'{sandbox}/Dockerfile.web', '-t', 'local-llm/sandbox-web:2030-01-01.1', str(sandbox)],
    ]
    assert docker[2] == [
        'run',
        '--rm',
        '--network',
        'none',
        image,
        'pip',
        'list',
        '--format=freeze',
        '--disable-pip-version-check',
    ]
    assert docker[3][:6] == ['run', '--rm', '--network', 'none', image, 'Rscript']
    assert len(docker) == 4
    # The stub prints its canned output for every docker call, so each freeze
    # file holds its run's output (the builds' go to the terminal, not to it).
    assert (sandbox / 'image-freeze.txt').read_text() == 'pandas==9.9.9\n'
    assert (sandbox / 'image-freeze-r.txt').read_text() == 'pandas==9.9.9\n'
    assert not list(sandbox.glob('*.tmp'))


def test_sandbox_images_refuses_without_a_tag(tmp_path):
    root = _checkout(tmp_path)
    result, calls = _make(root, tmp_path, 'sandbox-images')
    assert result.returncode != 0
    assert 'infra/sandbox/TAG' in result.stderr
    assert calls == []


def test_sandbox_images_stops_at_a_failed_build_and_keeps_the_committed_freezes(tmp_path):
    root, sandbox = _sandbox_checkout(tmp_path)
    (sandbox / 'image-freeze.txt').write_text('committed==1\n')
    result, calls = _make(root, tmp_path, 'sandbox-images', STUB_EXIT_DOCKER_BUILD='1')
    assert result.returncode != 0
    assert [c['argv'][0] for c in calls if c['tool'] == 'docker'] == ['build']
    assert (sandbox / 'image-freeze.txt').read_text() == 'committed==1\n'


def test_sandbox_images_keeps_the_committed_freeze_when_recording_it_fails(tmp_path):
    root, sandbox = _sandbox_checkout(tmp_path)
    (sandbox / 'image-freeze.txt').write_text('committed==1\n')
    result, calls = _make(root, tmp_path, 'sandbox-images', STUB_EXIT_DOCKER_RUN='1')
    assert result.returncode != 0
    assert (sandbox / 'image-freeze.txt').read_text() == 'committed==1\n'
    assert not list(sandbox.glob('*.tmp'))
