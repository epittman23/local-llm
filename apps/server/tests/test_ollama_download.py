"""A model downloaded by URL reaches Ollama whole (routers/ollama.py download_file_stream).

The download is written to a local file, hashed, pushed to Ollama as a
blob and deleted. The hash and the push once ran while the file was still
open for writing, so its last buffered bytes were missing from both: Ollama
accepted the truncated blob (its digest matched the truncated bytes), the
stream reported done, and the local copy was gone (#340).

A real aiohttp server on loopback stands in for both the download host and
Ollama, so nothing leaves the machine.

Run from apps/server:

    python -m pytest tests/test_ollama_download.py
"""

import asyncio
import hashlib
import json
import os

import aiohttp
from aiohttp import web

from local_llm.routers import ollama

# 3 MiB plus a tail that arrives as its own small read.
PAYLOAD = os.urandom(3 * 1024 * 1024 + 1500)


def _serve_and_download(monkeypatch, tmp_path, blob_status=201):
    received: dict[str, bytes] = {}

    async def gguf(request):
        resp = web.StreamResponse(status=200, headers={'Content-Length': str(len(PAYLOAD))})
        await resp.prepare(request)
        await resp.write(PAYLOAD[:-1500])
        await asyncio.sleep(0.05)
        await resp.write(PAYLOAD[-1500:])
        await resp.write_eof()
        return resp

    async def blobs(request):
        received[request.match_info['digest']] = await request.read()
        return web.Response(status=blob_status)

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
        file_path = str(tmp_path / 'm.gguf')
        events, error = [], None
        try:
            async for event in ollama.download_file_stream(base, f'{base}/m.gguf', file_path, 'm.gguf'):
                events.append(json.loads(event.removeprefix('data: ').strip()))
        except RuntimeError as exc:
            error = exc
        finally:
            await session.close()
            await runner.cleanup()
        return events, received, file_path, error

    return asyncio.run(run())


def test_the_pushed_blob_is_the_whole_download(monkeypatch, tmp_path):
    events, received, file_path, error = _serve_and_download(monkeypatch, tmp_path)

    assert error is None
    digest = hashlib.sha256(PAYLOAD).hexdigest()
    assert list(received) == [f'sha256:{digest}']
    assert received[f'sha256:{digest}'] == PAYLOAD
    assert events[-1] == {'done': True, 'blob': f'sha256:{digest}', 'name': 'm.gguf'}
    assert not os.path.exists(file_path)


def test_a_refused_blob_keeps_the_download(monkeypatch, tmp_path):
    events, received, file_path, error = _serve_and_download(monkeypatch, tmp_path, blob_status=500)

    assert isinstance(error, RuntimeError)
    assert not any(e.get('done') for e in events)
    with open(file_path, 'rb') as fh:
        assert fh.read() == PAYLOAD
