"""The interface between the sandbox manager and whatever runs the sandboxes.

The manager (T11) is the only caller and the only code that decides what to
run; a backend carries out its calls and enforces the boundary's fixed
options (sandbox/limits.py). The one implementation so far is the in-memory
FakeBackend (sandbox/fake.py) that CI uses, since hosted runners have no
`/dev/kvm`; the Kata backend that runs each chat in its own microVM is
planned (T14). The contract below is what every backend must honour, so
tests against the fake mean something for the real one.

Every method checks its chat id with types.validate_chat_id, and the
argument rules are checked by the validators here, which every backend
calls, so backends cannot drift apart. A backend never builds container
options from model or user strings, which reach it only as `exec` argument
lists and file contents.
"""

import posixpath
from typing import Protocol, runtime_checkable

from local_llm.sandbox.limits import WORKSPACE
from local_llm.sandbox.types import ExecResult, FileStat, SandboxInfo, SandboxSpec, validate_chat_id

# The longest file name Linux filesystems accept (NAME_MAX), in bytes.
_NAME_MAX_BYTES = 255


def _check_component(name: object, what: str) -> None:
    if not isinstance(name, str):
        raise TypeError(f'{what} must be a str, not {type(name).__name__}')
    if not name or '\0' in name or '/' in name or name in ('.', '..') or len(name.encode('utf-8')) > _NAME_MAX_BYTES:
        raise ValueError(f'{what} {name!r} is not a single path component of 1 to 255 bytes without NUL')


def validate_create(chat_id: str, spec: SandboxSpec) -> None:
    """Check `create` arguments against the contract, before anything is created.

    Raises:
        ValueError: `chat_id` is not a canonical UUID (validate_chat_id), or
            `spec.chat_id` is not `chat_id`.
        TypeError: `spec` is not a SandboxSpec.
    """
    validate_chat_id(chat_id)
    if not isinstance(spec, SandboxSpec):
        raise TypeError(f'create: spec must be a SandboxSpec, not {type(spec).__name__}')
    if spec.chat_id != chat_id:
        raise ValueError(f'create: spec is for chat {spec.chat_id}, not {chat_id}')


def validate_put_files(dir: str, files: list[tuple[str, bytes, int]]) -> None:
    """Check `put_files` arguments against the contract, before anything is written.

    Raises:
        ValueError: `dir` or a name is not a single path component (empty,
            `.`, `..`, containing `/` or NUL, over 255 bytes of UTF-8), a
            name is given twice, or a mode has bits outside 0o555.
        TypeError: `files` is not a list, `dir` or a name is not a str, a
            content not bytes, or a mode not an int.
    """
    _check_component(dir, 'put_files: directory')
    if not isinstance(files, list):
        raise TypeError(f'put_files: files must be a list, not {type(files).__name__}')
    seen: set[str] = set()
    for name, content, mode in files:
        _check_component(name, 'put_files: file name')
        if name in seen:
            raise ValueError(f'put_files: file name {name!r} is given twice')
        seen.add(name)
        if not isinstance(content, bytes):
            raise TypeError(f'put_files: content of {name!r} must be bytes, not {type(content).__name__}')
        if type(mode) is not int:
            raise TypeError(f'put_files: mode of {name!r} must be an int, not {type(mode).__name__}')
        # No write bit for anyone, so UID 1000 cannot change an uploaded file, and no setuid, setgid or sticky bit.
        if mode & ~0o555:
            raise ValueError(f'put_files: mode {mode:#o} of {name!r} has bits outside 0o555')


def validate_get_files(paths: list[str], max_bytes: int) -> None:
    """Check `get_files` arguments against the contract, before anything is read.

    Raises:
        ValueError: A path breaks validate_sandbox_path's rules, or
            `max_bytes` is negative.
        TypeError: `paths` is not a list, a path is not a str, or
            `max_bytes` is not an int (a bool or a float is refused).
    """
    if not isinstance(paths, list):
        raise TypeError(f'get_files: paths must be a list, not {type(paths).__name__}')
    for path in paths:
        validate_sandbox_path(path)
    if type(max_bytes) is not int:
        raise TypeError(f'get_files: max_bytes must be an int, not {type(max_bytes).__name__}')
    if max_bytes < 0:
        raise ValueError(f'get_files: max_bytes {max_bytes} is negative')


