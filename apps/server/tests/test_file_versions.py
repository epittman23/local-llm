"""Saving an edited file as a new version (canvas Phase 3, C14).

POST /files/{id}/versions stores the text as its own file row
(`meta.version_of` is the root, `meta.version` counts from 2), owned by the
root's owner, linked to the root's chats and processed so the model can read
it when attached. GET /files/{id}/versions lists the root and its edits.
Deleting the root deletes them.

Runs against the suite's temporary SQLite database and upload directory, with
the vector store, embedding settings and events replaced by stubs.

Run from apps/server:

    python -m pytest tests/test_file_versions.py
"""

import asyncio
import errno
import io
import os
import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.config import UPLOAD_DIR
from local_llm.models.chats import Chats
from local_llm.models.files import FileForm, Files
from local_llm.models.users import Users
from local_llm.routers import files as files_router
from local_llm.routers import retrieval as retrieval_router
from local_llm.sandbox.outputs import SANDBOX_OUTPUT
from local_llm.storage.provider import Storage


class Vectors:
    async def delete_collection(self, collection_name):
        return None

    async def delete(self, collection_name, ids=None, filter=None):
        return None


async def _nothing(*_a, **_k):
    return None


@pytest.fixture
def stubs(monkeypatch):
    async def bypass():
        return SimpleNamespace(BYPASS_EMBEDDING_AND_RETRIEVAL=True)

    for module in (retrieval_router, files_router):
        monkeypatch.setattr(module, 'ASYNC_VECTOR_DB_CLIENT', Vectors(), raising=False)
        monkeypatch.setattr(module, 'publish_event', _nothing, raising=False)
    monkeypatch.setattr(retrieval_router, 'get_retrieval_config', bypass)

    async def no_grant(*_a, **_k):
        return False

    monkeypatch.setattr(files_router, 'has_access_to_file', no_grant)
    monkeypatch.setattr(retrieval_router, 'has_access_to_file', no_grant)


def _grant(monkeypatch, *allowed: str):
    async def has_access(file_id, access_type, user, db=None, **_k):
        return access_type in allowed

    monkeypatch.setattr(files_router, 'has_access_to_file', has_access)
    monkeypatch.setattr(retrieval_router, 'has_access_to_file', has_access)


async def _user(role='user'):
    tag = uuid.uuid4().hex[:8]
    return await Users.insert_new_user(f'u{tag}', f'User {tag}', f'u{tag}@example.invalid', role=role)


async def _root(owner, data=b'first\n', name='notes.txt', content_type='text/plain', meta=None):
    file_id = str(uuid.uuid4())
    _, path = Storage.upload_file(io.BytesIO(data), f'{file_id}_{name}', {})
    return await Files.insert_new_file(
        owner.id,
        FileForm(
            id=file_id,
            filename=name,
            path=path,
            meta={'name': name, 'content_type': content_type, 'size': len(data), **(meta or {})},
        ),
    )


def _save(user, file_id, content):
    return files_router.create_file_version(
        None, file_id, files_router.VersionForm(content=content), user=user, db=None
    )


def _bytes(file):
    with open(Storage.get_file(file.path), 'rb') as f:
        return f.read()


def _stored_count():
    return len(os.listdir(UPLOAD_DIR))


def _rows_of(root_id):
    return Files.get_versions(root_id)


def test_the_owner_saves_version_two(stubs):
    async def scenario():
        owner = await _user()
        root = await _root(owner)
        new = await _save(owner, root.id, 'second\n')
        return owner, root, new, _bytes(new), await _rows_of(root.id)

    owner, root, new, stored, rows = asyncio.run(scenario())

    assert new.meta['version_of'] == root.id
    assert new.meta['version'] == 2
    assert new.meta['edited_by'] == owner.id
    assert new.meta['size'] == len(b'second\n')
    assert new.filename == root.filename
    assert new.user_id == owner.id
    assert new.id != root.id
    assert stored == b'second\n'
    assert [r.id for r in rows] == [new.id]


def test_a_version_of_a_version_belongs_to_the_root(stubs):
    async def scenario():
        owner = await _user()
        root = await _root(owner)
        v2 = await _save(owner, root.id, 'two')
        v3 = await _save(owner, v2.id, 'three')
        listing = await files_router.list_file_versions(v3.id, user=owner, db=None)
        return root, v2, v3, listing

    root, v2, v3, listing = asyncio.run(scenario())

    assert v3.meta['version_of'] == root.id
    assert v3.meta['version'] == 3
    assert [(e.id, e.version) for e in listing] == [(root.id, 1), (v2.id, 2), (v3.id, 3)]
    assert {e.name for e in listing} == {'notes.txt'}


