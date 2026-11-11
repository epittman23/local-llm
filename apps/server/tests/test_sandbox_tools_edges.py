"""The sandbox file tools' edges (T12): sandbox/workspace.py's error branches and the tools' error mapping.

Two kinds of test:

- workspace.py's functions run against a scripted session, one that answers
  `exec`, `stat` and `get_files` with what a misbehaving or unusual guest
  would: a helper that prints nonsense or fails, a file of an odd kind, a
  listing the cap cut, a line range that makes no sense;
- the four tools through SandboxManager and FakeBackend, with the model's
  arguments as awkward as a model makes them (text where a number is
  wanted, huge numbers, unicode and trailing slashes in paths) and with
  every error type the layers below raise.

Run from apps/server:

    python -m pytest tests/test_sandbox_tools_edges.py
"""

import asyncio
import base64
import json
import re
from collections.abc import Callable
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any, cast

import pytest

from local_llm.sandbox import (
    ExecResult,
    FileStat,
    SandboxError,
    SandboxManager,
    SandboxNotRunning,
    SandboxRefused,
    SandboxSession,
    SandboxUnavailable,
    wrap_command,
)
from local_llm.sandbox import workspace as ws
from local_llm.sandbox.fake import FakeFile
from local_llm.sandbox.limits import STREAM_CAP_CHARS
from local_llm.tools import builtin
from tests.test_sandbox_tools import CHAT, _Rig

# A scripted session.


def _ok(stdout: str = '', stderr: str = '', returncode: int = 0, truncated: bool = False) -> ExecResult:
    return ExecResult(
        returncode=returncode, stdout=stdout, stderr=stderr, timed_out=False, truncated=truncated, duration_ms=1
    )


def _stat(kind: str = 'file', size: int = 1) -> FileStat:
    return FileStat(path='/workspace/f', kind=cast(Any, kind), uid=1000, mode=0o644, size=size, mtime=0.0)


class _Script:
    """Stands in for a SandboxSession: exec answers come from a queue, stat and get_files from fields."""

    def __init__(
        self,
        execs: list[ExecResult] | None = None,
        info: FileStat | None = None,
        files: dict[str, bytes] | None = None,
    ) -> None:
        self.execs = list(execs or [])
        self.info = info
        self.files = files if files is not None else {}
        self.argvs: list[list[str]] = []
        self.stdins: list[bytes | None] = []

    async def exec(self, argv: list[str], timeout_s: int, stdin: bytes | None = None) -> ExecResult:
        self.argvs.append(argv)
        self.stdins.append(stdin)
        return self.execs.pop(0)

    async def stat(self, path: str) -> FileStat | None:
        return self.info

    async def get_files(self, paths: list[str], max_bytes: int) -> dict[str, bytes]:
        return self.files


def _session(script: _Script) -> SandboxSession:
    return cast(SandboxSession, script)


def _page(shown: object) -> dict:
    assert isinstance(shown, dict)
    return shown


def _resolved(path: str = '/workspace/f') -> ExecResult:
    return _ok(stdout=path + '\n')


# workspace._printed_path and _check_exit: what a helper may print or exit with.


@pytest.mark.parametrize(
    'printed',
    [
        _ok(stdout='/workspace/f'),
        _ok(stdout=''),
        _ok(stdout='/workspace/a\n/workspace/b\n'),
        _ok(stdout='/workspace/f\n', truncated=True),
        _ok(stdout='/workspace/' + 'x' * 4090 + '\n'),
        _ok(stdout='/etc/passwd\n'),
        _ok(stdout='/workspace\x00/x\n'),
        _ok(stdout='relative/path\n'),
        _ok(stdout='/workspace/a/../../etc\n'),
        _ok(stdout='/workspace/a//b\n'),
        _ok(stdout='/workspace/dir/\n'),
        _ok(stdout='/workspacefoo/x\n'),
    ],
)
def test_resolve_distrusts_a_path_the_helper_printed_that_is_not_one_clean_path_in_workspace(printed):
    with pytest.raises(SandboxError, match='lllm-path printed an unexpected result'):
        asyncio.run(ws.resolve(_session(_Script([printed])), 'f'))


def test_resolve_accepts_the_workspace_root_itself():
    assert asyncio.run(ws.resolve(_session(_Script([_resolved('/workspace')])), '.')) == '/workspace'


def test_resolve_turns_exit_1_into_a_refusal_the_model_can_act_on_with_the_helpers_message():
    script = _Script([_ok(stderr='lllm-path: the path leads outside /workspace\n', returncode=1)])
    with pytest.raises(ws.WorkspaceError, match='the path leads outside /workspace'):
        asyncio.run(ws.resolve(_session(script), 'f'))


def test_resolve_names_the_exit_status_when_a_refusal_has_no_message():
    with pytest.raises(ws.WorkspaceError, match='exit status 1'):
        asyncio.run(ws.resolve(_session(_Script([_ok(returncode=1)])), 'f'))


@pytest.mark.parametrize('returncode', [2, 126, 127, 137, -9])
def test_resolve_turns_any_other_exit_into_a_sandbox_failure(returncode):
    script = _Script([_ok(stderr='boom\n', returncode=returncode)])
    with pytest.raises(SandboxError, match='lllm-path failed: boom') as caught:
        asyncio.run(ws.resolve(_session(script), 'f'))
    assert not isinstance(caught.value, ws.WorkspaceError)


def test_resolve_confines_the_path_on_the_host_before_it_runs_anything():
    script = _Script([_resolved()])
    with pytest.raises(ws.WorkspaceError):
        asyncio.run(ws.resolve(_session(script), '../etc/passwd'))
    assert script.argvs == []


def test_a_workspace_error_is_a_value_error_and_a_sandbox_failure_is_not():
    assert issubclass(ws.WorkspaceError, ValueError)
    assert not issubclass(SandboxError, ValueError)


# image_type.


@pytest.mark.parametrize(
    ('data', 'media_type'),
    [
        (b'\x89PNG\r\n\x1a\n....', 'image/png'),
        (b'\xff\xd8\xff\xe0....', 'image/jpeg'),
        (b'GIF87a....', 'image/gif'),
        (b'GIF89a....', 'image/gif'),
        (b'RIFF\x00\x00\x00\x00WEBPVP8 ', 'image/webp'),
        (b'RIFF\x00\x00\x00\x00WAVEfmt ', None),
        (b'<svg xmlns="http://www.w3.org/2000/svg"></svg>', None),
        (b'\x89PNG', None),
        (b'', None),
        (b'GIF8', None),
    ],
)
def test_image_type_goes_by_the_first_bytes_and_never_names_svg(data, media_type):
    assert ws.image_type(data) == media_type


# number_lines.


def test_number_lines_numbers_from_one_and_treats_the_final_newline_as_ending_the_last_line():
    assert ws.number_lines('a\nb\n') == {'content': '     1\ta\n     2\tb', 'total_lines': 2, 'showing_lines': '1-2'}


