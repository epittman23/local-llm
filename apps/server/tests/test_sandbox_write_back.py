"""Writing a saved version back into the sandbox workspace (canvas Phase 4 (d), package 1).

POST /api/v1/sandbox/outputs/{id}/write-back writes the stored content of an
output's root or version over the output's own path in the chat's sandbox,
through workspace.write. These tests run the route function and the `bash`
tool against a FakeBackend, a real SQLite database and the local upload
directory, as test_sandbox_outputs.py does.

Run from apps/server:

    python -m pytest tests/test_sandbox_write_back.py
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import io
import json
import uuid
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from pydantic import ValidationError

from local_llm.models.chats import ChatForm, Chats
from local_llm.models.files import FileForm, Files
from local_llm.models.users import Users
from local_llm.routers import files as files_router
from local_llm.routers import sandbox as sandbox_router
from local_llm.sandbox.fake import FakeBackend, FakeFile
from local_llm.sandbox.manager import SandboxManager, SandboxSettings
from local_llm.sandbox.outputs import OUTPUTS_DIR, SANDBOX_OUTPUT, WRITE_BACK_MAX_BYTES
from local_llm.sandbox.workspaces import MemoryWorkspaces
from local_llm.storage.provider import Storage
from local_llm.tools import builtin

# Importing the config runs the migrations on the test run's database.
importlib.import_module('local_llm.config')

PAGE = f'{OUTPUTS_DIR}/page.html'


class _Chat:
    """A ChatLookup: every chat is usable unless `usable_chat` is False."""

    def __init__(self, usable_chat: bool = True) -> None:
        self.usable_chat = usable_chat

    async def usable(self, chat_id, user):
        return self.usable_chat

    async def updated_at(self, chat_ids):
        return {}


async def _settings() -> SandboxSettings:
    return SandboxSettings()


class Rig:
    """A manager on a FakeBackend, an owner, a saved chat, and the owner's `bash` tool."""

    def __init__(self) -> None:
        self.backend = FakeBackend()
        self.app = FastAPI()
        self.app.state.redis = None
        self.app.include_router(files_router.router, prefix='/api/v1/files')
        self.app.include_router(sandbox_router.router, prefix='/api/v1/sandbox')
        self.restart()
        tag = uuid.uuid4().hex[:8]
        self.owner = asyncio.run(
            Users.insert_new_user(f'wb-o-{tag}', 'Owner', f'wb-o-{tag}@example.invalid', role='user')
        )
        self.other = asyncio.run(
            Users.insert_new_user(f'wb-x-{tag}', 'Other', f'wb-x-{tag}@example.invalid', role='user')
        )
        self.admin = asyncio.run(
            Users.insert_new_user(f'wb-a-{tag}', 'Admin', f'wb-a-{tag}@example.invalid', role='admin')
        )
        self.chat_id = str(uuid.uuid4())
        history = {'messages': {'m1': {'id': 'm1', 'role': 'assistant', 'files': []}}}
        asyncio.run(
            Chats.insert_new_chat(self.chat_id, self.owner.id, ChatForm(chat={'title': 'W', 'history': history}))
        )

    def restart(self, chats: _Chat | None = None) -> None:
        """A new manager over the same backend: what the old one remembered (outputs, listings) is gone."""
        self.app.state.sandbox = SandboxManager(
            self.backend, workspaces=MemoryWorkspaces(), chats=chats or _Chat(), settings=_settings
        )

    @property
    def manager(self) -> SandboxManager:
        return self.app.state.sandbox

    async def bash(self, command: str) -> dict:
        out = await builtin.bash(
            command=command,
            __request__=SimpleNamespace(app=self.app, state=SimpleNamespace()),
            __user__={'id': self.owner.id},
            __chat_id__=self.chat_id,
            __message_id__='m1',
            __event_emitter__=None,
        )
        return json.loads(out)

    async def output(self, content: str = 'v1') -> object:
        """The model writes outputs/page.html; the File row `bash` stored for it."""
        await self.bash('mkdir outputs')
        written = await self.bash(f"printf '{content}' > outputs/page.html")
        (item,) = written['outputs']
        row = await Files.get_file_by_id(item['file_id'])
        assert row is not None
        return row

    def guest(self, path: str = PAGE) -> bytes | None:
        entry = self.backend.sandboxes[self.chat_id].files.get(path)
        return None if entry is None else entry.content

    async def write_back(self, file_id: str, *, user=None, force: bool = False, **extra) -> tuple[int, dict]:
        """The route's status and JSON body (an HTTPException's status and detail)."""
        request = SimpleNamespace(app=self.app)
        try:
            result = await sandbox_router.write_back_sandbox_output(
                request, file_id, sandbox_router.WriteBackForm(force=force, **extra), user=user or self.owner, db=None
            )
        except HTTPException as exc:
            return exc.status_code, {'detail': exc.detail}
        if isinstance(result, dict):
            return 200, result
        return result.status_code, json.loads(result.body)


