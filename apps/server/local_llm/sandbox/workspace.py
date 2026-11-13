"""What the sandbox's file tools do: confine a model's path to /workspace, then act on it there.

The tools `view`, `write_file` and `str_replace` (tools/builtin.py) call the
functions here inside one SandboxManager.session block. Every path a model
gives them is checked twice:

1. On the host, before anything runs (confine): a str without NUL or newline,
   1 to 4,096 bytes of UTF-8, relative (taken from /workspace) or absolute
   under /workspace, with no `..` that leaves it.
2. In the guest, by `/usr/local/bin/lllm-path` (one source:
   infra/sandbox/common/lllm-path), run as UID 1000, since only the guest
   sees its own symlinks: it resolves the path as `realpath -m` does and
   refuses a result outside /workspace or with a symlink or an unsearchable
   directory left on it. The path it prints is checked again here before the
   daemon-side `stat` and `get_files` use it; they never follow a final
   symlink, and the printed path has none anywhere. For a read, the same
   exec also checks that UID 1000 may read the file (READ_SCRIPT), so the
   daemon's reads, which run as root, return nothing `bash` could not.

Between the resolution and its use, nothing may change the files. That rests
on three things, all of which must hold:

- the tool runs every step in one session, which holds the sandbox's lock,
  so no other call on the chat runs meanwhile;
- SandboxSession.exec neither returns nor raises, cancellation included,
  until the backend's exec and its post-exec kill have both completed, so
  a cancelled call cannot hand the lock on while its command still runs;
- the backend's post-exec kill (SandboxBackend.exec) returns only once no
  UID 1000 process is left, and stops the sandbox when it cannot confirm
  that.

So no process the model started is alive during a helper's exec or the
daemon calls after it. The per-chat lock is per process: the manager must
run in a single server process.

The commands run here for the tools' own purposes trust nothing in the
guest's environment: each is `/usr/bin/env -i PATH=<fixed> /bin/bash
--noprofile --norc ...` under exec.wrap_argv, every program named by its
absolute path, so a file the model put on PATH or in its home directory
cannot replace one. A model's string only ever reaches them as a positional
argument (`"$1"`), never inside a script's text.

Errors the model can act on (a refused path, a missing file, a second match)
are WorkspaceError, a ValueError; a helper that misbehaves is SandboxError.
"""

import base64
import posixpath
from typing import Final

from local_llm.sandbox.backend import validate_sandbox_path
from local_llm.sandbox.exec import wrap_argv
from local_llm.sandbox.limits import (
    HELPER_TIMEOUT_S,
    IMAGE_MAX_BYTES,
    IMAGE_MAX_PIXELS,
    IMAGE_MAX_SIDE,
    MAX_PATH_BYTES,
    STREAM_CAP_CHARS,
    VIEW_MAX_BYTES,
    WORKSPACE,
)
from local_llm.sandbox.manager import SandboxSession
from local_llm.sandbox.types import ExecResult, FileStat, SandboxError

#: The PATH every helper runs with, the image's own directories only.
GUEST_PATH: Final = '/usr/local/bin:/usr/bin:/bin'
#: The confinement helper, baked into the images (T15).
LLLM_PATH: Final = '/usr/local/bin/lllm-path'
#: How every helper starts: an empty environment, a fixed PATH, and bash without startup files.
GUEST_SHELL: Final = ('/usr/bin/env', '-i', f'PATH={GUEST_PATH}', '/bin/bash', '--noprofile', '--norc')
#: The most bytes a directory listing returns; under STREAM_CAP_CHARS, so the stream is never cut in the middle.
LIST_CAP_BYTES: Final = 16_384
#: The write helper's exit status when the file exists and overwriting was not asked for.
EXISTS_EXIT: Final = 3

# Resolves "$1" with lllm-path into p, exiting with lllm-path's own status when it does not succeed: 1 (and its
# message on stderr) for a refusal, which the model can act on, and anything else (2 for wrong usage, 126 or 127
# for a helper missing from the image) for a failure of the sandbox, never mistaken for a refusal.
_RESOLVE = f'p=$(/bin/bash --noprofile --norc {LLLM_PATH} "$1") || exit $?'

