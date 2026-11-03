"""A model answering in a channel sees the conversation it is answering (#328).

`model_response_handler` gives the model a history of earlier messages in
its system message, and the triggering message as the user turn. It used to
take that history from the trigger's thread only. In
`channels.model_response_mode='channel'` a model's answer is a top-level
message, so a reply to it ("Now divide that by 17.") has no thread, and the
model saw only that line. Also:

- the trigger was in the history and in the user turn, so twice;
- a second model mentioned in the same message saw the first model's empty
  placeholder;
- a thread with 50 or more replies lost its root question.

`_model_context_messages` now picks the history, and these tests run it
against the suite's SQLite database, plus the handler itself with the
models, the user lookup and the chat pipeline faked.

Run from apps/server:

    python -m pytest tests/test_channel_model_context.py
"""

from __future__ import annotations

import asyncio
import importlib
import pkgutil
import uuid
from types import SimpleNamespace

import local_llm.models as models_pkg
from local_llm.internal.db import Base, async_engine
from local_llm.models.channels import Channels, CreateChannelForm
from local_llm.models.messages import MessageForm, Messages
from local_llm.models.users import Users
from local_llm.routers import channels as channels_router

for module in pkgutil.iter_modules(models_pkg.__path__):
    importlib.import_module(f'local_llm.models.{module.name}')

MODEL = {'id': 'calc', 'name': 'Calc'}


def _run(scenario):
    async def go():
        async with async_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        return await scenario()

    return asyncio.run(go())


async def _channel():
    tag = uuid.uuid4().hex[:8]
    user = await Users.insert_new_user(f'u{tag}', 'Una', f'u{tag}@example.invalid', role='admin')
    assert user is not None
    form = CreateChannelForm(
        type='',
        name=f'maths-{tag}',
        access_grants=[{'principal_type': 'user', 'principal_id': '*', 'permission': 'read'}],
    )
    channel = await Channels.insert_new_channel(form, user.id)
    assert channel is not None

    async def post(content, parent_id=None, reply_to_id=None, model=False, data=None):
        message = await Messages.insert_new_message(
            MessageForm(
                content=content,
                parent_id=parent_id,
                reply_to_id=reply_to_id,
                data=data,
                meta={'model_id': MODEL['id'], 'model_name': MODEL['name']} if model else None,
            ),
            channel.id,
            user.id,
        )
        assert message is not None
        full = await Messages.get_message_by_id(message.id)
        assert full is not None
        return full

    return SimpleNamespace(channel=channel, user=user, post=post)


def _contents(messages):
    return [message.content for message in messages]


# Choosing the history


def test_channel_mode_reply_to_a_model_sees_the_earlier_top_level_turns():
    async def scenario():
        c = await _channel()
        await c.post('What is 17 times 23?')
        answer = await c.post('391', model=True)
        trigger = await c.post('Now divide that by 17.', reply_to_id=answer.id)
        return await channels_router._model_context_messages(c.channel.id, trigger, 'channel')

    assert _contents(_run(scenario)) == ['What is 17 times 23?', '391']


def test_channel_mode_includes_the_replied_to_message_outside_the_window():
    async def scenario():
        c = await _channel()
        answer = await c.post('391', model=True)
        for i in range(3):
            await c.post(f'chatter {i}')
        trigger = await c.post('Now divide that by 17.', reply_to_id=answer.id)
        return await channels_router._model_context_messages(c.channel.id, trigger, 'channel', limit=2)

    assert _contents(_run(scenario)) == ['391', 'chatter 1', 'chatter 2']


def test_thread_mode_top_level_reply_to_a_model_sees_that_answer():
    async def scenario():
        c = await _channel()
        await c.post('unrelated')
        answer = await c.post('391', model=True)
        trigger = await c.post('Now divide that by 17.', reply_to_id=answer.id)
        return await channels_router._model_context_messages(c.channel.id, trigger, 'thread')

    assert _contents(_run(scenario)) == ['391']


def test_a_replied_to_message_from_another_channel_is_not_shown():
    async def scenario():
        here, elsewhere = await _channel(), await _channel()
        foreign = await elsewhere.post('private answer elsewhere', model=True)
        trigger = await here.post('@calc and this?', reply_to_id=foreign.id)
        return await channels_router._model_context_messages(here.channel.id, trigger, 'channel')

    assert _run(scenario) == []


def test_messages_after_the_trigger_do_not_shrink_the_window():
    async def scenario():
        c = await _channel()
        for i in range(3):
            await c.post(f'before {i}')
        trigger = await c.post('@calc @other hello')
        await c.post('', model=True)
        await c.post('after')
        return await channels_router._model_context_messages(c.channel.id, trigger, 'channel', limit=2)

    assert _contents(_run(scenario)) == ['before 1', 'before 2']


def test_channel_mode_leaves_out_messages_after_the_trigger():
    async def scenario():
        c = await _channel()
        await c.post('earlier')
        trigger = await c.post('@calc hello')
        await c.post('later')
        return await channels_router._model_context_messages(c.channel.id, trigger, 'channel')

    assert _contents(_run(scenario)) == ['earlier']


def test_thread_mode_top_level_trigger_starts_with_no_history():
    async def scenario():
        c = await _channel()
        await c.post('unrelated top-level message')
        trigger = await c.post('@calc hello')
        return await channels_router._model_context_messages(c.channel.id, trigger, 'thread')

    assert _run(scenario) == []


def test_thread_history_is_the_root_and_earlier_replies_without_the_trigger():
    async def scenario():
        c = await _channel()
        root = await c.post('What is 17 times 23?')
        await c.post('391', parent_id=root.id, model=True)
        trigger = await c.post('Now divide that by 17.', parent_id=root.id)
        return await channels_router._model_context_messages(c.channel.id, trigger, 'thread')

    assert _contents(_run(scenario)) == ['What is 17 times 23?', '391']


