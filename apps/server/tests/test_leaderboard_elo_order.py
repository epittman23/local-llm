"""The leaderboard applies Elo in the order feedback was given (#203).

Elo is order dependent, and the leaderboard query had no ORDER BY, so rows
came back in storage order: an edited feedback (a new row version in
Postgres) or a table rewrite reordered them and moved every rating with no
new data. The rows here are stored in the opposite order to their
created_at, with ids that sort against it too, so only a created_at
ordering gives the expected ratings.

Runs against the suite's temporary SQLite database (migrated on import).

Run from apps/server:

    python -m pytest tests/test_leaderboard_elo_order.py
"""

import asyncio
import uuid

from local_llm.internal.db import get_async_db_context
from local_llm.models.feedbacks import Feedback, Feedbacks
from local_llm.routers.evaluations import _calculate_elo


async def _store(rows: list[tuple[str, int, dict]]) -> None:
    """Insert (id, created_at, data) rows one commit at a time, in list order."""
    for fid, created_at, data in rows:
        async with get_async_db_context() as db:
            db.add(
                Feedback(
                    id=fid,
                    user_id='u',
                    version=0,
                    type='rating',
                    data=data,
                    meta={},
                    snapshot={},
                    created_at=created_at,
                    updated_at=created_at,
                )
            )
            await db.commit()


async def _leaderboard_rows(prefix: str):
    return [row for row in await Feedbacks.get_feedbacks_for_leaderboard() if row.id.startswith(prefix)]


def test_ratings_follow_created_at_not_storage_order():
    tag = uuid.uuid4().hex[:8]
    a, b = f'{tag}-model-a', f'{tag}-model-b'

    async def scenario():
        # B beats A second, but is stored first and has the id that sorts first.
        await _store(
            [
                (f'{tag}-1', 2000, {'model_id': b, 'rating': 1, 'sibling_model_ids': [a]}),
                (f'{tag}-2', 1000, {'model_id': a, 'rating': 1, 'sibling_model_ids': [b]}),
            ]
        )
        return await _leaderboard_rows(tag)

    rows = asyncio.run(scenario())
    stats = _calculate_elo(rows)

    # A beats B first (1016 / 984), then B's upset win is worth more than 16.
    assert [row.id for row in rows] == [f'{tag}-2', f'{tag}-1']
    assert round(stats[a]['rating']) == 999
    assert round(stats[b]['rating']) == 1001


def test_same_second_feedback_is_ordered_by_id():
    tag = uuid.uuid4().hex[:8]
    data = {'model_id': f'{tag}-m', 'rating': 1, 'sibling_model_ids': [f'{tag}-n']}

    async def scenario():
        await _store([(f'{tag}-z', 1500, data), (f'{tag}-a', 1500, data)])
        return await _leaderboard_rows(tag)

    assert [row.id for row in asyncio.run(scenario())] == [f'{tag}-a', f'{tag}-z']
