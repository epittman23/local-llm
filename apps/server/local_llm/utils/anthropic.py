import logging
import uuid

import aiohttp

from local_llm.env import (
    AIOHTTP_CLIENT_SESSION_SSL,
    AIOHTTP_CLIENT_TIMEOUT_MODEL_LIST,
    ENABLE_FORWARD_USER_INFO_HEADERS,
)
from local_llm.models.users import UserModel
from local_llm.utils.headers import include_user_info_headers
from local_llm.utils.json_codec import JSONCodec
from local_llm.utils.misc import url_host_matches

log = logging.getLogger(__name__)

ANTHROPIC_VERSION = '2023-06-01'

ANTHROPIC_CONVERTED_REQUEST_PARAMS = {
    'model',
    'messages',
    'system',
    'max_tokens',
    'temperature',
    'top_p',
    'top_k',
    'stop_sequences',
    'stream',
    'metadata',
    'service_tier',
    'tools',
    'tool_choice',
    'reasoning_effort',
}


def is_anthropic_url(url: str) -> bool:
    """Check if the URL is an Anthropic API endpoint."""
    return url_host_matches(url, 'api.anthropic.com')


async def get_anthropic_models(url: str, key: str, user: UserModel = None) -> dict:
    """
    Fetch models from Anthropic's /v1/models endpoint with pagination.
    Normalizes the response to OpenAI format.
    """
    timeout = aiohttp.ClientTimeout(total=AIOHTTP_CLIENT_TIMEOUT_MODEL_LIST)
    all_models = []
    after_id = None

    try:
        async with aiohttp.ClientSession(timeout=timeout, trust_env=True) as session:
            headers = {
                'x-api-key': key,
                'anthropic-version': ANTHROPIC_VERSION,
            }

            if ENABLE_FORWARD_USER_INFO_HEADERS and user:
                headers = include_user_info_headers(headers, user)

            while True:
                params = {'limit': 1000}
                if after_id:
                    params['after_id'] = after_id

                async with session.get(
                    f'{url}/models',
                    headers=headers,
                    params=params,
                    ssl=AIOHTTP_CLIENT_SESSION_SSL,
                ) as response:
                    if response.status != 200:
                        error_detail = f'HTTP Error: {response.status}'
                        try:
                            res = await response.json()
                            if 'error' in res:
                                error_detail = f'External Error: {res["error"]}'
                        except Exception:
                            pass
                        return {'object': 'list', 'data': [], 'error': error_detail}

                    data = await response.json()

                    for model in data.get('data', []):
                        all_models.append(
                            {
                                'id': model.get('id'),
                                'object': 'model',
                                'created': 0,
                                'owned_by': 'anthropic',
                                'name': model.get('display_name', model.get('id')),
                            }
                        )

                    if not data.get('has_more', False):
                        break
                    after_id = data.get('last_id')

    except Exception as e:
        log.error(f'Anthropic connection error: {e}')
        return None

    return {'object': 'list', 'data': all_models}


##############################
#
# Anthropic Messages API Conversion Utilities
#
##############################


def _copy_cache_control(source: dict, target: dict) -> dict:
    if isinstance(source, dict) and 'cache_control' in source:
        target['cache_control'] = source['cache_control']
    return target


def _has_cache_control(blocks: list) -> bool:
    return any(isinstance(block, dict) and 'cache_control' in block for block in blocks)


def _finalize_openai_content(blocks: list) -> str | list:
    if not blocks:
        return ''

    if len(blocks) == 1 and blocks[0].get('type') == 'text' and not _has_cache_control(blocks):
        return blocks[0].get('text', '')

    return blocks


def is_anthropic_messages_passthrough(url: str, api_config: dict | None = None) -> bool:
    api_config = api_config or {}
    provider = str(api_config.get('provider', '')).lower()

    return is_anthropic_url(url or '') or provider == 'litellm'


def _text_part(block: dict) -> dict:
    return _copy_cache_control(block, {'type': 'text', 'text': block.get('text', '')})


def _image_url_part(block: dict) -> dict | None:
    """An Anthropic image block as an OpenAI image_url part; None for a source OpenAI can't take."""
    source = block.get('source', {})
    if source.get('type') == 'base64':
        media_type = source.get('media_type', 'image/png')
        url = f'data:{media_type};base64,{source.get("data", "")}'
    elif source.get('type') == 'url':
        url = source.get('url', '')
    else:
        return None
    return _copy_cache_control(block, {'type': 'image_url', 'image_url': {'url': url}})