def test_a_long_thread_keeps_its_root():
    async def scenario():
        c = await _channel()
        root = await c.post('the root question')
        for i in range(4):
            await c.post(f'reply {i}', parent_id=root.id)
        trigger = await c.post('and now?', parent_id=root.id)
        return await channels_router._model_context_messages(c.channel.id, trigger, 'channel', limit=3)

    assert _contents(_run(scenario)) == ['the root question', 'reply 1', 'reply 2', 'reply 3']


def test_an_unfinished_model_message_is_left_out():
    async def scenario():
        c = await _channel()
        root = await c.post('@calc @other what is 2+2?')
        await c.post('', parent_id=root.id, model=True)
        trigger = await c.post('well?', parent_id=root.id)
        return await channels_router._model_context_messages(c.channel.id, trigger, 'thread')

    assert _contents(_run(scenario)) == ['@calc @other what is 2+2?']


def test_a_thread_root_from_another_channel_is_not_shown():
    async def scenario():
        here, elsewhere = await _channel(), await _channel()
        foreign = await elsewhere.post('private question elsewhere')
        trigger = await here.post('@calc hello', parent_id=foreign.id)
        return await channels_router._model_context_messages(here.channel.id, trigger, 'thread')

    assert _run(scenario) == []


# The handler


def _fake_pipeline(monkeypatch, mode_value='channel'):
    sent = []

    async def all_models(request, user=None):
        return [MODEL]

    async def filtered(models, user):
        return models

    async def placeholder(request, channel_id, form_data, user, db):
        return SimpleNamespace(id='response'), SimpleNamespace(id=channel_id)

    async def defaults(app, model_id):
        return [], {}, [], None

    async def mode(key, default=None):
        return mode_value

    async def completion(request, form_data, user=None):
        sent.append(form_data)

    monkeypatch.setattr(channels_router, 'get_all_models', all_models)
    monkeypatch.setattr(channels_router, 'get_filtered_models', filtered)
    monkeypatch.setattr(channels_router, 'new_message_handler', placeholder)
    monkeypatch.setattr(channels_router.Config, 'get', mode)
    monkeypatch.setattr('local_llm.utils.automations._resolve_model_defaults', defaults)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(CHAT_COMPLETION_HANDLER=completion)))
    return request, sent


def test_the_handler_sends_the_history_once_and_the_trigger_as_the_user_turn(monkeypatch):
    request, sent = _fake_pipeline(monkeypatch)

    async def scenario():
        c = await _channel()
        await c.post('What is 17 times 23?')
        answer = await c.post('391', model=True)
        trigger = await c.post('Now divide that by 17.', reply_to_id=answer.id)
        trigger.data = {'files': [{'type': 'image', 'url': 'https://example.invalid/sum.png'}, {'id': 'f1'}]}
        await channels_router.model_response_handler(request, c.channel, trigger, c.user)
        return c.user

    user = _run(scenario)

    system, turn = sent[0]['messages']
    assert 'Una: What is 17 times 23?\n\nCalc: 391' in system['content']
    assert 'divide' not in system['content']
    # The trigger's own files still go with it.
    assert turn == {
        'role': 'user',
        'content': [
            {'type': 'text', 'text': f'{user.name}: Now divide that by 17.'},
            {'type': 'image_url', 'image_url': {'url': 'https://example.invalid/sum.png'}},
        ],
    }
    assert sent[0]['files'] == [{'id': 'f1'}]
    assert sent[0]['id'] == 'response'
    assert 'participating in a channel conversation' in system['content']
    assert "Here's the conversation so far" in system['content']


def test_the_handler_reads_an_old_replied_to_answer_in_full_and_only_its_files(monkeypatch):
    request, sent = _fake_pipeline(monkeypatch)

    async def scenario():
        c = await _channel()
        answer = await c.post(
            '391',
            model=True,
            data={
                'output': [{'type': 'message', 'content': '391'}],
                'files': [{'type': 'image', 'url': 'https://example.invalid/answer.png'}],
            },
        )
        await c.post(
            'chatter with a picture', data={'files': [{'type': 'image', 'url': 'https://example.invalid/cat.png'}]}
        )
        for i in range(3):
            await c.post(f'chatter {i}')
        trigger = await c.post('Now divide that by 17.', reply_to_id=answer.id)
        monkeypatch.setattr(channels_router, 'MODEL_CONTEXT_LIMIT', 2)
        await channels_router.model_response_handler(request, c.channel, trigger, c.user)

    _run(scenario)

    system, turn = sent[0]['messages']
    assert 'Calc: 391\n\nUna: chatter 1\n\nUna: chatter 2' in system['content']
    assert turn['content'][1:] == [{'type': 'image_url', 'image_url': {'url': 'https://example.invalid/answer.png'}}]


def test_the_handler_in_a_thread_says_thread(monkeypatch):
    request, sent = _fake_pipeline(monkeypatch, 'thread')

    async def scenario():
        c = await _channel()
        root = await c.post('What is 17 times 23?')
        answer = await c.post('391', parent_id=root.id, model=True)
        trigger = await c.post('well?', parent_id=root.id, reply_to_id=answer.id)
        await channels_router.model_response_handler(request, c.channel, trigger, c.user)

    _run(scenario)

    system = sent[0]['messages'][0]['content']
    assert 'participating in a threaded conversation' in system
    assert "Here's the thread history" in system
    assert 'Una: What is 17 times 23?\n\nCalc: 391' in system
