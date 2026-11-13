"""Package telemetry: which packages the sandboxes use, and which they miss (T21).

docs/proposals/sandbox-code-interpreter.md, "Package telemetry". Three
signals, each turned into rows of `sandbox_package_events`
(models/sandbox.py):

- Imports. The data image's `sitecustomize.py` and `Rprofile.site`
  (infra/sandbox/data/) append one JSON line per imported distribution or
  loaded R namespace to EVENTS_PATH when a process exits, and one per
  uncaught ModuleNotFoundError. After each `bash` call (and each run of
  `run_code_in_sandbox`) the file is read through the daemon and emptied
  through lllm-path (read_events).
- Misses in the call's output: pip's "No matching distribution found for",
  bash's "command not found" and R's "there is no package called" on
  stderr, LaTeX's "File `...' not found" on either stream (pdflatex prints
  its errors on stdout) (output_misses).
- Installs: the pip mirror's access log since the last read, through the
  backend (SandboxBackend.mirror_log), each wheel download credited to the
  sandbox whose recorded address window (SandboxManager.sandbox_at) holds
  the request's client address at the line's time (mirror_events).

Everything the guest wrote is hostile: the file is read only when it is a
regular file, not a symlink, under a real directory, and at most
EVENTS_MAX_BYTES; lines are capped in number and length, and each field is
checked strictly (a name of at most NAME_MAX characters from a fixed
alphabet, a version of at most VERSION_MAX). A line that fails is dropped.
Telemetry is advisory: code in the sandbox can delete or forge its own
events, so the report counts what was recorded, nothing more.

Telemetry never breaks or stalls a call: every step's failure is logged
and swallowed, the tools call it only after the command's result is in
hand, the in-session part has COLLECT_TIMEOUT_S in all, and the mirror's
log and the database write run in a background task. A call's rows are
deduplicated on (kind, name, version) and capped at ROWS_PER_CALL; rows
older than PACKAGE_EVENTS_RETENTION_DAYS are pruned hourly. Rows carry the
chat, its owner's user id, the image's digest (the backend's `image_ids`),
the SHA-256 of infra/sandbox/requirements.lock (lock_sha) and, for the
benchmark harness, its suite run id, so reports can leave harness runs out.
"""

import asyncio
import hashlib
import json
import logging
import re
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final
from urllib.parse import unquote, urlsplit

from local_llm.sandbox.exec import wrap_argv
from local_llm.sandbox.limits import MIRROR_LOG_MAX_BYTES, PACKAGE_EVENTS_RETENTION_DAYS, WORKSPACE
from local_llm.sandbox.types import ExecResult, MirrorLine
from local_llm.sandbox.workspace import GUEST_SHELL, LLLM_PATH
from local_llm.utils.chat_id import NON_SAVED_CHAT_ID_PREFIXES

if TYPE_CHECKING:
    from local_llm.sandbox.manager import SandboxManager, SandboxSession

log = logging.getLogger(__name__)