def _system_message(system) -> dict | None:
    """Anthropic's top-level system prompt as an OpenAI system message."""
    if not system:
        return None
    if isinstance(system, str):
        return {'role': 'system', 'content': system}
    if not isinstance(system, list):
        return None
    parts = []
    for block in system:
        if isinstance(block, dict) and block.get('type') == 'text':
            parts.append(_text_part(block))
        elif isinstance(block, str):
            parts.append({'type': 'text', 'text': block})
    return {'role': 'system', 'content': _finalize_openai_content(parts)}


def _document_text(block: dict) -> str:
    """Documents have no OpenAI equivalent, so they become text."""
    source = block.get('source', {})
    text = f'[Document: {block.get("title", "Document")}]'
    if block.get('context', ''):
        text += f'\n{block.get("context", "")}'
    if source.get('type') == 'text' and source.get('data'):
        text += f'\n{source["data"]}'
    return text


def _search_result_text(block: dict) -> str:
    """A search result as text, with its source attributed."""
    texts = [
        part.get('text', '')
        for part in block.get('content', [])
        if isinstance(part, dict) and part.get('type') == 'text'
    ]
    body = '\n'.join(texts)
    text = f'[Search Result: {block.get("title", "")}]'
    if block.get('source', ''):
        text += f'\nSource: {block.get("source", "")}'
    if body:
        text += f'\n{body}'
    return text


def _tool_result_part(block) -> dict | None:
    """One block of a tool result's content in OpenAI form; None to drop it."""
    if not isinstance(block, dict):
        return None
    block_type = block.get('type', 'text')
    if block_type == 'text':
        return _text_part(block)
    if block_type == 'image':
        return _image_url_part(block)
    if block_type == 'document':
        return {'type': 'text', 'text': _document_text(block)}
    if block_type == 'search_result':
        return {'type': 'text', 'text': _search_result_text(block)}
    return None


def _tool_result_content(content) -> str | list:
    """A tool result's content: plain text when it is only uncached text, else a multimodal list."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ''
    parts = [part for part in map(_tool_result_part, content) if part is not None]
    if all(part.get('type') == 'text' for part in parts) and not _has_cache_control(parts):
        return '\n'.join(part.get('text', '') for part in parts)
    return parts


def _tool_message(block: dict) -> dict:
    """An Anthropic tool_result block as a separate OpenAI tool message."""
    content = _tool_result_content(block.get('content', ''))
    if block.get('is_error'):
        if isinstance(content, str):
            content = f'Error: {content}'
        else:
            content.insert(0, {'type': 'text', 'text': 'Error: '})
    return {'role': 'tool', 'tool_call_id': block.get('tool_use_id', ''), 'content': content}


def _tool_call(block: dict) -> dict:
    """An Anthropic tool_use block as an OpenAI tool call."""
    arguments = (
        JSONCodec.dumps(block.get('input', {}))
        if isinstance(block.get('input'), dict)
        else str(block.get('input', '{}'))
    )
    return {
        'id': block.get('id', ''),
        'type': 'function',
        'function': {'name': block.get('name', ''), 'arguments': arguments},
    }


def _convert_message(msg: dict) -> list[dict]:
    """One Anthropic message as OpenAI messages: its tool results first, then the message itself."""
    role = msg.get('role', 'user')
    content = msg.get('content')
    if isinstance(content, str):
        return [{'role': role, 'content': content}]
    if not isinstance(content, list):
        return [{'role': role, 'content': str(content) if content else ''}]

    messages, parts, tool_calls = [], [], []
    for block in content:
        block_type = block.get('type', 'text')
        if block_type == 'text':
            parts.append(_text_part(block))
        elif block_type in ('thinking', 'redacted_thinking'):
            parts.append(_copy_cache_control(block, dict(block)))
        elif block_type == 'image':
            image = _image_url_part(block)
            if image is not None:
                parts.append(image)
        elif block_type == 'tool_use':
            tool_calls.append(_tool_call(block))
        elif block_type == 'tool_result':
            messages.append(_tool_message(block))

    if tool_calls:
        messages.append(
            {'role': role, 'content': _finalize_openai_content(parts) if parts else '', 'tool_calls': tool_calls}
        )
    elif parts:
        messages.append({'role': role, 'content': _finalize_openai_content(parts)})
    return messages


def _passthrough_params(anthropic_payload: dict, passthrough_params) -> dict:
    """The request parameters this conversion doesn't handle that the caller asked to forward ('*' for all)."""
    captured = {
        param: value for param, value in anthropic_payload.items() if param not in ANTHROPIC_CONVERTED_REQUEST_PARAMS
    }
    if isinstance(passthrough_params, str):
        passthrough_params = passthrough_params.split(',')
    elif not isinstance(passthrough_params, (list, tuple, set)):
        passthrough_params = []
    names = {str(item).strip() for item in passthrough_params if str(item).strip()}
    if '*' in names:
        return captured
    return {param: captured[param] for param in names if param in captured}


