"""The admin feedback list is always in a total order (#205).

Admin > Evaluations > Feedback sends `order_by='user'` for its User column,
but `get_feedback_items` knew only `'username'`, and it applied its
newest-first default only when no filter at all was given. So sorting by
User, or any unknown key, ran the page query with no ORDER BY, and OFFSET
paging could repeat or skip rows; the other sorts had no tiebreaker for
equal values. Now 'user' sorts by user name like 'username', every sort
ends with the feedback id in the same direction, and anything else is
newest first.

Runs against the suite's own temporary SQLite database.

Run from apps/server:

    python -m pytest tests/test_feedback_list_order.py
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import update

from local_llm.internal.db import Base, async_engine, get_async_db_context
from local_llm.models.auths import Auths
from local_llm.models.feedbacks import Feedback, FeedbackForm, Feedbacks


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(scope='module')
def world():
    """Two users and four feedbacks on one model, all with the same timestamps."""
    tag = uuid.uuid4().hex[:8]
    model_id = f'model-{tag}'

    async def build():
        async with async_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        users = {}
        for name in ('Ann', 'Bob'):
            user = await Auths.insert_new_auth(f'{name.lower()}-{tag}@example.com', 'x', f'{name} {tag}', role='user')
            assert user is not None
            users[name] = user.id
        ids = []
        for owner, rating in (('Ann', 1), ('Bob', -1), ('Ann', -1), ('Bob', 1)):
            feedback = await Feedbacks.insert_new_feedback(
                users[owner], FeedbackForm(type='rating', data={'model_id': model_id, 'rating': rating})
            )
            assert feedback is not None
            ids.append(feedback.id)
        # Equal timestamps for all four, so only the tiebreaker orders them; and
        # ids whose insertion order is neither sort order, so an unordered query
        # (which SQLite returns in insertion order) cannot pass by chance.
        fixed = [f'fb-{tag}-{letter}' for letter in 'bdac']
        async with get_async_db_context() as db:
            for old_id, new_id in zip(ids, fixed, strict=True):
                await db.execute(
                    update(Feedback).filter(Feedback.id == old_id).values(id=new_id, created_at=100, updated_at=100)
                )
            await db.commit()
        return model_id, users, fixed

    return _run(build())


def _page(model_id, **order):
    result = _run(Feedbacks.get_feedback_items({'model_id': model_id, **order}, skip=0, limit=30))
    return [(item.user.name.split()[0] if item.user else None, item.id) for item in result.items]


@pytest.mark.parametrize('key', ['user', 'username'])
def test_sorting_by_user_orders_by_name_then_id(world, key):
    model_id, _, ids = world

    ascending = _page(model_id, order_by=key, direction='asc')
    descending = _page(model_id, order_by=key, direction='desc')

    ann = sorted(i for i in ids[0::2])
    bob = sorted(i for i in ids[1::2])
    assert ascending == [('Ann', ann[0]), ('Ann', ann[1]), ('Bob', bob[0]), ('Bob', bob[1])]
    assert descending == list(reversed(ascending))


@pytest.mark.parametrize('order', [{}, {'order_by': 'nonsense'}, {'order_by': 'updated_at', 'direction': 'desc'}])
def test_equal_timestamps_are_ordered_by_id(world, order):
    model_id, _, ids = world

    assert [i for _, i in _page(model_id, **order)] == sorted(ids, reverse=True)


def test_ascending_ties_are_ordered_by_id_ascending(world):
    model_id, _, ids = world

    assert [i for _, i in _page(model_id, order_by='updated_at', direction='asc')] == sorted(ids)


def test_every_sort_key_the_admin_table_sends_is_known():
    # #205 was a key mismatch between the two sides; read the table's keys
    # from its source so a rename on either side fails here.
    import re
    from pathlib import Path

    from local_llm.models.feedbacks import _FEEDBACK_ORDER_COLUMNS

    source = (Path(__file__).parents[3] / 'apps/web/src/routes/admin/evaluations/Feedbacks.tsx').read_text()
    columns = source[source.index('const COLUMNS') : source.index('];', source.index('const COLUMNS'))]
    keys = re.findall(r"key: '([^']+)'", columns)

    assert keys == ['user', 'model_id', 'rating', 'updated_at']
    assert set(keys) <= set(_FEEDBACK_ORDER_COLUMNS)
