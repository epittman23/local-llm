"""Read-only uploads (T13's acceptance test) in a real sandbox: the Kata backend through SandboxManager and `bash`.

Skipped unless LLLM_TEST_KATA=1 (owner decision Q3), like
test_sandbox_kata.py, whose fixtures it uses and whose needs it shares
(Docker with `kata-clh`, both sandbox images, udisks2 and an active local
login session). Pins that, with an attached file synced into
/workspace/uploads:

- it is a read-only mount (`ro` in /proc/mounts) holding the file, mode 0444;
- as UID 1000, writing, appending, deleting, renaming, `chmod` on an upload
  or on the directory, truncating, creating a file or symlink beside it,
  moving or removing the directory itself and moving a file out all fail,
  and the file is unchanged;
- an unchanged set is not put again; an added attachment appears and a
  removed one goes;
- a put of the whole 200 MiB cap ends well inside limits.CANCEL_WAIT_S, the
  longest a Stop waits for it (the time is printed; run with -s to see it).

Run from apps/server (any LLLM_SECRET_KEY of 32 characters or more):

    LLLM_TEST_KATA=1 LLLM_SECRET_KEY=... uv run --frozen python -m pytest tests/test_sandbox_uploads_kata.py -v -s
"""

import asyncio
import json
import os
import time
from types import SimpleNamespace

import pytest

if os.environ.get('LLLM_TEST_KATA') != '1':
    pytest.skip('set LLLM_TEST_KATA=1 on a host with Docker and Kata (kata-clh) to run these', allow_module_level=True)

import test_sandbox_kata as kata_tests

from local_llm.models.chats import Chats
from local_llm.models.users import Users
from local_llm.sandbox import uploads
from local_llm.sandbox.kata import KataDockerBackend
from local_llm.sandbox.limits import CANCEL_WAIT_S
from local_llm.sandbox.manager import SandboxManager, SandboxSettings
from local_llm.sandbox.workspaces import MemoryWorkspaces
from local_llm.tools import builtin

USER = SimpleNamespace(id='owner', role='user')

# test_sandbox_kata.py's fixtures, taken by name: its Docker client, sandbox network, keys and backend.
client = kata_tests.client
network = kata_tests.network
keys = kata_tests.keys
backend = kata_tests.backend
Keys = kata_tests.Keys


class _Chats:
    def __init__(self, chat_id: str) -> None:
        self.chat_id = chat_id

    async def usable(self, chat_id, user):
        return chat_id == self.chat_id and user.id == USER.id

    async def updated_at(self, chat_ids):
        return {}


async def _settings() -> SandboxSettings:
    return SandboxSettings()


@pytest.fixture
def stored_files(tmp_path, monkeypatch):
    """Chat files by id, each a real file on this host; returns the function that adds one."""
    from local_llm.models.files import Files
    from local_llm.storage.provider import Storage

    files: dict = {}

    def add(file_id: str, filename: str, content: bytes) -> None:
        path = tmp_path / file_id
        path.write_bytes(content)
        files[file_id] = SimpleNamespace(id=file_id, user_id=USER.id, filename=filename, path=str(path))

    async def get_file_by_id(file_id, db=None):
        return files.get(file_id)

    async def get_user_by_id(user_id, db=None):
        return USER if user_id == USER.id else None

    async def is_chat_owner(chat_id, user_id, db=None):
        return user_id == USER.id

    monkeypatch.setattr(Files, 'get_file_by_id', get_file_by_id)
    monkeypatch.setattr(Storage, 'get_file', lambda path: path)
    monkeypatch.setattr(Users, 'get_user_by_id', get_user_by_id)
    monkeypatch.setattr(Chats, 'is_chat_owner', is_chat_owner)
    return add


def _items(*ids: str) -> list[dict]:
    return [{'type': 'file', 'id': i, 'name': i} for i in ids]