def _apply_output_config(anthropic_payload: dict, openai_payload: dict) -> None:
    """output_config's effort becomes reasoning_effort, and its format a response_format."""
    output_config = anthropic_payload.get('output_config')
    if not isinstance(output_config, dict):
        return
    if 'effort' in output_config and 'reasoning_effort' not in anthropic_payload:
        openai_payload['reasoning_effort'] = output_config['effort']

    format_config = output_config.get('format')
    if not isinstance(format_config, dict):
        return
    format_type = format_config.get('type')
    if format_type == 'json_schema':
        json_schema = {
            'name': format_config.get('name', 'response_schema'),
            'schema': format_config.get('schema', {}),
        }
        for key in ('description', 'strict'):
            if key in format_config:
                json_schema[key] = format_config[key]
        openai_payload['response_format'] = {'type': 'json_schema', 'json_schema': json_schema}
    elif format_type == 'json_object':
        openai_payload['response_format'] = {'type': format_type}


def _openai_tool(tool: dict) -> dict:
    return _copy_cache_control(
        tool,
        {
            'type': 'function',
            'function': {
                'name': tool.get('name', ''),
                'description': tool.get('description', ''),
                'parameters': tool.get('input_schema', {}),
            },
        },
    )


def _openai_tool_choice(tool_choice):
    """Anthropic's tool_choice in OpenAI form; None when it has no equivalent."""
    if not isinstance(tool_choice, dict):
        return None
    tool_choice_type = tool_choice.get('type', 'auto')
    if tool_choice_type == 'auto':
        return 'auto'
    if tool_choice_type == 'any':
        return 'required'
    if tool_choice_type == 'tool':
        return {'type': 'function', 'function': {'name': tool_choice.get('name', '')}}
    return None


def convert_anthropic_to_openai_payload(
    anthropic_payload: dict, passthrough_params: list[str] | str | None = None
) -> dict:
    """
    Convert an Anthropic Messages API request to OpenAI Chat Completions format.

    Anthropic format:
        {model, messages: [{role, content}], system, max_tokens, ...}
    OpenAI format:
        {model, messages: [{role, content}], max_tokens, ...}

    The steps run in this order on purpose: forwarded parameters go in first,
    so the converted output_config, reasoning_effort, stop_sequences, tools and
    tool_choice override a raw parameter of the same OpenAI name.
    """
    messages = []
    system_message = _system_message(anthropic_payload.get('system'))
    if system_message:
        messages.append(system_message)
    for msg in anthropic_payload.get('messages', []):
        messages.extend(_convert_message(msg))

    openai_payload = {'model': anthropic_payload.get('model', ''), 'messages': messages}
    if 'max_tokens' in anthropic_payload:
        openai_payload['max_tokens'] = anthropic_payload['max_tokens']

    openai_payload.update(_passthrough_params(anthropic_payload, passthrough_params))
    _apply_output_config(anthropic_payload, openai_payload)
    if 'reasoning_effort' in anthropic_payload:
        openai_payload['reasoning_effort'] = anthropic_payload['reasoning_effort']

    for param in ('temperature', 'top_p', 'top_k', 'stop_sequences', 'stream', 'metadata', 'service_tier'):
        if param in anthropic_payload:
            openai_payload['stop' if param == 'stop_sequences' else param] = anthropic_payload[param]

    if 'tools' in anthropic_payload:
        openai_payload['tools'] = [_openai_tool(tool) for tool in anthropic_payload['tools']]

    if 'tool_choice' in anthropic_payload:
        tool_choice = _openai_tool_choice(anthropic_payload['tool_choice'])
        if tool_choice is not None:
            openai_payload['tool_choice'] = tool_choice

    return openai_payload


