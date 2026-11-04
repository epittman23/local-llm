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
        return [
            {'name': 'search', 'description': '', 'parameters': {}},
            {'name': 'fetch', 'description': '', 'parameters': {}},
        ]

    async def disconnect(self):
        self.connected = False
        self.disconnects += 1


def _connect(monkeypatch, client, config=None):
    connection = {'type': 'mcp', 'url': 'http://mcp.test', 'info': {'id': 'docs'}, 'config': config or {}}

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
    return asyncio.run(middleware.connect_mcp_server(None, 'docs', SimpleNamespace(id='u1'), {}, {}))


@pytest.mark.parametrize(
    'error',
    [RuntimeError('tools/list failed'), asyncio.CancelledError()],
    ids=['listing_fails', 'stopped_while_listing'],
)
def test_connect_mcp_server_disconnects_when_listing_tools_fails(monkeypatch, error):
    """Stopping a chat while tools/list is pending cancels it, which is not an Exception."""
    client = _FakeClient(list_error=error)

    with pytest.raises(type(error)):
        _connect(monkeypatch, client)

    assert client.disconnects == 1
    assert not client.connected


def test_connect_mcp_server_keeps_a_listed_client_open(monkeypatch):
    client = _FakeClient()

    got, specs = _connect(monkeypatch, client, {'function_name_filter_list': 'search'})

    assert got is client
    assert [s['name'] for s in specs] == ['search']
    assert client.connected and client.disconnects == 0


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


def test_a_server_listed_twice_connects_once(monkeypatch):
    """`tool_ids` naming one MCP server twice must not connect it twice (#521).

    The second client overwrote the first in mcp_clients, so the teardown
    never disconnected the first one.
    """
    clients = []

    async def connect(request, server_id, user, metadata, extra_params):
        client = _FakeClient()
        clients.append(client)
        await client.connect('http://mcp.test')
        return client, await client.list_tool_specs()

    monkeypatch.setattr(middleware, 'connect_mcp_server', connect)
    metadata = {'tool_ids': ['server:mcp:docs', 'server:mcp:docs']}
    mcp_clients = {}

    async def run():
        try:
            return await middleware._selected_tools(
                None, {'messages': []}, SimpleNamespace(id='u1'), metadata, {}, {'m1': {}}, 'm1', None, mcp_clients
            )
        finally:
            metadata['mcp_clients'] = mcp_clients
            await main._disconnect_mcp_clients(metadata)

    tools = asyncio.run(run())

    assert len(clients) == 1
    assert sorted(tools) == ['docs_fetch', 'docs_search']
    assert not clients[0].connected


def test_a_tool_listed_twice_is_loaded_once(monkeypatch):
    """A database tool id given twice is asked for once (#521)."""
    asked = []

    async def get_tools(request, tool_ids, user, extra_params):
        asked.append(list(tool_ids))
        return {}

    monkeypatch.setattr(middleware, 'get_tools', get_tools)
    monkeypatch.setattr(middleware, 'ENABLE_PLUGINS', True)
    metadata = {'tool_ids': ['calc', 'calc', 'web']}

    asyncio.run(
        middleware._selected_tools(
            None, {'messages': []}, SimpleNamespace(id='u1'), metadata, {}, {'m1': {}}, 'm1', None, {}
        )
    )

    assert asked == [['calc', 'web']]
