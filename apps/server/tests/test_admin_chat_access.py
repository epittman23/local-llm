"""ENABLE_ADMIN_CHAT_ACCESS also governs the completion and task routes in main.py.

Run from apps/server:

    python -m pytest tests/test_admin_chat_access.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm import main

ADMIN = SimpleNamespace(id='admin', role='admin')
OTHERS_CHAT = SimpleNamespace(id='c1', user_id='someone-else')


@pytest.fixture
def chat_lookup(monkeypatch):
    async def get_chat_by_id(chat_id, *a, **k):
        return OTHERS_CHAT

    async def stop_item_tasks(redis, chat_id):
        return {'status': True}

    async def list_ids(redis, chat_id):
        return ['t1']

    monkeypatch.setattr(main, 'get_temporary_chat_session_id', lambda _id: None)
    monkeypatch.setattr(main.Chats, 'get_chat_by_id', get_chat_by_id)
    monkeypatch.setattr(main, 'stop_item_tasks', stop_item_tasks)
    monkeypatch.setattr(main, 'list_task_ids_by_item_id', list_ids)


def _request():
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(redis=None)))


def test_admin_cannot_touch_others_chat_tasks_with_the_flag_off(monkeypatch, chat_lookup):
    monkeypatch.setattr(main, 'ENABLE_ADMIN_CHAT_ACCESS', False)
    assert not main._admin_reaches_other_chats(ADMIN)
    listed = asyncio.run(main.list_tasks_by_chat_id_endpoint(_request(), 'c1', user=ADMIN))
    assert listed == {'task_ids': []}
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.stop_tasks_by_chat_id_endpoint(_request(), 'c1', user=ADMIN))
    assert exc.value.status_code == 404


def test_admin_can_with_the_flag_on(monkeypatch, chat_lookup):
    monkeypatch.setattr(main, 'ENABLE_ADMIN_CHAT_ACCESS', True)
    assert main._admin_reaches_other_chats(ADMIN)
    listed = asyncio.run(main.list_tasks_by_chat_id_endpoint(_request(), 'c1', user=ADMIN))
    assert listed == {'task_ids': ['t1']}


def test_a_regular_user_never_can(monkeypatch):
    monkeypatch.setattr(main, 'ENABLE_ADMIN_CHAT_ACCESS', True)
    assert not main._admin_reaches_other_chats(SimpleNamespace(id='u', role='user'))
