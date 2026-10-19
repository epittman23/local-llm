"""An admin saves an edit to an existing, active function, and the new code
fails to load. The route answers 400 and keeps the old content in the DB,
but the function is switched off as a side effect."""
import asyncio
import types

from fastapi import HTTPException

import local_llm.utils.plugin as plugin
import local_llm.routers.functions as fr
from local_llm.models.functions import FunctionForm, FunctionMeta, Functions

calls = []


async def fake_update(id, updated, db=None):
    calls.append((id, updated))
    return None


Functions.update_function_by_id = fake_update  # the class singleton both modules use

request = types.SimpleNamespace(app=types.SimpleNamespace(state=types.SimpleNamespace()))
admin = types.SimpleNamespace(id='admin', role='admin')
form = FunctionForm(
    id='my_filter',
    name='My filter',
    content='class Filter:\n    def inlet(self, body):\n        return body\n    oops(\n',  # syntax error
    meta=FunctionMeta(description=''),
)


async def main():
    print('ENABLE_PLUGINS =', plugin.ENABLE_PLUGINS)
    try:
        await fr.update_function_by_id(request, 'my_filter', form, user=admin, db=None)
    except HTTPException as e:
        print('route answered', e.status_code, '-', e.detail[:80])
    print('DB writes made while rejecting the update:', calls)


asyncio.run(main())
