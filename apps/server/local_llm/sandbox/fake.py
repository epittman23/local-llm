"""An in-memory SandboxBackend, for testing the layers above the backend without Docker or Kata.

CI's hosted runners have no `/dev/kvm`, so the manager, the tools and the
call sites are tested against this fake. It keeps the invariants the
backend contract (sandbox/backend.py) requires of the planned Kata backend
(T14), or those tests would pass for the wrong reason: it checks chat ids,
specs, argv, timeouts, paths, names and modes with the shared validators
every backend is to call; `put_files` leaves exactly the given root-owned
files, so UID 1000 cannot change them or keep a planted one; a stopped
sandbox keeps its volume and a destroyed one loses it; a chat with no
running sandbox cannot run anything, and one that stops during a command
raises SandboxNotRunning instead of returning a result; and output goes
through the same StreamCap and result_from every backend uses.

It does not model the size of the volume (limits.WORKSPACE_SIZE): a write
never fails with ENOSPC, so a test of a full workspace needs a script.

The guest outside `/workspace` is modelled too, with the kernel's checks: a
root-owned `/etc` holding a 0o644 `/etc/passwd` that UID 1000 can read but
not change, a 0o1777 tmpfs `/tmp` emptied at every container start, and a
read-only root everywhere else (EROFS). Every path is checked for the search
bit on each ancestor, so a test that something refuses `/etc/passwd` fails
for the right reason: the file is there and readable.

`exec` runs a script the test supplies, or by default `interpret`, a tiny
bash for `cat`, `ls`, `printf` and `sleep` that honours the timeout without
sleeping. It is test support, not a shell. Every call is recorded in
`FakeBackend.calls`, so a test can assert what the manager asked for,
including the `('kill_uid_1000', ...)` entry that stands for the kill every
backend runs after every exec.
"""

import datetime as dt
import errno
import itertools
import os
import posixpath
import re
import shlex
import time
from collections.abc import Awaitable, Callable, Iterator
from dataclasses import dataclass, field

from local_llm.sandbox.backend import validate_create, validate_get_files, validate_put_files, validate_sandbox_path
from local_llm.sandbox.exec import StreamCap, require_wrapped, result_from
from local_llm.sandbox.limits import HOST_DEADLINE_SLACK_S, SANDBOX_UID, WORKSPACE
from local_llm.sandbox.types import (
    ExecResult,
    FileStat,
    ImageKey,
    SandboxInfo,
    SandboxNotRunning,
    SandboxSpec,
    SandboxUnavailable,
    validate_chat_id,
)

#: The guest's writable tmpfs; the rest of the root outside `/workspace` is read-only.
TMP = '/tmp'


def _error(code: int, path: str) -> OSError:
    # OSError picks the subclass from the errno: EACCES is a PermissionError,
    # ENOENT a FileNotFoundError, and so on; strerror is what the tools print.
    return OSError(code, os.strerror(code), path)


def _under(full: str, top: str) -> bool:
    return full == top or full.startswith(top + '/')


@dataclass
class FakeFile:
    """One entry of a fake sandbox's file table: a file, or a directory when `content` is None."""

    content: bytes | None
    uid: int
    mode: int
    mtime: float = field(default_factory=time.time)


def guest_root() -> dict[str, FakeFile]:
    """A fresh copy of the container's own files outside `/workspace`: `/`, `/etc`, `/etc/passwd` and `/tmp`."""
    return {
        '/': FakeFile(content=None, uid=0, mode=0o755),
        '/etc': FakeFile(content=None, uid=0, mode=0o755),
        '/etc/passwd': FakeFile(content=b'root:x:0:0:root:/root:/bin/bash\n', uid=0, mode=0o644),
        TMP: FakeFile(content=None, uid=0, mode=0o1777),
    }


def _allowed(entry: FakeFile, uid: int, bits: int) -> bool:
    # Owner bits for the owner, other bits for everyone else: every entry is
    # owned by root or by UID 1000, each in its own group. There is no root
    # override, since the sandbox drops every capability.
    shift = 6 if uid == entry.uid else 0
    return (entry.mode >> shift) & bits == bits


