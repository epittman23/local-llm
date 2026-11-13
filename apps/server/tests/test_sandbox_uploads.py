"""The chat's attached files in the sandbox (T13): which files, and the sync into /workspace/uploads.

Pins, without Docker or Kata:

- sandbox/uploads.py's selection, ported from test_jupyter_chat_files.py
  with the code (which T40 deletes): only uploaded files the user owns or
  may read, each id once, at most MAX_FILES, safe and unique names, the caps
  with a note for each file left out, decided from the size and hash
  recorded at upload; for the sync, an admin in another user's chat copies
  only what the owner may read too (Q14);
- the sync before every `bash` and `view` call, through the tool,
  SandboxManager and FakeBackend: copied once per sandbox start and then
  skipped while nothing changes; a new, changed or removed attachment puts
  the current set; the read-only uploads mount refuses UID 1000 every change
  (EROFS), and moving or removing it (EBUSY); notes reach the result's
  stderr; a failed sync still runs the command, with a note, and leaves no
  record; the record goes with the sandbox;
- the fake's `mv`, `rm` and `rmdir`, with the guest's permission checks and
  the mount's.

Run from apps/server:

    python -m pytest tests/test_sandbox_uploads.py
"""

import asyncio
import errno
import json
from types import SimpleNamespace
from typing import cast

import pytest

from local_llm.models.chats import Chats
from local_llm.models.users import Users
from local_llm.sandbox import SandboxError, SandboxManager, SandboxNotRunning, SandboxSettings, uploads, wrap_command
from local_llm.sandbox.backend import validate_put_files
from local_llm.sandbox.fake import FakeBackend, FakeExecRequest, FakeFile, FakeRun, FakeWorkspace, interpret
from local_llm.sandbox.workspaces import MemoryWorkspaces
from local_llm.tools import builtin

OWNER = SimpleNamespace(id='owner')
CHAT = '11111111-1111-4111-8111-111111111111'
UPLOADS = '/workspace/uploads'
SYNC_FAILED = (
    'The attached files could not be copied into /workspace/uploads ({why}), '
    'so it may be missing files or hold an older set'
)


@pytest.fixture
def stored_files(tmp_path, monkeypatch):
    """Files by id, each backed by a real file on disk; returns the function that adds one."""
    from local_llm.models.files import Files
    from local_llm.storage.provider import Storage
    from local_llm.utils.access_control import files as access

    files: dict = {}
    # File id -> who may read it by a grant: True for everyone, else a set of user ids.
    readable_by_grant: dict = {}

    def add(file_id, filename, user_id='owner', content=b'a,b\n1,2\n', size=None, granted=False, meta=None):
        path = tmp_path / file_id
        path.write_bytes(content if size is None else b'x' * size)
        files[file_id] = SimpleNamespace(id=file_id, user_id=user_id, filename=filename, path=str(path), meta=meta)
        if granted:
            readable_by_grant[file_id] = granted
        return path

    async def get_file_by_id(file_id, db=None):
        return files.get(file_id)

    async def has_access(file_id, access_type, user, db=None, user_group_ids=None):
        grant = readable_by_grant.get(file_id, False)
        return access_type == 'read' and (grant is True or (bool(grant) and user.id in grant))

    monkeypatch.setattr(Files, 'get_file_by_id', get_file_by_id)
    monkeypatch.setattr(access, 'has_access_to_file', has_access)

    def get_file(path):
        add.fetched.append(path)
        return path

    add.fetched = []
    monkeypatch.setattr(Storage, 'get_file', get_file)
    return add


def _items(*ids, kind='file'):
    return [{'type': kind, 'id': i, 'name': f'name-{i}'} for i in ids]


# The selection, ported from test_jupyter_chat_files.py.


def test_copies_the_users_own_files_by_their_filename(stored_files):
    stored_files('f1', 'sales.csv')
    files, notes = asyncio.run(uploads.chat_files(_items('f1'), OWNER))

    assert [name for name, _ in files] == ['sales.csv']
    assert notes == []


def test_another_users_file_needs_read_access(stored_files):
    stored_files('mine', 'a.csv')
    stored_files('theirs', 'b.csv', user_id='someone-else')
    stored_files('shared', 'c.csv', user_id='someone-else', granted=True)
    files, _ = asyncio.run(uploads.chat_files(_items('mine', 'theirs', 'shared'), OWNER))

    assert [name for name, _ in files] == ['a.csv', 'c.csv']


def test_only_uploaded_files_count(stored_files):
    stored_files('f1', 'a.csv')
    items = [
        *_items('f1', kind='collection'),
        *_items('f1', kind='web_search'),
        {'type': 'image', 'url': 'data:image/png;base64,xx'},
        {'type': 'file'},
        'not a dict',
    ]
    files, notes = asyncio.run(uploads.chat_files(items, OWNER))

    assert files == [] and notes == []


def test_no_user_copies_nothing(stored_files):
    stored_files('f1', 'a.csv')
    assert asyncio.run(uploads.chat_files(_items('f1'), None)) == ([], [])


def test_a_missing_file_record_is_skipped(stored_files):
    assert asyncio.run(uploads.chat_files(_items('gone'), OWNER)) == ([], [])


def test_names_are_reduced_to_a_base_name_and_made_unique(stored_files):
    stored_files('f1', '../../etc/passwd')
    stored_files('f2', 'data.csv')
    stored_files('f3', 'data.csv')
    stored_files('f4', 'C:\\Users\\me\\data.csv')
    stored_files('f5', '')
    files, _ = asyncio.run(uploads.chat_files(_items('f1', 'f2', 'f3', 'f4', 'f5'), OWNER))

    # A file without a filename takes the name the chat gave it.
    assert [name for name, _ in files] == ['passwd', 'data.csv', 'data (2).csv', 'data (3).csv', 'name-f5']