def test_a_stranger_gets_404_and_nothing_is_written(stubs):
    async def scenario():
        owner, stranger = await _user(), await _user()
        root = await _root(owner)
        before = _stored_count()
        with pytest.raises(HTTPException) as refused:
            await _save(stranger, root.id, 'mine')
        return refused.value.status_code, await _rows_of(root.id), _stored_count() - before

    code, rows, written = asyncio.run(scenario())

    assert (code, rows, written) == (404, [], 0)


def test_an_admin_saves_and_the_version_is_the_owners(stubs):
    async def scenario():
        owner, admin = await _user(), await _user('admin')
        root = await _root(owner)
        return owner, admin, await _save(admin, root.id, 'by admin')

    owner, admin, new = asyncio.run(scenario())

    assert new.user_id == owner.id
    assert new.meta['edited_by'] == admin.id


def test_a_write_grantee_saves_and_a_reader_does_not(monkeypatch, stubs):
    async def scenario():
        owner, other = await _user(), await _user()
        root = await _root(owner)
        _grant(monkeypatch, 'read', 'write')
        saved = await _save(other, root.id, 'granted')
        _grant(monkeypatch, 'read')
        with pytest.raises(HTTPException) as refused:
            await _save(other, root.id, 'read only')
        return owner, saved, refused.value.status_code, await _rows_of(root.id)

    owner, saved, code, rows = asyncio.run(scenario())

    assert saved.user_id == owner.id
    assert code == 404
    assert [r.id for r in rows] == [saved.id]


@pytest.mark.parametrize(
    'data,name,content_type',
    [
        (b'\x89PNG\r\n\x1a\n\x00\x00\x00', 'pic.png', 'image/png'),
        (b'%PDF-1.7\n\x00\x01\x02', 'doc.pdf', 'application/pdf'),
    ],
)
def test_a_binary_root_is_refused(stubs, data, name, content_type):
    async def scenario():
        owner = await _user()
        root = await _root(owner, data=data, name=name, content_type=content_type)
        before = _stored_count()
        with pytest.raises(HTTPException) as refused:
            await _save(owner, root.id, 'text')
        return refused.value.status_code, await _rows_of(root.id), _stored_count() - before

    assert asyncio.run(scenario()) == (400, [], 0)


def test_the_size_limit_is_256_kib(stubs):
    limit = 256 * 1024

    async def scenario():
        owner = await _user()
        root = await _root(owner)
        before = _stored_count()
        with pytest.raises(HTTPException) as refused:
            await _save(owner, root.id, 'a' * (limit + 1))
        refused_state = (refused.value.status_code, await _rows_of(root.id), _stored_count() - before)
        ok = await _save(owner, root.id, 'a' * limit)
        return refused_state, ok

    refused_state, ok = asyncio.run(scenario())

    assert refused_state == (413, [], 0)
    assert ok.meta['size'] == limit


def test_multibyte_text_counts_in_bytes(stubs):
    async def scenario():
        owner = await _user()
        root = await _root(owner)
        with pytest.raises(HTTPException) as refused:
            await _save(owner, root.id, 'é' * (128 * 1024 + 1))
        return refused.value.status_code

    assert asyncio.run(scenario()) == 413


def test_empty_content_is_refused_without_a_row(stubs):
    async def scenario():
        owner = await _user()
        root = await _root(owner)
        with pytest.raises(HTTPException) as refused:
            await _save(owner, root.id, '')
        return refused.value.status_code, await _rows_of(root.id)

    assert asyncio.run(scenario()) == (400, [])


def test_an_unknown_id_is_404(stubs):
    async def scenario():
        owner = await _user()
        with pytest.raises(HTTPException) as refused:
            await _save(owner, str(uuid.uuid4()), 'x')
        with pytest.raises(HTTPException) as listed:
            await files_router.list_file_versions(str(uuid.uuid4()), user=owner, db=None)
        return refused.value.status_code, listed.value.status_code

    assert asyncio.run(scenario()) == (404, 404)


