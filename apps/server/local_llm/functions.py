import asyncio
import inspect
import logging
import sys
from collections.abc import AsyncGenerator, Generator, Iterator

from fastapi import (
    Request,
)
from pydantic import BaseModel
from starlette.responses import StreamingResponse

from local_llm.config import BYPASS_ADMIN_ACCESS_CONTROL
from local_llm.env import BYPASS_MODEL_ACCESS_CONTROL, ENABLE_PLUGINS, GLOBAL_LOG_LEVEL
from local_llm.models.functions import Functions
from local_llm.models.models import Models
from local_llm.models.users import UserModel
from local_llm.socket.main import (
    get_event_call,
    get_event_emitter,
)
from local_llm.utils.access_control import check_model_access
from local_llm.utils.json_codec import JSONCodec
from local_llm.utils.misc import (
    openai_chat_chunk_message_template,
    openai_chat_completion_message_template,
)
from local_llm.utils.payload import (
    apply_model_params_to_body_openai,
    apply_system_prompt_to_body,
)
from local_llm.utils.plugin import (
    get_function_module_from_cache,
)

logging.basicConfig(stream=sys.stdout, level=GLOBAL_LOG_LEVEL)
log = logging.getLogger(__name__)


async def get_function_module_by_id(request: Request, pipe_id: str):
    function_module, _, _ = await get_function_module_from_cache(request, pipe_id)

    if hasattr(function_module, 'valves') and hasattr(function_module, 'Valves'):
        Valves = function_module.Valves
        valves = await Functions.get_function_valves_by_id(pipe_id)

        if valves:
            try:
                function_module.valves = Valves(**{k: v for k, v in valves.items() if v is not None})
            except Exception as e:
                log.exception(f'Error loading valves for function {pipe_id}: {e}')
                raise e
        else:
            function_module.valves = Valves()

    return function_module


async def get_function_models(request):
    if not ENABLE_PLUGINS:
        return []

    pipes = await Functions.get_functions_by_type('pipe', active_only=True)
    pipe_models = []

    for pipe in pipes:
        try:
            function_module = await get_function_module_by_id(request, pipe.id)

            has_user_valves = False
            if hasattr(function_module, 'UserValves'):
                has_user_valves = True

            # Check if function is a manifold
            if hasattr(function_module, 'pipes'):
                sub_pipes = []

                # Handle pipes being a list, sync function, or async function
                try:
                    if callable(function_module.pipes):
                        if asyncio.iscoroutinefunction(function_module.pipes):
                            sub_pipes = await function_module.pipes()
                        else:
                            sub_pipes = function_module.pipes()
                    else:
                        sub_pipes = function_module.pipes
                except Exception as e:
                    log.exception(e)
                    sub_pipes = []

                log.debug("get_function_models: function '%s' is a manifold of %s", pipe.id, sub_pipes)

                for p in sub_pipes:
                    sub_pipe_id = f'{pipe.id}.{p["id"]}'
                    sub_pipe_name = p['name']

                    if hasattr(function_module, 'name'):
                        sub_pipe_name = f'{function_module.name}{sub_pipe_name}'

                    pipe_flag = {'type': pipe.type}

                    pipe_models.append(
                        {
                            'id': sub_pipe_id,
                            'name': sub_pipe_name,
                            'object': 'model',
                            'created': pipe.created_at,
                            'owned_by': 'openai',
                            'pipe': pipe_flag,
                            'has_user_valves': has_user_valves,
                        }
                    )
            else:
                pipe_flag = {'type': 'pipe'}

                log.debug(
                    "get_function_models: function '%s' is a single pipe { 'id': %s, 'name': %s }",
                    pipe.id,
                    pipe.id,
                    pipe.name,
                )

                pipe_models.append(
                    {
                        'id': pipe.id,
                        'name': pipe.name,
                        'object': 'model',
                        'created': pipe.created_at,
                        'owned_by': 'openai',
                        'pipe': pipe_flag,
                        'has_user_valves': has_user_valves,
                    }
                )
        except Exception as e:
            log.exception(e)
            continue

    return pipe_models