#: Where the image hooks write their events (infra/sandbox/data/sitecustomize.py and Rprofile.site name it too).
EVENTS_DIR: Final = f'{WORKSPACE}/.telemetry'
EVENTS_PATH: Final = f'{EVENTS_DIR}/events.jsonl'
#: The largest events file read; a larger one is emptied unread, and its events lost.
EVENTS_MAX_BYTES: Final = 256 * 1024
#: The most lines of the file used per call; the rest are dropped.
EVENTS_MAX_LINES: Final = 2_000
#: The longest line used, in bytes.
LINE_MAX_BYTES: Final = 1_024
#: The longest name kept, in characters.
NAME_MAX: Final = 128
#: The longest version kept, in characters.
VERSION_MAX: Final = 64
#: The most misses one call records (each kind and name once).
MISSES_MAX: Final = 50
#: Guest timestamps further than this from the collection's time (seconds) are replaced by it.
TS_SLACK_S: Final = 30 * 86_400
#: The harness_run_id of a harness request whose run id is unknown, so reports still leave it out.
HARNESS_UNKNOWN: Final = 'harness'
#: Sandbox keys whose context (chat, image, harness run) is kept for attributing mirror lines.
CONTEXTS_KEPT: Final = 1_024
#: The most rows one call records, misses included, after each (kind, name, version) is kept once.
ROWS_PER_CALL: Final = 200
#: Seconds a call's own collection (its events file, its sandbox's address) may take inside its session.
COLLECT_TIMEOUT_S: Final = 3.0
#: Seconds the background part (the mirror, the owners, the database write) may take.
FINISH_TIMEOUT_S: Final = 30.0
#: Seconds without a mirror read after a failed one, doubling with each failure up to MIRROR_BACKOFF_MAX_S.
MIRROR_BACKOFF_S: Final = 60.0
MIRROR_BACKOFF_MAX_S: Final = 900.0
#: Timeout of the guest helper that empties the events file, in seconds.
TRUNCATE_TIMEOUT_S: Final = 5

#: The repository's infra/sandbox, where the lock and the image's frozen package lists live.
INFRA_SANDBOX: Final = Path(__file__).resolve().parents[4] / 'infra' / 'sandbox'
REQUIREMENTS_LOCK: Final = INFRA_SANDBOX / 'requirements.lock'
IMAGE_FREEZE: Final = INFRA_SANDBOX / 'image-freeze.txt'
IMAGE_FREEZE_R: Final = INFRA_SANDBOX / 'image-freeze-r.txt'

#: Empties the events file "$1" as UID 1000, only when lllm-path resolves it to exactly "$2" (so no symlink is on
#: the way) and it is a regular file; exits 1 otherwise, with lllm-path's own status when that fails.
TRUNCATE_SCRIPT: Final = (
    f'p=$(/bin/bash --noprofile --norc {LLLM_PATH} "$1") || exit $?\n'
    'if [ "$p" != "$2" ] || [ -L "$p" ] || [ ! -f "$p" ]; then exit 1; fi\n'
    ': > "$p"\n'
)

# The kinds the guest's hooks may write; the others are recorded on the host only.
_GUEST_KINDS: Final = frozenset({'import', 'r_import', 'module_miss'})
_FIELDS: Final = frozenset({'kind', 'name', 'version', 'ts'})
# A distribution name (PEP 508), an R package name, a top-level module, a command, a LaTeX file.
_DIST: Final = re.compile(r'[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?', re.ASCII)
_R_PACKAGE: Final = re.compile(r'[A-Za-z][A-Za-z0-9.]*[A-Za-z0-9]', re.ASCII)
_MODULE: Final = re.compile(r'[A-Za-z_][A-Za-z0-9_]*', re.ASCII)
_COMMAND: Final = re.compile(r'[A-Za-z0-9_.+][A-Za-z0-9_.+-]*', re.ASCII)
_FILE: Final = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_.+-]*', re.ASCII)
_VERSION: Final = re.compile(r'[A-Za-z0-9][A-Za-z0-9.+!_-]*', re.ASCII)
_NAME_RULES: Final = {
    'import': _DIST,
    'install': _DIST,
    'pip_miss': _DIST,
    'r_import': _R_PACKAGE,
    'r_miss': _R_PACKAGE,
    'module_miss': _MODULE,
    'command_miss': _COMMAND,
    'latex_miss': _FILE,
}

# The output matchers, one line at a time.
_PIP_MISS: Final = re.compile(r'No matching distribution found for ([A-Za-z0-9][A-Za-z0-9._-]*)')
_COMMAND_MISS: Final = re.compile(r'^(?:[^\n:]*: )?(?:line \d+: )?([^\s:]+): command not found\s*$', re.MULTILINE)
_LATEX_MISS: Final = re.compile(r"File `([^'`\n]{1,200})' not found")
_R_MISS: Final = re.compile('there is no package called [‘\'"]([A-Za-z0-9.]+)[’\'"]')

