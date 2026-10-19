"""Replicates routers/pipelines.py error handling: raise_for_status inside
`async with session.post(...) as response`, then response.json() in the except."""
import asyncio
import aiohttp
from aiohttp import web


async def handler(request):
    return web.json_response({'detail': 'Pipeline server says: invalid valves'}, status=400)


async def main():
    app = web.Application()
    app.router.add_post('/x/valves/update', handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    url = f'http://127.0.0.1:{port}/x/valves/update'

    response = None
    detail = None
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json={}) as response:
                response.raise_for_status()
                data = await response.json()
    except Exception as e:
        print('caught:', type(e).__name__, e)
        if response is not None:
            try:
                res = await response.json()
                print('res after context exit:', res)
                if 'detail' in res:
                    detail = res['detail']
            except Exception as e2:
                print('response.json() after exit raised:', type(e2).__name__, e2)
    print('final detail sent to client:', detail if detail else 'Pipeline not found')
    await runner.cleanup()


asyncio.run(main())
