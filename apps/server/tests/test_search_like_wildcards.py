"""`%` and `_` in the app's other searches are text, not LIKE wildcards (#625).

#292 escaped chat search. The other searches (users, shared chats, channel
messages, calendar events, groups, automations, prompts and their tag filter,
notes, knowledge bases and their files, workspace models) still bound the
user's text raw into LIKE / ILIKE, so searching for `%` matched every row and
`_` any one character. They now go through `local_llm.utils.sql_like`, with an
explicit ESCAPE character, on SQLite (which has no default) and Postgres alike.

Each search gets rows of its own, under a fresh tag: one whose text holds a
literal `%`, one a literal `_`, and a plain one (per searched field, where a
search covers more than one). Searching for `%`, `_` and a plain word must each
find only its own rows. The automation search matched the prompt against the
whole serialised data, whose own key "model_id" holds a `_`; it now matches the
prompt's value. One scenario builds and searches
everything; it runs against the test run's migrated SQLite database and, with
TEST_DATABASE_URL (CI and `make test-backend` provide one), in a subprocess
against a fresh Postgres.

Run from apps/server:

    python -m pytest tests/test_search_like_wildcards.py
"""

import asyncio
import importlib
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

from test_schema_drift import fresh_database

from local_llm.models.automations import AutomationData, AutomationForm, Automations
from local_llm.models.calendar import CalendarEventForm, CalendarEvents, CalendarForm, Calendars
from local_llm.models.channels import Channels, CreateChannelForm
from local_llm.models.chats import ChatForm, Chats
from local_llm.models.files import FileForm, Files
from local_llm.models.groups import GroupForm, Groups
from local_llm.models.knowledge import KnowledgeForm, Knowledges
from local_llm.models.messages import MessageForm, Messages
from local_llm.models.models import ModelForm, ModelMeta, ModelParams, Models
from local_llm.models.notes import NoteForm, Notes
from local_llm.models.prompts import PromptForm, Prompts
from local_llm.models.shared_chats import SharedChats
from local_llm.models.users import Users

# Importing the config runs the migrations on the test run's database.
importlib.import_module('local_llm.config')

__all__ = ['fresh_database']

TEXTS = {
    'percent': 'Budget 50% off',
    'underscore': 'snake_case',
    'plain': 'Weekly plan',
}
QUERIES = ('%', '_', 'plan')
EACH_OWN = {'%': ['percent'], '_': ['underscore'], 'plan': ['plain']}


class Run:
    """One scenario's owner and tag. Hex holds none of `%`, `_`, `p`, `l` or `n`, so the tag
    matches no query; the owner's name and email are searched too (prompts, knowledge bases,
    models), so they stay neutral."""

    def __init__(self, owner, tag):
        self.owner = owner
        self.tag = tag
        self.mine = {'user_id': owner.id, 'view_option': 'created'}

    def text(self, key):
        return f'{TEXTS[key]} {self.tag}'


async def found(ids, search, queries=QUERIES):
    """{query: sorted keys} for `search(query)`'s ids, keeping only this scenario's rows."""
    return {query: sorted({ids[row_id] for row_id in await search(query) if row_id in ids}) for query in queries}


async def users(run):
    """The user search: the name (the email stays neutral)."""
    ids = {}
    for key in TEXTS:
        user = await Users.insert_new_user(
            f'{key}-{run.tag}', run.text(key), f'{key}-{run.tag}@example.invalid', role='user'
        )
        ids[user.id] = key

    async def search(query):
        return [user.id for user in (await Users.get_users(filter={'query': query}))['users']]

    return {'users': await found(ids, search)}


async def shared_chats(run):
    """The shared chats list: the snapshot's title."""
    ids = {}
    for key in TEXTS:
        chat = await Chats.insert_new_chat(f'{key}-{run.tag}', run.owner.id, ChatForm(chat={'title': run.text(key)}))
        await SharedChats.create(chat.id, run.owner.id)
        ids[chat.id] = key

    async def search(query):
        return [chat.chat_id for chat in await SharedChats.get_by_user_id(run.owner.id, filter={'query': query})]

    return {'shared chats': await found(ids, search)}


async def channel_messages(run):
    """The channel message search: the content."""
    channel = await Channels.insert_new_channel(CreateChannelForm(name=f'c{run.tag}'), run.owner.id)
    ids = {}
    for key in TEXTS:
        message = await Messages.insert_new_message(MessageForm(content=run.text(key)), channel.id, run.owner.id)
        ids[message.id] = key

    async def search(query):
        return [message.id for message in await Messages.search_messages_by_channel_ids([channel.id], query)]

    return {'channel messages': await found(ids, search)}


