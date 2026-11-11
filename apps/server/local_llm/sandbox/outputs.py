"""What a `bash` call leaves in /workspace/outputs: found, attached to the message, previewed, and served safely.

The `bash` tool lists /workspace/outputs before and after the model's
command, inside the same SandboxManager.session block (list_outputs), and
attaches what is new or changed (changed_entries, collect): each file is read
back with get_files and stored as a File row marked `meta.source =
'sandbox_output'`, linked to the message. A PDF also gets PNG previews of its
first pages, rendered in the sandbox. The routes that serve file content
(routers/files.py) never render such a file on the app's origin; the one way
to show an HTML output is GET /api/v1/sandbox/outputs/{id}/html
(routers/sandbox.py), which returns it as JSON, with with_policy's
Content-Security-Policy in front, for a sandboxed iframe's `srcdoc`.

The listing trusts as little of the guest as workspace.py's helpers do, and
for the same reasons (its docstring has them): the script is fixed text run
with an empty environment and absolute paths, `find -P` never follows a
symlink, so every path it prints is symlink-free, and nothing the model
started is running while the listing, the reads and the stats run. Names are
NUL-delimited, since a model-chosen name may hold a tab or a newline. What
the guest prints is still parsed as untrusted: a record that does not parse,
or a path that is not normalised under /workspace/outputs, is dropped.
"""

import asyncio
import codecs
import hashlib
import io
import logging
import mimetypes
import posixpath
import re
import time
import unicodedata
import uuid
from dataclasses import dataclass, field
from typing import Any, Final, cast

from local_llm.sandbox.backend import validate_sandbox_path
from local_llm.sandbox.exec import wrap_argv
from local_llm.sandbox.limits import (
    HELPER_TIMEOUT_S,
    OUTPUT_CALL_CAP_BYTES,
    OUTPUT_CHAT_CAP_BYTES,
    OUTPUT_FILE_CAP_BYTES,
    OUTPUT_MAX_FILES,
    PREVIEW_DPI,
    PREVIEW_MAX_BYTES,
    PREVIEW_MAX_PAGES,
    PREVIEW_MAX_PDFS,
    PREVIEW_MAX_SIDE,
    WORKSPACE,
)
from local_llm.sandbox.manager import SandboxSession
from local_llm.sandbox.types import SandboxError
from local_llm.sandbox.workspace import GUEST_SHELL, image_size, image_type
from local_llm.utils.chat_id import is_saved_chat_id

log = logging.getLogger(__name__)

#: The directory whose new and changed files are attached to the message.
OUTPUTS_DIR: Final = f'{WORKSPACE}/outputs'
#: The `meta.source` of every File row made from a sandbox file; the file routes never render such a file.
SANDBOX_OUTPUT: Final = 'sandbox_output'
#: The most bytes a listing returns; under STREAM_CAP_CHARS, so the stream cap never splices two records together.
LISTING_CAP_BYTES: Final = 16_384
#: The last record of a listing that was not cut short.
_END: Final = 'END'

#: Where a PDF's previews are rendered, one directory per PDF, emptied before each render.
PREVIEWS_DIR: Final = f'{WORKSPACE}/.lllm/previews'

#: The policy put in front of every HTML output shown in the browser: no fetches or loads (images and fonts only
#: from data: and blob:), no form submissions, inline script and style only, and no <base> (base-uri does not fall
#: back to default-src). It is not "no network": CSP covers neither the frame navigating itself nor WebRTC (plan
#: Q4). A policy the document sets itself can only narrow it further.
HTML_POLICY: Final = (
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; "
    "style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'\">"
)

#: Lists /workspace/outputs as NUL-ended `<mtime>\t<size>\t<path>` records, newest first, then an `END` record, at
#: most LISTING_CAP_BYTES in all: `END` is missing when the cap cut the listing short (or sort failed). Regular
#: files UID 1000 can read only, never through a symlink (`-P`) or into another filesystem (`-xdev`). Sorting
#: makes the cut fall in the same place for the same files, so a cut listing's newest files are still compared.
#: find's complaints (a directory it cannot enter) are dropped: on stderr they would count toward the stream cap,
#: and a capped stream fails the listing.
LIST_SCRIPT: Final = (
    f"{{ /usr/bin/find -P {OUTPUTS_DIR} -xdev -type f -readable -printf '%T@\\t%s\\t%P\\0' 2>/dev/null "
    f"| /usr/bin/sort -z -r -n && printf '{_END}\\0'; }} | /usr/bin/head -c {LISTING_CAP_BYTES}\n"
)

