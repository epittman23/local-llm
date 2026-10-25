"""benchmarks/evaluation/harness.py - answer an item through the app's own chat pipeline.

The runner's bare mode (runner.ask) sends an item straight to llama-server,
so it measures the model. This mode sends it the way a chat does: through a
Workspace model entry, with that entry's system prompt and params, and with
the code interpreter on the Jupyter engine. It measures the assistant as
deployed. The design, and the owner's decisions behind each rule below, are
in docs/plans/benchmarks-through-the-app.md (D1-D8).

The pipeline was built for a browser, so this module drives it by hand:

  * `chat_completion` returns None on every path that runs code: the answer
    lives in the response context and in websocket events. So the four steps
    `_process_chat` runs are run here directly, with a capturing event
    emitter swapped in, and the answer read from ctx['assistant_message'].
  * Code runs only on the streaming path with an emitter, which needs a chat
    id and a message id; builtin tools are only offered with a session id.
    A `temporary:` chat id writes no chat row, and a synthetic session id
    never reaches a browser, because the Jupyter engine needs no event caller.
  * The pipeline offers about a dozen builtin tools. Some browse the user's
    notes, chats and knowledge, and ask_user would pause the reply and lose
    the answer. The tool list is cut down to execute_code (D3).
  * Nothing in the result says which connection answered. Every upstream
    request is observed (utils/upstream_trace.py) and must go to the
    llama-server being measured, or nothing is recorded (D4).

What gets recorded is read back from the request actually sent upstream:
the system message, the tools, the sampling params. The harness spec is the
part of that which every item shares; its sha groups results beside
system_sha (D5), and a run whose spec changes between items stops rather
than file the two under one key.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import json
import os
import time
import uuid
from dataclasses import dataclass, field
from urllib.parse import urlparse

import aiohttp
from fastapi import Request
from fastapi.security import HTTPAuthorizationCredentials
from starlette.datastructures import Headers
from starlette.responses import JSONResponse

from local_llm.utils.upstream_trace import tracing

#: The only tool offered to the model (D3).
TOOLS = ('execute_code',)
#: Upstream calls an item may make before the tool loop stops; one confused
#: item would otherwise spend the whole per-item timeout (256 by default).
MAX_TOOL_ROUNDS = 8
#: Body keys that are not params: the conversation and the tool list, which
#: the spec covers as the system message's sha and the tool names.
NOT_PARAMS = ('messages', 'tools')

LOCAL_HOSTS = {'127.0.0.1', 'localhost', '::1'}
CODE_INTERPRETER_ITEM = 'open_webui:code_interpreter'
TOOL_OUTPUT_ITEM = 'function_call_output'


class HarnessRefused(RuntimeError):
    """The harness cannot vouch for a result, so it records none.

    Raised before a run starts (a model entry not served by the measured
    llama-server, the wrong code interpreter engine) and during one (a
    request that went somewhere else, a spec that changed between items).
    A router reports it like a SuiteLoadError: the run stops, nothing is
    filed under a key it does not describe.
    """


@dataclass
class HarnessAnswer:
    content: str = ''
    reasoning: str = ''
    output: list = field(default_factory=list)
    wall_ms: float = 0.0
    error: str = ''
    gone: bool = False
    spec: dict = field(default_factory=dict)
    stats: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# preparing a run
# ---------------------------------------------------------------------------
def _request_for(source: Request, user) -> Request:
    """A synthetic internal request, as utils/subagents.py builds one.

    `internal` drops the subagent and memory-writing tools and the chat
    finished events; the tool-round cap stops a runaway tool loop.
    """
    from local_llm.utils.auth import create_token

    scope = {
        'type': 'http',
        'asgi': {'version': '3.0', 'spec_version': '2.0'},
        'method': 'POST',
        'path': '/api/v1/benchmarks/tests/harness',
        'query_string': b'',
        'headers': Headers({}).raw,
        'client': ('127.0.0.1', 0),
        'server': ('127.0.0.1', 80),
        'scheme': 'http',
        'app': source.app,
    }
    request = Request(scope)
    token = create_token(data={'id': user.id, 'typ': 'benchmark'}, expires_delta=dt.timedelta(hours=12))
    request.state.token = HTTPAuthorizationCredentials(scheme='Bearer', credentials=token)
    request.state.enable_api_keys = False
    request.state.internal = True
    request.state.max_tool_call_iterations = MAX_TOOL_ROUNDS
    # Read by tools/builtin.py's execute_code: a plot a code run prints is
    # kept inline instead of being stored as a file in the owner's Files.
    request.state.benchmark_harness = True
    return request


def is_local_target(url: str, port: int) -> bool:
    """Whether an upstream URL is the llama-server on this machine's `port`."""
    parsed = urlparse(url)
    return parsed.scheme in ('http', 'https') and parsed.hostname in LOCAL_HOSTS and parsed.port == port