#: Lists the directory "$1" two levels deep, hidden entries left out except `.runs`, as NUL-ended
#: `<type letter>\t<size>\t<path>` records, at most LIST_CAP_BYTES of them; symlinks are listed, never followed.
LIST_SCRIPT: Final = (
    f'{_RESOLVE}\n'
    "/usr/bin/find \"$p\" -mindepth 1 -maxdepth 2 -name '.*' ! -name .runs -prune -o -printf '%y\\t%s\\t%P\\0' "
    f'| /usr/bin/head -c {LIST_CAP_BYTES}\n'
)

#: Writes stdin to the file "$1", creating its parent directories; "$2" is `overwrite` to replace an existing
#: file, and without it an existing one exits EXISTS_EXIT. A directory, anything else that is not a regular file,
#: and a file UID 1000 may not write are refused. The content goes to a temporary file beside the target, which
#: takes the target's mode (0644 for a new file) and is renamed over it, so a write that fails (a full workspace,
#: the helper's timeout) leaves the old file whole; the temporary file is removed when a step fails. Prints the
#: resolved path.
WRITE_SCRIPT: Final = (
    f'{_RESOLVE}\n'
    'if [ -d "$p" ]; then printf \'%s is a directory\\n\' "$p" >&2; exit 1; fi\n'
    'if [ -e "$p" ] && [ ! -f "$p" ]; then printf \'%s is not a regular file\\n\' "$p" >&2; exit 1; fi\n'
    f'if [ "$2" != overwrite ] && [ -e "$p" ]; then exit {EXISTS_EXIT}; fi\n'
    'if [ -e "$p" ] && [ ! -w "$p" ]; then printf \'%s is read-only\\n\' "$p" >&2; exit 1; fi\n'
    '/usr/bin/mkdir -p -- "${p%/*}" || exit 1\n'
    't=$(/usr/bin/mktemp -- "${p%/*}/.lllm-write.XXXXXX") || exit 1\n'
    'if [ -e "$p" ]; then m=--reference=$p; else m=644; fi\n'
    'if ! /usr/bin/cat > "$t" || ! /usr/bin/chmod "$m" -- "$t" || ! /usr/bin/mv -f -T -- "$t" "$p"; then\n'
    '    /usr/bin/rm -f -- "$t"; exit 1\n'
    'fi\n'
    'printf \'%s\\n\' "$p"\n'
)

#: Resolves "$1" as lllm-path does, and refuses an existing file (not a directory) UID 1000 cannot read; prints
#: the resolved path. The file tools' reads go through the daemon, as root, so this keeps them to what UID 1000
#: could read with bash.
READ_SCRIPT: Final = (
    f'{_RESOLVE}\n'
    'if [ -e "$p" ] && [ ! -d "$p" ] && [ ! -r "$p" ]; then '
    'printf \'lllm-read: %s cannot be read: permission denied\\n\' "$p" >&2; exit 1; fi\n'
    'printf \'%s\\n\' "$p"\n'
)

# PNG, JPEG, GIF and WebP by their first bytes; nothing else is returned as an image (never SVG, which is a
# document that can carry script).
_IMAGE_MAGIC: Final = (
    (b'\x89PNG\r\n\x1a\n', 'image/png'),
    (b'\xff\xd8\xff', 'image/jpeg'),
    (b'GIF87a', 'image/gif'),
    (b'GIF89a', 'image/gif'),
)


# Ends a line number_lines cut to fit STREAM_CAP_CHARS.
_LINE_CUT: Final = ' [... rest of the line cut ...]'

# What the model is told when a helper prints something it should not: no internals, and nothing was used.
_UNEXPECTED: Final = 'a sandbox helper gave an unexpected answer, so the path was not used'


class WorkspaceError(ValueError):
    """A file request the model can correct: a refused path, a missing file, a match that is not unique."""


