"""The values that cross the sandbox backend interface, and its errors.

The manager (T11) talks to a backend (sandbox/backend.py) only in these
types, so a later backend (Firecracker, say) can replace the planned Kata one
(T14) without touching the tools, the call sites or the tests above the
interface.

No caller string may reach a Docker option: a chat id is accepted only as a
canonical UUID, an image only as an ImageKey, the ephemeral flag only as a
bool, the volume name is derived from the chat id, and labels cannot use the
`lllm.` prefix the backend sets itself. SandboxSpec checks all of it when it
is built, so a spec that exists is one a backend can use as it is.
"""

import datetime as dt
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Literal, get_args

from pydantic import BaseModel, ConfigDict

#: The images a sandbox can run: `data` (scipy-notebook based, the default)
#: or `web` (Node.js based). Validated before it reaches a backend.
ImageKey = Literal['data', 'web']

#: The label prefix the backend keeps for itself (`lllm.chat`, `lllm.image`, `lllm.ephemeral`).
RESERVED_LABEL_PREFIX = 'lllm.'


def validate_chat_id(chat_id: str) -> str:
    """Return `chat_id` as a plain str when it is a canonical UUID string (lowercase, hyphenated), else raise.

    The manager keys every sandbox by a UUID it controls (owner decision
    Q5), and the backend puts the id in container, volume and label names,
    so anything else is refused, not normalised. The value returned is
    `str(uuid.UUID(chat_id))`, always a plain str, so a str subclass that
    compares equal but formats differently goes no further than this check.

    Raises:
        ValueError: `chat_id` is not a str, or not `str(uuid.UUID(chat_id))`.
    """
    if isinstance(chat_id, str):
        try:
            canonical = str(uuid.UUID(chat_id))
        except ValueError:
            pass
        else:
            if canonical == chat_id:
                return canonical
    raise ValueError(f'chat id {chat_id!r} is not a canonical lowercase UUID')


def volume_name(chat_id: str) -> str:
    """The name of the chat's `/workspace` volume, `lllm-sandbox-<chat id>`.

    Raises:
        ValueError: `chat_id` is not a canonical UUID (validate_chat_id).
    """
    return f'lllm-sandbox-{validate_chat_id(chat_id)}'


class SandboxError(Exception):
    """A sandbox operation that could not be carried out."""


class SandboxNotRunning(SandboxError):
    """The chat has no running sandbox: it was never created, or it was stopped or destroyed."""


class SandboxUnavailable(SandboxError):
    """The backend cannot run sandboxes at all (no Docker, no Kata runtime); the message says why."""


def _check_label(text: object, what: str) -> None:
    # `type(...) is str`, not isinstance: a str subclass could format differently from what was checked.
    if type(text) is not str or not text or '\0' in text:
        raise ValueError(f'SandboxSpec: label {what} {text!r} is not a non-empty string without NUL')


@dataclass(frozen=True)
class SandboxSpec:
    """What to create for one chat. Built only by the manager, from validated values, never from model strings.

    Every field is checked when the spec is built, so a backend can pass it
    to Docker as it is. The labels are left out of the hash, since a
    read-only mapping is not hashable; equality still compares them.

    Attributes:
        chat_id: The chat the sandbox belongs to, a canonical UUID
            (validate_chat_id), stored as a plain str.
        image: Which image to run, one of ImageKey's values.
        labels: Extra container and volume labels. Keys and values are
            non-empty strings (exactly str, not a subclass) without NUL, and
            no key starts with `lllm.`, which the backend keeps for
            `lllm.chat`, `lllm.image` and `lllm.ephemeral`. Copied into a
            read-only mapping, so a spec cannot change after it is built.
        ephemeral: The sandbox belongs to a chat that is not saved (owner
            decision Q5), so the manager (T11) is to destroy its volume
            whenever its container stops. The backend records it as the label
            `lllm.ephemeral=1` and reports it back in SandboxInfo.ephemeral.

    Raises:
        ValueError: `chat_id`, `image` or a label breaks the rules above.
        TypeError: `ephemeral` is not a bool, or a field the spec does not
            have is given (`volume` among them: it is derived, never given).
    """

    chat_id: str
    image: ImageKey
    labels: Mapping[str, str] = field(default_factory=dict, hash=False)
    ephemeral: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, 'chat_id', validate_chat_id(self.chat_id))
        # Literal is not enforced at runtime; `type(...) is str` keeps out a
        # str subclass that compares equal to a key but formats differently.
        if type(self.image) is not str or self.image not in get_args(ImageKey):
            raise ValueError(f'SandboxSpec: image {self.image!r} is not one of {get_args(ImageKey)}')
        labels = dict(self.labels)
        for key, value in labels.items():
            _check_label(key, 'key')
            _check_label(value, 'value')
            if key.startswith(RESERVED_LABEL_PREFIX):
                raise ValueError(f'SandboxSpec: label key {key!r} uses the reserved prefix {RESERVED_LABEL_PREFIX!r}')
        object.__setattr__(self, 'labels', MappingProxyType(labels))
        if type(self.ephemeral) is not bool:
            raise TypeError(f'SandboxSpec: ephemeral must be a bool, not {type(self.ephemeral).__name__}')

    @property
    def volume(self) -> str:
        """The name of the volume mounted at `/workspace`, derived from the chat id, never chosen by a caller."""
        return volume_name(self.chat_id)


class ExecResult(BaseModel):
    """The outcome of one command, with each stream already capped (sandbox/exec.py)."""

    model_config = ConfigDict(frozen=True)

    returncode: int
    stdout: str
    stderr: str
    #: The command was ended by `timeout` (see exec.result_from for the rule).
    timed_out: bool
    #: Either stream lost characters to the cap.
    truncated: bool
    duration_ms: int


@dataclass(frozen=True)
class FileEntry:
    """One file in a sandbox directory listing.

    Attributes:
        path: Relative to the directory that was listed.
        size: Size in bytes.
        mtime: Modification time, in seconds since the epoch.
    """

    path: str
    size: int
    mtime: float


@dataclass(frozen=True)
class SandboxInfo:
    """One chat's sandbox as the backend sees it: a container, a volume, or both.

    Attributes:
        chat_id: The chat it belongs to.
        running: Whether its container is running.
        image: The image of its container (the `lllm.image` label); None
            when only a volume exists.
        ephemeral: Whether it was created from a spec with `ephemeral` set
            (the `lllm.ephemeral` label), reported whether or not it is
            running, so the sweeps can tell an unsaved chat's sandbox from a
            saved chat's.
        last_used: While running, when the backend last started its
            container; once stopped, when its volume was created; None when
            unknown. A backend cannot change labels after creation, so
            running a command, or putting, reading or stat-ing files, does
            not move it.
        ip: Its address on the sandbox network while running, else None.
    """

    chat_id: str
    running: bool
    image: ImageKey | None
    ephemeral: bool
    last_used: dt.datetime | None
    ip: str | None


@dataclass(frozen=True)
class FileStat:
    """One path in a sandbox as the daemon sees it, which sandboxed code cannot forge.

    Attributes:
        path: The path asked about, absolute.
        kind: A regular file, a directory, a symlink (never followed), or
            anything else (a socket, a FIFO, a device).
        uid: The owner's UID.
        mode: The permission bits, setuid, setgid and sticky included
            (`st_mode & 0o7777`), without the file type.
        size: Size in bytes; for a directory, whatever its filesystem reports.
        mtime: Modification time, in seconds since the epoch.
    """

    path: str
    kind: Literal['file', 'dir', 'symlink', 'other']
    uid: int
    mode: int
    size: int
    mtime: float