async def _store(owner, data: bytes, name: str, content_type: str, meta: dict) -> object:
    file_id = str(uuid.uuid4())
    _, path = Storage.upload_file(io.BytesIO(data), f'{file_id}_{name}', {})
    file_meta = {
        'name': name,
        'content_type': content_type,
        'size': len(data),
        'file_hash': hashlib.sha256(data).hexdigest(),
        **meta,
    }
    row = await Files.insert_new_file(owner.id, FileForm(id=file_id, filename=name, path=path, meta=file_meta))
    assert row is not None
    return row


async def _version(root, data: bytes, number: int = 2) -> object:
    """A saved version as POST /files/{id}/versions makes it."""
    meta = {
        'version_of': root.id,
        'version': number,
        'source': SANDBOX_OUTPUT,
        'chat_id': root.meta['chat_id'],
    }
    return await _store(SimpleNamespace(id=root.user_id), data, 'page.html', 'text/html', meta)


def test_the_owner_writes_back_a_version_and_the_guest_holds_its_exact_bytes():
    rig = Rig()

    async def go():
        root = await rig.output('v1')
        version = await _version(root, 'second é\n'.encode())
        return await rig.write_back(version.id), root, version

    (status, body), root, version = asyncio.run(go())

    assert status == 200
    assert body == {'path': 'outputs/page.html', 'bytes': len('second é\n'.encode())}
    assert rig.guest() == 'second é\n'.encode()
    assert rig.backend.sandboxes[rig.chat_id].files[PAGE].uid == 1000


def test_the_body_takes_no_path_or_content_and_the_bytes_are_the_stored_versions():
    rig = Rig()

    async def go():
        root = await rig.output('v1')
        version = await _version(root, b'stored')
        with pytest.raises(ValidationError):
            sandbox_router.WriteBackForm(**{'force': False, 'path': '/etc/passwd', 'content': 'evil'})
        return await rig.write_back(version.id)

    status, _ = asyncio.run(go())

    assert status == 200
    assert rig.guest() == b'stored'
    assert rig.guest('/etc/passwd') is None


def test_a_non_owner_an_admin_and_a_grantee_get_404_and_the_guest_is_untouched(monkeypatch):
    rig = Rig()

    async def allowed(*_a, **_k):
        return True

    monkeypatch.setattr(sandbox_router, 'has_access_to_file', allowed, raising=False)

    async def go():
        root = await rig.output('v1')
        version = await _version(root, b'edit')
        return [(await rig.write_back(version.id, user=user))[0] for user in (rig.other, rig.admin)]

    codes = asyncio.run(go())

    assert codes == [404, 404]
    assert rig.guest() == b'v1'


def test_an_unknown_id_and_a_missing_sandbox_manager():
    rig = Rig()
    assert asyncio.run(rig.write_back(str(uuid.uuid4())))[0] == 404
    rig.app.state.sandbox = None
    status, body = asyncio.run(rig.write_back(str(uuid.uuid4())))
    assert status == 503 and body['detail'] == 'The sandbox is not running'


@pytest.mark.parametrize(
    ('name', 'content_type', 'meta', 'status'),
    [
        ('up.txt', 'text/plain', {}, 404),
        ('o.txt', 'text/plain', {'source': SANDBOX_OUTPUT, 'chat_id': 'CHAT'}, 404),
        ('o.txt', 'text/plain', {'source': SANDBOX_OUTPUT, 'chat_id': 'CHAT', 'sandbox_path': '/etc/passwd'}, 404),
        ('o.txt', 'text/plain', {'source': SANDBOX_OUTPUT, 'chat_id': 'CHAT', 'sandbox_path': PAGE + '/../x'}, 404),
        ('o.txt', 'text/plain', {'source': SANDBOX_OUTPUT, 'chat_id': 'local:abc', 'sandbox_path': PAGE}, 404),
        ('o.png', 'image/png', {'source': SANDBOX_OUTPUT, 'chat_id': 'CHAT', 'sandbox_path': PAGE}, 400),
        ('o.pdf', 'application/pdf', {'source': SANDBOX_OUTPUT, 'chat_id': 'CHAT', 'sandbox_path': PAGE}, 400),
    ],
)
def test_an_upload_an_output_without_a_path_a_temporary_chat_and_binaries_are_refused(name, content_type, meta, status):
    rig = Rig()
    meta = {k: (rig.chat_id if v == 'CHAT' else v) for k, v in meta.items()}

    async def go():
        row = await _store(rig.owner, b'%PDF-1.4 text\n', name, content_type, meta)
        return await rig.write_back(row.id)

    assert asyncio.run(go())[0] == status
    assert rig.backend.sandboxes == {}