def test_files_over_the_limits_are_left_out_with_a_note(stored_files, monkeypatch):
    monkeypatch.setattr(uploads, 'MAX_FILE_BYTES', 10)
    monkeypatch.setattr(uploads, 'MAX_TOTAL_BYTES', 15)
    stored_files('small', 'small.csv', size=8)
    stored_files('big', 'big.csv', size=11)
    stored_files('second', 'second.csv', size=8)
    files, notes = asyncio.run(uploads.chat_files(_items('small', 'big', 'second'), OWNER))

    assert [name for name, _ in files] == ['small.csv']
    assert [note.split(':')[0] for note in notes] == ['big.csv', 'second.csv']
    assert notes[0] == 'big.csv: not copied, over the 0 MB per file or 0 MB total limit'


def test_the_caps_can_be_given_per_call(stored_files):
    stored_files('small', 'small.csv', size=8)
    stored_files('big', 'big.csv', size=11)
    files, notes = asyncio.run(
        uploads.chat_files(_items('small', 'big'), OWNER, max_file_bytes=10, max_total_bytes=100)
    )

    assert [name for name, _ in files] == ['small.csv']
    assert notes == ['big.csv: not copied, over the 0 MB per file or 0 MB total limit']


def test_the_default_caps_are_50_and_200_mib():
    assert (uploads.MAX_FILE_BYTES, uploads.MAX_TOTAL_BYTES) == (50 * 2**20, 200 * 2**20)


def test_a_file_storage_cannot_hand_over_gets_a_note(stored_files, monkeypatch):
    from local_llm.storage.provider import Storage

    stored_files('f1', 'a.csv')

    def broken(path):
        raise OSError('the object store is down')

    monkeypatch.setattr(Storage, 'get_file', broken)
    assert asyncio.run(uploads.chat_files(_items('f1'), OWNER)) == ([], ['a.csv: could not be read'])


def test_chat_uploads_carries_the_id_and_size(stored_files):
    path = stored_files('f1', 'a.csv', size=5)
    stored_files('f2', 'b.csv', size=5, meta={'size': 5, 'file_hash': 'h2'})
    files, _ = asyncio.run(uploads.chat_uploads(_items('f1', 'f2'), OWNER))
    # Without a recorded size the file is fetched to measure it; with one, nothing is fetched.
    assert files == [
        uploads.Upload('a.csv', 'f1', 5, None, str(path), str(path)),
        uploads.Upload('b.csv', 'f2', 5, 'h2', str(path.parent / 'f2')),
    ]
    assert stored_files.fetched == [str(path)]


def test_the_jupyter_module_still_offers_chat_files_with_its_own_caps(stored_files, monkeypatch):
    from local_llm.utils import code_interpreter as ci

    assert (ci.MAX_FILE_BYTES, ci.MAX_TOTAL_BYTES) == (uploads.MAX_FILE_BYTES, uploads.MAX_TOTAL_BYTES)
    monkeypatch.setattr(ci, 'MAX_FILE_BYTES', 10)
    stored_files('big', 'big.csv', size=11)
    files, notes = asyncio.run(ci.chat_files(_items('big'), OWNER))
    assert files == [] and [note.split(':')[0] for note in notes] == ['big.csv']


# The sync, through the bash tool.


class _Chats:
    async def usable(self, chat_id, user):
        # The owner, or an admin as ENABLE_ADMIN_CHAT_ACCESS lets in (Q14).
        return chat_id == CHAT and user.id in ('owner', 'admin')

    async def updated_at(self, chat_ids):
        return {}


async def _settings() -> SandboxSettings:
    return SandboxSettings()


