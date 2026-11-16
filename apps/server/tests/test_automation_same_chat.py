"""An automation can post every run into one chat (S6-D13).

A chat target with `same_chat` puts each run after the newest message of the
chat the previous run used, instead of creating a chat per run. The option is
a field of the target in the automation's `data` JSON, so it needs no column.
A chat since deleted or archived, or no earlier run, starts a new chat; the
model is sent this run's prompt only, as for a new chat.

Run from apps/server:

    python -m pytest tests/test_automation_same_chat.py
"""

from __future__ import annotations

import asyncio
import importlib
import uuid
from types import SimpleNamespace

from local_llm.models.automations import AutomationData, AutomationForm, AutomationRuns
from local_llm.utils import automations

# Importing the config runs the migrations on the test run's database.
importlib.import_module('local_llm.config')


def _run(monkeypatch, *, same_chat: bool, previous_chat=None, previous_chat_id='c-old'):
    """Drive execute_automation's chat path; returns what it inserted, upserted and sent."""
    seen: dict = {'inserted': [], 'upserted': [], 'looked_up': [], 'form': None}

    async def get_user(user_id):
        return SimpleNamespace(id='u1', role='admin', name='Eli')

    async def prompt_template(prompt, user):
        return prompt

    async def config_get(key, default=None):
        return default

    async def insert_chat(chat_id, user_id, form):
        seen['inserted'].append(form)
        return SimpleNamespace(id=chat_id, chat=form.chat)

    async def latest_chat_id(automation_id):
        return previous_chat_id

    async def get_chat(chat_id, user_id):
        seen['looked_up'].append((chat_id, user_id))
        return previous_chat

    async def upsert(chat_id, message_id, message):
        seen['upserted'].append((chat_id, message_id, message))
        return previous_chat

    async def model_defaults(app, model_id, user=None, token=None):
        return None, None, None, None

    async def nothing(*args, **kwargs):
        return None

    async def emit(name, payload, room=None):
        return None

    async def handler(request, form_data, user=None):
        seen['form'] = form_data
        return {'status': True, 'task_ids': []}

    async def finish(app, user, run, error=None):
        seen['run'] = run

    from local_llm.socket import main as socket_main

    monkeypatch.setattr(automations.Users, 'get_user_by_id', get_user)
    monkeypatch.setattr(automations, 'prompt_template', prompt_template)
    monkeypatch.setattr(automations.Config, 'get', config_get)
    monkeypatch.setattr(automations.Chats, 'insert_new_chat', insert_chat)
    monkeypatch.setattr(automations.Chats, 'get_chat_by_id_and_user_id', get_chat)
    monkeypatch.setattr(automations.Chats, 'upsert_message_to_chat_by_id_and_message_id', upsert)
    monkeypatch.setattr(automations.AutomationRuns, 'get_latest_chat_id', latest_chat_id)
    monkeypatch.setattr(automations, '_resolve_model_defaults', model_defaults)
    monkeypatch.setattr(automations, '_build_request', lambda app, token=None: None)
    monkeypatch.setattr(automations, '_announce_run', nothing)
    monkeypatch.setattr(automations, '_wait_for_reply', nothing)
    monkeypatch.setattr(automations, 'finish_automation_run', finish)
    monkeypatch.setattr(automations, '_record_run', nothing)
    monkeypatch.setattr(automations, 'publish_event', nothing)
    monkeypatch.setattr(socket_main.sio, 'emit', emit)

    app = SimpleNamespace(state=SimpleNamespace(CHAT_COMPLETION_HANDLER=handler))
    automation = SimpleNamespace(
        id='auto-1',
        name='Daily digest',
        user_id='u1',
        folder_id=None,
        data={'prompt': 'Summarise today', 'model_id': 'm', 'target': {'type': 'chat', 'same_chat': same_chat}},
    )
    asyncio.run(automations.execute_automation(app, automation))
    return seen