# A wheel's file name: name-version(-build)?-python-abi-platform.whl.
_WHEEL: Final = re.compile(
    r'(?P<name>[A-Za-z0-9](?:[A-Za-z0-9._]*[A-Za-z0-9])?)-(?P<version>[A-Za-z0-9.!+_]+)'
    r'(?:-[0-9][A-Za-z0-9_.]*)?-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+\.whl',
    re.ASCII,
)
_IPV4: Final = re.compile(r'(?:\d{1,3}\.){3}\d{1,3}', re.ASCII)
# The longest mirror log line looked at; nginx's own limits keep a real one far shorter.
_MIRROR_LINE_MAX: Final = 16_384


def canonical(name: str) -> str:
    """A distribution name in PEP 503's normal form: lower case, each run of `-`, `_` and `.` one `-`."""
    return re.sub(r'[-_.]+', '-', name).lower()


@dataclass(frozen=True)
class Event:
    """One telemetry event, before the context of its call is added.

    Attributes:
        kind: See models/sandbox.py's USE_KINDS and MISS_KINDS.
        name: Checked against its kind's rule, normalised for a distribution.
        version: For an import or an install; None otherwise.
        ts: Epoch seconds.
    """

    kind: str
    name: str
    version: str | None
    ts: int


def checked_name(kind: str, name: object) -> str | None:
    """`name` as recorded for `kind` (a distribution normalised), or None when it breaks the kind's rule."""
    rule = _NAME_RULES.get(kind)
    if rule is None or type(name) is not str or not 0 < len(name) <= NAME_MAX or not rule.fullmatch(name):
        return None
    return canonical(name) if rule is _DIST else name


def checked_version(version: object) -> str | None:
    """`version` when it is a plausible version string of at most VERSION_MAX characters, else None."""
    if type(version) is str and 0 < len(version) <= VERSION_MAX and _VERSION.fullmatch(version):
        return version
    return None


def parse_events(data: bytes, *, now: int) -> tuple[list[Event], int]:
    """The valid events in the guest's events file, and how many lines were dropped.

    Each line must be at most LINE_MAX_BYTES of UTF-8 holding one JSON object
    with only `kind`, `name`, `version` and `ts`: `kind` one the hooks write
    (import, r_import, module_miss), `name` valid for it, `version` a valid
    version or null (and absent or null for a miss; an import whose version
    is not valid keeps its name with no version), `ts` a number within
    TS_SLACK_S of `now`, else `now` is used. Only the first EVENTS_MAX_LINES
    lines are looked at.
    """
    events: list[Event] = []
    dropped = 0
    lines = [line for line in data.split(b'\n') if line.strip()]
    dropped += max(len(lines) - EVENTS_MAX_LINES, 0)
    for line in lines[:EVENTS_MAX_LINES]:
        event = _parse_line(line, now)
        if event is None:
            dropped += 1
        else:
            events.append(event)
    return events, dropped


def _parse_line(line: bytes, now: int) -> Event | None:
    if len(line) > LINE_MAX_BYTES:
        return None
    try:
        record = json.loads(line.decode('utf-8'))
    except (UnicodeDecodeError, ValueError, RecursionError):
        return None
    if not isinstance(record, dict) or not set(record) <= _FIELDS:
        return None
    kind = record.get('kind')
    if kind not in _GUEST_KINDS:
        return None
    name = checked_name(kind, record.get('name'))
    if name is None:
        return None
    version = record.get('version')
    if kind == 'module_miss':
        if version is not None:
            return None
    else:
        version = checked_version(version)
    ts = record.get('ts')
    stamp = now
    if isinstance(ts, int | float) and not isinstance(ts, bool) and abs(ts - now) <= TS_SLACK_S:
        stamp = int(ts)
    return Event(kind, name, version, stamp)


