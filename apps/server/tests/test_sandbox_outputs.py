"""Sandbox outputs (T17): the listing, the diff, attaching files to the message, PDF previews, and serving them.

The listing and preview scripts are also run for real, with bash, against a
temporary directory standing in for /workspace. Everything else talks to a
stub session (the FakeBackend learns `find` with the bash tool's wiring),
the test run's migrated SQLite database and its local upload directory. The
routes run behind real tokens through the real auth dependencies.

Run from apps/server:

    python -m pytest tests/test_sandbox_outputs.py
"""

from __future__ import annotations

import asyncio
import codecs
import datetime as dt
import hashlib
import importlib
import json
import os
import subprocess
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.constants import ERROR_MESSAGES
from local_llm.models.chats import ChatForm, Chats
from local_llm.models.files import FileForm, Files
from local_llm.models.users import Users
from local_llm.routers import files as files_router
from local_llm.routers import sandbox as sandbox_router
from local_llm.sandbox import outputs
from local_llm.sandbox.exec import wrap_argv
from local_llm.sandbox.fake import FakeBackend, FakeExecRequest, FakeFile, FakeRun, FakeWorkspace, interpret
from local_llm.sandbox.limits import HELPER_TIMEOUT_S, HTML_MAX_BYTES, OUTPUT_FILE_CAP_BYTES
from local_llm.sandbox.manager import SandboxManager, SandboxSettings
from local_llm.sandbox.outputs import (
    HTML_POLICY,
    OUTPUTS_DIR,
    PREVIEWS_DIR,
    Listing,
    OutputEntry,
    changed_entries,
    collect,
    decode_html,
    display_name,
    is_sandbox_output,
    list_outputs,
    parse_listing,
    with_policy,
)
from local_llm.sandbox.types import ExecResult, FileStat, SandboxError, SandboxNotRunning
from local_llm.sandbox.workspace import GUEST_SHELL
from local_llm.storage.provider import Storage
from local_llm.tools import builtin
from local_llm.utils.auth import create_token

# Importing the config runs the migrations on the test run's database.
UPLOAD_DIR = importlib.import_module('local_llm.config').UPLOAD_DIR
CHAT = '11111111-1111-4111-8111-111111111111'


def _run(coro):
    return asyncio.run(coro)


def _result(stdout: str = '', returncode: int = 0, *, truncated: bool = False, stderr: str = '') -> ExecResult:
    return ExecResult(
        returncode=returncode, stdout=stdout, stderr=stderr, timed_out=False, truncated=truncated, duration_ms=1
    )


def _dir(path: str, kind: Any = 'dir') -> FileStat:
    return FileStat(path, kind, 1000, 0o755, 0, 0.0)


def _png(width: int, height: int) -> bytes:
    """The first bytes of a PNG: enough for workspace.image_type and image_size."""
    ihdr = width.to_bytes(4, 'big') + height.to_bytes(4, 'big') + b'\x08\x02\x00\x00\x00'
    return b'\x89PNG\r\n\x1a\n' + (13).to_bytes(4, 'big') + b'IHDR' + ihdr + b'\0' * 4


class StubSession:
    """A SandboxSession stand-in: files by path, stats by path, and exec answered by `on_exec`."""

    def __init__(self, files=None, stats=None, on_exec=None):
        self.files: dict[str, bytes] = dict(files or {})
        self.stats: dict[str, FileStat] = dict(stats or {})
        self.on_exec = on_exec or (lambda argv: _result())
        self.calls: list[tuple] = []

    async def exec(self, argv, timeout_s, stdin=None):
        self.calls.append(('exec', list(argv), timeout_s))
        return self.on_exec(argv)

    async def get_files(self, paths, max_bytes):
        self.calls.append(('get_files', list(paths), max_bytes))
        return {p: self.files[p] for p in paths if p in self.files and len(self.files[p]) <= max_bytes}

    async def stat(self, path):
        self.calls.append(('stat', path))
        return self.stats.get(path)


def _record(name: str, size: int, mtime: str = '1700000000.5000000000') -> str:
    return f'{mtime}\t{size}\t{name}\0'


# --- the listing -----------------------------------------------------------------------------------------------------


def test_parse_listing_reads_names_with_tabs_and_newlines():
    stdout = _record('a\tb.txt', 3) + _record('new\nline.csv', 4, '1600000000.0') + _record('sub/c.png', 5) + 'END\0'
    listing = parse_listing(stdout)
    assert listing.complete
    assert list(listing.entries) == ['a\tb.txt', 'new\nline.csv', 'sub/c.png']
    assert listing.entries['new\nline.csv'] == OutputEntry('new\nline.csv', 4, '1600000000.0')
    assert listing.entries['sub/c.png'].path == f'{OUTPUTS_DIR}/sub/c.png'


def test_parse_listing_without_its_end_record_is_incomplete():
    # Cut inside a record: the partial record is dropped, the whole ones kept.
    cut = parse_listing(_record('a.txt', 1) + '1700000000.1\t9\tpart')
    assert not cut.complete
    assert list(cut.entries) == ['a.txt']
    # Cut exactly after a record: no END, so still incomplete.
    assert not parse_listing(_record('a.txt', 1)).complete
    # END not ended by its NUL, and nothing at all.
    assert not parse_listing(_record('a.txt', 1) + 'END').complete
    assert parse_listing('') == Listing({}, complete=False)
    assert parse_listing('END\0') == Listing({}, complete=True)


def test_parse_listing_drops_records_that_do_not_parse_or_leave_outputs():
    stdout = (
        _record('../escape', 1)
        + _record('a/../../b', 1)
        + _record('x//y', 1)
        + _record('', 1)
        + 'notatime\t1\tz\0'
        + '1700000000\tbig\tz\0'
        + '1700000000\t1\0'
        + _record('ok', 1, '-315619200.0000000000')
        + _record('ok', 2)
        + 'END\0'
    )
    listing = parse_listing(stdout)
    assert listing.complete
    # A name listed twice keeps its first (newest) record.
    assert listing.entries == {'ok': OutputEntry('ok', 1, '-315619200.0000000000')}


def test_list_outputs_runs_the_fixed_script_without_a_shell_on_the_host():
    session = StubSession(
        stats={OUTPUTS_DIR: _dir(OUTPUTS_DIR)}, on_exec=lambda argv: _result(_record('a.txt', 1) + 'END\0')
    )
    listing = _run(list_outputs(session))
    assert listing == Listing({'a.txt': OutputEntry('a.txt', 1, '1700000000.5000000000')})
    (call,) = [c for c in session.calls if c[0] == 'exec']
    assert call[1] == wrap_argv([*GUEST_SHELL, '-c', outputs.LIST_SCRIPT, 'lllm-outputs'], HELPER_TIMEOUT_S)
    assert call[2] == HELPER_TIMEOUT_S
    for part in ('/usr/bin/find -P', '-xdev', '-type f', '-readable', '\\0', '/usr/bin/sort -z', '/usr/bin/head -c'):
        assert part in outputs.LIST_SCRIPT


@pytest.mark.parametrize('stat', [None, _dir(OUTPUTS_DIR, 'symlink'), _dir(OUTPUTS_DIR, 'file')])
def test_list_outputs_is_empty_without_a_real_outputs_directory(stat):
    session = StubSession(stats={OUTPUTS_DIR: stat} if stat else {})
    assert _run(list_outputs(session)) == Listing()
    assert [c[0] for c in session.calls] == ['stat']


@pytest.mark.parametrize('result', [_result('END\0', 124), _result('END\0', truncated=True), _result('', 127)])
def test_list_outputs_is_none_when_the_listing_fails(result):
    session = StubSession(stats={OUTPUTS_DIR: _dir(OUTPUTS_DIR)}, on_exec=lambda argv: result)
    assert _run(list_outputs(session)) is None


def _bash(script: str, *args: str) -> bytes:
    return subprocess.run([*GUEST_SHELL, '-c', script, 'test', *args], capture_output=True, check=True).stdout


def test_the_listing_script_lists_regular_files_only_never_through_a_symlink(tmp_path):
    out = tmp_path / 'outputs'
    (out / 'sub').mkdir(parents=True)
    (tmp_path / 'elsewhere').mkdir()
    (tmp_path / 'elsewhere' / 'secret').write_text('s')
    (out / 'plain.txt').write_text('a')
    (out / 'tab\tname').write_text('bb')
    (out / 'new\nline').write_text('ccc')
    (out / 'sub' / 'deep.csv').write_text('dddd')
    (out / 'link').symlink_to(tmp_path / 'elsewhere' / 'secret')
    (out / 'dirlink').symlink_to(tmp_path / 'elsewhere')
    os.mkfifo(out / 'fifo')
    os.utime(out / 'plain.txt', (1_000_000_000, 1_000_000_000))
    stdout = _bash(outputs.LIST_SCRIPT.replace(OUTPUTS_DIR, str(out))).decode()
    listing = parse_listing(stdout)
    assert listing.complete
    assert {name: entry.size for name, entry in listing.entries.items()} == {
        'tab\tname': 2,
        'new\nline': 3,
        'sub/deep.csv': 4,
        'plain.txt': 1,
    }
    # Newest first: the file dated 2001 comes last.
    assert list(listing.entries)[-1] == 'plain.txt'
    # A symlinked outputs directory lists nothing.
    (tmp_path / 'linked').symlink_to(out)
    assert (
        parse_listing(_bash(outputs.LIST_SCRIPT.replace(OUTPUTS_DIR, str(tmp_path / 'linked'))).decode()).entries == {}
    )


def test_the_listing_script_stops_at_its_cap_and_says_so(tmp_path):
    out = tmp_path / 'outputs'
    out.mkdir()
    for n in range(400):
        (out / f'{"x" * 60}-{n:03}').write_text('x')
    stdout = _bash(outputs.LIST_SCRIPT.replace(OUTPUTS_DIR, str(out)))
    assert len(stdout) == outputs.LISTING_CAP_BYTES
    listing = parse_listing(stdout.decode())
    assert not listing.complete
    assert 0 < len(listing.entries) < 400