async def calendar_events(run):
    """The calendar event search: the title (description and location stay empty)."""
    calendar = await Calendars.insert_new_calendar(run.owner.id, CalendarForm(name=f'Cal {run.tag}'))
    ids = {}
    for key in TEXTS:
        form = CalendarEventForm(calendar_id=calendar.id, title=run.text(key), start_at=time.time_ns())
        event = await CalendarEvents.insert_new_event(run.owner.id, form)
        ids[event.id] = key

    async def search(query):
        return [event.id for event in (await CalendarEvents.search_events(run.owner.id, query, limit=1000)).items]

    return {'calendar events': await found(ids, search)}


async def groups(run):
    """The group name, in both group listings."""
    ids = {}
    for key in TEXTS:
        group = await Groups.insert_new_group(run.owner.id, GroupForm(name=run.text(key), description='d'))
        ids[group.id] = key

    async def listed(query):
        return [group.id for group in await Groups.get_groups(filter={'query': query})]

    async def searched(query):
        return [group.id for group in (await Groups.search_groups(filter={'query': query}, limit=1000))['items']]

    return {'groups': await found(ids, listed), 'group search': await found(ids, searched)}


async def automations(run):
    """The automation search: the name, and the prompt inside the JSON data."""
    ids = {}
    for key in TEXTS:
        for where in ('name', 'prompt'):
            name, prompt = (run.text(key), 'Ask') if where == 'name' else (f'Job {run.tag}', run.text(key))
            form = AutomationForm(name=name, data=AutomationData(prompt=prompt, model_id='m', rrule='FREQ=DAILY'))
            automation = await Automations.insert(run.owner.id, form, next_run_at=time.time_ns())
            ids[automation.id] = key if where == 'name' else f'{key} in prompt'

    async def search(query):
        return [automation.id for automation in (await Automations.search_automations(run.owner.id, query)).items]

    return {'automations': await found(ids, search)}


async def prompts(run):
    """The prompt search: the name (command and content stay neutral); and the tag filter,
    which matches a whole tag, so the tags are the query texts themselves."""
    ids = {}
    tags = {'percent': '%', 'underscore': '_', 'plain': 'plan'}
    for key in TEXTS:
        form = PromptForm(command=f'/{key}{run.tag}', name=run.text(key), content='Body', tags=[tags[key]])
        prompt = await Prompts.insert_new_prompt(run.owner.id, form)
        ids[prompt.id] = key

    async def by_text(query):
        result = await Prompts.search_prompts(run.owner.id, filter={**run.mine, 'query': query})
        return [prompt.id for prompt in result.items]

    async def by_tag(query):
        result = await Prompts.search_prompts(run.owner.id, filter={**run.mine, 'tag': query})
        return [prompt.id for prompt in result.items]

    return {'prompts': await found(ids, by_text), 'prompt tags': await found(ids, by_tag)}


async def notes(run):
    """The note search: the title, and the Markdown content."""
    ids = {}
    for key in TEXTS:
        note = await Notes.insert_new_note(run.owner.id, NoteForm(title=run.text(key)))
        ids[note.id] = key
        form = NoteForm(title=f'Note {run.tag}', data={'content': {'md': run.text(key)}})
        note = await Notes.insert_new_note(run.owner.id, form)
        ids[note.id] = f'{key} in content'

    async def search(query):
        return [note.id for note in (await Notes.search_notes(run.owner.id, filter={**run.mine, 'query': query})).items]

    return {'notes': await found(ids, search)}


async def knowledge_bases(run):
    """The knowledge base search: the name (the description stays neutral)."""
    ids = {}
    for key in TEXTS:
        form = KnowledgeForm(name=run.text(key), description='d')
        knowledge = await Knowledges.insert_new_knowledge(run.owner.id, form)
        ids[knowledge.id] = key

    async def search(query):
        result = await Knowledges.search_knowledge_bases(run.owner.id, filter={**run.mine, 'query': query})
        return [knowledge.id for knowledge in result.items]

    return {'knowledge bases': await found(ids, search)}


