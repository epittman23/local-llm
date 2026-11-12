"""The sandbox's package telemetry (T21): the image hooks, the parsers, the collection, the table and the report.

Pins, without Docker or Kata:

- the events file is parsed as hostile: only the hooks' kinds and fields,
  names and versions by fixed rules and lengths, a line and line-count cap,
  an implausible timestamp replaced;
- the miss matchers: pip's, bash's, R's and LaTeX's wording, each kind and
  name once per call, a name that breaks its rule dropped;
- a mirror log line counts only as a GET answered 200 for a wheel;
- through SandboxManager and FakeBackend: the file is read through the
  daemon only when it is a regular file under a real directory, emptied
  through lllm-path (the real script agrees), never followed through a
  symlink; the `bash` tool records imports, misses and installs with the
  chat, the image digest, the lock's hash and the harness run id, and
  installs are attributed by the sandbox's address, the mirror cursor
  moving on; no failure of the telemetry changes the tool's result;
- the Kata backend reads the mirror's log through the daemon's logs
  endpoint, bounded and after the cursor;
- the image hooks: sitecustomize.py run for real in a subprocess, and
  Rprofile.site run with R when it is installed (a static check otherwise);
- the table round-trips, the report ranks and leaves harness rows out, and
  the admin route refuses everyone else;
- the benchmark runner puts its suite run id on the harness request.

Run from apps/server (any LLLM_SECRET_KEY of 32 characters or more):

    LLLM_SECRET_KEY=... python -m pytest tests/test_sandbox_telemetry.py
"""

import asyncio
import datetime as dt
import hashlib
import json
import logging
import os
import shutil
import struct
import subprocess
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import docker.errors
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.benchmarks.evaluation import runner
from local_llm.models.sandbox import SandboxPackageEvents
from local_llm.models.users import Users
from local_llm.routers import sandbox as sandbox_router
from local_llm.sandbox import SandboxError, SandboxManager, SandboxSettings, telemetry, workspace
from local_llm.sandbox.fake import FakeBackend, FakeExecRequest, FakeFile, FakeWorkspace, interpret
from local_llm.sandbox.kata import MIRROR_CONTAINER, KataDockerBackend, log_time_ns, read_log_lines
from local_llm.sandbox.limits import MIRROR_LOG_MAX_BYTES, SANDBOX_UID, TIMEOUT_DEFAULT_S
from local_llm.sandbox.telemetry import (
    EVENTS_DIR,
    EVENTS_MAX_BYTES,
    EVENTS_MAX_LINES,
    EVENTS_PATH,
    MISSES_MAX,
    TRUNCATE_SCRIPT,
    Event,
    PackageSources,
    PackageTelemetry,
    output_misses,
    parse_events,
    parse_mirror_line,
)
from local_llm.sandbox.types import MirrorLine
from local_llm.sandbox.workspaces import MemoryWorkspaces
from local_llm.tools import builtin
from local_llm.utils.auth import create_token

REPO = Path(__file__).resolve().parents[3]
SITECUSTOMIZE = REPO / 'infra' / 'sandbox' / 'data' / 'sitecustomize.py'
RPROFILE = REPO / 'infra' / 'sandbox' / 'data' / 'Rprofile.site'
LLLM_PATH_SOURCE = REPO / 'infra' / 'sandbox' / 'common' / 'lllm-path'
EVENTS_LINE = "EVENTS = '/workspace/.telemetry/events.jsonl'\n"
CHAT = '33333333-3333-4333-8333-333333333333'
OTHER = '44444444-4444-4444-8444-444444444444'
NOW = 1_800_000_000
NS = 1_000_000_000


def run(coro):
    return asyncio.run(coro)


def line(**fields: Any) -> bytes:
    return json.dumps(fields).encode()


def mirror(remote: str, uri: str, *, method: str = 'GET', status: int = 200) -> str:
    return json.dumps(
        {'time': '2026-11-12T10:00:00+00:00', 'remote': remote, 'method': method, 'uri': uri, 'status': status}
    )


# The events file's parser.


def test_parse_events_keeps_valid_lines_and_normalises_distribution_names():
    data = b'\n'.join(
        [
            line(kind='import', name='Scikit_Learn', version='1.7.2', ts=NOW - 5),
            line(kind='r_import', name='data.table', version='1.18.6.1', ts=NOW),
            line(kind='module_miss', name='notapkg', ts=NOW),
            line(kind='module_miss', name='notapkg'),
            b'',
        ]
    )
    events, dropped = parse_events(data, now=NOW)
    assert dropped == 0
    assert events == [
        Event('import', 'scikit-learn', '1.7.2', NOW - 5),
        Event('r_import', 'data.table', '1.18.6.1', NOW),
        Event('module_miss', 'notapkg', None, NOW),
        Event('module_miss', 'notapkg', None, NOW),
    ]


@pytest.mark.parametrize(
    'bad',
    [
        b'not json',
        b'[1, 2]',
        b'\xff\xfe',
        line(kind='install', name='pandas', version='2.3.0', ts=NOW),
        line(kind='command_miss', name='ls', ts=NOW),
        line(kind='import', name='pandas', version='1', ts=NOW, extra=1),
        line(kind='import', name='a b', version='1', ts=NOW),
        line(kind='import', name='x' * 129, version='1', ts=NOW),
        line(kind='import', name='', version='1', ts=NOW),
        line(kind='import', name=['pandas'], version='1', ts=NOW),
        line(kind='import', name='pandas/../x', version='1', ts=NOW),
        line(kind='r_import', name='1abc', version='1', ts=NOW),
        line(kind='module_miss', name='a.b', ts=NOW),
        line(kind='module_miss', name='x', version='1', ts=NOW),
        line(kind='import', name='a' * 2000, ts=NOW),
        line(kind='import', name='pändas', version='1', ts=NOW),
    ],
)
def test_parse_events_drops_a_line_that_breaks_a_rule(bad):
    assert parse_events(bad, now=NOW) == ([], 1)