# --- the diff --------------------------------------------------------------------------------------------------------


def _listing(*entries: OutputEntry, complete: bool = True) -> Listing:
    return Listing({e.name: e for e in entries}, complete)


def test_changed_entries_are_the_new_files_and_those_changed_in_size_or_time():
    same = OutputEntry('same.txt', 1, '10.0')
    grown = OutputEntry('grown.txt', 1, '10.0')
    touched = OutputEntry('touched.txt', 1, '10.0')
    gone = OutputEntry('gone.txt', 1, '10.0')
    before = _listing(same, grown, touched, gone)
    new = OutputEntry('new.png', 7, '20.0')
    after = _listing(new, OutputEntry('touched.txt', 1, '20.0'), OutputEntry('grown.txt', 2, '10.0'), same)
    assert [e.name for e in changed_entries(before, after)] == ['new.png', 'touched.txt', 'grown.txt']
    assert changed_entries(after, after) == []
    assert changed_entries(Listing(), after) == list(after.entries.values())


def test_a_cut_before_listing_counts_only_files_newer_than_its_oldest_as_new():
    before = _listing(OutputEntry('kept.txt', 1, '50.0'), complete=False)
    after = _listing(
        OutputEntry('fresh.txt', 1, '60.0'),
        OutputEntry('kept.txt', 2, '55.0'),
        OutputEntry('past-the-cut.txt', 1, '40.0'),
        OutputEntry('tie.txt', 1, '50.0'),
    )
    assert [e.name for e in changed_entries(before, after)] == ['fresh.txt', 'kept.txt']
    # Cut before a single record: nothing can be told apart.
    assert changed_entries(Listing({}, complete=False), after) == []


# --- attaching -------------------------------------------------------------------------------------------------------


def _people(tag: str = '') -> SimpleNamespace:
    tag = tag or uuid.uuid4().hex[:8]

    async def make():
        owner = await Users.insert_new_user(f'sbo-o-{tag}', 'Owner', f'sbo-o-{tag}@example.invalid', role='user')
        other = await Users.insert_new_user(f'sbo-x-{tag}', 'Other', f'sbo-x-{tag}@example.invalid', role='user')
        admin = await Users.insert_new_user(f'sbo-a-{tag}', 'Admin', f'sbo-a-{tag}@example.invalid', role='admin')
        return owner, other, admin

    owner, other, admin = _run(make())
    return SimpleNamespace(owner=owner, other=other, admin=admin)


def _app() -> FastAPI:
    app = FastAPI()
    app.state.redis = None
    app.include_router(files_router.router, prefix='/api/v1/files')
    app.include_router(sandbox_router.router, prefix='/api/v1/sandbox')
    return app


def _collect(session, entries, user, *, chat_id=None, message_id=None, upload=True, app=None, **kwargs):
    request = SimpleNamespace(app=app or _app())
    return _run(
        collect(
            session,
            entries,
            request=request,
            user=user,
            chat_id=chat_id,
            message_id=message_id,
            upload=upload,
            **kwargs,
        )
    )


def _entry(name: str, data: bytes, mtime: str = '20.0') -> OutputEntry:
    return OutputEntry(name, len(data), mtime)


def test_collect_stores_each_file_as_a_sandbox_output_linked_to_the_message():
    people = _people()
    chat_id = str(uuid.uuid4())
    _run(Chats.insert_new_chat(chat_id, people.owner.id, ChatForm(chat={'title': 'Outputs'})))
    figure, table = _png(64, 48), b'a,b\n1,2\n'
    session = StubSession(files={f'{OUTPUTS_DIR}/fig.png': figure, f'{OUTPUTS_DIR}/sub/t.csv': table})
    got = _collect(
        session,
        [_entry('fig.png', figure), _entry('sub/t.csv', table)],
        people.owner,
        chat_id=chat_id,
        message_id='m1',
    )
    assert [o['path'] for o in got.outputs] == ['outputs/fig.png', 'outputs/sub/t.csv']
    assert all('reason' not in o for o in got.outputs)
    fig_out, csv_out = got.outputs
    assert fig_out['content_type'] == 'image/png'
    assert csv_out['name'] == 't.csv'
    assert fig_out['url'] == f'/api/v1/files/{fig_out["file_id"]}/content'
    row = _run(Files.get_file_by_id(fig_out['file_id']))
    assert row is not None and row.user_id == people.owner.id
    assert row.meta is not None
    assert row.meta['source'] == 'sandbox_output'
    assert row.meta['sandbox_path'] == f'{OUTPUTS_DIR}/fig.png'
    assert (row.meta['name'], row.meta['content_type'], row.meta['size']) == ('fig.png', 'image/png', len(figure))
    assert is_sandbox_output(row.meta)
    assert Path(Storage.get_file(row.path)).read_bytes() == figure
    # The `files` event's descriptors carry the meta the frontend reads.
    assert got.files[0] == {
        'type': 'file',
        'id': fig_out['file_id'],
        'url': fig_out['url'],
        'name': 'fig.png',
        'size': len(figure),
        'meta': {'source': 'sandbox_output', 'sandbox_path': f'{OUTPUTS_DIR}/fig.png', 'content_type': 'image/png'},
    }
    linked = _run(Chats.get_chat_files_by_chat_id_and_message_id(chat_id, 'm1'))
    assert sorted(c.file_id for c in linked) == sorted([fig_out['file_id'], csv_out['file_id']])
    # One read per file, each capped at the per-file limit.
    reads = [c for c in session.calls if c[0] == 'get_files']
    assert reads == [
        ('get_files', [f'{OUTPUTS_DIR}/fig.png'], OUTPUT_FILE_CAP_BYTES),
        ('get_files', [f'{OUTPUTS_DIR}/sub/t.csv'], OUTPUT_FILE_CAP_BYTES),
    ]


def test_collect_links_nothing_for_an_unsaved_chat():
    people = _people()
    data = b'x'
    session = StubSession(files={f'{OUTPUTS_DIR}/a.txt': data})
    got = _collect(session, [_entry('a.txt', data)], people.owner, chat_id='local:abc', message_id='m1')
    assert got.outputs[0]['file_id']
    assert _run(Chats.get_chat_files_by_chat_id_and_message_id('local:abc', 'm1')) == []


def test_collect_names_what_it_does_not_attach(monkeypatch):
    people = _people()
    monkeypatch.setattr(outputs, 'OUTPUT_FILE_CAP_BYTES', 10)
    monkeypatch.setattr(outputs, 'OUTPUT_CALL_CAP_BYTES', 12)
    monkeypatch.setattr(outputs, 'OUTPUT_MAX_FILES', 3)
    files = {
        'a.txt': b'aaaaaa',  # attached: 6 of 12
        'huge.bin': b'h' * 11,  # over the per-file cap: not read
        'b.txt': b'bbbbbbb',  # 7 more would pass 12: not read
        'gone.txt': None,  # listed, then not readable as a regular file
        'liar.txt': b'llllllll',  # listed as 1 byte, read as 8: over what is left
        'bad\ufffdname': b'z',
        'empty.txt': b'',
        'c.txt': b'cc',  # attached: 8 of 12
        'd.txt': b'd',  # attached: the third file, at the count cap
        'e.txt': b'e',  # the fourth: over the count
    }
    entries = []
    for name, data in files.items():
        size = 1 if name == 'liar.txt' else (1 if data is None else len(data))
        entries.append(OutputEntry(name, size, '20.0'))
    session = StubSession(files={f'{OUTPUTS_DIR}/{n}': d for n, d in files.items() if d is not None})
    got = _collect(session, entries, people.owner)
    reasons = {o['name']: o.get('reason') for o in got.outputs}
    assert reasons['a.txt'] is None and reasons['c.txt'] is None and reasons['d.txt'] is None
    assert 'one file' in reasons['huge.bin']
    assert 'in all' in reasons['b.txt']
    assert 'regular file' in reasons['gone.txt']
    assert 'in all' in reasons['liar.txt']
    assert 'UTF-8' in reasons['bad\ufffdname']
    assert reasons['empty.txt'] == 'it is empty'
    assert 'more than 3 files' in reasons['e.txt']
    read = {p for c in session.calls if c[0] == 'get_files' for p in c[1]}
    assert f'{OUTPUTS_DIR}/huge.bin' not in read and f'{OUTPUTS_DIR}/b.txt' not in read
    assert len(got.files) == 3
    assert all('file_id' not in o for o in got.outputs if o.get('reason'))


def test_collect_with_uploads_off_lists_and_reads_nothing():
    people = _people()
    data = b'%PDF-1.4'
    session = StubSession(files={f'{OUTPUTS_DIR}/r.pdf': data})
    got = _collect(session, [_entry('r.pdf', data)], people.owner, chat_id=str(uuid.uuid4()), message_id='m')
    assert got.outputs[0]['file_id']
    session = StubSession(files={f'{OUTPUTS_DIR}/r.pdf': data})
    got = _collect(session, [_entry('r.pdf', data)], people.owner, upload=False)
    assert got.outputs == [
        {'path': 'outputs/r.pdf', 'name': 'r.pdf', 'size': len(data), 'content_type': 'application/pdf'}
    ]
    assert got.files == []
    assert session.calls == []