class FakeWorkspace:
    """One fake sandbox's files as a command sees them, with the guest's permission checks for a given UID.

    Relative paths are taken from `/workspace`, the commands' working
    directory. Paths under `/workspace` are the volume (`files`); every
    other path is the container's own root (`rootfs`), writable only under
    `/tmp`. Every ancestor directory needs the search bit for the UID.
    """

    def __init__(self, files: dict[str, FakeFile], rootfs: dict[str, FakeFile] | None = None) -> None:
        """Wrap a volume's files and a container root.

        Args:
            files: The volume's entries, keyed by absolute, normalised path; shared with the backend.
            rootfs: The container's entries outside `/workspace`; a fresh guest_root() when omitted.
        """
        self.files = files
        self.rootfs = guest_root() if rootfs is None else rootfs

    @staticmethod
    def resolve(path: str) -> str:
        """The absolute, normalised form of `path`."""
        full = posixpath.normpath(posixpath.join(WORKSPACE, path))
        # normpath keeps a leading `//`, which the kernel reads as `/`.
        return '/' + full.lstrip('/')

    def _get(self, full: str) -> FakeFile | None:
        return (self.files if _under(full, WORKSPACE) else self.rootfs).get(full)

    def _lookup(self, path: str, uid: int) -> tuple[str, FakeFile | None]:
        """Walk to `path` as the kernel does: every ancestor must be a directory UID `uid` can search.

        Raises:
            FileNotFoundError, NotADirectoryError, PermissionError: For the first ancestor that fails.
        """
        full = self.resolve(path)
        ancestors: list[str] = []
        parent = full
        while parent != '/':
            parent = posixpath.dirname(parent)
            ancestors.append(parent)
        for ancestor in reversed(ancestors):
            entry = self._get(ancestor)
            if entry is None:
                raise _error(errno.ENOENT, path)
            if entry.content is not None:
                raise _error(errno.ENOTDIR, path)
            if not _allowed(entry, uid, 0o1):
                raise _error(errno.EACCES, path)
        return full, self._get(full)

    def read(self, path: str, uid: int = SANDBOX_UID) -> bytes:
        """Read a file as `uid`.

        Raises:
            FileNotFoundError, NotADirectoryError, IsADirectoryError, PermissionError: As the guest would.
        """
        _, entry = self._lookup(path, uid)
        if entry is None:
            raise _error(errno.ENOENT, path)
        if entry.content is None:
            raise _error(errno.EISDIR, path)
        if not _allowed(entry, uid, 0o4):
            raise _error(errno.EACCES, path)
        return entry.content

    def write(self, path: str, data: bytes, uid: int = SANDBOX_UID) -> None:
        """Create or replace a file as `uid`, as `open(O_WRONLY | O_CREAT | O_TRUNC)` would; a new file is 0o644.

        The kernel's order: an ancestor that fails, then EISDIR onto any
        directory (`/workspace` itself included), then EROFS on the
        read-only root, then the permission bits.

        Raises:
            OSError: EROFS outside `/workspace` and `/tmp`; FileNotFoundError,
                NotADirectoryError, IsADirectoryError or PermissionError as
                the guest would.
        """
        full, entry = self._lookup(path, uid)
        if entry is not None and entry.content is None:
            raise _error(errno.EISDIR, path)
        writable = self.files if _under(full, WORKSPACE) else self.rootfs if _under(full, TMP) else None
        if writable is None:
            raise _error(errno.EROFS, path)
        if entry is not None:
            if not _allowed(entry, uid, 0o2):
                raise _error(errno.EACCES, path)
            entry.content = data
            entry.mtime = time.time()
            return
        parent = self._get(posixpath.dirname(full))
        assert parent is not None, '_lookup has already checked every ancestor exists and is a directory'
        if not _allowed(parent, uid, 0o3):
            raise _error(errno.EACCES, path)
        writable[full] = FakeFile(content=data, uid=uid, mode=0o644)

    def listdir(self, path: str, uid: int = SANDBOX_UID) -> list[str]:
        """The sorted names in a directory, as `uid`.

        Raises:
            FileNotFoundError, NotADirectoryError, PermissionError: As the guest would.
        """
        full, entry = self._lookup(path, uid)
        if entry is None:
            raise _error(errno.ENOENT, path)
        if entry.content is not None:
            raise _error(errno.ENOTDIR, path)
        if not _allowed(entry, uid, 0o4):
            raise _error(errno.EACCES, path)
        prefix = full.rstrip('/') + '/'
        return sorted(
            p[len(prefix) :]
            for p in itertools.chain(self.files, self.rootfs)
            if p != full and p.startswith(prefix) and '/' not in p[len(prefix) :]
        )