#: Renders the first PREVIEW_MAX_PAGES pages of the PDF "$1" as PNGs `page-<n>.png` in PREVIEWS_DIR, which it
#: removes and makes again first, so it holds this PDF's pages only (collect reads each PDF's pages before the next
#: render). Refuses a /workspace/.lllm that is a symlink or not a directory. Its output is not read: the pages are
#: listed by PREVIEW_LIST_SCRIPT in a separate exec, once the post-exec kill has ended anything pdftoppm left behind.
PREVIEW_SCRIPT: Final = (
    f'b={WORKSPACE}/.lllm\n'
    'if [ -L "$b" ] || { [ -e "$b" ] && [ ! -d "$b" ]; }; then exit 1; fi\n'
    '/usr/bin/mkdir -p -- "$b" || exit 1\n'
    f'/usr/bin/rm -rf -- {PREVIEWS_DIR} || exit 1\n'
    f'/usr/bin/mkdir -m 700 -- {PREVIEWS_DIR} || exit 1\n'
    f'exec /usr/bin/pdftoppm -png -r {PREVIEW_DPI} -l {PREVIEW_MAX_PAGES} '
    f'-W {PREVIEW_MAX_SIDE} -H {PREVIEW_MAX_SIDE} "$1" {PREVIEWS_DIR}/page >/dev/null 2>&1\n'
)

#: Lists the PNGs in PREVIEWS_DIR as NUL-ended names.
PREVIEW_LIST_SCRIPT: Final = (
    f"/usr/bin/find -P {PREVIEWS_DIR} -mindepth 1 -maxdepth 1 -type f -name 'page-*.png' -printf '%P\\0' "
    f'2>/dev/null | /usr/bin/head -c {LISTING_CAP_BYTES}\n'
)

_MTIME = re.compile(r'-?[0-9]{1,15}(\.[0-9]{1,12})?', re.ASCII)
_SIZE = re.compile(r'[0-9]{1,15}', re.ASCII)
_OVER_CALL = f'the files of this call are over the {OUTPUT_CALL_CAP_BYTES // (1024 * 1024)} MiB limit in all'
_STOPPED = 'the sandbox stopped before it was read'
_UNCHANGED = 'its content is the same as when it was last attached'
_OVER_CHAT = (
    f'it would take the files attached in this chat past their {OUTPUT_CHAT_CAP_BYTES // (1024 * 1024 * 1024)} GiB '
    'limit, so no more can be attached in this chat'
)
_PREVIEWS_CUT = 'only some pages were previewed: the limits on files and bytes were reached'
_PAGE = re.compile(r'page-0*([1-9][0-9]*)\.png', re.ASCII)
# The longest display and storage name kept, in UTF-8 bytes, so `<uuid>_<name>` stays under a 255-byte file name.
_NAME_MAX_BYTES = 200
# Only whitespace may come before a doctype the policy goes after: anything else the HTML parser reads as text,
# which opens <body>, and a policy <meta> outside <head> is ignored. ASCII only, as the parser matches DOCTYPE, and
# `[^>]*` because every DOCTYPE tokenizer state, quoted identifiers included, ends at the first `>`.
_DOCTYPE = re.compile(r'[\t\n\f\r ]*<!doctype[^>]*>', re.ASCII | re.IGNORECASE)


@dataclass(frozen=True)
class OutputEntry:
    """One file in /workspace/outputs as the listing saw it.

    Attributes:
        name: Its path relative to /workspace/outputs, as decoded from the
            guest (a name that is not UTF-8 holds U+FFFD).
        size: Its size in bytes.
        mtime: Its modification time as `find` printed it, compared as text.
    """

    name: str
    size: int
    mtime: str

    @property
    def path(self) -> str:
        """Its absolute path in the sandbox."""
        return f'{OUTPUTS_DIR}/{self.name}'