def test_collect_reports_a_file_it_could_not_store(monkeypatch):
    people = _people()
    session = StubSession(files={f'{OUTPUTS_DIR}/a.txt': b'a', f'{OUTPUTS_DIR}/b.txt': b'b'})

    def broken(*_a, **_k):
        raise OSError('disk full')

    monkeypatch.setattr(Storage, 'upload_file', broken)
    got = _collect(session, [_entry('a.txt', b'a')], people.owner)
    assert got.outputs[0]['reason'] == 'it could not be stored'
    monkeypatch.undo()

    deleted = []
    monkeypatch.setattr(Storage, 'delete_file', lambda path: deleted.append(path))

    async def no_row(*_a, **_k):
        return None

    monkeypatch.setattr(Files, 'insert_new_file', no_row)
    got = _collect(session, [_entry('b.txt', b'b')], people.owner)
    assert got.outputs[0]['reason'] == 'it could not be stored'
    assert len(deleted) == 1 and deleted[0].endswith('_b.txt')

    # An insert that raises leaves no blob either.
    async def broken_row(*_a, **_k):
        raise RuntimeError('constraint')

    monkeypatch.setattr(Files, 'insert_new_file', broken_row)
    got = _collect(session, [_entry('a.txt', b'a')], people.owner)
    assert got.outputs[0]['reason'] == 'it could not be stored'
    assert len(deleted) == 2 and deleted[1].endswith('_a.txt')


def test_display_name_keeps_names_printable_and_short():
    assert display_name('sub/dir/fig.png') == 'fig.png'
    assert display_name('evil‮gnp.exe') == 'evil_gnp.exe'
    assert display_name('a\nb\tc.txt') == 'a_b_c.txt'
    assert display_name('   ') == 'output'
    long = display_name('é' * 300 + '.csv')
    assert long.endswith('.csv') and len(long.encode()) <= 200
    assert len(display_name('x.' + 'y' * 300).encode()) <= 200


# --- PDF previews ----------------------------------------------------------------------------------------------------


def _preview_session(pdfs: dict[str, bytes], pages: dict[str, bytes], listing: str, render_status: int = 0):
    stats = {p: _dir(p) for p in (f'{outputs.WORKSPACE}/.lllm', PREVIEWS_DIR)}

    def on_exec(argv):
        if outputs.PREVIEW_SCRIPT in argv:
            return _result(returncode=render_status)
        assert outputs.PREVIEW_LIST_SCRIPT in argv
        return _result(listing)

    files = {f'{OUTPUTS_DIR}/{n}': d for n, d in pdfs.items()}
    files.update({f'{PREVIEWS_DIR}/{name}': data for name, data in pages.items()})
    return StubSession(files=files, stats=stats, on_exec=on_exec)


def test_a_pdf_gets_its_page_previews_stored_against_it():
    people = _people()
    chat_id = str(uuid.uuid4())
    _run(Chats.insert_new_chat(chat_id, people.owner.id, ChatForm(chat={'title': 'PDF'})))
    pdf = b'%PDF-1.4 report'
    pages = {
        'page-01.png': _png(680, 880),
        'page-02.png': _png(680, 880),
        'page-03.png': b'not a png',
        'page-04.png': _png(outputs.PREVIEW_MAX_SIDE + 1, 10),
        'page-11.png': _png(10, 10),
        'cover.png': _png(10, 10),
    }
    listing = 'page-02.png\0page-01.png\0page-03.png\0page-04.png\0page-11.png\0cover.png\0'
    session = _preview_session({'report.pdf': pdf}, pages, listing)
    got = _collect(session, [_entry('report.pdf', pdf)], people.owner, chat_id=chat_id, message_id='m')
    pdf_id = got.outputs[0]['file_id']
    previews = [f for f in got.files if f['meta'].get('preview_of')]
    assert [f['name'] for f in previews] == ['report.pdf-page-1.png', 'report.pdf-page-2.png']
    assert all(f['meta']['preview_of'] == pdf_id for f in previews)
    row = _run(Files.get_file_by_id(previews[0]['id']))
    assert row is not None and row.meta is not None
    assert row.meta['source'] == 'sandbox_output'
    assert (row.meta['preview_of'], row.meta['preview_page'], row.meta['content_type']) == (pdf_id, 1, 'image/png')
    # Previews are on the message, not in the model's result.
    assert len(got.outputs) == 1
    linked = _run(Chats.get_chat_files_by_chat_id_and_message_id(chat_id, 'm'))
    assert len(linked) == 3
    # The render and the listing are separate execs; the only argument is the PDF's listed path.
    execs = [c[1] for c in session.calls if c[0] == 'exec']
    assert execs == [
        wrap_argv(
            [*GUEST_SHELL, '-c', outputs.PREVIEW_SCRIPT, 'lllm-preview', f'{OUTPUTS_DIR}/report.pdf'], HELPER_TIMEOUT_S
        ),
        wrap_argv([*GUEST_SHELL, '-c', outputs.PREVIEW_LIST_SCRIPT, 'lllm-preview-list'], HELPER_TIMEOUT_S),
    ]
    # Every output is read before pdftoppm runs.
    kinds = [c[0] for c in session.calls]
    assert kinds.index('exec') > kinds.index('get_files')


@pytest.mark.parametrize('broken', ['render', 'listing', 'symlink'])
def test_no_previews_when_the_render_or_the_directories_are_wrong(broken):
    people = _people()
    pdf = b'%PDF'
    session = _preview_session(
        {'r.pdf': pdf}, {'page-1.png': _png(10, 10)}, 'page-1.png\0', render_status=1 if broken == 'render' else 0
    )
    if broken == 'listing':
        session.on_exec = lambda argv: _result('page-1.png\0', 0 if outputs.PREVIEW_SCRIPT in argv else 124)
    if broken == 'symlink':
        session.stats[PREVIEWS_DIR] = _dir(PREVIEWS_DIR, 'symlink')
    got = _collect(session, [_entry('r.pdf', pdf)], people.owner)
    assert got.outputs[0]['file_id']
    assert [f['meta'].get('preview_of') for f in got.files] == [None]


def test_previews_are_rendered_for_at_most_a_few_pdfs():
    people = _people()
    pdfs = {f'{n}.pdf': b'%PDF' for n in range(outputs.PREVIEW_MAX_PDFS + 1)}
    session = _preview_session(pdfs, {'page-1.png': _png(10, 10)}, 'page-1.png\0')
    got = _collect(session, [_entry(n, d) for n, d in pdfs.items()], people.owner)
    assert len([f for f in got.files if f['meta'].get('preview_of')]) == outputs.PREVIEW_MAX_PDFS


def test_the_preview_scripts_render_into_a_fresh_directory_and_refuse_a_symlinked_one(tmp_path):
    workspace = tmp_path / 'workspace'
    (workspace / 'outputs').mkdir(parents=True)
    (workspace / 'outputs' / 'r.pdf').write_bytes(b'%PDF')
    stale = workspace / '.lllm' / 'previews' / '9'
    stale.mkdir(parents=True)
    (stale / 'page-1.png').write_bytes(b'old')
    # A stand-in for pdftoppm that writes the two pages a two-page PDF gives.
    fake = tmp_path / 'pdftoppm'
    fake.write_text(
        '#!/bin/bash\nprintf "%s\\n" "$@" > "$(dirname "$0")/args"\n'
        'for n in 1 2; do printf png > "${@: -1}-$n.png"; done\n'
    )
    fake.chmod(0o755)
    render = outputs.PREVIEW_SCRIPT.replace(outputs.WORKSPACE, str(workspace)).replace('/usr/bin/pdftoppm', str(fake))
    listing = outputs.PREVIEW_LIST_SCRIPT.replace(outputs.WORKSPACE, str(workspace))
    target = str(workspace / '.lllm' / 'previews')
    _bash(render, str(workspace / 'outputs' / 'r.pdf'))
    assert not stale.exists()
    # The plan's resolution and page count, and the crop that bounds a huge page.
    pdf = str(workspace / 'outputs' / 'r.pdf')
    args = ['-png', '-r', '80', '-l', '10', '-W', '1600', '-H', '1600', pdf, f'{target}/page']
    assert (tmp_path / 'args').read_text().splitlines() == args
    assert sorted(os.listdir(target)) == ['page-1.png', 'page-2.png']
    assert sorted(_bash(listing).split(b'\0')) == [b'', b'page-1.png', b'page-2.png']
    # A /workspace/.lllm that is a symlink is refused before anything is made or removed.
    elsewhere = tmp_path / 'elsewhere'
    (elsewhere / 'previews').mkdir(parents=True)
    os.rename(workspace / '.lllm', tmp_path / 'old-lllm')
    (workspace / '.lllm').symlink_to(elsewhere)
    with pytest.raises(subprocess.CalledProcessError):
        _bash(render, str(workspace / 'outputs' / 'r.pdf'))
    assert (elsewhere / 'previews').exists() and os.listdir(elsewhere / 'previews') == []


# --- the HTML policy -------------------------------------------------------------------------------------------------


def test_the_policy_is_the_planned_one_with_base_uri_none():
    assert HTML_POLICY == (
        '<meta http-equiv="Content-Security-Policy" content="'
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; "
        "font-src data:; form-action 'none'; base-uri 'none'\">"
    )


def test_a_model_written_base_comes_after_the_policy_that_forbids_it():
    doc = '<!doctype html><base href="https://example.invalid/"><a href="x">x</a>'
    out = with_policy(doc)
    assert out.index("base-uri 'none'") < out.index('<base ')


def test_the_policy_goes_first_without_a_doctype():
    doc = '<html><head><title>t</title></head><body><script>1</script></body></html>'
    assert with_policy(doc) == HTML_POLICY + doc


@pytest.mark.parametrize(
    'doctype', ['<!DOCTYPE html>', '<!doctype html>', '\n \t\r\f<!DocType html>', '<!DOCTYPEhtml>', '<!DOCTYPE "a>']
)
def test_the_policy_goes_right_after_a_leading_doctype(doctype):
    rest = '<script>alert(1)</script><head></head><body></body>'
    assert with_policy(doctype + rest) == doctype + HTML_POLICY + rest


def test_a_script_before_head_comes_after_the_policy():
    doc = '<!doctype html><script>fetch("/api/v1/chats")</script><head><title>x</title></head>'
    out = with_policy(doc)
    assert out.index(HTML_POLICY) < out.index('<script>')


def test_a_model_written_policy_is_kept_after_ours():
    doc = '<!doctype html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head>'
    out = with_policy(doc)
    assert out == '<!doctype html>' + HTML_POLICY + doc[len('<!doctype html>') :]
    assert out.index(HTML_POLICY) < out.index('default-src *')


