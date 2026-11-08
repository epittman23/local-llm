"""Paged users and models listings end in the id, so equal sort keys never repeat or skip (#199).

OFFSET paging over an ORDER BY with ties (or none) lets the database return tied
rows in any order per query, so a row could appear on two pages or on none. Every
ordering now ends with the primary key. The rows here all share their sort
values and are inserted in an order that is neither id order nor its reverse, so
an unordered query (which SQLite answers in insertion order) cannot pass by
chance. The feedback listing already ends in its id (#205,
test_feedback_list_order.py).

Runs against the suite's own temporary SQLite database.

Run from apps/server:

    python -m pytest tests/test_paged_listing_tiebreaker.py
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import update

from local_llm.internal.db import Base, async_engine, get_async_db_context
from local_llm.models.models import Model, ModelForm, ModelMeta, ModelParams, Models
from local_llm.models.users import User, Users

LETTERS = 'cebad'  # insertion order; sorted ids are a..e


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(scope='module')
def world():
    tag = uuid.uuid4().hex[:8]

    async def build():
        async with async_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        user_ids = [f'u-{tag}-{letter}' for letter in LETTERS]
        model_ids = [f'm-{tag}-{letter}' for letter in LETTERS]
        for uid in user_ids:
            await Users.insert_new_user(uid, 'Same Name', f'{uid}@example.com', role='user')
        for mid in model_ids:
            await Models.insert_new_model(
                ModelForm(id=mid, base_model_id='base', name='Same Name', meta=ModelMeta(), params=ModelParams()),
                user_ids[0],
            )
        async with get_async_db_context() as db:
            await db.execute(
                update(User).filter(User.id.in_(user_ids)).values(created_at=100, updated_at=100, last_active_at=100)
            )
            await db.execute(update(Model).filter(Model.id.in_(model_ids)).values(created_at=100, updated_at=100))
            await db.commit()
        return user_ids, model_ids

    return _run(build())


def _user_pages(ids, **kwargs):
    # Page through every user: a shared database (Postgres) also holds other tests' users.
    seen = []
    skip, total = 0, 1
    while skip < total:
        result = _run(Users.get_users(skip=skip, limit=2, **kwargs))
        total = result['total']
        seen += [u.id for u in result['users'] if u.id in ids]
        skip += 2
    return seen


def _model_pages(user_id, ids, **filter):
    seen = []
    skip, total = 0, 1
    while skip < total:
        result = _run(Models.search_models(user_id, filter={'view_option': 'created', **filter}, skip=skip, limit=2))
        total = result.total
        seen += [m.id for m in result.items if m.id in ids]
        skip += 2
    return seen


@pytest.mark.parametrize('field', ['name', 'email', 'created_at', 'last_active_at', 'updated_at', 'role'])
@pytest.mark.parametrize('direction', ['asc', 'desc'])
def test_user_pages_with_equal_sort_keys_cover_each_user_once(world, field, direction):
    user_ids, _ = world
    seen = _user_pages(user_ids, sort={'order_by': field, 'direction': direction})
    assert sorted(seen) == sorted(user_ids)
    assert len(seen) == len(set(seen))


def test_user_pages_unsorted_and_filtered_cover_each_user_once(world):
    user_ids, _ = world
    for kwargs in ({}, {'filter': {'roles': ['user']}}, {'sort': {'order_by': 'name', 'direction': 'asc'}}):
        seen = _user_pages(user_ids, **kwargs)
        assert sorted(seen) == sorted(user_ids)
        assert len(seen) == len(set(seen))


def test_user_ties_break_on_id_in_the_sort_direction(world):
    user_ids, _ = world
    ascending = _user_pages(user_ids, sort={'order_by': 'created_at', 'direction': 'asc'})
    descending = _user_pages(user_ids, sort={'order_by': 'created_at', 'direction': 'desc'})
    assert ascending == sorted(user_ids)
    assert descending == sorted(user_ids, reverse=True)


@pytest.mark.parametrize('order', [{}, {'order_by': 'name'}, {'order_by': 'created_at'}, {'order_by': 'updated_at'}])
@pytest.mark.parametrize('direction', ['asc', 'desc'])
def test_model_ties_break_on_id_in_the_sort_direction(world, order, direction):
    user_ids, model_ids = world
    seen = _model_pages(user_ids[0], model_ids, direction=direction, **order)
    expected = sorted(model_ids) if direction == 'asc' and order else sorted(model_ids, reverse=True)
    assert seen == expected
