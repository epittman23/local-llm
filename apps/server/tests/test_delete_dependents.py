"""Deleting a channel or a note removes what only it held (#333).

Channel delete removed the channel's grants and its row, and nothing else:
its messages, their reactions, its memberships and its webhooks stayed in the
database, unreachable. Note delete left the note's hidden chats (each user's
chat with the note, `meta.type == 'note'`). Runs against the test run's
migrated SQLite database.

Run from apps/server:

    python -m pytest tests/test_delete_dependents.py
"""

import asyncio
import importlib
import uuid

from sqlalchemy import func, select

from local_llm.internal.db import get_async_db_context
from local_llm.models.channels import ChannelMember, Channels, ChannelWebhook, ChannelWebhookForm, CreateChannelForm
from local_llm.models.chat_messages import ChatMessage, ChatMessages
from local_llm.models.chats import Chat, ChatForm, Chats
from local_llm.models.messages import Message, MessageForm, MessageReaction, Messages
from local_llm.models.notes import NoteForm, Notes
from local_llm.models.users import Users

# Importing the config runs the migrations on the test run's database.
importlib.import_module('local_llm.config')


def _run(coro):
    return asyncio.run(coro)


async def _count(model, *where):
    async with get_async_db_context() as db:
        return (await db.execute(select(func.count()).select_from(model).where(*where))).scalar()


def test_deleting_a_channel_removes_its_messages_reactions_members_and_webhooks():
    tag = uuid.uuid4().hex[:8]

    async def go():
        ann = await Users.insert_new_user(f'ann{tag}', 'Ann', f'ann{tag}@example.invalid', role='admin')
        ben = await Users.insert_new_user(f'ben{tag}', 'Ben', f'ben{tag}@example.invalid', role='user')
        channel = await Channels.insert_new_channel(CreateChannelForm(type='group', name=f'c-{tag}'), ann.id)
        keep = await Channels.insert_new_channel(CreateChannelForm(type='group', name=f'k-{tag}'), ann.id)
        for c in (channel, keep):
            await Channels.join_channel(c.id, ben.id)
            await Channels.insert_webhook(c.id, ann.id, ChannelWebhookForm(name='Bot'))
            root = await Messages.insert_new_message(MessageForm(content='hi'), c.id, ann.id)
            await Messages.insert_new_message(MessageForm(content='re', parent_id=root.id), c.id, ben.id)
            await Messages.add_reaction_to_message(root.id, ben.id, 'thumbsup')

        assert await Channels.delete_channel_by_id(channel.id)

        gone = {
            'messages': await _count(Message, Message.channel_id == channel.id),
            'members': await _count(ChannelMember, ChannelMember.channel_id == channel.id),
            'webhooks': await _count(ChannelWebhook, ChannelWebhook.channel_id == channel.id),
        }
        kept = {
            'messages': await _count(Message, Message.channel_id == keep.id),
            'members': await _count(ChannelMember, ChannelMember.channel_id == keep.id),
            'webhooks': await _count(ChannelWebhook, ChannelWebhook.channel_id == keep.id),
        }
        return gone, kept

    gone, kept = _run(go())

    # The reactions are checked by message id in the next test.
    assert gone == {'messages': 0, 'members': 0, 'webhooks': 0}
    assert kept['messages'] == 2 and kept['members'] >= 1 and kept['webhooks'] == 1


def test_deleting_a_channel_removes_the_reactions_on_its_messages():
    tag = uuid.uuid4().hex[:8]

    async def go():
        ann = await Users.insert_new_user(f'ann{tag}', 'Ann', f'ann{tag}@example.invalid', role='admin')
        channel = await Channels.insert_new_channel(CreateChannelForm(type='group', name=f'c-{tag}'), ann.id)
        message = await Messages.insert_new_message(MessageForm(content='hi'), channel.id, ann.id)
        await Messages.add_reaction_to_message(message.id, ann.id, 'tada')
        await Channels.delete_channel_by_id(channel.id)
        return await _count(MessageReaction, MessageReaction.message_id == message.id)

    assert _run(go()) == 0


def test_deleting_a_note_removes_every_users_chat_with_it():
    tag = uuid.uuid4().hex[:8]

    async def go():
        ann = await Users.insert_new_user(f'ann{tag}', 'Ann', f'ann{tag}@example.invalid', role='user')
        ben = await Users.insert_new_user(f'ben{tag}', 'Ben', f'ben{tag}@example.invalid', role='user')
        note = await Notes.insert_new_note(ann.id, NoteForm(title='Plan'))
        other = await Notes.insert_new_note(ann.id, NoteForm(title='Other'))
        for user_id, note_id in ((ann.id, note.id), (ben.id, note.id), (ann.id, other.id)):
            await Chats.insert_new_chat(
                str(uuid.uuid4()),
                user_id,
                ChatForm(chat={'title': 'note chat'}),
                internal_meta={'internal': True, 'type': 'note', 'note_id': note_id},
            )

        ann_chat = (await Chats.get_internal_chats_by_note_id(note.id, ann.id))[0]
        await ChatMessages.upsert_message('m1', ann_chat.id, ann.id, {'role': 'user', 'content': 'hi'})
        # A chat spawned from the note chat, as a subagent or a timer is.
        child = await Chats.insert_new_chat(
            str(uuid.uuid4()),
            ann.id,
            ChatForm(chat={'title': 'subagent'}),
            internal_meta={'internal': True, 'parent_chat_id': ann_chat.id},
        )

        assert await Notes.delete_note_by_id(note.id)

        note_chats = Chat.meta['note_id'].as_string()
        return (
            await _count(Chat, note_chats == note.id),
            await _count(Chat, note_chats == other.id),
            await _count(ChatMessage, ChatMessage.chat_id == ann_chat.id),
            await Chats.get_chat_by_id(child.id),
        )

    assert _run(go()) == (0, 1, 0, None)


def test_a_failed_chat_cleanup_still_reports_the_note_deleted(monkeypatch):
    """The note is committed as deleted before its chats go, so it must read as deleted."""
    tag = uuid.uuid4().hex[:8]

    async def failing(*_a, **_k):
        raise RuntimeError('database went away')

    monkeypatch.setattr(Chats, 'delete_internal_chats_by_note_id', failing)

    async def go():
        ann = await Users.insert_new_user(f'ann{tag}', 'Ann', f'ann{tag}@example.invalid', role='user')
        note = await Notes.insert_new_note(ann.id, NoteForm(title='Plan'))
        return await Notes.delete_note_by_id(note.id), await Notes.get_note_by_id(note.id)

    assert _run(go()) == (True, None)
