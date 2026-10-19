"""download_file_stream against a local server: a 404 page and a 416 resume."""
import asyncio, os, tempfile, hashlib
from aiohttp import web
import local_llm.routers.ollama as o

received = {}

async def gguf_404(request):
    return web.Response(status=404, text='Entry not found')

async def gguf_416(request):
    return web.Response(status=416, text='<?xml version="1.0"?><Error><Code>InvalidRange</Code></Error>',
                        headers={'Content-Type': 'application/xml'})

async def blobs(request):
    body = await request.read()
    received[request.match_info['digest']] = body
    return web.Response(status=201)

async def run(path, preexisting=None):
    d = tempfile.mkdtemp()
    fp = os.path.join(d, 'model.gguf')
    if preexisting is not None:
        open(fp, 'wb').write(preexisting)
    events = []
    async for ev in o.download_file_stream('http://127.0.0.1:8765', f'http://127.0.0.1:8765{path}', fp, 'model.gguf'):
        events.append(ev.strip())
    return events, fp

async def main():
    app = web.Application()
    app.router.add_get('/404.gguf', gguf_404)
    app.router.add_get('/416.gguf', gguf_416)
    app.router.add_post('/api/blobs/{digest}', blobs)
    runner = web.AppRunner(app); await runner.setup()
    await web.TCPSite(runner, '127.0.0.1', 8765).start()

    events, fp = await run('/404.gguf')
    print('404 case events:', events)
    print('  blob pushed to Ollama:', {k: v for k, v in received.items()})
    received.clear()

    gguf = b'GGUF' + b'\0' * 60  # a complete download left behind by a failed blob push
    events, fp = await run('/416.gguf', preexisting=gguf)
    print('416 resume events:', events)
    for k, v in received.items():
        print('  blob pushed:', k[:20], len(v), 'bytes; ends with', v[-60:])
    await runner.cleanup()

asyncio.run(main())