@dataclass(frozen=True)
class FakeExecRequest:
    """What an exec script receives: the call's arguments and the sandbox's files."""

    chat_id: str
    argv: list[str]
    timeout_s: int
    stdin: bytes | None
    workspace: FakeWorkspace


@dataclass(frozen=True)
class FakeRun:
    """What an exec script returns: the raw outcome, before StreamCap and result_from."""

    returncode: int
    stdout: bytes = b''
    stderr: bytes = b''
    #: Simulated run time in seconds; nothing actually waits this long. At or past the
    #: host-side deadline (`timeout_s + HOST_DEADLINE_SLACK_S`), the fake sets `deadline_hit` itself.
    elapsed_s: float = 0.0
    #: The host-side deadline fired, as a backend reports it to result_from.
    deadline_hit: bool = False


#: An exec script: given the request, return the outcome or raise, and the
#: exception reaches the caller of `exec` unchanged.
ExecScript = Callable[[FakeExecRequest], Awaitable[FakeRun]]


@dataclass
class FakeSandbox:
    """One chat's fake sandbox: its volume's files, and its container (and that container's root) while running.

    Attributes:
        image: The image of the last container started.
        ephemeral: The flag of the spec that created the volume; a label, so
            a later create does not change it.
        running: Whether its container is running.
        files: The volume's entries, keyed by absolute, normalised path.
        last_used: When `create` last started a container.
        volume_created: When the volume was created, which is all a stopped
            sandbox can report (SandboxInfo.last_used).
        ip: The container's address while running.
        rootfs: The container's own files outside `/workspace`.
    """

    image: ImageKey
    ephemeral: bool
    running: bool
    files: dict[str, FakeFile]
    last_used: dt.datetime
    volume_created: dt.datetime
    ip: str | None = None
    #: The container's own files outside `/workspace`, fresh at every container start, so `/tmp` is emptied.
    rootfs: dict[str, FakeFile] = field(default_factory=guest_root)


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def _copy(value: object) -> object:
    # A list argument is recorded as it was at the call; anything else as given, so a call whose argument is not a
    # list is recorded too, and then refused by the validators.
    return list(value) if isinstance(value, list) else value


