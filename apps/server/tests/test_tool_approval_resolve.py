"""A tool call is resolved once: a second approve, reject or answer is a 409 (#174).

`resolve_tool_call_output` refused only a call that already had an output or
had left the pending statuses, but approving leaves a call `queued` (with
`approved: True`) until the resumed reply runs it. A second resolve before
that, from another tab or an approve followed by a reject, went through, and
each resolve resumes the reply, which runs every approved call without an
output: the tool ran twice, or got both a rejection and a real output. Two
resolves at the same moment could also both pass the check before either
saved.

A fake chat store stands in for the database; it yields to the event loop on
every read and write, so concurrent resolves interleave as requests would.

Run from apps/server:

    python -m pytest tests/test_tool_approval_resolve.py
"""

import asyncio
import copy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.utils import tool_approval
from local_llm.utils.tool_approval import ResolveToolCallForm, resolve_tool_call_output

USER = SimpleNamespace(id='u1', role='user')


class FakeChats:
    def __init__(self, output):
        self.message = {'role': 'assistant', 'output': output}
        self.writes = []

    async def get_chat_by_id(self, chat_id, db=None):
        await asyncio.sleep(0)
        return SimpleNamespace(id=chat_id, user_id='u1', chat={})

    async def get_message_by_id_and_message_id(self, chat_id, message_id):
        await asyncio.sleep(0)
        return copy.deepcopy(self.message)

    async def upsert_message_to_chat_by_id_and_message_id(self, chat_id, message_id, message, touch=True):
        await asyncio.sleep(0)
        self.message = {**self.message, **copy.deepcopy(message)}
        self.writes.append(message)


def _call(status='pending', **extra):
    return {'type': 'function_call', 'call_id': 'c1', 'name': 'run_sql', 'arguments': '{}', 'status': status, **extra}


@pytest.fixture
def chats(monkeypatch):
    def install(output):
        fake = FakeChats(output)
        monkeypatch.setattr(tool_approval, 'Chats', fake)

        async def no_emitter(*args, **kwargs):
            return None

        monkeypatch.setattr(tool_approval, 'get_event_emitter', no_emitter)
        return fake

    return install


def _resolve(action, **form):
    return resolve_tool_call_output('chat1', 'm1', ResolveToolCallForm(call_id='c1', action=action, **form), USER)


@pytest.mark.parametrize('second', ['approve', 'reject'])
def test_an_approved_call_cannot_be_resolved_again(chats, second):
    fake = chats([_call()])

    async def run():
        await _resolve('approve')
        with pytest.raises(HTTPException) as refused:
            await _resolve(second)
        return refused.value

    refused = asyncio.run(run())

    assert refused.status_code == 409
    assert len(fake.writes) == 1
    (call,) = fake.message['output']
    assert (call['status'], call['approved']) == ('queued', True)


def test_two_resolves_at_once_resolve_the_call_once(chats):
    fake = chats([_call()])

    async def run():
        return await asyncio.gather(_resolve('approve'), _resolve('reject'), return_exceptions=True)

    results = asyncio.run(run())

    refused = [r for r in results if isinstance(r, HTTPException)]
    assert len(refused) == 1 and refused[0].status_code == 409
    assert len(fake.writes) == 1
    # The per-message lock goes once nobody holds or awaits it.
    assert tool_approval._resolving == {}


def test_a_call_waiting_its_turn_can_still_be_approved(chats):
    """`queued` without `approved` is a call waiting behind another for approval, not a resolved one."""
    fake = chats([_call('pending'), {**_call('queued'), 'call_id': 'c2'}])

    async def run():
        return await resolve_tool_call_output('chat1', 'm1', ResolveToolCallForm(call_id='c2', action='approve'), USER)

    asyncio.run(run())

    assert fake.message['output'][1]['approved'] is True


def test_a_rejected_call_cannot_be_approved(chats):
    chats([_call()])

    async def run():
        await _resolve('reject')
        with pytest.raises(HTTPException) as refused:
            await _resolve('approve')
        return refused.value

    assert asyncio.run(run()).status_code == 409