async def knowledge_files(run):
    """Both knowledge file searches: the filename, and with include_content the content too."""
    form = KnowledgeForm(name=f'Files {run.tag}', description='d')
    knowledge = await Knowledges.insert_new_knowledge(run.owner.id, form)
    ids = {}
    for key in TEXTS:
        for where in ('filename', 'content'):
            filename, content = (
                (f'{run.text(key)}.txt', 'Text') if where == 'filename' else (f'doc {run.tag}.txt', run.text(key))
            )
            file_id = str(uuid.uuid4())
            form = FileForm(id=file_id, filename=filename, path=f'/nowhere/{file_id}', data={'content': content})
            await Files.insert_new_file(run.owner.id, form)
            await Knowledges.add_file_to_knowledge_by_id(knowledge.id, file_id, run.owner.id)
            ids[file_id] = key if where == 'filename' else f'{key} in content'

    results = {}
    for include_content in (False, True):
        suffix = ' with content' if include_content else ''

        async def across_bases(query, include_content=include_content):
            search = {'user_id': run.owner.id, 'query': query, 'include_content': include_content}
            return [file.id for file in (await Knowledges.search_knowledge_files(search, limit=1000)).items]

        async def in_base(query, include_content=include_content):
            search = {'query': query, 'include_content': include_content}
            result = await Knowledges.search_files_by_id(knowledge.id, run.owner.id, search, limit=1000)
            return [file.id for file in result.items]

        results[f'knowledge files{suffix}'] = await found(ids, across_bases)
        results[f'files of a knowledge base{suffix}'] = await found(ids, in_base)
    return results


async def models(run):
    """The workspace model search: the name (the base model id is searched too, so it stays neutral)."""
    ids = {}
    for key in TEXTS:
        form = ModelForm(
            id=f'{key}-{run.tag}', base_model_id='basemodel', name=run.text(key), meta=ModelMeta(), params=ModelParams()
        )
        model = await Models.insert_new_model(form, run.owner.id)
        ids[model.id] = key

    async def search(query):
        result = await Models.search_models(run.owner.id, filter={**run.mine, 'query': query})
        return [model.id for model in result.items]

    return {'models': await found(ids, search)}


SEARCHES = (
    users,
    shared_chats,
    channel_messages,
    calendar_events,
    groups,
    automations,
    prompts,
    notes,
    knowledge_bases,
    knowledge_files,
    models,
)


async def scenario() -> dict:
    """Build every search's rows under a fresh tag; return {search: {query: sorted keys found}}."""
    tag = uuid.uuid4().hex[:8]
    owner = await Users.insert_new_user(f'own-{tag}', f'Owner {tag}', f'own-{tag}@example.invalid', role='user')
    run = Run(owner, tag)
    results = {}
    for search in SEARCHES:
        results.update(await search(run))
    return results


IN_CONTENT = {'%': ['percent in content'], '_': ['underscore in content'], 'plan': ['plain in content']}

EXPECTED = {
    'users': EACH_OWN,
    'shared chats': EACH_OWN,
    'channel messages': EACH_OWN,
    'calendar events': EACH_OWN,
    'groups': EACH_OWN,
    'group search': EACH_OWN,
    'automations': {
        '%': ['percent', 'percent in prompt'],
        '_': ['underscore', 'underscore in prompt'],
        'plan': ['plain', 'plain in prompt'],
    },
    'prompts': EACH_OWN,
    'prompt tags': EACH_OWN,
    'notes': {query: sorted(EACH_OWN[query] + IN_CONTENT[query]) for query in QUERIES},
    'knowledge bases': EACH_OWN,
    'knowledge files': EACH_OWN,
    'knowledge files with content': {query: sorted(EACH_OWN[query] + IN_CONTENT[query]) for query in QUERIES},
    'files of a knowledge base': EACH_OWN,
    'files of a knowledge base with content': {query: sorted(EACH_OWN[query] + IN_CONTENT[query]) for query in QUERIES},
    'models': EACH_OWN,
}


def test_searches_treat_wildcards_as_text():
    assert asyncio.run(scenario()) == EXPECTED


SEARCH_ON_POSTGRES = r"""
import asyncio, json, sys
sys.path.insert(0, 'tests')
import local_llm.config  # runs the migrations on DATABASE_URL
from test_search_like_wildcards import scenario

print('FOUND ' + json.dumps(asyncio.run(scenario())))
"""


def test_searches_treat_wildcards_as_text_on_postgres(fresh_database, tmp_path):
    env = {**os.environ, 'DATABASE_URL': fresh_database, 'DATA_DIR': str(tmp_path), 'HF_HUB_OFFLINE': '1'}
    result = subprocess.run(
        [sys.executable, '-c', SEARCH_ON_POSTGRES],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert result.returncode == 0, result.stderr[-4000:]
    line = next(line for line in result.stdout.splitlines() if line.startswith('FOUND '))

    # The knowledge searches print an error and return nothing, so show what was printed.
    assert json.loads(line.removeprefix('FOUND ')) == EXPECTED, result.stdout[-4000:]