@pytest.mark.parametrize(
    'prefix',
    [
        '﻿',  # a BOM left in the text is a character, not whitespace
        ' ',  # NBSP: Python's \s, but text to the HTML parser
        '　',
        '<!-- c -->',  # a comment before the doctype: the policy goes before it
        '<!-- <!doctype html> -->',
        'x',
        '\0',
    ],
)
def test_anything_but_whitespace_before_a_doctype_puts_the_policy_at_the_very_start(prefix):
    doc = prefix + '<!doctype html><script>1</script>'
    assert with_policy(doc) == HTML_POLICY + doc


def test_a_doctype_ends_at_its_first_angle_bracket():
    # The tokenizer ends a DOCTYPE at the first `>`, so the rest is content after the policy.
    doc = '<!doctype <script>alert(1)</script>'
    assert with_policy(doc) == '<!doctype <script>' + HTML_POLICY + 'alert(1)</script>'
    assert with_policy('') == HTML_POLICY


def test_decode_html_follows_the_bom():
    text = '<!doctype html><p>héllo</p>'
    assert decode_html(codecs.BOM_UTF8 + text.encode()) == text
    assert decode_html(codecs.BOM_UTF16_LE + text.encode('utf-16-le')) == text
    assert decode_html(codecs.BOM_UTF16_BE + text.encode('utf-16-be')) == text
    assert decode_html(text.encode()) == text
    assert decode_html(b'<p>\xff</p>') == '<p>�</p>'


# --- the routes ------------------------------------------------------------------------------------------------------


def _headers(user) -> dict:
    return {'Authorization': f'Bearer {create_token({"id": user.id}, dt.timedelta(minutes=30))}'}


def _file(user, name: str, data: bytes, content_type: str, *, sandbox: bool) -> str:
    file_id = str(uuid.uuid4())
    path = UPLOAD_DIR / f'{file_id}_{name}'
    path.write_bytes(data)
    meta = {'name': name, 'content_type': content_type, 'size': len(data)}
    if sandbox:
        meta |= {'source': 'sandbox_output', 'sandbox_path': f'{OUTPUTS_DIR}/{name}'}
    _run(Files.insert_new_file(user.id, FileForm(id=file_id, filename=name, path=str(path), meta=meta)))
    return file_id


@pytest.fixture(scope='module')
def people():
    return _people()


@pytest.fixture
def client():
    return TestClient(_app())


# (name, stored type, type served): only images, PDF, audio and video keep theirs.
SERVED = [
    ('r.pdf', 'application/pdf', 'application/pdf'),
    ('p.html', 'text/html', 'application/octet-stream'),
    ('t.txt', 'text/plain', 'application/octet-stream'),
    ('s.js', 'text/javascript', 'application/octet-stream'),
    ('c.css', 'text/css', 'application/octet-stream'),
    ('f.png', 'image/png', 'image/png'),
    ('v.svg', 'image/svg+xml', 'image/svg+xml'),
    ('a.ogg', 'audio/ogg', 'audio/ogg'),
    ('m.mp4', 'video/mp4', 'video/mp4'),
    ('x.bin', None, 'application/octet-stream'),
]


@pytest.mark.parametrize(('name', 'content_type', 'served'), SERVED)
@pytest.mark.parametrize('query', ['', '?attachment=false', '?attachment=true'])
def test_content_downloads_a_sandbox_output_whatever_its_type(client, people, name, content_type, served, query):
    file_id = _file(people.owner, name, b'data', content_type, sandbox=True)
    response = client.get(f'/api/v1/files/{file_id}/content{query}', headers=_headers(people.owner))
    assert response.status_code == 200
    assert response.headers['content-disposition'] == f"attachment; filename*=UTF-8''{name}"
    assert response.headers['x-content-type-options'] == 'nosniff'
    assert response.headers['content-security-policy'] == "default-src 'none'; sandbox"
    assert response.headers['content-type'].split(';')[0] == served


def test_content_is_unchanged_for_other_files(client, people):
    pdf = _file(people.owner, 'r.pdf', b'%PDF', 'application/pdf', sandbox=False)
    response = client.get(f'/api/v1/files/{pdf}/content', headers=_headers(people.owner))
    assert response.headers['content-disposition'] == "inline; filename*=UTF-8''r.pdf"
    assert 'x-content-type-options' not in response.headers
    assert 'content-security-policy' not in response.headers
    response = client.get(f'/api/v1/files/{pdf}/content?attachment=true', headers=_headers(people.owner))
    assert response.headers['content-disposition'] == "attachment; filename*=UTF-8''r.pdf"
    text = _file(people.owner, 't.txt', b'hi', 'text/plain', sandbox=False)
    response = client.get(f'/api/v1/files/{text}/content', headers=_headers(people.owner))
    assert 'content-disposition' not in response.headers
    assert response.text == 'hi'


@pytest.mark.parametrize(('name', 'content_type', 'served'), SERVED)
def test_content_by_name_serves_a_sandbox_output_as_the_content_route_does(client, people, name, content_type, served):
    output = _file(people.owner, name, b'data', content_type, sandbox=True)
    response = client.get(f'/api/v1/files/{output}/content/{name}', headers=_headers(people.owner))
    assert response.headers['content-disposition'] == f"attachment; filename*=UTF-8''{name}"
    assert response.headers['x-content-type-options'] == 'nosniff'
    assert response.headers['content-security-policy'] == "default-src 'none'; sandbox"
    assert response.headers['content-type'].split(';')[0] == served


def test_content_by_name_is_unchanged_for_other_files(client, people):
    other = _file(people.owner, 'q.html', b'<p>', 'text/html', sandbox=False)
    response = client.get(f'/api/v1/files/{other}/content/q.html', headers=_headers(people.owner))
    assert response.headers['content-disposition'] == "attachment; filename*=UTF-8''q.html"
    assert 'x-content-type-options' not in response.headers
    assert 'content-security-policy' not in response.headers
    # Guessed from the stored path, as before.
    assert response.headers['content-type'].startswith('text/html')


def test_content_html_refuses_a_sandbox_output_and_serves_other_admin_files(client, people):
    output = _file(people.admin, 'p.html', b'<script>1</script>', 'text/html', sandbox=True)
    response = client.get(f'/api/v1/files/{output}/content/html', headers=_headers(people.admin))
    assert response.status_code == 403
    other = _file(people.admin, 'q.html', b'<p>ok</p>', 'text/html', sandbox=False)
    response = client.get(f'/api/v1/files/{other}/content/html', headers=_headers(people.admin))
    assert response.status_code == 200
    assert response.text == '<p>ok</p>'
    assert response.headers['content-type'].startswith('text/html')


def test_content_html_answers_a_caller_without_access_as_for_a_missing_file(client, people):
    output = _file(people.admin, 'p.html', b'<script>1</script>', 'text/html', sandbox=True)
    missing = str(uuid.uuid4())
    for file_id in (output, missing):
        response = client.get(f'/api/v1/files/{file_id}/content/html', headers=_headers(people.other))
        assert (response.status_code, response.json()) == (404, {'detail': ERROR_MESSAGES.NOT_FOUND})
    # A sandbox output a non-admin owns is a 404 for its owner too, as any file of theirs is on this route.
    own = _file(people.owner, 'p.html', b'<p>', 'text/html', sandbox=True)
    assert client.get(f'/api/v1/files/{own}/content/html', headers=_headers(people.owner)).status_code == 404


def test_the_html_route_answers_a_caller_without_access_as_for_a_missing_file(client, people):
    output = _file(people.owner, 'page.html', b'<p>', 'text/html', sandbox=True)
    other_html = _file(people.owner, 'q.html', b'<p>', 'text/html', sandbox=False)
    missing = str(uuid.uuid4())
    answers = [
        client.get(f'/api/v1/sandbox/outputs/{file_id}/html', headers=_headers(people.other))
        for file_id in (output, other_html, missing)
    ]
    assert {(r.status_code, r.text) for r in answers} == {(404, answers[2].text)}


def test_the_html_route_returns_the_document_with_the_policy_first(client, people):
    doc = '<!DOCTYPE html><script>parent.document</script><head></head>'
    file_id = _file(people.owner, 'page.html', doc.encode(), 'text/html', sandbox=True)
    response = client.get(f'/api/v1/sandbox/outputs/{file_id}/html', headers=_headers(people.owner))
    assert response.status_code == 200
    assert response.headers['content-type'] == 'application/json'
    assert response.headers['x-content-type-options'] == 'nosniff'
    assert response.json() == {'html': '<!DOCTYPE html>' + HTML_POLICY + doc[len('<!DOCTYPE html>') :]}
    # An admin may read it, as with file content.
    assert client.get(f'/api/v1/sandbox/outputs/{file_id}/html', headers=_headers(people.admin)).status_code == 200


def test_the_html_route_decodes_utf16_and_drops_the_bom(client, people):
    doc = '<p>ünïcode</p>'
    file_id = _file(people.owner, 'u.htm', codecs.BOM_UTF16_LE + doc.encode('utf-16-le'), 'text/html', sandbox=True)
    response = client.get(f'/api/v1/sandbox/outputs/{file_id}/html', headers=_headers(people.owner))
    assert response.json() == {'html': HTML_POLICY + doc}


def test_the_html_route_refuses_another_user_other_files_and_non_html(client, people):
    output = _file(people.owner, 'page.html', b'<p>', 'text/html', sandbox=True)
    assert client.get(f'/api/v1/sandbox/outputs/{output}/html', headers=_headers(people.other)).status_code == 404
    plain = _file(people.owner, 'page.html', b'<p>', 'text/html', sandbox=False)
    assert client.get(f'/api/v1/sandbox/outputs/{plain}/html', headers=_headers(people.owner)).status_code == 404
    image = _file(people.owner, 'f.png', _png(1, 1), 'image/png', sandbox=True)
    assert client.get(f'/api/v1/sandbox/outputs/{image}/html', headers=_headers(people.owner)).status_code == 404
    missing = str(uuid.uuid4())
    assert client.get(f'/api/v1/sandbox/outputs/{missing}/html', headers=_headers(people.owner)).status_code == 404
    assert client.get(f'/api/v1/sandbox/outputs/{output}/html').status_code in (401, 403)


