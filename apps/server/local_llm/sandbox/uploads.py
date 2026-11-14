"""The chat's attached files, copied read-only into `/workspace/uploads` before `bash` and `view` calls.

Which files: `chat_uploads` takes the chat's `metadata['files']` and keeps
the uploaded files (type `file` with an id, each id once) the user owns or may
read (`has_access_to_file`, checked on every call), and for the sync also the
workspace's owner (`chat_owner`): an admin working in another user's saved
chat (Q14) copies only what that user may read too, so none of the admin's
own files lands in their workspace. At most MAX_FILES of them, within
MAX_FILE_BYTES each and MAX_TOTAL_BYTES together, with a note for every file
left out. Each gets its base name made safe for the sandbox (safe_name: no
`/`, NUL or control characters, never `.` or `..`, at most 255 bytes of
UTF-8) and unique as `name (n).ext`, so a name can never make the copy fail.
It decides from the database alone (the size and hash recorded at upload)
wherever it can, so a call whose files have not changed fetches nothing from
storage.

The sync (`sync_uploads`) runs inside the tool's session, so under the
sandbox's lock. The backend's `put_uploads` makes `/workspace/uploads`, a
read-only mount of a directory kept outside the workspace volume, hold
exactly the files given: nothing in the guest can write, rename, remove or
`chmod` it or its files, so there is nothing to check before a sync. A
sync is skipped when the files (name, id, size and hash) are those of the
last put on the running sandbox, a record the manager keeps per sandbox key
(SandboxSession.synced_uploads) and drops whenever it forgets the sandbox
(stopped or destroyed), so every container start puts once, empty or not,
and a file removed while it was stopped goes. Otherwise the whole current
set is read and handed over (the backend keeps a file whose content is
unchanged). Each put is at most MAX_TOTAL_BYTES; the session waits for it to
end even when the user presses Stop, at most limits.CANCEL_WAIT_S.
"""

import asyncio
import logging
import os
import unicodedata
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Final

from local_llm.sandbox.limits import WORKSPACE

if TYPE_CHECKING:
    from local_llm.sandbox.manager import SandboxSession

log = logging.getLogger(__name__)

#: Copied files are capped, per file and in total; a sync puts at most MAX_TOTAL_BYTES at once.
MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_TOTAL_BYTES = 200 * 1024 * 1024

#: Where the uploads appear in the guest (a read-only mount; SandboxBackend.put_uploads).
UPLOADS_PATH: Final = f'{WORKSPACE}/uploads'


#: The most files one chat copies; the rest get one note.
MAX_FILES: Final = 100
#: The most distinct file ids one call looks up, kept or not, so a request listing many ids it cannot read (or that
#: do not exist) costs a bounded number of queries on every call.
MAX_LOOKUPS: Final = 2 * MAX_FILES
#: The longest name a file in the sandbox may have, in UTF-8 bytes (NAME_MAX).
MAX_NAME_BYTES: Final = 255


@dataclass(frozen=True)
class Upload:
    """One chat file to copy.

    Attributes:
        name: The name it gets in /workspace/uploads (safe_name, unique).
        file_id: The file's id.
        size: Its size in bytes, as recorded at upload, else as found in storage.
        file_hash: The sha256 recorded at upload, or None for a file without one.
        stored: Its path in storage (`file.path`), for Storage.get_file.
        path: Its local path when the selection already fetched it (no recorded size), else None.
    """

    name: str
    file_id: str
    size: int
    file_hash: str | None
    stored: str
    path: str | None = None


@dataclass(frozen=True)
class SyncedUploads:
    """What the last sync put into a running sandbox.

    Attributes:
        files: (name, file id, size, hash) of every file the sync was asked for and read, put or not.
        notes: The notes the put itself added (a file over a cap when read), repeated while nothing changes.
    """

    files: tuple[tuple[str, str, int, str | None], ...]
    notes: tuple[str, ...] = ()


def _printable(text: str) -> str:
    # Control and format characters (newlines, bidirectional overrides) and lone surrogates dropped: the name goes
    # into the guest's file table and into notes the model reads.
    return ''.join(ch for ch in text if unicodedata.category(ch) not in ('Cc', 'Cf', 'Cs'))


