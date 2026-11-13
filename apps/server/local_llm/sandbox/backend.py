"""The interface between the sandbox manager and whatever runs the sandboxes.

The manager (T11) is the only caller and the only code that decides what to
run; a backend carries out its calls and enforces the boundary's fixed
options (sandbox/limits.py). There are two: the Kata backend
(sandbox/kata.py), which runs each chat in its own microVM, and the
in-memory FakeBackend (sandbox/fake.py) that CI uses, since hosted runners
have no `/dev/kvm`. The contract below is what every backend must honour, so
tests against the fake mean something for the real one.

Every method checks its chat id with types.validate_chat_id, and the
argument rules are checked by the validators here, which every backend
calls, so backends cannot drift apart. A backend never builds container
options from model or user strings, which reach it only as `exec` argument
lists and file contents.
"""

import posixpath
from typing import Protocol, runtime_checkable

from local_llm.sandbox.limits import LIST_MAX_ENTRIES, MIRROR_LOG_MAX_BYTES, WORKSPACE
from local_llm.sandbox.types import (
    ExecResult,
    FileStat,
    MirrorLine,
    SandboxInfo,
    SandboxSpec,
    WorkspaceListing,
    validate_chat_id,
)

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


def validate_put_uploads(files: list[tuple[str, bytes]]) -> None:
    """Check `put_uploads` arguments against the contract, before anything is written.

    Raises:
        ValueError: A name is not a single path component (empty, `.`, `..`,
            containing `/` or NUL, over 255 bytes of UTF-8), or is given twice.
        TypeError: `files` is not a list, a name is not a str, or a content
            not bytes.
    """
    if not isinstance(files, list):
        raise TypeError(f'put_uploads: files must be a list, not {type(files).__name__}')
    seen: set[str] = set()
    for name, content in files:
        _check_component(name, 'put_uploads: file name')
        if name in seen:
            raise ValueError(f'put_uploads: file name {name!r} is given twice')
        seen.add(name)
        if not isinstance(content, bytes):
            raise TypeError(f'put_uploads: content of {name!r} must be bytes, not {type(content).__name__}')


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


def validate_list_workspace(max_entries: int) -> None:
    """Check `list_workspace`'s `max_entries` against the contract, before anything is listed.

    Raises:
        TypeError: `max_entries` is not an int (a bool is refused).
        ValueError: `max_entries` is outside 1..LIST_MAX_ENTRIES.
    """
    if type(max_entries) is not int:
        raise TypeError(f'list_workspace: max_entries must be an int, not {type(max_entries).__name__}')
    if not 1 <= max_entries <= LIST_MAX_ENTRIES:
        raise ValueError(f'list_workspace: max_entries {max_entries} is outside 1..{LIST_MAX_ENTRIES}')