class FakeBackend:
    """An in-memory SandboxBackend.

    Attributes:
        sandboxes: Per-chat state, kept by `stop` and removed by `destroy`;
            a test may change it, for example to age `last_used`, or set
            `running` to False from a script to simulate a VM that died.
        calls: Every call, in order, as `(method name, arguments by name)`,
            including calls that raised, and a `('kill_uid_1000',
            {'chat_id': ...})` entry after every exec the sandbox survived
            (an exec it did not survive raises SandboxNotRunning).
        ready_reason: What `ready` returns; set it to make the backend
            unusable, so `create` raises SandboxUnavailable.
    """

    def __init__(self, script: ExecScript | None = None) -> None:
        """Make an empty backend.

        Args:
            script: Runs every `exec`; defaults to `interpret`.
        """
        self.script: ExecScript = script or interpret
        self.sandboxes: dict[str, FakeSandbox] = {}
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.ready_reason: str | None = None
        self._starts = itertools.count()

    def _running(self, chat_id: str) -> FakeSandbox:
        box = self.sandboxes.get(chat_id)
        if box is None or not box.running:
            raise SandboxNotRunning(f'no running sandbox for chat {chat_id}')
        return box

    def _still_running(self, chat_id: str, box: FakeSandbox) -> bool:
        return self.sandboxes.get(chat_id) is box and box.running

    async def create(self, chat_id: str, spec: SandboxSpec) -> None:
        self.calls.append(('create', {'chat_id': chat_id, 'spec': spec}))
        validate_create(chat_id, spec)
        # The plain str validate_chat_id gave the spec, equal to chat_id.
        chat_id = spec.chat_id
        if self.ready_reason is not None:
            raise SandboxUnavailable(self.ready_reason)
        box = self.sandboxes.get(chat_id)
        if box is None:
            # A new volume takes the image's /workspace: owned by UID 1000.
            workspace = {WORKSPACE: FakeFile(content=None, uid=SANDBOX_UID, mode=0o755)}
            created = _now()
            box = FakeSandbox(
                image=spec.image,
                ephemeral=spec.ephemeral,
                running=False,
                files=workspace,
                last_used=created,
                volume_created=created,
            )
            self.sandboxes[chat_id] = box
        if not (box.running and box.image == spec.image):
            box.image = spec.image
            box.running = True
            box.rootfs = guest_root()
            # A fresh address per container start, as Docker would give.
            n = next(self._starts)
            box.ip = f'172.30.{n // 250}.{n % 250 + 2}'
            # Only a container start moves it: labels cannot change after creation.
            box.last_used = _now()

    async def exec(self, chat_id: str, argv: list[str], timeout_s: int, stdin: bytes | None = None) -> ExecResult:
        self.calls.append(('exec', {'chat_id': chat_id, 'argv': _copy(argv), 'timeout_s': timeout_s, 'stdin': stdin}))
        chat_id = validate_chat_id(chat_id)
        require_wrapped(argv, timeout_s)
        box = self._running(chat_id)
        workspace = FakeWorkspace(box.files, box.rootfs)
        try:
            run = await self.script(FakeExecRequest(chat_id, list(argv), timeout_s, stdin, workspace))
        finally:
            # The kill every backend runs after every exec (owner decision
            # Q10), whenever the sandbox is still there to run it in.
            if self._still_running(chat_id, box):
                self.calls.append(('kill_uid_1000', {'chat_id': chat_id}))
        # Whatever the return code: a sandbox that died during the command is a failure, not a result.
        if not self._still_running(chat_id, box):
            raise SandboxNotRunning(f'the sandbox for chat {chat_id} stopped during the command')
        stdout, stderr = StreamCap(), StreamCap()
        stdout.feed(run.stdout)
        stderr.feed(run.stderr)
        return result_from(
            run.returncode,
            stdout=stdout,
            stderr=stderr,
            elapsed_s=run.elapsed_s,
            timeout_s=timeout_s,
            # A run this long would have met the host-side deadline, which would have fired.
            deadline_hit=run.deadline_hit or run.elapsed_s >= timeout_s + HOST_DEADLINE_SLACK_S,
        )

    async def put_files(self, chat_id: str, dir: str, files: list[tuple[str, bytes, int]]) -> None:
        self.calls.append(('put_files', {'chat_id': chat_id, 'dir': dir, 'files': _copy(files)}))
        chat_id = validate_chat_id(chat_id)
        validate_put_files(dir, files)
        box = self._running(chat_id)
        full = f'{WORKSPACE}/{dir}'
        # Replace, never follow or merge: the old entry goes with everything under it.
        for path in [p for p in box.files if _under(p, full)]:
            del box.files[path]
        now = time.time()
        box.files[full] = FakeFile(content=None, uid=0, mode=0o555, mtime=now)
        for name, content, mode in files:
            box.files[f'{full}/{name}'] = FakeFile(content=content, uid=0, mode=mode, mtime=now)

    async def get_files(self, chat_id: str, paths: list[str], max_bytes: int) -> dict[str, bytes]:
        self.calls.append(('get_files', {'chat_id': chat_id, 'paths': _copy(paths), 'max_bytes': max_bytes}))
        chat_id = validate_chat_id(chat_id)
        validate_get_files(paths, max_bytes)
        box = self._running(chat_id)
        found: dict[str, bytes] = {}
        for path in paths:
            # Read as the archive API reads, not as UID 1000: no permission check.
            entry = box.files.get(path)
            if entry is not None and entry.content is not None and len(entry.content) <= max_bytes:
                found[path] = entry.content
        return found

    async def stat(self, chat_id: str, path: str) -> FileStat | None:
        self.calls.append(('stat', {'chat_id': chat_id, 'path': path}))
        chat_id = validate_chat_id(chat_id)
        validate_sandbox_path(path, allow_workspace=True)
        box = self._running(chat_id)
        entry = box.files.get(path)
        if entry is None:
            return None
        # The fake has no symlinks or special files; a directory's size is 0.
        if entry.content is None:
            return FileStat(path, 'dir', entry.uid, entry.mode, 0, entry.mtime)
        return FileStat(path, 'file', entry.uid, entry.mode, len(entry.content), entry.mtime)

    async def stop(self, chat_id: str) -> None:
        self.calls.append(('stop', {'chat_id': chat_id}))
        chat_id = validate_chat_id(chat_id)
        box = self.sandboxes.get(chat_id)
        if box is not None:
            box.running = False
            box.ip = None

    async def destroy(self, chat_id: str) -> None:
        self.calls.append(('destroy', {'chat_id': chat_id}))
        chat_id = validate_chat_id(chat_id)
        self.sandboxes.pop(chat_id, None)

    async def list_sandboxes(self) -> list[SandboxInfo]:
        self.calls.append(('list_sandboxes', {}))
        # A stopped sandbox is only a volume: no container is left to carry the image label.
        return [
            SandboxInfo(
                chat_id=chat_id,
                running=box.running,
                image=box.image if box.running else None,
                ephemeral=box.ephemeral,
                # Once stopped, only the volume remains, and with it only its creation time.
                last_used=box.last_used if box.running else box.volume_created,
                ip=box.ip,
            )
            for chat_id, box in self.sandboxes.items()
        ]

    async def ready(self) -> str | None:
        self.calls.append(('ready', {}))
        return self.ready_reason