@dataclass(frozen=True)
class Listing:
    """/workspace/outputs at one moment.

    Attributes:
        entries: The files listed, by name, newest first.
        complete: The listing holds every file; when False, it holds the
            newest that fit LISTING_CAP_BYTES.
    """

    entries: dict[str, OutputEntry] = field(default_factory=dict)
    complete: bool = True


@dataclass
class Collected:
    """What collect attached.

    Attributes:
        outputs: One dict per file found, for the tool result's `outputs`:
            its `path` (relative to /workspace), `name`, `size` and
            `content_type`, then either `file_id` and `url` (attached),
            `reason` (not attached), or neither (listed only, when uploads
            are off).
        files: The message files to send in the `files` event, previews
            included, each with the `meta` the frontend reads (`source`,
            `sandbox_path`, `content_type`, and `preview_of` and
            `preview_page` for a preview).
        error: The sandbox failure that ended the collection early, if one
            did; what was stored before it is still in `files` and linked.
        stored_bytes: The bytes stored, previews included.
    """

    outputs: list[dict] = field(default_factory=list)
    files: list[dict] = field(default_factory=list)
    error: SandboxError | None = None
    stored_bytes: int = 0


#: The Content-Security-Policy the file routes send with every sandbox output, beside `attachment` and `nosniff`:
#: should one be rendered as a document anyway (in an <object>, say), nothing in it runs or loads.
SERVED_POLICY: Final = "default-src 'none'; sandbox"
# The types a sandbox output keeps when served; anything else is application/octet-stream. Images, PDF, audio and
# video, which the reply shows through <img> and the like. SVG among them: an <img> needs its type to show it and
# never runs its script, and as a document it is a download that SERVED_POLICY would keep inert.
_SERVED_TYPES: Final = ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'application/pdf')


def served_type(media_type: object) -> str:
    """The Content-Type the file routes serve a sandbox output with: its own for an image, a PDF, audio or video,
    else application/octet-stream, so no output is served as HTML, script or a style sheet."""
    if isinstance(media_type, str) and (media_type in _SERVED_TYPES or media_type.startswith(('audio/', 'video/'))):
        return media_type
    return 'application/octet-stream'


def is_sandbox_output(meta: dict | None) -> bool:
    """Whether a File row's `meta` marks it as a file read back from a sandbox."""
    return isinstance(meta, dict) and meta.get('source') == SANDBOX_OUTPUT


def list_argv() -> list[str]:
    """The argv that runs LIST_SCRIPT, for HELPER_TIMEOUT_S."""
    return wrap_argv([*GUEST_SHELL, '-c', LIST_SCRIPT, 'lllm-outputs'], HELPER_TIMEOUT_S)


def parse_listing(stdout: str) -> Listing:
    """Read LIST_SCRIPT's output: records that do not parse, or name a path outside /workspace/outputs, are dropped.

    The listing is complete only when its last record is `END`, followed by
    its NUL; whatever follows the last NUL is a record the cap cut short.
    """
    records = stdout.split('\0')
    complete = records.pop() == '' and bool(records) and records[-1] == _END
    if complete:
        records.pop()
    entries: dict[str, OutputEntry] = {}
    for record in records:
        mtime, _, rest = record.partition('\t')
        size, _, name = rest.partition('\t')
        if not _MTIME.fullmatch(mtime) or not _SIZE.fullmatch(size) or not name:
            continue
        entry = OutputEntry(name, int(size), mtime)
        try:
            validate_sandbox_path(entry.path)
        except ValueError:
            continue
        entries.setdefault(name, entry)
    return Listing(entries, complete)


async def list_outputs(session: SandboxSession) -> Listing | None:
    """/workspace/outputs now: empty when it is missing, a symlink or not a directory; None when it cannot be listed.

    Raises:
        SandboxError: The sandbox failed.
    """
    info = await session.stat(OUTPUTS_DIR)
    if info is None or info.kind != 'dir':
        return Listing()
    result = await session.exec(list_argv(), HELPER_TIMEOUT_S)
    if result.returncode != 0 or result.truncated:
        log.warning('the outputs listing failed: exit status %s, %r', result.returncode, result.stderr[:200])
        return None
    return parse_listing(result.stdout)