def output_misses(stdout: str, stderr: str, *, now: int) -> list[Event]:
    """The misses a call's output shows, each kind and name once, at most MISSES_MAX.

    stderr: pip's "No matching distribution found for <requirement>" (the
    requirement's name, normalised), bash's "<command>: command not found",
    R's "there is no package called '<name>'". Both streams: LaTeX's "File
    `<name>' not found", which pdflatex prints on stdout. A match whose name
    breaks its kind's rule (a command with a space, say) is not recorded.
    """
    found: dict[tuple[str, str], Event] = {}

    def add(kind: str, name: str) -> None:
        checked = checked_name(kind, name)
        if checked is not None and len(found) < MISSES_MAX:
            found.setdefault((kind, checked), Event(kind, checked, None, now))

    for match in _PIP_MISS.finditer(stderr):
        add('pip_miss', match[1])
    for match in _COMMAND_MISS.finditer(stderr):
        add('command_miss', match[1])
    for match in _R_MISS.finditer(stderr):
        add('r_miss', match[1])
    for stream in (stderr, stdout):
        for match in _LATEX_MISS.finditer(stream):
            add('latex_miss', match[1])
    return list(found.values())


def parse_mirror_line(line: str) -> tuple[str, str, str] | None:
    """`(client address, distribution, version)` for a mirror log line recording a wheel served in full, else None.

    The mirror logs one JSON object per request (infra/sandbox/mirror/nginx.conf:
    `remote`, `method`, `uri`, `status`, ...). Only a GET answered 200 for a
    `.whl` file counts; the wheel's file name gives the distribution
    (normalised) and the version.
    """
    if len(line) > _MIRROR_LINE_MAX:
        return None
    try:
        record = json.loads(line)
    except (ValueError, RecursionError):
        return None
    if not isinstance(record, dict) or record.get('method') != 'GET' or record.get('status') != 200:
        return None
    remote, uri = record.get('remote'), record.get('uri')
    if type(remote) is not str or not _IPV4.fullmatch(remote) or type(uri) is not str:
        return None
    filename = unquote(urlsplit(uri).path).rsplit('/', 1)[-1]
    match = _WHEEL.fullmatch(filename)
    if match is None:
        return None
    name, version = checked_name('install', match['name']), checked_version(match['version'])
    if name is None or version is None:
        return None
    return remote, name, version


def harness_run_id(request: object) -> str | None:
    """The harness suite run id a request carries (`request.state.harness_run_id`, set by the benchmark runner), or
    HARNESS_UNKNOWN for a harness request without one; None for anything else."""
    state = getattr(request, 'state', None)
    run_id = getattr(state, 'harness_run_id', None)
    if type(run_id) is str and run_id:
        return run_id[:NAME_MAX]
    if getattr(state, 'benchmark_harness', False) is True:
        return HARNESS_UNKNOWN
    return None


def _requirement_names(text: str) -> set[str]:
    """The normalised names of `name==version` lines (image-freeze.txt, and requirements.lock's requirement lines)."""
    names: set[str] = set()
    for line in text.splitlines():
        if not line or line[0] in ' \t#-':
            continue
        name = line.split('==', 1)[0].strip()
        if _DIST.fullmatch(name):
            names.add(canonical(name))
    return names


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding='utf-8')
    except OSError:
        log.warning('package telemetry: could not read %s', path)
        return ''


@dataclass(frozen=True)
class PackageSources:
    """Where each package comes from, by the repository's lists: the image's frozen lists and the wheelhouse lock."""

    image: frozenset[str]
    wheelhouse: frozenset[str]
    image_r: frozenset[str]

    def source(self, language: str, name: str) -> str:
        """`image`, `wheelhouse`, or `other` (neither list names it: vendored, or not from either source)."""
        if language == 'r':
            return 'image' if name in self.image_r else 'other'
        if name in self.image:
            return 'image'
        return 'wheelhouse' if name in self.wheelhouse else 'other'


