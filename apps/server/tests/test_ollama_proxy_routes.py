"""Three Ollama proxy-route defects (#345).

1. show, copy, delete and push find a model by the id the app lists, which
   carries the connection's prefix_id, and sent that id on to Ollama, which
   knows the model only by its own name. They never succeeded for a prefixed
   connection.
2. ChatMessage's check ran on `content` before `tool_calls` was read, so a
   tool-call turn with no content was refused, and a message with neither
   passed (an unset field was never checked).
3. /ollama/models/upload removed the uploaded file only after a successful
   push to Ollama, so a failed one left a multi-gigabyte file behind.

Run from apps/server:

    python -m pytest tests/test_ollama_proxy_routes.py
"""

import asyncio
import io
import json
import os
from collections.abc import AsyncGenerator
from types import SimpleNamespace
from typing import cast

import aiohttp
import pytest
from aiohttp import web
from fastapi import Request, UploadFile
from pydantic import ValidationError

from local_llm.routers import ollama

USER = SimpleNamespace(id='admin', role='admin')


class _Config:
    """Config as the proxy routes read it: one connection, prefixed with `p`."""

    def __init__(self, prefix_id: str | None = 'p'):
        self.values = {
            'ollama.enable': True,
            'ollama.base_urls': ['http://ollama.invalid'],
            'ollama.api_configs': {'0': {'prefix_id': prefix_id}} if prefix_id else {},
        }

    async def get(self, key, default=None):
        return self.values.get(key, default)

    async def get_many(self, *keys):
        return {key: self.values[key] for key in keys if key in self.values}


def _proxy(monkeypatch, prefix_id: str | None = 'p', listed: str = 'p.llama3', events: list | None = None):
    """Fakes the connection and Ollama; gives the request and what was sent."""
    sent: list[tuple[str, dict]] = []
    published = [] if events is None else events

    async def send_request(url, *args, payload: str | bytes = b'{}', **kwargs):
        sent.append((url, json.loads(payload)))
        return True

    async def nothing(*args, **kwargs):
        return None

    async def publish_event(request, event, **kwargs):
        published.append(kwargs)

    monkeypatch.setattr(ollama, 'Config', _Config(prefix_id))
    monkeypatch.setattr(ollama, 'send_request', send_request)
    monkeypatch.setattr(ollama, 'get_all_models', nothing)
    monkeypatch.setattr(ollama, 'publish_event', publish_event)
    monkeypatch.setattr(ollama, 'check_model_access', nothing)
    monkeypatch.setattr(ollama.Models, 'get_model_by_id', nothing)
    return _request({listed: {'urls': [0]}}), sent


def _request(models: dict | None = None) -> Request:
    """A request whose app lists `models`, as get_all_models leaves them."""
    app = SimpleNamespace(state=SimpleNamespace(OLLAMA_MODELS=models or {}))
    return Request({'type': 'http', 'app': app})


# --- 1. The prefixed id the app lists is sent to Ollama as Ollama's own name ---------


def test_push_sends_the_model_without_the_connection_prefix(monkeypatch):
    request, sent = _proxy(monkeypatch)
    asyncio.run(ollama.push_model(request, ollama.PushModelForm(model='p.llama3'), user=USER))

    assert sent == [('http://ollama.invalid/api/push', {'model': 'llama3'})]


def test_copy_sends_the_source_and_destination_without_the_connection_prefix(monkeypatch):
    request, sent = _proxy(monkeypatch)
    asyncio.run(
        ollama.copy_model(request, ollama.CopyModelForm(source='p.llama3', destination='p.llama3-copy'), user=USER)
    )

    assert sent == [('http://ollama.invalid/api/copy', {'source': 'llama3', 'destination': 'llama3-copy'})]


def test_delete_sends_the_model_without_the_connection_prefix(monkeypatch):
    request, sent = _proxy(monkeypatch)
    asyncio.run(ollama.delete_model(request, ollama.ModelNameForm(model='p.llama3'), user=USER))

    assert sent == [('http://ollama.invalid/api/delete', {'model': 'llama3'})]


def test_delete_by_the_older_name_field_sends_it_without_the_prefix_too(monkeypatch):
    request, sent = _proxy(monkeypatch)
    asyncio.run(ollama.delete_model(request, ollama.ModelNameForm.model_validate({'name': 'p.llama3'}), user=USER))

    assert sent == [('http://ollama.invalid/api/delete', {'model': 'llama3', 'name': 'llama3'})]