def convert_openai_to_anthropic_response(
    openai_response: dict, model: str = '', input_tokens: int | None = None
) -> dict:
    """
    Convert a non-streaming OpenAI Chat Completions response to Anthropic Messages format.
    """
    import uuid as _uuid

    choice = {}
    if openai_response.get('choices'):
        choice = openai_response['choices'][0]

    message = choice.get('message', {})
    finish_reason = choice.get('finish_reason', 'stop')

    # Map finish_reason to stop_reason
    stop_reason_map = {
        'stop': 'end_turn',
        'length': 'max_tokens',
        'tool_calls': 'tool_use',
        'content_filter': 'end_turn',
    }
    stop_reason = stop_reason_map.get(finish_reason, 'end_turn')

    # Build content blocks
    content = []
    message_thinking = message.get('thinking')
    thinking_blocks = message.get('thinking_blocks') or []
    if not thinking_blocks and isinstance(message_thinking, dict):
        thinking_blocks = message_thinking.get('blocks') or []

    has_thinking = False
    for block in thinking_blocks:
        if not isinstance(block, dict):
            continue

        if block.get('type') == 'redacted_thinking':
            content.append({k: v for k, v in block.items() if k in {'type', 'data'}})
            has_thinking = True
            continue

        thinking = block.get('thinking') or block.get('content') or block.get('text')
        if not thinking:
            continue

        thinking_block = {'type': 'thinking', 'thinking': thinking}
        if block.get('signature'):
            thinking_block['signature'] = block['signature']
        content.append(thinking_block)
        has_thinking = True

    reasoning_content = message.get('reasoning_content') or message.get('reasoning')
    if not reasoning_content and isinstance(message_thinking, str):
        reasoning_content = message_thinking
    if reasoning_content and not has_thinking:
        content.append({'type': 'thinking', 'thinking': reasoning_content})

    message_content = message.get('content')
    if message_content:
        content.append({'type': 'text', 'text': message_content})

    # Tool calls -> tool_use blocks
    tool_calls = message.get('tool_calls') or []
    for tool_call in tool_calls:
        function = tool_call.get('function', {})
        try:
            tool_input = JSONCodec.loads(function.get('arguments', '{}'))
        except (JSONCodec.JSONDecodeError, TypeError):
            tool_input = {}
        content.append(
            {
                'type': 'tool_use',
                'id': tool_call.get('id', f'toolu_{_uuid.uuid4().hex[:24]}'),
                'name': function.get('name', ''),
                'input': tool_input,
            }
        )

    # Usage
    openai_usage = openai_response.get('usage') or {}
    cache_creation = openai_usage.get('cache_creation_input_tokens')
    cache_read = openai_usage.get('cache_read_input_tokens')
    prompt_details = openai_usage.get('prompt_tokens_details')
    if cache_read is None and isinstance(prompt_details, dict):
        cache_read = prompt_details.get('cached_tokens')

    usage_input = openai_usage.get('input_tokens')
    if usage_input is None:
        prompt_tokens = openai_usage.get('prompt_tokens')
        if prompt_tokens is not None:
            usage_input = max(prompt_tokens - (cache_creation or 0) - (cache_read or 0), 0)

    usage_output = openai_usage.get('output_tokens')
    if usage_output is None:
        usage_output = openai_usage.get('completion_tokens')

    usage = {
        'input_tokens': usage_input if usage_input is not None else (input_tokens if input_tokens is not None else 0),
        'output_tokens': usage_output if usage_output is not None else 0,
    }
    if cache_creation is not None:
        usage['cache_creation_input_tokens'] = cache_creation
    if cache_read is not None:
        usage['cache_read_input_tokens'] = cache_read
    if isinstance(openai_usage.get('output_tokens_details'), dict):
        usage['output_tokens_details'] = openai_usage['output_tokens_details']
    if isinstance(openai_usage.get('server_tool_use'), dict):
        usage['server_tool_use'] = openai_usage['server_tool_use']
    if openai_usage.get('service_tier') is not None:
        usage['service_tier'] = openai_usage['service_tier']

    return {
        'id': openai_response.get('id', f'msg_{_uuid.uuid4().hex[:24]}'),
        'type': 'message',
        'role': 'assistant',
        'content': content,
        'model': model or openai_response.get('model', ''),
        'stop_reason': stop_reason,
        'stop_sequence': None,
        'usage': usage,
    }