def confine(path: str) -> str:
    """Return `path` when it may name something in /workspace, else raise; the host-side check, before any exec.

    A relative path is taken from /workspace. The check is lexical, so it
    cannot see symlinks; lllm-path resolves the path in the guest afterwards.
    Being lexical, it also refuses some paths that lead inside physically
    (`link/../../x`, with `link` a symlink two levels down): conservative on
    purpose, since the guest is what decides where a path leads.

    Raises:
        WorkspaceError: `path` is not a str, is empty, contains NUL or a
            newline, is not valid UTF-8, is over MAX_PATH_BYTES bytes, or
            names something outside /workspace.
    """
    if type(path) is not str:
        raise WorkspaceError(f'the path must be a string, not {type(path).__name__}')
    if not path:
        raise WorkspaceError('the path is empty')
    if '\0' in path or '\n' in path:
        raise WorkspaceError('the path cannot contain a NUL or newline character')
    try:
        size = len(path.encode('utf-8'))
    except UnicodeEncodeError:
        raise WorkspaceError('the path is not valid UTF-8') from None
    if size > MAX_PATH_BYTES:
        raise WorkspaceError(f'the path is {size} bytes, over the {MAX_PATH_BYTES}-byte limit')
    # normpath keeps a leading `//`, which the kernel reads as `/`.
    full = '/' + posixpath.normpath(posixpath.join(WORKSPACE, path)).lstrip('/')
    if full != WORKSPACE and not full.startswith(WORKSPACE + '/'):
        raise WorkspaceError(f'{path!r} is outside {WORKSPACE}; give a path relative to {WORKSPACE}, or under it')
    return path


def resolve_argv(path: str) -> list[str]:
    """The argv that runs lllm-path on `path` (already confined), for HELPER_TIMEOUT_S.

    The tools resolve with the read check (read_argv) or inside the write
    helper; this is resolve(readable=False), for a caller that needs where a
    path leads without reading it.
    """
    return wrap_argv([*GUEST_SHELL, LLLM_PATH, path], HELPER_TIMEOUT_S)


def confine_file(path: str) -> str:
    """confine, and also refuse a path that can only name a directory (ending in `/`, `.` or `..`), for a write.

    Raises:
        WorkspaceError: As confine, or the last component is empty, `.` or `..`.
    """
    if posixpath.basename(confine(path)) in ('', '.', '..'):
        raise WorkspaceError(f'{path!r} names a directory; give the path of a file')
    return path


def read_argv(path: str) -> list[str]:
    """The argv that runs READ_SCRIPT on `path` (already confined), for HELPER_TIMEOUT_S."""
    return wrap_argv([*GUEST_SHELL, '-c', READ_SCRIPT, 'lllm-read', path], HELPER_TIMEOUT_S)


def list_argv(path: str) -> list[str]:
    """The argv that runs LIST_SCRIPT on `path`, for HELPER_TIMEOUT_S."""
    return wrap_argv([*GUEST_SHELL, '-c', LIST_SCRIPT, 'lllm-list', path], HELPER_TIMEOUT_S)


def write_argv(path: str, *, overwrite: bool) -> list[str]:
    """The argv that runs WRITE_SCRIPT on `path`, for HELPER_TIMEOUT_S; the content goes on stdin."""
    return wrap_argv(
        [*GUEST_SHELL, '-c', WRITE_SCRIPT, 'lllm-write', path, 'overwrite' if overwrite else 'new'], HELPER_TIMEOUT_S
    )


def _message(result: ExecResult) -> str:
    return result.stderr.strip() or f'exit status {result.returncode}'


def _printed_path(result: ExecResult, what: str) -> str:
    """The resolved path a helper printed, checked again on the host.

    Raises:
        SandboxError: The helper printed something that is not one absolute,
            normalised path of at most MAX_PATH_BYTES bytes under
            /workspace, ended by one newline.
    """
    out = result.stdout
    resolved = out[:-1]
    if result.truncated or not out.endswith('\n') or '\n' in resolved or len(resolved.encode('utf-8')) > MAX_PATH_BYTES:
        raise SandboxError(f'{what} printed an unexpected result: {out[:200]!r}', public=_UNEXPECTED)
    try:
        validate_sandbox_path(resolved, allow_workspace=True)
    except ValueError as exc:
        raise SandboxError(f'{what} printed an unexpected result: {exc}', public=_UNEXPECTED) from None
    if '\ufffd' in resolved:
        # A name that is not UTF-8 decodes with replacement characters, which no longer name the file.
        raise WorkspaceError(
            f'the path leads to {resolved!r}, a name that is not valid UTF-8 (or holds U+FFFD); '
            'rename it through bash, or reach it through bash'
        )
    return resolved


