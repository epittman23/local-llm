"""Adding a file to a knowledge base it is already in is refused (#314).

The single add (`POST /knowledge/{id}/file/add`) had no check that the file
was already in the base, unlike the batch add: it embedded the file into the
base's collection a second time, and the duplicate link insert failed
unreported, so the route answered 200 with every chunk now twice in the
collection. It now refuses a file already in the base before embedding, and
reports a link that could not be made. The batch add built its per-file
failures into a response model with no field for them, so the client never
saw them; its response now carries them as `warnings`.

Runs against the suite's temporary SQLite database (tests/conftest.py points
DATA_DIR at a temp directory, and DATABASE_URL defaults to a file in it,
migrated on import), with processing and events replaced by recorders.

Run from apps/server:

    python -m pytest tests/test_knowledge_add_file_once.py
"""

import asyncio
import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import TypeAdapter

from local_llm.models.files import FileForm, Files
from local_llm.models.knowledge import KnowledgeForm, Knowledges
from local_llm.models.users import Users
from local_llm.routers import knowledge as knowledge_router
from local_llm.routers.retrieval import BatchProcessFilesResponse, BatchProcessFilesResult


class VectorRecorder:
    def __init__(self):
        self.deleted: list[tuple[str, dict]] = []

    async def delete(self, collection_name, ids=None, filter=None):
        self.deleted.append((collection_name, filter))


@pytest.fixture
def processed(monkeypatch):
    """Records each processing call; the batch reports the files named in `failing` as failed."""
    calls: list = []
    failing: set[str] = set()
    vectors = VectorRecorder()

    async def process_file(request, form, user=None, db=None):
        calls.append(form.file_id)

    async def process_files_batch(request, form_data, user=None, db=None):
        results, errors = [], []
        for f in form_data.files:
            calls.append(f.id)
            if f.id in failing:
                errors.append(BatchProcessFilesResult(file_id=f.id, status='failed', error='cannot read it'))
            else:
                results.append(BatchProcessFilesResult(file_id=f.id, status='completed'))
        return BatchProcessFilesResponse(results=results, errors=errors)

    async def publish(*_a, **_k):
        calls.append('event')

    monkeypatch.setattr(knowledge_router, 'ASYNC_VECTOR_DB_CLIENT', vectors)
    monkeypatch.setattr(knowledge_router, 'process_file', process_file)
    monkeypatch.setattr(knowledge_router, 'process_files_batch', process_files_batch)
    monkeypatch.setattr(knowledge_router, 'publish_event', publish)
    return SimpleNamespace(calls=calls, failing=failing, vectors=vectors)


async def _world(files=1):
    tag = uuid.uuid4().hex[:8]
    user = await Users.insert_new_user(f'u{tag}', 'Ada', f'u{tag}@example.invalid', role='user')
    kb = await Knowledges.insert_new_knowledge(user.id, KnowledgeForm(name='Notes', description=''))
    made = []
    for i in range(files):
        made.append(
            await Files.insert_new_file(
                user.id,
                FileForm(id=str(uuid.uuid4()), filename=f'f{i}.txt', path='', data={'content': f'text {i}'}),
            )
        )
    return SimpleNamespace(id=user.id, role='user'), kb, made


async def _add(user, kb, file_id):
    return await knowledge_router.add_file_to_knowledge_by_id(
        None, kb.id, knowledge_router.KnowledgeFileIdForm(file_id=file_id), user=user, db=None
    )


def test_adding_a_file_already_in_the_base_is_refused_before_it_is_embedded_again(processed):
    calls = processed.calls

    async def scenario():
        user, kb, (file,) = await _world()
        await _add(user, kb, file.id)
        with pytest.raises(HTTPException) as refused:
            await _add(user, kb, file.id)
        return file, refused.value, await Knowledges.get_files_by_id(kb.id)

    file, refused, linked = asyncio.run(scenario())

    assert refused.status_code == 400
    assert refused.detail == knowledge_router.ERROR_MESSAGES.FILE_ALREADY_IN_KNOWLEDGE
    assert calls == [file.id, 'event']  # embedded once
    assert [f.id for f in linked] == [file.id]


def test_a_link_that_could_not_be_made_is_reported(processed, monkeypatch):
    async def no_link(*_a, **_k):
        return None

    monkeypatch.setattr(knowledge_router.Knowledges, 'add_file_to_knowledge_by_id', no_link)

    async def scenario():
        user, kb, (file,) = await _world()
        with pytest.raises(HTTPException) as refused:
            await _add(user, kb, file.id)
        return refused.value, kb, file

    refused, kb, file = asyncio.run(scenario())

    assert refused.status_code == 400
    assert refused.detail == knowledge_router.ERROR_MESSAGES.FILE_NOT_ADDED_TO_KNOWLEDGE
    # The chunks just embedded go too, and nothing is announced.
    assert processed.vectors.deleted == [(kb.id, {'file_id': file.id})]
    assert 'event' not in processed.calls


