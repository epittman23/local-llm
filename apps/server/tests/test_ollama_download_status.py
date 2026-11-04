"""A model download by URL checks what the server answered (#341).

`download_file_stream` (routers/ollama.py) saved whatever body came back,
pushed it to Ollama and reported done, so a 404 page or a gated repo's 401
became a "model". A resume sent a Range header and appended whatever came
back: a full 200 body after the partial bytes, or a 416 error body. Partial
files were named by the URL's last path segment only, so two URLs ending in
the same name resumed into each other. And the download had a 10-minute
total limit, the push a 30-second one, which a real model file outlasts.

Now:
- a fresh download needs a 200, and anything else raises with nothing saved;
- a resume appends only a 206 whose range starts where the file ends, starts
  over on a 200, and treats a 416 for exactly the file's size as complete;
- a partial file is named by the whole URL;
- the download uses idle (read and connect) timeouts, not a total one, and
  the push a total scaled to the blob's size (aiohttp's read timeout starts
  only after the upload), so neither cuts off a real model file.

A real aiohttp server on loopback stands in for both the download host and
Ollama, so nothing leaves the machine.

Run from apps/server:

    python -m pytest tests/test_ollama_download_status.py
"""

import asyncio
import hashlib
import json
import os

import aiohttp
import pytest
from aiohttp import web

from local_llm.routers import ollama

PAYLOAD = os.urandom(256 * 1024 + 77)


def _download(monkeypatch, tmp_path, handler, partial: bytes | None = None):
    received: dict[str, bytes] = {}
    seen_ranges: list[str | None] = []

    async def gguf(request):
        seen_ranges.append(request.headers.get('Range'))
        return await handler(request)

    async def blobs(request):
        received[request.match_info['digest']] = await request.read()
        return web.Response(status=201)

    file_path = str(tmp_path / 'm.gguf.part')
    if partial is not None:
        with open(file_path, 'wb') as fh:
            fh.write(partial)

    async def run():
        app = web.Application(client_max_size=64 * 1024 * 1024)
        app.router.add_get('/m.gguf', gguf)
        app.router.add_post('/api/blobs/{digest}', blobs)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, '127.0.0.1', 0)
        await site.start()
        port = runner.addresses[0][1]
        session = aiohttp.ClientSession(trust_env=False)

        async def fresh_session():
            return session

        monkeypatch.setattr(ollama, 'get_session', fresh_session)
        base = f'http://127.0.0.1:{port}'
        events, error = [], None
        try:
            async for event in ollama.download_file_stream(base, f'{base}/m.gguf', file_path, 'm.gguf'):
                events.append(json.loads(event.removeprefix('data: ').strip()))
        except RuntimeError as exc:
            error = exc
        finally:
            await session.close()
            await runner.cleanup()
        return events, received, file_path, error, seen_ranges

    return asyncio.run(run())


def _blob(payload: bytes) -> str:
    return f'sha256:{hashlib.sha256(payload).hexdigest()}'


async def _ok(request):
    return web.Response(body=PAYLOAD)


def _respecting_range(request):
    start = int(request.headers['Range'].removeprefix('bytes=').removesuffix('-'))
    return web.Response(
        status=206,
        body=PAYLOAD[start:],
        headers={'Content-Range': f'bytes {start}-{len(PAYLOAD) - 1}/{len(PAYLOAD)}'},
    )


# A fresh download


@pytest.mark.parametrize('status', [401, 403, 404, 500])
def test_a_failed_download_raises_and_saves_nothing(monkeypatch, tmp_path, status):
    async def refused(request):
        return web.Response(status=status, text='<html>no model here</html>')

    events, received, file_path, error, _ = _download(monkeypatch, tmp_path, refused)

    assert isinstance(error, RuntimeError)
    assert str(status) in str(error)
    assert events == []
    assert received == {}
    assert not os.path.exists(file_path)


def test_a_download_that_succeeds_is_pushed_whole(monkeypatch, tmp_path):
    events, received, file_path, error, ranges = _download(monkeypatch, tmp_path, _ok)

    assert error is None
    assert ranges == [None]
    assert received == {_blob(PAYLOAD): PAYLOAD}
    assert events[-1] == {'done': True, 'blob': _blob(PAYLOAD), 'name': 'm.gguf'}
    assert not os.path.exists(file_path)


# A resume


def test_a_resume_appends_the_range_it_asked_for(monkeypatch, tmp_path):
    async def ranged(request):
        return _respecting_range(request)

    events, received, _, error, ranges = _download(monkeypatch, tmp_path, ranged, partial=PAYLOAD[:1000])

    assert error is None
    assert ranges == ['bytes=1000-']
    assert received == {_blob(PAYLOAD): PAYLOAD}
    assert events[0]['total'] == len(PAYLOAD)


def test_a_resume_the_server_ignores_starts_over(monkeypatch, tmp_path):
    events, received, _, error, _ = _download(monkeypatch, tmp_path, _ok, partial=PAYLOAD[:1000])

    assert error is None
    assert received == {_blob(PAYLOAD): PAYLOAD}
    assert events[-2]['completed'] == len(PAYLOAD)


def test_a_resume_of_a_complete_file_pushes_it(monkeypatch, tmp_path):
    async def nothing_left(request):
        return web.Response(status=416, headers={'Content-Range': f'bytes */{len(PAYLOAD)}'})

    events, received, file_path, error, _ = _download(monkeypatch, tmp_path, nothing_left, partial=PAYLOAD)

    assert error is None
    assert received == {_blob(PAYLOAD): PAYLOAD}
    assert events == [{'done': True, 'blob': _blob(PAYLOAD), 'name': 'm.gguf'}]
    assert not os.path.exists(file_path)


