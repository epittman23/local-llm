import asyncio
import logging
from contextlib import AsyncExitStack

import anyio
import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.types import PaginatedRequestParams
from local_llm.env import (
    AIOHTTP_CLIENT_SESSION_TOOL_SERVER_SSL,
    MCP_INITIALIZE_TIMEOUT,
)

log = logging.getLogger(__name__)

# The MCP SDK's own defaults for a streamable-HTTP client: 30 s to connect
# and write, 300 s to read, so the long-lived server-to-client stream stays
# open. (A bare httpx2 client would time it out after 5 s.)
MCP_DEFAULT_TIMEOUT = httpx2.Timeout(30, read=300)


def _build_httpx_client(headers=None, timeout=None, auth=None, verify=True):
    """Create the httpx2 AsyncClient the MCP SDK (v2) sends its requests with.

    It must be an httpx2 client, not httpx: the SDK checks the type, and an
    httpx client degrades silently (server-initiated messages stop arriving).

    Timeout: the caller's, else MCP_DEFAULT_TIMEOUT. (Under mcp v1 the SDK
    always passed its own 30/300 s timeout to this factory, so that is the
    behavior kept; AIOHTTP_CLIENT_TIMEOUT_TOOL_SERVER never applied here.)

    Note: verify must be passed at construction time because httpx2
    configures the SSL context during __init__. Setting client.verify = False
    after construction does not affect the underlying transport's SSL context.
    """
    kwargs = {
        'follow_redirects': True,
        'verify': verify,
    }
    kwargs['timeout'] = timeout if timeout is not None else MCP_DEFAULT_TIMEOUT
    if headers is not None:
        kwargs['headers'] = headers
    if auth is not None:
        kwargs['auth'] = auth
    return httpx2.AsyncClient(**kwargs)


def create_httpx_client(headers=None, timeout=None, auth=None):
    # AIOHTTP_CLIENT_SESSION_TOOL_SERVER_SSL may be True, False, or an
    # ssl.SSLContext (when a custom CA bundle path is configured).
    # httpx2's verify= accepts bool | ssl.SSLContext, which covers all three.
    ssl_setting = AIOHTTP_CLIENT_SESSION_TOOL_SERVER_SSL
    verify = ssl_setting if ssl_setting is not True else True
    return _build_httpx_client(headers=headers, timeout=timeout, auth=auth, verify=verify)


def create_insecure_httpx_client(headers=None, timeout=None, auth=None):
    return _build_httpx_client(headers=headers, timeout=timeout, auth=auth, verify=False)


class MCPClient:
    def __init__(self):
        self.session: ClientSession | None = None
        self.exit_stack = None

    async def connect(self, url: str, headers: dict | None = None):
        async with AsyncExitStack() as exit_stack:
            try:
                make_client = (
                    create_httpx_client if AIOHTTP_CLIENT_SESSION_TOOL_SERVER_SSL else create_insecure_httpx_client
                )
                http_client = await exit_stack.enter_async_context(make_client(headers=headers))
                self._streams_context = streamable_http_client(url, http_client=http_client)

                read_stream, write_stream = await exit_stack.enter_async_context(self._streams_context)

                self._session_context = ClientSession(read_stream, write_stream)  # pylint: disable=W0201

                self.session = await exit_stack.enter_async_context(self._session_context)
                with anyio.fail_after(MCP_INITIALIZE_TIMEOUT):
                    await self.session.initialize()
                self.exit_stack = exit_stack.pop_all()
            except Exception as e:
                await self.disconnect()
                raise e

    async def list_tool_specs(self) -> dict | None:
        if not self.session:
            raise RuntimeError('MCP client is not connected.')

        result = await self.session.list_tools()
        tools = result.tools

        tool_specs = []
        for tool in tools:
            name = tool.name
            description = tool.description

            tool_specs.append({'name': name, 'description': description, 'parameters': tool.input_schema})

        return tool_specs

    async def call_tool(self, function_name: str, function_args: dict) -> dict | None:
        if not self.session:
            raise RuntimeError('MCP client is not connected.')

        result = await self.session.call_tool(function_name, function_args)
        if not result:
            raise Exception('No result returned from MCP tool call.')

        # by_alias: the MCP wire format (camelCase, e.g. `mimeType`), which is
        # what middleware.py reads; a plain v2 model_dump() is snake_case.
        result_dict = result.model_dump(mode='json', by_alias=True)
        result_content = result_dict.get('content', {})

        if result.is_error:
            raise Exception(result_content)
        else:
            return result_content

    async def list_resources(self, cursor: str | None = None) -> dict | None:
        if not self.session:
            raise RuntimeError('MCP client is not connected.')

        result = await self.session.list_resources(
            params=PaginatedRequestParams(cursor=cursor) if cursor is not None else None
        )
        if not result:
            raise Exception('No result returned from MCP list_resources call.')

        result_dict = result.model_dump(by_alias=True)
        resources = result_dict.get('resources', [])

        return resources

    async def read_resource(self, uri: str) -> dict | None:
        if not self.session:
            raise RuntimeError('MCP client is not connected.')

        result = await self.session.read_resource(uri)
        if not result:
            raise Exception('No result returned from MCP read_resource call.')
        result_dict = result.model_dump(by_alias=True)

        return result_dict

    async def disconnect(self):
        """Clean up and close the session.

        This method is idempotent — calling it multiple times or on a
        client that was never connected is safe.
        """
        exit_stack = self.exit_stack
        if exit_stack is None:
            return

        # Prevent double-close from concurrent callers
        self.exit_stack = None
        self.session = None

        try:
            # IMPORTANT: Do NOT use asyncio.shield() or asyncio.wait_for()
            # because they create a new asyncio task, which violates the MCP SDK's
            # requirement that its TaskGroup be exited in the exact same task.
            # ALSO do NOT use anyio.CancelScope(shield=True) or anyio.fail_after(),
            # because they push a new cancel scope onto the task, violating LIFO
            # order when aclose() attempts to exit the inner TaskGroup.
            # We simply call aclose() directly. If the task is cancelled, the
            # sockets will eventually be cleaned up by garbage collection.
            await exit_stack.aclose()
        except asyncio.CancelledError as exc:
            task = asyncio.current_task()
            if task is not None and task.cancelling():
                raise
            log.debug('MCPClient.disconnect() suppressed internal cancellation: %s', exc)
        except RuntimeError as exc:
            log.debug('MCPClient.disconnect() suppressed RuntimeError: %s', exc)
        except Exception as exc:
            log.debug('MCPClient.disconnect() error: %s', exc)

    async def __aenter__(self):
        await self.exit_stack.__aenter__()
        return self

    async def __aexit__(self, exc_type, exc_value, traceback):
        await self.exit_stack.__aexit__(exc_type, exc_value, traceback)
        await self.disconnect()