def test_uploads_are_a_read_only_mount_nothing_in_the_guest_can_change_or_move(
    backend: KataDockerBackend, keys: Keys, stored_files, monkeypatch
) -> None:
    chat = keys.new(backend)
    manager = SandboxManager(backend, workspaces=MemoryWorkspaces(), chats=_Chats(chat), settings=_settings)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(sandbox=manager)))
    stored_files('f1', 'a.csv', b'a,b\n1,2\n')
    stored_files('f2', 'b.csv', b'second\n')
    puts: list[list[str]] = []
    real_put = backend.put_uploads

    async def counted(chat_id, files):
        puts.append([name for name, _ in files])
        await real_put(chat_id, files)

    monkeypatch.setattr(backend, 'put_uploads', counted)

    async def bash(command: str, *ids: str) -> dict:
        out = await builtin.bash(
            command=command,
            __request__=request,
            __user__={'id': USER.id},
            __chat_id__=chat,
            __metadata__={'files': _items(*ids)},
        )
        return json.loads(out)

    async def go() -> None:
        first = await bash(
            'cat uploads/a.csv && stat -c "%a %u %n" uploads/a.csv && grep " /workspace/uploads " /proc/mounts', 'f1'
        )
        assert first['returncode'] == 0, first
        lines = first['stdout'].splitlines()
        assert lines[:2] == ['a,b', '1,2'] and lines[2].startswith('444 ') and len(lines) == 4, first
        mount = lines[3]
        assert 'ro' in mount.split()[3].split(','), mount
        print('\nsynced:', lines[2], '| mount:', mount)

        attempts = {
            'write': 'echo x > uploads/a.csv',
            'append': 'echo x >> uploads/a.csv',
            'delete': 'rm -f uploads/a.csv',
            'chmod': 'chmod 666 uploads/a.csv',
            'chmod the directory': 'chmod 777 uploads',
            'rename inside': 'mv uploads/a.csv uploads/c.csv',
            'create beside': 'touch uploads/new',
            'truncate': 'truncate -s 0 uploads/a.csv',
            'symlink beside': 'ln -s /etc uploads/etc',
            'move the directory aside': 'mv /workspace/uploads /workspace/x',
            'remove the directory': 'rmdir /workspace/uploads',
            'remove it all': 'rm -rf /workspace/uploads',
            'move it out': 'mv uploads/a.csv moved.csv',
        }
        for what, command in attempts.items():
            result = await bash(command, 'f1')
            assert result['returncode'] != 0, (what, result)
            print(f'{what}: exit {result["returncode"]}: {result["stderr"].strip()}')
        after = await bash('cat uploads/a.csv && ls -A uploads && stat -c "%a" uploads/a.csv', 'f1')
        assert after['stdout'] == 'a,b\n1,2\na.csv\n444\n', after
        assert puts == [['a.csv']], 'an unchanged set is put once'

        added = await bash('ls -A uploads && cat uploads/b.csv', 'f1', 'f2')
        assert added['stdout'] == 'a.csv\nb.csv\nsecond\n', added
        removed = await bash('ls -A uploads', 'f2')
        assert removed['stdout'] == 'b.csv\n', removed
        assert puts == [['a.csv'], ['a.csv', 'b.csv'], ['b.csv']]

        # The whole cap in one put, timed: a Stop waits for it at most CANCEL_WAIT_S.
        big = [(f'big{n}.bin', os.urandom(uploads.MAX_FILE_BYTES)) for n in range(4)]
        assert sum(len(content) for _, content in big) == uploads.MAX_TOTAL_BYTES
        async with manager.session(chat, USER) as session:
            started = time.monotonic()
            await session.put_uploads(big)
            took = time.monotonic() - started
        print(f'put_uploads of {uploads.MAX_TOTAL_BYTES // 2**20} MiB in 4 files: {took:.2f} s')
        assert took < CANCEL_WAIT_S / 3

        await manager.release(chat)

    asyncio.run(go())