def test_a_resume_the_server_cannot_satisfy_removes_the_partial_file(monkeypatch, tmp_path):
    async def shorter(request):
        return web.Response(status=416, headers={'Content-Range': 'bytes */500'}, text='range not satisfiable')

    events, received, file_path, error, _ = _download(monkeypatch, tmp_path, shorter, partial=PAYLOAD[:1000])

    assert isinstance(error, RuntimeError)
    assert '416' in str(error)
    assert received == {}
    assert events == []
    assert not os.path.exists(file_path)


def test_a_resume_answered_from_the_wrong_offset_is_refused(monkeypatch, tmp_path):
    async def wrong_offset(request):
        return web.Response(
            status=206,
            body=PAYLOAD[10:],
            headers={'Content-Range': f'bytes 10-{len(PAYLOAD) - 1}/{len(PAYLOAD)}'},
        )

    events, received, file_path, error, _ = _download(monkeypatch, tmp_path, wrong_offset, partial=PAYLOAD[:1000])

    assert isinstance(error, RuntimeError)
    assert 'from byte 10' in str(error)
    assert received == {}
    assert events == []
    # Kept, the partial file would get the same wrong answer on every retry.
    assert not os.path.exists(file_path)


def test_a_resume_answered_without_a_range_is_refused(monkeypatch, tmp_path):
    async def no_range(request):
        return web.Response(status=206, body=PAYLOAD[1000:])

    events, received, file_path, error, _ = _download(monkeypatch, tmp_path, no_range, partial=PAYLOAD[:1000])

    assert isinstance(error, RuntimeError)
    assert 'without a usable range' in str(error)
    assert received == {}
    assert not os.path.exists(file_path)


def test_a_resume_answered_with_an_error_keeps_the_partial_file(monkeypatch, tmp_path):
    async def unavailable(request):
        return web.Response(status=503, text='try later')

    events, received, file_path, error, _ = _download(monkeypatch, tmp_path, unavailable, partial=PAYLOAD[:1000])

    assert isinstance(error, RuntimeError)
    assert '503' in str(error)
    assert received == {}
    with open(file_path, 'rb') as fh:
        assert fh.read() == PAYLOAD[:1000]


# Where partial files go, and how long a request may take


def test_partial_files_are_named_by_the_whole_url(tmp_path):
    first = ollama.partial_download_path('https://huggingface.co/a/resolve/main/m.gguf', 'm.gguf', str(tmp_path))
    second = ollama.partial_download_path('https://huggingface.co/b/resolve/main/m.gguf', 'm.gguf', str(tmp_path))

    assert first and second and first != second
    assert os.path.dirname(first) == os.path.realpath(tmp_path)
    assert os.path.basename(first).startswith('m.gguf.')
    assert ollama.partial_download_path('https://huggingface.co/x/..', '..', str(tmp_path)) is None
    assert ollama.partial_download_path('https://huggingface.co/x/', None, str(tmp_path)) is None
    long_name = ollama.partial_download_path('https://huggingface.co/x/' + 'n' * 250, 'n' * 250, str(tmp_path))
    assert long_name is not None
    assert len(os.path.basename(long_name)) <= 255


def test_the_download_has_idle_timeouts_and_no_total():
    timeout = ollama.DOWNLOAD_TIMEOUT
    assert timeout.total is None
    assert timeout.sock_connect and timeout.sock_read


def test_the_push_is_limited_by_the_blob_size():
    small = ollama.blob_push_timeout(1024)
    large = ollama.blob_push_timeout(20 * 1024**3)

    assert small.total == ollama.BLOB_PUSH_MIN_SECONDS
    assert large.total == 20 * 1024**3 / ollama.BLOB_PUSH_BYTES_PER_SECOND
    assert large.sock_connect and large.sock_read


def test_a_push_that_stalls_is_cut_off(monkeypatch, tmp_path):
    """An Ollama that accepts the push and stops reading no longer holds it for good."""
    monkeypatch.setattr(ollama, 'BLOB_PUSH_MIN_SECONDS', 1)
    payload = os.urandom(8 * 1024 * 1024)
    blob_started = asyncio.Event()

    async def run():
        async def gguf(request):
            return web.Response(body=payload)

        async def stalled(request):
            blob_started.set()
            await asyncio.sleep(5)
            return web.Response(status=201)

        app = web.Application(client_max_size=64 * 1024 * 1024)
        app.router.add_get('/m.gguf', gguf)
        app.router.add_post('/api/blobs/{digest}', stalled)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, '127.0.0.1', 0)
        await site.start()
        port = runner.addresses[0][1]
        session = aiohttp.ClientSession(trust_env=False)

        async def fresh_session():
            return session

        monkeypatch.setattr(ollama, 'get_session', fresh_session)
        base = f'http://127.0.0.1:{port}'

        async def consume():
            try:
                async for _ in ollama.download_file_stream(base, f'{base}/m.gguf', str(tmp_path / 'm.part'), 'm.gguf'):
                    pass
            except TimeoutError:
                return 'cut off by the push timeout'
            return 'finished'

        try:
            # The outer limit cancels consume(), which then raises no TimeoutError of its own.
            return await asyncio.wait_for(consume(), timeout=4)
        except TimeoutError:
            return 'still stalled'
        finally:
            await session.close()
            await runner.cleanup()

    assert asyncio.run(run()) == 'cut off by the push timeout'
