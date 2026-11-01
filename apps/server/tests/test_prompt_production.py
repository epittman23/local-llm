"""Saving a prompt version that is not marked production leaves the live prompt alone.

A prompt row holds what slash commands serve; its history holds every saved
version, and `version_id` names the live one. The editor's "Set as
Production" switch sends `is_production`. Prompts.update_prompt_by_id once
wrote the new content into the row whatever that flag said, and only
`version_id` respected it, so a staged draft went live while the history
still marked the old version Live (#221). Name, command and tags are the
prompt's identity, not versioned content: they apply at once, as the
editor's metadata autosave does.

Runs against the suite's own temporary SQLite database (tests/conftest.py
points DATA_DIR at a temp directory, and DATABASE_URL defaults to a file in
it), so nothing touches a real database.

Run from apps/server:

    python -m pytest tests/test_prompt_production.py
"""

import asyncio
import uuid

from local_llm.internal.db import Base, async_engine
from local_llm.models.prompt_history import PromptHistories
from local_llm.models.prompts import PromptForm, Prompts


def _run(coro):
    async def with_tables():
        async with async_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        return await coro

    return asyncio.run(with_tables())


async def _prompt(command: str):
    return await Prompts.insert_new_prompt(
        'u1', PromptForm(command=command, name='Sum', content='V1 content', access_grants=[], tags=['a'])
    )


def test_a_draft_saved_without_production_is_not_served():
    async def scenario():
        command = f'sum{uuid.uuid4().hex[:8]}'
        p = await _prompt(command)
        draft = PromptForm(
            command=command, name='Sum v2', content='V2 draft', access_grants=[], tags=['b'], is_production=False
        )
        updated = await Prompts.update_prompt_by_id(p.id, draft, 'u1')
        live = await Prompts.get_prompt_by_command(command)
        history = await PromptHistories.get_history_by_prompt_id(p.id)
        return p, updated, live, history

    p, updated, live, history = _run(scenario())

    assert updated is not None
    assert updated.version_id == p.version_id
    assert live.content == 'V1 content'
    assert (live.name, live.tags) == ('Sum v2', ['b'])
    # The draft is kept as a version, ready to be made production.
    assert any(h.snapshot.get('content') == 'V2 draft' for h in history)


def test_making_the_draft_production_puts_it_live():
    async def scenario():
        command = f'sum{uuid.uuid4().hex[:8]}'
        p = await _prompt(command)
        draft = PromptForm(command=command, name='Sum v2', content='V2 draft', access_grants=[], is_production=False)
        await Prompts.update_prompt_by_id(p.id, draft, 'u1')
        history = await PromptHistories.get_history_by_prompt_id(p.id)
        draft_entry = next(h for h in history if h.snapshot.get('content') == 'V2 draft')
        await Prompts.update_prompt_version(p.id, draft_entry.id)
        return draft_entry, await Prompts.get_prompt_by_command(command)

    draft_entry, live = _run(scenario())

    assert (live.content, live.version_id) == ('V2 draft', draft_entry.id)


def test_a_production_save_still_goes_live():
    async def scenario():
        command = f'sum{uuid.uuid4().hex[:8]}'
        p = await _prompt(command)
        form = PromptForm(command=command, name='Sum v2', content='V2 live', access_grants=[], tags=['b'])
        updated = await Prompts.update_prompt_by_id(p.id, form, 'u1')
        return p, updated, await Prompts.get_prompt_by_command(command)

    p, updated, live = _run(scenario())

    assert (live.content, live.tags) == ('V2 live', ['b'])
    assert updated.version_id != p.version_id
