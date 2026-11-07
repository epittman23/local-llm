"""Deleting a channel or a note removes what only it held (#333).

Channel delete removed the channel's grants and its row, and nothing else:
its messages, their reactions, its memberships and its webhooks stayed in the
database, unreachable. Note delete left the note's hidden chats (each user's
chat with the note, `meta.type == 'note'`). Purging a user who leaves no
administrator to take their channels and notes deletes them the same way, and
a note delete first stops the replies running in its chats (#713). Runs
against the test run's migrated SQLite database.

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


def test_purging_a_user_with_no_successor_removes_what_their_channels_and_notes_held(monkeypatch):
    """Purge deleted the user's channel and note rows alone, leaving what #333 removes (#713)."""
    from local_llm.models.access_grants import AccessGrant, AccessGrants
    from local_llm.models.notes import PinnedNote
    from local_llm.utils import user_purge

    async def nobody(*_a, **_k):
        return None

    # Other tests leave admins in the shared database: force the path that deletes.
    monkeypatch.setattr(user_purge, '_successor_id', nobody)
    monkeypatch.setattr(user_purge, '_remove_stored_data', nobody)
    tag = uuid.uuid4().hex[:8]

    async def go():
        gone = await Users.insert_new_user(f'gone{tag}', 'Gone', f'gone{tag}@example.invalid', role='user')
        ben = await Users.insert_new_user(f'ben{tag}', 'Ben', f'ben{tag}@example.invalid', role='admin')
        channel = await Channels.insert_new_channel(CreateChannelForm(type='group', name=f'c-{tag}'), gone.id)
        await Channels.join_channel(channel.id, ben.id)
        await Channels.insert_webhook(channel.id, ben.id, ChannelWebhookForm(name='Bot'))
        message = await Messages.insert_new_message(MessageForm(content='hi'), channel.id, ben.id)
        await Messages.add_reaction_to_message(message.id, ben.id, 'thumbsup')
        await AccessGrants.grant_access('channel', channel.id, 'user', ben.id, 'read')

        note = await Notes.insert_new_note(gone.id, NoteForm(title='Plan'))
        await Notes.toggle_note_pinned_by_id(note.id, ben.id)
        ben_chat = await Chats.insert_new_chat(
            str(uuid.uuid4()),
            ben.id,
            ChatForm(chat={'title': 'note chat'}),
            internal_meta={'internal': True, 'type': 'note', 'note_id': note.id},
        )
        child = await Chats.insert_new_chat(
            str(uuid.uuid4()),
            ben.id,
            ChatForm(chat={'title': 'subagent'}),
            internal_meta={'internal': True, 'parent_chat_id': ben_chat.id},
        )

        assert await Users.delete_user_by_id(gone.id)

        return {
            'messages': await _count(Message, Message.channel_id == channel.id),
            'reactions': await _count(MessageReaction, MessageReaction.message_id == message.id),
            'members': await _count(ChannelMember, ChannelMember.channel_id == channel.id),
            'webhooks': await _count(ChannelWebhook, ChannelWebhook.channel_id == channel.id),
            'grants': await _count(AccessGrant, AccessGrant.resource_id == channel.id),
            'pins': await _count(PinnedNote, PinnedNote.note_id == note.id),
            'note chats': await _count(Chat, Chat.id.in_([ben_chat.id, child.id])),
        }

    assert _run(go()) == dict.fromkeys(
        ('messages', 'reactions', 'members', 'webhooks', 'grants', 'pins', 'note chats'), 0
    )


def test_deleting_a_note_stops_the_replies_running_in_its_chats(monkeypatch):
    """The chat delete route stops a chat's tasks first; the note delete did not (#713)."""
    from types import SimpleNamespace

    from local_llm.routers import notes as notes_router

    tag = uuid.uuid4().hex[:8]
    stopped = []

    async def allowed(*_a, **_k):
        return True

    async def nothing(*_a, **_k):
        return None

    async def config_get(key, default=None):
        return default

    async def stop(redis, item_id):
        # Stopped while the chat is still there, as the chat delete route does.
        stopped.append((item_id, await Chats.get_chat_by_id(item_id) is not None))
        return {'status': True}

    monkeypatch.setattr(notes_router, 'has_permission', allowed)
    monkeypatch.setattr(notes_router.Config, 'get', config_get)
    monkeypatch.setattr(notes_router, 'publish_event', nothing)
    monkeypatch.setattr(notes_router, 'close_room', nothing)
    monkeypatch.setattr(notes_router, 'stop_item_tasks', stop, raising=False)

    async def go():
        ann = await Users.insert_new_user(f'ann{tag}', 'Ann', f'ann{tag}@example.invalid', role='user')
        ben = await Users.insert_new_user(f'ben{tag}', 'Ben', f'ben{tag}@example.invalid', role='user')
        note = await Notes.insert_new_note(ann.id, NoteForm(title='Plan'))
        chats = []
        for user_id in (ann.id, ben.id):
            chats.append(
                await Chats.insert_new_chat(
                    str(uuid.uuid4()),
                    user_id,
                    ChatForm(chat={'title': 'note chat'}),
                    internal_meta={'internal': True, 'type': 'note', 'note_id': note.id},
                )
            )
        child = await Chats.insert_new_chat(
            str(uuid.uuid4()),
            ben.id,
            ChatForm(chat={'title': 'subagent'}),
            internal_meta={'internal': True, 'parent_chat_id': chats[1].id},
        )
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(redis=None)))
        user = SimpleNamespace(id=ann.id, role='user')
        assert await notes_router.delete_note_by_id(request, note.id, user=user, db=None) is True
        return {(c.id, True) for c in (*chats, child)}

    expected = _run(go())
    assert set(stopped) == expected and len(stopped) == len(expected)