def package_sources() -> PackageSources:
    """The lists as the repository holds them now (a missing file lists nothing, logged)."""
    r_names = {line.split('==', 1)[0].strip() for line in _read_text(IMAGE_FREEZE_R).splitlines() if '==' in line}
    return PackageSources(
        image=frozenset(_requirement_names(_read_text(IMAGE_FREEZE))),
        wheelhouse=frozenset(_requirement_names(_read_text(REQUIREMENTS_LOCK))),
        image_r=frozenset(r_names),
    )


async def package_report(*, include_harness: bool = False, limit: int = 500) -> dict[str, Any]:
    """The admin report: packages with their source, and misses ranked by distinct users (models/sandbox.py)."""
    from local_llm.models.sandbox import SandboxPackageEvents

    uses = await SandboxPackageEvents.uses(include_harness=include_harness, limit=limit)
    misses = await SandboxPackageEvents.misses(include_harness=include_harness, limit=limit)
    sources = await asyncio.to_thread(package_sources)
    for row in uses:
        row['source'] = sources.source(row['language'], row['name'])
    return {'include_harness': include_harness, 'packages': uses, 'misses': misses}


async def store_events(rows: list[dict[str, Any]]) -> None:
    """Append rows to `sandbox_package_events`."""
    from local_llm.models.sandbox import SandboxPackageEvents

    await SandboxPackageEvents.add_events(rows)


async def chat_owner_id(chat_id: str) -> str | None:
    """The owner of the saved chat `chat_id`, or None when it has no row."""
    from local_llm.sandbox.workspaces import DatabaseWorkspaces

    return await DatabaseWorkspaces().owner_of(chat_id)


async def prune_events(before: int) -> int:
    """Delete the rows older than `before` (epoch seconds); how many."""
    from local_llm.models.sandbox import SandboxPackageEvents

    return await SandboxPackageEvents.delete_before(before)


@dataclass(frozen=True)
class Context:
    """What every row of one call carries besides the event itself."""

    chat_id: str
    image_digest: str
    lock_sha: str
    harness_run_id: str | None
    #: Epoch seconds when the call began.
    started: int
    #: The caller's user id: the owner of an unsaved chat's sandbox (Q12); for a saved chat the owner is looked up.
    caller_id: str | None = None

    def row(self, event: Event, user_id: str | None = None) -> dict[str, Any]:
        """The `sandbox_package_events` row of `event` in this context, credited to `user_id`."""
        return {
            'ts': event.ts,
            'chat_id': self.chat_id,
            'user_id': user_id,
            'kind': event.kind,
            'name': event.name,
            'version': event.version,
            'image_digest': self.image_digest,
            'lock_sha': self.lock_sha,
            'harness_run_id': self.harness_run_id,
        }


#: An event waiting to be stored, with the context of the call it belongs to.
Pending = tuple[Context, Event]


def deduplicated(pending: Iterable[Pending], cap: int = ROWS_PER_CALL) -> list[Pending]:
    """Each chat's (kind, name, version) once, the earliest kept, at most `cap` in all."""
    seen: set[tuple[str, str, str, str | None]] = set()
    kept: list[Pending] = []
    for context, event in pending:
        key = (context.chat_id, event.kind, event.name, event.version)
        if key in seen:
            continue
        if len(kept) >= cap:
            break
        seen.add(key)
        kept.append((context, event))
    return kept


