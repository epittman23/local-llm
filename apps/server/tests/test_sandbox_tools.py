"""The sandbox's file tools (T12): path confinement, the guest helpers, and the fake that emulates them.

Pins, without Docker or Kata:

- the real `infra/sandbox/common/lllm-path`, run with bash against a
  temporary directory standing in for /workspace (its one ROOT line
  rewritten), and the FakeBackend's emulation of it give the same answer
  for every case: a nested path, a missing one, `..` out, an absolute path
  out, a symlink out (absolute and relative), a symlink that stays in, a
  symlink loop, a symlink inside a directory UID 1000 cannot search, a
  symlink to a name with a newline, a result over 4,096 bytes;
- the listing and write helpers of sandbox/workspace.py, run with real bash
  and coreutils against the same directory, agree with the fake's
  emulation of them;
- the host-side check (`confine`) refuses NUL, newline, `..` out, an
  absolute path out and a path over 4,096 bytes before anything runs;
- the fake's symlinks and its `ln -s`, `chmod` and `mkdir` behave as the
  guest's do;
- the four tools, through SandboxManager and FakeBackend: a happy path for
  each, and the refusals a model meets most.

The real-bash tests rely on running as a user other than root, as CI's
runners do: root ignores `chmod 000`, so the unsearchable and unreadable
cases would read differently there.

Run from apps/server:

    python -m pytest tests/test_sandbox_tools.py
"""

import asyncio
import base64
import errno
import json
import os
import subprocess
from collections.abc import Callable, Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest

from local_llm.models.users import Users
from local_llm.sandbox import (
    ExecResult,
    SandboxError,
    SandboxManager,
    SandboxNotRunning,
    SandboxSettings,
    SandboxSpec,
    workspace,
    wrap_argv,
    wrap_command,
)
from local_llm.sandbox.fake import (
    FakeBackend,
    FakeExecRequest,
    FakeFile,
    FakeRun,
    FakeWorkspace,
    interpret,
    lllm_path,
)
from local_llm.tools import builtin

REPO = Path(__file__).resolve().parents[3]
LLLM_PATH_SOURCE = REPO / 'infra' / 'sandbox' / 'common' / 'lllm-path'
ROOT_LINE = 'readonly ROOT=/workspace\n'
CHAT = '11111111-1111-4111-8111-111111111111'
# A relative symlink target of 4,019 bytes, so a path through it resolves to more than 4,096.
LONG_TARGET = '/'.join(['d' * 200] * 20)

# The tree both sides build, as (operation, arguments) in order; paths are relative to the root.
TREE: list[tuple[str, tuple]] = [
    ('mkdir', ('sub',)),
    ('write', ('sub/ok.txt', b'ok\n')),
    ('mkdir', ('sub/deep',)),
    ('write', ('sub/deep/x.txt', b'x')),
    ('mkdir', ('sub/deep/deeper',)),
    ('write', ('top.txt', b'hello\n')),
    ('symlink', ('/etc', 'out')),
    ('symlink', ('..', 'up')),
    ('symlink', ('sub', 'inside')),
    ('symlink', ('loop2', 'loop1')),
    ('symlink', ('loop1', 'loop2')),
    ('symlink', ('a\nb', 'newline')),
    ('symlink', (LONG_TARGET, 'long')),
    ('mkdir', ('.hidden',)),
    ('write', ('.hidden/secret', b's')),
    ('mkdir', ('.runs',)),
    ('write', ('.runs/1.py', b'print(1)\n')),
    ('mkdir', ('locked',)),
    ('symlink', ('/etc', 'locked/x')),
    ('chmod', ('locked', 0o000)),
]

# (path given, where it leads relative to the root, or None when lllm-path refuses it); `{root}` is the root.
RESOLVE_CASES: list[tuple[str, str | None]] = [
    ('sub/ok.txt', 'sub/ok.txt'),
    ('sub/new/deeper.txt', 'sub/new/deeper.txt'),
    ('.', ''),
    ('{root}/sub/ok.txt', 'sub/ok.txt'),
    ('/{root}/sub/ok.txt', 'sub/ok.txt'),
    ('{root}', ''),
    ('inside/ok.txt', 'sub/ok.txt'),
    ('inside/../top.txt', 'top.txt'),
    ('locked', 'locked'),
    ('../etc/passwd', None),
    ('/etc/passwd', None),
    ('out', None),
    ('out/passwd', None),
    ('up/etc/passwd', None),
    ('loop1', None),
    ('loop1/a', None),
    ('locked/x/passwd', None),
    ('newline', None),
    ('long/' + 'e' * 100, None),
    ('', None),
    ('a\nb', None),
    ('x' * 4097, None),
    # Added by the T12 test pass: trailing slashes, dots, unicode, lookalike prefixes, long multi-byte names.
    ('sub/', 'sub'),
    ('sub//deep/', 'sub/deep'),
    ('./sub/./ok.txt', 'sub/ok.txt'),
    ('sub/..', ''),
    ('sub/../..', None),
    ('{root}/', ''),
    ('{root}/..', None),
    ('{root}/../etc', None),
    ('{root}foo', None),
    ('{root}foo/x', None),
    ('outputs/../../etc', None),
    ('outputs/../../etc/passwd', None),
    ('données/日本語.txt', 'données/日本語.txt'),
    ('é' * 1000, 'é' * 1000),
    ('é' * 2048, None),
    ('é' * 2049, None),
    ('top.txt/', 'top.txt'),
    ('top.txt/under', 'top.txt/under'),
    ('inside/', 'sub'),
    ('.hidden/secret', '.hidden/secret'),
    ('\\n', '\\n'),
    ('a b/c d', 'a b/c d'),
    ('-rf', '-rf'),
    ('--', '--'),
    ('*', '*'),
    ('$HOME', '$HOME'),
    ('$(id)', '$(id)'),
    ('`id`', '`id`'),
]


# Helpers.


def _fake_tree() -> FakeWorkspace:
    ws = FakeWorkspace({'/workspace': FakeFile(content=None, uid=1000, mode=0o755)})
    for op, args in TREE:
        if op == 'mkdir':
            ws.mkdir(*args)
        elif op == 'write':
            ws.write(*args)
        elif op == 'symlink':
            ws.symlink(*args)
        else:
            ws.chmod(*args)
    return ws


@pytest.fixture
def real_root(tmp_path: Path) -> Iterator[Path]:
    """The same tree on disk, under a root with no symlink above it; `locked` is opened again afterwards."""
    root = Path(os.path.realpath(tmp_path)) / 'ws'
    root.mkdir()
    for op, args in TREE:
        if op == 'mkdir':
            (root / args[0]).mkdir()
        elif op == 'write':
            (root / args[0]).write_bytes(args[1])
        elif op == 'symlink':
            os.symlink(args[0], root / args[1])
        else:
            os.chmod(root / args[0], args[1])
    yield root
    os.chmod(root / 'locked', 0o755)


def _real_lllm_path(root: Path) -> Path:
    """The real script with its one ROOT line pointed at `root`, written beside it."""
    source = LLLM_PATH_SOURCE.read_text(encoding='utf-8')
    assert source.count(ROOT_LINE) == 1, 'the test rewrites exactly this line; the script changed shape'
    script = root.parent / 'lllm-path'
    script.write_text(source.replace(ROOT_LINE, f"readonly ROOT='{root}'\n"), encoding='utf-8')
    return script


def _run_real(root: Path, args: list[str], stdin: bytes | None = None) -> subprocess.CompletedProcess:
    # Exactly the helper's argv after the timeout prefix, with lllm-path's path swapped for the rewritten copy.
    script = str(_real_lllm_path(root))
    argv = [arg.replace(workspace.LLLM_PATH, script) for arg in [*workspace.GUEST_SHELL, *args]]
    return subprocess.run(argv, input=stdin, capture_output=True, cwd=root, timeout=30, check=False)