class _Rig:
    """A manager on a FakeBackend on request.app.state.sandbox, with users `owner` (the chat's) and `admin`."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.backend = FakeBackend()
        self.manager = SandboxManager(self.backend, workspaces=MemoryWorkspaces(), chats=_Chats(), settings=_settings)
        self.request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(sandbox=self.manager)))

        async def get_user_by_id(user_id, db=None):
            roles = {'owner': 'user', 'admin': 'admin'}
            return SimpleNamespace(id=user_id, role=roles[user_id]) if user_id in roles else None

        async def is_chat_owner(chat_id, user_id, db=None):
            return chat_id == CHAT and user_id == 'owner'

        async def get_chat_by_id(chat_id, db=None):
            return SimpleNamespace(id=CHAT, user_id='owner') if chat_id == CHAT else None

        monkeypatch.setattr(Users, 'get_user_by_id', get_user_by_id)
        monkeypatch.setattr(Chats, 'is_chat_owner', is_chat_owner)
        monkeypatch.setattr(Chats, 'get_chat_by_id', get_chat_by_id)

    async def bash(self, command: str, files: list | None = None, user: str = 'owner') -> dict:
        out = await builtin.bash(
            command=command,
            __request__=self.request,
            __user__={'id': user},
            __chat_id__=CHAT,
            __metadata__={'files': files} if files is not None else {},
        )
        return json.loads(out)

    async def view(self, path: str, files: list | None = None) -> str:
        return await builtin.view(
            path=path,
            __request__=self.request,
            __user__={'id': 'owner'},
            __chat_id__=CHAT,
            __metadata__={'files': files} if files is not None else {},
        )

    async def guest(self, command: str) -> FakeRun:
        """Run `command` as UID 1000 straight on the backend, with no sync before it."""
        result = await self.backend.exec(CHAT, wrap_command(command, 60), 60)
        return FakeRun(result.returncode, result.stdout.encode(), result.stderr.encode())

    def puts(self) -> list[list[tuple[str, bytes]]]:
        return [
            cast(list[tuple[str, bytes]], args['files']) for name, args in self.backend.calls if name == 'put_uploads'
        ]

    def uploads(self) -> dict[str, tuple[bytes | None, int, int]]:
        """What the uploads mount holds, as the guest sees it: path -> (content, uid, mode)."""
        return {path: (e.content, e.uid, e.mode) for path, e in self.backend.sandboxes[CHAT].uploads.items()}


def _names(put: list[tuple[str, bytes]]) -> list[str]:
    return [name for name, _ in put]


def test_the_first_call_copies_the_files_read_only(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    stored_files('f1', 'sales.csv', content=b'a,b\n1,2\n')
    stored_files('f2', 'notes.txt', content=b'hello')
    result = asyncio.run(rig.bash('cat uploads/sales.csv', _items('f1', 'f2')))

    assert result['returncode'] == 0 and result['stdout'] == 'a,b\n1,2\n'
    assert rig.puts() == [[('sales.csv', b'a,b\n1,2\n'), ('notes.txt', b'hello')]]
    # A read-only mount: the files show as the backend's user's (1000 on the laptop), mode 0444.
    assert rig.uploads() == {
        UPLOADS: (None, 1000, 0o755),
        f'{UPLOADS}/sales.csv': (b'a,b\n1,2\n', 1000, 0o444),
        f'{UPLOADS}/notes.txt': (b'hello', 1000, 0o444),
    }


def test_files_already_copied_are_not_copied_again(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    stored_files('f1', 'sales.csv')

    async def go():
        for _ in range(3):
            await rig.bash('printf hi', _items('f1'))

    asyncio.run(go())
    assert len(rig.puts()) == 1
    # Nothing to check in the guest: the mount cannot be changed from there. The only stats are the bash tool's
    # checks of /workspace/outputs: before and after the first command, then after each one, since a call compares
    # with the listing the last one took (sandbox/outputs.py).
    stats = [cast(dict, args)['path'] for name, args in rig.backend.calls if name == 'stat']
    assert stats == ['/workspace/outputs'] * 4


def test_a_new_attachment_puts_the_whole_set(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    stored_files('f1', 'a.csv', content=b'A')
    stored_files('f2', 'b.csv', content=b'B')

    async def go():
        await rig.bash('printf hi', _items('f1'))
        return await rig.bash('cat uploads/a.csv uploads/b.csv', _items('f1', 'f2'))

    assert asyncio.run(go())['stdout'] == 'AB'
    assert [_names(put) for put in rig.puts()] == [['a.csv'], ['a.csv', 'b.csv']]


def test_a_file_whose_size_changed_is_copied_again(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    path = stored_files('f1', 'a.csv', content=b'old')

    async def go():
        await rig.bash('printf hi', _items('f1'))
        path.write_bytes(b'newer')
        return await rig.bash('cat uploads/a.csv', _items('f1'))

    assert asyncio.run(go())['stdout'] == 'newer'
    assert len(rig.puts()) == 2


def test_a_removed_attachment_is_removed(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    stored_files('f1', 'a.csv')
    stored_files('f2', 'b.csv')

    async def go():
        await rig.bash('printf hi', _items('f1', 'f2'))
        await rig.bash('printf hi', _items('f2'))
        listing = await rig.bash('ls uploads', _items('f2'))
        await rig.bash('printf hi', [])
        empty = await rig.bash('ls uploads', [])
        return listing, empty

    listing, empty = asyncio.run(go())
    assert listing['stdout'] == 'b.csv\n'
    assert empty['stdout'] == '' and empty['returncode'] == 0
    assert [_names(put) for put in rig.puts()] == [['a.csv', 'b.csv'], ['b.csv'], []]
    assert rig.uploads() == {UPLOADS: (None, 1000, 0o755)}


def test_a_chat_without_files_puts_once_per_sandbox_start(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    stored_files('f1', 'a.csv')

    async def go():
        await rig.bash('printf hi', _items('f1'))
        # Stopped with a file in it; the attachment is removed before the next start.
        async with rig.manager._hold(CHAT):
            await rig.manager._stop(CHAT, destroy=False)
        await rig.bash('printf hi')
        await rig.bash('printf hi', [])
        return await rig.bash('ls uploads')

    assert asyncio.run(go())['stdout'] == ''
    # The record goes with the stopped sandbox, so the next start puts the (empty) set once.
    assert [_names(put) for put in rig.puts()] == [['a.csv'], []]


@pytest.mark.parametrize(
    ('command', 'stderr'),
    [
        ('mv uploads x', "mv: cannot move 'uploads' to 'x': Device or resource busy"),
        ('rmdir uploads', "rmdir: failed to remove 'uploads': Device or resource busy"),
        ('rm uploads', "rm: cannot remove 'uploads': Is a directory"),
        ('mkdir uploads', "mkdir: cannot create directory 'uploads': File exists"),
        ('ln -s /etc uploads', "ln: failed to create symbolic link 'uploads': File exists"),
        ('printf x > uploads', 'bash: line 1: uploads: Is a directory'),
        ('printf x > uploads/a.csv', 'bash: line 1: uploads/a.csv: Read-only file system'),
        ('rm uploads/a.csv', "rm: cannot remove 'uploads/a.csv': Read-only file system"),
        ('chmod 666 uploads/a.csv', "chmod: changing permissions of 'uploads/a.csv': Read-only file system"),
        ('chmod 777 uploads', "chmod: changing permissions of 'uploads': Read-only file system"),
        ('mv uploads/a.csv uploads/b.csv', "mv: cannot move 'uploads/a.csv' to 'uploads/b.csv': Read-only file system"),
        ('mv uploads/a.csv a.csv', "mv: cannot move 'uploads/a.csv' to 'a.csv': Invalid cross-device link"),
        ('mv top.txt uploads', "mv: cannot move 'top.txt' to 'uploads/top.txt': Invalid cross-device link"),
        ('printf x > uploads/new', 'bash: line 1: uploads/new: Read-only file system'),
        ('mkdir uploads/sub', "mkdir: cannot create directory 'uploads/sub': Read-only file system"),
        ('ln -s /etc uploads/etc', "ln: failed to create symbolic link 'uploads/etc': Read-only file system"),
    ],
)
def test_uid_1000_can_neither_change_nor_move_the_uploads(stored_files, monkeypatch, command, stderr):
    rig = _Rig(monkeypatch)
    stored_files('f1', 'a.csv', content=b'A')

    async def go():
        await rig.bash('printf t > top.txt', _items('f1'))
        return await rig.guest(command), await rig.bash('cat uploads/a.csv', _items('f1'))

    attempt, after = asyncio.run(go())
    assert attempt.returncode != 0
    assert attempt.stderr.decode().strip() == stderr
    assert after['stdout'] == 'A'
    assert len(rig.puts()) == 1
    assert rig.uploads() == {UPLOADS: (None, 1000, 0o755), f'{UPLOADS}/a.csv': (b'A', 1000, 0o444)}


def test_notes_for_files_left_out_reach_stderr(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    monkeypatch.setattr(uploads, 'MAX_FILE_BYTES', 10)
    stored_files('small', 'small.csv', size=8)
    stored_files('big', 'big.csv', size=11)

    async def go():
        quiet = await rig.bash('printf hi', _items('small', 'big'))
        loud = await rig.bash('cat missing.txt', _items('small', 'big'))
        return quiet, loud

    quiet, loud = asyncio.run(go())
    note = 'big.csv: not copied, over the 0 MB per file or 200 MB total limit'
    assert (quiet['stdout'], quiet['stderr']) == ('hi', note)
    # After the command's own stderr, as the Jupyter engine adds them; the note is repeated at every call.
    assert loud['stderr'] == f'cat: missing.txt: No such file or directory\n\n{note}'
    assert [_names(put) for put in rig.puts()] == [['small.csv']]


def test_the_total_cap_bounds_what_one_put_carries(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    monkeypatch.setattr(uploads, 'MAX_TOTAL_BYTES', 20)
    for n in range(4):
        stored_files(f'f{n}', f'{n}.bin', size=8)
    result = asyncio.run(rig.bash('printf hi', _items('f0', 'f1', 'f2', 'f3')))

    assert sum(len(content) for _, content in rig.puts()[0]) <= 20
    assert _names(rig.puts()[0]) == ['0.bin', '1.bin']
    assert result['stderr'].count('not copied') == 2


def test_a_file_that_cannot_be_read_when_copied_gets_a_note(stored_files, monkeypatch, tmp_path):
    rig = _Rig(monkeypatch)
    stored_files('f1', 'a.csv', content=b'A')
    stored_files('f2', 'b.csv')
    # Listed with a size, but a directory cannot be read as a file.
    (tmp_path / 'f2').unlink()
    (tmp_path / 'f2').mkdir()

    async def go():
        failing = [await rig.bash('ls uploads', _items('f1', 'f2')) for _ in range(2)]
        # The failure passes: the next call tries the file again, since it was never recorded.
        (tmp_path / 'f2').rmdir()
        (tmp_path / 'f2').write_bytes(b'a,b\n1,2\n')
        return failing, await rig.bash('ls uploads', _items('f1', 'f2'))

    failing, recovered = asyncio.run(go())
    for result in failing:
        assert result['stdout'] == 'a.csv\n'
        assert result['stderr'] == 'b.csv: could not be read'
    assert (recovered['stdout'], recovered['stderr']) == ('a.csv\nb.csv\n', '')
    assert [_names(put) for put in rig.puts()] == [['a.csv'], ['a.csv'], ['a.csv', 'b.csv']]


def test_a_failed_put_still_runs_the_command_with_a_note_and_leaves_no_record(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    stored_files('f1', 'a.csv')
    real = rig.backend.put_uploads
    failures = [SandboxError('docker said no at unix:///var/run/docker.sock /var/lib/docker/volumes/x')]

    async def flaky(chat_id, files):
        if failures:
            raise failures.pop()
        await real(chat_id, files)

    monkeypatch.setattr(rig.backend, 'put_uploads', flaky)

    async def go():
        failed = await rig.bash('printf hi', _items('f1'))
        assert rig.manager._uploads == {}
        return failed, await rig.bash('printf hi', _items('f1'))

    failed, ok = asyncio.run(go())
    assert (failed['returncode'], failed['stdout']) == (0, 'hi')
    assert failed['stderr'] == SYNC_FAILED.format(why='the copy failed on the server')
    assert 'docker' not in json.dumps(failed)
    assert (ok['stdout'], ok['stderr']) == ('hi', '')
    assert len(rig.puts()) == 1


def test_the_record_goes_with_the_sandbox(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    stored_files('f1', 'a.csv')

    async def go():
        await rig.bash('printf hi', _items('f1'))
        assert set(rig.manager._uploads) == {CHAT}
        # The volume is destroyed with its files; the next call starts a new one and copies again.
        await rig.manager.release(CHAT)
        assert rig.manager._uploads == {}
        return await rig.bash('ls uploads', _items('f1'))

    assert asyncio.run(go())['stdout'] == 'a.csv\n'
    assert len(rig.puts()) == 2


def test_a_closed_session_keeps_no_record(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)

    async def go():
        async with rig.manager.session(CHAT, OWNER) as session:
            pass
        with pytest.raises(SandboxError):
            session.synced_uploads = None

    asyncio.run(go())


def test_the_sync_runs_inside_the_session_before_the_command(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    stored_files('f1', 'a.csv')
    asyncio.run(rig.bash('printf hi', _items('f1')))
    names = [name for name, _ in rig.backend.calls]
    # The stats either side of the command are the bash tool's checks of /workspace/outputs, which does not exist.
    assert names[names.index('create') :] == ['create', 'put_uploads', 'stat', 'exec', 'kill_uid_1000', 'stat']


def test_view_syncs_too_so_the_files_are_there_from_the_first_call(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    stored_files('f1', 'a.csv', content=b'x,y\n')
    monkeypatch.setattr(uploads, 'MAX_FILE_BYTES', 10)
    stored_files('big', 'big.csv', size=11)
    shown = json.loads(asyncio.run(rig.view('uploads/a.csv', _items('f1', 'big'))))

    assert 'x,y' in json.dumps(shown)
    # view's result is the file; the notes are bash's alone.
    assert 'big.csv' not in json.dumps(shown)
    assert [_names(put) for put in rig.puts()] == [['a.csv']]


def test_a_full_workspace_can_still_run_rm(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    stored_files('f1', 'a.csv')

    async def full(chat_id, files):
        raise SandboxError('ENOSPC writing /var/lib/docker/volumes/lllm-sandbox-x/_data/uploads/a.csv')

    async def go():
        await rig.bash('printf hi')
        assert (await rig.guest('printf data > /workspace/big.bin')).returncode == 0
        monkeypatch.setattr(rig.backend, 'put_uploads', full)
        return await rig.bash('rm big.bin', _items('f1'))

    result = asyncio.run(go())
    assert result['returncode'] == 0
    assert result['stderr'] == SYNC_FAILED.format(why='the copy failed on the server')
    assert '/workspace/big.bin' not in rig.backend.sandboxes[CHAT].files


def test_a_reason_written_for_the_model_reaches_the_note(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    stored_files('f1', 'a.csv')

    async def refused(chat_id, files):
        raise SandboxError('internal detail', public='the sandbox is busy')

    monkeypatch.setattr(rig.backend, 'put_uploads', refused)
    result = asyncio.run(rig.bash('printf hi', _items('f1')))
    assert result['stderr'] == SYNC_FAILED.format(why='the sandbox is busy')


def test_a_sandbox_that_stops_during_the_sync_fails_the_call(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    stored_files('f1', 'a.csv')

    async def died(chat_id, files):
        rig.backend.sandboxes[CHAT].running = False
        raise SandboxNotRunning('the VM died')

    monkeypatch.setattr(rig.backend, 'put_uploads', died)
    result = asyncio.run(rig.bash('printf hi', _items('f1')))
    assert result == {'error': 'The sandbox failed: it stopped during the call; the next call starts it again'}
    assert [name for name, _ in rig.backend.calls].count('exec') == 0


@pytest.mark.parametrize(
    ('raw', 'fallback', 'expected'),
    [
        ('..', 'id1', 'id1'),
        ('.', 'id1', 'id1'),
        ('', 'id1', 'id1'),
        ('dir/..', 'id1', 'id1'),
        ('..', '..', 'file'),
        ('a\0b\nc\x7f.csv', 'id1', 'abc.csv'),
        ('\u202eevil\u200b.csv', 'id1', 'evil.csv'),
        ('\ud800.csv', 'id1', '.csv'),
        ('é' * 130, 'id1', 'é' * 127),
        ('x' * 252 + '.csv', 'id1', 'x' * 251 + '.csv'),
        ('a.' + 'e' * 300, 'id1', 'a'),
        ('C:\\Users\\me\\data.csv', 'id1', 'data.csv'),
    ],
)
def test_safe_name_always_gives_a_name_put_files_accepts(raw, fallback, expected):
    name = uploads.safe_name(raw, fallback)
    assert name == expected
    validate_put_files('uploads', [(name, b'', 0o444)])


def test_unique_names_stay_within_255_bytes(stored_files):
    long = 'y' * 251 + '.csv'
    stored_files('f1', long)
    stored_files('f2', long)
    stored_files('f3', '')
    files, _ = asyncio.run(
        uploads.chat_files([*_items('f1', 'f2'), {'type': 'file', 'id': 'f3', 'name': '..\0\n'}], OWNER)
    )
    names = [name for name, _ in files]
    assert names == [long, 'y' * 247 + ' (2).csv', 'f3']
    validate_put_files('uploads', [(name, b'', 0o444) for name in names])


def test_bad_names_cannot_lock_bash_out(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    stored_files('f1', '..', content=b'A')
    stored_files('f2', 'é' * 200, content=b'B')
    stored_files('f3', 'z' * 251 + '.csv', content=b'C')
    stored_files('f4', 'z' * 251 + '.csv', content=b'D')
    result = asyncio.run(rig.bash('ls uploads', _items('f1', 'f2', 'f3', 'f4')))

    assert result['returncode'] == 0 and result['stderr'] == ''
    assert sorted(result['stdout'].splitlines()) == sorted(
        ['f1', 'é' * 127, 'z' * 251 + '.csv', 'z' * 247 + ' (2).csv']
    )


def test_each_file_id_counts_once_and_odd_ids_are_ignored(stored_files):
    stored_files('f1', 'a.csv')
    items = [*_items('f1', 'f1', 'f1'), {'type': 'file', 'id': ['f1']}, {'type': 'file', 'id': 7}]
    files, notes = asyncio.run(uploads.chat_files(items, OWNER))
    assert [name for name, _ in files] == ['a.csv'] and notes == []


def test_files_past_the_count_limit_are_not_looked_up(stored_files, monkeypatch):
    from local_llm.models.files import Files

    monkeypatch.setattr(uploads, 'MAX_FILES', 2)
    for n in range(5):
        stored_files(f'f{n}', f'{n}.csv')
    looked_up: list[str] = []
    real = Files.get_file_by_id

    async def counting(file_id, db=None):
        looked_up.append(file_id)
        return await real(file_id)

    monkeypatch.setattr(Files, 'get_file_by_id', counting)
    files, notes = asyncio.run(uploads.chat_files(_items('f0', 'f1', 'f2', 'f3', 'f4'), OWNER))

    assert [name for name, _ in files] == ['0.csv', '1.csv']
    assert notes == ['3 more attached file(s) not copied: at most 2 files are copied, from the first 200 listed']
    assert looked_up == ['f0', 'f1']


def test_the_default_count_limit_is_100():
    assert uploads.MAX_FILES == 100


def test_unchanged_files_with_a_recorded_size_are_not_fetched_from_storage(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    stored_files('f1', 'a.csv', content=b'abc', meta={'size': 3, 'file_hash': 'h1'})

    async def go():
        for _ in range(3):
            await rig.bash('printf hi', _items('f1'))

    asyncio.run(go())
    assert len(rig.puts()) == 1
    # Fetched once, for the put; the two calls after it decide from the database alone.
    assert len(stored_files.fetched) == 1


def test_a_new_hash_puts_again(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    stored_files('f1', 'a.csv', content=b'abc', meta={'size': 3, 'file_hash': 'h1'})

    async def go():
        await rig.bash('printf hi', _items('f1'))
        stored_files('f1', 'a.csv', content=b'xyz', meta={'size': 3, 'file_hash': 'h2'})
        return await rig.bash('cat uploads/a.csv', _items('f1'))

    assert asyncio.run(go())['stdout'] == 'xyz'
    assert len(rig.puts()) == 2


def test_a_file_larger_than_recorded_is_read_only_up_to_the_cap(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    monkeypatch.setattr(uploads, 'MAX_FILE_BYTES', 10)
    # Recorded as 3 bytes, so it passes the selection, but 30 on disk.
    stored_files('f1', 'a.csv', size=30, meta={'size': 3})
    stored_files('f2', 'b.csv', content=b'12345', meta={'size': 3})
    result = asyncio.run(rig.bash('cat uploads/b.csv', _items('f1', 'f2')))

    assert result['stdout'] == '12345'
    assert result['stderr'] == 'a.csv: not copied, over the 0 MB per file or 200 MB total limit'
    assert [_names(put) for put in rig.puts()] == [['b.csv']]


def test_malformed_recorded_facts_are_ignored(stored_files):
    stored_files('f1', 'a.csv', size=4, meta={'size': '4', 'file_hash': 5})
    stored_files('f2', 'b.csv', size=4, meta='not a dict')
    stored_files('f3', 'c.csv', size=4, meta={'size': -1})
    files, _ = asyncio.run(uploads.chat_uploads(_items('f1', 'f2', 'f3'), OWNER))
    assert [(f.size, f.file_hash, f.path is not None) for f in files] == [(4, None, True)] * 3


def test_chat_files_notes_a_file_storage_cannot_hand_over(stored_files, monkeypatch):
    from local_llm.storage.provider import Storage

    stored_files('f1', 'a.csv', meta={'size': 8})

    def broken(path):
        raise OSError('the object store is down')

    monkeypatch.setattr(Storage, 'get_file', broken)
    assert asyncio.run(uploads.chat_files(_items('f1'), OWNER)) == ([], ['a.csv: could not be read'])


def test_an_admin_in_another_users_chat_copies_only_what_the_owner_may_read_too(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    stored_files('mine', 'owners.csv', user_id='owner', granted={'admin'}, content=b'O')
    stored_files('admins', 'private.csv', user_id='admin', content=b'P')
    stored_files('shared', 'shared.csv', user_id='admin', granted={'owner'}, content=b'S')
    stored_files('notmine', 'unreadable.csv', user_id='owner', content=b'U')

    async def go():
        as_admin = await rig.bash('ls uploads', _items('mine', 'admins', 'shared', 'notmine'), user='admin')
        as_owner = await rig.bash('ls uploads', _items('mine', 'admins', 'shared', 'notmine'))
        return as_admin, as_owner

    as_admin, as_owner = asyncio.run(go())
    # The admin's own file never lands in the owner's workspace; one the admin cannot read is left out silently.
    assert as_admin['stdout'] == 'owners.csv\nshared.csv\n'
    assert as_admin['stderr'] == "private.csv: not copied, this chat's owner may not read it"
    # The owner gets what they may read, whatever the admin's call copied.
    assert as_owner['stdout'] == 'owners.csv\nshared.csv\nunreadable.csv\n'
    assert as_owner['stderr'] == ''
    assert not any(content == b'P' for put in rig.puts() for _, content in put)


def test_no_uploads_when_the_workspace_owner_cannot_be_told(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    stored_files('f1', 'a.csv', user_id='admin')

    async def gone(chat_id, db=None):
        return None

    monkeypatch.setattr(Chats, 'get_chat_by_id', gone)
    result = asyncio.run(rig.bash('printf hi', _items('f1'), user='admin'))
    assert result['stderr'] == "The attached files were not copied: this chat's owner could not be looked up"
    assert rig.puts() == [[]]


def test_an_unknown_owner_looks_nothing_up(stored_files, monkeypatch):
    from local_llm.models.files import Files

    stored_files('f1', 'a.csv')

    async def never(file_id, db=None):
        raise AssertionError('looked up')

    monkeypatch.setattr(Files, 'get_file_by_id', never)
    # Without file items there is nothing to say.
    asked: list[bool] = []

    async def unknown():
        asked.append(True)

    # Without file items the owner is not even asked for.
    assert asyncio.run(uploads.chat_uploads(_items('f1', kind='collection'), OWNER, owner_lookup=unknown)) == ([], [])
    assert asked == []
    files, notes = asyncio.run(uploads.chat_uploads(_items('f1', 'f2'), OWNER, owner_lookup=unknown))
    assert files == [] and len(notes) == 1
    assert asked == [True]


def test_the_lookups_per_call_are_bounded_whatever_the_request_lists(stored_files, monkeypatch):
    from local_llm.models.files import Files
    from local_llm.utils.access_control import files as access

    rig = _Rig(monkeypatch)
    stored_files('mine', 'a.csv', content=b'A')
    # Real files the caller may not read cost an access check each; ids that do not exist cost a lookup each.
    for n in range(300):
        stored_files(f'theirs{n}', f'{n}.csv', user_id='someone-else')
    items = _items('mine', *(f'theirs{n}' for n in range(300)), *(f'bogus{n}' for n in range(20_000)))
    looked_up: list[str] = []
    checked: list[str] = []
    real_lookup, real_check = Files.get_file_by_id, access.has_access_to_file

    async def counting_lookup(file_id, db=None):
        looked_up.append(file_id)
        return await real_lookup(file_id)

    async def counting_check(file_id, access_type, user, db=None, user_group_ids=None):
        checked.append(file_id)
        return await real_check(file_id, access_type, user)

    monkeypatch.setattr(Files, 'get_file_by_id', counting_lookup)
    monkeypatch.setattr(access, 'has_access_to_file', counting_check)

    async def go():
        return [await rig.bash('cat uploads/a.csv', items) for _ in range(2)]

    for result in asyncio.run(go()):
        assert result['stdout'] == 'A'
        assert result['stderr'] == (
            f'{300 + 20_000 + 1 - uploads.MAX_LOOKUPS} more attached file(s) not copied: at most 100 files are copied,'
            ' from the first 200 listed'
        )
    # Each call, the cached one too, looks up at most MAX_LOOKUPS ids and checks access on no more.
    assert len(looked_up) == 2 * uploads.MAX_LOOKUPS
    assert len(checked) <= 2 * uploads.MAX_LOOKUPS
    assert len(rig.puts()) == 1


def test_chat_owner(monkeypatch):
    owner = SimpleNamespace(id='owner')
    admin = SimpleNamespace(id='admin')

    async def is_chat_owner(chat_id, user_id, db=None):
        return chat_id == CHAT and user_id == 'owner'

    async def get_chat_by_id(chat_id, db=None):
        if chat_id == 'broken':
            raise RuntimeError('the database is down')
        return SimpleNamespace(user_id='owner') if chat_id == CHAT else None

    async def get_user_by_id(user_id, db=None):
        return owner if user_id == 'owner' else None

    monkeypatch.setattr(Chats, 'is_chat_owner', is_chat_owner)
    monkeypatch.setattr(Chats, 'get_chat_by_id', get_chat_by_id)
    monkeypatch.setattr(Users, 'get_user_by_id', get_user_by_id)

    async def go():
        return [
            await uploads.chat_owner(CHAT, owner),
            await uploads.chat_owner(CHAT, admin),
            # An unsaved chat's sandbox is the caller's own (Q12).
            await uploads.chat_owner('temporary:benchmark-1', admin),
            await uploads.chat_owner('22222222-2222-4222-8222-222222222222', admin),
            await uploads.chat_owner('broken', admin),
            await uploads.chat_owner(None, admin),
            await uploads.chat_owner(CHAT, None),
        ]

    assert asyncio.run(go()) == [owner, owner, admin, None, None, None, None]


def test_a_call_without_files_does_not_look_the_owner_up(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    asked: list[str] = []

    async def is_chat_owner(chat_id, user_id, db=None):
        asked.append(chat_id)
        return True

    monkeypatch.setattr(Chats, 'is_chat_owner', is_chat_owner)
    stored_files('f1', 'a.csv')

    async def go():
        await rig.bash('printf hi')
        await rig.bash('printf hi', [{'type': 'collection', 'id': 'k1'}])
        assert asked == []
        await rig.bash('printf hi', _items('f1'))

    asyncio.run(go())
    assert asked == [CHAT]


def test_stop_empties_the_uploads_and_the_next_start_puts_them_again(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    stored_files('f1', 'a.csv', content=b'A')

    async def go():
        await rig.bash('printf hi', _items('f1'))
        async with rig.manager._hold(CHAT):
            await rig.manager._stop(CHAT, destroy=False)
        # As kata.py's stop: the host directory is emptied, so a stopped sandbox keeps no uploads.
        assert rig.uploads() == {UPLOADS: (None, 1000, 0o755)}
        return await rig.bash('cat uploads/a.csv', _items('f1'))

    assert asyncio.run(go())['stdout'] == 'A'
    assert len(rig.puts()) == 2


def test_view_names_a_failed_sync_in_its_error(stored_files, monkeypatch):
    rig = _Rig(monkeypatch)
    stored_files('f1', 'a.csv')

    async def full(chat_id, files):
        raise SandboxError('ENOSPC on the host')

    monkeypatch.setattr(rig.backend, 'put_uploads', full)

    async def go():
        missing = json.loads(await rig.view('uploads/a.csv', _items('f1')))
        listing = json.loads(await rig.view('.', _items('f1')))
        return missing, listing

    missing, listing = asyncio.run(go())
    note = SYNC_FAILED.format(why='the copy failed on the server')
    assert missing['error'].endswith(f'({note})')
    assert 'ENOSPC' not in json.dumps(missing)
    # A view that works shows what it shows; the note is bash's.
    assert 'error' not in listing


# The fake's mv and rm.


def _workspace() -> FakeWorkspace:
    files = {
        '/workspace': FakeFile(content=None, uid=1000, mode=0o755),
        '/workspace/sub': FakeFile(content=None, uid=1000, mode=0o755),
        '/workspace/sub/f': FakeFile(content=b'f', uid=1000, mode=0o644),
        '/workspace/ro': FakeFile(content=None, uid=0, mode=0o555),
        '/workspace/ro/r': FakeFile(content=b'r', uid=0, mode=0o444),
        '/workspace/ro/empty': FakeFile(content=None, uid=0, mode=0o755),
        '/workspace/gone': FakeFile(content=None, uid=1000, mode=0o755),
        '/workspace/top': FakeFile(content=b't', uid=1000, mode=0o644),
    }
    return FakeWorkspace(files)


def _sh(ws: FakeWorkspace, command: str) -> FakeRun:
    request = FakeExecRequest(CHAT, wrap_command(command, 60), 60, None, ws)
    return asyncio.run(interpret(request))


def test_fake_mv_renames_a_directory_with_what_is_under_it():
    ws = _workspace()
    assert _sh(ws, 'mv sub moved') == FakeRun(0)
    assert ws.read('moved/f') == b'f'
    assert not any(path.startswith('/workspace/sub') for path in ws.files)


def test_fake_mv_moves_into_an_existing_directory():
    ws = _workspace()
    assert _sh(ws, 'mv top sub') == FakeRun(0)
    assert ws.read('sub/top') == b't'


def test_fake_mv_moves_a_root_owned_directory_within_its_parent_only():
    ws = _workspace()
    # The parent is UID 1000's, so the name can change, but the directory's `..` cannot without write on it.
    assert _sh(ws, 'mv ro sub/ro').returncode == 1
    assert _sh(ws, 'mv ro aside') == FakeRun(0)
    assert ws.files['/workspace/aside'].uid == 0


@pytest.mark.parametrize(
    ('command', 'stderr'),
    [
        ('mv top', 'mv: only `mv SOURCE TARGET` is modelled'),
        ('mv missing x', "mv: cannot move 'missing' to 'x': No such file or directory"),
        ('mv top sub/f', "mv: cannot move 'top' to 'sub/f': File exists"),
        ('mv top /tmp/top', "mv: cannot move 'top' to '/tmp/top': Invalid cross-device link"),
        ('mv /etc/passwd /etc/p', "mv: cannot move '/etc/passwd' to '/etc/p': Read-only file system"),
        ('mv sub sub/inner/x', "mv: cannot move 'sub' to 'sub/inner/x': No such file or directory"),
        ('mv sub sub/x', "mv: cannot move 'sub' to 'sub/x': Invalid argument"),
        ('mv ro/r r', "mv: cannot move 'ro/r' to 'r': Permission denied"),
        ('mv top ro/t', "mv: cannot move 'top' to 'ro/t': Permission denied"),
        ('mv ro sub/ro', "mv: cannot move 'ro' to 'sub/ro': Permission denied"),
    ],
)
def test_fake_mv_fails_as_the_guest_does(command, stderr):
    run = _sh(_workspace(), command)
    assert (run.returncode, run.stderr.decode().strip()) == (1, stderr)


def test_fake_rm_removes_files_and_symlinks_not_what_they_point_to():
    ws = _workspace()
    ws.symlink('sub/f', 'link')
    assert _sh(ws, 'rm top link') == FakeRun(0)
    assert '/workspace/top' not in ws.files and '/workspace/link' not in ws.files
    assert ws.read('sub/f') == b'f'


@pytest.mark.parametrize(
    ('command', 'stderr'),
    [
        ('rm', 'rm: missing operand'),
        ('rm missing', "rm: cannot remove 'missing': No such file or directory"),
        ('rm sub', "rm: cannot remove 'sub': Is a directory"),
        ('rm /etc/passwd', "rm: cannot remove '/etc/passwd': Read-only file system"),
        ('rm ro/r', "rm: cannot remove 'ro/r': Permission denied"),
    ],
)
def test_fake_rm_fails_as_the_guest_does(command, stderr):
    run = _sh(_workspace(), command)
    assert (run.returncode, run.stderr.decode().strip()) == (1, stderr)


def test_fake_unlink_and_rename_raise_the_guest_errors():
    ws = _workspace()
    with pytest.raises(PermissionError):
        ws.unlink('ro/r')
    with pytest.raises(OSError) as raised:
        ws.rename('top', '/tmp/top')
    assert raised.value.errno == errno.EXDEV


def test_fake_rmdir_removes_an_empty_directory():
    ws = _workspace()
    assert _sh(ws, 'rmdir gone') == FakeRun(0)
    assert '/workspace/gone' not in ws.files


@pytest.mark.parametrize(
    ('command', 'stderr'),
    [
        ('rmdir', 'rmdir: missing operand'),
        ('rmdir missing', "rmdir: failed to remove 'missing': No such file or directory"),
        ('rmdir top', "rmdir: failed to remove 'top': Not a directory"),
        ('rmdir /etc', "rmdir: failed to remove '/etc': Read-only file system"),
        ('rmdir sub', "rmdir: failed to remove 'sub': Directory not empty"),
        ('rmdir ro/empty', "rmdir: failed to remove 'ro/empty': Permission denied"),
        ('rmdir up', "rmdir: failed to remove 'up': Device or resource busy"),
        ('rmdir up/inner', "rmdir: failed to remove 'up/inner': Read-only file system"),
    ],
)
def test_fake_rmdir_fails_as_the_guest_does(command, stderr):
    ws = _workspace()
    ws.mounts = {
        '/workspace/up': {
            '/workspace/up': FakeFile(content=None, uid=1000, mode=0o755),
            '/workspace/up/inner': FakeFile(content=None, uid=1000, mode=0o755),
        }
    }
    run = _sh(ws, command)
    assert (run.returncode, run.stderr.decode().strip()) == (1, stderr)