def test_parse_events_keeps_an_import_whose_version_is_not_one_without_it():
    data = b'\n'.join(
        [
            line(kind='import', name='pandas', version='x' * 65, ts=NOW),
            line(kind='import', name='numpy', version='2.0;rm -rf', ts=NOW),
            line(kind='import', name='scipy', version=7, ts=NOW),
            line(kind='import', name='polars', ts=NOW),
        ]
    )
    events, _ = parse_events(data, now=NOW)
    assert [(e.name, e.version) for e in events] == [
        ('pandas', None),
        ('numpy', None),
        ('scipy', None),
        ('polars', None),
    ]


@pytest.mark.parametrize('ts', [0, NOW + 10**9, 'yesterday', True, None, 1e400])
def test_parse_events_replaces_an_implausible_timestamp_with_the_collection_s(ts):
    data = line(kind='import', name='pandas', version='2', ts=ts)
    assert parse_events(data, now=NOW)[0][0].ts == NOW


def test_parse_events_reads_at_most_the_line_cap():
    data = b'\n'.join(line(kind='import', name=f'p{i}', version='1', ts=NOW) for i in range(EVENTS_MAX_LINES + 7))
    events, dropped = parse_events(data, now=NOW)
    assert (len(events), dropped) == (EVENTS_MAX_LINES, 7)


# The output's misses.


def test_output_misses_match_each_wording_once():
    stderr = '\n'.join(
        [
            'ERROR: Could not find a version that satisfies the requirement Not_A_Pkg==1.0 (from versions: none)',
            'ERROR: No matching distribution found for Not_A_Pkg==1.0',
            'bash: line 1: fakecmd: command not found',
            'bash: fakecmd: command not found',
            '/bin/bash: line 4: other-cmd: command not found',
            'Error in library(foo): there is no package called ‘foo.bar’',
            "Error: there is no package called 'baz'",
        ]
    )
    stdout = "! LaTeX Error: File `tikzfoo.sty' not found.\n"
    misses = output_misses(stdout, stderr, now=NOW)
    assert [(e.kind, e.name) for e in misses] == [
        ('pip_miss', 'not-a-pkg'),
        ('command_miss', 'fakecmd'),
        ('command_miss', 'other-cmd'),
        ('r_miss', 'foo.bar'),
        ('r_miss', 'baz'),
        ('latex_miss', 'tikzfoo.sty'),
    ]
    assert all(e.ts == NOW and e.version is None for e in misses)


def test_output_misses_ignore_names_that_break_their_rule_and_stdout_for_commands():
    stderr = "bash: line 1: printf 'a > b': command not found\nFile `../../etc/passwd' not found\n"
    assert output_misses('ghost: command not found\n', stderr, now=NOW) == []


def test_output_misses_are_capped():
    stderr = ''.join(f'bash: c{i}: command not found\n' for i in range(MISSES_MAX + 10))
    assert len(output_misses('', stderr, now=NOW)) == MISSES_MAX


# The mirror's log lines.


def test_a_wheel_served_in_full_is_an_install():
    assert parse_mirror_line(mirror('10.231.0.130', '/scikit_learn-1.7.2-cp313-cp313-manylinux_2_28_x86_64.whl')) == (
        '10.231.0.130',
        'scikit-learn',
        '1.7.2',
    )
    # A build tag, a URL-encoded local version and a query string.
    assert parse_mirror_line(mirror('10.231.0.131', '/pkg-1.0%2Blocal-1-py3-none-any.whl?x=1')) == (
        '10.231.0.131',
        'pkg',
        '1.0+local',
    )


@pytest.mark.parametrize(
    'text',
    [
        mirror('10.231.0.130', '/pandas-2.3.0-cp313-cp313-manylinux_2_28_x86_64.whl', method='HEAD'),
        mirror('10.231.0.130', '/pandas-2.3.0-cp313-cp313-manylinux_2_28_x86_64.whl', status=404),
        mirror('10.231.0.130', '/'),
        mirror('10.231.0.130', '/pandas-2.3.0.tar.gz'),
        mirror('not-an-ip', '/pandas-2.3.0-cp313-cp313-manylinux_2_28_x86_64.whl'),
        mirror('10.231.0.130', '/a%20b-1.0-py3-none-any.whl'),
        'not json',
        '[]',
        json.dumps({'remote': '10.231.0.130', 'method': 'GET', 'status': '200', 'uri': '/a-1-py3-none-any.whl'}),
        mirror('10.231.0.130', '/' + 'a' * 20_000 + '-1-py3-none-any.whl'),
    ],
)
def test_anything_else_in_the_mirror_log_is_not(text):
    assert parse_mirror_line(text) is None


def test_harness_run_id_from_the_request():
    assert telemetry.harness_run_id(SimpleNamespace(state=SimpleNamespace(harness_run_id='run-1'))) == 'run-1'
    harness = SimpleNamespace(state=SimpleNamespace(benchmark_harness=True))
    assert telemetry.harness_run_id(harness) == telemetry.HARNESS_UNKNOWN
    assert telemetry.harness_run_id(SimpleNamespace(state=SimpleNamespace())) is None
    assert telemetry.harness_run_id(None) is None


def test_package_sources_read_the_repository_s_lists():
    sources = telemetry.package_sources()
    assert sources.source('python', 'pandas') == 'image'
    wheelhouse_only = sorted(sources.wheelhouse - sources.image)
    assert wheelhouse_only, 'requirements.lock adds packages the image lacks'
    assert sources.source('python', wheelhouse_only[0]) == 'wheelhouse'
    assert sources.source('python', 'surely-not-a-package') == 'other'
    assert sources.source('r', 'data.table') == 'image'
    assert sources.source('r', 'pandas') == 'other'