def _expected(root_text: str, case: str) -> str:
    return case.replace('{root}', root_text)


def _relative(printed: str, root_text: str) -> str:
    assert printed.endswith('\n')
    resolved = printed[:-1]
    assert resolved == root_text or resolved.startswith(root_text + '/'), resolved
    return resolved[len(root_text) + 1 :]


# lllm-path: the real script and the fake's emulation.


@pytest.mark.parametrize(('given', 'leads_to'), RESOLVE_CASES, ids=[repr(c[0])[:40] for c in RESOLVE_CASES])
def test_real_lllm_path_confines_to_the_root(real_root: Path, given: str, leads_to: str | None):
    run = _run_real(real_root, [workspace.LLLM_PATH, _expected(str(real_root), given)])
    if leads_to is None:
        assert run.returncode == 1, run.stdout
        assert run.stdout == b''
        assert run.stderr.startswith(b'lllm-path: ')
    else:
        assert run.returncode == 0, run.stderr
        assert _relative(run.stdout.decode(), str(real_root)) == leads_to


@pytest.mark.parametrize(('given', 'leads_to'), RESOLVE_CASES, ids=[repr(c[0])[:40] for c in RESOLVE_CASES])
def test_fake_lllm_path_agrees_with_the_real_script(given: str, leads_to: str | None):
    run = lllm_path(_fake_tree(), _expected('/workspace', given))
    if leads_to is None:
        assert run.returncode == 1, run.stdout
        assert run.stdout == b''
        assert run.stderr.startswith(b'lllm-path: ')
    else:
        assert run.returncode == 0, run.stderr
        assert _relative(run.stdout.decode(), '/workspace') == leads_to


def test_real_lllm_path_refuses_wrong_usage_with_exit_2(real_root: Path):
    assert _run_real(real_root, [workspace.LLLM_PATH]).returncode == 2
    assert _run_real(real_root, [workspace.LLLM_PATH, 'a', 'b']).returncode == 2


def test_lllm_path_source_is_executable_and_runs_bash():
    assert os.access(LLLM_PATH_SOURCE, os.X_OK)
    assert LLLM_PATH_SOURCE.read_text(encoding='utf-8').startswith('#!/bin/bash\n')


# The listing and write helpers: real bash and coreutils against the fake.


def _records(stdout: bytes) -> set[tuple[str, str]]:
    # (type letter, path) of each NUL-ended record; directory sizes differ between filesystems, so are left out.
    assert stdout.endswith(b'\0')
    return {(r.split('\t')[0], r.split('\t')[2]) for r in stdout.decode().split('\0')[:-1]}


def _fake_run(ws: FakeWorkspace, args: list[str], stdin: bytes | None = None) -> FakeRun:
    argv = wrap_argv([*workspace.GUEST_SHELL, *args], workspace.HELPER_TIMEOUT_S)
    return asyncio.run(interpret(FakeExecRequest(CHAT, argv, workspace.HELPER_TIMEOUT_S, stdin, ws)))


def test_listing_helper_matches_find_two_levels_deep_without_hidden_entries_but_runs(real_root: Path):
    args = ['-c', workspace.LIST_SCRIPT, 'lllm-list', '.']
    real = _run_real(real_root, args)
    fake = _fake_run(_fake_tree(), args)
    assert real.returncode == fake.returncode == 0
    expected = {
        ('d', 'sub'),
        ('f', 'sub/ok.txt'),
        ('d', 'sub/deep'),
        ('f', 'top.txt'),
        ('l', 'out'),
        ('l', 'up'),
        ('l', 'inside'),
        ('l', 'loop1'),
        ('l', 'loop2'),
        ('l', 'newline'),
        ('l', 'long'),
        ('d', '.runs'),
        ('f', '.runs/1.py'),
        ('d', 'locked'),
    }
    assert _records(real.stdout) == _records(fake.stdout) == expected
    assert b'Permission denied' in real.stderr
    assert b'Permission denied' in fake.stderr


@pytest.mark.parametrize('path', ['out', '/etc', 'locked/x'])
def test_listing_helper_refuses_a_directory_outside_the_root(real_root: Path, path: str):
    args = ['-c', workspace.LIST_SCRIPT, 'lllm-list', path]
    real = _run_real(real_root, args)
    fake = _fake_run(_fake_tree(), args)
    assert real.returncode == fake.returncode == 1
    assert real.stdout == fake.stdout == b''


def test_listing_helper_cuts_its_output_to_the_cap(real_root: Path):
    many = real_root / 'many'
    many.mkdir()
    ws = _fake_tree()
    ws.mkdir('many')
    for i in range(600):
        name = f'many/{"n" * 40}{i:04d}'
        (real_root / name).write_bytes(b'')
        ws.write(name, b'')
    args = ['-c', workspace.LIST_SCRIPT, 'lllm-list', 'many']
    real = _run_real(real_root, args)
    fake = _fake_run(ws, args)
    assert len(real.stdout) == len(fake.stdout) == workspace.LIST_CAP_BYTES


def _write(root: Path | None, ws: FakeWorkspace | None, path: str, mode: str, data: bytes) -> tuple[int, bytes]:
    args = ['-c', workspace.WRITE_SCRIPT, 'lllm-write', path, mode]
    if root is not None:
        run = _run_real(root, args, data)
        return run.returncode, run.stdout
    assert ws is not None
    run = _fake_run(ws, args, data)
    return run.returncode, run.stdout


@pytest.mark.parametrize(
    ('path', 'mode', 'returncode', 'leads_to'),
    [
        ('new.txt', 'new', 0, 'new.txt'),
        ('made/on/the/way.txt', 'new', 0, 'made/on/the/way.txt'),
        ('inside/via-link.txt', 'new', 0, 'sub/via-link.txt'),
        ('top.txt', 'new', workspace.EXISTS_EXIT, None),
        ('top.txt', 'overwrite', 0, 'top.txt'),
        ('sub', 'overwrite', 1, None),
        ('top.txt/under-a-file', 'new', 1, None),
        ('out/passwd', 'overwrite', 1, None),
        ('/etc/passwd', 'overwrite', 1, None),
        ('locked/x/passwd', 'overwrite', 1, None),
    ],
)
def test_write_helper_agrees_with_real_bash(real_root: Path, path, mode, returncode, leads_to):
    ws = _fake_tree()
    real = _write(real_root, None, path, mode, b'data\n')
    fake = _write(None, ws, path, mode, b'data\n')
    assert real[0] == fake[0] == returncode
    if leads_to is None:
        assert real[1] == fake[1] == b''
    else:
        assert _relative(real[1].decode(), str(real_root)) == _relative(fake[1].decode(), '/workspace') == leads_to
        assert (real_root / leads_to).read_bytes() == ws.read(leads_to) == b'data\n'


def test_write_helper_into_a_read_only_directory_fails_with_permission_denied(real_root: Path):
    ws = _fake_tree()
    (real_root / 'sub').chmod(0o555)
    ws.chmod('sub', 0o555)
    try:
        real = _run_real(real_root, ['-c', workspace.WRITE_SCRIPT, 'lllm-write', 'sub/x', 'new'], b'x')
    finally:
        (real_root / 'sub').chmod(0o755)
    fake = _fake_run(ws, ['-c', workspace.WRITE_SCRIPT, 'lllm-write', 'sub/x', 'new'], b'x')
    assert real.returncode == fake.returncode == 1
    assert b'Permission denied' in real.stderr
    assert b'Permission denied' in fake.stderr


# confine: the host-side check before any exec.


@pytest.mark.parametrize(
    'path',
    ['', 'a\0b', 'a\nb', '../etc/passwd', 'sub/../../etc', '/etc/passwd', '/workspacex', 'x' * 4097, '\ud800'],
)
def test_confine_refuses_before_anything_runs(path: str):
    with pytest.raises(workspace.WorkspaceError):
        workspace.confine(path)


