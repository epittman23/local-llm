"""Traced variant of safe_mode_event.py. DEACT=0 skips the SAFE_MODE deactivation (control run)."""

import asyncio
import os
import tempfile
import time

from fastapi import FastAPI

from local_llm.events import EVENTS, publish_event
from local_llm.models.functions import FunctionForm, FunctionMeta, Functions
from local_llm.utils.auth import create_admin_user

MARKER = os.path.join(tempfile.mkdtemp(), 'event-function-ran')

CONTENT = f'''
class Event:
    def event(self, event):
        open({MARKER!r}, 'a').write(event['event'] + '\\n')
'''

T0 = time.monotonic()


def t():
    return f'{time.monotonic() - T0:.4f}s'


async def main():
    await Functions.insert_new_function(
        'u1', 'event', FunctionForm(id='evfn', name='evfn', content=CONTENT, meta=FunctionMeta(description='x'))
    )
    await Functions.update_function_by_id('evfn', {'is_active': True})

    orig_get = Functions.get_functions_by_type
    orig_deact = Functions.deactivate_all_functions

    async def traced_get(*a, **k):
        print(t(), 'dispatch: query start')
        r = await orig_get(*a, **k)
        print(t(), 'dispatch: saw active event functions', [f.id for f in r])
        return r

    async def traced_deact(*a, **k):
        print(t(), 'safe mode: deactivate start')
        r = await orig_deact(*a, **k)
        print(t(), 'safe mode: deactivate committed', r)
        return r

    Functions.get_functions_by_type = traced_get
    Functions.deactivate_all_functions = traced_deact

    app = FastAPI()
    await publish_event(app, EVENTS.SYSTEM_STARTUP_STARTED, source='system')
    if os.environ.get('ADMIN') == '1':
        print(t(), 'create_admin_user ->', await create_admin_user('admin@example.com', 'pw-123456', 'Admin'))
    if os.environ.get('DEACT', '1') == '1':
        await Functions.deactivate_all_functions()

    await asyncio.sleep(2)
    print('event function ran:', os.path.exists(MARKER))


asyncio.run(main())
