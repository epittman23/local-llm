"""A GGUF download from a URL that fails part way ends with an error event (#250).

`POST /ollama/models/download` streams the download's progress, then the
stored blob. A failure once the stream had started (an HTTP error, a resume
the server could not satisfy, a refused blob push) raised inside the
stream and cut it off with no message, so the admin's tab showed nothing.
It now ends with an `{"error": ...}` event, as the upload's stream does.

Run from apps/server:

    python -m pytest tests/test_ollama_download_errors.py
"""

import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.routers import ollama

URL = 'https://huggingface.co/org/repo/resolve/main/model.Q4.gguf'


def _events(monkeypatch, tmp_path, stream):
    async def config_get(key, default=None):
        return ['http://ollama.invalid'] if key == 'ollama.base_urls' else default

    monkeypatch.setattr(ollama.Config, 'get', config_get)
    monkeypatch.setattr(ollama, 'partial_download_path', lambda url, name: str(tmp_path / 'part'))
    monkeypatch.setattr(ollama, 'download_file_stream', stream)

    async def run():
        response = await ollama.download_model(None, ollama.UrlForm(url=URL), url_idx=None, user=SimpleNamespace())
        return [chunk async for chunk in response.body_iterator]

    chunks = asyncio.run(run())
    return [json.loads(c.removeprefix('data: ').strip()) for c in chunks]


def test_a_failure_part_way_ends_the_stream_with_an_error_event(monkeypatch, tmp_path):
    async def stream(*_args):
        yield 'data: {"progress": 50}\n\n'
        raise ollama.ModelDownloadError('refused', 'Download failed: HTTP 503 Service Unavailable')

    assert _events(monkeypatch, tmp_path, stream) == [
        {'progress': 50},
        {'error': ollama.DOWNLOAD_ERRORS['refused']},
    ]


@pytest.mark.parametrize('kind', ['resume', 'refused', 'blob'])
def test_each_kind_of_failure_is_named_by_a_fixed_message(monkeypatch, tmp_path, kind):
    async def stream(*_args):
        raise ollama.ModelDownloadError(kind, 'the detail, for the log')
        yield ''

    (event,) = _events(monkeypatch, tmp_path, stream)
    assert event == {'error': ollama.DOWNLOAD_ERRORS[kind]}
    assert 'detail' not in event['error']


def test_any_other_failure_gives_the_general_message_and_logs_the_detail(monkeypatch, tmp_path, caplog):
    async def stream(*_args):
        raise OSError('No space left on device: /data/cache/part')
        yield ''

    (event,) = _events(monkeypatch, tmp_path, stream)

    assert event == {'error': ollama.DOWNLOAD_FAILED}
    assert 'No space left on device' in caplog.text


def test_a_download_that_succeeds_streams_as_before(monkeypatch, tmp_path):
    async def stream(*_args):
        yield 'data: {"progress": 100}\n\n'
        yield 'data: {"done": true, "blob": "sha256:abc", "name": "model.Q4.gguf"}\n\n'

    assert _events(monkeypatch, tmp_path, stream) == [
        {'progress': 100},
        {'done': True, 'blob': 'sha256:abc', 'name': 'model.Q4.gguf'},
    ]


def test_a_url_that_names_no_file_is_refused(monkeypatch, tmp_path):
    async def config_get(key, default=None):
        return ['http://ollama.invalid']

    monkeypatch.setattr(ollama.Config, 'get', config_get)

    with pytest.raises(HTTPException) as refused:
        asyncio.run(
            ollama.download_model(
                None, ollama.UrlForm(url='https://huggingface.co/'), url_idx=None, user=SimpleNamespace()
            )
        )

    assert refused.value.status_code == 400
