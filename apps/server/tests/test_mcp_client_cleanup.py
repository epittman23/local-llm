"""MCP clients are disconnected when tool setup fails after they connect (#169).

A connected MCPClient holds an httpx client, a streamable-HTTP task group
and a session. The chat teardown (main._disconnect_mcp_clients) closes only
the clients listed in metadata['mcp_clients'], so a client that connects and
is then dropped by a failing step leaks all three. The MCP client is a fake
here: no MCP server is started.
"""

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm import main
from local_llm.utils import middleware


class _FakeClient:
    def __init__(self, list_error=None):
        self.list_error = list_error
        self.connected = False
        self.disconnects = 0

    async def connect(self, url, headers=None):
        self.connected = True

    async def list_tool_specs(self):
        if self.list_error:
            raise self.list_error
        return [{'name': 'search', 'description': '', 'parameters': {}}]

    async def disconnect(self):
        self.connected = False
        self.disconnects += 1


def test_connect_mcp_server_disconnects_when_listing_tools_fails(monkeypatch):
    client = _FakeClient(list_error=RuntimeError('tools/list failed'))
    connection = {'type': 'mcp', 'url': 'http://mcp.test', 'info': {'id': 'docs'}, 'config': {}}

    async def config_get(key, default=None):
        return [connection]

    async def allow(user, server_connection):
        return True

    async def headers(*args, **kwargs):
        return {}, None

    monkeypatch.setattr(middleware, 'Config', SimpleNamespace(get=config_get))
    monkeypatch.setattr(middleware, 'has_connection_access', allow)
    monkeypatch.setattr(middleware, 'build_tool_server_headers', headers)
    monkeypatch.setattr(middleware, 'MCPClient', lambda: client)

    with pytest.raises(RuntimeError, match='tools/list failed'):
        asyncio.run(middleware.connect_mcp_server(None, 'docs', SimpleNamespace(id='u1'), {}, {}))

    assert client.disconnects == 1
    assert not client.connected


async def _no_terminal(request, terminal_id, user, extra_params):
    raise RuntimeError('terminal offline')


async def _no_db_tools(request, tool_ids, user, extra_params):
    raise RuntimeError('tool module failed to load')


@pytest.mark.parametrize(
    ('tool_ids', 'terminal_id', 'failure', 'expected'),
    [
        (['server:mcp:docs'], 'term-1', ('get_terminal_tools', _no_terminal), HTTPException),
        (['server:mcp:docs', 'calc'], None, ('get_tools', _no_db_tools), RuntimeError),
    ],
    ids=['terminal_unavailable', 'db_tools_fail'],
)
def test_clients_reach_teardown_when_a_later_setup_step_fails(monkeypatch, tool_ids, terminal_id, failure, expected):
    client = _FakeClient()

    async def connect(request, server_id, user, metadata, extra_params):
        await client.connect('http://mcp.test')
        return client, await client.list_tool_specs()

    monkeypatch.setattr(middleware, 'connect_mcp_server', connect)
    monkeypatch.setattr(middleware, failure[0], failure[1])
    monkeypatch.setattr(middleware, 'ENABLE_PLUGINS', True)

    metadata = {'tool_ids': tool_ids}
    form_data = {'messages': [{'role': 'user', 'content': 'hi'}], 'metadata': metadata}
    model = {'id': 'm1', 'info': {'meta': {}}}

    async def run():
        try:
            await middleware._resolve_payload_tools(
                None,
                form_data,
                SimpleNamespace(id='u1'),
                model,
                metadata,
                {},
                {'m1': model},
                'm1',
                None,
                terminal_id,
                False,
                [],
                {},
                False,
                [],
                [],
            )
        finally:
            await main._disconnect_mcp_clients(metadata)

    with pytest.raises(expected):
        asyncio.run(run())

    assert metadata['mcp_clients'] == {'docs': client}
    assert client.disconnects == 1
    assert not client.connected
