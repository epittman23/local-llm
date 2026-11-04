"""A valve save that stored nothing is an error, not a success (#288).

The tool and function valve routes (admin valves and each user's own)
called the model's save method, ignored what it returned, published a
"valves updated" event and answered with the submitted values. The save
methods swallowed every error and returned None, and the user-valve ones
also ignored a user update that saved nothing. So a failed database write
or encryption showed the user values that were never stored. The routes now
answer 400 and publish nothing when the save returned None, and the user
valve saves return None when the user update stored nothing.

Run from apps/server:

    python -m pytest tests/test_valve_save_result.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import BaseModel

from local_llm.models import functions as functions_model
from local_llm.models import tools as tools_model
from local_llm.routers import functions as functions_router
from local_llm.routers import tools as tools_router

USER = SimpleNamespace(id='u1', role='admin')


class _Valves(BaseModel):
    level: int = 1


MODULE = SimpleNamespace(Valves=_Valves, UserValves=_Valves)


@pytest.fixture
def events(monkeypatch):
    published = []

    async def publish(request, event, **kwargs):
        published.append(event)

    async def tool_module(request, id):
        return MODULE, {}

    async def function_module(request, id):
        return MODULE, 'filter', {}

    async def get_tool(id, db=None):
        return SimpleNamespace(id=id, user_id=USER.id)

    async def get_function(id, db=None):
        return SimpleNamespace(id=id, user_id=USER.id, is_active=True)

    monkeypatch.setattr(tools_router, 'publish_event', publish)
    monkeypatch.setattr(functions_router, 'publish_event', publish)
    monkeypatch.setattr(tools_router, 'get_tool_module_from_cache', tool_module)
    monkeypatch.setattr(functions_router, 'get_function_module_from_cache', function_module)
    monkeypatch.setattr(tools_router.Tools, 'get_tool_by_id', get_tool)
    monkeypatch.setattr(functions_router.Functions, 'get_function_by_id', get_function)
    return published


def _save(monkeypatch, owner, method, result):
    async def save(*args, **kwargs):
        return result

    monkeypatch.setattr(owner, method, save)


ROUTES = [
    (tools_router.update_tools_valves_by_id, tools_router.Tools, 'update_tool_valves_by_id'),
    (tools_router.update_tools_user_valves_by_id, tools_router.Tools, 'update_user_valves_by_id_and_user_id'),
    (functions_router.update_function_valves_by_id, functions_router.Functions, 'update_function_valves_by_id'),
    (
        functions_router.update_function_user_valves_by_id,
        functions_router.Functions,
        'update_user_valves_by_id_and_user_id',
    ),
]


@pytest.mark.parametrize(('route', 'owner', 'method'), ROUTES)
def test_a_save_that_stored_nothing_is_an_error_and_publishes_nothing(monkeypatch, events, route, owner, method):
    _save(monkeypatch, owner, method, None)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(route(request=None, id='t1', form_data={'level': 3}, user=USER, db=None))

    assert exc.value.status_code == 400
    assert events == []


@pytest.mark.parametrize(('route', 'owner', 'method'), ROUTES)
def test_a_save_that_stored_the_valves_still_answers_with_them(monkeypatch, events, route, owner, method):
    _save(monkeypatch, owner, method, SimpleNamespace(id='t1'))

    assert asyncio.run(route(request=None, id='t1', form_data={'level': 3}, user=USER, db=None)) == {'level': 3}
    assert len(events) == 1


@pytest.mark.parametrize(('table', 'scope'), [(tools_model.Tools, 'tools'), (functions_model.Functions, 'functions')])
def test_a_user_valve_save_is_none_when_the_user_update_stored_nothing(monkeypatch, table, scope):
    module = tools_model if scope == 'tools' else functions_model
    updates = []

    async def get_user(user_id, db=None):
        return SimpleNamespace(settings=None)

    async def update_user(user_id, updated, db=None):
        updates.append(updated)
        return None

    monkeypatch.setattr(module.Users, 'get_user_by_id', get_user)
    monkeypatch.setattr(module.Users, 'update_user_by_id', update_user)

    assert asyncio.run(table.update_user_valves_by_id_and_user_id('t1', 'u1', {'level': 3})) is None
    assert scope in updates[0]['settings']


@pytest.mark.parametrize(('table', 'scope'), [(tools_model.Tools, 'tools'), (functions_model.Functions, 'functions')])
def test_a_user_valve_save_returns_the_valves_when_stored(monkeypatch, table, scope):
    module = tools_model if scope == 'tools' else functions_model

    async def get_user(user_id, db=None):
        return SimpleNamespace(settings=None)

    async def update_user(user_id, updated, db=None):
        return SimpleNamespace(id=user_id)

    monkeypatch.setattr(module.Users, 'get_user_by_id', get_user)
    monkeypatch.setattr(module.Users, 'update_user_by_id', update_user)

    assert asyncio.run(table.update_user_valves_by_id_and_user_id('t1', 'u1', {'level': 3})) == {'level': 3}


@pytest.mark.parametrize(
    ('module', 'save'),
    [
        (tools_model, lambda: tools_model.Tools.update_tool_valves_by_id('t1', {'level': 3})),
        (functions_model, lambda: functions_model.Functions.update_function_valves_by_id('f1', {'level': 3})),
    ],
)
def test_a_valve_save_that_raises_is_none(monkeypatch, module, save):
    def fail(valves):
        raise ValueError('cannot encrypt')

    monkeypatch.setattr(module, 'encrypt_valves', fail)

    assert asyncio.run(save()) is None
