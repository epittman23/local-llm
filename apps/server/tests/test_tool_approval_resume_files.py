"""A resumed reply reads the documents its own turn was sent with (#160).

The chat's documents are read from the branch being answered, on every turn.
The chat's stored `files` list is only the last turn's, perhaps on another
branch. A turn paused for a tool approval records the documents it was sent
with on the reply's `meta`, but a turn that had none recorded `[]`, which the
resume read as missing and replaced with the chat's stored list: the resumed
reply read another branch's documents.

Run from apps/server:

    python -m pytest tests/test_tool_approval_resume_files.py
"""

import asyncio
from types import SimpleNamespace

import pytest

from local_llm.utils import tool_approval
from local_llm.utils.tool_approval import build_tool_approval_resume_payload

OTHER_BRANCH = {'type': 'file', 'id': 'd-other'}
THIS_BRANCH = {'type': 'file', 'id': 'd-this'}


class FakeChats:
    def __init__(self, meta):
        self.messages = {
            'q': {'id': 'q', 'role': 'user', 'parentId': None, 'content': 'go'},
            'r': {'id': 'r', 'role': 'assistant', 'parentId': 'q', 'model': 'm', 'meta': meta},
        }

    async def get_message_by_id_and_message_id(self, chat_id, message_id):
        return self.messages.get(message_id)


def _payload(monkeypatch, meta):
    monkeypatch.setattr(tool_approval, 'Chats', FakeChats(meta))
    chat = SimpleNamespace(id='c', chat={'models': ['m'], 'files': [OTHER_BRANCH]}, variables={})
    return asyncio.run(build_tool_approval_resume_payload('c', 'r', chat=chat))


@pytest.mark.parametrize(
    ('meta', 'expected'),
    [
        # The paused turn had no documents: the resume has none either.
        ({'files': []}, None),
        ({'files': [THIS_BRANCH]}, [THIS_BRANCH]),
        # Paused before the turn's files were recorded: the chat's list is all there is.
        ({}, [OTHER_BRANCH]),
    ],
)
def test_resume_reads_the_paused_turns_documents(monkeypatch, meta, expected):
    assert _payload(monkeypatch, meta)['files'] == expected
