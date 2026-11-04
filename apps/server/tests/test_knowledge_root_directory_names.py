"""Two directories at a knowledge base's root cannot share a name (#312).

Sibling names were kept unique by the constraint on (knowledge_id, parent_id,
name), but Postgres and SQLite both treat NULL parents as distinct, so two
root directories named "docs" were accepted, and the sync, which maps a path
to one directory, ignored the other for good. Creating, renaming or moving a
directory now refuses a name a sibling already has, at the root as below it.

Runs against the test run's migrated SQLite database.

Run from apps/server:

    python -m pytest tests/test_knowledge_root_directory_names.py
"""

import asyncio
import importlib
import uuid

import pytest
from fastapi import HTTPException

from local_llm.models.knowledge import KnowledgeForm, Knowledges
from local_llm.models.users import Users
from local_llm.routers import knowledge as knowledge_router

# Importing the config runs the migrations on the test run's database.
importlib.import_module('local_llm.config')


def _run(coro):
    return asyncio.run(coro)


def _base():
    tag = uuid.uuid4().hex[:8]
    user = _run(Users.insert_new_user(f'u-{tag}', 'Una', f'u-{tag}@example.invalid', role='user'))
    base = _run(Knowledges.insert_new_knowledge(user.id, KnowledgeForm(name=f'kb-{tag}', description='')))
    return base.id, user.id


def test_a_second_root_directory_with_the_same_name_is_refused():
    kb, user = _base()

    assert _run(Knowledges.create_directory(kb, 'docs', user)) is not None
    assert _run(Knowledges.create_directory(kb, 'docs', user)) is None
    assert [d.name for d in _run(Knowledges.get_directories(kb))] == ['docs']


def test_the_same_name_is_still_refused_under_a_parent_and_allowed_elsewhere():
    kb, user = _base()
    parent = _run(Knowledges.create_directory(kb, 'parent', user))

    assert _run(Knowledges.create_directory(kb, 'docs', user, parent_id=parent.id)) is not None
    assert _run(Knowledges.create_directory(kb, 'docs', user, parent_id=parent.id)) is None
    # Another level, and another knowledge base, may have one.
    assert _run(Knowledges.create_directory(kb, 'docs', user)) is not None
    other_kb, _ = _base()
    assert _run(Knowledges.create_directory(other_kb, 'docs', user)) is not None


def test_renaming_or_moving_onto_a_root_siblings_name_is_refused():
    kb, user = _base()
    _run(Knowledges.create_directory(kb, 'docs', user))
    notes = _run(Knowledges.create_directory(kb, 'notes', user))
    parent = _run(Knowledges.create_directory(kb, 'parent', user))
    nested = _run(Knowledges.create_directory(kb, 'docs', user, parent_id=parent.id))

    assert _run(Knowledges.update_directory(notes.id, name='docs')) is None
    assert _run(Knowledges.update_directory(nested.id, parent_id=None)) is None
    # Renaming a directory to its own name, and a free name, still work.
    assert _run(Knowledges.update_directory(notes.id, name='notes')) is not None
    assert _run(Knowledges.update_directory(notes.id, name='papers')).name == 'papers'
    assert sorted(d.name for d in _run(Knowledges.get_directories(kb))) == ['docs', 'papers', 'parent']


def test_a_move_with_a_rename_is_checked_against_its_final_name_and_place():
    kb, user = _base()
    parent = _run(Knowledges.create_directory(kb, 'parent', user))
    taken = _run(Knowledges.create_directory(kb, 'b', user))
    moving = _run(Knowledges.create_directory(kb, 'a', user, parent_id=parent.id))

    # The final name is taken at the root: refused, and nothing is applied.
    assert _run(Knowledges.update_directory(moving.id, name='b', parent_id=None)) is None
    unchanged = _run(Knowledges.get_directory_by_id(moving.id))
    assert (unchanged.parent_id, unchanged.name) == (parent.id, 'a')

    # Its current name is taken at the root, but the final one is free: both apply.
    _run(Knowledges.update_directory(taken.id, name='a'))
    moved = _run(Knowledges.update_directory(moving.id, name='c', parent_id=None))
    assert (moved.parent_id, moved.name) == (None, 'c')
    assert sorted(d.name for d in _run(Knowledges.get_directories(kb))) == ['a', 'c', 'parent']


@pytest.fixture
def no_events(monkeypatch):
    async def publish(*_a, **_k):
        return None

    monkeypatch.setattr(knowledge_router, 'publish_event', publish)


def test_the_routes_answer_400_for_a_root_name_already_taken(no_events):
    kb, user_id = _base()
    user = _run(Users.get_user_by_id(user_id))
    create = knowledge_router.KnowledgeDirectoryCreateForm(name='docs')

    _run(knowledge_router.create_knowledge_directory(None, kb, create, user=user, db=None))
    with pytest.raises(HTTPException) as refused_create:
        _run(knowledge_router.create_knowledge_directory(None, kb, create, user=user, db=None))

    other = _run(
        knowledge_router.create_knowledge_directory(
            None, kb, knowledge_router.KnowledgeDirectoryCreateForm(name='notes'), user=user, db=None
        )
    )
    rename = knowledge_router.KnowledgeDirectoryUpdateForm(name='docs')
    with pytest.raises(HTTPException) as refused_rename:
        _run(knowledge_router.update_knowledge_directory(None, kb, other.id, rename, user=user, db=None))

    assert refused_create.value.status_code == 400
    assert refused_rename.value.status_code == 400
    assert sorted(d.name for d in _run(Knowledges.get_directories(kb))) == ['docs', 'notes']