async def _execute_pipe(pipe, params):
    if inspect.iscoroutinefunction(pipe):
        return await pipe(**params)
    return pipe(**params)


async def _message_content(res) -> str:
    """A pipe's non-streamed output as message text; nothing (None) is empty text, anything else its str()."""
    if res is None:
        return ''
    if isinstance(res, str):
        return res
    if isinstance(res, (Generator, list, tuple)):
        return ''.join(map(str, res))
    if isinstance(res, AsyncGenerator):
        return ''.join([str(stream) async for stream in res])
    return str(res)


def _sse_line(model: str, line) -> str:
    """One line a pipe yielded, as an SSE event: a data line passes through, plain text becomes a chunk."""
    if isinstance(line, BaseModel):
        line = f'data: {line.model_dump_json()}'
    if isinstance(line, dict):
        line = f'data: {JSONCodec.dumps(line)}'
    try:
        line = line.decode('utf-8')
    except Exception:
        pass
    if not isinstance(line, str):
        line = str(line)
    if line.startswith('data:'):
        return f'{line}\n\n'
    return f'data: {JSONCodec.dumps(openai_chat_chunk_message_template(model, line))}\n\n'


def _pipe_id(model_id: str) -> str:
    """The function id of a pipe model; a manifold's sub-model ids are '<function id>.<sub id>'."""
    return model_id.split('.', 1)[0] if '.' in model_id else model_id


async def _pipe_params(function_module, form_data: dict, user, extra_params: dict) -> dict:
    """The body plus the extra params the pipe's signature asks for, with the user's valves if it takes __user__."""
    sig = inspect.signature(function_module.pipe)
    params = {'body': form_data} | {k: v for k, v in extra_params.items() if k in sig.parameters}
    if '__user__' in params and hasattr(function_module, 'UserValves'):
        user_valves = await Functions.get_user_valves_by_id_and_user_id(_pipe_id(form_data['model']), user.id)
        try:
            params['__user__']['valves'] = function_module.UserValves(**user_valves)
        except Exception as e:
            log.exception(e)
            params['__user__']['valves'] = function_module.UserValves()
    return params


async def _pipe_oauth_token(request, user):
    """The user's OAuth token: from the request's OAuth session, else (automations, API keys) their latest one."""
    oauth_token = None
    try:
        oauth_session_id = request.cookies.get('oauth_session_id', None)
        if oauth_session_id:
            oauth_token = await request.app.state.oauth_manager.get_oauth_token(user.id, oauth_session_id)
        if oauth_token is None:
            from local_llm.models.oauth_sessions import OAuthSessions

            sessions = await OAuthSessions.get_sessions_by_user_id(user.id)
            if sessions:
                best = max(sessions, key=lambda s: s.updated_at)
                oauth_token = await request.app.state.oauth_manager.get_oauth_token(user.id, best.id)
    except Exception as e:
        log.error(f'Error getting OAuth token: {e}')
    return oauth_token


async def _pipe_extra_params(request, metadata: dict, user) -> dict:
    """Everything a pipe can ask for by name: event callers, chat and task ids, files, user, tools, OAuth token."""
    event_emitter = event_call = task = task_body = None
    if metadata:
        if all(k in metadata for k in ('session_id', 'chat_id', 'message_id')):
            event_emitter = await get_event_emitter(metadata)
            event_call = await get_event_call(metadata)
        task = metadata.get('task', None)
        task_body = metadata.get('task_body', None)
    oauth_token = await _pipe_oauth_token(request, user)
    return {
        '__event_emitter__': event_emitter,
        '__event_call__': event_call,
        '__chat_id__': metadata.get('chat_id', None),
        '__session_id__': metadata.get('session_id', None),
        '__message_id__': metadata.get('message_id', None),
        '__task__': task,
        '__task_body__': task_body,
        '__files__': metadata.get('files', []),
        '__user__': user.model_dump() if isinstance(user, UserModel) else {},
        '__metadata__': metadata,
        '__oauth_token__': oauth_token,
        '__request__': request,
        '__tools__': metadata.get('tools', {}),
    }