def _check_exit(result: ExecResult, what: str) -> None:
    """Raise unless the helper succeeded: exit 1 is a refusal the model can act on, anything else a failure."""
    if result.returncode == 0:
        return
    if result.returncode == 1:
        raise WorkspaceError(_message(result))
    raise SandboxError(
        f'{what} failed: {_message(result)}', public=f'{what} failed in the sandbox (exit status {result.returncode})'
    )


async def resolve(session: SandboxSession, path: str, *, readable: bool = False) -> str:
    """Where `path` leads in the sandbox: confined on the host, then resolved and confined in the guest by lllm-path.

    With `readable`, the same exec (READ_SCRIPT) also refuses an existing
    file that is not a directory and that UID 1000 cannot read.

    Raises:
        WorkspaceError: Either check refuses the path, or it leads to a name
            that is not valid UTF-8.
        SandboxError: lllm-path failed or printed something unexpected, or the sandbox failed.
    """
    confined = confine(path)
    argv = read_argv(confined) if readable else resolve_argv(confined)
    result = await session.exec(argv, HELPER_TIMEOUT_S)
    _check_exit(result, 'lllm-path')
    return _printed_path(result, 'lllm-path')


def image_type(data: bytes) -> str | None:
    """The media type of a PNG, JPEG, GIF or WebP image, by its first bytes; None for anything else."""
    for magic, media_type in _IMAGE_MAGIC:
        if data.startswith(magic):
            return media_type
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'image/webp'
    return None


def _jpeg_size(data: bytes) -> tuple[int, int] | None:
    # Walk the segments to the first start-of-frame marker, which holds the height and the width.
    at = 2
    while at + 4 <= len(data):
        if data[at] != 0xFF:
            return None
        marker = data[at + 1]
        if marker == 0xFF:
            # A fill byte before the marker.
            at += 1
            continue
        if marker in (0x01, 0xD8) or 0xD0 <= marker <= 0xD7:
            at += 2
            continue
        if marker == 0xDA:
            # Start of scan, with no frame header before it.
            return None
        length = int.from_bytes(data[at + 2 : at + 4], 'big')
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            if at + 9 > len(data):
                return None
            return int.from_bytes(data[at + 7 : at + 9], 'big'), int.from_bytes(data[at + 5 : at + 7], 'big')
        at += 2 + length
    return None


def _le(data: bytes, start: int, size: int) -> int:
    return int.from_bytes(data[start : start + size], 'little')


def _gif_skip_sub_blocks(data: bytes, at: int) -> int:
    # Data sub-blocks: a length byte, that many bytes, until a 0 length; a truncated file ends the walk.
    while at < len(data):
        length = data[at]
        at += 1
        if length == 0:
            return at
        at += length
    return len(data)


def _gif_info(data: bytes) -> tuple[tuple[int, int] | None, int]:
    """The extent a GIF draws (its screen, grown to every frame's offset and size) and how many frames it has.

    A decoder may grow the screen to a frame larger than it, so every frame
    counts. The extent is None when the blocks cannot be read.
    """
    if len(data) < 13:
        return None, 0
    width, height = _le(data, 6, 2), _le(data, 8, 2)
    at = 13
    if data[10] & 0x80:
        at += 3 * 2 ** ((data[10] & 7) + 1)
    frames = 0
    while at < len(data) and data[at] != 0x3B:
        block = data[at]
        if block == 0x21:
            # An extension: its label, then sub-blocks.
            at = _gif_skip_sub_blocks(data, at + 2)
        elif block == 0x2C and at + 10 <= len(data):
            left, top, frame_width, frame_height = (_le(data, at + 1 + 2 * i, 2) for i in range(4))
            width, height = max(width, left + frame_width), max(height, top + frame_height)
            frames += 1
            flags = data[at + 9]
            at += 10
            if flags & 0x80:
                at += 3 * 2 ** ((flags & 7) + 1)
            # The LZW minimum code size, then the image data's sub-blocks.
            at = _gif_skip_sub_blocks(data, at + 1)
        else:
            return None, frames
    return (width, height), frames