def test_a_failed_link_keeps_the_chunks_when_the_file_was_linked_meanwhile(processed, monkeypatch):
    real_has_file = Knowledges.has_file
    seen = []

    async def has_file(*args, **kwargs):
        # The duplicate check runs before another request links the file.
        seen.append(1)
        return False if len(seen) == 1 else await real_has_file(*args, **kwargs)

    monkeypatch.setattr(Knowledges, 'has_file', has_file)

    async def scenario():
        user, kb, (file,) = await _world()
        await Knowledges.add_file_to_knowledge_by_id(kb.id, file.id, user.id)
        with pytest.raises(HTTPException) as refused:
            await _add(user, kb, file.id)
        return refused.value, await Knowledges.get_files_by_id(kb.id), file

    refused, linked, file = asyncio.run(scenario())

    # The real insert failed on the unique link; the other request's chunks stay.
    assert refused.status_code == 400
    assert [f.id for f in linked] == [file.id]
    assert processed.vectors.deleted == []


def test_a_failed_link_leaves_the_callers_session_usable(monkeypatch):
    import local_llm.internal.db as db_module

    monkeypatch.setattr(db_module, 'DATABASE_ENABLE_SESSION_SHARING', True)

    async def scenario():
        user, kb, (file,) = await _world()
        async with db_module.get_async_db() as db:
            first = await Knowledges.add_file_to_knowledge_by_id(kb.id, file.id, user.id, db=db)
            second = await Knowledges.add_file_to_knowledge_by_id(kb.id, file.id, user.id, db=db)
            # Without the rollback, this session could not run another query.
            still = await Knowledges.has_file(kb.id, file.id, db=db)
        return first, second, still

    first, second, still = asyncio.run(scenario())

    assert first is not None and second is None
    assert still is True


def test_a_batch_add_reports_the_files_that_failed(processed):
    failing = processed.failing

    async def scenario():
        user, kb, (good, bad) = await _world(files=2)
        failing.add(bad.id)
        forms = [knowledge_router.KnowledgeFileIdForm(file_id=f.id) for f in (good, bad)]
        response = await knowledge_router.add_files_to_knowledge_batch(None, kb.id, forms, user=user, db=None)
        return good, bad, response, await Knowledges.get_files_by_id(kb.id)

    good, bad, response, linked = asyncio.run(scenario())

    assert response.warnings == {'message': 'Some files failed to process', 'errors': [f'{bad.id}: cannot read it']}
    # What the route sends, through its declared response model, keeps them.
    route = next(r for r in knowledge_router.router.routes if getattr(r, 'path', '') == '/{id}/files/batch/add')
    sent = TypeAdapter(route.response_model).dump_python(response)
    assert sent['warnings'] == response.warnings
    assert [f.id for f in linked] == [good.id]


def test_a_batch_add_without_failures_has_no_warnings(processed):
    async def scenario():
        user, kb, (file,) = await _world()
        forms = [knowledge_router.KnowledgeFileIdForm(file_id=file.id)]
        first = await knowledge_router.add_files_to_knowledge_batch(None, kb.id, forms, user=user, db=None)
        again = await knowledge_router.add_files_to_knowledge_batch(None, kb.id, forms, user=user, db=None)
        return first, again

    first, again = asyncio.run(scenario())

    assert first.warnings is None and again.warnings is None


def test_a_batch_add_reports_a_file_that_could_not_be_linked(processed, monkeypatch):
    real_add = Knowledges.add_file_to_knowledge_by_id

    async def scenario():
        user, kb, (good, unlinkable) = await _world(files=2)

        async def add(knowledge_id, file_id, *args, **kwargs):
            if file_id == unlinkable.id:
                return None
            return await real_add(knowledge_id, file_id, *args, **kwargs)

        monkeypatch.setattr(knowledge_router.Knowledges, 'add_file_to_knowledge_by_id', add)
        forms = [knowledge_router.KnowledgeFileIdForm(file_id=f.id) for f in (good, unlinkable)]
        response = await knowledge_router.add_files_to_knowledge_batch(None, kb.id, forms, user=user, db=None)
        return kb, unlinkable, response

    kb, unlinkable, response = asyncio.run(scenario())

    assert response.warnings['errors'] == [
        f'{unlinkable.id}: {knowledge_router.ERROR_MESSAGES.FILE_NOT_ADDED_TO_KNOWLEDGE}'
    ]
    assert processed.vectors.deleted == [(kb.id, {'file_id': unlinkable.id})]
