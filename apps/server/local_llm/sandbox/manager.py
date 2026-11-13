"""The sandbox manager: which chat gets which sandbox, when it runs, and when it goes.

The backend (sandbox/backend.py) runs one sandbox per key and decides
nothing; the manager is the only code that calls it, and it decides
everything around it: whether a chat may have a sandbox at all, which key
the backend sees, how many run at once, one command at a time per chat, and
when an idle or abandoned sandbox is stopped or its volume destroyed
(docs/proposals/sandbox-code-interpreter.md, "Lifecycle").

Keys. The backend only ever sees a key, a canonical UUID, never a raw chat
id. A caller without a non-empty str user id is refused. A saved chat's key
is its own id, after the chat is checked to exist and the caller to be its
owner, or an admin the chat completion endpoint lets into other users'
chats (owner decision Q14; ChatLookup.usable); its sandbox is persistent,
and its volume outlives the container. An unsaved chat (an id of at most
MAX_UNSAVED_CHAT_ID_LEN characters starting with one of
NON_SAVED_CHAT_ID_PREFIXES, such as the harness's
`temporary:benchmark-<uuid>`) gets an ephemeral sandbox (owner decision Q5):
keyed by a UUID the manager generates and keeps in memory, destroyed with
its volume whenever it stops, and never kept across a restart. The memory
map is keyed by the chat id and the caller's user id together (owner
decision Q12), so each user of a shared `channel:` chat gets a sandbox of
their own, and another user's `temporary:` id leads to a new sandbox, not
theirs. A mapping is dropped once its sandbox is confirmed destroyed, or
when a session on it fails before the sandbox ran and nobody else is on it;
a release whose destroy fails keeps it, so a later release can retry.
Anything else is refused with SandboxRefused before the backend is called.
A background sub-agent uses its parent chat's sandbox (owner decision Q6):
callers pass the parent chat's id, and the per-chat lock serializes the
two.

Slots. At most `max_running` sandboxes run at once across all chats. A slot
is taken when a sandbox starts and freed only once a stop or destroy has
confirmed it gone; a session whose sandbox already runs needs none. A
tracked sandbox is marked in doubt before every stop or destroy, and when a
create fails or is cancelled, or the sandbox is reported not running
mid-session, since a container may still exist: it keeps its slot until a
cleanup (stop, or destroy if ephemeral) succeeds, the idle reaper retries
it on its next pass, eviction passes it over, and the next session on it
creates it again on that slot. When no slot is free, a session stops the
least recently used sandbox nobody is using that has been idle for
`evict_idle_s` and takes its slot (owner decision Q13), trying the next one
when a stop fails, or else waits, for at most `slot_wait_timeout_s`. Each
session reads the settings once, on entry, so an admin change applies to
the next session; one that finds more sandboxes running than a lowered
`max_running` evicts as many as it takes to get a slot.

Last use. The idle reaper uses an in-memory record of each running
sandbox's last call, which covers every running sandbox, since the startup
sweep stops whatever a previous process left running. The retention sweep
uses the chat row's `updated_at` instead: every call happens inside a chat
that is being updated, it survives restarts, and it needs no new table.
Ephemeral sandboxes need neither.

The instance lives on `app.state.sandbox`, created in main.py's lifespan
with the Kata backend (sandbox/lifespan.py), which runs `startup_sweep()`
before the first session and the maintenance loop beside the app, and
closed in its shutdown.
"""

import asyncio
import logging
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field, fields
from typing import TYPE_CHECKING, Any, Final, Protocol, get_args

from local_llm.sandbox.backend import SandboxBackend
from local_llm.sandbox.limits import CANCEL_WAIT_S, TIMEOUT_MAX_S, TIMEOUT_MIN_S
from local_llm.sandbox.types import (
    ExecResult,
    FileStat,
    ImageKey,
    SandboxError,
    SandboxInfo,
    SandboxNotRunning,
    SandboxSpec,
    validate_chat_id,
)
from local_llm.sandbox.uploads import SyncedUploads

if TYPE_CHECKING:
    from local_llm.sandbox.outputs import Listing
from local_llm.utils.chat_id import NON_SAVED_CHAT_ID_PREFIXES

log = logging.getLogger(__name__)

# Inclusive bounds of the integer settings; None is unbounded.
_BOUNDS: Final[dict[str, tuple[int, int | None]]] = {
    'max_running': (1, 16),
    'idle_minutes': (1, None),
    'retention_days': (1, None),
}

#: Seconds ready() waits for the backend, so a hung Docker daemon cannot leave the admin page waiting.
READY_TIMEOUT_S: Final = 5.0

_SECONDS_PER_DAY: Final = 86_400

# What the model is told when a session meets a manager that has shut down.
_SHUT_DOWN: Final = 'the sandbox service is shutting down; try again once the server has restarted'

#: Seconds a running sandbox must have been idle before a session that finds no free slot may stop it (Q13).
EVICT_IDLE_S: Final = 60.0
#: Seconds a session waits for a slot before it gives up with SandboxError (Q13).
SLOT_WAIT_TIMEOUT_S: Final = 120.0
#: The longest unsaved chat id given a sandbox, so callers cannot fill the in-memory map with huge keys.
MAX_UNSAVED_CHAT_ID_LEN: Final = 200

# Seconds between a waiting session's eviction attempts when no slot is freed meanwhile.
_SLOT_RETRY_S: Final = 5.0


def _setting_error(name: str, value: object) -> str | None:
    """Why `value` cannot be the setting `name`, or None when it can."""
    if name == 'default_image':
        if type(value) is str and value in get_args(ImageKey):
            return None
        return f'{value!r} is not one of {get_args(ImageKey)}'
    low, high = _BOUNDS[name]
    # `type(...) is int` keeps out a bool, which is an int too.
    if type(value) is int and value >= low and (high is None or value <= high):
        return None
    return f'{value!r} is not an int from {low} to {"any" if high is None else high}'