_STREAM_STOP_REASONS = {
    'stop': 'end_turn',
    'length': 'max_tokens',
    'tool_calls': 'tool_use',
}


def _sse(payload: dict) -> bytes:
    """One Anthropic SSE event; its event name is the payload's type."""
    return f'event: {payload["type"]}\ndata: {JSONCodec.dumps(payload)}\n\n'.encode()


def _block_stop(index: int) -> bytes:
    return _sse({'type': 'content_block_stop', 'index': index})


def _parse_openai_sse_chunk(chunk):
    """The JSON objects in one chunk of an OpenAI SSE stream, skipping keep-alives, [DONE] and bad lines."""
    if isinstance(chunk, bytes):
        chunk = chunk.decode('utf-8', errors='ignore')
    for line in chunk.strip().split('\n'):
        line = line.strip()
        if not line or not line.startswith('data:'):
            continue
        data_string = line[5:].strip()
        if data_string in ('[DONE]', '{}'):
            continue
        try:
            yield JSONCodec.loads(data_string)
        except (JSONCodec.JSONDecodeError, TypeError):
            continue


def _stream_reasoning_text(delta: dict, message: dict):
    """The reasoning text a chunk carries, wherever the provider put it."""
    reasoning_content = (
        delta.get('reasoning_content')
        or delta.get('reasoning')
        or delta.get('thinking')
        or message.get('reasoning_content')
        or message.get('reasoning')
    )
    if reasoning_content:
        return reasoning_content
    for block in delta.get('thinking_blocks') or message.get('thinking_blocks') or []:
        if isinstance(block, dict):
            reasoning_content = block.get('thinking') or block.get('content') or block.get('text')
            if reasoning_content:
                break
    return reasoning_content


