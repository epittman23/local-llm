"""Calls the real routers/pipelines.py handlers against a local stand-in for a
Pipelines server that rejects the request with a JSON detail."""
import asyncio
import types

from aiohttp import web
from fastapi import HTTPException

import local_llm.routers.pipelines as pr

published = []


async def reject(request):
    return web.json_response({'detail': 'Rate limit exceeded: 10 requests per minute'}, status=429)


async def ok(request):
    return web.json_response({'max_tokens': 5})


async def fake_publish(request, event, **kw):
    published.append(event.name)


async def main():
    app = web.Application()
    app.router.add_post('/rate_limit/valves/update', reject)
    app.router.add_post('/rate_limit/filter/inlet', reject)
    app.router.add_get('/rate_limit/valves', ok)
    app.router.add_post('/rate_limit2/valves/update', ok)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    base = f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}'

    async def conn(idx):
        return base, 'key'

    pr.get_openai_connection = conn
    pr.publish_event = fake_publish
    req = types.SimpleNamespace(app=types.SimpleNamespace(state=types.SimpleNamespace()))
    admin = types.SimpleNamespace(id='a', email='a@x', name='A', role='admin')

    try:
        await pr.update_pipeline_valves(req, 0, 'rate_limit', {'requests_per_minute': 10}, user=admin)
    except HTTPException as e:
        print('update_pipeline_valves ->', e.status_code, repr(e.detail))

    models = {'gpt': {'id': 'gpt'}, 'rate_limit': {'id': 'rate_limit', 'urlIdx': 0,
              'pipeline': {'type': 'filter', 'pipelines': ['*'], 'priority': 0}}}
    try:
        await pr.process_pipeline_inlet_filter(req, {'model': 'gpt', 'messages': []}, admin, models)
    except HTTPException as e:
        print('process_pipeline_inlet_filter ->', e.status_code, repr(e.detail))

    published.clear()
    await pr.get_pipeline_valves(req, 0, 'rate_limit', user=admin)
    print('events after only READING valves:', published)
    published.clear()
    await pr.update_pipeline_valves(req, 0, 'rate_limit2', {'max_tokens': 5}, user=admin)
    print('events after UPDATING valves:', published)
    await runner.cleanup()


asyncio.run(main())
