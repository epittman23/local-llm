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
from types import SimpleNamespace

from local_llm.routers import files as files_router


def _upload(monkeypatch, metadata, link=True):
    events: list = []

    async def config_get(key, default=None):
        return default

    async def process_file_for(request, form, user=None, db=None, *, mark_completed=True, **_options):
        events.append(('process', form.collection_name, mark_completed))

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
    monkeypatch.setattr(files_router.Knowledges, 'get_knowledge_by_id', knowledge)
    monkeypatch.setattr(files_router.Knowledges, 'add_file_to_knowledge_by_id', add_file)
    monkeypatch.setattr(files_router.Files, 'update_file_data_by_id', update_data)
    monkeypatch.setattr(files_router, 'run_in_background', run_in_background)
    monkeypatch.setattr(files_router, '_cleanup_local_cache', lambda path: None)

    asyncio.run(
        files_router.process_uploaded_file(
            SimpleNamespace(),
            SimpleNamespace(content_type='text/plain'),
            '/uploads/f1',
            SimpleNamespace(id='f1'),
            metadata,
            SimpleNamespace(id='u1', role='user'),
            db=object(),
        )
    )
    return events


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
    events = _upload(monkeypatch, {'knowledge_id': 'kb1'}, link=False)

    statuses = [status for kind, *rest in events if kind == 'status' for status in rest]
    assert 'completed' not in statuses
    assert statuses[-1] == 'failed'


def test_an_upload_outside_a_knowledge_base_is_completed_by_its_processing(monkeypatch):
    assert _upload(monkeypatch, {}) == [('process', None, True)]


def test_a_processing_step_writes_completed_only_when_it_is_the_last():
    from local_llm.routers.retrieval import _done_status

    assert _done_status(True) == {'status': 'completed', 'error': None}
    assert _done_status(False) == {'error': None}
