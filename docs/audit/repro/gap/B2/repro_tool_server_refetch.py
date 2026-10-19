import asyncio
from types import SimpleNamespace
from local_llm.utils import tools as T

fetches = 0
async def fake_data(connections):
    global fetches; fetches += 1
    return [{'id': 's1', 'idx': 0, 'url': 'http://x', 'openapi': {}, 'info': {}, 'specs': []}]

async def fake_config_get(key, default=None):
    return [{'url': 'http://x', 'config': {'enable': True}}]

T.get_tool_servers_data = fake_data
T.Config = SimpleNamespace(get=fake_config_get)

async def main():
    app = SimpleNamespace(state=SimpleNamespace(redis=None))
    req = SimpleNamespace(app=app)
    await T.set_tool_servers(req)           # what startup does (main.py:413)
    print('after startup: fetches =', fetches, 'cached =', app.state.TOOL_SERVERS)
    for _ in range(3):
        await T.get_tool_servers(req)       # each chat with a tool server / each tools list
    print('after 3 get_tool_servers calls: fetches =', fetches)

asyncio.run(main())