def _webp_info(data: bytes) -> tuple[tuple[int, int] | None, bool]:
    """The extent a WebP draws (its VP8X canvas and bitstream, the larger of each side), and whether it animates."""
    sizes: list[tuple[int, int]] = []
    animated = False
    at = 12
    while at + 8 <= len(data):
        fourcc, length = data[at : at + 4], _le(data, at + 4, 4)
        body = data[at + 8 : at + 8 + length]
        if fourcc == b'VP8X' and len(body) >= 10:
            animated = bool(body[0] & 0x02)
            sizes.append((_le(body, 4, 3) + 1, _le(body, 7, 3) + 1))
        elif fourcc == b'VP8 ' and len(body) >= 10:
            sizes.append((_le(body, 6, 2) & 0x3FFF, _le(body, 8, 2) & 0x3FFF))
        elif fourcc == b'VP8L' and len(body) >= 5:
            bits = _le(body, 1, 4)
            sizes.append(((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1))
        # Chunks are padded to an even length.
        at += 8 + length + (length & 1)
    if not sizes:
        return None, animated
    return (max(w for w, _ in sizes), max(h for _, h in sizes)), animated


def image_size(data: bytes, media_type: str) -> tuple[int, int] | None:
    """The width and height an image of `media_type` (from image_type) draws, by its headers; None if unreadable.

    For a GIF, the screen grown to cover every frame; for a WebP, the larger
    of its canvas and its bitstream on each side.
    """
    if media_type == 'image/png':
        if len(data) < 24 or data[12:16] != b'IHDR':
            return None
        return int.from_bytes(data[16:20], 'big'), int.from_bytes(data[20:24], 'big')
    if media_type == 'image/gif':
        return _gif_info(data)[0]
    if media_type == 'image/jpeg':
        return _jpeg_size(data)
    return _webp_info(data)[0]


def _png_animated(data: bytes) -> bool:
    # An APNG declares itself with an acTL chunk before its first IDAT; browsers play it.
    at = 8
    while at + 8 <= len(data):
        kind = data[at + 4 : at + 8]
        if kind == b'acTL':
            return True
        if kind == b'IDAT':
            return False
        # Length, type, data, CRC.
        at += 12 + int.from_bytes(data[at : at + 4], 'big')
    return False


def image_animated(data: bytes, media_type: str) -> bool:
    """Whether an image would play as an animation: an APNG, a GIF of several frames, or an animated WebP."""
    if media_type == 'image/png':
        return _png_animated(data)
    if media_type == 'image/gif':
        return _gif_info(data)[1] > 1
    if media_type == 'image/webp':
        return _webp_info(data)[1]
    return False


def _check_image(path: str, data: bytes, media_type: str) -> None:
    """Refuse an image too large to hand the model: by bytes, or by the size its header declares.

    The data URI is stored with the chat, sent with every later request and
    decoded by the user's browser, so a small file that decodes to a huge
    picture is refused as well as a large one; so is one whose header cannot
    be read.
    """
    if len(data) > IMAGE_MAX_BYTES:
        raise WorkspaceError(f'{path} is an image of {len(data)} bytes, over the {IMAGE_MAX_BYTES}-byte limit')
    if image_animated(data, media_type):
        raise WorkspaceError(f'{path} is an animated image; save one frame as a PNG and view that')
    size = image_size(data, media_type)
    if size is None:
        raise WorkspaceError(f'{path} looks like an image, but its size cannot be read from its header')
    width, height = size
    if width > IMAGE_MAX_SIDE or height > IMAGE_MAX_SIDE or width * height > IMAGE_MAX_PIXELS:
        raise WorkspaceError(
            f'{path} is {width}x{height} pixels, over the limit of {IMAGE_MAX_SIDE} pixels a side and '
            f'{IMAGE_MAX_PIXELS} pixels in all; save a smaller version and view that'
        )


def _lines(text: str) -> list[str]:
    # Split on '\n' only; a final newline ends the last line rather than starting another. The twin of
    # tools/knowledge_fs.split_lines (#666), copied rather than imported so sandbox/ does not depend on tools/; a
    # fix to one belongs in the other.
    lines = text.split('\n')
    if lines[-1] == '':
        lines.pop()
    return lines


def number_lines(text: str, start_line: int | None = None, end_line: int | None = None) -> dict:
    """Lines `start_line`..`end_line` of `text` (1-based, inclusive), numbered, at most STREAM_CAP_CHARS characters.

    A page cut short by the cap carries `next_start_line`; a single line
    longer than the cap is cut, and says so within the cap.

    Raises:
        WorkspaceError: `start_line` is below 1 or past the end, or `end_line` is before `start_line`.
    """
    lines = _lines(text)
    total = len(lines)
    start = 1 if start_line is None else start_line
    end = total if end_line is None else min(end_line, total)
    if start < 1:
        raise WorkspaceError(f'start_line must be 1 or more, not {start}')
    if end_line is not None and end_line < start:
        raise WorkspaceError(f'end_line {end_line} is before start_line {start}')
    if total and start > total:
        raise WorkspaceError(f'start_line {start} is past the end of the file, which has {total} lines')
    rows: list[str] = []
    size = 0
    last = start - 1
    for number in range(start, end + 1):
        row = f'{number:6}\t{lines[number - 1]}'
        if rows and size + len(row) + 1 > STREAM_CAP_CHARS:
            break
        if len(row) > STREAM_CAP_CHARS:
            row = row[: STREAM_CAP_CHARS - len(_LINE_CUT)] + _LINE_CUT
        rows.append(row)
        size += len(row) + 1
        last = number
    page: dict = {'content': '\n'.join(rows), 'total_lines': total}
    if rows:
        page['showing_lines'] = f'{start}-{last}'
    if last < end:
        page['next_start_line'] = last + 1
    return page


async def _read(session: SandboxSession, resolved: str, path: str, info: FileStat | None) -> bytes:
    """A regular file's bytes, at most VIEW_MAX_BYTES, read by the daemon at a path lllm-path printed.

    `info` is the daemon's stat of `resolved`, taken by the caller.
    """
    if info is None:
        raise WorkspaceError(f'{path}: no such file or directory')
    if info.kind != 'file':
        raise WorkspaceError(f'{path} is not a regular file')
    if info.size > VIEW_MAX_BYTES:
        raise WorkspaceError(
            f'{path} is {info.size} bytes, over the {VIEW_MAX_BYTES}-byte limit; '
            'work with it through bash (head, tail, sed -n, grep)'
        )
    data = (await session.get_files([resolved], VIEW_MAX_BYTES)).get(resolved)
    if data is None:
        message = f'{resolved} could not be read back after it was found'
        raise SandboxError(message, public=message)
    return data


async def _listing(session: SandboxSession, resolved: str) -> dict:
    result = await session.exec(list_argv(resolved), HELPER_TIMEOUT_S)
    _check_exit(result, 'the directory listing')
    records = result.stdout.split('\0')
    # Whatever follows the last NUL is a record LIST_CAP_BYTES cut short.
    truncated = records.pop() != '' or result.truncated
    entries = []
    for record in records:
        kind, _, rest = record.partition('\t')
        size, _, name = rest.partition('\t')
        if kind == 'd':
            entries.append(f'{name}/')
        elif kind == 'f':
            entries.append(f'{name} ({size} bytes)')
        elif kind == 'l':
            entries.append(f'{name} (symlink)')
        else:
            entries.append(name)
    listing: dict = {'path': resolved, 'entries': sorted(entries)}
    if truncated:
        listing['truncated'] = True
        listing['note'] = 'The listing was cut short; list a subdirectory, or use bash (find, ls).'
    if result.stderr:
        listing['errors'] = result.stderr
    return listing


async def view(
    session: SandboxSession, path: str, start_line: int | None = None, end_line: int | None = None
) -> dict | str:
    """A directory's listing, a text file's numbered lines, or an image as a `data:` URI.

    Raises:
        WorkspaceError: The path is refused, missing, not a file or a
            directory, too large, or a binary file that is not an image; or
            the line range is wrong.
        SandboxError: The sandbox or a helper failed.
    """
    resolved = await resolve(session, path, readable=True)
    info = await session.stat(resolved)
    if info is not None and info.kind == 'dir':
        return await _listing(session, resolved)
    data = await _read(session, resolved, path, info)
    media_type = image_type(data)
    if media_type is not None:
        _check_image(path, data, media_type)
        return f'data:{media_type};base64,{base64.b64encode(data).decode("ascii")}'
    if b'\0' in data[:8192]:
        raise WorkspaceError(f'{path} is a binary file; inspect it through bash (file, xxd, od)')
    return {'path': resolved, **number_lines(data.decode('utf-8', errors='replace'), start_line, end_line)}


async def write(session: SandboxSession, path: str, data: bytes, *, overwrite: bool) -> str:
    """Write `data` to `path` as UID 1000, creating parent directories; return the resolved path.

    The write is atomic (WRITE_SCRIPT): the content goes to a temporary file
    in the same directory, which is renamed over the target, so a write that
    fails leaves the old file whole. What that costs: the directory must be
    writable too, even to overwrite a file in it; a hard link to the target
    keeps the old content; the file's owner is UID 1000 afterwards; and a
    write killed between its steps (the helper's timeout) can leave a hidden
    `.lllm-write.*` file beside the target.

    Raises:
        WorkspaceError: The path is refused; the file exists and `overwrite`
            is False; or the guest refused the write (a directory, a
            read-only file, a full disk).
        SandboxError: The sandbox or the helper failed.
    """
    confine_file(path)
    result = await session.exec(write_argv(path, overwrite=overwrite), HELPER_TIMEOUT_S, stdin=data)
    if result.returncode == EXISTS_EXIT:
        raise WorkspaceError(f'{path} already exists; pass overwrite=true to replace it, or edit it with str_replace')
    _check_exit(result, 'the write')
    return _printed_path(result, 'the write')


def check_replacement(old: object, new: object) -> None:
    """Refuse a str_replace whose `old` or `new` is not text, or whose `old` is empty, before anything runs.

    Raises:
        WorkspaceError: Either is not exactly a str, or `old` is empty.
    """
    for name, value in (('old_str', old), ('new_str', new)):
        if type(value) is not str:
            raise WorkspaceError(f'{name} must be text, not {type(value).__name__}')
    if not old:
        raise WorkspaceError('old_str is empty; give the exact text to replace')


async def str_replace(session: SandboxSession, path: str, old: str, new: str) -> dict:
    """Replace the one occurrence of `old` in the text file `path` with `new`, and show the lines around it.

    Raises:
        WorkspaceError: `old` is empty, occurs zero or several times
            (overlapping matches count), the file is not UTF-8 text, or the
            path is refused, missing or not writable.
        SandboxError: The sandbox or a helper failed.
    """
    check_replacement(old, new)
    resolved = await resolve(session, path, readable=True)
    try:
        text = (await _read(session, resolved, path, await session.stat(resolved))).decode('utf-8')
    except UnicodeDecodeError:
        raise WorkspaceError(f'{path} is not UTF-8 text; edit it through bash') from None
    at = text.find(old)
    if at < 0:
        raise WorkspaceError(f'old_str does not occur in {path}; view the file and copy the text exactly')
    if text.find(old, at + 1) >= 0:
        count = max(2, text.count(old))
        raise WorkspaceError(
            f'old_str occurs {count} times in {path}; include more of the surrounding text so it occurs once'
        )
    updated = text[:at] + new + text[at + len(old) :]
    await write(session, resolved, updated.encode('utf-8'), overwrite=True)
    first = text.count('\n', 0, at) + 1
    # A newline that ends the replacement ends its last line; it starts no edited line after it.
    last = max(first, first + new.count('\n') - new.endswith('\n'))
    context = number_lines(updated, max(1, first - 3), last + 3)
    return {'path': resolved, 'edited_lines': f'{first}-{last}', 'context': context['content']}