def test_the_version_is_linked_to_the_roots_chat_and_message(stubs):
    async def scenario():
        owner = await _user()
        linked = await _root(owner)
        unlinked = await _root(owner)
        chat_id, message_id = str(uuid.uuid4()), str(uuid.uuid4())
        await Chats.insert_chat_files(chat_id, message_id, [linked.id], owner.id)
        v_linked = await _save(owner, linked.id, 'in a chat')
        v_unlinked = await _save(owner, unlinked.id, 'in no chat')
        return (
            chat_id,
            message_id,
            v_linked,
            await Chats.get_chat_files_by_file_id(v_linked.id),
            await Chats.get_chat_files_by_file_id(v_unlinked.id),
        )

    chat_id, message_id, v_linked, links, no_links = asyncio.run(scenario())

    assert [(c.chat_id, c.message_id, c.user_id) for c in links] == [(chat_id, message_id, v_linked.user_id)]
    assert no_links == []


def test_a_version_of_a_sandbox_output_stays_a_download(stubs):
    async def scenario():
        owner = await _user()
        root = await _root(
            owner,
            name='out.html',
            content_type='text/html',
            meta={'source': SANDBOX_OUTPUT, 'chat_id': 'chat-1', 'sandbox_path': '/x', 'preview_of': 'p'},
        )
        new = await _save(owner, root.id, '<script>1</script>')
        response = await files_router.get_file_content_by_id(new.id, user=owner, attachment=False, db=None)
        return new, response

    new, response = asyncio.run(scenario())

    assert new.meta['source'] == SANDBOX_OUTPUT
    assert new.meta['chat_id'] == 'chat-1'
    assert 'sandbox_path' not in new.meta and 'preview_of' not in new.meta
    assert response.headers['content-disposition'].startswith('attachment')
    assert response.headers['x-content-type-options'] == 'nosniff'


def test_listing_versions_is_for_readers_only_and_a_lone_file_lists_itself(stubs):
    async def scenario():
        owner, stranger = await _user(), await _user()
        root = await _root(owner)
        with pytest.raises(HTTPException) as refused:
            await files_router.list_file_versions(root.id, user=stranger, db=None)
        return root, refused.value.status_code, await files_router.list_file_versions(root.id, user=owner, db=None)

    root, code, listing = asyncio.run(scenario())

    assert code == 404
    assert [(e.id, e.version, e.size) for e in listing] == [(root.id, 1, len(b'first\n'))]


def test_a_processed_version_carries_its_text(stubs):
    async def scenario():
        owner = await _user()
        root = await _root(owner)
        new = await _save(owner, root.id, 'for the model')
        return (await Files.get_file_by_id(new.id)).data

    data = asyncio.run(scenario())

    assert data['content'] == 'for the model'
    assert data.get('status') != 'failed'


def test_a_processing_failure_still_saves(monkeypatch, stubs):
    async def broken(*_a, **_k):
        raise RuntimeError('embedding model offline')

    monkeypatch.setattr(files_router, 'process_file', broken)

    async def scenario():
        owner = await _user()
        root = await _root(owner)
        new = await _save(owner, root.id, 'kept anyway')
        return new, await Files.get_file_by_id(new.id)

    new, row = asyncio.run(scenario())

    assert row.data['status'] == 'failed'
    assert _bytes(new) == b'kept anyway'


def test_text_round_trips_byte_exact(stubs):
    text = 'café 中文 \U0001f600\r\nline two\r\n\n'

    async def scenario():
        owner = await _user()
        root = await _root(owner)
        return _bytes(await _save(owner, root.id, text))

    assert asyncio.run(scenario()) == text.encode('utf-8')


def test_deleting_the_root_deletes_its_versions_and_a_version_goes_alone(stubs):
    async def scenario():
        owner = await _user()
        root = await _root(owner)
        v2 = await _save(owner, root.id, 'two')
        v3 = await _save(owner, root.id, 'three')
        await files_router.delete_file_by_id(None, v3.id, user=owner, db=None)
        after_version = [r.id for r in await _rows_of(root.id)], await Files.get_file_by_id(root.id)
        v2_path = v2.path
        await files_router.delete_file_by_id(None, root.id, user=owner, db=None)
        return after_version, v2_path, await Files.get_file_by_id(v2.id), await Files.get_file_by_id(root.id)

    (remaining, root_row), v2_path, v2_row, root_row_after = asyncio.run(scenario())

    assert remaining == [remaining[0]] and root_row is not None
    assert v2_row is None and root_row_after is None
    assert not os.path.exists(v2_path)


