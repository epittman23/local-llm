"""Deleting a thread's parent message deletes the thread with it (#277).

Delete removed only the message and its own reactions, so a parent's replies
stayed in the database: gone from the channel and thread views, but still in
the pinned list and in the search_messages tool results given to the model,
with their reactions.

Runs against the suite's temporary SQLite database (tests/conftest.py points
DATA_DIR at a temp directory, and DATABASE_URL defaults to a file in it).

Run from apps/server:

    python -m pytest tests/test_channel_thread_delete.py
"""

import asyncio
import importlib
import pkgutil
import uuid

import local_llm.models as models_pkg
from local_llm.internal.db import Base, async_engine
from local_llm.models.channels import Channels, CreateChannelForm
from local_llm.models.messages import MessageForm, Messages
from local_llm.models.users import Users

for module in pkgutil.iter_modules(models_pkg.__path__):
    importlib.import_module(f'local_llm.models.{module.name}')


def _run(scenario):
    async def go():
        async with async_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        return await scenario()

    return asyncio.run(go())


async def _channel_with_thread():
    tag = uuid.uuid4().hex[:8]
    user = await Users.insert_new_user(f'u{tag}', 'Una', f'u{tag}@example.invalid', role='admin')
    assert user is not None
    form = CreateChannelForm(
        type='',
        name=f'general-{tag}',
        access_grants=[{'principal_type': 'user', 'principal_id': '*', 'permission': 'read'}],
    )
    channel = await Channels.insert_new_channel(form, user.id)
    assert channel is not None

    async def post(content, parent_id=None):
        message = await Messages.insert_new_message(
            MessageForm(content=f'{content} {tag}', parent_id=parent_id), channel.id, user.id
        )
        assert message is not None
        return message

    parent = await post('parent')
    reply = await post('secret reply in thread', parent_id=parent.id)
    nested = await post('secret nested reply', parent_id=reply.id)
    bystander = await post('unrelated message')
    for message in (reply, nested, bystander):
        await Messages.update_is_pinned_by_id(message.id, True, pinned_by=user.id)
        await Messages.add_reaction_to_message(message.id, user.id, 'eyes')
    return tag, user, channel, parent, reply, nested, bystander


def test_deleting_a_parent_takes_its_replies_pins_and_reactions_with_it():
    async def scenario():
        tag, _user, channel, parent, reply, nested, bystander = await _channel_with_thread()

        assert await Messages.delete_message_by_id(parent.id) is True

        return {
            'bystander': bystander.id,
            'pinned': [m.id for m in await Messages.get_pinned_messages_by_channel_id(channel.id)],
            'searched': [m.id for m in await Messages.search_messages_by_channel_ids([channel.id], tag)],
            'reply': await Messages.get_message_by_id(reply.id),
            'nested': await Messages.get_message_by_id(nested.id),
            'reply_reactions': await Messages.get_reactions_by_message_id(reply.id),
            'nested_reactions': await Messages.get_reactions_by_message_id(nested.id),
            'bystander_reactions': [r.name for r in await Messages.get_reactions_by_message_id(bystander.id)],
        }

    seen = _run(scenario)

    assert seen['pinned'] == [seen['bystander']]
    assert seen['searched'] == [seen['bystander']]
    assert seen['reply'] is None
    assert seen['nested'] is None
    assert seen['reply_reactions'] == []
    assert seen['nested_reactions'] == []
    assert seen['bystander_reactions'] == ['eyes']


def test_deleting_a_reply_leaves_its_parent_and_siblings():
    async def scenario():
        tag, user, channel, parent, reply, nested, _bystander = await _channel_with_thread()
        sibling = await Messages.insert_new_message(
            MessageForm(content=f'sibling {tag}', parent_id=parent.id), channel.id, user.id
        )
        assert sibling is not None

        await Messages.delete_message_by_id(reply.id)

        return {
            'parent': await Messages.get_message_by_id(parent.id),
            'sibling': await Messages.get_message_by_id(sibling.id),
            'nested': await Messages.get_message_by_id(nested.id),
        }

    seen = _run(scenario)

    assert seen['parent'] is not None
    assert seen['parent'].reply_count == 1
    assert seen['sibling'] is not None
    assert seen['nested'] is None


def test_a_message_gone_already_is_neither_deleted_nor_updated():
    """A model reply still streaming into a thread whose parent was deleted finds its row gone."""

    async def scenario():
        _tag, _user, _channel, parent, reply, _nested, _bystander = await _channel_with_thread()
        await Messages.delete_message_by_id(parent.id)
        return (
            await Messages.delete_message_by_id(parent.id),
            await Messages.update_message_by_id(reply.id, MessageForm(content='late token')),
        )

    deleted_again, updated = _run(scenario)

    assert deleted_again is True
    assert updated is None