def test_number_lines_keeps_the_last_line_that_has_no_newline():
    assert ws.number_lines('a\nb')['total_lines'] == 2


def test_number_lines_counts_a_trailing_blank_line_but_not_the_newline_ending_the_last_one():
    assert ws.number_lines('a\n\n')['total_lines'] == 2


def test_number_lines_of_an_empty_file_is_an_empty_page_with_no_range():
    assert ws.number_lines('') == {'content': '', 'total_lines': 0}


def test_number_lines_keeps_a_carriage_return_as_part_of_the_line():
    assert ws.number_lines('a\r\nb\r\n')['content'] == '     1\ta\r\n     2\tb\r'


def test_number_lines_shows_the_range_asked_for_inclusively():
    page = ws.number_lines('1\n2\n3\n4\n5\n', 2, 4)
    assert page['content'] == '     2\t2\n     3\t3\n     4\t4'
    assert page['showing_lines'] == '2-4'
    assert 'next_start_line' not in page


def test_number_lines_clamps_an_end_line_past_the_end_to_the_last_line():
    assert ws.number_lines('1\n2\n', 2, 999)['showing_lines'] == '2-2'


def test_number_lines_shows_one_line_when_start_and_end_agree():
    assert ws.number_lines('1\n2\n3\n', 2, 2)['content'] == '     2\t2'


@pytest.mark.parametrize('start', [0, -1, -100])
def test_number_lines_refuses_a_start_line_below_one(start):
    with pytest.raises(ws.WorkspaceError, match=f'start_line must be 1 or more, not {start}'):
        ws.number_lines('a\n', start)


def test_number_lines_refuses_an_end_line_before_the_start_line():
    with pytest.raises(ws.WorkspaceError, match='end_line 1 is before start_line 3'):
        ws.number_lines('a\nb\nc\nd\n', 3, 1)


def test_number_lines_refuses_an_end_line_of_zero_even_with_no_start_line():
    with pytest.raises(ws.WorkspaceError, match='end_line 0 is before start_line 1'):
        ws.number_lines('a\n', None, 0)


def test_number_lines_refuses_a_start_line_past_the_end_and_says_how_long_the_file_is():
    with pytest.raises(ws.WorkspaceError, match='start_line 4 is past the end of the file, which has 3 lines'):
        ws.number_lines('a\nb\nc\n', 4)


def test_number_lines_of_an_empty_file_accepts_any_start_line_and_returns_nothing():
    assert ws.number_lines('', 7) == {'content': '', 'total_lines': 0}


def test_number_lines_cuts_a_page_at_the_stream_cap_and_says_where_the_next_one_starts():
    text = ''.join(f'{"x" * 999}\n' for _ in range(60))
    page = ws.number_lines(text)
    assert len(page['content']) <= STREAM_CAP_CHARS
    assert page['total_lines'] == 60
    shown = int(page['showing_lines'].split('-')[1])
    assert page['showing_lines'] == f'1-{shown}'
    assert page['next_start_line'] == shown + 1
    assert 0 < shown < 60


def test_number_lines_pages_chain_without_gap_or_overlap():
    text = ''.join(f'{i}:{"y" * 500}\n' for i in range(200))
    seen: list[int] = []
    start: int | None = 1
    while start is not None:
        page = ws.number_lines(text, start)
        first, last = (int(n) for n in page['showing_lines'].split('-'))
        assert first == start
        seen.extend(range(first, last + 1))
        start = page.get('next_start_line')
    assert seen == list(range(1, 201))


def test_number_lines_cuts_one_line_longer_than_the_cap_and_says_so():
    page = ws.number_lines('z' * (STREAM_CAP_CHARS * 3) + '\nafter\n')
    first, _, rest = page['content'].partition('\n')
    assert first.endswith(' [... rest of the line cut ...]')
    assert len(first) < STREAM_CAP_CHARS + 100
    assert rest == '' or rest.startswith('     2\t')
    assert page['showing_lines'].startswith('1-')


def test_number_lines_shows_a_long_line_alone_on_the_page_after_the_short_ones_before_it():
    page = ws.number_lines('short\n' + 'z' * (STREAM_CAP_CHARS * 2) + '\n')
    assert page['showing_lines'] == '1-1'
    assert page['next_start_line'] == 2
    follow = ws.number_lines('short\n' + 'z' * (STREAM_CAP_CHARS * 2) + '\n', 2)
    assert follow['showing_lines'] == '2-2'
    assert 'rest of the line cut' in follow['content']
    assert 'next_start_line' not in follow


def test_number_lines_keeps_the_line_numbers_aligned_in_six_columns():
    assert ws.number_lines('a\n' * 12, 10, 10)['content'] == '    10\ta'


# _read, through view and str_replace.


@pytest.mark.parametrize('kind', ['symlink', 'other'])
def test_view_refuses_what_is_not_a_regular_file_or_directory(kind):
    script = _Script([_resolved()], info=_stat(kind))
    with pytest.raises(ws.WorkspaceError, match='f is not a regular file'):
        asyncio.run(ws.view(_session(script), 'f'))


def test_view_refuses_a_missing_file():
    with pytest.raises(ws.WorkspaceError, match='f: no such file or directory'):
        asyncio.run(ws.view(_session(_Script([_resolved()], info=None)), 'f'))


def test_view_refuses_a_file_over_the_read_limit_and_points_at_bash():
    script = _Script([_resolved()], info=_stat(size=ws.VIEW_MAX_BYTES + 1))
    with pytest.raises(ws.WorkspaceError, match=r'over the 10485760-byte limit; work with it through bash'):
        asyncio.run(ws.view(_session(script), 'big.log'))


def test_view_reads_a_file_exactly_at_the_read_limit():
    script = _Script([_resolved()], info=_stat(size=ws.VIEW_MAX_BYTES), files={'/workspace/f': b'ok\n'})
    assert _page(asyncio.run(ws.view(_session(script), 'f')))['content'] == '     1\tok'


def test_view_says_the_sandbox_failed_when_a_file_it_just_found_cannot_be_read_back():
    script = _Script([_resolved()], info=_stat(), files={})
    with pytest.raises(SandboxError, match='could not be read back after it was found'):
        asyncio.run(ws.view(_session(script), 'f'))


def test_view_refuses_an_image_over_the_image_limit(monkeypatch):
    monkeypatch.setattr(ws, 'IMAGE_MAX_BYTES', 16)
    png = b'\x89PNG\r\n\x1a\n' + b'\0' * 32
    script = _Script([_resolved()], info=_stat(size=len(png)), files={'/workspace/f': png})
    with pytest.raises(ws.WorkspaceError, match='is an image of 40 bytes, over the 16-byte limit'):
        asyncio.run(ws.view(_session(script), 'f'))