def test_confine_refuses_a_path_that_is_not_a_str():
    with pytest.raises(workspace.WorkspaceError):
        workspace.confine(cast(str, b'x'))


@pytest.mark.parametrize('path', ['x', 'a/b/../c', '.', '/workspace', '/workspace/a', 'x' * 4096])
def test_confine_passes_a_path_under_workspace_unchanged(path: str):
    assert workspace.confine(path) == path


# The fake's symlinks and file commands, with the guest's semantics.


def _sh(ws: FakeWorkspace, command: str) -> FakeRun:
    request = FakeExecRequest(CHAT, wrap_command(command, 60), 60, None, ws)
    return asyncio.run(interpret(request))


def _empty() -> FakeWorkspace:
    return FakeWorkspace({'/workspace': FakeFile(content=None, uid=1000, mode=0o755)})


def test_fake_symlinks_are_followed_on_the_way_and_at_the_end():
    ws = _fake_tree()
    assert ws.read('inside/ok.txt') == b'ok\n'
    assert ws.read('out/passwd').startswith(b'root:')
    assert ws.read('up/etc/passwd').startswith(b'root:')
    assert ws.listdir('inside') == ['deep', 'ok.txt']
    ws.write('inside/new.txt', b'n')
    assert ws.files['/workspace/sub/new.txt'].content == b'n'


def test_fake_lookup_without_follow_returns_the_symlink_itself():
    full, entry = _fake_tree()._lookup('out', 1000, follow=False)
    assert full == '/workspace/out'
    assert entry is not None
    assert entry.link == '/etc'
    assert not entry.is_dir


def test_fake_symlink_loop_fails_with_eloop():
    with pytest.raises(OSError) as caught:
        _fake_tree().read('loop1')
    assert caught.value.errno == errno.ELOOP
    assert _sh(_fake_tree(), 'cat loop1').stderr == b'cat: loop1: Too many levels of symbolic links\n'


def test_fake_dot_dot_goes_up_from_the_directory_reached_and_stops_at_the_root():
    ws = _fake_tree()
    assert ws.read('inside/../top.txt') == b'hello\n'
    assert ws.read('/../../etc/passwd').startswith(b'root:')


def test_fake_realpath_keeps_what_it_cannot_follow_as_a_name():
    ws = _fake_tree()
    assert ws.realpath('loop1/a') == '/workspace/loop1/a'
    assert ws.realpath('locked/x/passwd') == '/workspace/locked/x/passwd'
    assert ws.realpath('out/passwd') == '/etc/passwd'
    assert ws.realpath('inside/missing/../ok.txt') == '/workspace/sub/ok.txt'


def test_fake_ln_creates_a_symlink_owned_by_uid_1000():
    ws = _empty()
    assert _sh(ws, 'ln -s /etc/passwd leak').returncode == 0
    entry = ws.files['/workspace/leak']
    assert (entry.link, entry.uid, entry.mode) == ('/etc/passwd', 1000, 0o777)


@pytest.mark.parametrize(
    ('command', 'stderr'),
    [
        ('ln a b', b'ln: only `ln -s TARGET LINK` is modelled\n'),
        ('ln -s x top.txt', b"ln: failed to create symbolic link 'top.txt': File exists\n"),
        ('ln -s x out', b"ln: failed to create symbolic link 'out': File exists\n"),
        ("ln -s '' empty", b"ln: failed to create symbolic link 'empty': No such file or directory\n"),
        ('ln -s x /etc/y', b"ln: failed to create symbolic link '/etc/y': Read-only file system\n"),
        ('ln -s x missing/y', b"ln: failed to create symbolic link 'missing/y': No such file or directory\n"),
    ],
)
def test_fake_ln_fails_as_the_guest_does(command: str, stderr: bytes):
    run = _sh(_fake_tree(), command)
    assert (run.returncode, run.stderr) == (1, stderr)


def test_fake_chmod_sets_the_mode_of_what_a_symlink_points_to():
    ws = _fake_tree()
    assert _sh(ws, 'chmod 600 inside').returncode == 0
    assert ws.files['/workspace/sub'].mode == 0o600
    assert ws.files['/workspace/inside'].mode == 0o777


@pytest.mark.parametrize(
    ('command', 'stderr'),
    [
        ('chmod u+x top.txt', b'chmod: only `chmod OCTAL-MODE PATH...` is modelled\n'),
        ('chmod 644', b'chmod: only `chmod OCTAL-MODE PATH...` is modelled\n'),
        ('chmod 644 missing', b"chmod: cannot access 'missing': No such file or directory\n"),
        ('chmod 644 /etc/passwd', b"chmod: changing permissions of '/etc/passwd': Read-only file system\n"),
        ('chmod 644 /tmp', b"chmod: changing permissions of '/tmp': Operation not permitted\n"),
        ('chmod 644 locked/x', b"chmod: cannot access 'locked/x': Permission denied\n"),
    ],
)
def test_fake_chmod_fails_as_the_guest_does(command: str, stderr: bytes):
    run = _sh(_fake_tree(), command)
    assert (run.returncode, run.stderr) == (1, stderr)


def test_fake_mkdir_creates_directories_and_with_p_their_parents():
    ws = _empty()
    assert _sh(ws, 'mkdir a').returncode == 0
    assert _sh(ws, 'mkdir -p /workspace/b/c/d a').returncode == 0
    assert ws.files['/workspace/b/c/d'].is_dir
    assert (ws.files['/workspace/a'].uid, ws.files['/workspace/a'].mode) == (1000, 0o755)


@pytest.mark.parametrize(
    ('command', 'stderr'),
    [
        ('mkdir', b'mkdir: missing operand\n'),
        ('mkdir sub', b"mkdir: cannot create directory 'sub': File exists\n"),
        ('mkdir -p top.txt/x', b"mkdir: cannot create directory 'top.txt/x': File exists\n"),
        ('mkdir /etc/x', b"mkdir: cannot create directory '/etc/x': Read-only file system\n"),
        ('mkdir a/b', b"mkdir: cannot create directory 'a/b': No such file or directory\n"),
    ],
)
def test_fake_mkdir_fails_as_the_guest_does(command: str, stderr: bytes):
    run = _sh(_fake_tree(), command)
    assert (run.returncode, run.stderr) == (1, stderr)


def test_fake_mkdir_in_a_directory_without_write_permission_fails_with_eacces():
    ws = _fake_tree()
    ws.chmod('sub', 0o555)
    assert _sh(ws, 'mkdir sub/x').stderr == b"mkdir: cannot create directory 'sub/x': Permission denied\n"


def test_fake_runs_no_guest_helper_it_does_not_know():
    run = _fake_run(_fake_tree(), ['-c', 'echo hi', 'lllm-other'])
    assert run.returncode == 127


def test_fake_backend_stat_reports_a_symlink_without_following_it():
    async def go():
        backend = FakeBackend()
        await backend.create(CHAT, SandboxSpec(CHAT, 'data'))
        await backend.exec(CHAT, wrap_command('ln -s /etc/passwd leak', 60), 60)
        return await backend.stat(CHAT, '/workspace/leak'), await backend.get_files(CHAT, ['/workspace/leak'], 100)

    stat, files = asyncio.run(go())
    assert stat is not None
    assert (stat.kind, stat.uid, stat.size) == ('symlink', 1000, len('/etc/passwd'))
    assert files == {}


# The four tools, through SandboxManager and FakeBackend.


class _Chats:
    async def usable(self, chat_id, user):
        return chat_id == CHAT and user.id == 'u1'

    async def updated_at(self, chat_ids):
        return {}


async def _settings() -> SandboxSettings:
    return SandboxSettings()


