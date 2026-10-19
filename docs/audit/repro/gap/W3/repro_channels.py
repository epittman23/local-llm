"""W3 repros against a throwaway SQLite database (tables from the ORM metadata).

A. send_notification never notifies DM / group channel members.
B. model_response_handler in 'channel' (inline) mode gives the model no context,
   not even the model message being replied to; thread mode repeats the trigger.
C. pinning a webhook message broadcasts the webhook owner as its author.
"""

import asyncio
import importlib
import pkgutil
from types import SimpleNamespace

import local_llm.models as M
from local_llm.internal.db import Base, engine

for m in pkgutil.iter_modules(M.__path__):
    importlib.import_module('local_llm.models.' + m.name)
Base.metadata.create_all(engine)

import local_llm.routers.channels as rc  # noqa: E402
import local_llm.utils.automations as automations  # noqa: E402
from local_llm.models.channels import ChannelWebhookForm, Channels, CreateChannelForm  # noqa: E402
from local_llm.models.config import Config  # noqa: E402
from local_llm.models.messages import MessageForm, Messages  # noqa: E402
from local_llm.models.users import Users  # noqa: E402

published = []
emitted = []
completions = []


async def fake_publish_event(request, event, **kw):
    published.append((event.name, kw.get('data', {}).get('user_id')))


async def fake_emit(event, data, **kw):
    emitted.append(data)


rc.publish_event = fake_publish_event
rc.sio.emit = fake_emit


async def fake_all_models(request, user=None):
    return [{'id': 'm1', 'name': 'M1'}]


async def fake_filtered(models, user):
    return models


async def fake_defaults(app, model_id):
    return [], {}, [], None


rc.get_all_models = fake_all_models
rc.get_filtered_models = fake_filtered
automations._resolve_model_defaults = fake_defaults


async def handler(request, form_data, user=None):
    completions.append(form_data)


request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(CHAT_COMPLETION_HANDLER=handler)))


async def main():
    a = await Users.insert_new_user('a', 'Ann', 'a@x.io', role='admin')
    b = await Users.insert_new_user('b', 'Bob', 'b@x.io', role='user')
    await Users.update_user_settings_by_id('b', {'notifications': {'targets': []}})
    b = await Users.get_user_by_id('b')
    await Config.upsert({'ui.enable_user_webhooks': True, 'webui.url': 'http://h'})

    # --- A ---------------------------------------------------------------
    payload = dict(name='', is_private=None, access_grants=[], group_ids=[], user_ids=['b'])  # channelPayload for a DM
    dm = await Channels.insert_new_channel(CreateChannelForm(type='dm', **payload), 'a')
    grp = await Channels.insert_new_channel(
        CreateChannelForm(type='group', **{**payload, 'name': 'team', 'is_private': True}), 'a'
    )
    std = await Channels.insert_new_channel(
        CreateChannelForm(
            type='',
            name='general',
            access_grants=[{'principal_type': 'user', 'principal_id': '*', 'permission': 'read'}],
        ),
        'a',
    )
    await Channels.join_channel(std.id, 'b')
    for ch in (dm, grp, std):
        msg = await Messages.insert_new_message(MessageForm(content='hi'), ch.id, 'a')
        published.clear()
        await rc.send_notification(request, ch, msg, active_user_ids=[])
        members = [m.user_id for m in await Channels.get_members_by_channel_id(ch.id)]
        print(f'A {ch.type or "standard":8} members={sorted(members)} channel.message events={published}')

    # --- B ---------------------------------------------------------------
    for mode in ('channel', 'thread'):
        await Config.upsert({'channels.model_response_mode': mode})
        q = await Messages.insert_new_message(MessageForm(content='What is 17*23? <@M:m1|M1>'), std.id, 'a')
        reply = await Messages.insert_new_message(
            MessageForm(
                content='17*23 = 391.',
                parent_id=q.id if mode == 'thread' else None,
                meta={'model_id': 'm1', 'model_name': 'M1'},
            ),
            std.id,
            'a',
        )
        follow = await Messages.insert_new_message(
            MessageForm(
                content='Now divide that by 17.',
                reply_to_id=reply.id,
                parent_id=q.id if mode == 'thread' else None,
            ),
            std.id,
            'a',
        )
        follow = await Messages.get_message_by_id(follow.id)
        completions.clear()
        await rc.model_response_handler(request, std, follow, a)
        msgs = completions[0]['messages']
        print(f'\nB mode={mode}: model triggered={bool(completions)}')
        print('  system:', repr(msgs[0]['content']))
        print('  user  :', repr(msgs[1]['content']))

    # --- C ---------------------------------------------------------------
    hook = await Channels.insert_webhook(std.id, 'a', ChannelWebhookForm(name='CI Bot'))
    wmsg = await Messages.insert_new_message(MessageForm(content='build ok', meta={'webhook': {'id': hook.id}}), std.id, 'a')
    listed = await rc.get_channel_messages(request, std.id, 0, 50, user=a, db=None) if False else None
    full = await Messages.get_message_by_id(wmsg.id)
    print('\nC author via get_message_by_id (list/update path):', full.user.model_dump() if full.user else None)
    emitted.clear()

    async def ok_access(*args, **kw):
        return None

    rc.check_channels_access = ok_access
    await rc.pin_channel_message(request, std.id, wmsg.id, rc.PinMessageForm(is_pinned=True), user=a, db=None)
    print('C author in pin message:update event       :', emitted[-1]['data']['data']['user'])
    pinned = await rc.get_pinned_channel_messages(request, std.id, 1, user=a, db=None)
    print('C author in pinned list                     :', pinned[0].user.model_dump())


asyncio.run(main())