def test_the_html_route_refuses_a_document_over_5_mib(client, people):
    big = _file(people.owner, 'big.html', b'x' * (HTML_MAX_BYTES + 1), 'text/html', sandbox=True)
    assert client.get(f'/api/v1/sandbox/outputs/{big}/html', headers=_headers(people.owner)).status_code == 413
    edge = _file(people.owner, 'edge.html', b'x' * HTML_MAX_BYTES, 'text/html', sandbox=True)
    response = client.get(f'/api/v1/sandbox/outputs/{edge}/html', headers=_headers(people.owner))
    assert response.status_code == 200
    assert len(response.json()['html']) == HTML_MAX_BYTES + len(HTML_POLICY)


def test_the_html_route_is_404_when_the_stored_file_is_gone(client, people):
    file_id = _file(people.owner, 'gone.html', b'<p>', 'text/html', sandbox=True)
    (UPLOAD_DIR / f'{file_id}_gone.html').unlink()
    assert client.get(f'/api/v1/sandbox/outputs/{file_id}/html', headers=_headers(people.owner)).status_code == 404


def test_a_sandbox_failure_mid_collection_keeps_and_links_what_was_stored():
    people = _people()
    chat_id = str(uuid.uuid4())
    _run(Chats.insert_new_chat(chat_id, people.owner.id, ChatForm(chat={'title': 'Stops'})))
    session = StubSession(files={f'{OUTPUTS_DIR}/a.txt': b'a', f'{OUTPUTS_DIR}/c.txt': b'c'})
    real_get = session.get_files

    async def get_files(paths, max_bytes):
        if paths == [f'{OUTPUTS_DIR}/b.txt']:
            raise SandboxNotRunning('the VM died')
        return await real_get(paths, max_bytes)

    session.get_files = get_files
    entries = [_entry('a.txt', b'a'), _entry('b.txt', b'b'), _entry('c.txt', b'c')]
    got = _collect(session, entries, people.owner, chat_id=chat_id, message_id='m')
    assert isinstance(got.error, SandboxNotRunning)
    first, second, third = got.outputs
    assert first['file_id'] and 'reason' not in first
    assert second['reason'] == third['reason'] == 'the sandbox stopped before it was read'
    assert [f['id'] for f in got.files] == [first['file_id']]
    linked = _run(Chats.get_chat_files_by_chat_id_and_message_id(chat_id, 'm'))
    assert [c.file_id for c in linked] == [first['file_id']]


def test_a_sandbox_failure_while_previewing_keeps_the_pdfs_and_stops_the_previews():
    people = _people()
    chat_id = str(uuid.uuid4())
    _run(Chats.insert_new_chat(chat_id, people.owner.id, ChatForm(chat={'title': 'PDFs'})))
    pdfs = {'a.pdf': b'%PDF-a', 'b.pdf': b'%PDF-b'}
    session = _preview_session(pdfs, {'page-1.png': _png(10, 10)}, 'page-1.png\0')

    def on_exec(argv):
        raise SandboxNotRunning('the VM died')

    session.on_exec = on_exec
    got = _collect(session, [_entry(n, d) for n, d in pdfs.items()], people.owner, chat_id=chat_id, message_id='m')
    assert isinstance(got.error, SandboxNotRunning)
    assert all(o['file_id'] for o in got.outputs)
    assert len(got.files) == 2
    # The first PDF's render failed; the second PDF's is never tried.
    assert [c[1][-1] for c in session.calls if c[0] == 'exec'] == [f'{OUTPUTS_DIR}/a.pdf']
    linked = _run(Chats.get_chat_files_by_chat_id_and_message_id(chat_id, 'm'))
    assert len(linked) == 2


def test_a_preview_keeps_its_own_page_number_when_an_earlier_page_is_dropped():
    people = _people()
    pdf = b'%PDF'
    pages = {'page-1.png': _png(10, 10), 'page-2.png': b'broken', 'page-3.png': _png(10, 10)}
    session = _preview_session({'r.pdf': pdf}, pages, 'page-3.png\0page-1.png\0page-2.png\0')
    got = _collect(session, [_entry('r.pdf', pdf)], people.owner)
    previews = [f for f in got.files if f['meta'].get('preview_of')]
    assert [(f['name'], f['meta']['preview_page']) for f in previews] == [
        ('r.pdf-page-1.png', 1),
        ('r.pdf-page-3.png', 3),
    ]


# --- the bash tool (phase 2), through SandboxManager and FakeBackend ----------------------------------------------


class _AnyChat:
    """A ChatLookup that lets every user use every chat; access is not what these tests are about."""

    async def usable(self, chat_id, user):
        return True

    async def updated_at(self, chat_ids):
        return {}


async def _sandbox_settings() -> SandboxSettings:
    return SandboxSettings()


class _BashRig:
    """The bash tool on a FakeBackend, a real user and a saved chat whose message m1 already has one file."""

    PREVIOUS = {'type': 'file', 'id': 'earlier', 'name': 'earlier.txt'}

    def __init__(self, *, saved: bool = True, harness: bool = False) -> None:
        self.backend = FakeBackend()
        self.app = _app()
        self.app.state.sandbox = SandboxManager(self.backend, chats=_AnyChat(), settings=_sandbox_settings)
        state = SimpleNamespace(benchmark_harness=True) if harness else SimpleNamespace()
        self.request = SimpleNamespace(app=self.app, state=state)
        self.user = _people().owner
        self.chat_id = str(uuid.uuid4()) if saved else f'local:{uuid.uuid4()}'
        if saved:
            history = {'messages': {'m1': {'id': 'm1', 'role': 'assistant', 'files': [self.PREVIOUS]}}}
            _run(Chats.insert_new_chat(self.chat_id, self.user.id, ChatForm(chat={'title': 'B', 'history': history})))
        self.events: list[dict] = []

    async def emit(self, event: dict) -> None:
        self.events.append(event)

    async def bash(self, command: str, emit=True) -> dict:
        out = await builtin.bash(
            command=command,
            __request__=self.request,
            __user__={'id': self.user.id},
            __chat_id__=self.chat_id,
            __message_id__='m1',
            __event_emitter__=self.emit if emit else None,
        )
        return json.loads(out)

    def files_events(self) -> list[list[dict]]:
        return [e['data']['files'] for e in self.events if e['type'] == 'files']


def test_bash_attaches_a_new_file_in_outputs_and_sends_it_in_a_files_event():
    rig = _BashRig()

    async def go():
        made = await rig.bash('mkdir outputs')
        written = await rig.bash('printf hello > outputs/fig.png')
        again = await rig.bash('printf hi')
        return made, written, again

    made, written, again = _run(go())
    assert made['outputs'] == [] and 'outputs_note' not in made
    assert written['returncode'] == 0
    (output,) = written['outputs']
    assert output['path'] == 'outputs/fig.png' and output['size'] == 5 and output['file_id']
    row = _run(Files.get_file_by_id(output['file_id']))
    assert row is not None and row.meta is not None
    assert row.meta['source'] == 'sandbox_output'
    assert row.meta['sandbox_path'] == f'{OUTPUTS_DIR}/fig.png'
    linked = _run(Chats.get_chat_files_by_chat_id_and_message_id(rig.chat_id, 'm1'))
    assert [c.file_id for c in linked] == [output['file_id']]
    # Only the new file: the chat page and the socket handler merge it into what the message has.
    (event,) = rig.files_events()
    assert [f['id'] for f in event] == [output['file_id']]
    assert event[0]['meta']['source'] == 'sandbox_output'
    # Nothing new or changed on the third call.
    assert again['outputs'] == []
    assert len(rig.files_events()) == 1


def test_bash_attaches_a_changed_file_again_and_never_an_unchanged_one():
    rig = _BashRig()

    async def go():
        await rig.bash('mkdir outputs')
        first = await rig.bash('printf one > outputs/a.txt')
        await rig.bash('printf two > outputs/b.txt')
        changed = await rig.bash('printf three > outputs/a.txt')
        return first, changed

    first, changed = _run(go())
    assert [o['path'] for o in changed['outputs']] == ['outputs/a.txt']
    assert changed['outputs'][0]['file_id'] != first['outputs'][0]['file_id']


def test_bash_in_an_unsaved_chat_sends_only_the_new_files():
    rig = _BashRig(saved=False)

    async def go():
        await rig.bash('mkdir outputs')
        return await rig.bash('printf x > outputs/a.txt')

    result = _run(go())
    (event,) = rig.files_events()
    assert [f['id'] for f in event] == [result['outputs'][0]['file_id']]


def test_bash_in_a_benchmark_run_lists_the_outputs_and_stores_none():
    rig = _BashRig(harness=True)

    async def go():
        await rig.bash('mkdir outputs')
        return await rig.bash('printf x > outputs/a.txt')

    result = _run(go())
    assert result['outputs'] == [{'path': 'outputs/a.txt', 'name': 'a.txt', 'size': 1, 'content_type': 'text/plain'}]
    assert rig.files_events() == []
    assert not [name for name, _ in rig.backend.calls if name == 'get_files']


def test_bash_says_when_the_outputs_listing_was_cut_short(monkeypatch):
    rig = _BashRig()
    monkeypatch.setattr(outputs, 'LISTING_CAP_BYTES', 40)

    async def go():
        await rig.bash('mkdir outputs')
        await rig.bash('printf x > outputs/a.txt')
        return await rig.bash('printf y > outputs/b.txt')

    result = _run(go())
    assert result['outputs_note'] == builtin.OUTPUTS_CUT
    assert result['returncode'] == 0