@dataclass(frozen=True)
class SandboxSettings:
    """The admin-changeable sandbox settings, read afresh for every operation.

    Attributes:
        default_image: The image a chat's sandbox starts with when a call names none.
        max_running: How many sandboxes may run at once, 1 to 16.
        idle_minutes: Minutes since its last call after which a running sandbox is stopped, at least 1.
        retention_days: Days since its chat was last updated after which a stopped saved chat's volume is
            destroyed, at least 1.

    Raises:
        ValueError: A field is outside the bounds above, or of the wrong type.
    """

    default_image: ImageKey = 'data'
    max_running: int = 4
    idle_minutes: int = 30
    retention_days: int = 7

    def __post_init__(self) -> None:
        for f in fields(self):
            error = _setting_error(f.name, getattr(self, f.name))
            if error is not None:
                raise ValueError(f'SandboxSettings.{f.name}: {error}')


#: The command timeout's config key: bounded by limits.TIMEOUT_MIN_S..TIMEOUT_MAX_S, not a SandboxSettings field.
TIMEOUT_KEY: Final = 'code_interpreter.sandbox.timeout'

#: Config key -> SandboxSettings field, the keys T19 registers.
SETTING_KEYS: Final = {
    'code_interpreter.sandbox.default_image': 'default_image',
    'code_interpreter.sandbox.max_running': 'max_running',
    'code_interpreter.sandbox.idle_minutes': 'idle_minutes',
    'code_interpreter.sandbox.retention_days': 'retention_days',
}


def sandbox_setting_error(key: str, value: object) -> str | None:
    """Why `value` cannot be the config setting `key`, or None when it can; None (unset) is always fine.

    Covers every `code_interpreter.sandbox.*` key: the ones in SETTING_KEYS by the manager's own rules, and the
    command timeout by the limits' bounds. The admin form and the config import both use it.
    """
    if value is None:
        return None
    if key == TIMEOUT_KEY:
        if type(value) is int and TIMEOUT_MIN_S <= value <= TIMEOUT_MAX_S:
            return None
        return f'{value!r} is not an int from {TIMEOUT_MIN_S} to {TIMEOUT_MAX_S}'
    return _setting_error(SETTING_KEYS[key], value)


async def settings_from_config() -> SandboxSettings:
    """The settings from config, with one Config.get_many; never raises.

    A key config does not return (Config.get_many omits keys that are not
    registered) or whose value is None keeps the field's default. A value
    that breaks the field's rules keeps the default too, with a warning. If
    config cannot be read at all, every field keeps its default, and the
    error is logged.
    """
    # Imported here, not at the top, so importing the sandbox package does not load the app's environment.
    from local_llm.models.config import Config

    try:
        values = await Config.get_many(*SETTING_KEYS)
    except Exception:
        log.exception('could not read the sandbox settings; using the defaults')
        return SandboxSettings()
    chosen: dict[str, Any] = {}
    for key, name in SETTING_KEYS.items():
        value = values.get(key)
        if value is None:
            continue
        error = _setting_error(name, value)
        if error is None:
            chosen[name] = value
        else:
            log.warning('ignoring the sandbox setting %s: %s; using the default', key, error)
    return SandboxSettings(**chosen)


class ChatLookup(Protocol):
    """What the manager needs to know about chats, so tests can stand in for the database."""

    async def usable(self, chat_id: str, user: Any) -> bool:
        """Whether `chat_id` is a saved chat `user` may run code in (owner decision Q14).

        `user` has a non-empty str `id`; the manager refuses any other
        before asking.
        """
        ...

    async def updated_at(self, chat_ids: list[str]) -> dict[str, int]:
        """When each chat was last updated, in epoch seconds; a chat that does not exist is left out.

        Implementations must raise on any error, never return a partial
        result: the retention sweep destroys the volume of a chat left out.
        """
        ...


class DatabaseChats:
    """The ChatLookup on the app's database."""

    async def usable(self, chat_id: str, user: Any) -> bool:
        """Whether `user` may run code in the saved chat `chat_id`: its owner, or an admin as the chat endpoint allows.

        The rule is the chat completion endpoint's for posting into an
        existing chat (main.py's `_persist_follow_up`, with
        `_admin_reaches_other_chats`): the owner, or an admin while
        ENABLE_ADMIN_CHAT_ACCESS is on. It is mirrored here rather than
        imported, since importing main.py builds the whole app; change both
        together. Unlike the endpoint, the chat must exist for an admin too,
        so no sandbox is keyed to a chat with no row. Folder readers and
        other readers are not let in (Q14): reading a chat is not running
        code in it. A database error refuses, as `Chats.is_chat_owner`
        does, and is logged.
        """
        from local_llm import env
        from local_llm.models.chats import Chats

        if await Chats.is_chat_owner(chat_id, user.id):
            return True
        # main.py's _admin_reaches_other_chats.
        if getattr(user, 'role', None) == 'admin' and env.ENABLE_ADMIN_CHAT_ACCESS:
            try:
                return chat_id in await self.updated_at([chat_id])
            except Exception:
                log.exception('could not look chat %s up for an admin; refusing its sandbox', chat_id)
        return False

    async def updated_at(self, chat_ids: list[str]) -> dict[str, int]:
        """Each existing chat's `updated_at`, in one query; a database error is raised, never a partial result.

        A row with no `updated_at` falls back to its `created_at`, and one
        with neither counts as updated now: a chat that exists never loses
        its volume to a missing timestamp.
        """
        if not chat_ids:
            return {}
        from sqlalchemy import select

        from local_llm.internal.db import get_async_db_context
        from local_llm.models.chats import Chat

        async with get_async_db_context() as db:
            result = await db.execute(select(Chat.id, Chat.updated_at, Chat.created_at).where(Chat.id.in_(chat_ids)))
            rows = result.all()
        now = int(time.time())
        return {
            chat_id: int(updated if updated is not None else created if created is not None else now)
            for chat_id, updated, created in rows
        }