def changed_entries(before: Listing, after: Listing) -> list[OutputEntry]:
    """The files in `after` that are new since `before`, or changed in size or modification time, newest first.

    When `before` was cut short, a file it does not hold counts as new only
    if it is newer than the oldest file it does hold; older ones may have
    been there already, just past the cut.
    """
    cutoff: float | None = None
    if not before.complete:
        if not before.entries:
            return []
        cutoff = min(float(entry.mtime) for entry in before.entries.values())
    found = []
    for name, entry in after.entries.items():
        old = before.entries.get(name)
        if old is None:
            if cutoff is None or float(entry.mtime) > cutoff:
                found.append(entry)
        elif (old.size, old.mtime) != (entry.size, entry.mtime):
            found.append(entry)
    return found


def display_name(name: str) -> str:
    """The base name of `name` with control and format characters (bidi overrides among them) replaced, cut short.

    At most _NAME_MAX_BYTES bytes of UTF-8, the extension kept when it is
    short; `output` for a name with nothing left.
    """
    base = ''.join('_' if unicodedata.category(c) in ('Cc', 'Cf', 'Cs') else c for c in posixpath.basename(name))
    base = base.strip() or 'output'
    stem, ext = posixpath.splitext(base)
    if len(ext.encode('utf-8')) > 16:
        stem, ext = base, ''
    while len((stem + ext).encode('utf-8')) > _NAME_MAX_BYTES:
        stem = stem[:-1]
    return (stem + ext) or 'output'


def content_type(name: str) -> str:
    """The media type a file of this name is stored with, by its extension."""
    return mimetypes.guess_type(name, strict=False)[0] or 'application/octet-stream'


async def _store(
    request: Any, user: Any, chat_id: str, data: bytes, name: str, media_type: str, meta: dict, digest: str
) -> tuple[dict, dict] | None:
    """Store `data` (whose SHA-256 is `digest`) as a File row owned by `user`, with `meta` merged into its own;
    (row, descriptor), or None when the blob or the row could not be written, and then neither is left.

    The row is inserted with `meta.source` already set, so no moment exists
    in which the file routes would treat it as an ordinary file.
    """
    # Imported here, as the rest of sandbox/ does, so the package loads without the database and storage.
    from local_llm.models.files import FileForm, Files
    from local_llm.storage.provider import Storage

    file_id = str(uuid.uuid4())
    tags = {
        'LLLM-User-Email': user.email,
        'LLLM-User-Id': user.id,
        'LLLM-User-Name': user.name,
        'LLLM-File-Id': file_id,
    }
    try:
        _, stored_path = await asyncio.to_thread(Storage.upload_file, io.BytesIO(data), f'{file_id}_{name}', tags)
    except Exception:
        log.exception('could not store sandbox output %r', name)
        return None
    file_meta = {
        'name': name,
        'content_type': media_type,
        'size': len(data),
        'file_hash': digest,
        **meta,
        # Set last, by the server, so nothing in `meta` replaces them: chat_usage counts by them.
        'source': SANDBOX_OUTPUT,
        'chat_id': chat_id,
        'stored_ns': time.time_ns(),
    }
    url = str(request.app.url_path_for('get_file_content_by_id', id=file_id))
    try:
        row = await Files.insert_new_file(
            user.id, FileForm(id=file_id, filename=name, path=stored_path, data={}, meta=file_meta)
        )
    except Exception:
        log.exception('could not record sandbox output %r', name)
        row = None
    if row is None:
        await asyncio.to_thread(Storage.delete_file, stored_path)
        return None
    descriptor = {
        'type': 'file',
        'id': file_id,
        'url': url,
        'name': name,
        'size': len(data),
        'meta': {key: file_meta[key] for key in ('source', 'sandbox_path', 'content_type', *meta) if key in file_meta},
    }
    return {'file_id': file_id, 'url': url}, descriptor


def preview_argv(pdf: str) -> list[str]:
    """The argv that runs PREVIEW_SCRIPT on the PDF `pdf`, for HELPER_TIMEOUT_S."""
    return wrap_argv([*GUEST_SHELL, '-c', PREVIEW_SCRIPT, 'lllm-preview', pdf], HELPER_TIMEOUT_S)


