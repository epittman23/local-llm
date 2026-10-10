"""MCPClient against a real MCP server over streamable HTTP.

Added with the move to mcp v2, which changed the transport (an httpx2 client
passed in, a 2-tuple of streams), renamed result fields to snake_case, and
made a plain model_dump() snake_case too. middleware.py reads the results in
the MCP wire format (`mimeType`, `inputSchema`-shaped `parameters`), so these
tests pin that shape, not just that a call succeeds.
"""

import asyncio
import base64
import socket
import threading
import time

import pytest
import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.types import ImageContent

from open_webui.utils.mcp.client import MCPClient

PIXEL = base64.b64encode(b'\x89PNG\r\n\x1a\n').decode()


def _server() -> MCPServer:
    server = MCPServer('test-server')

    @server.tool()
    def add(a: int, b: int) -> str:
        """Add two numbers."""
        return str(a + b)

    @server.tool()
    def picture() -> ImageContent:
        """Return a tiny image."""
        return ImageContent(type='image', data=PIXEL, mime_type='image/png')

    @server.tool()
    def broken() -> str:
        """Always fails."""
        raise ValueError('nope')

    @server.resource('notes://greeting', mime_type='text/plain')
    def greeting() -> str:
        return 'hello'

    return server


@pytest.fixture(scope='module')
def mcp_url():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
    config = uvicorn.Config(_server().streamable_http_app(), host='127.0.0.1', port=port, log_level='warning')
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 15
    while not server.started:
        if time.monotonic() > deadline:
            raise RuntimeError('MCP test server did not start')
        time.sleep(0.05)
    yield f'http://127.0.0.1:{port}/mcp'
    server.should_exit = True
    thread.join(timeout=10)


def _run(coro):
    return asyncio.run(coro)


async def _with_client(url, fn):
    client = MCPClient()
    await client.connect(url)
    try:
        return await fn(client)
    finally:
        await client.disconnect()


def test_lists_tools_with_their_input_schema(mcp_url):
    specs = _run(_with_client(mcp_url, lambda c: c.list_tool_specs()))
    add = next(s for s in specs if s['name'] == 'add')
    assert add['description'] == 'Add two numbers.'
    assert add['parameters']['type'] == 'object'
    assert set(add['parameters']['properties']) == {'a', 'b'}


def test_call_tool_returns_wire_format_content(mcp_url):
    text = _run(_with_client(mcp_url, lambda c: c.call_tool('add', {'a': 2, 'b': 3})))
    assert text[0]['type'] == 'text'
    assert text[0]['text'] == '5'

    image = _run(_with_client(mcp_url, lambda c: c.call_tool('picture', {})))
    # camelCase, as middleware.py reads it (`item.get("mimeType")`).
    assert (image[0]['type'], image[0]['data'], image[0]['mimeType']) == ('image', PIXEL, 'image/png')
    assert 'mime_type' not in image[0]


def test_a_failing_tool_raises(mcp_url):
    # The server reports an unexpected exception without its message.
    with pytest.raises(Exception, match='Error executing tool broken'):
        _run(_with_client(mcp_url, lambda c: c.call_tool('broken', {})))


def test_resources_list_and_read_in_wire_format(mcp_url):
    resources = _run(_with_client(mcp_url, lambda c: c.list_resources()))
    assert any(r['uri'] == 'notes://greeting' and r['mimeType'] == 'text/plain' for r in resources)

    read = _run(_with_client(mcp_url, lambda c: c.read_resource('notes://greeting')))
    assert read['contents'][0]['text'] == 'hello'
    assert read['contents'][0]['mimeType'] == 'text/plain'