def _chat(current='a-prev', archived=False):
    return SimpleNamespace(
        id='c-old',
        archived=archived,
        chat={'history': {'currentId': current, 'messages': {current: {'id': current, 'role': 'assistant'}}}},
    )


def test_a_same_chat_run_goes_after_the_newest_message_of_the_last_runs_chat(monkeypatch):
    seen = _run(monkeypatch, same_chat=True, previous_chat=_chat())

    assert seen['inserted'] == []
    assert seen['looked_up'] == [('c-old', 'u1')]
    (chat_1, user_id, user_msg), (chat_2, assistant_id, assistant_msg) = seen['upserted']
    assert chat_1 == chat_2 == 'c-old'
    assert user_msg['parentId'] == 'a-prev'
    assert user_msg['childrenIds'] == [assistant_id]
    assert assistant_msg['parentId'] == user_id
    form = seen['form']
    assert form['chat_id'] == 'c-old'
    assert form['parent_id'] == 'a-prev'
    assert form['user_message']['parentId'] == 'a-prev'
    # Only this run's prompt is sent, as for a new chat.
    assert form['messages'] == [{'role': 'user', 'content': 'Summarise today'}]
    assert seen['run'] == {'automation_id': 'auto-1', 'chat_id': 'c-old', 'message_id': assistant_id}


def test_a_same_chat_run_whose_chat_is_gone_starts_a_new_chat(monkeypatch):
    seen = _run(monkeypatch, same_chat=True, previous_chat=None)

    assert len(seen['inserted']) == 1
    assert seen['upserted'] == []
    assert seen['form']['parent_id'] is None
    assert seen['form']['chat_id'] != 'c-old'


def test_a_same_chat_run_whose_chat_was_archived_starts_a_new_chat(monkeypatch):
    seen = _run(monkeypatch, same_chat=True, previous_chat=_chat(archived=True))

    assert len(seen['inserted']) == 1
    assert seen['upserted'] == []


def test_the_first_same_chat_run_starts_a_new_chat(monkeypatch):
    seen = _run(monkeypatch, same_chat=True, previous_chat=_chat(), previous_chat_id=None)

    assert len(seen['inserted']) == 1
    assert seen['looked_up'] == []


def test_a_chat_target_still_starts_a_new_chat_per_run_by_default(monkeypatch):
    seen = _run(monkeypatch, same_chat=False, previous_chat=_chat())

    assert len(seen['inserted']) == 1
    assert seen['looked_up'] == []
    assert seen['upserted'] == []
    assert seen['form']['parent_id'] is None


def test_the_option_is_kept_in_the_saved_data_and_defaults_off():
    on = AutomationForm(
        name='Daily digest',
        data=AutomationData(
            prompt='p', model_id='m', rrule='RRULE:FREQ=DAILY', target={'type': 'chat', 'same_chat': True}
        ),
    )
    off = AutomationData(prompt='p', model_id='m', rrule='RRULE:FREQ=DAILY', target={'type': 'chat'})

    assert on.data.model_dump()['target'] == {'type': 'chat', 'channel_id': None, 'same_chat': True}
    assert off.model_dump()['target']['same_chat'] is False


def test_the_chat_to_reuse_is_the_newest_run_that_made_one():
    automation_id = f'auto-{uuid.uuid4()}'

    async def scenario():
        before = await AutomationRuns.get_latest_chat_id(automation_id)
        await AutomationRuns.insert(automation_id, 'success', chat_id='chat-older')
        await AutomationRuns.insert(automation_id, 'success', chat_id='chat-newer')
        await AutomationRuns.insert(automation_id, 'error', error='Owner no longer permitted to run automations')
        await AutomationRuns.insert(automation_id, 'success', chat_id='channel:ch-1')
        return before, await AutomationRuns.get_latest_chat_id(automation_id)

    assert asyncio.run(scenario()) == (None, 'chat-newer')