@dataclass
class OutputsMemory:
    """What the `bash` tool keeps about one running sandbox's /workspace/outputs between calls (sandbox/outputs.py).

    Attributes:
        listing: The listing the last call took after its command; the next
            compares with it, so files other tools wrote in between count as
            new. None until a call keeps one, and while a call runs.
        stored: By sandbox path, the SHA-256 and file id of the last File row
            stored for it, so a file whose bytes did not change is not stored
            and attached again.
    """

    listing: 'Listing | None' = None
    stored: dict[str, tuple[str, str]] = field(default_factory=dict)


class SandboxRefused(SandboxError):
    """A chat id the manager will not give a sandbox; raised before the backend is called.

    The id is empty or not a str, the user has no non-empty str `id`, an
    unsaved chat's id is longer than MAX_UNSAVED_CHAT_ID_LEN, or a saved
    chat's id is not a canonical UUID, names no chat, or names one the user
    may not run code in (ChatLookup.usable).
    """


class SandboxSession:
    """One chat's sandbox, handed out by SandboxManager.session and valid only inside its block.

    Each method calls the backend with the session's key and returns, or
    raises, what the backend does, unchanged. After the block has exited,
    every method raises SandboxError.

    Attributes:
        key: The UUID the backend knows the sandbox by.
    """

    def __init__(
        self,
        backend: SandboxBackend,
        key: str,
        *,
        cancel_wait_s: float = CANCEL_WAIT_S,
        uploads: dict[str, SyncedUploads] | None = None,
        outputs: dict[str, OutputsMemory] | None = None,
    ) -> None:
        """Open a session on `key`; only the manager makes one, passing its per-key records `uploads` and `outputs`."""
        self.key = key
        self._backend = backend
        self._cancel_wait_s = cancel_wait_s
        self._uploads: dict[str, SyncedUploads] = {} if uploads is None else uploads
        self._outputs: dict[str, OutputsMemory] = {} if outputs is None else outputs
        self._open = True
        self._died = False

    @property
    def synced_uploads(self) -> SyncedUploads | None:
        """What the last upload sync put into this sandbox (sandbox/uploads.py), kept by the manager per key."""
        return self._uploads.get(self.key)

    @synced_uploads.setter
    def synced_uploads(self, value: SyncedUploads | None) -> None:
        self._check()
        if value is None:
            self._uploads.pop(self.key, None)
        else:
            self._uploads[self.key] = value

    @property
    def outputs_memory(self) -> OutputsMemory:
        """What the `bash` tool keeps about this sandbox's /workspace/outputs; the manager keeps it while it runs."""
        self._check()
        return self._outputs.setdefault(self.key, OutputsMemory())

    def _check(self) -> None:
        if not self._open:
            raise SandboxError(f'the session on sandbox {self.key} has ended')

    async def _watch[T](self, call: Awaitable[T]) -> T:
        # A sandbox found not running mid-session may have stopped behind the manager's back (its VM died, say),
        # or the report may be wrong while the container lives on; the manager cleans it up when the block exits.
        try:
            return await call
        except SandboxNotRunning:
            self._died = True
            raise

    async def _complete[T](self, call: Awaitable[T], *, cancel_once: bool = False) -> T:
        """Await a backend call to its end, cancellation included; the block, and the lock, wait for it.

        The file tools resolve a path in one call and use it in the next,
        trusting that nothing changes the files in between (T12's security
        review, B1 and R1), so a session cannot end while a backend call it
        started may still be acting on the sandbox: a command or its kill, a
        put still untarring, a read. When the caller is cancelled (the user's
        Stop), an exec is cancelled once (`cancel_once`), which by the
        backend's contract runs the post-exec kill at once; other calls are
        left to finish. Either way this waits, through any further
        cancellations, for the call to end, then raises CancelledError.

        The wait after a cancellation is bounded by `cancel_wait_s` (R2): a
        call that has not ended by then is given up as in doubt, so the
        manager stops the sandbox when the block exits, still under its
        lock, before anything else may use it. The call is kept referenced
        until it ends.

        Raises:
            asyncio.CancelledError: The caller was cancelled; raised only
                once the call has ended or been given up.
            SandboxError: The call ended cancelled without the caller being
                cancelled (R5), so it neither escapes as a cancellation nor
                passes for a result.
        """
        task = asyncio.ensure_future(call)
        loop = asyncio.get_running_loop()
        deadline: float | None = None
        while not task.done():
            if deadline is not None and loop.time() >= deadline:
                _ABANDONED.add(task)
                task.add_done_callback(_settle_abandoned)
                self._died = True
                log.error(
                    'a cancelled call on sandbox %s did not end within %g s; stopping the sandbox',
                    self.key,
                    self._cancel_wait_s,
                )
                raise asyncio.CancelledError
            try:
                # Unlike awaiting the task, asyncio.wait leaves it running when this coroutine is cancelled.
                await asyncio.wait([task], timeout=None if deadline is None else deadline - loop.time())
            except asyncio.CancelledError:
                if deadline is None:
                    deadline = loop.time() + self._cancel_wait_s
                    if cancel_once:
                        task.cancel()
        if deadline is not None:
            # Retrieved, so asyncio does not log it as never retrieved.
            error = None if task.cancelled() else task.exception()
            if isinstance(error, SandboxNotRunning):
                self._died = True
            elif error is not None:
                log.debug('a sandbox call failed after its caller was cancelled', exc_info=error)
            raise asyncio.CancelledError
        if task.cancelled():
            raise SandboxError(
                f'a backend call on sandbox {self.key} ended cancelled though its caller was not',
                public='the sandbox call was interrupted; try again',
            )
        return await self._watch(task)

    def _close(self) -> bool:
        """End the session; True when the backend reported the sandbox not running during it."""
        self._open = False
        return self._died

    async def exec(self, argv: list[str], timeout_s: int, stdin: bytes | None = None) -> ExecResult:
        """Run one wrapped command (SandboxBackend.exec), returning or raising only once it and its kill are over.

        A cancelled caller cancels the backend's exec once, whose contract
        then runs the post-exec kill at once, and waits for it (_complete).
        """
        self._check()
        return await self._complete(self._backend.exec(self.key, argv, timeout_s, stdin), cancel_once=True)

    async def put_files(self, dir: str, files: list[tuple[str, bytes, int]]) -> None:
        """Replace `/workspace/<dir>` with exactly `files`, root-owned (SandboxBackend.put_files), to its end."""
        self._check()
        await self._complete(self._backend.put_files(self.key, dir, files))

    async def put_uploads(self, files: list[tuple[str, bytes]]) -> None:
        """Make the read-only `/workspace/uploads` hold exactly `files` (SandboxBackend.put_uploads), to its end."""
        self._check()
        await self._complete(self._backend.put_uploads(self.key, files))

    async def get_files(self, paths: list[str], max_bytes: int) -> dict[str, bytes]:
        """Read regular files of at most `max_bytes` (SandboxBackend.get_files), to its end."""
        self._check()
        return await self._complete(self._backend.get_files(self.key, paths, max_bytes))

    async def stat(self, path: str) -> FileStat | None:
        """The daemon's view of one path (SandboxBackend.stat), to its end."""
        self._check()
        return await self._complete(self._backend.stat(self.key, path))