@pytest.mark.parametrize(
    ('data', 'media_type'),
    [
        # Each with a header that declares a 2x1 picture, which view reads before it returns an image.
        (b'\xff\xd8\xff\xc0\x00\x11\x08\x00\x01\x00\x02\x03', 'image/jpeg'),
        # A screen, one frame of the same size and the trailer.
        (b'GIF89a\x02\x00\x01\x00\x00\x00\x00\x2c\x00\x00\x00\x00\x02\x00\x01\x00\x00\x02\x00\x3b', 'image/gif'),
        # A VP8 chunk of 10 bytes whose frame header declares 2x1.
        (b'RIFF\0\0\0\0WEBPVP8 \x0a\0\0\0\0\0\0\x9d\x01\x2a\x02\x00\x01\x00', 'image/webp'),
    ],
)
def test_view_returns_each_image_kind_as_a_data_uri_of_its_own_type(data, media_type):
    script = _Script([_resolved()], info=_stat(size=len(data)), files={'/workspace/f': data})
    assert asyncio.run(ws.view(_session(script), 'f')) == f'data:{media_type};base64,' + base64.b64encode(data).decode()


def test_view_does_not_return_svg_as_an_image_but_as_text():
    svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'
    script = _Script([_resolved()], info=_stat(size=len(svg)), files={'/workspace/f': svg})
    shown = asyncio.run(ws.view(_session(script), 'f'))
    assert isinstance(shown, dict)
    assert shown['content'].startswith('     1\t<svg')


def test_view_calls_a_nul_in_the_first_8_kib_binary_but_not_one_after_it():
    head = _Script([_resolved()], info=_stat(), files={'/workspace/f': b'abc\0def'})
    with pytest.raises(ws.WorkspaceError, match='is a binary file'):
        asyncio.run(ws.view(_session(head), 'f'))
    tail = _Script([_resolved()], info=_stat(), files={'/workspace/f': b'a' * 8192 + b'\0'})
    assert isinstance(asyncio.run(ws.view(_session(tail), 'f')), dict)


def test_view_replaces_bytes_that_are_not_utf_8_rather_than_failing():
    script = _Script([_resolved()], info=_stat(), files={'/workspace/f': b'caf\xe9\n'})
    assert _page(asyncio.run(ws.view(_session(script), 'f')))['content'] == '     1\tcaf\ufffd'


def test_view_of_an_empty_file_returns_no_lines():
    script = _Script([_resolved()], info=_stat(size=0), files={'/workspace/f': b''})
    assert asyncio.run(ws.view(_session(script), 'f')) == {'path': '/workspace/f', 'content': '', 'total_lines': 0}


# The listing helper's output, as the guest or the cap may leave it.


def _listing(stdout: str, stderr: str = '', returncode: int = 0, truncated: bool = False) -> _Script:
    return _Script([_resolved('/workspace'), _ok(stdout, stderr, returncode, truncated)], info=_stat('dir'))


def test_listing_marks_directories_files_with_sizes_and_symlinks_and_sorts_them():
    stdout = 'f\t12\tb.txt\0d\t4096\tsub\0l\t3\tlink\0f\t0\ta.txt\0p\t0\tfifo\0'
    listing = asyncio.run(ws.view(_session(_listing(stdout)), '.'))
    assert listing == {
        'path': '/workspace',
        'entries': ['a.txt (0 bytes)', 'b.txt (12 bytes)', 'fifo', 'link (symlink)', 'sub/'],
    }


def test_listing_of_an_empty_directory_has_no_entries_and_no_truncation_flag():
    assert asyncio.run(ws.view(_session(_listing('')), '.')) == {'path': '/workspace', 'entries': []}


def test_listing_drops_the_record_the_cap_cut_short_and_says_the_listing_was_cut():
    stdout = 'f\t1\tcomplete\0f\t1\tcut-in-the-mid'
    listing = asyncio.run(ws.view(_session(_listing(stdout)), '.'))
    assert isinstance(listing, dict)
    assert listing['entries'] == ['complete (1 bytes)']
    assert listing['truncated'] is True
    assert 'cut short' in listing['note']


def test_listing_says_it_was_cut_when_the_stream_was_truncated_even_at_a_record_boundary():
    listing = asyncio.run(ws.view(_session(_listing('f\t1\ta\0', truncated=True)), '.'))
    assert isinstance(listing, dict)
    assert listing['truncated'] is True


def test_listing_passes_on_what_the_helper_complained_about():
    stderr = "find: '/workspace/locked': Permission denied\n"
    listing = asyncio.run(ws.view(_session(_listing('d\t1\tlocked\0', stderr)), '.'))
    assert isinstance(listing, dict)
    assert listing['errors'] == stderr
    assert listing['entries'] == ['locked/']


def test_listing_exit_1_is_a_refusal_and_any_other_exit_a_failure():
    with pytest.raises(ws.WorkspaceError, match='gone'):
        asyncio.run(ws.view(_session(_listing('', 'gone\n', 1)), '.'))
    with pytest.raises(SandboxError, match='the directory listing failed: bad'):
        asyncio.run(ws.view(_session(_listing('', 'bad\n', 2)), '.'))


# write and str_replace on a scripted session.


def test_write_names_the_flag_to_pass_when_the_file_exists():
    script = _Script([_ok(returncode=ws.EXISTS_EXIT)])
    with pytest.raises(ws.WorkspaceError, match='f already exists; pass overwrite=true to replace it'):
        asyncio.run(ws.write(_session(script), 'f', b'x', overwrite=False))


def test_write_sends_the_content_on_stdin_and_the_mode_as_an_argument_never_in_the_script():
    script = _Script([_resolved()])
    asyncio.run(ws.write(_session(script), 'f', b'$(touch pwned)\n', overwrite=True))
    assert script.stdins == [b'$(touch pwned)\n']
    assert script.argvs[0][-2:] == ['f', 'overwrite']
    assert all('pwned' not in part for part in script.argvs[0])


def test_write_passes_new_as_the_mode_without_overwrite():
    script = _Script([_resolved()])
    asyncio.run(ws.write(_session(script), 'f', b'', overwrite=False))
    assert script.argvs[0][-2:] == ['f', 'new']


def test_write_turns_a_guest_refusal_into_the_models_error_and_any_other_exit_into_a_failure():
    refusal = _Script([_ok(stderr='/workspace/d is a directory\n', returncode=1)])
    with pytest.raises(ws.WorkspaceError, match='is a directory'):
        asyncio.run(ws.write(_session(refusal), 'd', b'', overwrite=True))
    failure = _Script([_ok(stderr='oops\n', returncode=4)])
    with pytest.raises(SandboxError, match='the write failed: oops'):
        asyncio.run(ws.write(_session(failure), 'd', b'', overwrite=True))


def test_write_distrusts_a_path_the_helper_printed_outside_workspace():
    with pytest.raises(SandboxError, match='the write printed an unexpected result'):
        asyncio.run(ws.write(_session(_Script([_ok(stdout='/etc/passwd\n')])), 'f', b'', overwrite=True))


def test_write_confines_the_path_before_running_anything():
    script = _Script([_resolved()])
    with pytest.raises(ws.WorkspaceError):
        asyncio.run(ws.write(_session(script), '/etc/passwd', b'x', overwrite=True))
    assert script.argvs == []


