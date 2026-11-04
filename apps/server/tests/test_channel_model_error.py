"""A channel model reply that fails ends as an error instead of "Thinking" forever (#329).

`model_response_handler` inserts the model's empty reply first, then calls
the chat pipeline. A failure the pipeline raises before its task starts (a
workspace model whose base model is gone: "Model not found") was only
logged, so the reply stayed empty, and the channel shows an empty model
reply as "Thinking". Now the reply is finished as `Error: ...`, marked done,
through the channel emitter's own error path, which also sends the update to
the channel's room.

Runs against the suite's SQLite database; the model list, the model defaults,
the chat pipeline and the socket emit are faked.

Run from apps/server:

    python -m pytest tests/test_channel_model_error.py
"""

from __future__ import annotations

import asyncio
import importlib
import pkgutil
import uuid
from types import SimpleNamespace

from fastapi import HTTPException

import local_llm.models as models_pkg
from local_llm.internal.db import Base, async_engine
from local_llm.models.channels import Channels, CreateChannelForm
from local_llm.models.messages import MessageForm, Messages
from local_llm.models.users import Users
from local_llm.routers import channels as channels_router
from local_llm.socket import main as socket_main

for module in pkgutil.iter_modules(models_pkg.__path__):
    importlib.import_module(f'local_llm.models.{module.name}')

MODEL = {'id': 'calc', 'name': 'Calc'}


def _harness(monkeypatch, completion):
    emitted = []
    placeholders = []

    async def all_models(request, user=None):
        return [MODEL]

    async def filtered(models, user):
        return models

    async def placeholder(request, channel_id, form_data, user, db):
        message = await Messages.insert_new_message(form_data, channel_id, user.id)
        assert message is not None
        placeholders.append(message.id)
        return message, await Channels.get_channel_by_id(channel_id)

    async def defaults(app, model_id):
        return [], {}, [], None

    async def mode(key, default=None):
        return 'thread'

    async def emit(event, data, to=None):
        emitted.append((event, to, data))

    monkeypatch.setattr(channels_router, 'get_all_models', all_models)
    monkeypatch.setattr(channels_router, 'get_filtered_models', filtered)
    monkeypatch.setattr(channels_router, 'new_message_handler', placeholder)
    monkeypatch.setattr(channels_router.Config, 'get', mode)
    monkeypatch.setattr('local_llm.utils.automations._resolve_model_defaults', defaults)
    monkeypatch.setattr(socket_main.sio, 'emit', emit)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(CHAT_COMPLETION_HANDLER=completion)))
    return SimpleNamespace(request=request, emitted=emitted, placeholders=placeholders)


def _ask(h):
    async def go():
        async with async_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        tag = uuid.uuid4().hex[:8]
        user = await Users.insert_new_user(f'u{tag}', 'Una', f'u{tag}@example.invalid', role='admin')
        assert user is not None
        form = CreateChannelForm(
            type='',
            name=f'errors-{tag}',
            access_grants=[{'principal_type': 'user', 'principal_id': '*', 'permission': 'read'}],
        )
        channel = await Channels.insert_new_channel(form, user.id)
        assert channel is not None
        answer = await Messages.insert_new_message(
            MessageForm(content='391', meta={'model_id': MODEL['id']}), channel.id, user.id
        )
        assert answer is not None
        trigger = await Messages.insert_new_message(
            MessageForm(content='and divided by 17?', reply_to_id=answer.id), channel.id, user.id
        )
        assert trigger is not None
        full = await Messages.get_message_by_id(trigger.id)
        await channels_router.model_response_handler(h.request, channel, full, user)
        return channel, [await Messages.get_message_by_id(mid) for mid in h.placeholders]

    return asyncio.run(go())


def test_a_completion_that_fails_before_its_task_finishes_the_reply_as_an_error(monkeypatch):
    async def completion(request, form_data, user=None):
        raise HTTPException(status_code=400, detail='Model not found')

    h = _harness(monkeypatch, completion)
    channel, (reply,) = _ask(h)

    assert reply is not None
    assert reply.content == 'Error: Model not found'
    assert reply.meta == {'model_id': 'calc', 'model_name': 'Calc', 'done': True}
    assert [(event, to) for event, to, _ in h.emitted] == [('events:channel', f'channel:{channel.id}')]
    assert h.emitted[0][2]['data']['data']['content'] == 'Error: Model not found'