async def _apply_workspace_model(request, form_data: dict, metadata: dict, user, model_info) -> dict:
    """A workspace model over the pipe: its base model, access check, params and system prompt."""
    if model_info.base_model_id:
        form_data['model'] = model_info.base_model_id
    if not BYPASS_MODEL_ACCESS_CONTROL:
        bypass = isinstance(user, UserModel) and user.role == 'admin' and BYPASS_ADMIN_ACCESS_CONTROL
        await check_model_access(user if isinstance(user, UserModel) else UserModel(**user), model_info, bypass)
    params = model_info.params.model_dump()
    if params:
        system = params.pop('system', None)
        form_data = apply_model_params_to_body_openai(params, form_data)
        # Set server-side by utils/chat.py, never by client input. Mirrors the routers.
        if not getattr(request.state, 'bypass_system_prompt', False):
            form_data = await apply_system_prompt_to_body(system, form_data, metadata, user)
    return form_data


async def _stream_pipe(pipe, params: dict, model: str):
    """The pipe's output as SSE: passed through, or as chunks ending with a stop chunk and [DONE]."""
    try:
        res = await _execute_pipe(pipe, params)
        # Directly return if the response is a StreamingResponse
        if isinstance(res, StreamingResponse):
            async for data in res.body_iterator:
                yield data
            return
        if isinstance(res, dict):
            yield f'data: {JSONCodec.dumps(res)}\n\n'
            return
    except Exception as e:
        log.error(f'Error: {e}')
        yield f'data: {JSONCodec.dumps({"error": {"detail": str(e)}})}\n\n'
        return

    if isinstance(res, str):
        yield f'data: {JSONCodec.dumps(openai_chat_chunk_message_template(model, res))}\n\n'
    if isinstance(res, (Iterator, list, tuple)):
        for line in res:
            yield _sse_line(model, line)
    if isinstance(res, AsyncGenerator):
        async for line in res:
            yield _sse_line(model, line)

    finish_message = openai_chat_chunk_message_template(model, '')
    finish_message['choices'][0]['finish_reason'] = 'stop'
    yield f'data: {JSONCodec.dumps(finish_message)}\n\n'
    yield 'data: [DONE]'


async def _complete_pipe(pipe, params: dict, model: str):
    """The pipe's output as one completion (a response or dict from the pipe is returned as it is)."""
    try:
        res = await _execute_pipe(pipe, params)
    except Exception as e:
        log.error(f'Error: {e}')
        return {'error': {'detail': str(e)}}
    if isinstance(res, StreamingResponse) or isinstance(res, dict):
        return res
    if isinstance(res, BaseModel):
        return res.model_dump()
    return openai_chat_completion_message_template(model, await _message_content(res))


async def generate_function_chat_completion(request, form_data, user, models: dict | None = None):
    """Runs a pipe function as a model, streaming or not, as form_data asks."""
    # Copy so the base-model substitution below doesn't leak into the caller's
    # payload, which the tool-call continuation re-submits. Mirrors the routers.
    form_data = {**form_data}
    model_info = await Models.get_model_by_id(form_data.get('model'))
    metadata = form_data.pop('metadata', {})
    extra_params = await _pipe_extra_params(request, metadata, user)
    if model_info:
        form_data = await _apply_workspace_model(request, form_data, metadata, user, model_info)

    function_module = await get_function_module_by_id(request, _pipe_id(form_data['model']))
    pipe = function_module.pipe
    params = await _pipe_params(function_module, form_data, user, extra_params)

    if form_data.get('stream', False):
        return StreamingResponse(_stream_pipe(pipe, params, form_data['model']), media_type='text/event-stream')
    return await _complete_pipe(pipe, params, form_data['model'])