def test_show_sends_the_model_without_the_connection_prefix(monkeypatch):
    request, sent = _proxy(monkeypatch)
    asyncio.run(ollama.show_model_info(request, ollama.ModelNameForm(model='p.llama3'), user=USER))

    assert sent == [('http://ollama.invalid/api/show', {'model': 'llama3'})]


def test_a_connection_without_a_prefix_sends_the_model_as_it_is(monkeypatch):
    request, sent = _proxy(monkeypatch, prefix_id=None, listed='llama3')
    asyncio.run(ollama.push_model(request, ollama.PushModelForm(model='llama3'), user=USER))
    asyncio.run(ollama.show_model_info(request, ollama.ModelNameForm(model='llama3'), user=USER))

    assert [payload for _, payload in sent] == [{'model': 'llama3'}, {'model': 'llama3'}]


def test_a_named_instance_is_sent_the_name_as_given(monkeypatch):
    # With url_idx, the caller has Ollama's own name (Manage Ollama lists it from
    # /api/tags/{url_idx}); a native name that starts like the prefix is kept.
    request, sent = _proxy(monkeypatch, prefix_id='qwen2')
    asyncio.run(ollama.delete_model(request, ollama.ModelNameForm(model='qwen2.5-coder:7b'), url_idx=0, user=USER))
    asyncio.run(ollama.push_model(request, ollama.PushModelForm(model='qwen2.5-coder:7b'), url_idx=0, user=USER))

    assert [payload for _, payload in sent] == [{'model': 'qwen2.5-coder:7b'}, {'model': 'qwen2.5-coder:7b'}]


def test_a_copy_is_announced_by_the_id_the_app_lists_it_under(monkeypatch):
    events = []
    request, _ = _proxy(monkeypatch, events=events)
    for destination in ('llama3-copy', 'p.llama3-copy'):
        asyncio.run(
            ollama.copy_model(request, ollama.CopyModelForm(source='p.llama3', destination=destination), user=USER)
        )

    assert [event['subject_id'] for event in events] == ['p.llama3-copy', 'p.llama3-copy']


# --- 2. A chat message needs something to say, checked once all of it is read -------


def test_a_tool_call_turn_without_content_is_accepted():
    message = ollama.ChatMessage(
        role='assistant', content=None, tool_calls=[{'function': {'name': 'now', 'arguments': {}}}]
    )

    assert message.tool_calls == [{'function': {'name': 'now', 'arguments': {}}}]


def test_a_message_with_nothing_in_it_is_refused():
    with pytest.raises(ValidationError, match='A message needs content, tool_calls, images or thinking'):
        ollama.ChatMessage(role='user')
    with pytest.raises(ValidationError, match='A message needs content, tool_calls, images or thinking'):
        ollama.ChatMessage(role='user', content=None, tool_calls=None)


def test_an_image_only_turn_from_the_chat_is_accepted():
    from local_llm.utils.payload import convert_messages_openai_to_ollama

    # The composer sends files with no prompt; the converter then sets no content.
    (message,) = convert_messages_openai_to_ollama(
        [{'role': 'user', 'content': [{'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,AAA'}}]}]
    )
    form = ollama.GenerateChatCompletionForm.model_validate({'model': 'llava', 'messages': [message]})

    assert form.messages[0].images == ['AAA']


def test_a_thinking_only_turn_is_accepted():
    message = ollama.ChatMessage.model_validate({'role': 'assistant', 'thinking': 'hm'})

    assert message.model_dump(exclude_none=True) == {'role': 'assistant', 'thinking': 'hm'}


def test_a_message_with_content_is_accepted_as_before():
    assert ollama.ChatMessage(role='user', content='hello').content == 'hello'
    assert ollama.ChatMessage(role='user', content='').content == ''


# --- 3. The uploaded file is removed whatever happens to the push --------------------


