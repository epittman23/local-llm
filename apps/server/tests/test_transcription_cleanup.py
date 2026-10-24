"""Transcription leaves no audio copies or transcripts beside the upload.

The STT handler is stubbed, and writes its transcript JSON beside the audio it
is given exactly as the real handlers do.

Run from apps/server:

    python -m pytest tests/test_transcription_cleanup.py
"""

from __future__ import annotations

import asyncio
import os

import aiofiles

from local_llm.routers import audio as audio_router


def test_transcribe_leaves_only_the_original(monkeypatch, tmp_path):
    upload = tmp_path / 'voice memo.webm'
    upload.write_bytes(b'not really audio')
    seen = []

    async def handler(request, chunk_path, metadata, user=None):
        seen.append(chunk_path)
        base = os.path.splitext(chunk_path)[0]
        async with aiofiles.open(base + '.json', 'w') as f:
            await f.write('{"text": "hello"}')
        async with aiofiles.open(base + '.mp3', 'wb') as f:
            await f.write(b'converted copy')
        return {'text': 'hello'}

    monkeypatch.setattr(audio_router, 'BYPASS_PYDUB_PREPROCESSING', True)
    monkeypatch.setattr(audio_router, 'transcription_handler', handler)

    assert asyncio.run(audio_router.transcribe(None, str(upload))) == {'text': 'hello'}
    assert sorted(p.name for p in tmp_path.iterdir()) == ['voice memo.webm']
    # The handler worked on a copy, in a directory that no longer exists.
    assert not os.path.exists(os.path.dirname(seen[0]))
