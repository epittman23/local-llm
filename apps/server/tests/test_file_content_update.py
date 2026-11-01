"""Saving a file's edited content reports what really happened (#307).

POST /files/{id}/data/content/update passes anyone the file grants write
access, but process_file looked non-admins up by owner only, so for a
knowledge base's write grantee it 404'd and nothing was saved. The route
swallowed that, and any other processing or knowledge-base failure, and
returned 200 with the old content, which the page toasted as success. Now a
processing failure is an error, and a knowledge base the new text could not
reach is named in the response for the page to warn about.
Saving empty content restored the originally extracted text instead.
And /knowledge/{id}/file/update deleted the file's chunks from the base
before re-adding them, so a failed re-add left the base without them.

Runs against the suite's temporary SQLite database (tests/conftest.py points
DATA_DIR at a temp directory; it is migrated on import), with the vector
store, embedding settings and events replaced by stubs.

Run from apps/server:

    python -m pytest tests/test_file_content_update.py
"""

import asyncio
import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.models.files import FileForm, Files
from local_llm.models.users import Users
from local_llm.routers import files as files_router
from local_llm.routers import knowledge as knowledge_router
from local_llm.routers import retrieval as retrieval_router


class Vectors:
    def __init__(self):
        self.deleted: list = []

    async def delete_collection(self, collection_name):
        self.deleted.append(collection_name)

    async def delete(self, collection_name, ids=None, filter=None):
        self.deleted.append((collection_name, ids, filter))

    async def query(self, collection_name, filter=None):
        return SimpleNamespace(ids=[['old-1', 'old-2']])


async def _nothing(*_a, **_k):
    return None


@pytest.fixture
def stubs(monkeypatch):
    vectors = Vectors()

    async def bypass():
        return SimpleNamespace(BYPASS_EMBEDDING_AND_RETRIEVAL=True)

    for module in (retrieval_router, files_router, knowledge_router):
        monkeypatch.setattr(module, 'ASYNC_VECTOR_DB_CLIENT', vectors, raising=False)
        monkeypatch.setattr(module, 'publish_event', _nothing, raising=False)
    monkeypatch.setattr(retrieval_router, 'get_retrieval_config', bypass)
    return vectors


async def _users_and_file():
    tag = uuid.uuid4().hex[:8]
    owner = await Users.insert_new_user(f'o{tag}', 'Owner', f'o{tag}@example.invalid', role='user')
    other = await Users.insert_new_user(f'g{tag}', 'Grantee', f'g{tag}@example.invalid', role='user')
    file = await Files.insert_new_file(
        owner.id, FileForm(id=str(uuid.uuid4()), filename='notes.txt', path='', data={'content': 'OLD CONTENT'})
    )
    return owner, other, file


def _grant(monkeypatch, *allowed: str):
    async def has_access(file_id, access_type, user, db=None, **_k):
        return access_type in allowed

    monkeypatch.setattr(retrieval_router, 'has_access_to_file', has_access)
    monkeypatch.setattr(files_router, 'has_access_to_file', has_access)


def test_a_write_grantee_saves_new_content(monkeypatch, stubs):
    _grant(monkeypatch, 'read', 'write')
    monkeypatch.setattr(files_router.Knowledges, 'get_knowledges_by_file_id', lambda *a, **k: _empty())

    async def scenario():
        _, grantee, file = await _users_and_file()
        out = await files_router.update_file_data_content_by_id(
            None, file.id, files_router.ContentForm(content='NEW CONTENT'), user=grantee, db=None
        )
        return out, (await Files.get_file_by_id(file.id)).data['content']

    out, stored = asyncio.run(scenario())

    assert out == {'content': 'NEW CONTENT', 'failed_knowledge': []}
    assert stored == 'NEW CONTENT'


def test_a_reader_cannot_change_a_files_content_through_process_file(monkeypatch, stubs):
    _grant(monkeypatch, 'read')

    async def scenario():
        _, reader, file = await _users_and_file()
        with pytest.raises(HTTPException) as refused:
            await retrieval_router.process_file(
                None, retrieval_router.ProcessFileForm(file_id=file.id, content='X'), user=reader, db=None
            )
        return refused.value.status_code, (await Files.get_file_by_id(file.id)).data['content']

    code, stored = asyncio.run(scenario())

    assert code == 404
    assert stored == 'OLD CONTENT'


def test_a_processing_failure_is_reported_not_toasted_as_saved(monkeypatch, stubs):
    async def fails(*_a, **_k):
        raise RuntimeError('embedding service unreachable')

    monkeypatch.setattr(files_router, 'process_file', fails)

    async def scenario():
        owner, _, file = await _users_and_file()
        with pytest.raises(HTTPException) as refused:
            await files_router.update_file_data_content_by_id(
                None, file.id, files_router.ContentForm(content='NEW'), user=owner, db=None
            )
        return refused.value

    err = asyncio.run(scenario())

    assert err.status_code == 400
    assert 'embedding service unreachable' in err.detail