@pytest.mark.parametrize(('when', 'how'), [('before', 'fails'), ('before', 'raises'), ('after', 'raises')])
def test_bash_keeps_the_command_result_when_outputs_cannot_be_listed(monkeypatch, when, how):
    rig = _BashRig()
    real = outputs.list_outputs
    calls = []

    async def listing(session):
        calls.append(1)
        if (when == 'before') == (len(calls) == 1):
            if how == 'raises':
                raise SandboxError('the VM died')
            return None
        return await real(session)

    monkeypatch.setattr(builtin.sandbox_outputs, 'list_outputs', listing)
    result = _run(rig.bash('printf hi'))
    assert (result['returncode'], result['stdout']) == (0, 'hi')
    assert result['outputs'] == []
    assert result['outputs_note'] == builtin.OUTPUTS_NOT_LISTED
    assert len(calls) == 2


def test_bash_keeps_the_command_result_when_attaching_fails(monkeypatch):
    rig = _BashRig()

    async def broken(*_a, **_k):
        raise RuntimeError('database down')

    _run(rig.bash('mkdir outputs'))
    monkeypatch.setattr(builtin.sandbox_outputs, 'collect', broken)
    result = _run(rig.bash('printf x > outputs/a.txt'))
    assert result['returncode'] == 0
    # Named, with why it is not attached.
    assert result['outputs'] == [
        {
            'path': 'outputs/a.txt',
            'name': 'a.txt',
            'size': 1,
            'content_type': 'text/plain',
            'reason': 'a server error came first',
        }
    ]
    assert 'server error' in result['outputs_note']


def test_bash_says_when_the_sandbox_stopped_while_reading_outputs(monkeypatch):
    rig = _BashRig()

    async def stopped(session, entries, *, into, **_k):
        into.outputs.append({'path': 'outputs/a.txt', 'reason': outputs._STOPPED})
        into.error = SandboxNotRunning('gone')
        return into

    _run(rig.bash('mkdir outputs'))
    monkeypatch.setattr(builtin.sandbox_outputs, 'collect', stopped)
    result = _run(rig.bash('printf x > outputs/a.txt'))
    assert result['outputs'] == [{'path': 'outputs/a.txt', 'reason': 'the sandbox stopped before it was read'}]
    assert 'the sandbox stopped while' in result['outputs_note']


def test_a_files_event_that_fails_never_costs_the_result():
    rig = _BashRig()

    async def broken(event):
        if event['type'] == 'files':
            raise RuntimeError('socket gone')

    async def go():
        await rig.bash('mkdir outputs')
        out = await builtin.bash(
            command='printf x > outputs/a.txt',
            __request__=rig.request,
            __user__={'id': rig.user.id},
            __chat_id__=rig.chat_id,
            __message_id__='m1',
            __event_emitter__=broken,
        )
        no_emitter = await rig.bash('printf y > outputs/b.txt', emit=False)
        return json.loads(out), no_emitter

    result, no_emitter = _run(go())
    assert result['outputs'][0]['file_id']
    assert no_emitter['outputs'][0]['file_id']
    assert rig.files_events() == []


# --- the FakeBackend's listing, against the real script ----------------------------------------------------------


def _fake_listing(files: dict[str, FakeFile]) -> FakeRun:
    request = FakeExecRequest(CHAT, outputs.list_argv(), HELPER_TIMEOUT_S, None, FakeWorkspace(files))
    return _run(interpret(request))


def _ws(**entries: FakeFile) -> dict[str, FakeFile]:
    files = {'/workspace': FakeFile(content=None, uid=1000, mode=0o755)}
    files.update({f'/workspace/{k.replace("__", "/")}': v for k, v in entries.items()})
    return files


def test_the_fake_lists_outputs_as_the_real_script_does(tmp_path):
    def f(data: bytes, mtime: float, mode: int = 0o644) -> FakeFile:
        return FakeFile(content=data, uid=1000, mode=mode, mtime=mtime)

    def d(mode: int = 0o755) -> FakeFile:
        return FakeFile(content=None, uid=1000, mode=mode)

    tree = {
        'outputs': d(),
        'outputs/new.txt': f(b'abc', 2_000_000_000),
        'outputs/old.csv': f(b'1,2\n', 1_000_000_000),
        'outputs/tab\tname': f(b'x', 1_500_000_000),
        'outputs/sub': d(),
        'outputs/sub/deep.png': f(b'png!!', 1_700_000_000),
        'outputs/secret': f(b's', 1_600_000_000, 0o000),
        'outputs/locked': d(0o000),
        'outputs/link': FakeFile(content=None, uid=1000, mode=0o777, link='/etc/passwd'),
        'outputs/fifo': FakeFile(content=b'', uid=1000, mode=0o644, fifo=True),
    }
    fake = {'/workspace': d(), **{f'/workspace/{k}': v for k, v in tree.items()}}
    fake['/workspace/outputs/locked/hidden'] = f(b'h', 1_800_000_000)
    run = _fake_listing(fake)
    # The same tree on disk, through the real script.
    root = tmp_path / 'outputs'
    for name, entry in tree.items():
        path = tmp_path / name
        if entry.link is not None:
            path.symlink_to(entry.link)
        elif entry.fifo:
            os.mkfifo(path)
        elif entry.content is None:
            path.mkdir()
        else:
            path.write_bytes(entry.content)
            os.utime(path, (entry.mtime, entry.mtime))
    (root / 'locked' / 'hidden').write_bytes(b'h')
    for name, entry in tree.items():
        if entry.link is None:
            (tmp_path / name).chmod(entry.mode)
    try:
        real = subprocess.run(
            [*GUEST_SHELL, '-c', outputs.LIST_SCRIPT.replace(OUTPUTS_DIR, str(root)), 'x'], capture_output=True
        )
    finally:
        (root / 'locked').chmod(0o755)
    assert run.stdout == real.stdout
    assert parse_listing(run.stdout.decode()).complete
    assert list(parse_listing(run.stdout.decode()).entries) == ['new.txt', 'sub/deep.png', 'tab\tname', 'old.csv']
    # find's complaint about `locked` is dropped by the script, and the fake makes none.
    assert run.stderr == real.stderr == b''


def test_the_fake_lists_nothing_without_a_real_outputs_directory():
    missing = _fake_listing(_ws())
    assert (missing.returncode, missing.stdout, missing.stderr) == (0, b'END\0', b'')
    linked = _fake_listing(_ws(outputs=FakeFile(content=None, uid=1000, mode=0o777, link='/tmp')))
    assert (linked.stdout, linked.stderr) == (b'END\0', b'')


def test_the_fake_cuts_the_listing_at_its_cap(monkeypatch):
    monkeypatch.setattr(outputs, 'LISTING_CAP_BYTES', 30)
    files = _ws(outputs=FakeFile(content=None, uid=1000, mode=0o755))
    for n in range(5):
        files[f'/workspace/outputs/{n}.txt'] = FakeFile(content=b'x', uid=1000, mode=0o644, mtime=float(n))
    run = _fake_listing(files)
    assert len(run.stdout) == 30
    assert not parse_listing(run.stdout.decode()).complete


# --- phase 3: files the other tools write, partial failures, the files contract ------------------------------------


@pytest.mark.parametrize('first_bash', [True, False])
def test_a_file_write_file_puts_in_outputs_is_attached_by_the_next_bash_call(first_bash):
    rig = _BashRig()

    async def call(tool, **kwargs):
        out = await tool(**kwargs, __request__=rig.request, __user__={'id': rig.user.id}, __chat_id__=rig.chat_id)
        return json.loads(out)

    async def go():
        if first_bash:
            await rig.bash('mkdir outputs')
        await call(builtin.write_file, path='outputs/report.md', content='# Report\n')
        written = await rig.bash('printf hi')
        await call(builtin.str_replace, path='outputs/report.md', old_str='Report', new_str='Final report')
        edited = await rig.bash('printf hi')
        unchanged = await rig.bash('printf hi')
        return written, edited, unchanged

    written, edited, unchanged = _run(go())
    assert [o['path'] for o in written['outputs']] == ['outputs/report.md']
    assert [o['path'] for o in edited['outputs']] == ['outputs/report.md']
    assert edited['outputs'][0]['file_id'] != written['outputs'][0]['file_id']
    assert unchanged['outputs'] == []


def test_a_listing_kept_for_the_next_call_goes_when_the_sandbox_stops():
    rig = _BashRig()
    manager = cast(SandboxManager, rig.app.state.sandbox)

    async def go():
        await rig.bash('mkdir outputs')
        await rig.bash('printf x > outputs/a.txt')
        await manager.release(rig.chat_id)
        # A new container: the listing is taken afresh before the command, so a.txt is not new.
        return await rig.bash('printf hi')

    assert _run(go())['outputs'] == []
    stats = [args['path'] for name, args in rig.backend.calls if name == 'stat']
    # Before and after the first call, after the second, then before and after the third.
    assert stats == [OUTPUTS_DIR] * 5