# The default exec script.

_OPERATOR_CHARS = frozenset('();<>|&')
_PRINTF_TOKEN = re.compile(r'%[%s]|\\[nt\\]')
_PRINTF_ESCAPES = {'%%': '%', r'\n': '\n', r'\t': '\t', '\\\\': '\\'}


def _not_found(name: str) -> FakeRun:
    return FakeRun(127, stderr=f'bash: line 1: {name}: command not found\n'.encode())


def _cat(args: list[str], request: FakeExecRequest, limit: int) -> FakeRun:
    if not args:
        return FakeRun(0, stdout=request.stdin or b'')
    out: list[bytes] = []
    err: list[str] = []
    for path in args:
        try:
            out.append(request.workspace.read(path))
        except OSError as exc:
            err.append(f'cat: {path}: {exc.strerror}\n')
    return FakeRun(1 if err else 0, b''.join(out), ''.join(err).encode())


def _ls(args: list[str], request: FakeExecRequest, limit: int) -> FakeRun:
    out: list[str] = []
    err: list[str] = []
    for path in args or ['.']:
        try:
            # ls prints a file's own name and lists a directory; either way every ancestor must be a searchable
            # directory, so `ls f/x` with `f` a file fails with ENOTDIR.
            _, entry = request.workspace._lookup(path, SANDBOX_UID)
            out.extend([path] if entry is not None and entry.content is not None else request.workspace.listdir(path))
        except OSError as exc:
            err.append(f"ls: cannot access '{path}': {exc.strerror}\n")
    return FakeRun(2 if err else 0, ''.join(f'{name}\n' for name in out).encode(), ''.join(err).encode())