class _Rig:
    """A manager on a FakeBackend on request.app.state.sandbox, and user u1 signed in."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, *, manager: bool = True) -> None:
        self.backend = FakeBackend()
        state = SimpleNamespace()
        if manager:
            state.sandbox = SandboxManager(self.backend, chats=_Chats(), settings=_settings)
        self.request = SimpleNamespace(app=SimpleNamespace(state=state))
        self.events: list[dict] = []

        async def get_user_by_id(user_id, db=None):
            return SimpleNamespace(id=user_id, role='user') if user_id == 'u1' else None

        monkeypatch.setattr(Users, 'get_user_by_id', get_user_by_id)

    async def call(self, tool: Callable, chat_id: str = CHAT, **kwargs) -> dict | str:
        async def emit(event: dict) -> None:
            self.events.append(event)

        out = await tool(
            **kwargs, __request__=self.request, __user__={'id': 'u1'}, __chat_id__=chat_id, __event_emitter__=emit
        )
        return json.loads(out) if out.startswith('{') else out

    def execs(self) -> list[list[str]]:
        return [cast(list[str], args['argv']) for name, args in self.backend.calls if name == 'exec']


def test_bash_runs_the_command_and_returns_exactly_its_result(monkeypatch):
    rig = _Rig(monkeypatch)
    result = asyncio.run(rig.call(builtin.bash, command='printf hi'))
    assert result == {
        'returncode': 0,
        'stdout': 'hi',
        'stderr': '',
        'timed_out': False,
        'truncated': False,
        'outputs': [],
    }
    assert rig.execs() == [wrap_command('printf hi', 60)]


@pytest.mark.parametrize(('given', 'used'), [(None, 60), ('5', 5), (999, 300), (0, 1)])
def test_bash_clamps_the_timeout(monkeypatch, given, used):
    rig = _Rig(monkeypatch)
    asyncio.run(rig.call(builtin.bash, command='printf hi', timeout_s=given))
    assert rig.execs() == [wrap_command('printf hi', used)]


@pytest.mark.parametrize(
    ('kwargs', 'error'),
    [
        ({'command': 'printf hi', 'image': 'gpu'}, "image must be 'data' or 'web', not 'gpu'"),
        ({'command': 'printf \0'}, 'the command cannot contain a NUL character'),
        ({'command': 'x' * 100_001}, 'write the script to a file with write_file'),
    ],
)
def test_bash_refuses_before_anything_runs(monkeypatch, kwargs, error):
    rig = _Rig(monkeypatch)
    result = asyncio.run(rig.call(builtin.bash, **kwargs))
    assert isinstance(result, dict)
    assert error in result['error']
    assert rig.backend.calls == []


def test_tools_say_the_sandbox_is_not_available_without_a_manager(monkeypatch):
    rig = _Rig(monkeypatch, manager=False)
    result = asyncio.run(rig.call(builtin.view, path='.'))
    assert result == {'error': 'The sandbox is not available on this server'}


def test_tools_refuse_a_chat_the_user_may_not_use(monkeypatch):
    rig = _Rig(monkeypatch)
    result = asyncio.run(rig.call(builtin.bash, chat_id='22222222-2222-4222-8222-222222222222', command='ls'))
    assert isinstance(result, dict)
    assert result['error'].startswith('The sandbox cannot be used in this chat: ')
    assert rig.backend.calls == []


def test_write_file_view_and_str_replace_edit_a_file(monkeypatch):
    rig = _Rig(monkeypatch)

    async def go():
        written = await rig.call(builtin.write_file, path='src/a.py', content='x = 1\ny = 2\n')
        again = await rig.call(builtin.write_file, path='src/a.py', content='z')
        edited = await rig.call(builtin.str_replace, path='src/a.py', old_str='y = 2', new_str='y = 3')
        shown = await rig.call(builtin.view, path='/workspace/src/a.py', start_line='2')
        listing = await rig.call(builtin.view, path='.')
        return written, again, edited, shown, listing

    written, again, edited, shown, listing = asyncio.run(go())
    assert written == {'path': '/workspace/src/a.py', 'bytes_written': 12}
    assert isinstance(again, dict)
    assert 'already exists; pass overwrite=true' in again['error']
    assert edited == {'path': '/workspace/src/a.py', 'edited_lines': '2-2', 'context': '     1\tx = 1\n     2\ty = 3'}
    assert shown == {
        'path': '/workspace/src/a.py',
        'content': '     2\ty = 3',
        'total_lines': 2,
        'showing_lines': '2-2',
    }
    # uploads/ is the read-only uploads mount every sandbox has (T13).
    assert listing == {'path': '/workspace', 'entries': ['src/', 'src/a.py (12 bytes)', 'uploads/']}


def test_write_file_overwrites_when_asked(monkeypatch):
    rig = _Rig(monkeypatch)

    async def go():
        await rig.call(builtin.write_file, path='a.txt', content='one')
        await rig.call(builtin.write_file, path='a.txt', content='two', overwrite=True)
        return await rig.call(builtin.view, path='a.txt')

    shown = asyncio.run(go())
    assert isinstance(shown, dict)
    assert shown['content'] == '     1\ttwo'


@pytest.mark.parametrize(
    ('old', 'error'),
    [
        ('', 'old_str is empty'),
        ('nowhere', 'old_str does not occur in a.txt'),
        ('ab', 'old_str occurs 2 times in a.txt'),
        ('aa', 'old_str occurs 2 times in a.txt'),
    ],
)
def test_str_replace_needs_exactly_one_match(monkeypatch, old, error):
    rig = _Rig(monkeypatch)

    async def go():
        await rig.call(builtin.write_file, path='a.txt', content='ab ab aaa')
        return await rig.call(builtin.str_replace, path='a.txt', old_str=old, new_str='x')

    result = asyncio.run(go())
    assert isinstance(result, dict)
    assert error in result['error']


@pytest.mark.parametrize(
    ('setup', 'path'),
    [
        (None, '/etc/passwd'),
        (None, '../etc/passwd'),
        (None, 'a\0b'),
        ('ln -s /etc/passwd leak', 'leak'),
        ('ln -s /etc etc', 'etc/passwd'),
        ('ln -s .. up', 'up/etc/passwd'),
    ],
)
def test_view_write_and_edit_never_reach_outside_workspace(monkeypatch, setup, path):
    rig = _Rig(monkeypatch)

    async def go():
        if setup:
            await rig.call(builtin.bash, command=setup)
        return [
            await rig.call(builtin.view, path=path),
            await rig.call(builtin.write_file, path=path, content='pwned', overwrite=True),
            await rig.call(builtin.str_replace, path=path, old_str='root', new_str='pwned'),
        ]

    for result in asyncio.run(go()):
        assert isinstance(result, dict)
        assert 'error' in result
        assert 'root:' not in json.dumps(result)
    # The only daemon call is the bash tool's own check of /workspace/outputs (sandbox/outputs.py), a fixed path.
    reads = [(name, args) for name, args in rig.backend.calls if name in ('get_files', 'stat')]
    assert all(name == 'stat' and cast(dict, args)['path'] == '/workspace/outputs' for name, args in reads)
    # Neither the guest's files nor the fake's emulation of them were changed.
    box = rig.backend.sandboxes.get(next(iter(rig.backend.sandboxes), ''))
    assert box is None or box.rootfs['/etc/passwd'].content == b'root:x:0:0:root:/root:/bin/bash\n'


def test_view_returns_an_image_as_a_data_uri(monkeypatch):
    rig = _Rig(monkeypatch)
    # A PNG signature and an IHDR chunk declaring a 2x1 picture.
    png = b'\x89PNG\r\n\x1a\n' + b'\0\0\0\x0dIHDR' + (2).to_bytes(4, 'big') + (1).to_bytes(4, 'big') + b'\0' * 16

    async def go():
        await rig.call(builtin.bash, command='printf hi')
        box = next(iter(rig.backend.sandboxes.values()))
        box.files['/workspace/plot.png'] = FakeFile(content=png, uid=1000, mode=0o644)
        return await rig.call(builtin.view, path='plot.png')

    assert asyncio.run(go()) == 'data:image/png;base64,' + base64.b64encode(png).decode()


@pytest.mark.parametrize(
    ('content', 'path', 'error'),
    [
        (b'\0\1\2', 'blob.bin', 'is a binary file'),
        (b'x', 'missing.txt', 'missing.txt: no such file or directory'),
    ],
)
def test_view_refuses_a_binary_or_missing_file(monkeypatch, content, path, error):
    rig = _Rig(monkeypatch)

    async def go():
        await rig.call(builtin.bash, command='printf hi')
        box = next(iter(rig.backend.sandboxes.values()))
        box.files['/workspace/blob.bin'] = FakeFile(content=content, uid=1000, mode=0o644)
        return await rig.call(builtin.view, path=path)

    result = asyncio.run(go())
    assert isinstance(result, dict)
    assert error in result['error']


# T12's security review: the fixes, each pinned.


async def _second_session_marks(rig: _Rig, log: list[str]) -> None:
    manager = cast(SandboxManager, rig.request.app.state.sandbox)
    async with manager.session(CHAT, SimpleNamespace(id='u1', role='user')):
        log.append('second session')


def test_a_cancelled_bash_call_holds_the_chat_until_its_command_has_ended_and_the_kill_has_run(monkeypatch):
    # B1: the user's Stop cancels the tool while the command runs. The next call on the chat may not start until the
    # command has ended and the post-exec kill has run, even when Stop is pressed again during the kill.
    rig = _Rig(monkeypatch)
    log: list[str] = []
    kill = rig.backend._kill

    def recording_kill(chat_id, box):
        log.append('kill')
        kill(chat_id, box)

    monkeypatch.setattr(rig.backend, '_kill', recording_kill)

    async def go():
        started = asyncio.Event()

        async def script(request):
            if request.argv[-1] != 'slow':
                return await interpret(request)
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                # A command takes a moment to die after the kill's signal.
                for _ in range(10):
                    await asyncio.sleep(0)
                log.append('command ended')
                raise
            return FakeRun(0)

        rig.backend.script = script
        first = asyncio.ensure_future(rig.call(builtin.bash, command='slow'))
        await started.wait()
        first.cancel()
        second = asyncio.ensure_future(_second_session_marks(rig, log))
        await asyncio.sleep(0)
        first.cancel()
        outcome = await asyncio.gather(first, second, return_exceptions=True)
        return outcome

    first, second = asyncio.run(go())
    assert isinstance(first, asyncio.CancelledError)
    assert second is None
    assert log == ['command ended', 'kill', 'second session']


def test_a_kill_that_fails_stops_the_sandbox_and_the_model_is_told_without_internals(monkeypatch):
    # S2: a post-exec kill that cannot confirm every UID 1000 process is gone fails closed: the sandbox is stopped,
    # the call fails, and the next call starts a fresh container on the same volume.
    rig = _Rig(monkeypatch)

    async def go():
        await rig.call(builtin.write_file, path='kept.txt', content='kept')
        rig.backend.kill_fails = True
        failed = await rig.call(builtin.bash, command='printf hi')
        rig.backend.kill_fails = False
        again = await rig.call(builtin.view, path='kept.txt')
        return failed, again

    failed, again = asyncio.run(go())
    assert failed == {'error': 'The sandbox failed: it stopped during the call; the next call starts it again'}
    assert ('kill_uid_1000_failed', {'chat_id': CHAT}) in rig.backend.calls
    assert ('stop', {'chat_id': CHAT}) in rig.backend.calls
    assert cast(dict, again)['content'] == '     1\tkept'


def test_a_failed_kill_on_a_cancelled_exec_stops_the_sandbox_too():
    async def go():
        backend = FakeBackend()
        await backend.create(CHAT, SandboxSpec(CHAT, 'data'))
        backend.kill_fails = True

        async def hang(request):
            await asyncio.Event().wait()
            return FakeRun(0)

        backend.script = hang
        task = asyncio.ensure_future(backend.exec(CHAT, wrap_command('x', 60), 60))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(SandboxNotRunning):
            await task
        return backend

    backend = asyncio.run(go())
    assert not backend.sandboxes[CHAT].running


def test_the_fake_retrieves_what_a_command_raised_after_its_caller_gave_up():
    async def go():
        backend = FakeBackend()
        await backend.create(CHAT, SandboxSpec(CHAT, 'data'))

        async def dies_badly(request):
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                raise RuntimeError('the command died its own way') from None
            return FakeRun(0)

        backend.script = dies_badly
        task = asyncio.ensure_future(backend.exec(CHAT, wrap_command('x', 60), 60))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return backend

    assert asyncio.run(go()).calls[-1] == ('kill_uid_1000', {'chat_id': CHAT})


def test_write_helper_refuses_a_fifo_at_once_instead_of_blocking_on_it(real_root: Path):
    # S3: `cat > fifo` would wait for a reader for the whole helper timeout.
    os.mkfifo(real_root / 'pipe')
    ws = _fake_tree()
    ws.mkfifo('pipe')
    args = ['-c', workspace.WRITE_SCRIPT, 'lllm-write', 'pipe', 'overwrite']
    real = _run_real(real_root, args, b'x')
    fake = _fake_run(ws, args, b'x')
    assert real.returncode == fake.returncode == 1
    assert real.stderr.endswith(b'/pipe is not a regular file\n')
    assert fake.stderr == b'/workspace/pipe is not a regular file\n'


def test_the_fake_reports_a_fifo_as_other_lists_it_and_never_reads_it():
    async def go():
        backend = FakeBackend()
        await backend.create(CHAT, SandboxSpec(CHAT, 'data'))
        FakeWorkspace(backend.sandboxes[CHAT].files).mkfifo('pipe')
        listing = await backend.exec(CHAT, workspace.list_argv('.'), workspace.HELPER_TIMEOUT_S)
        return (
            await backend.stat(CHAT, '/workspace/pipe'),
            await backend.get_files(CHAT, ['/workspace/pipe'], 9),
            listing,
        )

    stat, files, listing = asyncio.run(go())
    assert stat is not None
    assert stat.kind == 'other'
    assert files == {}
    # uploads is the read-only uploads mount every sandbox has (T13).
    assert listing.stdout == 'p\t0\tpipe\0d\t0\tuploads\0'


def test_view_refuses_a_fifo_and_write_file_refuses_it_without_waiting(monkeypatch):
    rig = _Rig(monkeypatch)

    async def go():
        await rig.call(builtin.bash, command='printf hi')
        FakeWorkspace(next(iter(rig.backend.sandboxes.values())).files).mkfifo('pipe')
        return (
            await rig.call(builtin.view, path='pipe'),
            await rig.call(builtin.write_file, path='pipe', content='x', overwrite=True),
        )

    viewed, written = asyncio.run(go())
    assert viewed == {'error': 'pipe is not a regular file'}
    assert written == {'error': '/workspace/pipe is not a regular file'}


@pytest.mark.parametrize(('path', 'refused'), [('top.txt', True), ('sub', False), ('sub/missing/x', False)])
def test_read_helper_refuses_a_file_uid_1000_cannot_read_like_real_bash(real_root: Path, path: str, refused: bool):
    # N10: the daemon reads as root, so the read check keeps view and str_replace to what bash could read.
    ws = _fake_tree()
    (real_root / 'top.txt').chmod(0o000)
    ws.chmod('top.txt', 0o000)
    args = ['-c', workspace.READ_SCRIPT, 'lllm-read', path]
    try:
        real = _run_real(real_root, args)
    finally:
        (real_root / 'top.txt').chmod(0o644)
    fake = _fake_run(ws, args)
    assert real.returncode == fake.returncode == (1 if refused else 0)
    if refused:
        assert b'cannot be read: permission denied' in real.stderr
        assert fake.stderr == b'lllm-read: /workspace/top.txt cannot be read: permission denied\n'
    else:
        assert _relative(real.stdout.decode(), str(real_root)) == _relative(fake.stdout.decode(), '/workspace')


@pytest.mark.parametrize('path', ['../etc/passwd', 'out/passwd'])
def test_read_helper_refuses_what_lllm_path_refuses(real_root: Path, path: str):
    args = ['-c', workspace.READ_SCRIPT, 'lllm-read', path]
    assert _run_real(real_root, args).returncode == _fake_run(_fake_tree(), args).returncode == 1


def test_view_and_str_replace_refuse_a_file_uid_1000_cannot_read(monkeypatch):
    rig = _Rig(monkeypatch)

    async def go():
        await rig.call(builtin.write_file, path='secret.txt', content='root only')
        next(iter(rig.backend.sandboxes.values())).files['/workspace/secret.txt'].uid = 0
        next(iter(rig.backend.sandboxes.values())).files['/workspace/secret.txt'].mode = 0o600
        return (
            await rig.call(builtin.view, path='secret.txt'),
            await rig.call(builtin.str_replace, path='secret.txt', old_str='root', new_str='x'),
        )

    for result in asyncio.run(go()):
        assert result == {'error': 'lllm-read: /workspace/secret.txt cannot be read: permission denied'}
    assert not any(name == 'get_files' for name, _ in rig.backend.calls)


def test_a_path_to_a_name_that_is_not_utf8_is_the_models_to_fix_not_a_sandbox_failure():
    # N8: a replacement character in what lllm-path printed means a name that is not UTF-8.
    class _Printed:
        async def exec(self, argv, timeout_s, stdin=None):
            return ExecResult(
                returncode=0, stdout='/workspace/a�\n', stderr='', timed_out=False, truncated=False, duration_ms=1
            )

    with pytest.raises(workspace.WorkspaceError, match='not valid UTF-8'):
        asyncio.run(workspace.resolve(cast(workspace.SandboxSession, _Printed()), 'a'))


@pytest.mark.parametrize('path', ['//workspace/x', '///workspace/a/b', '//workspace'])
def test_confine_reads_leading_slashes_as_the_kernel_does(path: str):
    assert workspace.confine(path) == path


@pytest.mark.parametrize('path', ['dir/', '/workspace/dir/', './dir/./', 'dir/.', 'a/..', 'x/../'])
def test_write_file_refuses_a_path_that_names_a_directory_before_anything_runs(monkeypatch, path: str):
    # N9: realpath drops a trailing `/`, which would have written a file named `dir`.
    rig = _Rig(monkeypatch)
    result = asyncio.run(rig.call(builtin.write_file, path=path, content='x'))
    assert result == {'error': f'{path!r} names a directory; give the path of a file'}
    assert rig.backend.calls == []


@pytest.mark.parametrize(
    ('tool', 'kwargs'),
    [
        (builtin.view, {'path': '../etc/passwd'}),
        (builtin.str_replace, {'path': '/etc/passwd', 'old_str': 'a', 'new_str': 'b'}),
        (builtin.write_file, {'path': 'a\0b', 'content': 'x'}),
    ],
)
def test_a_path_refused_on_the_host_starts_no_sandbox(monkeypatch, tool, kwargs):
    rig = _Rig(monkeypatch)
    result = asyncio.run(rig.call(tool, **kwargs))
    assert isinstance(result, dict)
    assert 'error' in result
    assert rig.backend.calls == []


def _png(width: int, height: int) -> bytes:
    # The signature and a whole IHDR chunk: 13 bytes of data (the size, then 5 more) and its CRC.
    return b'\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR' + width.to_bytes(4, 'big') + height.to_bytes(4, 'big') + b'\0' * 9


def _jpeg(width: int, height: int, before: bytes = b'') -> bytes:
    frame = b'\xff\xc0\x00\x11\x08' + height.to_bytes(2, 'big') + width.to_bytes(2, 'big') + b'\x03' + b'\0' * 9
    return b'\xff\xd8' + before + frame


def _gif_frame(width: int, height: int, left: int = 0, top: int = 0) -> bytes:
    # An image descriptor without a local color table, the LZW minimum code size, and an empty sub-block chain.
    return b'\x2c' + b''.join(v.to_bytes(2, 'little') for v in (left, top, width, height)) + b'\x00\x02\x00'


def _gif(width: int, height: int, *frames: bytes, before: bytes = b'') -> bytes:
    # A screen of width x height (one frame of the same size unless frames are given), then the trailer.
    screen = b'GIF89a' + width.to_bytes(2, 'little') + height.to_bytes(2, 'little') + b'\x00\x00\x00'
    return screen + before + b''.join(frames or (_gif_frame(width, height),)) + b'\x3b'


def _webp(chunk: bytes, body: bytes) -> bytes:
    return b'RIFF\0\0\0\0WEBP' + chunk + len(body).to_bytes(4, 'little') + body


def _vp8(width: int, height: int) -> bytes:
    return _webp(b'VP8 ', b'\0\0\0\x9d\x01\x2a' + width.to_bytes(2, 'little') + height.to_bytes(2, 'little'))


def _vp8l(width: int, height: int) -> bytes:
    bits = (width - 1) | ((height - 1) << 14)
    return _webp(b'VP8L', b'\x2f' + bits.to_bytes(4, 'little'))


def _vp8x(width: int, height: int) -> bytes:
    return _webp(b'VP8X', b'\0\0\0\0' + (width - 1).to_bytes(3, 'little') + (height - 1).to_bytes(3, 'little'))


@pytest.mark.parametrize(
    ('data', 'size'),
    [
        (_png(640, 480), (640, 480)),
        (_jpeg(640, 480), (640, 480)),
        # An APP0 segment, a fill byte and a restart marker before the frame header.
        (_jpeg(3, 2, b'\xff\xe0\x00\x04ab\xff\xff\xd0'), (3, 2)),
        (_gif(640, 480), (640, 480)),
        (_vp8(640, 480), (640, 480)),
        (_vp8l(640, 480), (640, 480)),
        (_vp8x(640, 480), (640, 480)),
    ],
    ids=['png', 'jpeg', 'jpeg-segments', 'gif', 'vp8', 'vp8l', 'vp8x'],
)
def test_image_size_reads_each_kinds_header(data: bytes, size: tuple[int, int]):
    media_type = workspace.image_type(data)
    assert media_type is not None
    assert workspace.image_size(data, media_type) == size


@pytest.mark.parametrize(
    'data',
    [
        b'\x89PNG\r\n\x1a\n\0\0\0\x0dXXXX' + b'\0' * 8,
        b'GIF89a\x01',
        b'\xff\xd8\xff\xda\x00\x02',
        b'\xff\xd8\xff\xe0\x00\x04ab\x00\x00\x00\x00',
        b'\xff\xd8\xff\xc0\x00\x11\x08\x00',
        b'\xff\xd8\xff\xe0\x00\x04',
        _webp(b'ALPH', b''),
    ],
    ids=['png-no-ihdr', 'gif-short', 'jpeg-scan-first', 'jpeg-not-a-marker', 'jpeg-short-frame', 'jpeg-ends', 'webp'],
)
def test_image_size_is_none_for_a_header_it_cannot_read(data: bytes):
    media_type = workspace.image_type(data)
    assert media_type is not None
    assert workspace.image_size(data, media_type) is None


@pytest.mark.parametrize(
    ('data', 'error'),
    [
        (_png(8193, 1), 'is 8193x1 pixels, over the limit'),
        (_jpeg(1, 9000), 'is 1x9000 pixels, over the limit'),
        (_vp8x(8000, 8000), 'is 8000x8000 pixels, over the limit'),
        (_gif(8192, 8192), 'is 8192x8192 pixels, over the limit'),
        (b'GIF89a\x01', 'its size cannot be read from its header'),
        (_png(1, 1) + b'\0' * workspace.IMAGE_MAX_BYTES, 'over the 2097152-byte limit'),
    ],
    ids=['wide', 'tall', 'pixels', 'pixels-at-the-side-limit', 'unreadable', 'bytes'],
)
def test_view_refuses_an_image_too_large_to_hand_the_model(monkeypatch, data: bytes, error: str):
    # S5: the data URI is kept with the chat and decoded by the user's browser.
    rig = _Rig(monkeypatch)

    async def go():
        await rig.call(builtin.bash, command='printf hi')
        box = next(iter(rig.backend.sandboxes.values()))
        box.files['/workspace/pic'] = FakeFile(content=data, uid=1000, mode=0o644)
        return await rig.call(builtin.view, path='pic')

    result = asyncio.run(go())
    assert isinstance(result, dict)
    assert error in result['error']


def test_view_returns_an_image_at_the_limits():
    assert workspace.IMAGE_MAX_BYTES == 2 * 1024 * 1024
    data = _png(8192, 4882)
    media_type = workspace.image_type(data)
    assert media_type == 'image/png'
    workspace._check_image('pic', data, media_type)


def test_resolve_without_the_read_check_runs_lllm_path_alone_through_the_fake():
    async def go():
        backend = FakeBackend()
        manager = SandboxManager(backend, chats=_Chats(), settings=_settings)
        async with manager.session(CHAT, SimpleNamespace(id='u1', role='user')) as session:
            return await workspace.resolve(session, 'a/../b'), backend

    resolved, backend = asyncio.run(go())
    assert resolved == '/workspace/b'
    assert [args['argv'] for name, args in backend.calls if name == 'exec'] == [workspace.resolve_argv('a/../b')]


# T12's second round of review fixes.


def test_the_fakes_cancelled_exec_counts_a_command_the_kill_cannot_end_as_a_failed_kill():
    # R2: a backend bounds the wait for its kill to end the command; past it, it fails closed.
    async def go():
        backend = FakeBackend()
        backend.kill_wait_s = 0.02
        await backend.create(CHAT, SandboxSpec(CHAT, 'data'))
        release = asyncio.Event()

        async def stubborn(request):
            while not release.is_set():
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    continue
            return FakeRun(0)

        backend.script = stubborn
        task = asyncio.ensure_future(backend.exec(CHAT, wrap_command('x', 60), 60))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(SandboxNotRunning):
            await task
        lingering = len(backend._lingering)
        release.set()
        await asyncio.sleep(0)
        return backend, lingering

    backend, lingering = asyncio.run(go())
    assert not backend.sandboxes[CHAT].running
    assert ('kill_uid_1000_failed', {'chat_id': CHAT}) in backend.calls
    assert (lingering, len(backend._lingering)) == (1, 0)


def test_lllm_path_and_the_host_agree_on_the_longest_path():
    # M6: the one limit two places hold.
    assert f'readonly MAX_BYTES={workspace.MAX_PATH_BYTES}\n' in LLLM_PATH_SOURCE.read_text(encoding='utf-8')


def _resolving_to(root: str, total: int) -> str:
    # A relative path, in components under 255 bytes, that resolves under `root` to exactly `total` bytes.
    remaining = total - len(root) - 1
    parts = []
    while remaining > 0:
        part = min(200, remaining)
        if remaining - part == 1:
            part -= 2
        parts.append('a' * part)
        remaining -= part + 1
    path = '/'.join(parts)
    assert len(f'{root}/{path}') == total
    return path


@pytest.mark.parametrize(('total', 'accepted'), [(4096, True), (4097, False)])
def test_a_path_resolving_to_exactly_the_limit_is_accepted_and_one_byte_more_refused(real_root, total, accepted):
    real = _run_real(real_root, [workspace.LLLM_PATH, _resolving_to(str(real_root), total)])
    fake = lllm_path(_fake_tree(), _resolving_to('/workspace', total))
    assert (real.returncode, fake.returncode) == ((0, 0) if accepted else (1, 1))


@pytest.mark.parametrize('script', ['read', 'write'])
def test_a_helper_missing_from_the_image_is_a_sandbox_failure_not_a_refusal(real_root: Path, script: str):
    # M3: `|| exit $?` keeps 127 (no such program) apart from lllm-path's refusal, 1.
    args = {
        'read': ['-c', workspace.READ_SCRIPT, 'lllm-read', 'top.txt'],
        'write': ['-c', workspace.WRITE_SCRIPT, 'lllm-write', 'new.txt', 'new'],
    }[script]
    argv = [arg.replace(workspace.LLLM_PATH, '/nonexistent/lllm-path') for arg in [*workspace.GUEST_SHELL, *args]]
    run = subprocess.run(argv, input=b'x', capture_output=True, cwd=real_root, timeout=30, check=False)
    assert run.returncode == 127
    result = ExecResult(
        returncode=127, stdout='', stderr=run.stderr.decode(), timed_out=False, truncated=False, duration_ms=1
    )
    with pytest.raises(SandboxError) as caught:
        workspace._check_exit(result, 'lllm-path')
    assert caught.value.public == 'lllm-path failed in the sandbox (exit status 127)'
    assert not (real_root / 'new.txt').exists()


def _write_both(real_root: Path, ws: FakeWorkspace, path: str, mode: str, data: bytes):
    args = ['-c', workspace.WRITE_SCRIPT, 'lllm-write', path, mode]
    return _run_real(real_root, args, data), _fake_run(ws, args, data)


def test_an_overwrite_keeps_the_files_mode_and_leaves_no_temporary_file(real_root: Path):
    # M4: the content goes to a temporary file renamed over the target.
    ws = _fake_tree()
    (real_root / 'top.txt').chmod(0o600)
    ws.chmod('top.txt', 0o600)
    real, fake = _write_both(real_root, ws, 'top.txt', 'overwrite', b'new\n')
    assert real.returncode == fake.returncode == 0
    assert (real_root / 'top.txt').read_bytes() == ws.read('top.txt') == b'new\n'
    assert (real_root / 'top.txt').stat().st_mode & 0o777 == ws.files['/workspace/top.txt'].mode == 0o600
    assert not [p for p in os.listdir(real_root) if p.startswith('.lllm-write')]
    assert not [p for p in ws.files if '.lllm-write' in p]


def test_a_new_file_is_written_with_mode_644(real_root: Path):
    ws = _fake_tree()
    real, fake = _write_both(real_root, ws, 'sub/new.txt', 'new', b'x')
    assert real.returncode == fake.returncode == 0
    assert (real_root / 'sub/new.txt').stat().st_mode & 0o777 == ws.files['/workspace/sub/new.txt'].mode == 0o644


def test_an_overwrite_of_a_read_only_file_is_refused_and_leaves_it_alone(real_root: Path):
    ws = _fake_tree()
    (real_root / 'top.txt').chmod(0o444)
    ws.chmod('top.txt', 0o444)
    real, fake = _write_both(real_root, ws, 'top.txt', 'overwrite', b'new\n')
    assert real.returncode == fake.returncode == 1
    assert real.stderr.endswith(b'/top.txt is read-only\n')
    assert fake.stderr == b'/workspace/top.txt is read-only\n'
    assert (real_root / 'top.txt').read_bytes() == ws.read('top.txt') == b'hello\n'


def test_a_write_into_a_directory_it_cannot_write_is_refused_by_mktemp_in_the_fake_too(real_root: Path):
    ws = _fake_tree()
    (real_root / 'sub').chmod(0o555)
    ws.chmod('sub', 0o555)
    try:
        real, fake = _write_both(real_root, ws, 'sub/ok.txt', 'overwrite', b'new\n')
    finally:
        (real_root / 'sub').chmod(0o755)
    assert real.returncode == fake.returncode == 1
    assert b'mktemp: failed to create file via template' in real.stderr
    assert b'mktemp: failed to create file via template' in fake.stderr
    assert (real_root / 'sub/ok.txt').read_bytes() == ws.read('sub/ok.txt') == b'ok\n'


def test_a_write_that_fails_part_way_leaves_the_old_file_whole(real_root: Path):
    # M4: a full disk, simulated with a 4-byte file size limit, kills `cat` with SIGXFSZ half-way.
    import resource

    def limit_file_size() -> None:
        resource.setrlimit(resource.RLIMIT_FSIZE, (4, 4))

    script = str(_real_lllm_path(real_root))
    args = ['-c', workspace.WRITE_SCRIPT, 'lllm-write', 'top.txt', 'overwrite']
    argv = [arg.replace(workspace.LLLM_PATH, script) for arg in [*workspace.GUEST_SHELL, *args]]
    run = subprocess.run(
        argv, input=b'x' * 100, capture_output=True, cwd=real_root, timeout=30, check=False, preexec_fn=limit_file_size
    )
    assert run.returncode == 1
    assert (real_root / 'top.txt').read_bytes() == b'hello\n'
    assert not [p for p in os.listdir(real_root) if p.startswith('.lllm-write')]


def _gif_info(data: bytes):
    media_type = workspace.image_type(data)
    assert media_type == 'image/gif'
    return workspace.image_size(data, media_type), workspace.image_animated(data, media_type)


def test_a_gif_frame_larger_than_its_screen_counts_with_its_offset():
    # R4: a 1x1 screen whose one frame is 9000x10 at (10, 0).
    assert _gif_info(_gif(1, 1, _gif_frame(9000, 10, left=10))) == ((9010, 10), False)


def test_a_gif_with_a_color_table_and_extensions_is_walked_to_its_frames():
    color_table = b'\0' * 6  # two colors, for a flags byte of 0x80
    screen = b'GIF89a' + (3).to_bytes(2, 'little') + (2).to_bytes(2, 'little') + b'\x80\x00\x00' + color_table
    extension = b'\x21\xf9\x04\x00\x00\x00\x00\x00'
    local_table_frame = b'\x2c' + b'\0' * 4 + (3).to_bytes(2, 'little') + (2).to_bytes(2, 'little') + b'\x80'
    data = screen + extension + local_table_frame + b'\0' * 6 + b'\x02\x01\x00\x00' + b'\x3b'
    assert _gif_info(data) == ((3, 2), False)


def test_a_gif_with_two_frames_is_animated_and_refused(monkeypatch):
    data = _gif(2, 2, _gif_frame(2, 2), _gif_frame(2, 2))
    assert _gif_info(data) == ((2, 2), True)
    with pytest.raises(workspace.WorkspaceError, match='is an animated image'):
        workspace._check_image('a.gif', data, 'image/gif')


@pytest.mark.parametrize(
    ('data', 'size'),
    [
        # A block that is neither an extension, a frame nor the trailer.
        (_gif(2, 2, before=b'\x99'), None),
        # Cut off in the middle of a frame's data: the frames so far count.
        (_gif(2, 2)[:-3] + b'\x05ab', (2, 2)),
        # No trailer at all.
        (_gif(2, 2)[:-1], (2, 2)),
    ],
    ids=['unknown-block', 'cut-in-data', 'no-trailer'],
)
def test_a_gif_whose_blocks_cannot_be_walked_or_are_cut_short(data: bytes, size):
    assert _gif_info(data)[0] == size


def test_a_webp_bitstream_larger_than_its_canvas_counts():
    vp8x = b'VP8X' + (10).to_bytes(4, 'little') + b'\0' * 4 + (0).to_bytes(3, 'little') + (0).to_bytes(3, 'little')
    bitstream = (
        b'VP8 ' + (10).to_bytes(4, 'little') + b'\0\0\0\x9d\x01\x2a' + (9000).to_bytes(2, 'little') + b'\x01\x00'
    )
    data = b'RIFF\0\0\0\0WEBP' + vp8x + bitstream
    media_type = workspace.image_type(data)
    assert media_type == 'image/webp'
    assert workspace.image_size(data, media_type) == (9000, 1)
    assert not workspace.image_animated(data, media_type)


def test_a_webp_chunk_of_odd_length_is_padded_to_the_next_one():
    data = b'RIFF\0\0\0\0WEBP' + b'ICCP' + (3).to_bytes(4, 'little') + b'abc\0' + _vp8(5, 4)[12:]
    assert workspace.image_size(data, 'image/webp') == (5, 4)


def _png_chunk(kind: bytes, body: bytes) -> bytes:
    return len(body).to_bytes(4, 'big') + kind + body + b'\0\0\0\0'


@pytest.mark.parametrize(
    ('chunks', 'animated'),
    [
        # acTL before the first IDAT: an APNG, which browsers play.
        ([_png_chunk(b'acTL', b'\0' * 8), _png_chunk(b'IDAT', b'')], True),
        # acTL only after IDAT is not an APNG.
        ([_png_chunk(b'IDAT', b''), _png_chunk(b'acTL', b'\0' * 8)], False),
        ([_png_chunk(b'tEXt', b'a'), _png_chunk(b'IDAT', b'')], False),
        # No IDAT at all, cut short.
        ([_png_chunk(b'tEXt', b'a')], False),
    ],
    ids=['apng', 'actl-after-idat', 'still', 'no-idat'],
)
def test_an_animated_png_is_found_by_its_actl_chunk_before_the_image_data(chunks: list[bytes], animated: bool):
    data = _png(2, 2) + b''.join(chunks)
    assert workspace.image_animated(data, 'image/png') is animated
    if animated:
        with pytest.raises(workspace.WorkspaceError, match='is an animated image'):
            workspace._check_image('a.png', data, 'image/png')
    else:
        workspace._check_image('a.png', data, 'image/png')


def test_an_animated_webp_is_refused():
    animated = (
        b'VP8X' + (10).to_bytes(4, 'little') + b'\x02\0\0\0' + (1).to_bytes(3, 'little') + (1).to_bytes(3, 'little')
    )
    data = b'RIFF\0\0\0\0WEBP' + animated
    assert workspace.image_animated(data, 'image/webp')
    assert not workspace.image_animated(_jpeg(1, 1), 'image/jpeg')
    with pytest.raises(workspace.WorkspaceError, match='is an animated image'):
        workspace._check_image('a.webp', data, 'image/webp')


@pytest.mark.parametrize(
    ('old', 'new', 'edited'),
    [('a\n', 'b\n', '2-2'), ('a', 'b\nc', '2-3'), ('a\n', '', '2-2'), ('a\ny\n', 'b\nc\nd\n', '2-4')],
)
def test_str_replace_reports_the_lines_it_edited(monkeypatch, old: str, new: str, edited: str):
    # L4: a newline that ends the replacement starts no edited line after it.
    rig = _Rig(monkeypatch)

    async def go():
        await rig.call(builtin.write_file, path='f', content='x\na\ny\n')
        return await rig.call(builtin.str_replace, path='f', old_str=old, new_str=new)

    assert cast(dict, asyncio.run(go()))['edited_lines'] == edited


def test_a_wait_for_a_sandbox_that_ends_without_one_closes_its_status(monkeypatch):
    # L3: the chat would otherwise show "Waiting for a free sandbox" for good.
    rig = _Rig(monkeypatch)
    manager = cast(SandboxManager, rig.request.app.state.sandbox)

    @asynccontextmanager
    async def no_slot(chat_id, user, *, image=None, on_wait=None):
        assert on_wait is not None
        await on_wait()
        raise SandboxError('no free sandbox: all 4 slots are taken', public='no sandbox came free')
        yield

    monkeypatch.setattr(manager, 'session', no_slot)
    result = asyncio.run(rig.call(builtin.bash, command='printf hi'))
    assert result == {'error': 'The sandbox failed: no sandbox came free'}
    assert [event['data'] for event in rig.events] == [
        {'description': 'Waiting for a free sandbox', 'done': False},
        {'description': 'No sandbox could start', 'done': True},
    ]