def preview_list_argv() -> list[str]:
    """The argv that runs PREVIEW_LIST_SCRIPT, for HELPER_TIMEOUT_S."""
    return wrap_argv([*GUEST_SHELL, '-c', PREVIEW_LIST_SCRIPT, 'lllm-preview-list'], HELPER_TIMEOUT_S)


def _preview_ok(data: bytes) -> bool:
    if image_type(data) != 'image/png':
        return False
    size = image_size(data, 'image/png')
    return size is not None and max(size) <= PREVIEW_MAX_SIDE


async def render_previews(session: SandboxSession, pdf: str) -> list[tuple[int, bytes]]:
    """(page number, PNG) for the first pages of the PDF at `pdf` (a path from the listing); [] when none render.

    pdftoppm runs as UID 1000 on a file the model wrote, so it is treated as
    the model's code: its pages are listed in a later exec, after the
    post-exec kill, from PREVIEWS_DIR once the daemon confirms it and
    /workspace/.lllm are real directories, and each page must be a PNG of at
    most PREVIEW_MAX_SIDE pixels a side and PREVIEW_MAX_BYTES bytes.

    Raises:
        SandboxError: The sandbox failed.
    """
    result = await session.exec(preview_argv(pdf), HELPER_TIMEOUT_S)
    if result.returncode != 0:
        log.info('no previews of %r: exit status %s', pdf, result.returncode)
        return []
    listed = await session.exec(preview_list_argv(), HELPER_TIMEOUT_S)
    if listed.returncode != 0 or listed.truncated:
        return []
    pages: dict[int, str] = {}
    for name in listed.stdout.split('\0')[:-1]:
        match = _PAGE.fullmatch(name)
        if match and int(match.group(1)) <= PREVIEW_MAX_PAGES:
            pages.setdefault(int(match.group(1)), f'{PREVIEWS_DIR}/{name}')
    for parent in (posixpath.dirname(PREVIEWS_DIR), PREVIEWS_DIR):
        info = await session.stat(parent)
        if info is None or info.kind != 'dir':
            return []
    images = []
    for number in sorted(pages):
        data = (await session.get_files([pages[number]], PREVIEW_MAX_BYTES)).get(pages[number])
        if data is not None and _preview_ok(data):
            images.append((number, data))
    return images


@dataclass
class _Allowance:
    """What a call may still read (files and bytes, OUTPUT_MAX_FILES and OUTPUT_CALL_CAP_BYTES), and what the chat may
    still store (bytes, None for no bound)."""

    call: int
    chat: int | None
    files: int = 0

    def refusal(self, size: int) -> str | None:
        """Why `size` more bytes may not be read in this call, or None."""
        return _OVER_CALL if size > self.call else None

    def chat_refusal(self, size: int) -> str | None:
        """Why `size` more bytes may not be stored in this chat, or None."""
        return _OVER_CHAT if self.chat is not None and size > self.chat else None

    def read(self, size: int) -> None:
        self.call -= size
        self.files += 1

    def store(self, size: int) -> None:
        if self.chat is not None:
            self.chat -= size


def _refusal(entry: OutputEntry, allowance: _Allowance) -> str | None:
    """Why `entry` is not attached before it is read, or None."""
    if allowance.files >= OUTPUT_MAX_FILES:
        return f'more than {OUTPUT_MAX_FILES} files were new or changed in this call'
    if '\ufffd' in entry.name:
        return 'its name is not valid UTF-8 (or holds U+FFFD); rename it'
    if entry.size == 0:
        return 'it is empty'
    if entry.size > OUTPUT_FILE_CAP_BYTES:
        return f'it is over the {OUTPUT_FILE_CAP_BYTES // (1024 * 1024)} MiB limit for one file'
    return allowance.refusal(entry.size)


def describe(entry: OutputEntry) -> dict:
    """How `entry` starts in the tool result's `outputs`: its path relative to /workspace, name, size and type."""
    name = display_name(entry.name)
    return {'path': f'outputs/{entry.name}', 'name': name, 'size': entry.size, 'content_type': content_type(name)}


