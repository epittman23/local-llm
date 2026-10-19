"""/tools/export withholds the source of tools the user can only read.

Run from apps/server:

    python -m pytest tests/test_tool_export_access.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from local_llm.models.tools import ToolMeta, ToolUserModel
from local_llm.routers import tools as tools_router


def _tool(tool_id: str, owner: str) -> ToolUserModel:
    return ToolUserModel(
        id=tool_id, user_id=owner, name=tool_id, content=f'# source of {tool_id}', specs=[], meta=ToolMeta(),
        updated_at=1, created_at=1,
    )  # fmt: skip


def test_export_strips_content_without_write_access(monkeypatch):
    readable = [_tool('mine', 'u1'), _tool('shared-ro', 'u2'), _tool('shared-rw', 'u3')]

    async def get_tools(db=None, user_id=None, permission='read', defer_content=False, **_):
        if permission == 'write':
            return [t for t in readable if t.id in {'mine', 'shared-rw'}]
        return readable

    async def has_permission(*_a, **_k):
        return True

    async def config_get(_key):
        return {}

    monkeypatch.setattr(tools_router.Tools, 'get_tools', get_tools)
    monkeypatch.setattr(tools_router, 'has_permission', has_permission)
    monkeypatch.setattr(tools_router.Config, 'get', config_get)

    user = SimpleNamespace(id='u1', role='user')
    out = asyncio.run(tools_router.export_tools(request=None, user=user, db=None))
    content = {t.id: t.content for t in out}
    assert content == {'mine': '# source of mine', 'shared-ro': None, 'shared-rw': '# source of shared-rw'}
