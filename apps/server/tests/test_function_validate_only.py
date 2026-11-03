"""A function edit whose code fails to load leaves the stored function as it was (#302).

`load_function_module_by_id` both loads stored functions at runtime and
checks new code for the create, update and sync routes. Its error branch
switched the stored function off (`is_active=False`), which is what a
runtime load of broken stored code should do. The update route, though,
then answered 400 and kept the old content, so a typo in an edit silently
turned a working (possibly global) filter off for everyone, behind an error
that implied nothing had changed. `/functions/sync` did the same.

Now the routes check new code without switching anything off, and a runtime
load of broken stored code still does.

Runs against the suite's migrated SQLite database; the event publisher is
faked.

Run from apps/server:

    python -m pytest tests/test_function_validate_only.py
"""

from __future__ import annotations

import asyncio
import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.models.functions import FunctionForm, FunctionMeta, Functions, FunctionWithValvesModel
from local_llm.routers import functions as functions_router
from local_llm.utils import plugin

WORKING = """
class Filter:
    def inlet(self, body):
        return body
"""
BROKEN = """
class Filter:
    def inlet(self, body)
        return body
"""
ADMIN = SimpleNamespace(id='admin', role='admin')


@pytest.fixture
def stored(monkeypatch):
    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(functions_router, 'publish_event', nothing)
    function_id = f'filter_{uuid.uuid4().hex[:8]}'

    async def create():
        form = FunctionForm(id=function_id, name='My filter', content=WORKING, meta=FunctionMeta())
        created = await Functions.insert_new_function('admin', 'filter', form)
        assert created is not None
        await Functions.update_function_by_id(function_id, {'is_active': True, 'is_global': True})

    asyncio.run(create())
    return function_id


def _request():
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(FUNCTIONS={}, FUNCTION_CONTENTS={})))


def _function(function_id):
    function = asyncio.run(Functions.get_function_by_id(function_id))
    assert function is not None
    return function


def test_an_edit_that_fails_to_load_keeps_the_function_on_and_unchanged(stored):
    form = FunctionForm(id=stored, name='My filter', content=BROKEN, meta=FunctionMeta())

    async def update():
        return await functions_router.update_function_by_id(_request(), stored, form, ADMIN, db=None)

    with pytest.raises(HTTPException) as raised:
        asyncio.run(update())

    assert raised.value.status_code == 400
    function = _function(stored)
    assert function.is_active is True
    assert function.is_global is True
    assert function.content.strip() == WORKING.strip()


def test_a_sync_with_code_that_fails_to_load_keeps_the_function_on(stored):
    current = _function(stored)
    form = functions_router.SyncFunctionsForm(
        functions=[FunctionWithValvesModel(**{**current.model_dump(), 'content': BROKEN})]
    )

    with pytest.raises(HTTPException):
        asyncio.run(functions_router.sync_functions(_request(), form, ADMIN, db=None))

    assert _function(stored).is_active is True


def test_a_new_function_that_fails_to_load_is_not_created():
    function_id = f'filter_{uuid.uuid4().hex[:8]}'
    form = FunctionForm(id=function_id, name='Broken', content=BROKEN, meta=FunctionMeta())

    with pytest.raises(HTTPException):
        asyncio.run(functions_router.create_new_function(_request(), form, ADMIN, db=None))

    assert asyncio.run(Functions.get_function_by_id(function_id)) is None


def test_a_runtime_load_of_broken_stored_code_still_switches_it_off(stored):
    asyncio.run(Functions.update_function_by_id(stored, {'content': BROKEN}))

    with pytest.raises(SyntaxError):
        asyncio.run(plugin.load_function_module_by_id(stored, BROKEN))

    assert _function(stored).is_active is False