async def _read_output(session: SandboxSession, entry: OutputEntry, allowance: _Allowance) -> bytes | str:
    """`entry`'s bytes, or why it is not attached: gone, no longer a regular file, or over what is left.

    Raises:
        SandboxError: The sandbox failed.
    """
    data = (await session.get_files([entry.path], OUTPUT_FILE_CAP_BYTES)).get(entry.path)
    if not data:
        return 'it could not be read back as a regular file within the limits'
    return allowance.refusal(len(data)) or data


async def collect(
    session: SandboxSession,
    entries: list[OutputEntry],
    *,
    request: Any,
    user: Any,
    chat_id: str | None,
    message_id: str | None,
    upload: bool = True,
    chat_left: int | None = None,
    stored: dict[str, tuple[str, str]] | None = None,
    into: Collected | None = None,
) -> Collected:
    """Attach `entries` (from changed_entries) to the message, within the caps; with `upload` off, only list them.

    The per-call caps count every file read, PDF preview pages included: at
    most OUTPUT_MAX_FILES files and OUTPUT_CALL_CAP_BYTES bytes. What is
    stored may not pass `chat_left` bytes, what the chat's cap
    (OUTPUT_CHAT_CAP_BYTES) has left (the caller works it out; None for no
    bound). A file whose bytes are those of the last row stored for its path
    (`stored`: by sandbox path, the SHA-256 and file id, kept by the caller
    and updated here) is read but not stored or attached again.

    Each file is read, stored, recorded in the result and linked to the
    message (Chats.insert_chat_files, when the chat is saved) before the next
    is read, so at most one is held at a time, and a call cut short (a Stop,
    a database error) leaves unlinked at most the one row it was linking,
    which is still recorded: pass `into` to keep what was recorded when this
    raises. A file that cannot be
    attached is named with the reason, and nothing about one file stops the
    others. The PDFs are previewed after every file has been read, since
    pdftoppm, run on a model-written file, may change the workspace.

    A sandbox failure (SandboxError) ends the collection without raising:
    the files not yet read are named as not attached, no more previews are
    made, and the failure is in `error`.
    """
    collected = Collected() if into is None else into
    allowance = _Allowance(call=OUTPUT_CALL_CAP_BYTES, chat=chat_left)
    known = {} if stored is None else stored
    link = bool(chat_id and message_id and is_saved_chat_id(chat_id))

    async def keep(
        data: bytes, name: str, media_type: str, meta: dict, item: dict | None = None, digest: str = ''
    ) -> str | None:
        """Store one file, record it, then link it; its file id, or None when it could not be stored."""
        digest = digest or hashlib.sha256(data).hexdigest()
        result = await _store(request, user, chat_id or '', data, name, media_type, meta, digest)
        if result is None:
            return None
        ref, descriptor = result
        allowance.store(len(data))
        collected.stored_bytes += len(data)
        if item is not None:
            item.update(ref)
            known[meta['sandbox_path']] = (digest, ref['file_id'])
        collected.files.append(descriptor)
        if link:
            from local_llm.models.chats import Chats

            await Chats.insert_chat_files(
                chat_id=cast(str, chat_id), message_id=cast(str, message_id), file_ids=[ref['file_id']], user_id=user.id
            )
        return ref['file_id']

    pdfs: list[tuple[str, str, str, dict]] = []
    for entry in entries:
        item = describe(entry)
        name, media_type = item['name'], item['content_type']
        collected.outputs.append(item)
        reason = _refusal(entry, allowance) or (_STOPPED if collected.error is not None else None)
        if reason is None and not upload:
            allowance.read(entry.size)
            continue
        if reason is None:
            try:
                data = await _read_output(session, entry, allowance)
            except SandboxError as exc:
                collected.error, data = exc, _STOPPED
            if isinstance(data, str):
                reason = data
            else:
                item['size'] = len(data)
                allowance.read(len(data))
                digest = hashlib.sha256(data).hexdigest()
                unchanged = known.get(entry.path, ('',))[0] == digest
                reason = _UNCHANGED if unchanged else allowance.chat_refusal(len(data))
                if reason is None:
                    file_id = await keep(data, name, media_type, {'sandbox_path': entry.path}, item, digest)
                    if file_id is None:
                        reason = 'it could not be stored'
                    elif media_type == 'application/pdf' and len(pdfs) < PREVIEW_MAX_PDFS:
                        pdfs.append((entry.path, file_id, name, item))
        if reason is not None:
            item['reason'] = reason
    for path, pdf_id, name, item in pdfs:
        if collected.error is not None:
            break
        try:
            pages = await render_previews(session, path)
        except SandboxError as exc:
            collected.error, pages = exc, []
        for page, png in pages:
            if allowance.files >= OUTPUT_MAX_FILES or allowance.refusal(len(png)) or allowance.chat_refusal(len(png)):
                item['previews'] = _PREVIEWS_CUT
                break
            allowance.read(len(png))
            meta = {'sandbox_path': path, 'preview_of': pdf_id, 'preview_page': page}
            await keep(png, display_name(f'{name}-page-{page}.png'), 'image/png', meta)
    return collected