def _fit(stem: str, ext: str, suffix: str = '') -> str:
    """`stem + suffix + ext` within MAX_NAME_BYTES of UTF-8, cutting the stem on a character boundary."""
    room = MAX_NAME_BYTES - len((suffix + ext).encode())
    if room < 1:
        # An extension too long to keep.
        ext, room = '', MAX_NAME_BYTES - len(suffix.encode())
    return stem.encode()[:room].decode(errors='ignore') + suffix + ext


def safe_name(raw: str, fallback: str) -> str:
    """The base name of `raw` as a single path component the sandbox accepts, else `fallback` (made safe too).

    A backslash counts as a separator, control and format characters are
    dropped, and the result is cut to MAX_NAME_BYTES; empty, `.` and `..`
    give `fallback`.
    """
    for candidate in (raw, fallback):
        name = _printable(os.path.basename(str(candidate).replace('\\', '/')))
        stem, ext = os.path.splitext(name)
        name = _fit(stem, ext)
        if name not in ('', '.', '..'):
            return name
    return 'file'


def _listed(file: Any) -> tuple[int | None, str | None]:
    """The size and sha256 recorded at upload (`file.meta`), each None when missing or malformed."""
    meta = getattr(file, 'meta', None)
    meta = meta if isinstance(meta, dict) else {}
    size, digest = meta.get('size'), meta.get('file_hash')
    return (size if type(size) is int and size >= 0 else None), (digest if isinstance(digest, str) else None)


def _over_limit(name: str, max_file_bytes: int, max_total_bytes: int) -> str:
    return (
        f'{name}: not copied, over the {max_file_bytes // 2**20} MB per file'
        f' or {max_total_bytes // 2**20} MB total limit'
    )


async def _may_read(file: Any, reader: Any) -> bool:
    from local_llm.utils.access_control.files import has_access_to_file

    return reader is not None and (file.user_id == reader.id or await has_access_to_file(file.id, 'read', reader))


async def chat_owner(chat_id: object, user: Any) -> Any | None:
    """Whose workspace the chat's sandbox is: the caller for an unsaved chat (Q12) or the saved chat's owner.

    For an admin in another user's saved chat (Q14) that is the owner's
    account, looked up; None when it cannot be told (no user or chat id, the
    chat or its owner not found, a database error), which copies nothing.
    """
    from local_llm.models.chats import Chats
    from local_llm.models.users import Users
    from local_llm.utils.chat_id import NON_SAVED_CHAT_ID_PREFIXES

    if user is None or not isinstance(chat_id, str) or not chat_id:
        return None
    if chat_id.startswith(NON_SAVED_CHAT_ID_PREFIXES) or await Chats.is_chat_owner(chat_id, user.id):
        return user
    try:
        chat = await Chats.get_chat_by_id(chat_id)
        return None if chat is None else await Users.get_user_by_id(chat.user_id)
    except Exception:
        log.exception('could not look up the owner of chat %s; copying no uploads', chat_id)
        return None