def validate_mirror_log(since_ns: int, max_bytes: int) -> None:
    """Check `mirror_log` arguments against the contract, before the log is read.

    Raises:
        TypeError: Either is not an int (a bool is refused).
        ValueError: `since_ns` is negative, or `max_bytes` is outside 1..MIRROR_LOG_MAX_BYTES.
    """
    for name, value in (('since_ns', since_ns), ('max_bytes', max_bytes)):
        if type(value) is not int:
            raise TypeError(f'mirror_log: {name} must be an int, not {type(value).__name__}')
    if since_ns < 0:
        raise ValueError(f'mirror_log: since_ns {since_ns} is negative')
    if not 1 <= max_bytes <= MIRROR_LOG_MAX_BYTES:
        raise ValueError(f'mirror_log: max_bytes {max_bytes} is outside 1..{MIRROR_LOG_MAX_BYTES}')


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
        The file tools depend on it (sandbox/workspace.py: a path resolved
        in one exec is used in the next call, which nothing may change in
        between), so (T12's security review, B1 and S2):

        - The kill waits until no UID 1000 process remains (`kill -9 -1`
          returns once the signals are queued, so it checks that no
          `/proc/<pid>/status` names UID 1000, zombies included; `kill -0
          -1` cannot tell, since it succeeds whenever any process is
          visible, even one it may not signal). That check is a separate
          command run as a user UID 1000 can neither trace nor signal
          (`nobody`), since a surviving UID 1000 process can trace the
          kill and fake its exit status, and it must hold against a
          process that keeps changing its PID (fork, parent exits), which
          a snapshot of /proc never lists: the Kata backend counts a pass
          only when no PID was allocated while it ran. It fails closed: when it cannot
          confirm that (a kill or check cannot be created or start, as
          under a fork bomb holding UID 1000 at its nproc limit, the check
          finds a process left, or either times out), the backend stops
          the sandbox and raises SandboxNotRunning,
          whose message is fixed text free of host details. The manager
          then treats the sandbox as stopped behind its back and cleans it
          up.
        - If the coroutine awaiting `exec` is cancelled, the backend ends
          the command by running the kill at once, then re-raises
          CancelledError; it neither returns nor raises until that kill has
          completed. A backend whose Docker call runs in a thread
          (`asyncio.to_thread` goes on after its awaiter is cancelled) must
          therefore catch the cancellation, run the kill, wait for the
          thread, and only then re-raise. That wait is bounded (R2): when
          the command and its streams have not ended within the kill's own
          timeout, well inside limits.CANCEL_WAIT_S, it is a failed kill:
          stop the sandbox and raise SandboxNotRunning. The manager waits
          for a cancelled call at most CANCEL_WAIT_S in any case, and then
          stops the sandbox itself before the chat's lock is released.

        Every error from the Docker SDK or the runtime is raised as a
        SandboxError with fixed wording, never the SDK's own text, which
        carries the daemon URL and host paths; SandboxError.public is left
        None unless the text was written for the model.

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

        The Kata backend does this with Docker's untar, which replaces an
        existing file or symlink but merges a directory entry into an
        existing directory: its archive names the directory first as an
        empty regular file, which removes whatever was there, then as the
        directory, then the files (kata.put_archive_bytes).

        Raises:
            ValueError, TypeError: The arguments break validate_put_files's
                rules (`files` not a list, a name or `dir` not a single
                component, a name given twice, a mode with bits outside
                0o555).
            SandboxNotRunning: The chat has no running sandbox.
        """
        ...

    async def put_uploads(self, chat_id: str, files: list[tuple[str, bytes]]) -> None:
        """Make the chat's uploads, `/workspace/uploads` in the guest, hold exactly `files`, read-only to the guest.

        `/workspace/uploads` is a read-only mount of a directory the backend
        keeps outside the workspace volume, made when the sandbox is created,
        so nothing in the guest can write, rename, remove or chmod it or its
        files, whatever the user and whatever is mounted over the workspace
        (the put_files design let UID 1000 rename `uploads` aside without
        end, each rename forcing a re-put and leaving a copy it could not
        delete, until the workspace was full; T13's security review). Each
        file is `(name, content)`, a single path component, and is written
        mode 0o444; files already there with the same content are kept as
        they are, others replaced one by one (each atomically, so a command
        never sees half a file), and files not in `files` removed. It
        returns once the guest sees exactly that set.

        Raises:
            ValueError, TypeError: The arguments break validate_put_uploads's
                rules (`files` not a list, a name not a single component or
                given twice, a content not bytes).
            SandboxNotRunning: The chat has no running sandbox.
            SandboxError: The files could not be written, or the guest did
                not come to see them in time.
        """
        ...

    async def get_files(self, chat_id: str, paths: list[str], max_bytes: int) -> dict[str, bytes]:
        """Read regular files from the sandbox, keyed by the path as given.

        The arguments must pass validate_get_files: each path absolute,
        normalised and under `/workspace/`, and `max_bytes` an int that is
        not negative. Only regular files are returned: a directory, a
        symlink (a final-component symlink included), a missing path or a
        file over `max_bytes` bytes is omitted, never truncated, so the
        caller tells them by their absence. The Kata backend checks the
        daemon's stat of the path before it reads the body, so an omitted
        file is never streamed.

        Raises:
            ValueError, TypeError: The arguments break validate_get_files's
                rules.
            SandboxNotRunning: The chat has no running sandbox.
        """
        ...

    async def stat(self, chat_id: str, path: str) -> FileStat | None:
        """The daemon's view of one path, which sandboxed code cannot forge; None when it does not exist.

        For checks that must not trust the guest, such as the outputs
        (T17). A symlink is reported as a symlink, not followed, and a FIFO,
        a socket or a device as `other`, never `file`: the file tools read
        only `file`, and opening a FIFO would block.
        `path` must pass validate_sandbox_path with `/workspace` itself
        allowed.

        Raises:
            ValueError: `path` breaks the rules.
            SandboxNotRunning: The chat has no running sandbox.
        """
        ...

    async def list_workspace(self, chat_id: str, max_entries: int) -> WorkspaceListing | None:
        """The regular files on the chat's workspace volume, whether or not its sandbox runs; None when it has none.

        For the workspace deletion dialog (T24), which shows a stopped
        workspace's contents before the user decides. It never starts the
        chat's sandbox and runs nothing from the workspace: the Kata backend
        lists the volume from a short-lived helper container of fixed
        options (the volume mounted read-only, no network, UID 1000, a fixed
        script), and nothing a caller or the model chose reaches those
        options. Symlinks are not followed and not listed; a directory UID
        1000 may not search is skipped, and the listing marked incomplete.
        At most `max_entries` files are listed, and `files` and `bytes`
        count them all (WorkspaceListing).

        Raises:
            ValueError, TypeError: `max_entries` breaks
                validate_list_workspace's rules.
            SandboxError: The volume could not be listed.
        """
        ...

    async def remove_helpers(self) -> None:
        """Remove every short-lived helper (list_workspace's) a previous process left behind; for the startup sweep.

        A helper mounts its workspace's volume, so one left behind would keep
        the volume from being destroyed. `stop` and `destroy` remove the
        key's own helper too.

        Raises:
            SandboxError: The helpers could not be listed or removed.
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

    async def mirror_log(self, since_ns: int, max_bytes: int) -> list[MirrorLine]:
        """The pip mirror's access log lines recorded after `since_ns`, oldest first, for the package telemetry (T21).

        The arguments must pass validate_mirror_log. Only lines the daemon
        recorded strictly after `since_ns` (nanoseconds since the epoch) are
        returned, each with its own time, so a caller that passes the last
        line's `at_ns` next time reads every line once. At most `max_bytes`
        bytes of lines are returned: the read stops before the line that
        would pass it, which the next read returns (a single line longer
        than `max_bytes` is returned cut to it, so the cursor still moves).
        The log is the mirror's own (its JSON access log on stdout); what is
        in a line is the sandboxes' choice, so the caller parses it as
        hostile text.

        Raises:
            ValueError, TypeError: The arguments break validate_mirror_log's rules.
            SandboxError: The mirror's log could not be read (the mirror is not there, the daemon failed).
        """
        ...

    async def ready(self) -> str | None:
        """Whether the backend can run sandboxes: None when it can, else the reason it cannot."""
        ...
