"""A tool server saved without a name is listed by its spec's title, its URL or a default (#618).

The admin's Add/Edit tool server dialog saves `info.name` as `''` when the
field is left empty, and the backend kept that empty string as the name the
tool list gives the chat's Integrations menu, which showed a blank row with
an empty switch label. A blank name (empty or only spaces) now falls back:
for an OpenAPI server to its spec's own title, then its URL's host; for an
MCP server to its URL's host; and then to the old default label. Only the
host: the list reaches every user with access, and a URL's path, query or
userinfo can carry a credential.

Run from apps/server:

    python -m pytest tests/test_tool_server_names.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from local_llm.routers import tools as tools_router
from local_llm.utils import tools as tools_utils

ADMIN = SimpleNamespace(id='admin-1', role='admin')


def _names(monkeypatch, connections, servers):
    async def config_get(key, default=None):
        assert key == 'tool_server.connections'
        return connections

    async def tool_servers(request):
        return servers

    async def no_tools(**kwargs):
        return []

    monkeypatch.setattr(tools_router.Config, 'get', config_get)
    monkeypatch.setattr(tools_router, 'get_tool_servers', tool_servers)
    monkeypatch.setattr(tools_router.Tools, 'get_tools', no_tools)
    monkeypatch.setattr(tools_router, 'BYPASS_ADMIN_ACCESS_CONTROL', True)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(TOOLS={})))
    return [tool.name for tool in asyncio.run(tools_router.get_tools(request, user=ADMIN, db=None))]


def _openapi(title):
    info = {} if title is None else {'title': title}
    return {'id': 'a', 'idx': 0, 'openapi': {'info': info}}


def _mcp(name, url='https://mcp.example/sse'):
    info = {'id': 'm'} if name is None else {'id': 'm', 'name': name}
    return {'type': 'mcp', 'url': url, 'config': {'enable': True}, 'info': info}


@pytest.mark.parametrize(
    ('title', 'shown'),
    [
        ('Search', 'Search'),
        ('', 'tools.example'),
        ('   ', 'tools.example'),
        (None, 'tools.example'),
    ],
)
def test_an_openapi_server_without_a_title_is_listed_by_its_host(monkeypatch, title, shown):
    connections = [{'type': 'openapi', 'url': 'https://tools.example', 'config': {}}]

    assert _names(monkeypatch, connections, [_openapi(title)]) == [shown]


def test_an_openapi_server_without_a_title_or_url_gets_the_default_label(monkeypatch):
    assert _names(monkeypatch, [{'type': 'openapi', 'config': {}}], [_openapi('')]) == ['Tool Server']


@pytest.mark.parametrize(
    ('name', 'url', 'shown'),
    [
        ('Files', 'https://mcp.example/sse', 'Files'),
        ('', 'https://mcp.example/sse', 'mcp.example'),
        (' ', 'https://mcp.example/sse', 'mcp.example'),
        (None, 'https://mcp.example/sse', 'mcp.example'),
        ('', 'http://127.0.0.1:8811/mcp', '127.0.0.1:8811'),
        # Nothing but the host: the path, query and userinfo can hold a secret.
        ('', 'https://u:p@mcp.example/api/mcp/s/secret/mcp?api_key=k', 'mcp.example'),
        ('', '', 'MCP Tool Server'),
        ('', 'not a url', 'MCP Tool Server'),
        ('', 'http://[bad', 'MCP Tool Server'),
    ],
)
def test_an_mcp_server_without_a_name_is_listed_by_its_host(monkeypatch, name, url, shown):
    assert _names(monkeypatch, [_mcp(name, url)], []) == [shown]


@pytest.mark.parametrize(('name', 'title'), [('Mine', 'Mine'), ('', 'Spec Title'), ('  ', 'Spec Title')])
def test_a_blank_name_leaves_the_specs_own_title(name, title):
    # get_tool_servers_data gives the spec the connection's name as its title;
    # a blank one no longer replaces the spec's own.
    server = {
        'type': 'openapi',
        'url': 'https://tools.example',
        'auth_type': 'none',
        'spec_type': 'json',
        'spec': '{"openapi": "3.1.0", "info": {"title": "Spec Title"}, "paths": {}}',
        'config': {'enable': True},
        'info': {'id': 's1', 'name': name, 'description': ''},
    }
    [data] = asyncio.run(tools_utils.get_tool_servers_data([server]))

    assert data['openapi']['info']['title'] == title