def test_a_link_that_fails_still_reports_and_sends_what_was_stored(monkeypatch):
    rig = _BashRig()
    real = Chats.insert_chat_files
    links = []

    async def insert_chat_files(*args, **kwargs):
        links.append(kwargs['file_ids'])
        if len(links) == 3:
            raise RuntimeError('database gone')
        return await real(*args, **kwargs)

    async def go():
        await rig.bash('mkdir outputs')
        for name in 'abcd':
            await rig.bash(f'printf {name} > outputs/{name}.txt')
        monkeypatch.setattr(Chats, 'insert_chat_files', insert_chat_files)
        # One call that finds all four changed, in mtime order: d, c, b, a.
        for name in 'dcba':
            box = next(iter(rig.backend.sandboxes.values()))
            box.files[f'{OUTPUTS_DIR}/{name}.txt'].content = name.encode() * 2
            box.files[f'{OUTPUTS_DIR}/{name}.txt'].mtime += 100 + 'dcba'.index(name)
        return await rig.bash('printf hi')

    result = _run(go())
    stored = [o for o in result['outputs'] if o.get('file_id')]
    # Each row is linked as it is stored; the third link fails, so its row is stored, reported and sent, unlinked,
    # and the fourth file is never read.
    assert [o['path'] for o in result['outputs']] == [
        'outputs/a.txt',
        'outputs/b.txt',
        'outputs/c.txt',
        'outputs/d.txt',
    ]
    assert [o['path'] for o in stored] == ['outputs/a.txt', 'outputs/b.txt', 'outputs/c.txt']
    assert result['outputs'][3]['reason'] == 'a server error came first'
    assert 'server error' in result['outputs_note']
    assert [f['id'] for f in rig.files_events()[-1][-3:]] == [o['file_id'] for o in stored]
    linked = {c.file_id for c in _run(Chats.get_chat_files_by_chat_id_and_message_id(rig.chat_id, 'm1'))}
    assert {o['file_id'] for o in stored[:2]} <= linked and stored[2]['file_id'] not in linked


def test_a_stop_mid_collection_leaves_the_stored_rows_linked_and_attaches_nothing_twice(monkeypatch):
    people = _people()
    chat_id = str(uuid.uuid4())
    _run(Chats.insert_new_chat(chat_id, people.owner.id, ChatForm(chat={'title': 'Stop'})))
    files = {f'{OUTPUTS_DIR}/{n}.txt': n.encode() for n in 'abc'}
    session = StubSession(files=files)
    real_get = session.get_files

    async def get_files(paths, max_bytes):
        if paths == [f'{OUTPUTS_DIR}/c.txt']:
            raise asyncio.CancelledError
        return await real_get(paths, max_bytes)

    session.get_files = get_files
    into = outputs.Collected()

    async def go():
        with pytest.raises(asyncio.CancelledError):
            await collect(
                session,
                [_entry(f'{n}.txt', n.encode()) for n in 'abc'],
                request=SimpleNamespace(app=_app()),
                user=people.owner,
                chat_id=chat_id,
                message_id='m1',
                into=into,
            )

    _run(go())
    stored = [o['file_id'] for o in into.outputs if o.get('file_id')]
    assert len(stored) == 2 and [f['id'] for f in into.files] == stored
    linked = _run(Chats.get_chat_files_by_chat_id_and_message_id(chat_id, 'm1'))
    assert sorted(c.file_id for c in linked) == sorted(stored)

    # Through the tool: a call stopped while attaching keeps no listing, so the next call does not attach its files.
    rig = _BashRig()

    async def cancelled(*_a, **_k):
        raise asyncio.CancelledError

    async def tool():
        await rig.bash('mkdir outputs')
        with monkeypatch.context() as m:
            m.setattr(builtin.sandbox_outputs, 'collect', cancelled)
            with pytest.raises(asyncio.CancelledError):
                await rig.bash('printf x > outputs/a.txt')
        return await rig.bash('printf hi')

    assert _run(tool())['outputs'] == []


def test_many_unreadable_directories_do_not_cut_the_listing(tmp_path):
    root = tmp_path / 'outputs'
    root.mkdir()
    (root / 'a.txt').write_text('a')
    for n in range(400):
        (root / f'locked-{n:03}').mkdir(mode=0o000)
    try:
        real = subprocess.run(
            [*GUEST_SHELL, '-c', outputs.LIST_SCRIPT.replace(OUTPUTS_DIR, str(root)), 'x'], capture_output=True
        )
    finally:
        for n in range(400):
            (root / f'locked-{n:03}').chmod(0o755)
    assert real.stderr == b''
    listing = parse_listing(real.stdout.decode())
    assert listing.complete and list(listing.entries) == ['a.txt']


def test_the_message_keeps_every_call_s_outputs_when_events_are_saved_as_the_socket_saves_them():
    from local_llm.socket.main import merge_message_files

    rig = _BashRig()

    async def save(event: dict) -> None:
        # socket/main.py's handler for a `files` event in a saved chat.
        rig.events.append(event)
        existing = await Chats.get_message_metadata(rig.chat_id, 'm1', 'files')
        merged = merge_message_files(existing, event['data']['files'])
        await Chats.upsert_message_to_chat_by_id_and_message_id(rig.chat_id, 'm1', {'files': merged}, touch=False)

    rig.emit = save

    async def go():
        await rig.bash('mkdir outputs')
        first = await rig.bash('printf one > outputs/one.txt')
        second = await rig.bash('printf two > outputs/two.txt')
        return first, second

    first, second = _run(go())
    one, two = first['outputs'][0]['file_id'], second['outputs'][0]['file_id']
    events = rig.files_events()
    assert [f['id'] for f in events[0]] == [one]
    assert [f['id'] for f in events[1]] == [two]
    saved = _run(Chats.get_message_metadata(rig.chat_id, 'm1', 'files'))
    assert [f['id'] for f in saved] == ['earlier', one, two]


def test_a_write_goes_ahead_when_outputs_cannot_be_listed_first(monkeypatch):
    rig = _BashRig()

    async def broken(session):
        raise SandboxError('the VM died')

    monkeypatch.setattr(builtin.sandbox_outputs, 'list_outputs', broken)
    out = _run(
        builtin.write_file(
            path='outputs/a.txt',
            content='a',
            __request__=rig.request,
            __user__={'id': rig.user.id},
            __chat_id__=rig.chat_id,
        )
    )
    assert json.loads(out) == {'path': '/workspace/outputs/a.txt', 'bytes_written': 1}


# --- security review: previews within the caps, identical bytes not stored again ----------------------------------


