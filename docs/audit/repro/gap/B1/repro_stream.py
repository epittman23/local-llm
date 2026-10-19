"""B1 repros: drive the real _StreamingReply with the characterization-test fakes (read-only import)."""

import asyncio
import json
import sys

sys.path.insert(0, 'tests')
import pytest  # noqa: E402
from starlette.responses import StreamingResponse  # noqa: E402

import test_streaming_response as tsr  # noqa: E402
from local_llm.utils import middleware  # noqa: E402

SAVED = tsr.SAVED_CHAT


def show(title, log, outcome, keys=('emit', 'chats.upsert_message', 'tool')):
    print('=' * 20, title)
    print('outcome:', outcome)
    for entry in log:
        if entry[0] in keys:
            print(' ', json.dumps(entry)[:400])


def run(lines_or_response, metadata=None, world=None, continuations=()):
    mp = pytest.MonkeyPatch()
    log = []
    tsr._install(mp, world or {}, log, list(continuations))
    ctx = tsr._ctx(world or {}, {'chat_id': SAVED, **(metadata or {})}, {}, None, log)
    response = (
        lines_or_response
        if isinstance(lines_or_response, StreamingResponse)
        else tsr._stream_response(lines_or_response, log, 'first')
    )
    try:
        outcome = asyncio.run(middleware.streaming_chat_response_handler(response, ctx))
    except BaseException as e:  # noqa: BLE001
        outcome = f'RAISED {type(e).__name__}: {e}'
    mp.undo()
    return log, outcome


# 1. OpenRouter's documented mid-stream error event (top-level error + choices with finish_reason "error").
openrouter_error = tsr.sse(
    {
        'id': 'gen-abc123',
        'object': 'chat.completion.chunk',
        'error': {'code': 502, 'message': 'Provider disconnected unexpectedly'},
        'choices': [{'index': 0, 'delta': {'content': ''}, 'finish_reason': 'error'}],
    }
)
log, outcome = run([tsr.chunk('The answer is'), openrouter_error, tsr.DONE])
show('1. OpenRouter mid-stream error chunk', log, outcome)


# 2. The upstream connection drops mid-stream (the body iterator raises).
async def dropping_body():
    yield tsr.chunk('Partial answer that the user already saw')
    raise ConnectionResetError('Connection reset by peer')


log, outcome = run(StreamingResponse(dropping_body()))
show('2. connection drops mid-stream', log, outcome, keys=('emit', 'chats.upsert_message', 'clear_response_stream'))


# 3. Tool call whose arguments are valid JSON but not an object.
tools = [tsr.tool('lookup', result={'ok': True})]
log, outcome = run(tsr.tool_call_stream('lookup', '[]'), metadata={'tools': tools}, continuations=[tsr.TEXT])
show('3. tool arguments "[]"', log, outcome)


# 4. Responses API: response.failed after some text.
failed = [
    tsr.RESP_TEXT[0], tsr.RESP_TEXT[1], tsr.RESP_TEXT[2],
    tsr.sse({'type': 'response.failed', 'response': {'error': {'code': 'server_error', 'message': 'upstream died'}}}),
]
log, outcome = run(failed)
show('4. Responses API response.failed', log, outcome, keys=('chats.upsert_message', 'emit'))
