"""download_file_stream: a 200 download whose last network read is small. Is the pushed blob complete?"""
import asyncio, os, tempfile, hashlib
from aiohttp import web
import local_llm.routers.ollama as o

received = {}
PAYLOAD = os.urandom(3 * 1024 * 1024 + 1500)  # 3 MiB + 1500 bytes

async def gguf(request):
    resp = web.StreamResponse(status=200, headers={'Content-Length': str(len(PAYLOAD))})
    await resp.prepare(request)
    await resp.write(PAYLOAD[:-1500]); await asyncio.sleep(0.2)
    await resp.write(PAYLOAD[-1500:])   # the tail arrives as its own small read
    await resp.write_eof()
    return resp

async def blobs(request):
    received[request.match_info['digest']] = await request.read()
    return web.Response(status=201)

async def main():
    app = web.Application(client_max_size=64 * 1024 * 1024)
    app.router.add_get('/m.gguf', gguf)
    app.router.add_post('/api/blobs/{digest}', blobs)
    runner = web.AppRunner(app); await runner.setup()
    await web.TCPSite(runner, '127.0.0.1', 8766).start()
    fp = os.path.join(tempfile.mkdtemp(), 'm.gguf')
    last = None
    async for ev in o.download_file_stream('http://127.0.0.1:8766', 'http://127.0.0.1:8766/m.gguf', fp, 'm.gguf'):
        last = ev.strip()
    print('last event      :', last)
    print('source size     :', len(PAYLOAD), 'sha256', hashlib.sha256(PAYLOAD).hexdigest()[:16])
    for k, v in received.items():
        print('blob pushed size:', len(v), 'sha256', hashlib.sha256(v).hexdigest()[:16], '(digest in URL', k[7:23] + ')')
    await runner.cleanup()

asyncio.run(main())