def _upload(monkeypatch, tmp_path, blob_status: int, read_all: bool = True):
    """Uploads a small model file through the route, with a loopback Ollama."""

    async def blobs(request):
        await request.read()
        return web.Response(status=blob_status)

    async def create(request):
        return web.Response(status=200, text='{}')

    async def run():
        app = web.Application(client_max_size=16 * 1024 * 1024)
        app.router.add_post('/api/blobs/{digest}', blobs)
        app.router.add_post('/api/create', create)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, '127.0.0.1', 0)
        await site.start()
        session = aiohttp.ClientSession(trust_env=False)

        async def fresh_session():
            return session

        config = _Config(prefix_id=None)
        config.values['ollama.base_urls'] = [f'http://127.0.0.1:{runner.addresses[0][1]}']
        monkeypatch.setattr(ollama, 'Config', config)
        monkeypatch.setattr(ollama, 'get_session', fresh_session)
        monkeypatch.setattr(ollama, 'UPLOAD_DIR', str(tmp_path))
        events = []
        try:
            upload = UploadFile(file=io.BytesIO(os.urandom(256 * 1024)), filename='m.gguf')
            response = await ollama.upload_model(_request(), file=upload, url_idx=0, user=USER)
            # The route's own generator, so it can be closed as a client that goes away closes it.
            stream = cast(AsyncGenerator[str, None], response.body_iterator)
            async for chunk in stream:
                events.append(json.loads(str(chunk).removeprefix('data: ').strip()))
                if not read_all:
                    # A client that stops reading: the response closes the stream.
                    await stream.aclose()
                    break
        finally:
            await session.close()
            await runner.cleanup()
        return events

    return asyncio.run(run())


def test_a_failed_push_to_ollama_removes_the_uploaded_file(monkeypatch, tmp_path):
    events = _upload(monkeypatch, tmp_path, blob_status=500)

    assert 'error' in events[-1]
    assert not (tmp_path / 'm.gguf').exists()


def test_a_successful_upload_leaves_no_file_either(monkeypatch, tmp_path):
    events = _upload(monkeypatch, tmp_path, blob_status=201)

    assert events[-1].get('done') is True
    assert not (tmp_path / 'm.gguf').exists()


def test_an_upload_the_client_stops_reading_removes_the_file(monkeypatch, tmp_path):
    _upload(monkeypatch, tmp_path, blob_status=201, read_all=False)

    assert not (tmp_path / 'm.gguf').exists()


def test_an_upload_the_client_disconnects_from_mid_push_removes_the_file(monkeypatch, tmp_path):
    """As Starlette abandons the stream: it cancels the task the stream runs in."""

    async def slow_blob(request):
        await asyncio.sleep(5)
        return web.Response(status=201)

    async def run():
        app = web.Application(client_max_size=16 * 1024 * 1024)
        app.router.add_post('/api/blobs/{digest}', slow_blob)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, '127.0.0.1', 0)
        await site.start()
        session = aiohttp.ClientSession(trust_env=False)

        async def fresh_session():
            return session

        config = _Config(prefix_id=None)
        config.values['ollama.base_urls'] = [f'http://127.0.0.1:{runner.addresses[0][1]}']
        monkeypatch.setattr(ollama, 'Config', config)
        monkeypatch.setattr(ollama, 'get_session', fresh_session)
        monkeypatch.setattr(ollama, 'UPLOAD_DIR', str(tmp_path))
        try:
            upload = UploadFile(file=io.BytesIO(os.urandom(256 * 1024)), filename='m.gguf')
            response = await ollama.upload_model(_request(), file=upload, url_idx=0, user=USER)

            async def receive():
                await asyncio.sleep(0.3)  # mid-push, while Ollama takes the blob
                return {'type': 'http.disconnect'}

            async def send(message):
                return None

            scope = {'type': 'http', 'asgi': {'spec_version': '2.3'}, 'method': 'POST', 'headers': []}
            await asyncio.wait_for(response(scope, receive, send), timeout=4)
        finally:
            await session.close()
            await runner.cleanup()

    asyncio.run(run())

    assert not (tmp_path / 'm.gguf').exists()


def test_an_upload_that_fails_while_it_is_saved_leaves_no_file(monkeypatch, tmp_path):
    class Broken(io.BytesIO):
        def __init__(self):
            super().__init__(os.urandom(1024))
            self.reads = 0

        def read(self, size: int | None = -1, /) -> bytes:
            self.reads += 1
            if self.reads > 1:
                raise OSError('the connection dropped')
            return super().read(size)

    monkeypatch.setattr(ollama, 'Config', _Config(prefix_id=None))
    monkeypatch.setattr(ollama, 'UPLOAD_DIR', str(tmp_path))
    monkeypatch.setattr(ollama, 'AIOHTTP_FILE_STREAM_CHUNK_SIZE', 256)
    upload = UploadFile(file=Broken(), filename='m.gguf')

    with pytest.raises(OSError, match='the connection dropped'):
        asyncio.run(ollama.upload_model(_request(), file=upload, url_idx=0, user=USER))
    assert not (tmp_path / 'm.gguf').exists()
