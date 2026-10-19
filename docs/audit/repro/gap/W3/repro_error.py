"""Model reply placeholder is left empty when chat_completion fails before starting its task."""
import asyncio, importlib, pkgutil
from types import SimpleNamespace
import local_llm.models as M
from local_llm.internal.db import Base, engine
for m in pkgutil.iter_modules(M.__path__):
    importlib.import_module('local_llm.models.' + m.name)
Base.metadata.create_all(engine)

from fastapi import HTTPException
import local_llm.routers.channels as rc
import local_llm.utils.automations as automations
from local_llm.models.channels import Channels, CreateChannelForm
from local_llm.models.messages import MessageForm, Messages
from local_llm.models.users import Users

async def noop(*a, **k): return None
rc.publish_event = noop
rc.sio.emit = noop
async def models(request, user=None): return [{'id': 'coding', 'name': 'Coding'}]
async def filtered(m, u): return m
async def defaults(app, mid): return [], {}, [], None
rc.get_all_models, rc.get_filtered_models, automations._resolve_model_defaults = models, filtered, defaults

async def chat_completion(request, form_data, user=None):
    # what main.chat_completion raises from its metadata block for a preset whose base model is gone
    raise HTTPException(status_code=400, detail='Model not found')

request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(CHAT_COMPLETION_HANDLER=chat_completion)))

async def main():
    a = await Users.insert_new_user('a', 'Ann', 'a@x.io', role='admin')
    ch = await Channels.insert_new_channel(CreateChannelForm(type='', name='general'), 'a')
    q = await Messages.insert_new_message(MessageForm(content='hi <@M:coding|Coding>'), ch.id, 'a')
    q = await Messages.get_message_by_id(q.id)
    await rc.model_response_handler(request, ch, q, a)
    replies = await Messages.get_messages_by_parent_id(ch.id, q.id)
    for r in replies:
        if r.id != q.id:
            print('placeholder content=%r meta=%r' % (r.content, r.meta))
asyncio.run(main())