async def prepare(source: Request, user, model_entry: str, port: int) -> dict:
    """Resolve a model entry for a harness run, or refuse it.

    Every check here is one the pipeline would otherwise get past silently:
    a result answered by OpenRouter but filed under a local config_id, a
    fallback model standing in for a missing base model, a non-streaming
    entry that never runs code, a Pyodide engine whose event call would wait
    for a browser that is not there.
    """
    from local_llm import main
    from local_llm.models.config import Config
    from local_llm.routers.openai import get_openai_connection
    from local_llm.utils.misc import merge_model_params
    from local_llm.utils.models import get_all_models

    request = _request_for(source, user)

    def base_of(entry_id: str) -> str | None:
        entry = request.app.state.MODELS.get(entry_id) or {}
        return (entry.get('info') or {}).get('base_model_id')

    # The app's model list is a cache, refreshed when a chat lists models.
    # After a serve swaps the model, it can still name the old one, so a
    # missing entry or base is checked against a fresh list before refusing.
    models = request.app.state.MODELS
    if model_entry not in models or (base_of(model_entry) and base_of(model_entry) not in models):
        await get_all_models(request, refresh=True, user=user)
    if model_entry not in request.app.state.MODELS:
        raise HarnessRefused(f"no model '{model_entry}' in the app; create it under Workspace > Models")

    model, model_info, _fallback, missing_base = await main._resolve_chat_model(request, model_entry, {}, user)
    if model_info is None:
        raise HarnessRefused(
            f"'{model_entry}' is a connection model, not a Workspace model entry; the harness measures an entry"
        )
    if missing_base:
        raise HarnessRefused(f"the base model of '{model_entry}' is missing, so the app would answer with another")

    base_id = model_info.base_model_id or model_entry
    base = request.app.state.MODELS.get(base_id) or {}
    if base.get('pipe') or base.get('owned_by') in ('ollama', 'arena') or 'urlIdx' not in base:
        raise HarnessRefused(f"'{model_entry}' is not on an OpenAI-compatible connection")
    url, _key, api_config = await get_openai_connection(base['urlIdx'])
    if not is_local_target(url, port):
        raise HarnessRefused(
            f"'{model_entry}' is served by {url}, not the llama-server on port {port}. "
            f'Point a connection at http://127.0.0.1:{port}/v1 (Admin Settings > Connections) '
            'and base the entry on a model from it.'
        )
    if api_config.get('api_type') == 'responses' or api_config.get('azure'):
        raise HarnessRefused('the connection must use the chat completions API')

    # The params the pipeline will use: the global defaults with the
    # entry's own on top (main._merge_chat_params), not the entry's alone.
    params = merge_model_params(
        await Config.get('models.default_params', {}) or {},
        model_info.params.model_dump() if model_info.params else {},
    )
    if params.get('stream_response') is False:
        raise HarnessRefused(f"'{model_entry}' turns streaming off, and the code interpreter only runs streaming")
    if params.get('function_calling') == 'legacy':
        raise HarnessRefused(f"'{model_entry}' uses legacy function calling; the harness supports native only")
    if params.get('max_completion_tokens') is not None:
        raise HarnessRefused(f"'{model_entry}' sets max_completion_tokens, which would replace the item's token cap")

    ci = await Config.get_many(
        'code_interpreter.enable',
        'code_interpreter.engine',
        'code_interpreter.jupyter.url',
        'code_interpreter.jupyter.auth',
        'code_interpreter.jupyter.auth_token',
    )
    if not ci.get('code_interpreter.enable') or ci.get('code_interpreter.engine') != 'jupyter':
        raise HarnessRefused('the code interpreter must be on, on the Jupyter engine (Admin Settings > Code Execution)')
    if not await _jupyter_alive(ci):
        raise HarnessRefused(f'the Jupyter server at {ci.get("code_interpreter.jupyter.url")} does not answer')

    return {
        'request': request,
        'user': user,
        'model_entry': model_entry,
        'base_model': base_id,
        'model': model,
        'model_info': model_info,
        'port': port,
        'max_tokens': int(os.environ.get('LLAMA_TEST_MAX_TOKENS', 2048)),
        'timeout': float(os.environ.get('LLAMA_TEST_TIMEOUT', 900)),
    }


# ---------------------------------------------------------------------------
# reading what came back
# ---------------------------------------------------------------------------
def _parts_text(item: dict) -> str:
    parts = item.get('content') or []
    if isinstance(parts, str):
        return parts
    return ''.join(str(p.get('text')) for p in parts if isinstance(p, dict) and p.get('text') is not None)


