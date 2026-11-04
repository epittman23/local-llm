"""A note delete or pin that fails says so (#332).

`Notes.delete_note_by_id` reports a failure as False, which the delete route
ignored: it announced NOTE_DELETED and answered true. `toggle_note_pinned_by_id`
reports one as None, which the pin route then read as a note, a 500. Both
now answer 400 and announce nothing.

Run from apps/server:

    python -m pytest tests/test_note_delete_pin_failures.py
"""

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.routers import notes as notes_router

OWNER = SimpleNamespace(id='u1', role='user')


@pytest.fixture
def note_routes(monkeypatch):
    events: list = []

    async def allowed(*_a, **_k):
        return True

    async def note(note_id, db=None):
        return SimpleNamespace(id=note_id, user_id='u1')

    async def publish(request, event, **_k):
        events.append(event)

    async def nothing(*_a, **_k):
        return None

    async def config_get(key, default=None):
        return default

    monkeypatch.setattr(notes_router, 'has_permission', allowed)
    monkeypatch.setattr(notes_router.Config, 'get', config_get)
    monkeypatch.setattr(notes_router.Notes, 'get_note_by_id', note)
    monkeypatch.setattr(notes_router, 'publish_event', publish)
    monkeypatch.setattr(notes_router, 'close_room', nothing)
    return events


def _failing(value):
    async def result(*_a, **_k):
        return value

    return result


def test_a_failed_delete_is_a_400_and_announces_nothing(note_routes, monkeypatch):
    monkeypatch.setattr(notes_router.Notes, 'delete_note_by_id', _failing(False))

    with pytest.raises(HTTPException) as refused:
        asyncio.run(notes_router.delete_note_by_id(None, 'n1', user=OWNER, db=None))

    assert refused.value.status_code == 400
    assert note_routes == []


def test_a_delete_that_succeeds_is_announced(note_routes, monkeypatch):
    monkeypatch.setattr(notes_router.Notes, 'delete_note_by_id', _failing(True))

    assert asyncio.run(notes_router.delete_note_by_id(None, 'n1', user=OWNER, db=None)) is True
    assert note_routes == [notes_router.EVENTS.NOTE_DELETED]


def test_a_failed_pin_is_a_400_and_announces_nothing(note_routes, monkeypatch):
    monkeypatch.setattr(notes_router.Notes, 'toggle_note_pinned_by_id', _failing(None))

    with pytest.raises(HTTPException) as refused:
        asyncio.run(notes_router.pin_note_by_id(None, 'n1', user=OWNER, db=None))

    assert refused.value.status_code == 400
    assert note_routes == []