# Backend calls a session gave up on after its caller was cancelled (_complete), kept here until they end, so a
# running one is never garbage-collected.
_ABANDONED: set[asyncio.Future[Any]] = set()


def _settle_abandoned(task: asyncio.Future[Any]) -> None:
    _ABANDONED.discard(task)
    if not task.cancelled():
        # Retrieved, so asyncio does not log it as never retrieved.
        task.exception()


@dataclass
class _KeyLock:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    #: Coroutines holding or waiting on `lock`; the entry is dropped when it reaches 0.
    users: int = 0


@dataclass
class _Tracked:
    """A sandbox that holds a slot: one this manager started and has not confirmed gone."""

    #: The image it runs, or None while it is being started or its state is in doubt (a create, stop or destroy
    #: failed or was cancelled, or it was reported not running), until a create or a cleanup settles it.
    image: ImageKey | None
    #: clock() at the end of its last call.
    last_call: float
    #: Destroyed, not stopped, whatever happened to its unsaved-chat mapping (Q5).
    ephemeral: bool


class SandboxManager:
    """Gives each chat its sandbox, one command at a time, within the running limit, and cleans up after them.

    Callers that act for a background sub-agent pass the parent chat's id
    (owner decision Q6): the sub-agent works on the parent's files, the
    per-chat lock serializes their calls, and it takes no slot of its own.
    An unsaved chat's sandbox belongs to the chat id and the user together
    (owner decision Q12); the lock is per sandbox key either way.
    """

    def __init__(
        self,
        backend: SandboxBackend,
        *,
        settings: Callable[[], Awaitable[SandboxSettings]] = settings_from_config,
        chats: ChatLookup | None = None,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
        wait_notice_s: float = 1.0,
        evict_idle_s: float = EVICT_IDLE_S,
        slot_wait_timeout_s: float = SLOT_WAIT_TIMEOUT_S,
        cancel_wait_s: float = CANCEL_WAIT_S,
    ) -> None:
        """Make a manager with no sandboxes; run `startup_sweep()` before the first session.

        Args:
            backend: Runs the sandboxes.
            settings: Reads the current settings; called once per operation.
            chats: Answers what the manager needs to know about chats; the app's database when None.
            clock: Monotonic seconds, for the last-call times the idle reaper and eviction compare.
            wall_clock: Epoch seconds, compared with chats' `updated_at` by the retention sweep.
            wait_notice_s: Seconds a session waits for a slot before it calls its `on_wait`.
            evict_idle_s: Seconds, by `clock`, a sandbox must have been idle before a session with no free
                slot may stop it and take its slot (Q13).
            slot_wait_timeout_s: Seconds, by the event loop's clock, a session waits for a slot before it
                raises SandboxError.
            cancel_wait_s: Seconds a session waits for a backend call to end after its caller was cancelled,
                before it gives the sandbox up as in doubt and stops it (SandboxSession._complete).
        """
        self._backend = backend
        self._settings = settings
        self._chats: ChatLookup = DatabaseChats() if chats is None else chats
        self._clock = clock
        self._wall_clock = wall_clock
        self._wait_notice_s = wait_notice_s
        self._evict_idle_s = evict_idle_s
        self._slot_wait_timeout_s = slot_wait_timeout_s
        self._cancel_wait_s = cancel_wait_s
        self._locks: dict[str, _KeyLock] = {}
        # Every sandbox that holds a slot, by key; the slots taken are its length.
        self._tracked: dict[str, _Tracked] = {}
        # (Unsaved chat id, user id) -> its ephemeral sandbox's key (Q12), and back.
        self._unsaved: dict[tuple[str, str], str] = {}
        self._unsaved_by_key: dict[str, tuple[str, str]] = {}
        # What the last upload sync put into each running sandbox (sandbox/uploads.py); dropped when it is forgotten.
        self._uploads: dict[str, SyncedUploads] = {}
        # What the `bash` tool keeps about each running sandbox's /workspace/outputs (sandbox/outputs.py); dropped when
        # it is forgotten.
        self._outputs: dict[str, OutputsMemory] = {}
        # Set, and replaced, whenever a slot is freed, waking every session waiting for one.
        self._freed = asyncio.Event()
        # Backend calls run to their end even when the session that started them is cancelled; kept here so a
        # running one is never garbage-collected.
        self._tasks: set[asyncio.Future[Any]] = set()
        # Set by shutdown(stop_running=True), after which no sandbox starts.
        self._stopped_all = False

    async def ready(self) -> str | None:
        """Why the backend cannot run sandboxes, or None when it can; never raises; waits READY_TIMEOUT_S at most."""
        try:
            return await asyncio.wait_for(self._backend.ready(), READY_TIMEOUT_S)
        except TimeoutError:
            return f'The sandbox backend did not answer within {READY_TIMEOUT_S:g} seconds'
        except Exception as e:
            log.exception('the sandbox backend could not report whether it is ready')
            return f'The sandbox backend could not report its state ({type(e).__name__})'

    # Sessions.

    @asynccontextmanager
    async def session(
        self,
        chat_id: str,
        user: Any,
        *,
        image: ImageKey | None = None,
        on_wait: Callable[[], Awaitable[None]] | None = None,
    ) -> AsyncIterator[SandboxSession]:
        """Hold the chat's sandbox, running with `image`, for the block; the chat's other calls wait.

        The chat is checked first (see SandboxRefused). A saved chat's
        sandbox is the chat's; an unsaved chat's is the chat's and this
        user's (owner decision Q12), so two users of one `channel:` chat get
        two sandboxes. Then, under the sandbox's lock: a sandbox that is not
        running is started, after finding a slot (see the module docstring),
        and for a saved chat, checking again that the user may use it; one
        running a different image than `image` is created again with it
        (the backend's create replaces the container on the same volume), so
        its files stay, keeping its slot. When the block exits, the call
        counts as the sandbox's last use.

        A session cancelled while the backend creates, stops or destroys a
        sandbox for it stays until that call has ended, then raises
        CancelledError: the backend's call cannot be cancelled with it, and
        the sandbox's lock is held until it is known what it left.

        Args:
            chat_id: The chat, or for a sub-agent its parent chat (owner decision Q6).
            user: Who is asking: must have a non-empty str `id`, and be allowed to use a saved chat
                (ChatLookup.usable); for an unsaved chat, the id picks the sandbox with the chat id.
            image: The image to run; None keeps the running one, or starts the default.
            on_wait: Awaited once if the session has waited `wait_notice_s` for a slot, so the caller can
                say it is waiting.

        Raises:
            SandboxRefused: The chat may not have a sandbox; the backend has not been called.
            ValueError: `image` is not an ImageKey.
            SandboxError: No slot came free within `slot_wait_timeout_s`, the manager has shut down, or the
                backend could not start the sandbox. No slot, lock or mapping is kept, except for a sandbox
                left to clean up.
        """
        owner = await self._admit(chat_id, user)
        settings = await self._settings()
        while True:
            key = validate_chat_id(chat_id) if owner is None else self._ephemeral_key(owner)
            try:
                async with self._hold(key):
                    if owner is not None and self._unsaved.get(owner) != key:
                        # Released or reaped while this session waited for the lock: resolve the key again.
                        continue
                    await self._start(
                        key, image, ephemeral=owner is not None, user=user, settings=settings, on_wait=on_wait
                    )
                    handle = SandboxSession(
                        self._backend,
                        key,
                        cancel_wait_s=self._cancel_wait_s,
                        uploads=self._uploads,
                        outputs=self._outputs,
                    )
                    try:
                        yield handle
                    finally:
                        await self._end(handle, ephemeral=owner is not None)
                    return
            except BaseException:
                if owner is not None and key not in self._tracked and key not in self._locks:
                    # Failed before its sandbox ran, and no other session is on it: forget the key, so failed
                    # and cancelled starts do not pile up in memory.
                    self._drop_mapping(key)
                raise

    async def _admit(self, chat_id: str, user: Any) -> tuple[str, str] | None:
        """None for a saved chat, `(chat_id, user id)` for an unsaved one (Q12); raise SandboxRefused for neither."""
        if type(chat_id) is not str or not chat_id:
            raise SandboxRefused(f'no sandbox without a chat id (got {chat_id!r})')
        user_id = getattr(user, 'id', None)
        if type(user_id) is not str or not user_id:
            raise SandboxRefused('no sandbox for a caller without a user id')
        if chat_id.startswith(NON_SAVED_CHAT_ID_PREFIXES):
            if len(chat_id) > MAX_UNSAVED_CHAT_ID_LEN:
                raise SandboxRefused(
                    f'an unsaved chat id of {len(chat_id)} characters is longer than {MAX_UNSAVED_CHAT_ID_LEN}'
                )
            return chat_id, user_id
        try:
            validate_chat_id(chat_id)
        except ValueError:
            raise SandboxRefused(f'chat id {chat_id!r} is neither a saved chat id nor an unsaved one') from None
        if not await self._chats.usable(chat_id, user):
            raise SandboxRefused(f'chat {chat_id} does not exist or this user may not run code in it')
        return None

    def _ephemeral_key(self, owner: tuple[str, str]) -> str:
        """The key of an unsaved chat's sandbox for one user, made the first time it is asked for."""
        key = self._unsaved.get(owner)
        if key is None:
            key = str(uuid.uuid4())
            self._unsaved[owner] = key
            self._unsaved_by_key[key] = owner
        return key

    async def _start(
        self,
        key: str,
        image: ImageKey | None,
        *,
        ephemeral: bool,
        user: Any,
        settings: SandboxSettings,
        on_wait: Callable[[], Awaitable[None]] | None,
    ) -> None:
        """Make `key`'s sandbox run the image asked for; the caller holds its lock.

        A key not tracked takes a slot first. A tracked one keeps its slot
        and is created again on it, whether it runs another image or is in
        doubt: the backend's create is idempotent, and replaces a container
        of another image on the same volume.
        """
        tracked = self._tracked.get(key)
        running = None if tracked is None else tracked.image
        want: ImageKey = image if image is not None else running if running is not None else settings.default_image
        if running == want:
            return
        # Built first: a bad image is refused before any backend call.
        spec = SandboxSpec(key, want, ephemeral=ephemeral)
        if tracked is None:
            await self._take_slot(key, ephemeral, settings.max_running, on_wait)
            try:
                if self._stopped_all:
                    # shutdown(stop_running=True) freed the slot this session waited for: start nothing behind it.
                    raise SandboxError('the sandbox manager has shut down', public=_SHUT_DOWN)
                # Asked again: access may have been revoked while this session waited.
                if not ephemeral and not await self._chats.usable(key, user):
                    raise SandboxRefused(f'chat {key} does not exist or this user may not run code in it')
            except BaseException:
                # Nothing has been created, so the slot is free at once.
                self._forget(key)
                raise
        await self._create(key, spec)
        if self._stopped_all:
            # The manager shut down, forgetting every key, while the backend created it: nothing may run behind
            # the shutdown.
            await self._clean_up(key, ephemeral)
            raise SandboxError('the sandbox manager has shut down', public=_SHUT_DOWN)
        # Still tracked: only a stop or destroy under its lock, which this session holds, or a shutdown forgets it.
        tracked = self._tracked[key]
        tracked.image = want
        tracked.last_call = self._clock()
        log.info('started sandbox %s (%s%s)', key, want, ', ephemeral' if ephemeral else '')

    async def _create(self, key: str, spec: SandboxSpec) -> None:
        """Create `key`'s sandbox, which holds a slot; the caller holds its lock.

        The backend's create runs to its end even if the caller is cancelled
        (T14's runs in a thread, which would go on anyway). If it fails or
        the caller was cancelled, a container may exist, so the sandbox is
        cleaned up before the error is raised, and stays tracked, in doubt,
        if that fails.
        """
        try:
            await self._finish(self._backend.create(key, spec))
        except BaseException:
            await self._clean_up(key, spec.ephemeral)
            raise

    async def _end(self, handle: SandboxSession, *, ephemeral: bool) -> None:
        """Close a session; the caller still holds its key's lock."""
        if handle._close():
            # The backend reported it not running, which may be wrong while the container lives on: stop it
            # (destroy, if ephemeral) before its slot is freed. A persistent sandbox keeps its volume and key, so
            # the next session starts it again on the same files.
            await self._clean_up(handle.key, ephemeral)
        elif (tracked := self._tracked.get(handle.key)) is not None:
            tracked.last_call = self._clock()

    async def _clean_up(self, key: str, ephemeral: bool) -> None:
        """Stop a sandbox that may still run (destroy, if ephemeral), logging a failure; the caller holds its lock.

        On success the key is forgotten and its slot freed; on failure it
        stays tracked, in doubt and holding its slot, and the idle reaper
        tries again.
        """
        try:
            await self._stop(key, destroy=ephemeral)
        except Exception:
            log.exception('could not clean up sandbox %s; it keeps its slot until the idle reaper stops it', key)

    async def _finish[T](self, call: Awaitable[T]) -> T:
        """Await `call` to its end, even if the caller is cancelled meanwhile, then raise that cancellation.

        When the caller was cancelled, the cancellation wins over whatever
        `call` raised, which is logged at debug level.
        """
        task = asyncio.ensure_future(call)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        cancelled = False
        while not task.done():
            try:
                # Unlike awaiting the task, asyncio.wait leaves it running when this coroutine is cancelled.
                await asyncio.wait([task])
            except asyncio.CancelledError:
                cancelled = True
        if cancelled:
            # Retrieved, so asyncio does not log it as never retrieved.
            error = None if task.cancelled() else task.exception()
            if error is not None:
                log.debug('a sandbox backend call failed after its caller was cancelled', exc_info=error)
            raise asyncio.CancelledError
        return task.result()

    # Slots and locks.

    async def _take_slot(
        self, key: str, ephemeral: bool, limit: int, on_wait: Callable[[], Awaitable[None]] | None
    ) -> None:
        """Track `key`, in doubt, on a free slot, evicting idle sandboxes for one or waiting.

        The slot is taken and the key tracked with no await between. It
        waits for at most `slot_wait_timeout_s`; `on_wait` is awaited once
        after `wait_notice_s`. A waiting session tries eviction again
        whenever a slot is freed, or every _SLOT_RETRY_S, since a sandbox
        becomes evictable by aging, which nothing announces.

        Raises:
            SandboxError: No slot came free in time.
        """
        loop = asyncio.get_running_loop()
        start = loop.time()
        notice_at = start + self._wait_notice_s
        deadline = start + self._slot_wait_timeout_s
        while True:
            if len(self._tracked) < limit:
                self._tracked[key] = _Tracked(image=None, last_call=self._clock(), ephemeral=ephemeral)
                return
            # Set by any slot freed from here on, so one freed during the awaits below is not missed.
            freed = self._freed
            if await self._evict():
                # Another waiter may have taken the freed slot meanwhile: check again.
                continue
            now = loop.time()
            if now >= deadline:
                raise SandboxError(
                    f'no free sandbox: all {limit} slots are taken, and none could be freed (each sandbox is in '
                    f'use, idle for less than {self._evict_idle_s:g} s, in doubt, or failed to stop); '
                    f'waited {self._slot_wait_timeout_s:g} s',
                    public=(
                        f'no sandbox came free within {self._slot_wait_timeout_s:g} seconds: all {limit} are in '
                        'use; try again in a few minutes'
                    ),
                )
            if on_wait is not None and now >= notice_at:
                callback, on_wait = on_wait, None
                await callback()
                continue
            wake = min(deadline, now + _SLOT_RETRY_S, notice_at if on_wait is not None else deadline)
            try:
                async with asyncio.timeout(wake - now):
                    await freed.wait()
            except TimeoutError:
                pass

    async def _evict(self) -> bool:
        """Stop the least recently used sandbox idle for `evict_idle_s` that nobody holds, freeing its slot.

        Exactly as the idle reaper would: a persistent sandbox keeps its
        volume, so its next call starts it again on the same files; an
        ephemeral one is destroyed with its volume, and its key forgotten.
        When a stop fails (logged), the sandbox is left in doubt for the
        reaper, and the next least recently used one is tried. A sandbox in
        doubt is never a candidate, so one that cannot be stopped does not
        block eviction of the others. False when none could be stopped.
        """
        now = self._clock()
        candidates = sorted(
            (tracked.last_call, key)
            for key, tracked in self._tracked.items()
            if tracked.image is not None and key not in self._locks and now - tracked.last_call >= self._evict_idle_s
        )
        for _, key in candidates:
            if await self._stop_idle(key, self._evict_idle_s, in_doubt_due=False, why=' to free a slot'):
                return True
        return False

    async def _stop_idle(self, key: str, idle_s: float, *, in_doubt_due: bool, why: str) -> bool:
        """Stop `key`'s sandbox if nobody holds it and it is still idle for `idle_s`; True once it is stopped.

        Checked again under its lock, against a fresh clock, since it may
        have been used, stopped or put in doubt while earlier ones were
        being stopped. A sandbox in doubt is due when `in_doubt_due`, and
        skipped otherwise. A failed stop is logged, leaving it in doubt.
        """
        # A sandbox in use is skipped, not waited for.
        if key in self._locks:
            return False
        async with self._hold(key):
            tracked = self._tracked.get(key)
            if tracked is None:
                return False
            if tracked.image is None:
                if not in_doubt_due:
                    return False
            elif self._clock() - tracked.last_call < idle_s:
                return False
            try:
                await self._stop(key, destroy=tracked.ephemeral)
            except Exception:
                log.exception('could not stop idle sandbox %s%s', key, why)
                return False
        log.info('stopped idle sandbox %s%s', key, why)
        return True

    def _free_slot(self) -> None:
        """Wake every session waiting for a slot."""
        self._freed.set()
        self._freed = asyncio.Event()

    def _forget(self, key: str) -> None:
        """Record that `key`'s sandbox no longer runs, freeing its slot."""
        # No await, so a cancellation can neither lose the slot nor keep the waiters from being woken.
        # A container started again, or a new volume, gets a full upload sync, and lists its outputs afresh.
        self._uploads.pop(key, None)
        self._outputs.pop(key, None)
        if self._tracked.pop(key, None) is not None:
            self._free_slot()

    def _drop_mapping(self, key: str) -> None:
        owner = self._unsaved_by_key.pop(key, None)
        if owner is not None and self._unsaved.get(owner) == key:
            del self._unsaved[owner]

    @asynccontextmanager
    async def _hold(self, key: str) -> AsyncIterator[None]:
        """Hold `key`'s lock; the lock is dropped once nobody holds or waits on it."""
        entry = self._locks.get(key)
        if entry is None:
            entry = self._locks[key] = _KeyLock()
        entry.users += 1
        try:
            async with entry.lock:
                yield
        finally:
            entry.users -= 1
            if entry.users == 0 and self._locks.get(key) is entry:
                del self._locks[key]

    def _busy(self, key: str) -> bool:
        """Whether a session holds or waits on `key`, or this manager tracks it (running, or in doubt)."""
        return key in self._locks or key in self._tracked

    async def _stop(self, key: str, *, destroy: bool) -> None:
        """Stop `key`'s sandbox, or destroy it with its volume; the caller holds its lock.

        A tracked sandbox is marked in doubt first, so a failed or cancelled
        call leaves it in doubt, holding its slot. The backend call runs to
        its end even if the caller is cancelled, and once it has succeeded
        the key is forgotten, its slot freed and its unsaved-chat mapping
        dropped, whatever happened to the caller.

        Raises:
            SandboxError: The backend could not stop or destroy it.
        """
        tracked = self._tracked.get(key)
        if tracked is not None:
            tracked.image = None

        async def call() -> None:
            if destroy:
                await self._backend.destroy(key)
            else:
                await self._backend.stop(key)
            self._drop_mapping(key)
            self._forget(key)

        await self._finish(call())

    # Release, sweeps and shutdown.

    async def release(self, chat_id: str) -> None:
        """Destroy the chat's sandboxes and volumes now, each under its lock, freeing their slots.

        For trusted internal callers only, such as the harness, which
        releases each item's ephemeral sandbox as soon as the item finishes
        (T30), so it never idles in a slot. It does no authorization and
        must never be given a user-supplied id: unlike `session`, it takes
        no user, so it cannot check who owns the chat, and for an unsaved
        chat it destroys every user's sandbox for that id.

        For a saved chat that is its one sandbox: the backend's destroy is
        called, itself a no-op when nothing exists. For an unsaved chat it
        is every user's sandbox for that chat id (owner decision Q12); one
        with none, and an id no sandbox could have, are no-ops with no
        backend call. Each sandbox's lock is waited for, and it is not
        re-entrant: call this outside any session block, since calling it
        inside one on the same sandbox deadlocks.

        Raises:
            SandboxError: The backend could not destroy one; that one stays
                tracked (in doubt, for the idle reaper) and mapped (for a
                later release), the others are still destroyed, and the first
                error is raised after them. For a saved chat, the reaper
                then only stops the one left in doubt, and its volume waits
                for the retention sweep.
        """
        if type(chat_id) is not str or not chat_id:
            return
        if not chat_id.startswith(NON_SAVED_CHAT_ID_PREFIXES):
            try:
                key = validate_chat_id(chat_id)
            except ValueError:
                return
            await self._release_key(key, ephemeral=False)
            return
        failure: Exception | None = None
        for key in [key for (chat, _), key in self._unsaved.items() if chat == chat_id]:
            try:
                await self._release_key(key, ephemeral=True)
            except Exception as exc:
                log.exception('could not release sandbox %s', key)
                failure = failure or exc
        if failure is not None:
            raise failure

    async def _release_key(self, key: str, *, ephemeral: bool) -> None:
        async with self._hold(key):
            if ephemeral and key not in self._unsaved_by_key:
                # Already destroyed (reaped or released) while this waited for the lock.
                return
            await self._stop(key, destroy=True)
        log.info('released sandbox %s', key)

    async def reap_idle(self) -> None:
        """Stop every running sandbox idle for at least `idle_minutes` and not in use, and retry those in doubt.

        A persistent sandbox keeps its volume; an ephemeral one is destroyed
        with its volume, and its chat's key forgotten (Q5). Each is checked
        again under its lock, against a fresh clock, so one used while
        earlier ones were being stopped is kept. A sandbox the backend fails
        to stop is logged, left in doubt, and tried again next pass.
        """
        settings = await self._settings()
        threshold = settings.idle_minutes * 60
        now = self._clock()
        due = [
            key
            for key, tracked in self._tracked.items()
            if tracked.image is None or now - tracked.last_call >= threshold
        ]
        for key in due:
            await self._stop_idle(key, threshold, in_doubt_due=True, why='')

    async def sweep_retention(self) -> None:
        """Destroy the volumes of stopped saved chats not updated for `retention_days`, or deleted.

        Only sandboxes the backend lists as not running are judged, and
        none in use. A stopped ephemeral one whose key this manager no
        longer maps is destroyed whatever its age, since an ephemeral
        sandbox goes when it stops (Q5). The persistent ones' chats are
        looked up in one `updated_at` call, skipped when there is nothing
        to judge. A volume is destroyed when its chat has no row (deleted,
        by any path) or its `updated_at` is before `wall_clock() -
        retention_days` days; exactly at that moment, it is kept. The chat's
        `updated_at` is taken as given, so a chat imported with a future date
        keeps its volume until then; T24 judges expiry by the manager's own
        record of last use instead. If more than half of the
        chats looked up, and more than 3, have no row, the database may be
        empty or wrong: none of those volumes is destroyed that pass, and
        an error is logged. The chats of the volumes to be destroyed are
        looked up again just before, so one updated meanwhile is kept.

        Raises:
            SandboxError: Listing the sandboxes failed. A volume that fails to be destroyed is logged instead.
        """
        settings = await self._settings()
        infos = await self._backend.list_sandboxes()
        for info in infos:
            key = info.chat_id
            # Checked with no await before the lock is taken, so nobody can start it in between.
            if not info.ephemeral or info.running or key in self._unsaved_by_key or self._busy(key):
                continue
            async with self._hold(key):
                try:
                    await self._backend.destroy(key)
                except Exception:
                    log.exception('could not destroy stopped ephemeral sandbox volume %s', key)
                else:
                    log.info('destroyed stopped ephemeral sandbox volume %s', key)
        stopped = [info.chat_id for info in infos if not info.running and not info.ephemeral]
        candidates = [key for key in stopped if not self._busy(key)]
        if not candidates:
            return
        updated = await self._chats.updated_at(candidates)
        cutoff = self._wall_clock() - settings.retention_days * _SECONDS_PER_DAY
        missing = {key for key in candidates if key not in updated}
        if len(missing) > 3 and 2 * len(missing) > len(candidates):
            log.error(
                'the chats of %d of %d stopped sandbox volumes were not found; destroying none of those this pass, '
                'in case the database is empty or wrong',
                len(missing),
                len(candidates),
            )
            candidates = [key for key in candidates if key not in missing]
        doomed = [key for key in candidates if key in missing or updated[key] < cutoff]
        if not doomed:
            return
        # Looked up again just before destroying: a chat updated during the awaits above keeps its volume.
        fresh = await self._chats.updated_at(doomed)
        for key in doomed:
            stamp = fresh.get(key)
            if stamp is not None and stamp >= cutoff:
                continue
            # Checked again, with no await before the lock: a session may have started it during the awaits above.
            if self._busy(key):
                continue
            async with self._hold(key):
                try:
                    await self._backend.destroy(key)
                except Exception:
                    log.exception('could not destroy expired sandbox volume %s', key)
                else:
                    log.info('destroyed sandbox volume %s (%s)', key, 'chat deleted' if stamp is None else 'expired')

    async def startup_sweep(self) -> None:
        """Clean up after the previous process; it must run before the manager serves any session.

        Everything listed is taken for the previous process's, which is why
        it must come first (T14 runs it in the app's lifespan before
        serving): a running sandbox is stopped, an ephemeral one destroyed
        with its volume, running or not, and a persistent volume kept for
        the retention sweep. Each is cleaned under its lock, and one this
        manager tracks, or a session holds or waits on, is skipped.
        Failures are logged per sandbox.

        Raises:
            SandboxError: Listing the sandboxes failed.
        """
        for info in await self._backend.list_sandboxes():
            # Checked with no await before the lock is taken, so nobody can start it in between.
            if self._busy(info.chat_id):
                continue
            async with self._hold(info.chat_id):
                await self._clean_one(info)

    async def _clean_one(self, info: SandboxInfo) -> None:
        try:
            if info.ephemeral:
                await self._backend.destroy(info.chat_id)
            elif info.running:
                await self._backend.stop(info.chat_id)
        except Exception:
            log.exception('could not clean up sandbox %s', info.chat_id)

    async def shutdown(self, *, stop_running: bool) -> None:
        """End the manager's work as the app shuts down.

        With `stop_running` False (an ordinary shutdown, such as a
        `--reload` restart), running sandboxes are left alone, so no command
        is killed mid-run; the next startup sweep stops them. With it True
        (`LLLM_STOP_JOBS_ON_SHUTDOWN`), every running sandbox is stopped and
        every ephemeral one destroyed, without waiting for sessions in
        progress, and the manager forgets them all; from then on, a session
        that would start a sandbox raises SandboxError instead, and one
        whose create was in flight cleans its sandbox up and raises it too.
        It prints no `==> ` lines, which the desktop app's progress dialog
        follows.

        Raises:
            SandboxError: Listing the sandboxes failed.
        """
        if not stop_running:
            log.info('leaving %d running sandbox(es) for the next start to stop', len(self._tracked))
            return
        self._stopped_all = True
        for info in await self._backend.list_sandboxes():
            await self._clean_one(info)
        for key in list(self._tracked):
            self._forget(key)
        self._unsaved.clear()
        self._unsaved_by_key.clear()

    async def maintenance_loop(self, *, reap_every_s: float = 60, sweep_every_s: float = 3600) -> None:
        """Reap idle sandboxes every `reap_every_s` and sweep retention every `sweep_every_s`, until cancelled.

        The first retention sweep runs with the first reap, so a process
        restarted within the hour still sweeps. A pass that fails is logged and
        never ends the loop.
        """
        last_sweep: float | None = None
        while True:
            await asyncio.sleep(reap_every_s)
            try:
                await self.reap_idle()
            except Exception:
                log.exception('the sandbox idle reaper failed')
            if last_sweep is None or self._clock() - last_sweep >= sweep_every_s:
                last_sweep = self._clock()
                try:
                    await self.sweep_retention()
                except Exception:
                    log.exception('the sandbox retention sweep failed')