class PackageTelemetry:
    """Collects the package telemetry for the `bash` tool and run_code_in_sandbox; one per app (app.state).

    A call's own events (its events file and its output's misses) are
    gathered inside its session, under COLLECT_TIMEOUT_S in all. Everything
    else runs after the session in a tracked background task (`finish`), so
    the call returns without waiting: the mirror's new lines, the chats'
    owners, and the database write. `close` cancels what is left at
    shutdown; `drain` waits for it (tests).

    It keeps the mirror log's cursor (the last line credited, starting when
    it is made, since earlier lines name addresses nobody here recorded), a
    lock that a second reader skips rather than waits on (the next call
    reads those lines), a back-off after a failed read, and the context of
    each sandbox's latest call, so an install read after another chat's
    call is still credited to its own chat, image and harness run.
    """

    def __init__(
        self,
        *,
        store: Callable[[list[dict[str, Any]]], Awaitable[None]] = store_events,
        owner_of: Callable[[str], Awaitable[str | None]] = chat_owner_id,
        prune: Callable[[int], Awaitable[int]] = prune_events,
        wall_clock: Callable[[], float] = time.time,
        wall_clock_ns: Callable[[], int] = time.time_ns,
        clock: Callable[[], float] = time.monotonic,
        lock_file: Path = REQUIREMENTS_LOCK,
    ) -> None:
        """Start with the mirror cursor at `wall_clock_ns()`."""
        self._store = store
        self._owner_of = owner_of
        self._prune = prune
        self._wall_clock = wall_clock
        self._clock = clock
        self._lock_file = lock_file
        self._cursor_ns = wall_clock_ns()
        self._mirror_lock = asyncio.Lock()
        self._mirror_retry_at = 0.0
        self._mirror_backoff_s = MIRROR_BACKOFF_S
        self._contexts: OrderedDict[str, Context] = OrderedDict()
        self._owners: OrderedDict[str, str | None] = OrderedDict()
        self._tasks: set[asyncio.Task[None]] = set()
        self._lock_stamp: tuple[int, int] | None = None
        self._lock_sha = ''

    def lock_sha(self) -> str:
        """SHA-256 of requirements.lock, read again only when its size or mtime changed; '' when unreadable."""
        try:
            info = self._lock_file.stat()
            stamp = (info.st_mtime_ns, info.st_size)
            if stamp != self._lock_stamp:
                self._lock_sha = hashlib.sha256(self._lock_file.read_bytes()).hexdigest()
                self._lock_stamp = stamp
        except OSError:
            log.warning('package telemetry: could not read %s', self._lock_file)
            self._lock_stamp, self._lock_sha = None, ''
        return self._lock_sha

    def begin(
        self, manager: 'SandboxManager', session: 'SandboxSession', chat_id: str, request: object, caller_id: object
    ) -> Context | None:
        """Note the context of a call about to run in `session`'s sandbox; None (logged) when it cannot be made."""
        try:
            context = Context(
                chat_id=chat_id,
                image_digest=manager.image_digest(session.image),
                lock_sha=self.lock_sha(),
                harness_run_id=harness_run_id(request),
                started=int(self._wall_clock()),
                caller_id=caller_id if isinstance(caller_id, str) and caller_id else None,
            )
            self._contexts[session.key] = context
            self._contexts.move_to_end(session.key)
            while len(self._contexts) > CONTEXTS_KEPT:
                self._contexts.popitem(last=False)
            return context
        except Exception:
            log.warning('package telemetry: could not note the context of a call', exc_info=True)
            return None

    async def gather(
        self, manager: 'SandboxManager', session: 'SandboxSession', context: Context | None, result: ExecResult
    ) -> list[Pending]:
        """A call's own events: its output's misses, then its events file; and the sandbox's address, once per start.

        Runs inside the session, after the command (its sandbox's lock is
        held, and no process the command started is left), for at most
        COLLECT_TIMEOUT_S in all: what is not done by then is given up,
        logged. Each step that fails is logged and gives nothing; nothing is
        raised but a cancellation of the caller.
        """
        if context is None:
            return []
        now = int(self._wall_clock())
        pending: list[Pending] = []
        try:
            pending += [(context, event) for event in output_misses(result.stdout, result.stderr, now=now)]
        except Exception:
            log.warning('package telemetry: could not match the output of sandbox %s', session.key, exc_info=True)
        try:
            async with asyncio.timeout(COLLECT_TIMEOUT_S):
                try:
                    pending += [(context, event) for event in await read_events(session, now=now)]
                except TimeoutError:
                    raise
                except Exception:
                    log.warning(
                        'package telemetry: could not read the events of sandbox %s', session.key, exc_info=True
                    )
                try:
                    await manager.learn_address(session.key)
                except TimeoutError:
                    raise
                except Exception:
                    log.warning(
                        'package telemetry: could not learn the address of sandbox %s', session.key, exc_info=True
                    )
        except TimeoutError:
            log.warning(
                'package telemetry: sandbox %s took over %g s; giving the rest up', session.key, COLLECT_TIMEOUT_S
            )
        return deduplicated(pending)

    def finish(self, manager: 'SandboxManager', pending: list[Pending]) -> None:
        """Store `pending` with the mirror's new installs, in a tracked background task; never raises."""
        try:
            task = asyncio.get_running_loop().create_task(self._finish(manager, pending))
        except Exception:
            log.warning('package telemetry: could not start recording %d events', len(pending), exc_info=True)
            return
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _finish(self, manager: 'SandboxManager', pending: list[Pending]) -> None:
        try:
            async with asyncio.timeout(FINISH_TIMEOUT_S):
                installs: list[Pending] = []
                try:
                    installs = await self.mirror_events(manager)
                except Exception:
                    log.warning('package telemetry: could not credit the mirror log', exc_info=True)
                rows = [context.row(event, await self._user(context)) for context, event in pending]
                rows += [context.row(event, await self._user(context)) for context, event in deduplicated(installs)]
                if rows:
                    await self._store(rows)
        except Exception:
            log.warning('package telemetry: could not record %d events', len(pending), exc_info=True)

    async def _user(self, context: Context) -> str | None:
        """Whose workspace the context's chat is: the caller for an unsaved chat (Q12), else the saved chat's owner."""
        if context.chat_id.startswith(NON_SAVED_CHAT_ID_PREFIXES) or not context.chat_id:
            return context.caller_id
        if context.chat_id not in self._owners:
            try:
                self._owners[context.chat_id] = await self._owner_of(context.chat_id)
            except Exception:
                log.warning('package telemetry: could not look up the owner of chat %s', context.chat_id, exc_info=True)
                return None
            while len(self._owners) > CONTEXTS_KEPT:
                self._owners.popitem(last=False)
        return self._owners[context.chat_id]

    async def drain(self) -> None:
        """Wait for every background task started so far."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    async def close(self) -> None:
        """Cancel the background tasks still running (the app's shutdown) and wait for them to end."""
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*list(self._tasks), return_exceptions=True)

    async def mirror_events(self, manager: 'SandboxManager') -> list[Pending]:
        """The installs in the mirror's log since the last read, credited by client address and time.

        One read at a time: a call that finds a read under way skips its own
        (the next call reads those lines). After a failed read none is tried
        for MIRROR_BACKOFF_S, doubling with each failure up to
        MIRROR_BACKOFF_MAX_S; the failure is logged when the back-off starts.
        At most MIRROR_LOG_MAX_BYTES a read; what is left waits for the next
        call. Each install goes to the sandbox whose recorded address window
        holds the line's time (SandboxManager.sandbox_at); one no window
        holds is dropped (debug). The cursor moves past the lines only once
        they are credited, so a failure reads them again.
        """
        if self._mirror_lock.locked() or self._clock() < self._mirror_retry_at:
            return []
        async with self._mirror_lock:
            try:
                lines = await manager.mirror_log(self._cursor_ns, MIRROR_LOG_MAX_BYTES)
            except Exception:
                if self._mirror_backoff_s == MIRROR_BACKOFF_S:
                    log.warning('package telemetry: could not read the mirror log', exc_info=True)
                self._mirror_retry_at = self._clock() + self._mirror_backoff_s
                self._mirror_backoff_s = min(self._mirror_backoff_s * 2, MIRROR_BACKOFF_MAX_S)
                return []
            self._mirror_backoff_s = MIRROR_BACKOFF_S
            self._mirror_retry_at = 0.0
            credited = self._credit(manager, lines)
            if lines:
                self._cursor_ns = max(self._cursor_ns, max(line.at_ns for line in lines))
            return credited

    def _credit(self, manager: 'SandboxManager', lines: Iterable[MirrorLine]) -> list[Pending]:
        pending: list[Pending] = []
        for line in lines:
            parsed = parse_mirror_line(line.line)
            if parsed is None:
                continue
            address, name, version = parsed
            key = manager.sandbox_at(address, line.at_ns)
            if key is None:
                log.debug(
                    'package telemetry: no recorded sandbox held %s then; its install of %s is dropped', address, name
                )
                continue
            context = self._contexts.get(key) or Context(manager.chat_of(key), '', self.lock_sha(), None, 0)
            pending.append((context, Event('install', name, version, line.at_ns // 1_000_000_000)))
        return pending

    async def prune(self) -> None:
        """Delete rows older than PACKAGE_EVENTS_RETENTION_DAYS; a failure is logged."""
        try:
            removed = await self._prune(int(self._wall_clock()) - PACKAGE_EVENTS_RETENTION_DAYS * 86_400)
        except Exception:
            log.warning('package telemetry: could not prune old events', exc_info=True)
            return
        if removed:
            log.info('package telemetry: pruned %d events older than %d days', removed, PACKAGE_EVENTS_RETENTION_DAYS)

    async def maintenance_loop(self, every_s: float = 3600) -> None:
        """Prune now, then every `every_s` seconds, until cancelled."""
        while True:
            await self.prune()
            await asyncio.sleep(every_s)


def truncate_argv() -> list[str]:
    """The argv that runs TRUNCATE_SCRIPT on EVENTS_PATH, for TRUNCATE_TIMEOUT_S."""
    return wrap_argv(
        [*GUEST_SHELL, '-c', TRUNCATE_SCRIPT, 'lllm-telemetry', EVENTS_PATH, EVENTS_PATH], TRUNCATE_TIMEOUT_S
    )


async def read_events(session: 'SandboxSession', *, now: int) -> list[Event]:
    """Read the guest's events file and empty it; its valid events.

    The daemon's stat (which does not follow a symlink) must show
    EVENTS_DIR a directory and EVENTS_PATH a regular file; anything else
    (missing, a symlink, a FIFO) is left alone and gives nothing. An empty
    file costs no exec. A file over EVENTS_MAX_BYTES is emptied unread. The
    read goes through the daemon (get_files, which omits a symlink and never
    goes through one), and the emptying through lllm-path in the guest
    (TRUNCATE_SCRIPT), as UID 1000, only when it resolves to exactly
    EVENTS_PATH. Nothing can change the file in between: the session holds
    the sandbox's lock, and the backend's post-exec kill has ended every
    process the command started (sandbox/workspace.py).

    Raises:
        SandboxError: The sandbox failed.
    """
    directory = await session.stat(EVENTS_DIR)
    if directory is None or directory.kind != 'dir':
        return []
    info = await session.stat(EVENTS_PATH)
    if info is None or info.kind != 'file' or info.size == 0:
        return []
    data = b''
    if info.size <= EVENTS_MAX_BYTES:
        data = (await session.get_files([EVENTS_PATH], EVENTS_MAX_BYTES)).get(EVENTS_PATH, b'')
    else:
        log.warning('package telemetry: sandbox %s wrote %d bytes of events; dropping them', session.key, info.size)
    result = await session.exec(truncate_argv(), TRUNCATE_TIMEOUT_S)
    if result.returncode != 0:
        log.warning('package telemetry: could not empty the events file of sandbox %s', session.key)
    events, dropped = parse_events(data, now=now)
    if dropped:
        log.info('package telemetry: dropped %d malformed event lines from sandbox %s', dropped, session.key)
    return events