def _printf(args: list[str], request: FakeExecRequest, limit: int) -> FakeRun:
    # Only `%s`, `%%` and the escapes `\n`, `\t`, `\\`; a missing argument is empty. As in bash, the format is
    # reused until every argument is consumed, and arguments are ignored when it has no `%s`.
    fmt, *rest = args or ['']
    values: Iterator[str] = iter(rest)
    conversions = sum(match[0] == '%s' for match in _PRINTF_TOKEN.finditer(fmt))
    rounds = max(1, -(-len(rest) // conversions)) if conversions else 1
    text = ''.join(
        _PRINTF_TOKEN.sub(lambda m: _PRINTF_ESCAPES.get(m[0]) or next(values, ''), fmt) for _ in range(rounds)
    )
    return FakeRun(0, stdout=text.encode())


def _sleep(args: list[str], request: FakeExecRequest, limit: int) -> FakeRun:
    try:
        (seconds,) = (float(arg) for arg in args)
    except ValueError:
        return FakeRun(1, stderr=b'sleep: invalid time interval\n')
    # GNU sleep refuses a negative interval and NaN (`not >=` is true for both).
    if not seconds >= 0:
        return FakeRun(1, stderr=b'sleep: invalid time interval\n')
    if seconds > limit:
        # `timeout` ends it with SIGTERM, which sleep obeys: exit 124 at the limit.
        return FakeRun(124, elapsed_s=limit)
    return FakeRun(0, elapsed_s=seconds)


_COMMANDS: dict[str, Callable[[list[str], FakeExecRequest, int], FakeRun]] = {
    'cat': _cat,
    'ls': _ls,
    'printf': _printf,
    'sleep': _sleep,
}


async def interpret(request: FakeExecRequest) -> FakeRun:
    """The default exec script: a tiny bash for `cat`, `ls`, `printf` and `sleep`.

    The argv must pass exec.require_wrapped (ValueError otherwise), and the
    command after the prefix must be `/bin/bash -lc -- <command>`, as
    exec.wrap_command builds it; the command inside is one simple command
    with an optional `> path`, run as UID 1000 in `/workspace`. `sleep`
    longer than the wrapped timeout returns 124 at the timeout, without
    waiting. Anything else (another command after the prefix, another
    command name, `;`, `&&`, pipes, unbalanced quotes) exits 127 with bash's
    "command not found". A redirect that cannot be written exits 1 with
    bash's message, as when UID 1000 writes into root-owned uploads.

    Where it differs from bash: a quoted `'>'` is still read as a redirect
    (`printf a '>' f` writes `a` to `f`), since the tokenizer does not say
    which words were quoted, and `printf` knows only `%s`, `%%`, `\\n`,
    `\\t` and `\\\\` (it does reuse its format for extra arguments, as bash
    does).
    """
    require_wrapped(request.argv, request.timeout_s)
    match request.argv[3:]:
        case ['/bin/bash', '-lc', '--', command]:
            pass
        case _:
            return _not_found(shlex.join(request.argv))
    limit = int(request.argv[2])
    lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    try:
        words = list(lexer)
    except ValueError:
        return _not_found(command)
    target = None
    if len(words) >= 3 and words[-2] == '>':
        words, target = words[:-2], words[-1]
    if not words or any(word and set(word) <= _OPERATOR_CHARS for word in words):
        return _not_found(command)
    handler = _COMMANDS.get(words[0])
    if handler is None:
        return _not_found(words[0])
    run = handler(words[1:], request, limit)
    if target is None:
        return run
    try:
        request.workspace.write(target, run.stdout)
    except OSError as exc:
        return FakeRun(1, stderr=f'bash: line 1: {target}: {exc.strerror}\n'.encode(), elapsed_s=run.elapsed_s)
    return FakeRun(run.returncode, stderr=run.stderr, elapsed_s=run.elapsed_s)
