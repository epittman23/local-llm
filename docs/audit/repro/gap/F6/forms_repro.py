"""F6 backend-side repros: what the admin config endpoints do with the values the tabs send."""

import datetime as dt
import re

from pydantic import ValidationError

from local_llm.routers.chats import ChatConfigForm
from local_llm.routers.configs import CodeInterpreterConfigForm
from local_llm.routers.tasks import TaskConfigForm
from local_llm.utils.auth import create_token, decode_token
from local_llm.utils.misc import parse_duration

code_exec = dict(
    ENABLE_CODE_EXECUTION=True,
    CODE_EXECUTION_ENGINE='jupyter',
    CODE_EXECUTION_JUPYTER_URL='http://j',
    CODE_EXECUTION_JUPYTER_AUTH='',
    CODE_EXECUTION_JUPYTER_AUTH_TOKEN='',
    CODE_EXECUTION_JUPYTER_AUTH_PASSWORD='',
    CODE_EXECUTION_JUPYTER_TIMEOUT=60,
    ENABLE_CODE_INTERPRETER=False,
    CODE_INTERPRETER_ENGINE='pyodide',
    CODE_INTERPRETER_PROMPT_TEMPLATE='',
    CODE_INTERPRETER_JUPYTER_URL='',
    CODE_INTERPRETER_JUPYTER_AUTH='',
    CODE_INTERPRETER_JUPYTER_AUTH_TOKEN='',
    CODE_INTERPRETER_JUPYTER_AUTH_PASSWORD='',
    CODE_INTERPRETER_JUPYTER_TIMEOUT=60,
)


def check(label, cls, data):
    try:
        cls(**data)
        print(f'{label}: accepted')
    except ValidationError as e:
        print(f'{label}: 422 -> {[(err["loc"], err["type"]) for err in e.errors()]}')


print('--- Code Execution timeout cleared ---')
check('timeout=None (what Svelte sent)', CodeInterpreterConfigForm, {**code_exec, 'CODE_EXECUTION_JUPYTER_TIMEOUT': None})
check('timeout="" (what the port sends)', CodeInterpreterConfigForm, {**code_exec, 'CODE_EXECUTION_JUPYTER_TIMEOUT': ''})

print('--- Interface number fields cleared (sent as null) ---')
task = dict(
    TASK_MODEL='',
    TASK_MODEL_EXTERNAL='',
    TASK_MODEL_PARAMS={},
    ENABLE_TITLE_GENERATION=True,
    TITLE_GENERATION_PROMPT_TEMPLATE='',
    IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE='',
    ENABLE_AUTOCOMPLETE_GENERATION=True,
    AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH=None,
    AUTOCOMPLETE_GENERATION_PROMPT_TEMPLATE='',
    TAGS_GENERATION_PROMPT_TEMPLATE='',
    FOLLOW_UP_GENERATION_PROMPT_TEMPLATE='',
    ENABLE_FOLLOW_UP_GENERATION=True,
    ENABLE_TAGS_GENERATION=True,
    ENABLE_SEARCH_QUERY_GENERATION=True,
    ENABLE_RETRIEVAL_QUERY_GENERATION=True,
    QUERY_GENERATION_PROMPT_TEMPLATE='',
    TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE='',
    ENABLE_VOICE_MODE_PROMPT=False,
    VOICE_MODE_PROMPT_TEMPLATE='',
)
check('AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH=null', TaskConfigForm, task)
chat = dict(
    CONTEXT_COMPACTION_MODEL='',
    ENABLE_CONTEXT_COMPACTION=True,
    CONTEXT_COMPACTION_TOKEN_THRESHOLD=None,
    CONTEXT_COMPACTION_TOKEN_CAP=None,
    CONTEXT_COMPACTION_RETENTION_PERCENTAGE=None,
    CONTEXT_COMPACTION_PROMPT_TEMPLATE='',
    ENABLE_TOOL_PERMISSIONS=False,
)
check('compaction threshold/cap/retention=null', ChatConfigForm, chat)

print('--- JWT_EXPIRES_IN (routers/auths.py:946-950 pattern) ---')
pattern = r'^(-1|0|(-?\d+(\.\d+)?)(ms|s|m|h|d|w))$'
for value in ['-1h', '-5m', '1 hour', '24hr', '1H', '0s']:
    ok = bool(re.match(pattern, value))
    if not ok:
        print(f'{value!r}: rejected by the pattern -> silently popped, endpoint still 200')
        continue
    delta = parse_duration(value)
    token = create_token({'id': 'u'}, expires_delta=delta)
    print(
        f'{value!r}: accepted, parse_duration={delta!r}, '
        f'fresh token decodes={decode_token(token) is not None}'
    )