def test_empty_content_is_refused_before_anything_changes(monkeypatch, stubs):
    called = []
    monkeypatch.setattr(files_router, 'process_file', lambda *a, **k: called.append(a))

    async def scenario():
        owner, _, file = await _users_and_file()
        with pytest.raises(HTTPException) as refused:
            await files_router.update_file_data_content_by_id(
                None, file.id, files_router.ContentForm(content='  \n'), user=owner, db=None
            )
        return refused.value.status_code, (await Files.get_file_by_id(file.id)).data['content']

    code, stored = asyncio.run(scenario())

    assert (code, stored, called) == (400, 'OLD CONTENT', [])


def _content_saves(monkeypatch):
    async def process(request, form, **_k):
        await Files.update_file_data_by_id(form.file_id, {'content': form.content})

    monkeypatch.setattr(files_router, 'process_file', process)


def test_a_knowledge_base_that_could_not_be_updated_is_named(monkeypatch, stubs):
    _content_saves(monkeypatch)

    async def mirror(request, form, user, db, *, check_collection_access=True, record_failure=True):
        raise RuntimeError('vector store full')

    async def bases(*_a, **_k):
        return [SimpleNamespace(id='kb1', name='Research'), SimpleNamespace(id='kb2', name='Private notes')]

    async def readable(knowledge_id, user_id, permission='write', **_k):
        return knowledge_id == 'kb1'

    monkeypatch.setattr(files_router, 'process_file_for', mirror)
    monkeypatch.setattr(files_router.Knowledges, 'get_knowledges_by_file_id', bases)
    monkeypatch.setattr(files_router.Knowledges, 'check_access_by_user_id', readable)

    async def scenario():
        owner, _, file = await _users_and_file()
        return await files_router.update_file_data_content_by_id(
            None, file.id, files_router.ContentForm(content='NEW'), user=owner, db=None
        )

    out = asyncio.run(scenario())

    # Saved, and the bases the new text could not reach are reported for the
    # page to warn about: by name only where the editor can open the base.
    assert out == {'content': 'NEW', 'failed_knowledge': ['Research', 'a knowledge base you cannot open']}
    # The base's old chunks stay until new ones are in.
    assert stubs.deleted == []


def test_every_base_holding_the_file_gets_the_new_text_whoever_can_write_it(monkeypatch, stubs):
    """The editor's write access to the file is checked once; bases mirror its chunks."""
    _content_saves(monkeypatch)
    mirrored = []

    async def mirror(request, form, user, db, *, check_collection_access=True, record_failure=True):
        mirrored.append((form.collection_name, check_collection_access))
        assert record_failure is False

    async def bases(*_a, **_k):
        return [SimpleNamespace(id='mine', name='Mine'), SimpleNamespace(id='theirs', name='Theirs')]

    monkeypatch.setattr(files_router, 'process_file_for', mirror)
    monkeypatch.setattr(files_router.Knowledges, 'get_knowledges_by_file_id', bases)

    async def scenario():
        owner, _, file = await _users_and_file()
        return await files_router.update_file_data_content_by_id(
            None, file.id, files_router.ContentForm(content='NEW'), user=owner, db=None
        )

    out = asyncio.run(scenario())

    assert out['failed_knowledge'] == []
    assert mirrored == [('mine', False), ('theirs', False)]
    assert ('mine', ['old-1', 'old-2'], None) in stubs.deleted


def test_a_reader_cannot_copy_a_file_into_a_collection_through_process_file(monkeypatch, stubs):
    """Every process_file path writes the file's row, so reading it is not enough."""
    _grant(monkeypatch, 'read')

    async def scenario():
        _, reader, file = await _users_and_file()
        with pytest.raises(HTTPException) as refused:
            await retrieval_router.process_file(
                None, retrieval_router.ProcessFileForm(file_id=file.id, collection_name='kb1'), user=reader, db=None
            )
        return refused.value.status_code, await Files.get_file_by_id(file.id)

    code, row = asyncio.run(scenario())

    assert code == 404
    assert (row.data.get('status'), row.data['content']) == (None, 'OLD CONTENT')


