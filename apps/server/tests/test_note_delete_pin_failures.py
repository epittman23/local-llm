"""A note delete or pin that fails says so (#332).

`Notes.delete_note_by_id` reports a failure as False, which the delete route
ignored: it announced NOTE_DELETED and answered true. `toggle_note_pinned_by_id`
reports one as None, which the pin route then read as a note, a 500. Both
now answer 400 and announce nothing, and the model logs what failed.

Run from apps/server:

    python -m pytest tests/test_note_delete_pin_failures.py
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from local_llm.models import notes as notes_model
from local_llm.routers import notes as notes_router

OWNER = SimpleNamespace(id='u1', role='user')


@pytest.fixture
def routes(monkeypatch):
    seen = SimpleNamespace(events=[], closed=[])

    async def allowed(*_a, **_k):
        return True

    async def note(note_id, db=None):
        return SimpleNamespace(id=note_id, user_id='u1')

    async def publish(request, event, **_k):
        seen.events.append(event)

    async def close(room):
        seen.closed.append(room)

    async def config_get(key, default=None):
        return default

    monkeypatch.setattr(notes_router, 'has_permission', allowed)
    monkeypatch.setattr(notes_router.Config, 'get', config_get)
    monkeypatch.setattr(notes_router.Notes, 'get_note_by_id', note)
    monkeypatch.setattr(notes_router, 'publish_event', publish)
    monkeypatch.setattr(notes_router, 'close_room', close)
    return seen


def _returns(value):
    async def result(*_a, **_k):
        return value

    return result


def test_a_failed_delete_is_a_400_and_announces_nothing(routes, monkeypatch):
    monkeypatch.setattr(notes_router.Notes, 'delete_note_by_id', _returns(False))

    with pytest.raises(HTTPException) as refused:
        asyncio.run(notes_router.delete_note_by_id(None, 'n1', user=OWNER, db=None))

    assert refused.value.status_code == 400
    # The note is still there, so its collaborators stay connected.
    assert routes.events == [] and routes.closed == []


def test_a_delete_that_succeeds_is_announced(routes, monkeypatch):
    monkeypatch.setattr(notes_router.Notes, 'delete_note_by_id', _returns(True))

    assert asyncio.run(notes_router.delete_note_by_id(None, 'n1', user=OWNER, db=None)) is True
    assert routes.events == [notes_router.EVENTS.NOTE_DELETED]
    assert routes.closed == ['note:n1']


def test_a_failed_pin_is_a_400_and_announces_nothing(routes, monkeypatch):
    monkeypatch.setattr(notes_router.Notes, 'toggle_note_pinned_by_id', _returns(None))

    with pytest.raises(HTTPException) as refused:
        asyncio.run(notes_router.pin_note_by_id(None, 'n1', user=OWNER, db=None))

    assert refused.value.status_code == 400
    assert routes.events == []


def test_a_pin_that_succeeds_returns_the_note_and_is_announced(routes, monkeypatch):
    monkeypatch.setattr(notes_router.Notes, 'toggle_note_pinned_by_id', _returns(SimpleNamespace(id='n1')))
    monkeypatch.setattr(notes_router.Notes, 'get_pinned_note_ids', _returns(['n1']))

    note = asyncio.run(notes_router.pin_note_by_id(None, 'n1', user=OWNER, db=None))

    assert note.is_pinned is True
    assert routes.events == [notes_router.EVENTS.NOTE_PINNED]


def test_the_model_reports_a_database_failure_and_logs_it(monkeypatch, caplog):
    class Broken:
        async def execute(self, *_a, **_k):
            raise RuntimeError('database unavailable')

        async def commit(self):
            raise RuntimeError('database unavailable')

    @asynccontextmanager
    async def broken_db(db=None):
        yield Broken()

    async def revoke(*_a, **_k):
        raise RuntimeError('database unavailable')

    monkeypatch.setattr(notes_model, 'get_async_db_context', broken_db)
    monkeypatch.setattr(notes_model.AccessGrants, 'revoke_all_access', revoke)

    with caplog.at_level(logging.WARNING, logger=notes_model.__name__):
        assert asyncio.run(notes_model.Notes.delete_note_by_id('n1')) is False
        assert asyncio.run(notes_model.Notes.toggle_note_pinned_by_id('n1', 'u1')) is None

    messages = [r.getMessage() for r in caplog.records]
    assert any('Could not delete note n1' in m for m in messages)
    assert any('Could not pin or unpin note n1' in m for m in messages)