def validate_sandbox_path(path: str, *, allow_workspace: bool = False) -> str:
    """Return `path` when it is an absolute, normalised path under `/workspace/`, else raise.

    For the paths the manager passes to a backend's `get_files` and `stat`,
    which must already be exact. It is not the check for a path a model
    supplies, which is relative, may need normalising, and must be confined
    against symlinks; the tools (T12) are to have their own confinement for
    that.

    Args:
        path: The path to check.
        allow_workspace: Accept `/workspace` itself too (for `stat`).

    Raises:
        ValueError: `path` contains NUL, is not absolute, is not
            normalised (`posixpath.normpath(path) != path`, so no `..`, `.`,
            `//` or trailing `/`), or is not under `/workspace/`.
        TypeError: `path` is not a str.
    """
    if not isinstance(path, str):
        raise TypeError(f'path must be a str, not {type(path).__name__}')
    inside = path.startswith(WORKSPACE + '/') or (allow_workspace and path == WORKSPACE)
    if '\0' in path or not path.startswith('/') or posixpath.normpath(path) != path or not inside:
        raise ValueError(f'path {path!r} is not an absolute, normalised path under {WORKSPACE}/')
    return path


@runtime_checkable
class SandboxBackend(Protocol):
    """Runs one sandbox per chat: a container with the chat's volume at `/workspace`.

    Every method raises ValueError for a chat id that is not a canonical
    UUID (types.validate_chat_id), before it does anything else.
    """

    async def create(self, chat_id: str, spec: SandboxSpec) -> None:
        """Start the chat's sandbox, or keep the one already running.

        The arguments must pass validate_create, checked first.

        Idempotent: a running container for the chat with the same image is
        reused as it is. One with a different image is removed and a new one
        started on the same volume, so files carry over. A chat whose
        sandbox was stopped gets a new container on its kept volume. The
        volume (`spec.volume`) is a fixed-size filesystem of
        limits.WORKSPACE_SIZE, so a runaway write fills it and not the
        host's disk.

        The backend records the spec's image and ephemeral flag as labels
        (`lllm.image` on the container; `lllm.ephemeral=1` on the container
        and the volume when the flag is set, with `lllm.chat` on both) and
        reports them back through list_sandboxes. Labels cannot change
        after creation, so the volume keeps the ephemeral flag of the spec
        that created it, whatever a later create's spec says.

        Raises:
            ValueError, TypeError: The arguments break validate_create's
                rules (`spec` not a SandboxSpec, `spec.chat_id` not `chat_id`).
            SandboxUnavailable: The backend cannot run sandboxes (see `ready`).
        """
        ...

    async def exec(self, chat_id: str, argv: list[str], timeout_s: int, stdin: bytes | None = None) -> ExecResult:
        """Run one command as UID 1000 in `/workspace`, its output capped, and return how it ended.

        `timeout_s` must already be within TIMEOUT_MIN_S..TIMEOUT_MAX_S, and
        `argv` must pass exec.require_wrapped for it, checked first: the
        caller clamps once with exec.clamp_timeout and passes that value to
        both exec.wrap_command (or wrap_argv) and here, so the guest's
        `timeout` enforces exactly `timeout_s`. `argv` is passed as it is,
        never through a shell on the host. The backend also keeps a
        host-side deadline of `timeout_s + HOST_DEADLINE_SLACK_S`, and ends
        the exec itself if it fires. Output is collected through
        exec.StreamCap as it arrives and the result built by
        exec.result_from, with `deadline_hit` set when the deadline fired.

        Every ending the command causes is returned as an ExecResult: a
        non-zero exit, a signal, the guest's OOM killer, `timeout`, the
        host-side deadline. SandboxError (or a subclass) is raised only when
        the sandbox itself failed: the container is gone, the VM died, the
        daemon is unreachable, or the exec could not be created. A sandbox
        that died during the command is a failure, not a result, whatever
        return code the exec reported: the post-exec kill below, or a check
        that the container is still running, reveals it, and the backend
        raises SandboxNotRunning. So a 137 from the guest's OOM killer is a
        result, and a 137 from a dead VM is not.

        After every exec, whatever its ending, the backend kills every UID
        1000 process in the sandbox (an exec as `1000:1000` running
        `kill -9 -1`), so nothing the command started runs between calls
        (owner decision Q10). Backgrounded children survive `timeout`, and
        root in the guest cannot kill them, since it has no CAP_KILL (T02).

        Raises:
            ValueError: `timeout_s` is outside TIMEOUT_MIN_S..TIMEOUT_MAX_S,
                or `argv` fails require_wrapped.
            TypeError: `timeout_s` is not an int, or an `argv` element is
                not a str.
            SandboxNotRunning: The chat has no running sandbox, or it died
                during the command.
            SandboxError: The sandbox could not run the command.
        """
        ...

    async def put_files(self, chat_id: str, dir: str, files: list[tuple[str, bytes, int]]) -> None:
        """Make `/workspace/<dir>` a root-owned directory holding exactly `files`, so UID 1000 cannot change them.

        `dir` is a single path component directly under `/workspace` (such
        as `uploads`), not a path. Afterwards `/workspace/<dir>` is a
        directory owned by root with mode 0o555 that contains the given
        files and nothing else. Whatever had that name before is replaced,
        never followed: a symlink, a file, or a directory (with everything
        in it, including files UID 1000 planted there). Each file is
        `(name, content, mode)`, written owned by root with `mode` and the
        time of the put as its mtime.

        The Kata backend (T14) must guarantee this with Docker's untar: it
        replaces an existing file or symlink, but merges a directory entry
        into an existing directory, so the archive has to remove the old
        entry first (T14 is to verify how).

        Raises:
            ValueError, TypeError: The arguments break validate_put_files's
                rules (`files` not a list, a name or `dir` not a single
                component, a name given twice, a mode with bits outside
                0o555).
            SandboxNotRunning: The chat has no running sandbox.
        """
        ...

    async def get_files(self, chat_id: str, paths: list[str], max_bytes: int) -> dict[str, bytes]:
        """Read regular files from the sandbox, keyed by the path as given.

        The arguments must pass validate_get_files: each path absolute,
        normalised and under `/workspace/`, and `max_bytes` an int that is
        not negative. Only regular files are returned: a directory, a
        symlink (a final-component symlink included), a missing path or a
        file over `max_bytes` bytes is omitted, never truncated, so the
        caller tells them by their absence. The Kata backend (T14) must
        check the daemon's stat of the path before it reads the body, so an
        omitted file is never streamed.

        Raises:
            ValueError, TypeError: The arguments break validate_get_files's
                rules.
            SandboxNotRunning: The chat has no running sandbox.
        """
        ...

    async def stat(self, chat_id: str, path: str) -> FileStat | None:
        """The daemon's view of one path, which sandboxed code cannot forge; None when it does not exist.

        For checks that must not trust the guest, such as the owner and
        mode of `/workspace/uploads` before each upload sync (T13) and the
        outputs (T17). A symlink is reported as a symlink, not followed.
        `path` must pass validate_sandbox_path with `/workspace` itself
        allowed.

        Raises:
            ValueError: `path` breaks the rules.
            SandboxNotRunning: The chat has no running sandbox.
        """
        ...

    async def stop(self, chat_id: str) -> None:
        """Remove the chat's container and keep its volume. A no-op when nothing is running."""
        ...

    async def destroy(self, chat_id: str) -> None:
        """Remove the chat's container and its volume, and so its files. A no-op when neither exists."""
        ...

    async def list_sandboxes(self) -> list[SandboxInfo]:
        """Every chat that has a sandbox container or volume, running or not, for the startup and retention sweeps.

        Each SandboxInfo carries what `create` recorded as labels: the
        container's image (None once only the volume is left) and the
        ephemeral flag (from the volume too, so it is known while stopped).
        """
        ...

    async def ready(self) -> str | None:
        """Whether the backend can run sandboxes: None when it can, else the reason it cannot."""
        ...
