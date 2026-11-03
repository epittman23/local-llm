"""Uploads whose processing a restart interrupted are marked failed at startup (#309).

Upload processing runs as an in-memory background task. When a restart cut
it off (a crash or kill, a forced shutdown, the desktop app's 10 s graceful
timeout), the file stayed `pending` or `processing` for good: the knowledge
base page kept a spinner row and polled forever, and the row could not be
removed because the file was never linked. Startup now marks such files
failed, with an error saying to upload them again. These run against the
test run's migrated database.

Run from apps/server (any LLLM_SECRET_KEY of 32 characters or more):

    LLLM_SECRET_KEY=... python -m pytest tests/test_interrupted_uploads.py
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from test_safe_mode_startup import _FirstPublish, _startup

# Importing the app runs the migrations on the test run's database.
from local_llm import main
from local_llm.models.files import FileForm, Files


def _file(status: str | None) -> str:
    file_id = str(uuid.uuid4())
    data = {'status': status} if status else {}
    asyncio.run(
        Files.insert_new_file(
            'uploader',
            FileForm(
                id=file_id,
                filename=f'{status}.pdf',
                path=f'/tmp/{file_id}',
                data=data,
                meta={'data': {'knowledge_id': 'kb-interrupted'}},
            ),
        )
    )
    return file_id


def _data(file_id: str) -> dict:
    return asyncio.run(Files.get_file_by_id(file_id)).data or {}


def test_files_left_pending_or_processing_are_failed_with_a_reason():
    pending, processing = _file('pending'), _file('processing')
    done, failed, unset = _file('completed'), _file('failed'), _file(None)

    marked = asyncio.run(Files.fail_interrupted_processing())

    assert marked >= 2
    for file_id in (pending, processing):
        data = _data(file_id)
        assert data['status'] == 'failed'
        assert 'upload it again' in data['error']
    assert _data(done)['status'] == 'completed'
    assert _data(failed)['status'] == 'failed'
    assert 'status' not in _data(unset)


def test_the_knowledge_base_page_no_longer_lists_them_as_uploading():
    file_id = _file('processing')
    assert file_id in [f.id for f in asyncio.run(Files.get_pending_files_for_knowledge('kb-interrupted'))]

    asyncio.run(Files.fail_interrupted_processing())

    assert file_id not in [f.id for f in asyncio.run(Files.get_pending_files_for_knowledge('kb-interrupted'))]


def test_startup_marks_them_before_anything_is_published(monkeypatch):
    # The startup step runs in main.lifespan; the order is checked there by
    # driving the lifespan to its first published event.
    order, run = _startup(monkeypatch, safe_mode=False, deactivated=True)

    async def fail_interrupted_processing():
        order.append('fail interrupted uploads')
        return 0

    monkeypatch.setattr(main.Files, 'fail_interrupted_processing', fail_interrupted_processing)

    with pytest.raises(_FirstPublish):
        asyncio.run(run())

    assert order == ['fail interrupted uploads', 'publish system.startup.started']


def test_a_database_error_is_logged_and_startup_goes_on(monkeypatch):
    from contextlib import asynccontextmanager

    from local_llm.models import files as files_model

    class _Broken:
        async def execute(self, stmt):
            raise RuntimeError('database went away')

    @asynccontextmanager
    async def broken(db=None):
        yield _Broken()

    monkeypatch.setattr(files_model, 'get_async_db_context', broken)

    assert asyncio.run(Files.fail_interrupted_processing()) == 0


def test_startup_says_how_many_uploads_it_marked(monkeypatch, caplog):
    order, run = _startup(monkeypatch, safe_mode=False, deactivated=True)

    async def two_interrupted():
        return 2

    monkeypatch.setattr(main.Files, 'fail_interrupted_processing', two_interrupted)

    with caplog.at_level('WARNING'), pytest.raises(_FirstPublish):
        asyncio.run(run())

    assert 'Marked 2 upload(s) interrupted by the last restart as failed' in caplog.text