def test_preview_pages_are_charged_to_the_call_s_bytes_and_files(monkeypatch):
    people = _people()
    pdf = b'%PDF-1.4'
    page = _png(10, 10)
    pages = {f'page-{n}.png': page for n in range(1, 6)}
    listing = ''.join(f'page-{n}.png\0' for n in range(1, 6))

    # The call's bytes: the PDF and two pages fit, the third does not.
    monkeypatch.setattr(outputs, 'OUTPUT_CALL_CAP_BYTES', len(pdf) + 2 * len(page) + len(page) // 2)
    session = _preview_session({'r.pdf': pdf}, pages, listing)
    got = _collect(session, [_entry('r.pdf', pdf)], people.owner)
    assert [f['meta'].get('preview_page') for f in got.files] == [None, 1, 2]
    assert got.outputs[0]['previews'] == outputs._PREVIEWS_CUT
    monkeypatch.undo()

    # What the chat's cap has left: the same.
    session = _preview_session({'r.pdf': pdf}, pages, listing)
    got = _collect(session, [_entry('r.pdf', pdf)], people.owner, chat_left=len(pdf) + 2 * len(page))
    assert [f['meta'].get('preview_page') for f in got.files] == [None, 1, 2]
    assert got.stored_bytes == len(pdf) + 2 * len(page)

    # Files: with a cap of 3, the PDF and two pages.
    monkeypatch.setattr(outputs, 'OUTPUT_MAX_FILES', 3)
    session = _preview_session({'r.pdf': pdf}, pages, listing)
    got = _collect(session, [_entry('r.pdf', pdf)], people.owner)
    assert len(got.files) == 3
    assert got.outputs[0]['previews'] == outputs._PREVIEWS_CUT


def test_previews_spend_what_the_outputs_leave(monkeypatch):
    people = _people()
    monkeypatch.setattr(outputs, 'OUTPUT_MAX_FILES', 4)
    pdfs = {f'{n}.pdf': b'%PDF' for n in range(3)}
    session = _preview_session(
        pdfs, {'page-1.png': _png(10, 10), 'page-2.png': _png(10, 10)}, 'page-1.png\0page-2.png\0'
    )
    got = _collect(session, [_entry(n, d) for n, d in pdfs.items()], people.owner)
    # Three PDFs read, then one page: four files in all; the first PDF says its previews were cut.
    assert len(got.files) == 4
    assert [f['meta'].get('preview_of') for f in got.files][3] == got.outputs[0]['file_id']
    assert got.outputs[0]['previews'] == outputs._PREVIEWS_CUT


def test_identical_bytes_are_read_but_not_stored_or_attached_again():
    people = _people()
    chat_id = str(uuid.uuid4())
    _run(Chats.insert_new_chat(chat_id, people.owner.id, ChatForm(chat={'title': 'Dedup'})))
    stored: dict[str, tuple[str, str]] = {}
    path = f'{OUTPUTS_DIR}/a.txt'

    def once(data: bytes, mtime: str) -> outputs.Collected:
        session = StubSession(files={path: data})
        return _collect(
            session, [_entry('a.txt', data, mtime)], people.owner, chat_id=chat_id, message_id='m', stored=stored
        )

    first = once(b'one', '1.0')
    touched = once(b'one', '2.0')
    changed = once(b'two', '3.0')
    back = once(b'one', '4.0')
    assert first.outputs[0]['file_id'] and len(first.files) == 1
    assert touched.outputs[0]['reason'] == 'its content is the same as when it was last attached'
    assert touched.files == [] and 'file_id' not in touched.outputs[0]
    # Compared with the last row stored for the path, not any earlier one.
    assert changed.outputs[0]['file_id'] and back.outputs[0]['file_id']
    assert stored[path][1] == back.outputs[0]['file_id']
    linked = _run(Chats.get_chat_files_by_chat_id_and_message_id(chat_id, 'm'))
    assert len(linked) == 3


def test_bash_does_not_attach_a_rewrite_with_the_same_bytes():
    rig = _BashRig()

    async def go():
        await rig.bash('mkdir outputs')
        first = await rig.bash('printf one > outputs/a.txt')
        again = await rig.bash('printf one > outputs/a.txt')
        changed = await rig.bash('printf two > outputs/a.txt')
        return first, again, changed

    first, again, changed = _run(go())
    assert first['outputs'][0]['file_id']
    assert again['outputs'][0]['reason'] == 'its content is the same as when it was last attached'
    assert changed['outputs'][0]['file_id']
    assert len(rig.files_events()) == 2
    linked = _run(Chats.get_chat_files_by_chat_id_and_message_id(rig.chat_id, 'm1'))
    assert len(linked) == 2


# --- Q22: the per-chat cap ------------------------------------------------------------------------------------------


def test_collect_stores_no_more_than_the_chat_has_left():
    people = _people()
    files = {
        f'{OUTPUTS_DIR}/{n}': d
        for n, d in {'a.txt': b'aaaaaa', 'b.txt': b'bbbbbb', 'c.txt': b'cc', 'd.txt': b'dddd'}.items()
    }
    session = StubSession(files=files)
    # d.txt is listed as 1 byte and read as 4, past what is left.
    entries = [
        _entry('a.txt', b'aaaaaa'),
        _entry('b.txt', b'bbbbbb'),
        _entry('c.txt', b'cc'),
        OutputEntry('d.txt', 1, '1.0'),
    ]
    stored = {f'{OUTPUTS_DIR}/c.txt': (hashlib.sha256(b'cc').hexdigest(), 'earlier')}
    got = _collect(session, entries, people.owner, chat_left=8, stored=stored)
    reasons = {o['name']: o.get('reason') for o in got.outputs}
    over = (
        'it would take the files attached in this chat past their 1 GiB limit, so no more can be attached in this chat'
    )
    assert reasons == {
        'a.txt': None,
        'b.txt': over,
        'c.txt': 'its content is the same as when it was last attached',
        'd.txt': over,
    }
    assert got.stored_bytes == 6


def _output_row(user_id: str, meta: dict, created_at: int | None = None) -> str:
    file_id = str(uuid.uuid4())
    _run(Files.insert_new_file(user_id, FileForm(id=file_id, filename='x', path='/nowhere', meta=meta)))
    if created_at is not None:
        from local_llm.internal.db import get_async_db_context
        from local_llm.models.files import File

        async def date():
            async with get_async_db_context() as db:
                row = await db.get(File, file_id)
                row.created_at = created_at
                await db.commit()

        _run(date())
    return file_id


def test_chat_usage_counts_the_rows_the_server_marked_as_the_chat_s_and_finds_the_last_per_path():
    people = _people()
    chat_id = str(uuid.uuid4())
    path = f'{OUTPUTS_DIR}/a.txt'

    def output(size, digest, **extra):
        meta = {'source': 'sandbox_output', 'chat_id': chat_id, 'sandbox_path': path, 'size': size, 'file_hash': digest}
        return {**meta, **extra}

    # The same second: the store's clock in nanoseconds orders them; an older row without it comes first.
    old = _output_row(people.owner.id, output(10, 'h0'), created_at=1000)
    first = _output_row(people.owner.id, output(10, 'h1', stored_ns=5), created_at=2000)
    second = _output_row(people.owner.id, output(20, 'h2', stored_ns=9), created_at=2000)
    _output_row(people.owner.id, output(5, 'p', stored_ns=10, preview_of=second), created_at=2000)
    # Counted, though owned by another user (an admin's call in the chat, Q14).
    _output_row(people.admin.id, {**output(1, 'x', stored_ns=1), 'sandbox_path': f'{OUTPUTS_DIR}/b.txt'}, created_at=10)
    # Not counted: an ordinary file, a malformed size, another chat's output, and a chat id only a client set.
    _output_row(people.owner.id, {'name': 'u.csv', 'size': 1000, 'chat_id': chat_id})
    _output_row(people.owner.id, {**output('lots', 'h9'), 'sandbox_path': 7})
    _output_row(people.owner.id, {**output(7, 'h3'), 'chat_id': str(uuid.uuid4())})
    _output_row(people.owner.id, {'source': 'sandbox_output', 'size': 50, 'data': {'chat_id': chat_id}})
    used, latest = _run(outputs.chat_usage(chat_id))
    assert used == 10 + 10 + 20 + 5 + 1
    assert latest == {path: ('h2', second), f'{OUTPUTS_DIR}/b.txt': ('x', latest[f'{OUTPUTS_DIR}/b.txt'][1])}
    assert old and first
    # Scoped to an owner: the admin's row drops out.
    assert _run(outputs.chat_usage(chat_id, people.owner.id))[0] == 45
    assert _run(outputs.chat_usage(str(uuid.uuid4()))) == (0, {})


def test_bash_refuses_what_would_pass_a_saved_chat_s_cap_across_restarts(monkeypatch):
    rig = _BashRig()
    monkeypatch.setattr(builtin, 'OUTPUT_CHAT_CAP_BYTES', 10)

    async def go():
        await rig.bash('mkdir outputs')
        first = await rig.bash('printf 123456 > outputs/a.txt')
        over = await rig.bash('printf 123456 > outputs/b.txt')
        # A restarted server: a new manager, so nothing is remembered, on the same volume. The count comes from the
        # rows linked to the chat, and so does the last row per path.
        rig.app.state.sandbox = SandboxManager(rig.backend, chats=_AnyChat(), settings=_sandbox_settings)
        again = await rig.bash('printf 123456 > outputs/c.txt')
        same = await rig.bash('printf 123456 > outputs/a.txt')
        small = await rig.bash('printf 1234 > outputs/d.txt')
        return first, over, again, same, small

    first, over, again, same, small = _run(go())
    assert first['outputs'][0]['file_id']
    assert 'past their 1 GiB limit' in over['outputs'][0]['reason']
    assert 'past their' in again['outputs'][0]['reason']
    assert same['outputs'][0]['reason'] == 'its content is the same as when it was last attached'
    assert small['outputs'][0]['file_id']


def test_an_unsaved_chat_counts_its_rows_across_sandboxes_and_only_its_user_s(monkeypatch):
    rig = _BashRig(saved=False)
    monkeypatch.setattr(builtin, 'OUTPUT_CHAT_CAP_BYTES', 10)
    # Another user's rows under the same unsaved chat id do not count against this one.
    other = _people().owner
    _output_row(other.id, {'source': 'sandbox_output', 'chat_id': rig.chat_id, 'size': 100})

    async def go():
        await rig.bash('mkdir outputs')
        first = await rig.bash('printf 123456 > outputs/a.txt')
        # A new manager (a restarted server), so a new ephemeral sandbox: the count comes from the rows.
        rig.app.state.sandbox = SandboxManager(rig.backend, chats=_AnyChat(), settings=_sandbox_settings)
        await rig.bash('mkdir outputs')
        over = await rig.bash('printf 123456 > outputs/b.txt')
        fits = await rig.bash('printf 1234 > outputs/c.txt')
        return first, over, fits

    first, over, fits = _run(go())
    assert first['outputs'][0]['file_id'] and fits['outputs'][0]['file_id']
    assert 'past their' in over['outputs'][0]['reason']
    row = _run(Files.get_file_by_id(first['outputs'][0]['file_id']))
    assert row is not None and row.meta is not None and row.meta['chat_id'] == rig.chat_id


def test_a_call_with_no_message_id_stores_and_counts_but_links_nothing(monkeypatch):
    rig = _BashRig()
    monkeypatch.setattr(builtin, 'OUTPUT_CHAT_CAP_BYTES', 10)

    async def bash(command):
        out = await builtin.bash(
            command=command, __request__=rig.request, __user__={'id': rig.user.id}, __chat_id__=rig.chat_id
        )
        return json.loads(out)

    async def go():
        await bash('mkdir outputs')
        first = await bash('printf 123456 > outputs/a.txt')
        over = await bash('printf 123456 > outputs/b.txt')
        return first, over

    first, over = _run(go())
    assert first['outputs'][0]['file_id']
    assert 'past their' in over['outputs'][0]['reason']
    assert _run(Chats.get_chat_files_by_chat_id_and_message_id(rig.chat_id, 'm1')) == []


def test_a_failed_attach_still_counts_what_it_stored(monkeypatch):
    rig = _BashRig(saved=False)
    monkeypatch.setattr(builtin, 'OUTPUT_CHAT_CAP_BYTES', 10)
    real = outputs._store
    calls = []

    async def store_then_fail(*args, **kwargs):
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError('database gone')
        return await real(*args, **kwargs)

    async def go():
        await rig.bash('mkdir outputs')
        with monkeypatch.context() as m:
            m.setattr(outputs, '_store', store_then_fail)
            box = None
            await rig.bash('printf 123456 > outputs/a.txt')
            box = next(iter(rig.backend.sandboxes.values()))
            box.files[f'{OUTPUTS_DIR}/b.txt'] = FakeFile(content=b'bb', uid=1000, mode=0o644)
            box.files[f'{OUTPUTS_DIR}/a.txt'].content = b'7654321'
            box.files[f'{OUTPUTS_DIR}/a.txt'].mtime += 10
            failed = await rig.bash('printf hi')
        return await rig.bash('printf 1234 > outputs/c.txt'), failed

    after, failed = _run(go())
    assert 'server error' in failed['outputs_note']
    # 6 bytes stored by the first call: 4 more fit the cap of 10.
    assert after['outputs'][0]['file_id']


def test_a_command_stopped_while_it_runs_keeps_its_outputs_for_the_next_call():
    rig = _BashRig()
    started = asyncio.Event()

    async def script(request):
        if 'SLOW' in request.argv[-1]:
            # The command writes its figure, then is still running when the user presses Stop.
            request.workspace.write('/workspace/outputs/fig.png', b'png')
            started.set()
            await asyncio.sleep(3600)
        return await interpret(request)

    rig.backend.script = script

    async def go():
        await rig.bash('mkdir outputs')
        await rig.bash('printf a > outputs/a.txt')
        call = asyncio.ensure_future(rig.bash('SLOW'))
        await started.wait()
        call.cancel()
        with pytest.raises(asyncio.CancelledError):
            await call
        return await rig.bash('printf hi')

    after = _run(go())
    assert [o['path'] for o in after['outputs']] == ['outputs/fig.png']
    assert after['outputs'][0]['file_id']