def test_lock_sha_is_the_lock_s_hash_and_empty_when_unreadable(tmp_path):
    lock = tmp_path / 'requirements.lock'
    lock.write_bytes(b'a==1\n')
    collector = PackageTelemetry(lock_file=lock)
    assert collector.lock_sha() == hashlib.sha256(b'a==1\n').hexdigest()
    lock.write_bytes(b'a==2 \n')
    assert collector.lock_sha() == hashlib.sha256(b'a==2 \n').hexdigest()
    lock.unlink()
    assert collector.lock_sha() == ''
    assert PackageTelemetry().lock_sha() == hashlib.sha256(telemetry.REQUIREMENTS_LOCK.read_bytes()).hexdigest()


# The collection, through SandboxManager and FakeBackend.


class _Chats:
    async def usable(self, chat_id, user):
        return chat_id in (CHAT, OTHER) and user.id == 'u1'

    async def updated_at(self, chat_ids):
        return {}


async def _settings() -> SandboxSettings:
    return SandboxSettings()


class Rig:
    """The `bash` tool on a manager over a FakeBackend, with the package telemetry on app.state, rows kept in memory."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, *, store=None) -> None:
        self.backend = FakeBackend()
        self.backend.image_ids = {'data': 'sha256:data-image', 'web': 'sha256:web-image'}
        self.manager = SandboxManager(self.backend, workspaces=MemoryWorkspaces(), chats=_Chats(), settings=_settings)
        self.rows: list[dict] = []
        self.lock = tmp_path / 'requirements.lock'
        self.lock.write_bytes(b'pkg==1.0\n')

        async def keep(rows):
            self.rows.extend(rows)

        self.telemetry = PackageTelemetry(
            store=store or keep, wall_clock=lambda: float(NOW), wall_clock_ns=lambda: NOW * NS, lock_file=self.lock
        )
        state = SimpleNamespace(sandbox=self.manager, sandbox_telemetry=self.telemetry)
        self.request = SimpleNamespace(app=SimpleNamespace(state=state), state=SimpleNamespace())

        async def get_user_by_id(user_id, db=None):
            return SimpleNamespace(id=user_id, role='user') if user_id == 'u1' else None

        async def configured_timeout() -> int:
            return TIMEOUT_DEFAULT_S

        monkeypatch.setattr(Users, 'get_user_by_id', get_user_by_id)
        monkeypatch.setattr(builtin, 'configured_timeout', configured_timeout)

    def bash(self, command: str, chat_id: str = CHAT, **kwargs) -> dict:
        async def go():
            return await builtin.bash(
                command, __request__=self.request, __user__={'id': 'u1'}, __chat_id__=chat_id, **kwargs
            )

        return json.loads(run(go()))

    def files(self, chat_id: str = CHAT) -> dict[str, FakeFile]:
        return self.backend.sandboxes[chat_id].files

    def plant(self, data: bytes, chat_id: str = CHAT) -> None:
        """An events file as the hooks leave it, owned by UID 1000."""
        files = self.files(chat_id)
        files.setdefault(EVENTS_DIR, FakeFile(content=None, uid=SANDBOX_UID, mode=0o700))
        files[EVENTS_PATH] = FakeFile(content=data, uid=SANDBOX_UID, mode=0o644)

    def truncations(self) -> int:
        return sum(1 for name, args in self.backend.calls if name == 'exec' and TRUNCATE_SCRIPT in (args['argv'] or []))


EVENTS = b'\n'.join(
    [
        line(kind='import', name='pandas', version='2.3.0', ts=NOW - 2),
        line(kind='import', name='numpy', version='2.3.1', ts=NOW - 2),
        line(kind='module_miss', name='notapkg', ts=NOW - 1),
        b'garbage',
        b'',
    ]
)


def _row(kind, name, version=None, ts=NOW, chat=CHAT, image='sha256:data-image', lock=None, harness=None):
    return {
        'ts': ts,
        'chat_id': chat,
        'kind': kind,
        'name': name,
        'version': version,
        'image_digest': image,
        'lock_sha': lock,
        'harness_run_id': harness,
    }


def test_bash_records_the_events_misses_and_installs_of_its_call(monkeypatch, tmp_path):
    rig = Rig(monkeypatch, tmp_path)
    assert rig.bash('mkdir outputs')['returncode'] == 0
    # Nothing recorded, and no exec spent on a file that is not there.
    assert rig.rows == [] and rig.truncations() == 0
    rig.plant(EVENTS)
    ip = rig.backend.sandboxes[CHAT].ip
    assert ip is not None
    rig.backend.mirror_lines.append(MirrorLine((NOW + 1) * NS, mirror(ip, '/lifelines-0.30.0-py3-none-any.whl')))
    result = rig.bash('fakecmd')
    assert result['returncode'] == 127
    lock = hashlib.sha256(b'pkg==1.0\n').hexdigest()
    assert rig.rows == [
        _row('import', 'pandas', '2.3.0', NOW - 2, lock=lock),
        _row('import', 'numpy', '2.3.1', NOW - 2, lock=lock),
        _row('module_miss', 'notapkg', None, NOW - 1, lock=lock),
        _row('command_miss', 'fakecmd', lock=lock),
        _row('install', 'lifelines', '0.30.0', NOW + 1, lock=lock),
    ]
    # Emptied through the guest helper, not removed.
    assert rig.files()[EVENTS_PATH].content == b''
    assert rig.truncations() == 1
    rig.rows.clear()
    rig.bash('mkdir more')
    # Read once: the file is empty and the mirror's cursor has moved past its line.
    assert rig.rows == []
    assert rig.truncations() == 1


def test_a_harness_call_carries_its_run_id(monkeypatch, tmp_path):
    rig = Rig(monkeypatch, tmp_path)
    rig.request.state.benchmark_harness = True
    rig.request.state.harness_run_id = '20261112T100000Z-abc123'
    rig.bash('mkdir outputs')
    rig.plant(line(kind='import', name='pandas', version='2.3.0', ts=NOW))
    rig.bash('mkdir x')
    assert [(r['name'], r['harness_run_id']) for r in rig.rows] == [('pandas', '20261112T100000Z-abc123')]


def test_installs_go_to_the_chat_whose_sandbox_has_the_address_and_unknown_ones_are_dropped(monkeypatch, tmp_path):
    rig = Rig(monkeypatch, tmp_path)
    rig.bash('mkdir a', chat_id=CHAT)
    rig.bash('mkdir b', chat_id=OTHER, image='web')
    mine, other = rig.backend.sandboxes[CHAT].ip, rig.backend.sandboxes[OTHER].ip
    assert mine and other and mine != other
    rig.backend.mirror_lines += [
        MirrorLine((NOW + 1) * NS, mirror(other, '/autograd-1.9.1-py3-none-any.whl')),
        MirrorLine((NOW + 2) * NS, mirror('10.231.0.250', '/cloudpickle-3.1.2-py3-none-any.whl')),
        MirrorLine((NOW + 3) * NS, mirror(mine, '/')),
    ]
    rig.bash('mkdir c', chat_id=CHAT)
    # Read during CHAT's call, but OTHER's sandbox fetched it: OTHER's chat and image.
    assert [(r['chat_id'], r['kind'], r['name'], r['image_digest']) for r in rig.rows] == [
        (OTHER, 'install', 'autograd', 'sha256:web-image')
    ]


def test_an_install_from_a_sandbox_that_stopped_since_the_last_listing_keeps_its_chat(monkeypatch, tmp_path):
    rig = Rig(monkeypatch, tmp_path)
    rig.bash('mkdir a')
    ip = rig.backend.sandboxes[CHAT].ip
    rig.backend.mirror_lines.append(MirrorLine((NOW + 1) * NS, mirror(ip, '/autograd-1.9.1-py3-none-any.whl')))
    rig.bash('mkdir b')
    assert len(rig.rows) == 1
    rig.backend.mirror_lines.append(MirrorLine((NOW + 2) * NS, mirror(ip, '/autograd-1.9.1-py3-none-any.whl')))
    run(rig.backend.stop(CHAT))
    rows = run(rig.telemetry.mirror_events(rig.manager))
    assert [(r['chat_id'], r['name']) for r in rows] == [(CHAT, 'autograd')]
    # Forgotten once a listing no longer shows it: its address may go to another sandbox.
    rig.backend.mirror_lines.append(MirrorLine((NOW + 3) * NS, mirror(ip, '/autograd-1.9.1-py3-none-any.whl')))
    assert run(rig.telemetry.mirror_events(rig.manager)) == []


def test_an_ephemeral_sandbox_s_events_carry_its_unsaved_chat_id(monkeypatch, tmp_path):
    rig = Rig(monkeypatch, tmp_path)
    chat = 'temporary:benchmark-0123'
    rig.bash('mkdir a', chat_id=chat)
    key = next(iter(rig.backend.sandboxes))
    assert rig.manager.chat_of(key) == chat
    rig.plant(line(kind='import', name='pandas', version='2', ts=NOW), chat_id=key)
    rig.backend.mirror_lines.append(
        MirrorLine((NOW + 1) * NS, mirror(rig.backend.sandboxes[key].ip or '', '/autograd-1.9.1-py3-none-any.whl'))
    )
    rig.bash('mkdir b', chat_id=chat)
    assert [(r['chat_id'], r['kind']) for r in rig.rows] == [(chat, 'import'), (chat, 'install')]


@pytest.mark.parametrize('shape', ['symlinked file', 'symlinked directory', 'fifo', 'directory'])
def test_an_events_file_that_is_not_a_regular_file_under_a_real_directory_is_never_read(monkeypatch, tmp_path, shape):
    rig = Rig(monkeypatch, tmp_path)
    rig.bash('mkdir a')
    files = rig.files()
    secret = line(kind='import', name='leaked', version='1', ts=NOW)
    files['/workspace/elsewhere'] = FakeFile(content=None, uid=SANDBOX_UID, mode=0o755)
    files['/workspace/elsewhere/events.jsonl'] = FakeFile(content=secret, uid=SANDBOX_UID, mode=0o644)
    if shape == 'symlinked directory':
        files[EVENTS_DIR] = FakeFile(content=None, uid=SANDBOX_UID, mode=0o777, link='/workspace/elsewhere')
    else:
        files[EVENTS_DIR] = FakeFile(content=None, uid=SANDBOX_UID, mode=0o700)
    if shape == 'symlinked file':
        files[EVENTS_PATH] = FakeFile(
            content=None, uid=SANDBOX_UID, mode=0o777, link='/workspace/elsewhere/events.jsonl'
        )
    elif shape == 'fifo':
        files[EVENTS_PATH] = FakeFile(content=b'', uid=SANDBOX_UID, mode=0o644, fifo=True)
    elif shape == 'directory':
        files[EVENTS_PATH] = FakeFile(content=None, uid=SANDBOX_UID, mode=0o755)
    rig.bash('mkdir b')
    assert rig.rows == []
    assert rig.truncations() == 0
    assert files['/workspace/elsewhere/events.jsonl'].content == secret
    assert not any(name == 'get_files' and args['paths'] == [EVENTS_PATH] for name, args in rig.backend.calls)


def test_an_events_file_over_the_cap_is_emptied_unread(monkeypatch, tmp_path, caplog):
    rig = Rig(monkeypatch, tmp_path)
    rig.bash('mkdir a')
    rig.plant(line(kind='import', name='pandas', version='2', ts=NOW) + b' ' * EVENTS_MAX_BYTES)
    with caplog.at_level(logging.WARNING, logger='local_llm.sandbox.telemetry'):
        rig.bash('mkdir b')
    assert rig.rows == []
    assert rig.files()[EVENTS_PATH].content == b''
    assert 'dropping them' in caplog.text
    assert not any(name == 'get_files' and args['paths'] == [EVENTS_PATH] for name, args in rig.backend.calls)


# The truncation helper: the fake's emulation and the real script agree.


def _fake_truncate(ws: FakeWorkspace) -> int:
    request = FakeExecRequest(CHAT, telemetry.truncate_argv(), 30, None, ws)
    return run(interpret(request)).returncode


def _tree(kind: str) -> FakeWorkspace:
    ws = FakeWorkspace({'/workspace': FakeFile(content=None, uid=SANDBOX_UID, mode=0o755)})
    ws.mkdir('real')
    ws.write('real/events.jsonl', b'keep')
    if kind == 'file':
        ws.mkdir('.telemetry')
        ws.write('.telemetry/events.jsonl', b'data')
    elif kind == 'symlinked directory':
        ws.symlink('real', '.telemetry')
    elif kind == 'symlinked file':
        ws.mkdir('.telemetry')
        ws.symlink('/workspace/real/events.jsonl', '.telemetry/events.jsonl')
    return ws


def _real_truncate(tmp_path: Path, kind: str) -> tuple[int, Path]:
    root = Path(os.path.realpath(tmp_path)) / 'ws'
    (root / 'real').mkdir(parents=True)
    (root / 'real' / 'events.jsonl').write_bytes(b'keep')
    if kind == 'file':
        (root / '.telemetry').mkdir()
        (root / '.telemetry' / 'events.jsonl').write_bytes(b'data')
    elif kind == 'symlinked directory':
        os.symlink('real', root / '.telemetry')
    elif kind == 'symlinked file':
        (root / '.telemetry').mkdir()
        os.symlink(root / 'real' / 'events.jsonl', root / '.telemetry' / 'events.jsonl')
    source = LLLM_PATH_SOURCE.read_text(encoding='utf-8')
    script = tmp_path / 'lllm-path'
    script.write_text(source.replace('readonly ROOT=/workspace\n', f"readonly ROOT='{root}'\n"), encoding='utf-8')
    path = f'{root}/.telemetry/events.jsonl'
    argv = [
        arg.replace(workspace.LLLM_PATH, str(script))
        for arg in [*workspace.GUEST_SHELL, '-c', TRUNCATE_SCRIPT, 'lllm-telemetry', path, path]
    ]
    done = subprocess.run(argv, capture_output=True, cwd=root, timeout=30, check=False)
    return done.returncode, root


@pytest.mark.parametrize(
    ('kind', 'code'), [('file', 0), ('symlinked directory', 1), ('symlinked file', 1), ('missing', 1)]
)
def test_the_truncation_empties_only_the_real_file_in_the_fake_and_in_real_bash(tmp_path, kind, code):
    ws = _tree(kind)
    assert _fake_truncate(ws) == code
    assert ws.read('real/events.jsonl') == b'keep'
    real, root = _real_truncate(tmp_path, kind)
    assert real == code
    assert (root / 'real' / 'events.jsonl').read_bytes() == b'keep'
    if kind == 'file':
        assert ws.read('.telemetry/events.jsonl') == b''
        assert (root / '.telemetry' / 'events.jsonl').read_bytes() == b''


# Telemetry never breaks a call.


def _plain_result(monkeypatch, tmp_path, command: str) -> dict:
    rig = Rig(monkeypatch, tmp_path)
    rig.request.app.state.sandbox_telemetry = None
    return rig.bash(command)


@pytest.mark.parametrize('failure', ['store', 'mirror', 'listing', 'stat', 'begin'])
def test_no_telemetry_failure_changes_the_result(monkeypatch, tmp_path, caplog, failure):
    expected = _plain_result(monkeypatch, tmp_path, 'fakecmd')

    async def broken_store(rows):
        raise RuntimeError('database down')

    rig = Rig(monkeypatch, tmp_path, store=broken_store if failure == 'store' else None)
    rig.bash('mkdir a')
    rig.plant(EVENTS)
    ip = rig.backend.sandboxes[CHAT].ip or ''
    rig.backend.mirror_lines.append(MirrorLine((NOW + 1) * NS, mirror(ip, '/autograd-1.9.1-py3-none-any.whl')))
    if failure == 'mirror':
        rig.backend.mirror_error = SandboxError('the sandbox-mirror container does not exist')
    elif failure == 'listing':

        async def no_listing():
            raise SandboxError('daemon down')

        monkeypatch.setattr(rig.backend, 'list_sandboxes', no_listing)
    elif failure == 'stat':
        real_stat = rig.backend.stat

        async def no_stat(chat_id, path):
            if path.startswith(EVENTS_DIR):
                raise RuntimeError('stat failed')
            return await real_stat(chat_id, path)

        monkeypatch.setattr(rig.backend, 'stat', no_stat)
    elif failure == 'begin':
        monkeypatch.setattr(rig.manager, 'image_digest', lambda image: 1 / 0)
    with caplog.at_level(logging.WARNING, logger='local_llm.sandbox.telemetry'):
        assert rig.bash('fakecmd') == expected
    assert 'package telemetry' in caplog.text


def test_a_mirror_that_keeps_failing_is_logged_once(monkeypatch, tmp_path, caplog):
    rig = Rig(monkeypatch, tmp_path)
    rig.backend.mirror_error = SandboxError('no mirror')
    with caplog.at_level(logging.WARNING, logger='local_llm.sandbox.telemetry'):
        for _ in range(3):
            rig.bash('mkdir -p a')
    assert caplog.text.count('could not read the mirror log') == 1


def test_run_code_in_sandbox_collects_too(monkeypatch, tmp_path):
    rig = Rig(monkeypatch, tmp_path)
    rig.bash('mkdir a')
    rig.plant(line(kind='import', name='pandas', version='2', ts=NOW))

    async def go():
        return await builtin.run_code_in_sandbox(
            'print(1)', request=rig.request, user={'id': 'u1'}, chat_id=CHAT, message_id=None, metadata=None
        )

    run(go())
    assert [(r['kind'], r['name']) for r in rig.rows][:1] == [('import', 'pandas')]


def test_the_manager_s_telemetry_helpers(monkeypatch, tmp_path):
    rig = Rig(monkeypatch, tmp_path)
    assert rig.manager.image_digest('data') == 'sha256:data-image'
    assert rig.manager.image_digest(None) == ''
    rig.backend.image_ids = {}
    assert rig.manager.image_digest('web') == ''
    assert rig.manager.chat_of(CHAT) == CHAT
    assert run(rig.manager.addresses()) == {}
    rig.bash('mkdir a')
    assert run(rig.manager.addresses()) == {rig.backend.sandboxes[CHAT].ip: CHAT}


def test_the_fake_mirror_log_reads_after_the_cursor_within_the_budget():
    backend = FakeBackend()
    backend.mirror_lines = [MirrorLine(i * NS, 'x' * 9) for i in range(1, 6)]
    assert [m.at_ns for m in run(backend.mirror_log(2 * NS, 25))] == [3 * NS, 4 * NS]
    assert run(backend.mirror_log(0, 5)) == [MirrorLine(NS, 'xxxx')]
    with pytest.raises(ValueError):
        run(backend.mirror_log(-1, 10))
    with pytest.raises(ValueError):
        run(backend.mirror_log(0, MIRROR_LOG_MAX_BYTES + 1))
    with pytest.raises(TypeError):
        run(backend.mirror_log(True, 10))


# The Kata backend's read of the mirror's log, against a minimal mocked SDK.


def _frames(*parts: tuple[int, bytes]) -> bytes:
    return b''.join(struct.pack('>BxxxL', kind, len(data)) + data for kind, data in parts)


class _Response:
    def __init__(self, body: bytes, status: int = 200) -> None:
        import io

        self.raw = io.BytesIO(body)
        self.status_code = status
        self.closed = False

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            import requests

            raise requests.HTTPError(f'{self.status_code}')

    def close(self) -> None:
        self.closed = True


class _Docker:
    def __init__(self, body: bytes, *, tty: bool = False, present: bool = True, status: int = 200) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.responses: list[_Response] = []
        mirror_container = SimpleNamespace(id='mirror-id', attrs={'Config': {'Tty': tty}})

        def get(name):
            if not present or name != MIRROR_CONTAINER:
                raise docker.errors.NotFound(name)
            return mirror_container

        def api_get(url, params, stream, headers):
            self.calls.append((url, dict(params)))
            assert stream and headers == {'Accept-Encoding': 'identity'}
            response = _Response(body, status)
            self.responses.append(response)
            return response

        self.containers = SimpleNamespace(get=get)
        self.api = SimpleNamespace(base_url='http+docker://localhost', api_version='1.56', get=api_get)


def _kata(tmp_path: Path, client: _Docker) -> KataDockerBackend:
    return KataDockerBackend(tmp_path / 'volumes', client_factory=lambda: cast(Any, client))


def _stamped(at: str, text: str) -> bytes:
    return f'{at} {text}\n'.encode()


def test_log_time_ns():
    assert log_time_ns('2026-11-12T10:00:00.123456789Z') == 1_794_477_600_123_456_789
    assert log_time_ns('2026-11-12T10:00:00Z') == 1_794_477_600_000_000_000
    assert log_time_ns('2026-11-12T11:00:00.5+01:00') == 1_794_477_600_500_000_000
    for bad in ('', 'yesterday', '2026-11-12 10:00:00Z', '2026-13-40T10:00:00Z'):
        assert log_time_ns(bad) is None


def test_the_kata_backend_reads_the_mirror_log_after_the_cursor_through_the_daemon(tmp_path):
    body = _frames(
        (1, _stamped('2026-11-12T10:00:00.000000001Z', 'old')),
        (1, _stamped('2026-11-12T10:00:00.000000002Z', 'first')),
        (2, _stamped('2026-11-12T10:00:00.000000003Z', 'an error')),
        (1, b'no timestamp at all\n'),
        (1, _stamped('2026-11-12T10:00:01Z', 'second')),
    )
    client = _Docker(body)
    since = 1_794_477_600_000_000_001
    lines = run(_kata(tmp_path, client).mirror_log(since, 1024))
    assert lines == [MirrorLine(since + 1, 'first'), MirrorLine(1_794_477_601 * NS, 'second')]
    url, params = client.calls[0]
    assert url == 'http+docker://localhost/v1.56/containers/mirror-id/logs'
    assert params == {'stdout': '1', 'stderr': '0', 'timestamps': '1', 'follow': '0', 'since': '1794477599'}
    assert client.responses[0].closed


def test_the_kata_mirror_log_stops_at_the_budget_and_cuts_a_line_longer_than_it(tmp_path):
    body = _frames(*((1, _stamped(f'2026-11-12T10:00:0{i}Z', 'x' * 9)) for i in range(1, 6)))
    assert len(run(_kata(tmp_path, _Docker(body)).mirror_log(1, 25))) == 2
    assert run(_kata(tmp_path, _Docker(body)).mirror_log(1, 5)) == [MirrorLine(1_794_477_601 * NS, 'xxxx')]


@pytest.mark.parametrize(
    'client', [_Docker(b'', present=False), _Docker(b'', tty=True), _Docker(b'', status=500)], ids=str
)
def test_the_kata_mirror_log_fails_as_a_sandbox_error(tmp_path, client):
    with pytest.raises(SandboxError):
        run(_kata(tmp_path, client).mirror_log(1, 10))


def test_read_log_lines_stops_at_a_body_cut_short():
    import io

    whole = _frames((1, _stamped('2026-11-12T10:00:01Z', 'a')), (1, _stamped('2026-11-12T10:00:02Z', 'b')))
    assert [m.line for m in read_log_lines(io.BytesIO(whole[:-3]), 0, 100)] == ['a']


# The image hooks.


def _sitecustomize(tmp_path: Path, events: str) -> Path:
    source = SITECUSTOMIZE.read_text(encoding='utf-8')
    assert source.count(EVENTS_LINE) == 1, 'the test rewrites exactly this line; the hook changed shape'
    directory = tmp_path / 'site'
    directory.mkdir()
    (directory / 'sitecustomize.py').write_text(source.replace(EVENTS_LINE, f'EVENTS = {events!r}\n'))
    return directory


def _python(site: Path, code: str) -> subprocess.CompletedProcess:
    env = {**os.environ, 'PYTHONPATH': str(site), 'PYTHONDONTWRITEBYTECODE': '1'}
    return subprocess.run(
        [sys.executable, '-c', code], capture_output=True, text=True, env=env, timeout=120, check=False
    )


def test_sitecustomize_records_imports_and_an_uncaught_module_miss(tmp_path):
    events = tmp_path / 'ws' / '.telemetry' / 'events.jsonl'
    site = _sitecustomize(tmp_path, str(events))
    done = _python(site, 'import sitecustomize, pydantic, json; print("ok")')
    assert (done.returncode, done.stdout, done.stderr) == (0, 'ok\n', '')
    missing = _python(site, 'import notapkg_for_telemetry')
    assert missing.returncode == 1
    # The previous excepthook still prints the traceback.
    assert "ModuleNotFoundError: No module named 'notapkg_for_telemetry'" in missing.stderr
    parsed, dropped = parse_events(events.read_bytes(), now=int(dt.datetime.now(dt.UTC).timestamp()))
    assert dropped == 0
    by_name = {(e.kind, e.name): e for e in parsed}
    from importlib import metadata

    assert by_name[('import', 'pydantic')].version == metadata.version('pydantic')
    assert ('module_miss', 'notapkg_for_telemetry') in by_name
    # The standard library is never recorded.
    assert not any(e.name in ('json', 'os', 'sys') for e in parsed)


def test_sitecustomize_never_breaks_a_process_when_it_cannot_write(tmp_path):
    blocker = tmp_path / 'a-file'
    blocker.write_text('')
    site = _sitecustomize(tmp_path, str(blocker / 'events.jsonl'))
    done = _python(site, 'import sitecustomize, pydantic; print("ok")')
    assert (done.returncode, done.stdout, done.stderr) == (0, 'ok\n', '')
    missing = _python(site, 'import notapkg_for_telemetry')
    assert missing.returncode == 1
    assert missing.stderr.count('Traceback') == 1


def test_sitecustomize_does_not_take_a_missing_submodule_for_a_missing_package(tmp_path):
    events = tmp_path / 'events.jsonl'
    site = _sitecustomize(tmp_path, str(events))
    done = _python(site, 'import sitecustomize, json.not_a_submodule')
    assert done.returncode == 1
    lines = events.read_bytes() if events.exists() else b''
    assert b'module_miss' not in lines


def test_rprofile_site_records_loaded_namespaces(tmp_path):
    source = RPROFILE.read_text(encoding='utf-8')
    target = 'lllm_events <- "/workspace/.telemetry/events.jsonl"\n'
    assert source.count(target) == 1, 'the test rewrites exactly this line; the hook changed shape'
    for needed in ('reg.finalizer(', 'onexit = TRUE', 'try(', 'silent = TRUE', 'options(lllm.telemetry', 'r_import'):
        assert needed in source
    # Balanced, as R would need to parse it.
    code = '\n'.join(text.split('#', 1)[0] for text in source.splitlines())
    for opening, closing in ('()', '{}', '[]'):
        assert code.count(opening) == code.count(closing)
    rscript = shutil.which('Rscript')
    if rscript is None:
        return
    events = tmp_path / 'events.jsonl'
    profile = tmp_path / 'Rprofile.site'
    profile.write_text(source.replace(target, f'lllm_events <- "{events}"\n'), encoding='utf-8')
    env = {**os.environ, 'R_PROFILE': str(profile)}
    done = subprocess.run(
        [rscript, '-e', 'invisible(loadNamespace("tools")); cat("ok")'],
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
        check=False,
    )
    assert done.returncode == 0 and done.stdout == 'ok'
    parsed, dropped = parse_events(events.read_bytes() if events.exists() else b'', now=NOW)
    assert dropped == 0


# The table and the report.


def test_the_table_round_trips_and_the_report_ranks_and_leaves_harness_rows_out():
    tag = uuid.uuid4().hex[:10]
    used, rare, missed = f'used-{tag}', f'rare-{tag}', f'missed-{tag}'
    chats = [f'chat-{tag}-{n}' for n in range(3)]

    def row(kind, name, chat, ts, version=None, harness=None):
        return _row(kind, name, version, ts, chat=chat, image='sha256:x', lock='l', harness=harness)

    rows = [
        row('import', used, chats[0], 10, '1.0'),
        row('import', used, chats[0], 11, '1.0'),
        row('install', used, chats[1], 12, '1.0'),
        row('import', used, chats[2], 13, '1.0', harness='run-1'),
        row('r_import', rare, chats[0], 14, '0.1'),
        row('command_miss', missed, chats[0], 15),
        row('command_miss', missed, chats[0], 16),
        row('command_miss', missed, chats[1], 17),
        row('command_miss', missed, chats[2], 18, harness='run-1'),
    ]

    async def scenario():
        assert await SandboxPackageEvents.add_events(rows) == len(rows)
        assert await SandboxPackageEvents.add_events([]) == 0
        stored = await SandboxPackageEvents.get_events(chats[0])
        uses = await SandboxPackageEvents.uses(limit=5000)
        uses_all = await SandboxPackageEvents.uses(include_harness=True, limit=5000)
        misses = await SandboxPackageEvents.misses(limit=5000)
        misses_all = await SandboxPackageEvents.misses(include_harness=True, limit=5000)
        return stored, uses, uses_all, misses, misses_all

    stored, uses, uses_all, misses, misses_all = run(scenario())
    assert [(e.kind, e.name, e.ts, e.version, e.image_digest, e.lock_sha, e.harness_run_id) for e in stored] == [
        ('import', used, 10, '1.0', 'sha256:x', 'l', None),
        ('import', used, 11, '1.0', 'sha256:x', 'l', None),
        ('r_import', rare, 14, '0.1', 'sha256:x', 'l', None),
        ('command_miss', missed, 15, None, 'sha256:x', 'l', None),
        ('command_miss', missed, 16, None, 'sha256:x', 'l', None),
    ]
    assert all(isinstance(e.event_id, int) for e in stored)
    mine = {(u['language'], u['name']): u for u in uses if u['name'].endswith(tag)}
    assert mine == {
        ('python', used): {
            'language': 'python',
            'name': used,
            'chats': 2,
            'imports': 2,
            'installs': 1,
            'last_used': 12,
        },
        ('r', rare): {'language': 'r', 'name': rare, 'chats': 1, 'imports': 1, 'installs': 0, 'last_used': 14},
    }
    assert next(u for u in uses_all if u['name'] == used)['chats'] == 3
    assert [m for m in misses if m['name'] == missed] == [
        {'kind': 'command_miss', 'name': missed, 'chats': 2, 'events': 3, 'last_seen': 17}
    ]
    assert next(m for m in misses_all if m['name'] == missed)['chats'] == 3
    # Most chats first.
    ranked = [m['chats'] for m in misses]
    assert ranked == sorted(ranked, reverse=True)


def _user(role: str) -> SimpleNamespace:
    uid = f'sbxpkg-{role}-{uuid.uuid4().hex[:10]}'
    run(Users.insert_new_user(uid, f'{role} user', f'{uid}@example.com', role=role))
    token = create_token({'id': uid}, dt.timedelta(minutes=30))
    return SimpleNamespace(id=uid, headers={'Authorization': f'Bearer {token}'})


@pytest.fixture(scope='module')
def client():
    app = FastAPI()
    app.include_router(sandbox_router.router, prefix='/sandbox')
    return TestClient(app)


def test_the_report_route_is_for_admins_and_names_each_package_s_source(client, monkeypatch):
    tag = uuid.uuid4().hex[:10]
    name = f'wheel-{tag}'
    run(
        SandboxPackageEvents.add_events(
            [
                _row('install', name, '1', 5, chat=f'c-{tag}', lock='l'),
                _row('import', name, '1', 6, chat=f'c-{tag}', lock='l', harness='run-x'),
            ]
        )
    )
    monkeypatch.setattr(
        telemetry,
        'package_sources',
        lambda: PackageSources(image=frozenset(), wheelhouse=frozenset({name}), image_r=frozenset()),
    )
    admin, user = _user('admin'), _user('user')
    response = client.get('/sandbox/packages', headers=admin.headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['include_harness'] is False
    assert [p for p in body['packages'] if p['name'] == name] == [
        {
            'language': 'python',
            'name': name,
            'chats': 1,
            'imports': 0,
            'installs': 1,
            'last_used': 5,
            'source': 'wheelhouse',
        }
    ]
    with_harness = client.get('/sandbox/packages?include_harness=true', headers=admin.headers).json()
    assert next(p for p in with_harness['packages'] if p['name'] == name)['imports'] == 1
    assert client.get('/sandbox/packages', headers=user.headers).status_code == 403
    assert client.get('/sandbox/packages').status_code in (401, 403)
    assert client.get('/sandbox/packages?limit=0', headers=admin.headers).status_code == 422


def test_the_report_route_is_503_when_the_events_cannot_be_read(client, monkeypatch):
    async def broken(**kwargs):
        raise RuntimeError('database down')

    monkeypatch.setattr(SandboxPackageEvents, 'uses', broken)
    assert client.get('/sandbox/packages', headers=_user('admin').headers).status_code == 503


# The benchmark runner tags the harness request.


def test_the_runner_puts_the_suite_run_id_on_the_harness_request(monkeypatch):
    request = SimpleNamespace(state=SimpleNamespace())

    async def profile(name):
        return {'name': 'qwen25c'}

    async def served(session, port, prof):
        return 'qwen25c'

    async def no_run(port):
        return None

    async def prepare(source, user, entry, port):
        return {'request': request}

    monkeypatch.setattr(runner.env_profile, 'profile', profile)
    monkeypatch.setattr(runner.env_profile, 'port', lambda prof: 8090)
    monkeypatch.setattr(runner.env_profile, 'served_model', served)
    monkeypatch.setattr(runner.BenchmarkRuns, 'get_active_run', no_run)
    monkeypatch.setattr(runner.harness, 'prepare', prepare)
    ctx = run(
        runner.context(
            None,
            profile_name=None,
            tier='smoke',
            seed=0,
            benches=[],
            suite_run_id='suite-run-7',
            harness_entry='coder',
            source_request=object(),
            user=object(),
        )
    )
    assert ctx['suite_run_id'] == 'suite-run-7'
    assert request.state.harness_run_id == 'suite-run-7'
    assert telemetry.harness_run_id(request) == 'suite-run-7'
