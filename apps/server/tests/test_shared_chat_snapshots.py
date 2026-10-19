"""A chat share is a snapshot: its grant reads the snapshot and its files, not the live chat.

Run from apps/server:

    python -m pytest tests/test_shared_chat_snapshots.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from local_llm.models import chats as chats_model
from local_llm.models import shared_chats as shared_model
from local_llm.models.shared_chats import snapshot_file_ids
from local_llm.utils.access_control import files as file_access

READER = SimpleNamespace(id='reader', role='user')
SNAPSHOT_CHAT = {
    'history': {
        'messages': {
            'm1': {'files': [{'type': 'file', 'id': 'f-shared'}]},
            'm2': {'files': [{'type': 'image', 'file': {'id': 'f-nested'}}, 'junk']},
            'm3': {'files': [{'type': 'image', 'url': '/api/v1/files/f-generated/content'}]},
            'm4': {'content': 'Here: ![plot](/api/v1/files/f-inline/content)', 'files': []},
            'm5': {'files': [{'type': 'image', 'url': 'https://example.com/elsewhere.png'}]},
        }
    }
}


def test_snapshot_file_ids():
    assert snapshot_file_ids(SNAPSHOT_CHAT) == {'f-shared', 'f-nested', 'f-generated', 'f-inline'}
    assert snapshot_file_ids(None) == set()


def test_a_share_grant_does_not_open_the_live_chat(monkeypatch):
    live = SimpleNamespace(id='c1', user_id='owner', meta={}, folder_id=None)

    async def not_owner(*_a, **_k):
        return None

    async def get_chat(*_a, **_k):
        return live

    monkeypatch.setattr(chats_model.Chats, 'get_chat_by_id_and_user_id', not_owner)
    monkeypatch.setattr(chats_model.Chats, 'get_chat_by_id', get_chat)
    assert asyncio.run(chats_model.Chats.get_chat_by_id_for_user('c1', READER)) is None


@pytest.fixture
def file_world(monkeypatch):
    async def get_file(file_id, db=None):
        return SimpleNamespace(id=file_id, user_id='owner', meta={})

    async def nothing(*_a, **_k):
        return []

    async def no_groups(*_a, **_k):
        return []

    async def no_models(*_a, **_k):
        return {}

    async def shared_ids(file_id, db=None):
        return ['c1']  # the live chat holds both files and has a share link

    async def snapshot(chat_id, db=None):
        return SimpleNamespace(chat_id='c1', chat=SNAPSHOT_CHAT)

    async def granted(**k):
        return k['resource_ids']

    monkeypatch.setattr(file_access.Files, 'get_file_by_id', get_file)
    monkeypatch.setattr(file_access.Knowledges, 'get_knowledges_by_file_id', nothing)
    monkeypatch.setattr(file_access.Groups, 'get_groups_by_member_id', no_groups)
    monkeypatch.setattr(file_access.Channels, 'get_channels_by_file_id_and_user_id', nothing)
    monkeypatch.setattr(file_access.Models, 'get_model_owners_attaching_file', no_models)
    monkeypatch.setattr(file_access.Chats, 'get_shared_chat_ids_by_file_id', shared_ids)
    monkeypatch.setattr(shared_model.SharedChats, 'get_by_chat_id', snapshot)
    monkeypatch.setattr(file_access.AccessGrants, 'get_accessible_resource_ids', granted)


def test_a_file_in_the_snapshot_is_readable_through_the_share(file_world):
    assert asyncio.run(file_access.has_access_to_file('f-shared', 'read', READER)) is True


def test_a_file_attached_after_sharing_is_not(file_world):
    assert asyncio.run(file_access.has_access_to_file('f-later', 'read', READER)) is False