async def chat_uploads(
    items: list | None,
    user: Any,
    *,
    max_file_bytes: int | None = None,
    max_total_bytes: int | None = None,
    owner_lookup: Callable[[], Awaitable[Any]] | None = None,
) -> tuple[list[Upload], list[str]]:
    """The chat's uploaded files this user may read, and a note for each file left out.

    `items` is the chat's `metadata['files']`. Only uploaded files count
    (type 'file' with a str id), each id once: knowledge bases, web results
    and images are not files on disk. Each one is re-checked against the
    user, since the list comes from the request. Past MAX_FILES files, the
    rest are not looked up, nor ids past the first MAX_LOOKUPS distinct
    ones, and one note counts them. With `owner_lookup` (chat_owner, for the
    sync), the workspace's owner is looked up at the first file item, never
    for a call without one, and each file must be readable by the owner too,
    unless that is the user; an owner that cannot be told (None) copies
    nothing, with one note and no file lookup. A file's size comes
    from what was recorded at upload; only a file without one is fetched
    from storage here. The caps default to MAX_FILE_BYTES and
    MAX_TOTAL_BYTES, read when called.
    """
    max_file_bytes = MAX_FILE_BYTES if max_file_bytes is None else max_file_bytes
    max_total_bytes = MAX_TOTAL_BYTES if max_total_bytes is None else max_total_bytes
    from local_llm.models.files import Files
    from local_llm.storage.provider import Storage

    files: list[Upload] = []
    notes: list[str] = []
    names: set[str] = set()
    seen: set[str] = set()
    beyond = 0
    total = 0
    owner: Any = user
    for item in items or []:
        file_id = item.get('id') if isinstance(item, dict) and item.get('type') == 'file' else None
        if not isinstance(file_id, str) or not file_id or file_id in seen:
            continue
        if not seen and owner_lookup is not None:
            owner = await owner_lookup()
            if owner is None:
                return [], ["The attached files were not copied: this chat's owner could not be looked up"]
        seen.add(file_id)
        if len(files) >= MAX_FILES or len(seen) > MAX_LOOKUPS:
            beyond += 1
            continue
        file = await Files.get_file_by_id(file_id)
        if not file or not file.path or user is None:
            continue
        if not await _may_read(file, user):
            continue
        name = safe_name(file.filename or item.get('name') or file.id, file.id)
        if owner is not user and owner.id != user.id and not await _may_read(file, owner):
            notes.append(f"{name}: not copied, this chat's owner may not read it")
            continue
        size, digest = _listed(file)
        path = None
        if size is None:
            try:
                path = await asyncio.to_thread(Storage.get_file, file.path)
                size = await asyncio.to_thread(os.path.getsize, path)
            except Exception as err:
                log.warning('chat file %s is not readable: %s', file.id, err)
                notes.append(f'{name}: could not be read')
                continue
        if size > max_file_bytes or total + size > max_total_bytes:
            notes.append(_over_limit(name, max_file_bytes, max_total_bytes))
            continue
        stem, ext = os.path.splitext(name)
        n = 1
        while name in names:
            n += 1
            name = _fit(stem, ext, f' ({n})')
        names.add(name)
        total += size
        files.append(Upload(name, file.id, size, digest, file.path, path))
    if beyond:
        notes.append(
            f'{beyond} more attached file(s) not copied: at most {MAX_FILES} files are copied,'
            f' from the first {MAX_LOOKUPS} listed'
        )
    return files, notes


async def _local_path(upload: Upload) -> str:
    if upload.path is not None:
        return upload.path
    from local_llm.storage.provider import Storage

    return await asyncio.to_thread(Storage.get_file, upload.stored)


def _read_at_most(path: str, limit: int) -> bytes:
    with open(path, 'rb') as f:
        return f.read(limit)


async def sync_uploads(
    session: 'SandboxSession', items: list | None, user: Any, owner_lookup: Callable[[], Awaitable[Any]]
) -> list[str]:
    """Make the sandbox's read-only `/workspace/uploads` hold exactly the chat's current files.

    `owner_lookup` gives the workspace's owner (chat_owner), asked only when
    the chat has files: only files they may read too are copied, and none
    when it gives None. A file that could not be read is left out of the
    record, so the next call tries it again. Returns the notes for files
    left out (over a cap, not readable, past MAX_FILES, not the owner's to
    read), for the tool result's stderr. Nothing is fetched from storage
    unless a put is needed. Each file is read up to the caps that remain,
    whatever its recorded size, so a file that changed since it was listed
    cannot carry a put past them.

    Raises:
        SandboxError: The backend could not put the files.
    """
    uploads, notes = await chat_uploads(items, user, owner_lookup=owner_lookup)
    wanted = tuple((u.name, u.file_id, u.size, u.file_hash) for u in uploads)
    record = session.synced_uploads
    if record is not None and record.files == wanted:
        return [*notes, *record.notes]
    # Dropped first, so a put that fails or is cancelled leaves no record and the next call puts again.
    session.synced_uploads = None
    contents: list[tuple[str, bytes]] = []
    put_notes: list[str] = []
    unread: list[str] = []
    total = 0
    for upload in uploads:
        limit = min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total)
        try:
            content = await asyncio.to_thread(_read_at_most, await _local_path(upload), limit + 1)
        except Exception as err:
            log.warning('chat file %s is not readable: %s', upload.file_id, err)
            unread.append(upload.name)
            continue
        if len(content) > limit:
            put_notes.append(_over_limit(upload.name, MAX_FILE_BYTES, MAX_TOTAL_BYTES))
            continue
        contents.append((upload.name, content))
        total += len(content)
    await session.put_uploads(contents)
    # A read failure may be passing (a storage hiccup): the file is not recorded, so the next call puts again.
    session.synced_uploads = SyncedUploads(tuple(w for w in wanted if w[0] not in unread), tuple(put_notes))
    return [*notes, *put_notes, *(f'{name}: could not be read' for name in unread)]