def _edit(text: bytes, old: str, new: str) -> tuple[dict, _Script]:
    script = _Script([_resolved(), _resolved()], info=_stat(), files={'/workspace/f': text})
    return asyncio.run(ws.str_replace(_session(script), 'f', old, new)), script


def test_str_replace_refuses_a_file_that_is_not_utf_8_and_changes_nothing():
    script = _Script([_resolved()], info=_stat(), files={'/workspace/f': b'caf\xe9 x'})
    with pytest.raises(ws.WorkspaceError, match='f is not UTF-8 text; edit it through bash'):
        asyncio.run(ws.str_replace(_session(script), 'f', 'x', 'y'))
    assert len(script.argvs) == 1


def test_str_replace_refuses_an_empty_old_str_before_running_anything():
    script = _Script([])
    with pytest.raises(ws.WorkspaceError, match='old_str is empty'):
        asyncio.run(ws.str_replace(_session(script), 'f', '', 'y'))
    assert script.argvs == []


def test_str_replace_counts_overlapping_matches_as_several():
    with pytest.raises(ws.WorkspaceError, match='old_str occurs 2 times in f'):
        _edit(b'aaa', 'aa', 'b')


def test_str_replace_counts_every_non_overlapping_match_in_its_message():
    with pytest.raises(ws.WorkspaceError, match='old_str occurs 4 times in f'):
        _edit(b'x x x x', 'x', 'y')


def test_str_replace_changes_nothing_when_the_match_is_not_unique():
    script = _Script([_resolved()], info=_stat(), files={'/workspace/f': b'x x'})
    with pytest.raises(ws.WorkspaceError):
        asyncio.run(ws.str_replace(_session(script), 'f', 'x', 'y'))
    assert len(script.argvs) == 1


def test_str_replace_writes_the_whole_edited_text_over_the_file_and_reports_the_lines_around_it():
    text = ''.join(f'line {n}\n' for n in range(1, 11)).encode()
    result, script = _edit(text, 'line 5', 'five\nand a half')
    assert script.stdins[1] == text.replace(b'line 5', b'five\nand a half')
    assert script.argvs[1][-2:] == ['/workspace/f', 'overwrite']
    assert result['edited_lines'] == '5-6'
    shown = result['context'].split('\n')
    assert shown[0] == '     2\tline 2'
    assert shown[-1] == '     9\tline 8'
    assert '     5\tfive' in shown
    assert '     6\tand a half' in shown


def test_str_replace_near_the_top_starts_the_context_at_line_one():
    result, _ = _edit(b'a\nb\nc\n', 'a', 'A')
    assert result['edited_lines'] == '1-1'
    assert result['context'].startswith('     1\tA')


def test_str_replace_at_the_end_of_a_file_without_a_final_newline():
    result, script = _edit(b'a\nb', 'b', 'B')
    assert script.stdins[1] == b'a\nB'
    assert result['context'].endswith('     2\tB')


def test_str_replace_can_delete_text_by_replacing_it_with_nothing():
    result, script = _edit(b'keep drop keep\n', ' drop', '')
    assert script.stdins[1] == b'keep keep\n'
    assert result['edited_lines'] == '1-1'


def test_str_replace_takes_old_str_literally_not_as_a_pattern():
    result, script = _edit(b'a.c abc\n', 'a.c', 'X')
    assert script.stdins[1] == b'X abc\n'
    assert result['edited_lines'] == '1-1'


def test_str_replace_matches_across_lines():
    _, script = _edit(b'one\ntwo\nthree\n', 'one\ntwo', '1-2')
    assert script.stdins[1] == b'1-2\nthree\n'


def test_str_replace_keeps_unicode_intact_in_the_bytes_it_writes():
    _, script = _edit('héllo wörld\n'.encode(), 'wörld', 'wörld 日本')
    assert script.stdins[1] == 'héllo wörld 日本\n'.encode()


def test_str_replace_can_replace_a_blank_line_it_is_the_only_one_of():
    _, script = _edit(b'a\n\nb\n', '\n\n', '\n')
    assert script.stdins[1] == b'a\nb\n'


# confine, extra cases.


@pytest.mark.parametrize(
    'path',
    [
        '../x',
        '..',
        'a/../..',
        'outputs/../../etc',
        'outputs/../../etc/passwd',
        '/',
        '/workspacefoo',
        '/workspacefoo/x',
        '/workspace/../etc',
        '/workspace/..',
        '//etc/passwd',
        '///workspace/../etc',
        '/tmp/x',
        '/proc/self/environ',
        'a\r\n',
        '\n',
        '\0',
        '/etc/../workspace/../etc',
    ],
)
def test_confine_refuses_more_ways_out_of_workspace(path):
    with pytest.raises(ws.WorkspaceError):
        ws.confine(path)


@pytest.mark.parametrize(
    'path',
    [
        'é/日本語.txt',
        'a b/c d',
        'dir/',
        '/workspace/',
        '/workspace/dir/',
        './x',
        'a/./b',
        'a//b',
        '/workspace/../workspace/x',
        '///workspace/x',
        'workspace/x',
        '~',
        '$HOME',
        '-rf',
        '*',
        'a\tb',
        '\x01',
        '..hidden',
        '.../x',
        'a/..b',
    ],
)
def test_confine_passes_these_legitimate_or_harmless_paths_unchanged(path):
    assert ws.confine(path) == path


def test_confine_counts_the_limit_in_bytes_not_characters():
    assert ws.confine('é' * 2048) == 'é' * 2048
    with pytest.raises(ws.WorkspaceError, match='4098 bytes'):
        ws.confine('é' * 2049)


@pytest.mark.parametrize('bad', [None, 5, b'x', ['x'], ('x',), 1.5])
def test_confine_refuses_a_path_of_the_wrong_type_by_name(bad):
    with pytest.raises(ws.WorkspaceError, match='the path must be a string'):
        ws.confine(bad)


def test_confine_refuses_a_str_subclass_that_could_lie_about_its_content():
    class Sneaky(str):
        pass

    with pytest.raises(ws.WorkspaceError, match='must be a string'):
        ws.confine(Sneaky('/etc/passwd'))


# The argv builders.


# Every guest helper: (name, the argv for a path, the script it runs or None, where the path sits in the argv).
_HELPERS: list[tuple[str, Callable[[str], list[str]], str | None, int]] = [
    ('lllm-path', ws.resolve_argv, None, -1),
    ('read', ws.read_argv, ws.READ_SCRIPT, -1),
    ('list', ws.list_argv, ws.LIST_SCRIPT, -1),
    ('write', lambda path: ws.write_argv(path, overwrite=True), ws.WRITE_SCRIPT, -2),
]
# A program named without its absolute path: not preceded by a word character, `/`, `.` or `-`.
_BARE_PROGRAM = re.compile(r'(?<![\w/.-])(find|head|mkdir|cat|realpath|mktemp|mv|chmod|rm|bash|env)\b')


