import asyncio, json
from aiohttp import web
from local_llm.utils import tools as T

seen = []

async def handler(request):
    body = await request.text()
    seen.append({'method': request.method, 'url': str(request.rel_url),
                 'x-api-version': request.headers.get('X-Api-Version'), 'body': body})
    return web.json_response({'ok': True})

spec = {
    'openapi': '3.0.0', 'info': {'title': 't'},
    'paths': {
        '/items': {
            'get': {'operationId': 'list_items', 'parameters': [
                {'name': 'X-Api-Version', 'in': 'header', 'required': True, 'schema': {'type': 'string'}},
                {'name': 'q', 'in': 'query', 'schema': {'type': 'string'}}]},
            'post': {'operationId': 'bulk_add', 'requestBody': {'content': {'application/json': {
                'schema': {'type': 'array', 'items': {'type': 'string'}}}}}},
        },
        '/users/{id}': {
            'put': {'operationId': 'put_user', 'parameters': [{'name': 'id', 'in': 'path', 'required': True, 'schema': {'type': 'string'}}],
                    'requestBody': {'content': {'application/json': {'schema': {'type': 'object', 'required': ['id', 'name'],
                        'properties': {'id': {'type': 'string'}, 'name': {'type': 'string'}}}}}}},
        },
    },
}

async def main():
    payload = T.convert_openapi_to_tool_payload(spec)
    for p in payload:
        print('SPEC', p['name'], json.dumps(p['parameters']))
    app = web.Application(); app.router.add_route('*', '/{tail:.*}', handler)
    runner = web.AppRunner(app); await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0); await site.start()
    port = site._server.sockets[0].getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    sd = {'openapi': spec}
    print(await T.execute_tool_server(url, {}, {}, 'list_items', {'X-Api-Version': '2', 'q': 'a'}, sd))
    # what the model can send for the array-body tool: kwargs only (a dict)
    print(await T.execute_tool_server(url, {}, {}, 'bulk_add', {'items': ['a', 'b']}, sd))
    print(await T.execute_tool_server(url, {}, {}, 'put_user', {'id': 'u1', 'name': 'N'}, sd))
    for s in seen: print('SERVER SAW', s)
    await runner.cleanup()

asyncio.run(main())
