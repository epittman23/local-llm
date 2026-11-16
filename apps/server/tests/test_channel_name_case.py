"""A new channel keeps its name as typed (S6-D2, #1109).

The server lower-cased a new channel's name in `insert_new_channel`, while a
rename kept the case, so "Team Notes" was stored as "team notes" and only
renaming it brought the capitals back. Nothing looks a channel up by name,
so the name is now stored as typed on create too. (The 60-character limit is
the client's; the server does not enforce it.)

Runs against the suite's temporary SQLite database.

Run from apps/server:

    python -m pytest tests/test_channel_name_case.py
"""

import asyncio
import importlib
import pkgutil
import uuid

import local_llm.models as models_pkg
from local_llm.internal.db import Base, async_engine
from local_llm.models.channels import ChannelForm, Channels, CreateChannelForm
from local_llm.models.users import Users

for module in pkgutil.iter_modules(models_pkg.__path__):
    importlib.import_module(f'local_llm.models.{module.name}')


def _run(scenario):
    async def go():
        async with async_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        return await scenario()

    return asyncio.run(go())


def test_create_and_rename_keep_the_name_as_typed():
    async def scenario():
        tag = uuid.uuid4().hex[:8]
        owner = await Users.insert_new_user(f'o{tag}', 'Owner', f'o{tag}@example.invalid', role='user')
        created = await Channels.insert_new_channel(CreateChannelForm(type='group', name='Team Notes'), owner.id)
        stored = await Channels.get_channel_by_id(created.id)
        renamed = await Channels.update_channel_by_id(created.id, ChannelForm(name='Release Plans Q4'))
        return created.name, stored.name, renamed.name

    assert _run(scenario) == ('Team Notes', 'Team Notes', 'Release Plans Q4')