class _AnthropicStreamConverter:
    """The state of one OpenAI-to-Anthropic stream conversion.

    Every method that emits events is a generator, so events reach the client
    as they are produced: a chunk that fails part-way still delivers what was
    yielded before the failure, as the single try/except around the stream
    expects.

    Content blocks get a running index. Tool calls are tracked by their id,
    not their OpenAI index, so parallel calls sharing an index get distinct
    tool_use blocks; argument-only deltas (no id) go to the most recent call
    at their index. Each block follows Anthropic's start -> delta -> stop
    lifecycle, and text is dropped once a tool call has started, since
    Anthropic expects text before tools.
    """

    def __init__(self, model: str, input_tokens: int | None):
        self.message_id = f'msg_{uuid.uuid4().hex[:24]}'
        self.model = model
        self.input_tokens = input_tokens
        self.output_tokens = 0
        self.cache_creation_input_tokens = None
        self.cache_read_input_tokens = None
        self.output_tokens_details = None
        self.server_tool_use = None
        self.service_tier = None
        self.stop_reason = 'end_turn'

        self.current_block_index = 0
        self.thinking_block_open = False
        self.text_block_open = False
        # {id, name, arguments, block_index, started, stopped}, keyed by tool call id
        self.tracked_tool_calls = {}
        self.index_to_tool_id = {}
        self.has_tool_calls = False

    def message_start(self) -> bytes:
        return _sse(
            {
                'type': 'message_start',
                'message': {
                    'id': self.message_id,
                    'type': 'message',
                    'role': 'assistant',
                    'content': [],
                    'model': self.model,
                    'stop_reason': None,
                    'stop_sequence': None,
                    'usage': {'input_tokens': self.input_tokens or 0, 'output_tokens': 0},
                },
            }
        )

    def handle(self, data: dict):
        """The events for one parsed OpenAI chunk."""
        self._update_usage(data.get('usage'))

        choices = data.get('choices', [])
        if not choices:
            return
        delta = choices[0].get('delta', {})
        finish_reason = choices[0].get('finish_reason')
        message = choices[0].get('message') or {}

        yield from self._reasoning(_stream_reasoning_text(delta, message))
        yield from self._text(delta.get('content'))

        # Some providers put tool_calls on the final message object instead
        # of the delta; fall back to that when needed.
        tool_calls = delta.get('tool_calls') or []
        if not tool_calls and message.get('tool_calls'):
            tool_calls = message['tool_calls']
        if tool_calls:
            yield from self._close_thinking()
            yield from self._close_text()
            for tool_call in tool_calls:
                yield from self._tool_call(tool_call)

        if finish_reason is not None:
            self.stop_reason = _STREAM_STOP_REASONS.get(finish_reason, 'end_turn')

    def _update_usage(self, usage_data) -> None:
        if not isinstance(usage_data, dict):
            return
        cache_creation = usage_data.get('cache_creation_input_tokens')
        cache_read = usage_data.get('cache_read_input_tokens')
        prompt_details = usage_data.get('prompt_tokens_details')
        if cache_read is None and isinstance(prompt_details, dict):
            cache_read = prompt_details.get('cached_tokens')

        usage_input = usage_data.get('input_tokens')
        if usage_input is None:
            prompt_tokens = usage_data.get('prompt_tokens')
            if prompt_tokens is not None:
                usage_input = max(prompt_tokens - (cache_creation or 0) - (cache_read or 0), 0)

        usage_output = usage_data.get('output_tokens')
        if usage_output is None:
            usage_output = usage_data.get('completion_tokens')

        if usage_input is not None:
            self.input_tokens = usage_input
        if usage_output is not None:
            self.output_tokens = usage_output
        if cache_creation is not None:
            self.cache_creation_input_tokens = cache_creation
        if cache_read is not None:
            self.cache_read_input_tokens = cache_read
        if isinstance(usage_data.get('output_tokens_details'), dict):
            self.output_tokens_details = usage_data['output_tokens_details']
        if isinstance(usage_data.get('server_tool_use'), dict):
            self.server_tool_use = usage_data['server_tool_use']
        if usage_data.get('service_tier') is not None:
            self.service_tier = usage_data['service_tier']

    def _reasoning(self, reasoning_content):
        if not reasoning_content or self.text_block_open or self.has_tool_calls:
            return
        if not self.thinking_block_open:
            yield _sse(
                {
                    'type': 'content_block_start',
                    'index': self.current_block_index,
                    'content_block': {'type': 'thinking', 'thinking': ''},
                }
            )
            self.thinking_block_open = True
        yield _sse(
            {
                'type': 'content_block_delta',
                'index': self.current_block_index,
                'delta': {'type': 'thinking_delta', 'thinking': reasoning_content},
            }
        )

    def _text(self, content):
        if not content or self.has_tool_calls:
            return
        yield from self._close_thinking()
        if not self.text_block_open:
            yield _sse(
                {
                    'type': 'content_block_start',
                    'index': self.current_block_index,
                    'content_block': {'type': 'text', 'text': ''},
                }
            )
            self.text_block_open = True
        yield _sse(
            {
                'type': 'content_block_delta',
                'index': self.current_block_index,
                'delta': {'type': 'text_delta', 'text': content},
            }
        )

    def _close_thinking(self):
        if self.thinking_block_open:
            yield _block_stop(self.current_block_index)
            self.thinking_block_open = False
            self.current_block_index += 1

    def _close_text(self):
        if self.text_block_open:
            yield _block_stop(self.current_block_index)
            self.text_block_open = False
            self.current_block_index += 1

    def _tracked_tool(self, tool_call_index, tool_call_id: str, tool_call_name: str) -> dict:
        """The tracked call this delta belongs to, created on its first delta.

        A delta with an id starts or identifies a specific tool; one without
        carries arguments for the most recent tool at its OpenAI index, or
        starts a provisional entry with a generated id if there is none.
        """
        if not tool_call_id and tool_call_index in self.index_to_tool_id:
            return self.tracked_tool_calls[self.index_to_tool_id[tool_call_index]]
        tool_id = tool_call_id or f'toolu_{uuid.uuid4().hex[:24]}'
        if tool_id not in self.tracked_tool_calls:
            self.tracked_tool_calls[tool_id] = {
                'id': tool_id,
                'name': tool_call_name,
                'arguments': '',
                'block_index': -1,
                'started': False,
                'stopped': False,
            }
        self.index_to_tool_id[tool_call_index] = tool_id
        return self.tracked_tool_calls[tool_id]

    def _tool_call(self, tool_call: dict):
        function = tool_call.get('function') or {}
        tool_call_name = function.get('name', '')
        arguments_chunk = function.get('arguments', '')
        tool = self._tracked_tool(tool_call.get('index', 0), tool_call.get('id', ''), tool_call_name)

        if tool_call_name and not tool['name']:
            tool['name'] = tool_call_name

        # A tool's block starts as soon as it has a name.
        if not tool['started'] and tool['name']:
            tool['block_index'] = self.current_block_index
            tool['started'] = True
            self.has_tool_calls = True
            yield _sse(
                {
                    'type': 'content_block_start',
                    'index': self.current_block_index,
                    'content_block': {'type': 'tool_use', 'id': tool['id'], 'name': tool['name'], 'input': {}},
                }
            )
            self.current_block_index += 1

        if arguments_chunk:
            tool['arguments'] += arguments_chunk
            if tool['started'] and not tool['stopped']:
                yield _sse(
                    {
                        'type': 'content_block_delta',
                        'index': tool['block_index'],
                        'delta': {'type': 'input_json_delta', 'partial_json': arguments_chunk},
                    }
                )
            yield from self._close_tool_if_complete(tool)

    def _close_tool_if_complete(self, tool: dict):
        """Closes a tool's block once its buffered arguments parse as complete JSON."""
        if not tool['started'] or tool['stopped']:
            return
        arguments = tool['arguments']
        if arguments.rstrip()[-1:] != '}' and arguments.lstrip()[:1] == '{':
            return
        try:
            JSONCodec.loads(arguments)
        except (JSONCodec.JSONDecodeError, ValueError):
            return
        tool['stopped'] = True
        yield _block_stop(tool['block_index'])

    def close(self):
        """Closes whatever is still open, then ends the message."""
        if self.thinking_block_open:
            yield _block_stop(self.current_block_index)
            self.current_block_index += 1
        if self.text_block_open:
            yield _block_stop(self.current_block_index)
        for tool in self.tracked_tool_calls.values():
            if tool['started'] and not tool['stopped']:
                yield _block_stop(tool['block_index'])

        usage = {'output_tokens': self.output_tokens}
        optional_usage = {
            'input_tokens': self.input_tokens,
            'cache_creation_input_tokens': self.cache_creation_input_tokens,
            'cache_read_input_tokens': self.cache_read_input_tokens,
            'output_tokens_details': self.output_tokens_details,
            'server_tool_use': self.server_tool_use,
            'service_tier': self.service_tier,
        }
        usage.update({key: value for key, value in optional_usage.items() if value is not None})

        yield _sse(
            {
                'type': 'message_delta',
                'delta': {'stop_reason': self.stop_reason, 'stop_sequence': None},
                'usage': usage,
            }
        )
        yield _sse({'type': 'message_stop'})


async def openai_stream_to_anthropic_stream(openai_stream_generator, model: str = '', input_tokens: int | None = None):
    """
    Convert an OpenAI SSE streaming response to Anthropic Messages SSE format.

    OpenAI sends: data: {"choices": [{"delta": {"content": "..."}}]}
    Anthropic sends: event: content_block_delta\\ndata: {"type": "content_block_delta", ...}

    Handles text, thinking, tool calls, and mixed content with proper
    multi-block indexing as required by Anthropic's streaming protocol (see
    _AnthropicStreamConverter). An error anywhere in the source stream or in a
    chunk ends the conversion there; whatever is open is then closed and the
    message ended, so the client still receives a well-formed stream. That
    close runs after the try, not in a finally, so a client disconnect
    (GeneratorExit) is not answered with more events.
    """
    converter = _AnthropicStreamConverter(model, input_tokens)
    yield converter.message_start()

    try:
        async for chunk in openai_stream_generator:
            for data in _parse_openai_sse_chunk(chunk):
                for event in converter.handle(data):
                    yield event
    except Exception as e:
        log.error(f'Error in Anthropic stream conversion: {e}')

    for event in converter.close():
        yield event