async def chat_usage(chat_id: str, user_id: str | None = None) -> tuple[int, dict[str, tuple[str, str]]]:
    """A chat's sandbox outputs, from the File rows the server marked as this chat's (`meta.source` and
    `meta.chat_id`, set by _store, which nothing a client sends can set), with `user_id` also their owner's when
    given: their bytes in all, previews included, and by sandbox path the SHA-256 and file id of the last output
    stored for it (previews left out).

    The rows are counted whether or not they are linked to a message, so the
    count holds for an unsaved chat, a call with no message id, and across a
    stopped sandbox or a restarted server. "Last" is by `created_at`, then
    `meta.stored_ns` (the store's clock in nanoseconds), then the row's id.
    """
    from sqlalchemy import select

    from local_llm.internal.db import get_async_db_context
    from local_llm.models.files import File

    query = select(File.id, File.meta, File.created_at).where(
        File.meta['source'].as_string() == SANDBOX_OUTPUT, File.meta['chat_id'].as_string() == chat_id
    )
    if user_id is not None:
        query = query.where(File.user_id == user_id)
    async with get_async_db_context() as db:
        rows = (await db.execute(query)).all()
    used = 0
    latest: dict[str, tuple[str, str]] = {}
    for file_id, meta, _ in sorted(rows, key=_row_order):
        size = meta.get('size')
        used += size if type(size) is int and size > 0 else 0
        path, digest = meta.get('sandbox_path'), meta.get('file_hash')
        if 'preview_of' not in meta and isinstance(path, str) and isinstance(digest, str):
            latest[path] = (digest, file_id)
    return used, latest


def _row_order(row: Any) -> tuple[int, int, str]:
    file_id, meta, created_at = row
    stored_ns = meta.get('stored_ns') if isinstance(meta, dict) else None
    return (
        created_at if type(created_at) is int else 0,
        stored_ns if type(stored_ns) is int else 0,
        file_id,
    )


def decode_html(data: bytes) -> str:
    """An HTML file's text, decoded as a browser would without a charset: by its BOM (UTF-8, UTF-16), else UTF-8.

    The BOM is consumed. A `srcdoc` is already text, so whatever charset the
    document declares has no effect there.
    """
    if data.startswith(codecs.BOM_UTF8):
        return data[len(codecs.BOM_UTF8) :].decode('utf-8', errors='replace')
    if data.startswith(codecs.BOM_UTF16_LE):
        return data[2:].decode('utf-16-le', errors='replace')
    if data.startswith(codecs.BOM_UTF16_BE):
        return data[2:].decode('utf-16-be', errors='replace')
    return data.decode('utf-8', errors='replace')


def with_policy(document: str) -> str:
    """`document` with HTML_POLICY as its first element, after a leading doctype if it has one.

    The policy must come before anything that could run or load, and must
    land in <head>, or the browser ignores it. Whitespace and one doctype are
    the only things the HTML parser lets come first without opening <body>,
    so the policy goes after exactly those, and at the very start otherwise
    (a comment, a BOM left in the text, an NBSP, or any other character
    before the doctype included; the doctype after it is then ignored, which
    costs only quirks mode). A policy the document declares itself is kept:
    it can only narrow this one.
    """
    match = _DOCTYPE.match(document)
    at = match.end() if match else 0
    return document[:at] + HTML_POLICY + document[at:]