def test_an_unexpected_failure_is_reported_without_its_details(monkeypatch, caplog):
    async def completion(request, form_data, user=None):
        raise RuntimeError('connection to 10.0.0.5:5432 refused')

    h = _harness(monkeypatch, completion)
    _, (reply,) = _ask(h)

    # Every member of the channel sees the reply; the details are in the log only.
    assert reply is not None
    assert reply.content == 'Error: An error occurred'
    assert (reply.meta or {}).get('done') is True
    assert '10.0.0.5' in caplog.text


def test_when_one_of_several_models_fails_the_others_replies_are_left_alone(monkeypatch):
    async def completion(request, form_data, user=None):
        return {'status': True}

    h = _harness(monkeypatch, completion)
    second = {'id': 'other', 'name': 'Other'}

    async def two_models(request, user=None):
        return [MODEL, second]

    real_placeholder = channels_router.new_message_handler

    async def second_fails(request, channel_id, form_data, user, db):
        if form_data.meta and form_data.meta.get('model_id') == 'other':
            raise HTTPException(status_code=403, detail='No access to Other')
        return await real_placeholder(request, channel_id, form_data, user, db)

    monkeypatch.setattr(channels_router, 'get_all_models', two_models)
    monkeypatch.setattr(channels_router, 'new_message_handler', second_fails)
    monkeypatch.setattr(channels_router, 'extract_mentions', lambda content: [{'id': 'other', 'id_type': 'M'}])

    _, (first_reply,) = _ask(h)

    assert first_reply is not None
    assert first_reply.content == ''
    assert 'done' not in (first_reply.meta or {})
    assert h.emitted == []


def test_a_completion_that_starts_leaves_the_reply_to_the_pipeline(monkeypatch):
    async def completion(request, form_data, user=None):
        return {'status': True}

    h = _harness(monkeypatch, completion)
    _, (reply,) = _ask(h)

    assert reply is not None
    assert reply.content == ''
    assert 'done' not in (reply.meta or {})
    assert h.emitted == []


def test_an_error_reply_is_not_given_to_the_next_model_as_history():
    async def go():
        async with async_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        tag = uuid.uuid4().hex[:8]
        user = await Users.insert_new_user(f'u{tag}', 'Una', f'u{tag}@example.invalid', role='admin')
        assert user is not None
        form = CreateChannelForm(type='', name=f'history-{tag}', access_grants=[])
        channel = await Channels.insert_new_channel(form, user.id)
        assert channel is not None

        async def post(content, parent_id=None, meta=None):
            message = await Messages.insert_new_message(
                MessageForm(content=content, parent_id=parent_id, meta=meta), channel.id, user.id
            )
            assert message is not None
            return await Messages.get_message_by_id(message.id)

        root = await post('What is 17 times 23?')
        assert root is not None
        await post('Error: Model not found', parent_id=root.id, meta={'model_id': 'calc', 'done': True})
        await post('Error: is a word I use', parent_id=root.id)
        trigger = await post('try again', parent_id=root.id)
        return await channels_router._model_context_messages(channel.id, trigger, 'thread')

    history = asyncio.run(go())

    assert [m.content for m in history] == ['What is 17 times 23?', 'Error: is a word I use']


def test_a_failure_while_reporting_the_error_is_only_logged(monkeypatch, caplog):
    async def completion(request, form_data, user=None):
        raise RuntimeError('connection refused')

    async def broken_emitter(request_info, update_db=True):
        raise RuntimeError('socket gone')

    h = _harness(monkeypatch, completion)
    monkeypatch.setattr(socket_main, 'get_event_emitter', broken_emitter)
    _, (reply,) = _ask(h)

    assert reply is not None
    assert reply.content == ''
    assert 'socket gone' in caplog.text
