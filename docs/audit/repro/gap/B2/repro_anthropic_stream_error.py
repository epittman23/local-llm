import asyncio, json
from local_llm.utils.anthropic import openai_stream_to_anthropic_stream, convert_openai_to_anthropic_response

def line(obj): return f'data: {json.dumps(obj)}\n'.encode()

async def src_midstream_error():
    yield line({'choices': [{'index': 0, 'delta': {'content': 'Partial ans'}}]})
    # OpenRouter's documented mid-stream error chunk
    yield line({'error': {'code': 'server_error', 'message': 'Provider disconnected unexpectedly'},
                'choices': [{'index': 0, 'delta': {'content': ''}, 'finish_reason': 'error'}]})
    yield b'data: [DONE]\n'

async def src_raises():
    yield line({'choices': [{'index': 0, 'delta': {'content': 'Partial ans'}}]})
    raise ConnectionResetError('upstream connection reset')

async def show(gen):
    async for ev in openai_stream_to_anthropic_stream(gen, model='m'):
        print('  ', ev.decode().strip().replace('\n', ' | '))

async def main():
    print('mid-stream provider error:'); await show(src_midstream_error())
    print('source stream raises:'); await show(src_raises())
    print('non-stream error body:', convert_openai_to_anthropic_response(
        {'error': {'message': 'quota exceeded', 'code': 429}}, model='m'))

asyncio.run(main())
