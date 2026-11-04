"""Thread replies carry their author, so view_channel_thread names who said what (#185).

`get_thread_replies_by_message_id` filled a reply's `user` only for a webhook
message, so the `view_channel_thread` tool gave `user_name: null` for every
reply a person posted, and the model could not tell who said what. A reply's
author is now its real user (batch-loaded), as `get_message_by_id` already did
for a single message; a genuine webhook reply still shows the webhook.

Runs against the test run's migrated SQLite database.

Run from apps/server:

    python -m pytest tests/test_thread_reply_user_names.py
"""

import asyncio
import importlib
import json
import uuid
from types import SimpleNamespace

from local_llm.models.channels import Channels, ChannelWebhookForm, CreateChannelForm
from local_llm.models.messages import MessageForm, Messages
from local_llm.models.users import Users
from local_llm.tools import builtin

# Importing the config runs the migrations on the test run's database.
importlib.import_module('local_llm.config')


def _thread():
    tag = uuid.uuid4().hex[:8]

    async def build():
        ann = await Users.insert_new_user(f'ann-{tag}', 'Ann', f'ann-{tag}@example.invalid', role='admin')
        ben = await Users.insert_new_user(f'ben-{tag}', 'Ben', f'ben-{tag}@example.invalid', role='user')
        channel = await Channels.insert_new_channel(CreateChannelForm(name=f'general-{tag}', user_ids=[ben.id]), ann.id)
        hook = await Channels.insert_webhook(channel.id, ann.id, ChannelWebhookForm(name='Deploy bot'))
        parent = await Messages.insert_new_message(MessageForm(content='Plan?'), channel.id, ann.id)
        await Messages.insert_new_message(MessageForm(content='Yes', parent_id=parent.id), channel.id, ben.id)
        await Messages.insert_new_message(MessageForm(content='Me too', parent_id=parent.id), channel.id, ann.id)
        await Messages.insert_new_message(
            MessageForm(content='Deployed', parent_id=parent.id, meta={'webhook': {'id': hook.id}}),
            channel.id,
            ann.id,
        )
        return SimpleNamespace(ann=ann, ben=ben, channel=channel, parent=parent)

    return asyncio.run(build())


def test_thread_replies_carry_their_authors():
    t = _thread()

    replies = asyncio.run(Messages.get_thread_replies_by_message_id(t.parent.id))

    assert sorted((r.content, r.user.name if r.user else None) for r in replies) == [
        ('Deployed', 'Deploy bot'),
        ('Me too', 'Ann'),
        ('Yes', 'Ben'),
    ]


def test_view_channel_thread_names_who_said_what():
    t = _thread()

    result = json.loads(
        asyncio.run(builtin.view_channel_thread(t.parent.id, __request__=SimpleNamespace(), __user__={'id': t.ann.id}))
    )

    assert [(m['content'], m['user_name']) for m in result['messages']] == [
        ('Plan?', 'Ann'),
        ('Yes', 'Ben'),
        ('Me too', 'Ann'),
        ('Deployed', 'Deploy bot'),
    ]