def final_text(output: list) -> str:
    """The text of the message items after the last code run or tool output (D6).

    Not `content`, which joins every round's prose, and not
    get_output_text, which joins every message item: either would grade
    "let me test this" prose or code the model ran along the way as if it
    were the answer.
    """
    last_run = -1
    for i, item in enumerate(output):
        if isinstance(item, dict) and item.get('type') in (CODE_INTERPRETER_ITEM, TOOL_OUTPUT_ITEM):
            last_run = i
    texts = [
        _parts_text(item) for item in output[last_run + 1 :] if isinstance(item, dict) and item.get('type') == 'message'
    ]
    return '\n'.join(t for t in texts if t and not t.isspace())


def reasoning_text(output: list) -> str:
    return ''.join(_parts_text(item) for item in output if isinstance(item, dict) and item.get('type') == 'reasoning')


def _sha(value) -> str:
    return hashlib.sha1(json.dumps(value, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()[:12]


def spec_from_request(hctx: dict, body: dict) -> dict:
    """The part of the first upstream request every item shares: what the harness sha names."""
    system = ''.join(
        m.get('content', '') if isinstance(m.get('content'), str) else json.dumps(m.get('content'))
        for m in body.get('messages', [])
        if m.get('role') == 'system'
    )
    tools = sorted((t.get('function') or {}).get('name', '') for t in body.get('tools') or [])
    return {
        'model_entry': hctx['model_entry'],
        'base_model': hctx['base_model'],
        'system_sha': _sha(system) if system else None,
        'tools': tools,
        # Everything else in the body, whatever the entry, the global
        # defaults or a custom param put there: two requests that differ in
        # any sampling setting must not share a sha.
        'params': {k: v for k, v in body.items() if k not in NOT_PARAMS},
        'function_calling': 'native',
        'features': ['code_interpreter'],
        'code_interpreter_engine': 'jupyter',
        'max_tool_rounds': MAX_TOOL_ROUNDS,
        'tool_approval_mode': 'full',
    }


def spec_sha(spec: dict) -> str:
    return _sha(spec)


# ---------------------------------------------------------------------------
# asking
# ---------------------------------------------------------------------------
async def _server_alive(port: int) -> bool:
    try:
        async with (
            aiohttp.ClientSession() as session,
            session.get(f'http://127.0.0.1:{port}/health', timeout=aiohttp.ClientTimeout(total=5)) as resp,
        ):
            return resp.status < 500
    except (aiohttp.ClientError, TimeoutError):
        return False


async def _jupyter_alive(ci: dict) -> bool:
    """Whether the configured Jupyter server answers, with its token when one is set."""
    url = (ci.get('code_interpreter.jupyter.url') or '').rstrip('/')
    if not url:
        return False
    params = {}
    if ci.get('code_interpreter.jupyter.auth') == 'token' and ci.get('code_interpreter.jupyter.auth_token'):
        params['token'] = ci['code_interpreter.jupyter.auth_token']
    try:
        async with (
            aiohttp.ClientSession() as session,
            session.get(f'{url}/api/status', params=params, timeout=aiohttp.ClientTimeout(total=5)) as resp,
        ):
            return resp.status == 200
    except (aiohttp.ClientError, TimeoutError):
        return False


async def _run_pipeline(hctx: dict, prompt: str, errors: list[str]) -> dict | None:
    """process_chat_payload -> generate_chat_completion -> process_chat_response, as _process_chat runs them."""
    from local_llm import main
    from local_llm.utils.chat import generate_chat_completion
    from local_llm.utils.middleware import (
        build_chat_response_context,
        process_chat_payload,
        process_chat_response,
    )

    request, user, model, model_info = hctx['request'], hctx['user'], hctx['model'], hctx['model_info']
    form_data = {
        'model': hctx['model_entry'],
        'messages': [{'role': 'user', 'content': prompt}],
        'stream': True,
        # At the top level, where they win over the entry's own params.
        'temperature': 0,
        'max_tokens': hctx['max_tokens'],
        'features': {'code_interpreter': True},
        'params': {'function_calling': 'native'},
    }
    model_info_params = await main._merge_chat_params(form_data, model_info)
    capabilities = ((model.get('info') or {}).get('meta') or {}).get('capabilities') or {}
    chat_params = main._chat_stream_params(form_data, model_info_params, capabilities)

    metadata = {
        'user_id': user.id,
        'user_agent': '',
        'internal': True,
        # Not a saved chat: no chat row, no title or tags, no analytics.
        'chat_id': f'temporary:benchmark-{uuid.uuid4().hex}',
        'message_id': uuid.uuid4().hex,
        'user_message': None,
        'user_message_id': None,
        'assistant_message_id': None,
        # Needed for builtin tools to be offered at all; never a browser.
        'session_id': f'benchmark-{uuid.uuid4().hex}',
        'automation_id': None,
        'folder_id': None,
        'filter_ids': [],
        'tool_ids': None,
        'tool_servers': [],
        'files': None,
        'features': form_data['features'],
        'variables': {},
        'chat_variables': {},
        'model': model,
        'direct': False,
        'params': {**chat_params, 'function_calling': 'native', 'tool_approval_mode': 'full'},
    }
    request.state.metadata = metadata
    form_data['metadata'] = metadata

    async def capture(event: dict) -> None:
        kind = event.get('type')
        data = event.get('data') or {}
        error = data.get('error') if kind in ('chat:message:error', 'chat:completion') else None
        if error:
            errors.append(error.get('content', str(error)) if isinstance(error, dict) else str(error))

    async def no_caller(event: dict):
        # Only Pyodide and client-side tools call back into a browser, and
        # prepare() refused both.
        return {'error': 'no browser is attached to a benchmark request'}

    try:
        form_data, metadata, events = await process_chat_payload(request, form_data, user, metadata, model)
        tools = metadata.get('tools') or {}
        if not all(name in tools for name in TOOLS):
            raise HarnessRefused(
                f"'{hctx['model_entry']}' was not offered {', '.join(TOOLS)}; "
                'check its builtin tools and code interpreter capability'
            )
        metadata['tools'] = {name: tools[name] for name in TOOLS}
        form_data['tools'] = [t for t in form_data.get('tools') or [] if (t.get('function') or {}).get('name') in TOOLS]

        response = await generate_chat_completion(request, form_data, user)
        if isinstance(response, JSONResponse) and response.status_code >= 400:
            errors.append(bytes(response.body).decode('utf-8', 'replace')[:400])
            return None

        ctx = await build_chat_response_context(request, form_data, user, model, metadata, None, events)
        ctx['event_emitter'] = capture
        ctx['event_caller'] = no_caller
        await process_chat_response(response, ctx)
        return ctx.get('assistant_message')
    finally:
        await main._disconnect_mcp_clients(metadata)
        await main._end_chat_task(request, user, metadata)


async def ask(hctx: dict, prompt: str) -> HarnessAnswer:
    """One item through the pipeline, graded text and all, or an error.

    Raises HarnessRefused when a request went anywhere but the measured
    llama-server, or none was seen at all: a path the observer cannot see is
    a path the guard cannot vouch for.
    """
    out = HarnessAnswer()
    errors: list[str] = []
    t0 = time.monotonic()
    port = hctx['port']
    # A request to anywhere else is stopped before it is sent, so neither the
    # item nor the entry's system prompt reaches that host.
    with tracing(allow=lambda url: is_local_target(url, port)) as trace:
        try:
            assistant = await asyncio.wait_for(_run_pipeline(hctx, prompt, errors), hctx['timeout'])
        except HarnessRefused:
            raise
        except TimeoutError:
            assistant = None
            errors.append(f'no answer within {hctx["timeout"]:.0f} s')
        except Exception as exc:
            # The pipeline's own failure, recorded as the item's error.
            assistant = None
            errors.append(f'{type(exc).__name__}: {exc}')
    out.wall_ms = (time.monotonic() - t0) * 1000

    if not trace.requests:
        if errors and not await _server_alive(hctx['port']):
            out.gone, out.error = True, f'no response from port {hctx["port"]} ({errors[0]})'
            return out
        why = f' ({errors[0]})' if errors else ''
        raise HarnessRefused(f'no upstream request was observed, so where the answer came from is unknown{why}')
    for url, _body in trace.requests:
        if not is_local_target(url, hctx['port']):
            raise HarnessRefused(f'a request went to {url}, not the llama-server on port {hctx["port"]}')

    if trace.code_run_failures:
        # The model answered without its code: grading that would score
        # an outage as the model's.
        raise HarnessRefused(f'the code interpreter failed ({trace.code_run_failures[0]})')

    try:
        first = json.loads(trace.requests[0][1])
    except (ValueError, TypeError) as exc:
        raise HarnessRefused(f'the first upstream request is not readable: {exc}') from exc
    out.spec = spec_from_request(hctx, first)

    usage = (assistant or {}).get('usage') or {}
    out.stats = {
        'rounds': len(trace.requests),
        'code_runs': len(trace.code_runs_ms),
        'code_ms': round(sum(trace.code_runs_ms)),
        # None, not 0, when the connection reported no usage.
        'output_tokens': usage.get('output_tokens', usage.get('completion_tokens')),
    }

    if errors or assistant is None:
        if not await _server_alive(hctx['port']):
            out.gone = True
            out.error = f'no response from port {hctx["port"]} ({errors[0] if errors else "no answer"})'
        else:
            out.error = errors[0] if errors else 'the pipeline returned no answer'
        return out

    out.output = assistant.get('output') or []
    out.content = final_text(out.output)
    out.reasoning = reasoning_text(out.output)
    return out