@pytest.mark.parametrize(('name', 'build', 'script', 'at'), _HELPERS, ids=[h[0] for h in _HELPERS])
def test_every_helper_argv_starts_from_an_empty_environment_right_after_the_timeout(name, build, script, at):
    argv = build('p')
    assert argv[:3] == ['/usr/bin/timeout', '--kill-after=5', str(ws.HELPER_TIMEOUT_S)]
    assert argv[3 : 3 + len(ws.GUEST_SHELL)] == list(ws.GUEST_SHELL)


@pytest.mark.parametrize(('name', 'build', 'script', 'at'), _HELPERS, ids=[h[0] for h in _HELPERS])
def test_the_model_path_is_a_positional_argument_never_part_of_a_script(name, build, script, at):
    nasty = "x'; touch /workspace/pwned; echo '"
    argv = build(nasty)
    assert argv[at] == nasty
    assert argv.count(nasty) == 1
    if script is not None:
        assert nasty not in script
        assert '"$1"' in script


@pytest.mark.parametrize(
    ('name', 'script'), [(h[0], h[2]) for h in _HELPERS if h[2] is not None], ids=[h[0] for h in _HELPERS if h[2]]
)
def test_the_helper_scripts_call_only_programs_by_absolute_path(name, script):
    assert _BARE_PROGRAM.findall(script) == []


def test_the_bare_program_check_catches_a_program_named_without_its_path():
    for line in ('find "$p"', 'x | head -c 1', 'p=$(realpath x)', 'a; mv a b', '(cat x)'):
        assert _BARE_PROGRAM.search(line), line


# The tools, through SandboxManager and FakeBackend.


def _run(rig: _Rig, tool: Callable, **kwargs) -> dict | str:
    return asyncio.run(rig.call(tool, **kwargs))


@pytest.mark.parametrize(
    ('given', 'used'),
    [
        (-5, 1),
        (-(10**30), 1),
        (1, 1),
        (300, 300),
        (301, 300),
        (10**30, 300),
        ('7', 7),
        ('7.0', 7),
        (7.0, 7),
        (' 9 ', 9),
        ('1e2', 100),
        ('1e30', 300),
        ('', 60),
        (None, 60),
    ],
)
def test_bash_timeout_is_read_leniently_and_clamped(monkeypatch, given, used):
    rig = _Rig(monkeypatch)
    _run(rig, builtin.bash, command='printf hi', timeout_s=given)
    assert rig.execs() == [wrap_command('printf hi', used)]


@pytest.mark.parametrize('given', ['abc', 'nan', 'inf', '-inf', '1.5', 2.5, True, False, [], {}, '0x10', '5s'])
def test_bash_refuses_a_timeout_that_is_not_a_whole_number_and_runs_nothing(monkeypatch, given):
    rig = _Rig(monkeypatch)
    result = _run(rig, builtin.bash, command='printf hi', timeout_s=given)
    assert isinstance(result, dict)
    assert result['error'].startswith('timeout_s must be a whole number')
    assert rig.backend.calls == []


@pytest.mark.parametrize('image', ['', 'DATA', 'data ', ' web', 'Web', 'gpu', 'data\0', 'data\n', 'None', 0, False])
def test_bash_refuses_any_image_but_data_or_web_naming_both(monkeypatch, image):
    rig = _Rig(monkeypatch)
    result = _run(rig, builtin.bash, command='printf hi', image=image)
    assert isinstance(result, dict)
    assert result['error'].startswith("image must be 'data' or 'web', not ")
    assert rig.backend.calls == []


@pytest.mark.parametrize('image', [None, 'data', 'web'])
def test_bash_runs_on_each_valid_image(monkeypatch, image):
    rig = _Rig(monkeypatch)
    result = _run(rig, builtin.bash, command='printf hi', image=image)
    assert isinstance(result, dict)
    assert result['returncode'] == 0


def test_bash_returns_a_nonzero_exit_as_a_result_not_an_error(monkeypatch):
    rig = _Rig(monkeypatch)
    result = _run(rig, builtin.bash, command='cat missing')
    assert isinstance(result, dict)
    assert 'error' not in result
    assert result['returncode'] == 1
    assert 'No such file' in result['stderr']


def test_bash_does_not_escape_non_ascii_output(monkeypatch):
    rig = _Rig(monkeypatch)
    out = asyncio.run(
        builtin.bash(command='printf é', __request__=cast(Any, rig.request), __user__={'id': 'u1'}, __chat_id__=CHAT)
    )
    assert '"stdout":"é"' in out.replace(' ', '')


@pytest.mark.parametrize('command', [None, 5, b'x', ['ls']])
def test_bash_refuses_a_command_that_is_not_a_string_without_raising(monkeypatch, command):
    rig = _Rig(monkeypatch)
    result = _run(rig, builtin.bash, command=command)
    assert isinstance(result, dict)
    assert 'error' in result
    assert rig.backend.calls == []


@pytest.mark.parametrize(
    ('path', 'content', 'size'),
    [
        ('données/日本.txt', 'é', 2),
        ('日本/語.txt', '日本語', 9),
        ('emoji 🎉/f.txt', '🎉', 4),
        ('empty.txt', '', 0),
        ('crlf.txt', 'a\r\nb\r\n', 6),
    ],
)
def test_write_file_and_view_round_trip_unicode_names_and_count_bytes_not_characters(monkeypatch, path, content, size):
    rig = _Rig(monkeypatch)
    written = _run(rig, builtin.write_file, path=path, content=content)
    assert written == {'path': f'/workspace/{path}', 'bytes_written': size}
    shown = _run(rig, builtin.view, path=path)
    assert isinstance(shown, dict)
    expected = content.split('\n')
    assert shown['total_lines'] == (len(expected) - (1 if expected[-1] == '' else 0))


def test_write_file_creates_parent_directories_and_reports_the_absolute_path(monkeypatch):
    rig = _Rig(monkeypatch)
    written = _run(rig, builtin.write_file, path='a/b/c/d.txt', content='x')
    assert written == {'path': '/workspace/a/b/c/d.txt', 'bytes_written': 1}


@pytest.mark.parametrize('given', ['dir', '/workspace/dir', './dir', 'a/../dir', '/workspace/./dir'])
def test_write_file_normalises_the_path_the_same_way_however_it_is_spelled(monkeypatch, given):
    rig = _Rig(monkeypatch)
    assert _run(rig, builtin.write_file, path=given, content='x') == {'path': '/workspace/dir', 'bytes_written': 1}


@pytest.mark.parametrize('path', ['/workspace', '.', '', '/workspace/', 'sub/..'])
def test_write_file_refuses_the_workspace_itself_and_an_empty_path(monkeypatch, path):
    rig = _Rig(monkeypatch)
    result = _run(rig, builtin.write_file, path=path, content='x', overwrite=True)
    assert isinstance(result, dict)
    assert 'error' in result