def test_a_refused_collection_does_not_mark_the_file_failed(monkeypatch, stubs):
    async def refuse(collections, user, access_type='read'):
        raise HTTPException(status_code=403, detail='no')

    monkeypatch.setattr(retrieval_router, '_validate_collection_access', refuse)

    async def scenario():
        owner, _, file = await _users_and_file()
        with pytest.raises(HTTPException) as refused:
            await retrieval_router.process_file(
                None, retrieval_router.ProcessFileForm(file_id=file.id, collection_name='kb1'), user=owner, db=None
            )
        return refused.value.status_code, await Files.get_file_by_id(file.id)

    code, row = asyncio.run(scenario())

    assert code == 403
    assert row.data.get('status') is None and row.hash is None and row.data['content'] == 'OLD CONTENT'


def test_a_failed_knowledge_reindex_keeps_the_old_chunks(monkeypatch, stubs):
    async def fails(*_a, **_k):
        raise RuntimeError('vector store full')

    async def kb(*_a, **_k):
        return SimpleNamespace(id='kb1', user_id='owner', name='Research', meta=None, model_dump=lambda: {})

    async def yes(*_a, **_k):
        return True

    monkeypatch.setattr(knowledge_router, 'process_file', fails)
    monkeypatch.setattr(knowledge_router.Knowledges, 'get_knowledge_by_id', kb)
    monkeypatch.setattr(knowledge_router.Knowledges, 'has_file', yes)

    async def scenario():
        owner, _, file = await _users_and_file()
        user = SimpleNamespace(id='owner', role='user')
        with pytest.raises(HTTPException):
            await knowledge_router.update_file_from_knowledge_by_id(
                None, 'kb1', knowledge_router.KnowledgeFileIdForm(file_id=file.id), user=user, db=None
            )

    asyncio.run(scenario())

    assert stubs.deleted == []


def test_a_failed_mirror_does_not_mark_the_file_failed(monkeypatch, stubs):
    """The file's own content and collection are fine; only one base missed the new text."""

    async def chunks_without_text(collection_name, filter=None):
        return SimpleNamespace(ids=[['x']])  # no documents: copying them fails

    monkeypatch.setattr(stubs, 'query', chunks_without_text)

    async def scenario():
        owner, _, file = await _users_and_file()
        with pytest.raises(Exception):
            await retrieval_router.process_file_for(
                None,
                retrieval_router.ProcessFileForm(file_id=file.id, collection_name='kb1'),
                owner,
                None,
                check_collection_access=False,
                record_failure=False,
            )
        return await Files.get_file_by_id(file.id)

    row = asyncio.run(scenario())

    assert row.data.get('status') is None


def test_a_successful_knowledge_reindex_removes_the_old_chunks(monkeypatch, stubs):
    async def succeeds(*_a, **_k):
        return None

    fields = {'id': 'kb1', 'user_id': 'owner', 'name': 'Research', 'description': '', 'created_at': 1, 'updated_at': 1}

    async def kb(*_a, **_k):
        return SimpleNamespace(**fields, meta=None, model_dump=lambda: fields)

    async def yes(*_a, **_k):
        return True

    async def no_files(*_a, **_k):
        return []

    monkeypatch.setattr(knowledge_router, 'process_file', succeeds)
    monkeypatch.setattr(knowledge_router.Knowledges, 'get_knowledge_by_id', kb)
    monkeypatch.setattr(knowledge_router.Knowledges, 'has_file', yes)
    monkeypatch.setattr(knowledge_router.Knowledges, 'get_file_metadatas_by_id', no_files)

    async def scenario():
        _, _, file = await _users_and_file()
        user = SimpleNamespace(id='owner', role='user')
        return await knowledge_router.update_file_from_knowledge_by_id(
            None, 'kb1', knowledge_router.KnowledgeFileIdForm(file_id=file.id), user=user, db=None
        )

    assert asyncio.run(scenario()).id == 'kb1'

    assert stubs.deleted == [('kb1', ['old-1', 'old-2'], None)]


def test_adding_someone_elses_file_to_a_base_needs_write_access_to_it(monkeypatch, stubs):
    """Read access passed the route and then failed inside process_file with a confusing 404."""

    async def kb(*_a, **_k):
        return SimpleNamespace(id='kb1', user_id='reader', name='Mine', meta=None)

    async def read_only(file_id, access_type, user, db=None, **_k):
        return access_type == 'read'

    monkeypatch.setattr(knowledge_router.Knowledges, 'get_knowledge_by_id', kb)
    monkeypatch.setattr(knowledge_router, 'has_access_to_file', read_only)

    async def scenario():
        _, _, file = await _users_and_file()
        with pytest.raises(HTTPException) as refused:
            await knowledge_router.add_file_to_knowledge_by_id(
                None,
                'kb1',
                knowledge_router.KnowledgeFileIdForm(file_id=file.id),
                user=SimpleNamespace(id='reader', role='user'),
                db=None,
            )
        return refused.value.status_code

    assert asyncio.run(scenario()) == 403


async def _empty():
    return []