def test_a_changed_workspace_file_needs_force_and_a_missing_one_is_created_with_it():
    rig = Rig()

    async def go():
        root = await rig.output('v1')
        version = await _version(root, b'edit')
        # The model's write_file replaced it; no `bash` call has attached the new content yet.
        rig.backend.sandboxes[rig.chat_id].files[PAGE].content = b'model newer'
        refused = await rig.write_back(version.id)
        kept = rig.guest()
        forced = await rig.write_back(version.id, force=True)
        again = await rig.write_back(version.id)
        del rig.backend.sandboxes[rig.chat_id].files[PAGE]
        gone = await rig.write_back(version.id)
        created = await rig.write_back(version.id, force=True)
        return refused, kept, forced, again, gone, created

    refused, kept, forced, again, gone, created = asyncio.run(go())

    assert refused == (
        409,
        {
            'code': 'changed',
            'missing': False,
            'detail': 'The file in the workspace changed after this version. Replace it anyway?',
        },
    )
    assert kept == b'model newer'
    assert forced[0] == 200
    assert again[0] == 200  # the file is what this output last held: the version just written
    assert gone[0] == 409 and gone[1]['code'] == 'changed' and gone[1]['missing'] is True
    assert created[0] == 200 and rig.guest() == b'edit'


def test_a_busy_workspace_is_409_within_the_wait(monkeypatch):
    rig = Rig()
    monkeypatch.setattr(sandbox_router, 'WRITE_BACK_WAIT_S', 0.2)

    async def go():
        root = await rig.output('v1')
        version = await _version(root, b'edit')
        async with rig.manager.session(rig.chat_id, rig.owner):
            return await rig.write_back(version.id)

    status, body = asyncio.run(go())

    assert (status, body['code']) == (409, 'busy')
    assert body['detail'] == 'The workspace is busy. Try again when the reply has finished.'
    assert rig.guest() == b'v1'


def _symlink(rig):
    rig.backend.sandboxes[rig.chat_id].files[PAGE] = FakeFile(content=None, uid=1000, mode=0o777, link='/etc/passwd')


def _directory(rig):
    rig.backend.sandboxes[rig.chat_id].files[PAGE] = FakeFile(content=None, uid=1000, mode=0o755)


def _read_only(rig):
    rig.backend.sandboxes[rig.chat_id].files[PAGE] = FakeFile(content=b'v1', uid=0, mode=0o444)


@pytest.mark.parametrize('damage', [_symlink, _directory, _read_only])
def test_a_symlink_a_directory_and_a_read_only_file_are_503_without_internals(damage):
    rig = Rig()

    async def go():
        root = await rig.output('v1')
        version = await _version(root, b'edit')
        damage(rig)
        return await rig.write_back(version.id, force=True)

    status, body = asyncio.run(go())

    assert status == 503
    assert body['detail'] == 'The file could not be written to the workspace'
    assert rig.guest('/etc/passwd') != b'edit'


def test_a_sandbox_that_cannot_start_is_503_and_a_refused_chat_is_404():
    rig = Rig()
    meta = {'source': SANDBOX_OUTPUT, 'chat_id': rig.chat_id, 'sandbox_path': PAGE}
    row = asyncio.run(_store(rig.owner, b'edit', 'page.html', 'text/html', meta))

    rig.backend.ready_reason = 'no runtime here: /var/run/secret.sock'
    status, body = asyncio.run(rig.write_back(row.id))
    assert status == 503
    assert 'secret' not in json.dumps(body)

    rig.restart(_Chat(usable_chat=False))
    assert asyncio.run(rig.write_back(row.id))[0] == 404


def test_the_next_bash_listing_does_not_attach_the_written_file_again():
    rig = Rig()

    async def go():
        root = await rig.output('v1')
        version = await _version(root, b'v2')
        await rig.write_back(version.id)
        listing = await rig.bash('printf hi')
        touched = await rig.bash("printf 'v2' > outputs/page.html")
        return root, version, listing, touched

    root, version, listing, touched = asyncio.run(go())
    rows = asyncio.run(Files.get_versions(root.id))

    assert all('file_id' not in item for item in listing['outputs'])
    (item,) = touched['outputs']
    assert 'file_id' not in item and 'same' in item['reason']
    assert [r.id for r in rows] == [version.id]
    marked = asyncio.run(Files.get_file_by_id(version.id))
    assert marked.meta['sandbox_path'] == PAGE and isinstance(marked.meta['written_back_ns'], int)


