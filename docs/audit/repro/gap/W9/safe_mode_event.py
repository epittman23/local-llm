"""SAFE_MODE: does an active event function still run during startup?

Replays main.py lifespan lines 341 and 349-350 in order:
    await publish_event(app, EVENTS.SYSTEM_STARTUP_STARTED, source='system')
    if SAFE_MODE: await Functions.deactivate_all_functions()
against the scratch SQLite database (DATA_DIR is a fresh temp dir).
"""

import asyncio
import os
import tempfile

from fastapi import FastAPI

from local_llm.events import EVENTS, publish_event
from local_llm.models.functions import FunctionForm, FunctionMeta, Functions

MARKER = os.path.join(tempfile.mkdtemp(), 'event-function-ran')

CONTENT = f'''
class Function:
    def event(self, event):
        open({MARKER!r}, 'a').write(event['event'] + '\\n')
'''


async def main():
    await Functions.insert_new_function(
        'u1', 'event', FunctionForm(id='evfn', name='evfn', content=CONTENT, meta=FunctionMeta(description='x'))
    )
    await Functions.update_function_by_id('evfn', {'is_active': True})

    app = FastAPI()
    # lifespan order
    await publish_event(app, EVENTS.SYSTEM_STARTUP_STARTED, source='system')
    ok = await Functions.deactivate_all_functions()
    print('deactivate_all_functions returned', ok)

    await asyncio.sleep(2)  # let the scheduled dispatch task finish
    fn = await Functions.get_function_by_id('evfn')
    print('function is_active after SAFE_MODE deactivation:', fn.is_active)
    print('event function ran:', os.path.exists(MARKER), open(MARKER).read().strip() if os.path.exists(MARKER) else '')


asyncio.run(main())