def test_a_name_too_long_for_the_filesystem_falls_back_to_the_id(monkeypatch, stubs):
    real = Storage.upload_file
    names = []

    def upload(fileobj, filename, tags):
        names.append(filename)
        if len(names) == 1:
            raise OSError(errno.ENAMETOOLONG, 'File name too long')
        return real(fileobj, filename, tags)

    async def scenario():
        owner = await _user()
        root = await _root(owner)
        monkeypatch.setattr(files_router.Storage, 'upload_file', upload)
        return await _save(owner, root.id, 'short name')

    new = asyncio.run(scenario())

    assert names[1].startswith(new.id) and names[1].endswith('.txt')
    assert _bytes(new) == b'short name'


@pytest.mark.parametrize('errnos', [[errno.ENOSPC], [errno.ENAMETOOLONG, errno.ENOSPC]])
def test_a_storage_error_is_a_400_without_a_row(monkeypatch, stubs, errnos):
    calls = []

    def upload(fileobj, filename, tags):
        calls.append(filename)
        raise OSError(errnos[min(len(calls), len(errnos)) - 1], 'disk trouble')

    async def scenario():
        owner = await _user()
        root = await _root(owner)
        monkeypatch.setattr(files_router.Storage, 'upload_file', upload)
        with pytest.raises(HTTPException) as refused:
            await _save(owner, root.id, 'x')
        return refused.value.status_code, await _rows_of(root.id)

    assert asyncio.run(scenario()) == (400, [])


def test_a_failed_insert_removes_the_stored_bytes(monkeypatch, stubs):
    deleted = []

    async def no_insert(*_a, **_k):
        return None

    async def scenario():
        owner = await _user()
        root = await _root(owner)
        monkeypatch.setattr(files_router.Files, 'insert_new_file', no_insert)
        monkeypatch.setattr(files_router.Storage, 'delete_file', deleted.append)
        with pytest.raises(HTTPException) as refused:
            await _save(owner, root.id, 'x')
        return refused.value.status_code

    assert asyncio.run(scenario()) == 400
    assert len(deleted) == 1


def test_a_failed_chat_link_does_not_fail_the_save(monkeypatch, stubs):
    async def broken(*_a, **_k):
        raise RuntimeError('database busy')

    async def scenario():
        owner = await _user()
        root = await _root(owner)
        monkeypatch.setattr(files_router.Chats, 'get_chat_files_by_file_id', broken)
        return await _save(owner, root.id, 'saved anyway')

    assert asyncio.run(scenario()).meta['version'] == 2


def test_one_failed_chat_link_does_not_drop_the_others(monkeypatch, stubs):
    async def scenario():
        owner = await _user()
        root = await _root(owner)
        first, second = str(uuid.uuid4()), str(uuid.uuid4())
        message_id = str(uuid.uuid4())
        await Chats.insert_chat_files(first, message_id, [root.id], owner.id)
        await Chats.insert_chat_files(second, message_id, [root.id], owner.id)
        real = Chats.insert_chat_files
        calls = []

        async def flaky(chat_id, *args, **kwargs):
            calls.append(chat_id)
            if len(calls) == 1:
                raise RuntimeError('database busy')
            return await real(chat_id, *args, **kwargs)

        monkeypatch.setattr(files_router.Chats, 'insert_chat_files', flaky)
        saved = await _save(owner, root.id, 'saved anyway')
        links = await Chats.get_chat_files_by_file_id(saved.id)
        return calls, [c.chat_id for c in links]

    calls, linked = asyncio.run(scenario())

    assert len(calls) == 2
    assert linked == [calls[1]]


def test_an_orphaned_version_has_no_root_to_edit_or_list(stubs):
    async def scenario():
        owner = await _user()
        root = await _root(owner)
        v2 = await _save(owner, root.id, 'two')
        await Files.delete_file_by_id(root.id)
        with pytest.raises(HTTPException) as saved:
            await _save(owner, v2.id, 'three')
        with pytest.raises(HTTPException) as listed:
            await files_router.list_file_versions(v2.id, user=owner, db=None)
        return saved.value.status_code, listed.value.status_code

    assert asyncio.run(scenario()) == (404, 404)


def test_a_version_the_storage_cannot_delete_does_not_stop_the_root_deleting(monkeypatch, stubs):
    async def scenario():
        owner = await _user()
        root = await _root(owner)
        v2 = await _save(owner, root.id, 'two')
        real = Storage.delete_file

        def delete(path):
            if path == v2.path:
                raise OSError('gone already')
            real(path)

        monkeypatch.setattr(files_router.Storage, 'delete_file', delete)
        await files_router.delete_file_by_id(None, root.id, user=owner, db=None)
        return await Files.get_file_by_id(root.id), await Files.get_file_by_id(v2.id)

    assert asyncio.run(scenario()) == (None, None)