def test_after_a_restart_the_database_row_keeps_the_dedupe_and_the_precondition():
    rig = Rig()

    async def go():
        root = await rig.output('v1')
        v2 = await _version(root, b'v2')
        v3 = await _version(root, b'v3', 3)
        await rig.write_back(v2.id)
        rig.restart()
        again = await rig.bash("printf 'v2' > outputs/page.html")
        rig.restart()
        precondition = await rig.write_back(v3.id)
        return again, precondition

    again, precondition = asyncio.run(go())

    assert 'file_id' not in again['outputs'][0] and 'same' in again['outputs'][0]['reason']
    assert precondition[0] == 200
    assert rig.guest() == b'v3'


def test_when_the_row_could_not_be_marked_a_restart_costs_one_duplicate_attach(monkeypatch):
    rig = Rig()

    async def fail(*_a, **_k):
        raise RuntimeError('database down')

    async def go():
        root = await rig.output('v1')
        version = await _version(root, b'v2')
        monkeypatch.setattr(sandbox_router.Files, 'update_file_metadata_by_id', fail)
        written = await rig.write_back(version.id)
        monkeypatch.undo()
        rig.restart()
        first = await rig.bash("printf 'v2' > outputs/page.html")
        second = await rig.bash("printf 'v2 ' > outputs/page.html")
        return written, first, second

    written, first, second = asyncio.run(go())

    assert written[0] == 200
    assert first['outputs'][0].get('file_id')  # the one accepted duplicate: the database knew only the model's v1
    assert second['outputs'][0].get('file_id')  # new bytes, a genuine new output


def test_more_than_256_kib_and_non_utf8_bytes_are_refused():
    rig = Rig()

    async def go():
        root = await rig.output('v1')
        big = await _version(root, b'a' * (WRITE_BACK_MAX_BYTES + 1))
        latin = await _version(root, b'caf\xe9', 3)
        nul = await _version(root, b'a\0b', 4)
        exact = await _version(root, b'b' * WRITE_BACK_MAX_BYTES, 5)
        return [(await rig.write_back(v.id))[0] for v in (big, latin, nul, exact)]

    assert asyncio.run(go()) == [413, 400, 400, 200]


def test_an_older_version_can_be_written_back_to_revert_the_workspace():
    rig = Rig()

    async def go():
        root = await rig.output('v1')
        v2 = await _version(root, b'two')
        await _version(root, b'three', 3)
        first = await rig.write_back(v2.id)
        root_back = await rig.write_back(root.id)
        return first, root_back

    first, root_back = asyncio.run(go())

    assert first[0] == 200
    assert root_back[0] == 200
    assert rig.guest() == b'v1'


def test_a_newer_model_rewrite_that_bash_attached_is_still_a_change():
    rig = Rig()

    async def go():
        root = await rig.output('v1')
        version = await _version(root, b'edit')
        await rig.bash("printf 'model newer' > outputs/page.html")  # attached as another output row
        refused = await rig.write_back(version.id)
        kept = rig.guest()
        forced = await rig.write_back(version.id, force=True)
        return refused, kept, forced

    refused, kept, forced = asyncio.run(go())

    assert (refused[0], refused[1]['code']) == (409, 'changed')
    assert kept == b'model newer'
    assert forced[0] == 200 and rig.guest() == b'edit'


def test_a_file_equal_to_an_earlier_version_or_the_root_is_not_a_change():
    rig = Rig()

    async def go():
        root = await rig.output('v1')
        v2 = await _version(root, b'two')
        v3 = await _version(root, b'three', 3)
        from_root = await rig.write_back(v2.id)  # the workspace holds the root's bytes
        from_v2 = await rig.write_back(v3.id)  # now it holds version 2's
        return from_root, from_v2

    from_root, from_v2 = asyncio.run(go())

    assert (from_root[0], from_v2[0]) == (200, 200)
    assert rig.guest() == b'three'


def test_a_stored_version_whose_blob_is_gone_is_404():
    rig = Rig()

    async def go():
        root = await rig.output('v1')
        version = await _version(root, b'edit')
        Storage.delete_file(version.path)
        return await rig.write_back(version.id)

    assert asyncio.run(go())[0] == 404
    assert rig.guest() == b'v1'
