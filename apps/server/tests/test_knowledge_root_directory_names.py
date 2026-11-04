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

from local_llm.models.knowledge import KnowledgeForm, Knowledges
from local_llm.models.users import Users

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