def test_write_file_refuses_to_write_over_a_directory_even_with_overwrite(monkeypatch):
    rig = _Rig(monkeypatch)
    _run(rig, builtin.write_file, path='d/f.txt', content='x')
    result = _run(rig, builtin.write_file, path='d', content='x', overwrite=True)
    assert isinstance(result, dict)
    assert 'is a directory' in result['error']


def test_write_file_refuses_a_path_under_an_existing_file(monkeypatch):
    rig = _Rig(monkeypatch)
    _run(rig, builtin.write_file, path='f.txt', content='x')
    result = _run(rig, builtin.write_file, path='f.txt/g', content='y')
    assert isinstance(result, dict)
    assert 'error' in result


@pytest.mark.parametrize('overwrite', [None, 'false', 'FALSE', False])
def test_write_file_overwrites_only_for_the_boolean_true(monkeypatch, overwrite):
    rig = _Rig(monkeypatch)
    _run(rig, builtin.write_file, path='f', content='one')
    result = _run(rig, builtin.write_file, path='f', content='two', overwrite=overwrite)
    assert isinstance(result, dict)
    assert 'already exists' in result['error']
    assert _run(rig, builtin.view, path='f') == {
        'path': '/workspace/f',
        'content': '     1\tone',
        'total_lines': 1,
        'showing_lines': '1-1',
    }


@pytest.mark.parametrize('overwrite', ['true', 'True', ' TRUE ', True])
def test_write_file_overwrites_for_true_or_the_text_true_in_any_case(monkeypatch, overwrite):
    rig = _Rig(monkeypatch)
    _run(rig, builtin.write_file, path='f', content='one')
    assert _run(rig, builtin.write_file, path='f', content='two', overwrite=overwrite) == {
        'path': '/workspace/f',
        'bytes_written': 3,
    }
    assert cast(dict, _run(rig, builtin.view, path='f'))['content'] == '     1\ttwo'


@pytest.mark.parametrize('overwrite', [1, 0, 'yes', 'no', 1.0, ['true']])
def test_write_file_refuses_an_overwrite_that_is_neither_true_nor_false_before_anything_runs(monkeypatch, overwrite):
    rig = _Rig(monkeypatch)
    result = _run(rig, builtin.write_file, path='f', content='x', overwrite=overwrite)
    assert result == {'error': f'overwrite must be true or false, not {overwrite!r}'}
    assert rig.backend.calls == []


@pytest.mark.parametrize('content', [None, 5, b'x', ['x']])
def test_write_file_refuses_content_that_is_not_text_without_raising_and_writes_nothing(monkeypatch, content):
    rig = _Rig(monkeypatch)
    result = _run(rig, builtin.write_file, path='f', content=content)
    assert isinstance(result, dict)
    assert 'error' in result
    assert rig.backend.calls == []


def test_write_file_refuses_content_that_cannot_be_utf_8_encoded(monkeypatch):
    rig = _Rig(monkeypatch)
    result = _run(rig, builtin.write_file, path='f', content='\ud800')
    assert isinstance(result, dict)
    assert 'error' in result
    assert rig.backend.calls == []


@pytest.mark.parametrize(
    ('kwargs', 'error'),
    [
        ({'start_line': 0}, 'start_line must be 1 or more, not 0'),
        ({'start_line': -3}, 'start_line must be 1 or more, not -3'),
        ({'start_line': 9}, 'start_line 9 is past the end of the file, which has 3 lines'),
        ({'start_line': 3, 'end_line': 1}, 'end_line 1 is before start_line 3'),
        ({'end_line': 0}, 'end_line 0 is before start_line 1'),
        ({'start_line': 'abc'}, "start_line must be a whole number, got 'abc'"),
        ({'end_line': 'x'}, "end_line must be a whole number, got 'x'"),
        ({'start_line': 1.5}, 'start_line must be a whole number, got 1.5'),
        ({'start_line': True}, 'start_line must be a whole number, got True'),
    ],
)
def test_view_refuses_a_bad_line_range_naming_the_fault(monkeypatch, kwargs, error):
    rig = _Rig(monkeypatch)
    _run(rig, builtin.write_file, path='f', content='a\nb\nc\n')
    result = _run(rig, builtin.view, path='f', **kwargs)
    assert isinstance(result, dict)
    assert result['error'] == error


@pytest.mark.parametrize(
    ('kwargs', 'shown'),
    [
        ({'start_line': '2', 'end_line': '3'}, '2-3'),
        ({'start_line': 2.0}, '2-3'),
        ({'start_line': '', 'end_line': ''}, '1-3'),
        ({'end_line': 10**30}, '1-3'),
        ({'start_line': 3, 'end_line': 3}, '3-3'),
    ],
)
def test_view_reads_line_numbers_leniently(monkeypatch, kwargs, shown):
    rig = _Rig(monkeypatch)
    _run(rig, builtin.write_file, path='f', content='a\nb\nc\n')
    result = _run(rig, builtin.view, path='f', **kwargs)
    assert isinstance(result, dict)
    assert result['showing_lines'] == shown


def test_view_pages_a_long_file_and_a_very_long_line_through_the_tool(monkeypatch):
    rig = _Rig(monkeypatch)
    _run(rig, builtin.write_file, path='long.txt', content='short\n' + 'q' * 100_000 + '\nlast\n')
    first = _run(rig, builtin.view, path='long.txt')
    assert isinstance(first, dict)
    assert first['next_start_line'] == 2
    second = _run(rig, builtin.view, path='long.txt', start_line=first['next_start_line'])
    assert isinstance(second, dict)
    assert 'rest of the line cut' in second['content']
    assert len(second['content']) < STREAM_CAP_CHARS + 100


def test_view_lists_two_levels_without_hidden_entries_except_runs(monkeypatch):
    rig = _Rig(monkeypatch)

    async def go():
        await rig.call(builtin.bash, command='mkdir -p a/b/c')
        for name in ('top.txt', 'a/two.txt', 'a/b/three.txt', 'a/b/c/four.txt', '.env', 'a/.hid'):
            await rig.call(builtin.write_file, path=name, content='x')
        await rig.call(builtin.write_file, path='.hidden/inner.txt', content='x')
        await rig.call(builtin.write_file, path='.runs/1.py', content='x')
        await rig.call(builtin.write_file, path='.runs/.nested', content='x')
        return await rig.call(builtin.view, path='.')

    listing = asyncio.run(go())
    assert isinstance(listing, dict)
    assert listing['entries'] == [
        '.runs/',
        '.runs/1.py (1 bytes)',
        'a/',
        'a/b/',
        'a/two.txt (1 bytes)',
        'top.txt (1 bytes)',
        # Every sandbox has its read-only uploads mount (T13), empty without attachments.
        'uploads/',
    ]


def test_view_of_a_subdirectory_lists_relative_to_it(monkeypatch):
    rig = _Rig(monkeypatch)
    _run(rig, builtin.write_file, path='a/b/f.txt', content='x')
    listing = _run(rig, builtin.view, path='a/')
    assert listing == {'path': '/workspace/a', 'entries': ['b/', 'b/f.txt (1 bytes)']}


