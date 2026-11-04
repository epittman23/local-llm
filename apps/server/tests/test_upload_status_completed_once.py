"""An upload into a knowledge base reports completed only once it is linked there (#311).

The file status stream (`GET /files/{id}/process/status?stream=true`) ends at
the first "completed". An upload from a knowledge base runs two processing
steps (the file's own collection, then the knowledge base's) and then links
the file, and each step wrote "completed": a poll between them reported
success before a later step could fail (a duplicate, a failed link), and the
file was briefly neither pending nor linked. The steps before the link now
leave the status alone, and "completed" is written once, after the link.

Run from apps/server:

    python -m pytest tests/test_upload_status_completed_once.py
"""

import asyncio
import uuid
from types import SimpleNamespace

from local_llm.models.files import FileForm, Files
from local_llm.models.users import Users
from local_llm.routers import files as files_router
from local_llm.routers import retrieval as retrieval_router


def _upload(monkeypatch, metadata, link=True, content_type='text/plain', stt=()):
    events: list = []

    async def config_get(key, default=None):
        return list(stt) if key == 'audio.stt.supported_content_types' else default

    async def process_file_for(request, form, user=None, db=None, *, mark_completed=True, **_options):
        events.append(('process', form.collection_name, mark_completed))
        # What the real step writes on success: "completed" only when asked to.
        if mark_completed:
            events.append(('status', 'completed'))

    async def transcribe(request, path, metadata, user):
        events.append(('transcribe', path))
        return {'text': 'spoken words'}

    async def knowledge(id, db=None):
        return SimpleNamespace(id=id, user_id='u1')

    async def add_file(**kwargs):
        events.append(('link', kwargs['knowledge_id']))
        return SimpleNamespace(id='kf1') if link else None

    async def update_data(file_id, data, db=None):
        events.append(('status', data.get('status')))

    def run_in_background(coroutine):
        coroutine.close()

    monkeypatch.setattr(files_router.Config, 'get', config_get)
    monkeypatch.setattr(files_router, 'process_file_for', process_file_for)
    # The upload used process_file before (#311); the same fake stands in for it.
    monkeypatch.setattr(files_router, 'process_file', process_file_for)
    monkeypatch.setattr(files_router, 'transcribe', transcribe)
    monkeypatch.setattr(files_router.Storage, 'get_file', lambda path: path)
    monkeypatch.setattr(files_router, '_is_text_file', lambda path: False)
    monkeypatch.setattr(files_router.Knowledges, 'get_knowledge_by_id', knowledge)
    monkeypatch.setattr(files_router.Knowledges, 'add_file_to_knowledge_by_id', add_file)
    monkeypatch.setattr(files_router.Files, 'update_file_data_by_id', update_data)
    monkeypatch.setattr(files_router, 'run_in_background', run_in_background)
    monkeypatch.setattr(files_router, '_cleanup_local_cache', lambda path: None)

    asyncio.run(
        files_router.process_uploaded_file(
            SimpleNamespace(),
            SimpleNamespace(content_type=content_type),
            '/uploads/f1',
            SimpleNamespace(id='f1'),
            metadata,
            SimpleNamespace(id='u1', role='user'),
            db=object(),
        )
    )
    return events


def _statuses(events):
    return [rest[0] for kind, *rest in events if kind == 'status']


def test_an_upload_into_a_knowledge_base_is_completed_once_after_the_link(monkeypatch):
    events = _upload(monkeypatch, {'knowledge_id': 'kb1'})

    assert events == [
        ('process', None, False),
        ('status', 'processing'),
        ('process', 'kb1', False),
        ('link', 'kb1'),
        ('status', 'completed'),
    ]


def test_a_failed_link_is_reported_failed_and_never_completed(monkeypatch):
    statuses = _statuses(_upload(monkeypatch, {'knowledge_id': 'kb1'}, link=False))

    assert 'completed' not in statuses
    assert statuses[-1] == 'failed'


def test_an_upload_outside_a_knowledge_base_is_completed_by_its_processing(monkeypatch):
    assert _upload(monkeypatch, {}) == [('process', None, True), ('status', 'completed')]


def test_a_transcribed_upload_into_a_knowledge_base_is_completed_only_after_the_link(monkeypatch):
    events = _upload(monkeypatch, {'knowledge_id': 'kb1'}, content_type='audio/mpeg', stt=['audio/mpeg'])

    assert events[:2] == [('transcribe', '/uploads/f1'), ('process', None, False)]
    assert _statuses(events) == ['processing', 'completed']
    assert events[-2:] == [('link', 'kb1'), ('status', 'completed')]


def test_a_transcribed_upload_outside_a_knowledge_base_is_completed_by_its_processing(monkeypatch):
    events = _upload(monkeypatch, {}, content_type='audio/mpeg', stt=['audio/mpeg'])

    assert events == [('transcribe', '/uploads/f1'), ('process', None, True), ('status', 'completed')]


def test_a_video_outside_a_knowledge_base_is_completed_at_once(monkeypatch):
    assert _upload(monkeypatch, {}, content_type='video/mp4') == [('status', 'completed')]


def test_a_video_into_a_knowledge_base_is_not_completed_before_the_link(monkeypatch):
    events = _upload(monkeypatch, {'knowledge_id': 'kb1'}, content_type='video/mp4')

    # No early "completed": the first status is the knowledge-base step's.
    assert _statuses(events)[0] == 'processing'
    assert _statuses(events)[-1] == 'completed'
    assert ('link', 'kb1') in events


def test_a_processing_step_writes_completed_only_when_it_is_the_last():
    from local_llm.routers.retrieval import _done_status

    assert _done_status(True) == {'status': 'completed', 'error': None}
    assert _done_status(False) == {'error': None}


def test_process_file_for_leaves_the_status_to_the_caller_when_asked(monkeypatch):
    async def bypass():
        return SimpleNamespace(BYPASS_EMBEDDING_AND_RETRIEVAL=True)

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(retrieval_router, 'get_retrieval_config', bypass)
    monkeypatch.setattr(retrieval_router, 'publish_event', nothing)

    async def scenario():
        tag = uuid.uuid4().hex[:8]
        owner = await Users.insert_new_user(f'o{tag}', 'Owner', f'o{tag}@example.invalid', role='user')
        rows = {}
        for mark_completed in (False, True):
            file = await Files.insert_new_file(
                owner.id,
                FileForm(
                    id=str(uuid.uuid4()),
                    filename='notes.txt',
                    path='',
                    data={'content': 'TEXT', 'status': 'pending', 'error': 'earlier'},
                ),
            )
            await retrieval_router.process_file_for(
                None, retrieval_router.ProcessFileForm(file_id=file.id), owner, None, mark_completed=mark_completed
            )
            rows[mark_completed] = (await Files.get_file_by_id(file.id)).data
        return rows

    rows = asyncio.run(scenario())

    assert (rows[False]['status'], rows[False]['error']) == ('pending', None)
    assert (rows[True]['status'], rows[True]['error']) == ('completed', None)