def test_a_note_chat_that_cannot_be_deleted_is_logged(monkeypatch, caplog):
    """Its child chats' failed deletes were dropped silently; the chat's own was logged."""
    import logging

    from local_llm.models import chats as chats_model

    tag = uuid.uuid4().hex[:8]

    async def refused(*_a, **_k):
        return False

    async def go():
        ann = await Users.insert_new_user(f'ann{tag}', 'Ann', f'ann{tag}@example.invalid', role='user')
        note = await Notes.insert_new_note(ann.id, NoteForm(title='Plan'))
        chat = await Chats.insert_new_chat(
            str(uuid.uuid4()),
            ann.id,
            ChatForm(chat={'title': 'note chat'}),
            internal_meta={'internal': True, 'type': 'note', 'note_id': note.id},
        )
        child = await Chats.insert_new_chat(
            str(uuid.uuid4()),
            ann.id,
            ChatForm(chat={'title': 'subagent'}),
            internal_meta={'internal': True, 'parent_chat_id': chat.id},
        )
        monkeypatch.setattr(Chats, 'delete_chat_by_id', refused)
        await Chats.delete_internal_chats_by_note_id(note.id)
        return chat.id, child.id

    with caplog.at_level(logging.WARNING, logger=chats_model.__name__):
        chat_id, child_id = _run(go())

    messages = [r.getMessage() for r in caplog.records]
    assert any(chat_id in m for m in messages)
    assert any(child_id in m for m in messages)


def test_purging_a_user_with_a_successor_keeps_what_was_reassigned(monkeypatch):
    """A shared note and a channel go to the successor with their chats, messages and members."""
    from local_llm.models.access_grants import AccessGrants
    from local_llm.utils import user_purge

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(user_purge, '_remove_stored_data', nothing)
    tag = uuid.uuid4().hex[:8]

    async def go():
        gone = await Users.insert_new_user(f'gone{tag}', 'Gone', f'gone{tag}@example.invalid', role='user')
        ben = await Users.insert_new_user(f'ben{tag}', 'Ben', f'ben{tag}@example.invalid', role='user')
        admin = await Users.insert_new_user(f'adm{tag}', 'Adm', f'adm{tag}@example.invalid', role='admin')

        async def successor(*_a, **_k):
            return admin.id

        # Other tests leave admins in the shared database: name the one that inherits.
        monkeypatch.setattr(user_purge, '_successor_id', successor)

        channel = await Channels.insert_new_channel(CreateChannelForm(type='group', name=f'c-{tag}'), gone.id)
        await Channels.join_channel(channel.id, ben.id)
        await Messages.insert_new_message(MessageForm(content='hi'), channel.id, ben.id)

        note = await Notes.insert_new_note(gone.id, NoteForm(title='Plan'))
        await AccessGrants.grant_access('note', note.id, 'user', ben.id, 'read')
        ben_chat = await Chats.insert_new_chat(
            str(uuid.uuid4()),
            ben.id,
            ChatForm(chat={'title': 'note chat'}),
            internal_meta={'internal': True, 'type': 'note', 'note_id': note.id},
        )

        assert await Users.delete_user_by_id(gone.id)

        return (
            (await Channels.get_channel_by_id(channel.id)).user_id,
            await _count(Message, Message.channel_id == channel.id),
            await _count(ChannelMember, ChannelMember.channel_id == channel.id, ChannelMember.user_id == ben.id),
            (await Notes.get_note_by_id(note.id)).user_id,
            await Chats.get_chat_by_id(ben_chat.id) is not None,
            admin.id,
        )

    channel_owner, messages, members, note_owner, chat_kept, admin_id = _run(go())
    assert (channel_owner, messages, members, note_owner, chat_kept) == (admin_id, 1, 1, admin_id, True)
