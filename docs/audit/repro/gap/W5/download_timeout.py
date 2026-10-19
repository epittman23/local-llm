"""download_file_stream: the blob push is capped at 30 s in total, however large the file.
The fake Ollama accepts the body at ~1 MiB/s, standing in for a multi-GB GGUF on a slower link."""
import asyncio, os, tempfile, time
from aiohttp import web
import local_llm.routers.ollama as o

PAYLOAD = os.urandom(40 * 1024 * 1024)

async def gguf(request):
    return web.Response(body=PAYLOAD)

async def blobs(request):
    n = 0
    async for chunk in request.content.iter_chunked(1024 * 1024):
        n += len(chunk); await asyncio.sleep(1)  # ~1 MiB/s
    return web.Response(status=201)

async def main():
    app = web.Application(client_max_size=1024 ** 3)
    app.router.add_get('/m.gguf', gguf)
    app.router.add_post('/api/blobs/{digest}', blobs)
    runner = web.AppRunner(app); await runner.setup()
    await web.TCPSite(runner, '127.0.0.1', 8768).start()
    fp = os.path.join(tempfile.mkdtemp(), 'm.gguf')
    t = time.monotonic(); last = None
    try:
        async for ev in o.download_file_stream('http://127.0.0.1:8768', 'http://127.0.0.1:8768/m.gguf', fp, 'm.gguf'):
            last = ev.strip()
        print('finished:', last)
    except BaseException as e:
        print(f'raised after {time.monotonic() - t:.1f}s:', type(e).__name__, e, '| last event:', last[:60])
        print('downloaded file still on disk:', os.path.exists(fp), os.path.getsize(fp))
    await runner.cleanup()

asyncio.run(main())
