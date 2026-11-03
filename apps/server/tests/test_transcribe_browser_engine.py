"""An audio upload under the browser's "Web API" speech-to-text engine fails with a reason (#343).

With Admin Settings > Audio's speech-to-text engine set to "Web API", the
browser transcribes what the microphone hears; the server has no engine to
run. An uploaded audio file was still sent to server transcription, where
`transcription_handler` had no branch for `web`, returned None, and
`transcribe` raised `TypeError: 'NoneType' object is not subscriptable`,
which the upload stored as its error.

Now `transcribe` refuses an engine the server cannot run before it touches
the file, with a 400 that says which setting to change, and the upload is
stored with that message as its failed status.

Run from apps/server:

    python -m pytest tests/test_transcribe_browser_engine.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.routers import audio as audio_router
from local_llm.routers import files as files_router


def _engine(monkeypatch, engine, extra=None):
    values = {'audio.stt.engine': engine, **(extra or {})}

    async def config_get(key, default=None):
        return values.get(key, default)

    monkeypatch.setattr(audio_router.Config, 'get', config_get)


@pytest.mark.parametrize('engine', ['web', 'something-else'])
def test_transcribe_refuses_an_engine_the_server_cannot_run(monkeypatch, tmp_path, engine):
    _engine(monkeypatch, engine)
    recording = tmp_path / 'r.wav'
    recording.write_bytes(b'RIFF')

    def must_not_copy(*_a, **_k):
        raise AssertionError('the file was touched')

    monkeypatch.setattr(audio_router.shutil, 'copyfile', must_not_copy)

    with pytest.raises(HTTPException) as raised:
        asyncio.run(audio_router.transcribe(SimpleNamespace(), str(recording)))

    assert raised.value.status_code == 400
    assert 'Admin Settings > Audio' in raised.value.detail
    if engine == 'web':
        assert '"Web API", a browser engine' in raised.value.detail


@pytest.mark.parametrize('engine', audio_router.SERVER_STT_ENGINES)
def test_every_server_engine_is_one_the_handler_runs(monkeypatch, tmp_path, engine):
    """The list `transcribe` checks matches the handler's branches, so no server engine is refused."""
    _engine(monkeypatch, engine)
    ran = []

    def stub(name):
        async def run(*_a, **_k):
            ran.append(name)
            return {'text': name}

        return run

    for name in (
        '_transcribe_whisper',
        '_transcribe_openai',
        '_transcribe_deepgram',
        '_transcribe_azure',
        '_transcribe_mistral',
    ):
        monkeypatch.setattr(audio_router, name, stub(name))

    result = asyncio.run(audio_router.transcription_handler(SimpleNamespace(), str(tmp_path / 'c.mp3'), {}))

    assert len(ran) == 1
    assert result == {'text': ran[0]}


def test_a_chunk_for_an_engine_the_server_cannot_run_is_refused_too(monkeypatch, tmp_path):
    _engine(monkeypatch, 'web')

    with pytest.raises(HTTPException) as raised:
        asyncio.run(audio_router.transcription_handler(SimpleNamespace(), str(tmp_path / 'c.mp3'), {}))

    assert raised.value.status_code == 400


def test_an_audio_upload_under_the_web_engine_is_stored_as_failed_with_the_reason(monkeypatch):
    marked: list[dict] = []
    _engine(monkeypatch, 'web', {'audio.stt.supported_content_types': ['audio/*']})

    async def update_data(file_id, data, db=None):
        marked.append(data)

    monkeypatch.setattr(files_router.Files, 'update_file_data_by_id', update_data)
    monkeypatch.setattr(files_router.Storage, 'get_file', lambda path: path)
    monkeypatch.setattr(files_router, '_cleanup_local_cache', lambda path: None)

    asyncio.run(
        files_router.process_uploaded_file(
            SimpleNamespace(),
            SimpleNamespace(content_type='audio/wav'),
            '/uploads/r.wav',
            SimpleNamespace(id='f1'),
            {},
            SimpleNamespace(id='u1', role='user'),
            db=object(),
        )
    )

    assert marked[-1]['status'] == 'failed'
    assert 'Web API' in marked[-1]['error']
    assert 'NoneType' not in marked[-1]['error']