@pytest.mark.parametrize('path', ['.', '/workspace', '/workspace/', ''])
def test_view_of_the_workspace_itself_is_a_listing_except_for_the_empty_path(monkeypatch, path):
    rig = _Rig(monkeypatch)
    result = _run(rig, builtin.view, path=path)
    assert isinstance(result, dict)
    if path:
        # Every sandbox has its read-only uploads mount (T13), empty without attachments.
        assert result == {'path': '/workspace', 'entries': ['uploads/']}
    else:
        assert result['error'] == 'the path is empty'


@pytest.mark.parametrize(
    'path',
    ['/workspacefoo', '/workspace/..', 'outputs/../../etc', 'outputs/../../etc/passwd', '//etc/passwd', '/', '..'],
)
def test_view_refuses_every_lexical_way_out_before_running_anything(monkeypatch, path):
    rig = _Rig(monkeypatch)
    result = _run(rig, builtin.view, path=path)
    assert isinstance(result, dict)
    assert 'outside /workspace' in result['error']
    assert rig.execs() == []
    assert not any(name in ('stat', 'get_files', 'put_files') for name, _ in rig.backend.calls)


def test_view_refuses_a_symlink_to_a_file_outside_through_every_tool_and_leaks_nothing(monkeypatch):
    rig = _Rig(monkeypatch)
    _run(rig, builtin.bash, command='ln -s /etc/passwd leak')
    before = len(rig.backend.calls)
    for result in (
        _run(rig, builtin.view, path='leak'),
        _run(rig, builtin.write_file, path='leak', content='x', overwrite=True),
        _run(rig, builtin.str_replace, path='leak', old_str='root', new_str='x'),
    ):
        assert isinstance(result, dict)
        assert 'the path leads outside /workspace' in result['error']
    assert not any(name in ('stat', 'get_files', 'put_files') for name, _ in rig.backend.calls[before:])


def test_view_follows_a_symlink_that_stays_inside_workspace(monkeypatch):
    rig = _Rig(monkeypatch)
    _run(rig, builtin.write_file, path='real/f.txt', content='hi\n')
    _run(rig, builtin.bash, command='ln -s real alias')
    shown = _run(rig, builtin.view, path='alias/f.txt')
    assert isinstance(shown, dict)
    assert shown['path'] == '/workspace/real/f.txt'


def test_str_replace_through_a_symlink_inside_workspace_edits_the_target(monkeypatch):
    rig = _Rig(monkeypatch)
    _run(rig, builtin.write_file, path='real/f.txt', content='hi\n')
    _run(rig, builtin.bash, command='ln -s real alias')
    edited = _run(rig, builtin.str_replace, path='alias/f.txt', old_str='hi', new_str='bye')
    assert isinstance(edited, dict)
    assert edited['path'] == '/workspace/real/f.txt'
    assert _run(rig, builtin.view, path='real/f.txt') == {
        'path': '/workspace/real/f.txt',
        'content': '     1\tbye',
        'total_lines': 1,
        'showing_lines': '1-1',
    }


def test_str_replace_refuses_a_directory_and_a_missing_file(monkeypatch):
    rig = _Rig(monkeypatch)
    _run(rig, builtin.write_file, path='d/f', content='x')
    directory = _run(rig, builtin.str_replace, path='d', old_str='x', new_str='y')
    missing = _run(rig, builtin.str_replace, path='nope', old_str='x', new_str='y')
    assert isinstance(directory, dict)
    assert isinstance(missing, dict)
    assert directory['error'] == 'd is not a regular file'
    assert missing['error'] == 'nope: no such file or directory'


def test_str_replace_on_a_file_the_guest_will_not_let_it_write_reports_the_guests_reason(monkeypatch):
    rig = _Rig(monkeypatch)
    _run(rig, builtin.write_file, path='ro.txt', content='x')
    _run(rig, builtin.bash, command='chmod 444 ro.txt')
    result = _run(rig, builtin.str_replace, path='ro.txt', old_str='x', new_str='y')
    assert result == {'error': '/workspace/ro.txt is read-only'}
    assert _page(_run(rig, builtin.view, path='ro.txt'))['content'] == '     1\tx'


@pytest.mark.parametrize('new', [None, 5])
def test_str_replace_with_a_new_str_that_is_not_text_is_an_error_not_a_crash(monkeypatch, new):
    rig = _Rig(monkeypatch)
    _run(rig, builtin.write_file, path='f', content='abc')
    result = _run(rig, builtin.str_replace, path='f', old_str='b', new_str=new)
    assert result == {'error': f'new_str must be text, not {type(new).__name__}'}
    assert _page(_run(rig, builtin.view, path='f'))['content'] == '     1\tabc'


def test_view_of_an_image_the_guest_holds_is_a_bare_data_uri_not_json(monkeypatch):
    rig = _Rig(monkeypatch)
    gif = b'GIF89a\x02\x00\x01\x00\x00\x00\x00\x2c\x00\x00\x00\x00\x02\x00\x01\x00\x00\x02\x00\x3b'

    async def go():
        await rig.call(builtin.bash, command='printf hi')
        box = next(iter(rig.backend.sandboxes.values()))
        box.files['/workspace/a.gif'] = FakeFile(content=gif, uid=1000, mode=0o644)
        return await builtin.view(
            path='a.gif', __request__=cast(Any, rig.request), __user__={'id': 'u1'}, __chat_id__=CHAT
        )

    out = asyncio.run(go())
    assert out == 'data:image/gif;base64,' + base64.b64encode(gif).decode()


# Error mapping: every error type, through every tool.

_TOOL_CALLS: list[tuple[str, Callable, dict]] = [
    ('bash', builtin.bash, {'command': 'printf hi'}),
    ('view', builtin.view, {'path': 'f'}),
    ('write_file', builtin.write_file, {'path': 'f', 'content': 'x'}),
    ('str_replace', builtin.str_replace, {'path': 'f', 'old_str': 'a', 'new_str': 'b'}),
]


@pytest.mark.parametrize(('name', 'tool', 'kwargs'), _TOOL_CALLS, ids=[c[0] for c in _TOOL_CALLS])
@pytest.mark.parametrize(
    ('raised', 'message'),
    [
        # The text of an error that may carry internals is never passed on (T12's security review, S4).
        (SandboxUnavailable('no docker at /run/docker.sock'), 'The sandbox is not available on this server'),
        (SandboxRefused('too many'), 'The sandbox cannot be used in this chat: too many'),
        (
            SandboxError('vm died at /var/lib/kata'),
            '{name} failed inside the sandbox service; try again, and say so if it keeps failing',
        ),
        (SandboxError('vm died at /var/lib/kata', public='no slot'), 'The sandbox failed: no slot'),
        (
            SandboxNotRunning('container gone: http+docker://localhost/v1.47'),
            'The sandbox failed: it stopped during the call; the next call starts it again',
        ),
        # Only a WorkspaceError is the model's own mistake; a ValueError or TypeError from inside the backend may
        # be a library's, carrying a URL or a row's values (T12's security re-review, R3).
        (ws.WorkspaceError('no such file'), 'no such file'),
        (
            ValueError('Invalid URL http+docker://localhost/v1.47'),
            '{name} failed inside the sandbox service; try again, and say so if it keeps failing',
        ),
        (
            TypeError('wrong type in row {"id": 1}'),
            '{name} failed inside the sandbox service; try again, and say so if it keeps failing',
        ),
        (
            RuntimeError('unexpected at 127.0.0.1:5432'),
            '{name} failed inside the sandbox service; try again, and say so if it keeps failing',
        ),
    ],
    ids=['unavailable', 'refused', 'error', 'public', 'not-running', 'workspace', 'value', 'type', 'other'],
)
def test_every_tool_maps_each_error_type_to_a_json_error_and_never_raises(
    monkeypatch, name, tool, kwargs, raised, message
):
    rig = _Rig(monkeypatch)
    _run(rig, builtin.bash, command='printf hi')

    async def boom(*args, **kwargs):
        raise raised

    monkeypatch.setattr(rig.backend, 'exec', boom)
    result = _run(rig, tool, **kwargs)
    assert result == {'error': message.format(name=name)}


@pytest.mark.parametrize(('name', 'tool', 'kwargs'), _TOOL_CALLS, ids=[c[0] for c in _TOOL_CALLS])
def test_every_tool_says_the_sandbox_is_not_available_without_a_manager(monkeypatch, name, tool, kwargs):
    rig = _Rig(monkeypatch, manager=False)
    assert _run(rig, tool, **kwargs) == {'error': 'The sandbox is not available on this server'}


@pytest.mark.parametrize(
    'request_object', [None, SimpleNamespace(), SimpleNamespace(app=None), SimpleNamespace(app=SimpleNamespace())]
)
def test_a_missing_request_or_app_or_state_is_a_tool_error_never_an_attribute_error(request_object):
    out = asyncio.run(builtin.view(path='f', __request__=cast(Any, request_object), __user__={'id': 'u1'}))
    assert json.loads(out) == {'error': 'The sandbox is not available on this server'}


@pytest.mark.parametrize('user', [None, {}, {'id': ''}, {'id': 'ghost'}])
def test_every_tool_refuses_a_missing_or_unknown_user(monkeypatch, user):
    rig = _Rig(monkeypatch)
    for _, tool, kwargs in _TOOL_CALLS:
        out = asyncio.run(
            tool(**kwargs, __request__=cast(Any, rig.request), __user__=cast(Any, user), __chat_id__=CHAT)
        )
        assert json.loads(out) == {
            'error': 'The sandbox cannot be used in this chat: no sandbox without a signed-in user'
        }
    assert rig.backend.calls == []


@pytest.mark.parametrize('chat', [None, '', 'not-a-uuid'])
def test_every_tool_refuses_a_chat_that_is_missing_or_not_an_id(monkeypatch, chat):
    rig = _Rig(monkeypatch)
    for _, tool, kwargs in _TOOL_CALLS:
        out = asyncio.run(tool(**kwargs, __request__=cast(Any, rig.request), __user__={'id': 'u1'}, __chat_id__=chat))
        assert 'error' in json.loads(out)
    assert rig.backend.calls == []


def test_the_chat_id_falls_back_to_the_one_in_the_metadata(monkeypatch):
    rig = _Rig(monkeypatch)
    out = asyncio.run(
        builtin.bash(
            command='printf hi',
            __request__=cast(Any, rig.request),
            __user__={'id': 'u1'},
            __chat_id__=None,
            __metadata__={'chat_id': CHAT},
        )
    )
    assert json.loads(out)['stdout'] == 'hi'


def test_the_chat_id_argument_wins_over_the_metadata(monkeypatch):
    rig = _Rig(monkeypatch)
    other = '22222222-2222-4222-8222-222222222222'
    out = asyncio.run(
        builtin.bash(
            command='printf hi',
            __request__=cast(Any, rig.request),
            __user__={'id': 'u1'},
            __chat_id__=CHAT,
            __metadata__={'chat_id': other},
        )
    )
    assert json.loads(out)['stdout'] == 'hi'


class _WaitingManager:
    """A manager whose session first calls on_wait, as one does when the chat has to queue for a slot."""

    def __init__(self, wait: bool) -> None:
        self.wait = wait

    @asynccontextmanager
    async def session(self, chat_id, user, *, image=None, on_wait=None):
        if self.wait and on_wait is not None:
            await on_wait()
        yield _Script([_ok(stdout='hi')])


def _waiting_call(wait: bool, emit: Callable | None) -> tuple[dict, str]:
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(sandbox=_WaitingManager(wait))))

    async def go() -> str:
        return await builtin.bash(
            command='printf hi',
            __request__=cast(Any, request),
            __user__={'id': 'u1'},
            __chat_id__=CHAT,
            __event_emitter__=emit,
        )

    out = asyncio.run(go())
    return json.loads(out), out


@pytest.fixture
def known_user(monkeypatch):
    from local_llm.models.users import Users

    async def get_user_by_id(user_id, db=None):
        return SimpleNamespace(id=user_id, role='user')

    monkeypatch.setattr(Users, 'get_user_by_id', get_user_by_id)


def test_a_call_that_queues_for_a_sandbox_says_so_and_then_that_it_is_ready(known_user):
    events: list[dict] = []

    async def emit(event: dict) -> None:
        events.append(event)

    result, _ = _waiting_call(True, emit)
    assert result['stdout'] == 'hi'
    assert events == [
        {'type': 'status', 'data': {'description': 'Waiting for a free sandbox', 'done': False}},
        {'type': 'status', 'data': {'description': 'Sandbox ready', 'done': True}},
    ]


def test_a_call_that_does_not_queue_emits_no_status(known_user):
    events: list[dict] = []

    async def emit(event: dict) -> None:
        events.append(event)

    _waiting_call(False, emit)
    assert events == []


def test_a_call_that_queues_without_an_event_emitter_still_runs(known_user):
    result, _ = _waiting_call(True, None)
    assert result['stdout'] == 'hi'


def test_the_manager_is_never_handed_a_session_for_a_bad_image(monkeypatch):
    rig = _Rig(monkeypatch)
    manager = cast(SandboxManager, rig.request.app.state.sandbox)
    seen: list[str | None] = []
    real = manager.session

    @asynccontextmanager
    async def spy(chat_id, user, *, image=None, on_wait=None):
        seen.append(image)
        async with real(chat_id, user, image=image, on_wait=on_wait) as session:
            yield session

    monkeypatch.setattr(manager, 'session', spy)
    _run(rig, builtin.bash, command='printf hi', image='nope')
    _run(rig, builtin.bash, command='printf hi', image='web')
    assert seen == ['web']
