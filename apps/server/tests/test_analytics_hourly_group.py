"""The Analytics 24-hour chart honours the group filter (#198).

Admin > Analytics sends `group_id` with `granularity=hourly` for "Last 24
hours", but the hourly branch of `/analytics/daily` called
`get_hourly_message_counts_by_model` without it, and the method took no such
parameter, so the chart counted every user's messages. Both granularities now
build their query with the same filter.

Runs against the suite's own temporary SQLite database.

Run from apps/server:

    python -m pytest tests/test_analytics_hourly_group.py
"""

from __future__ import annotations

import asyncio
import uuid

import pytest

from local_llm.internal.db import Base, async_engine, get_async_db_context
from local_llm.models.chat_messages import ChatMessage, ChatMessages
from local_llm.models.chats import Chat
from local_llm.models.groups import GroupMember
from local_llm.routers import analytics

# 2026-11-04 10:30 and 11:30 UTC; the counts are bucketed in local time, so
# the tests compare totals rather than bucket names.
T1, T2 = 1_793_788_200, 1_793_791_800


@pytest.fixture(scope='module')
def world():
    tag = uuid.uuid4().hex[:8]
    group_id, member, outsider = f'g-{tag}', f'member-{tag}', f'outsider-{tag}'
    model = f'model-{tag}'

    async def build():
        async with async_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with get_async_db_context() as db:
            db.add(GroupMember(id=f'gm-{tag}', group_id=group_id, user_id=member, created_at=0))
            for user_id, times in ((member, (T1,)), (outsider, (T1, T2))):
                chat_id = f'chat-{user_id}'
                db.add(Chat(id=chat_id, user_id=user_id, title='t', chat={}, created_at=0, updated_at=0))
                for i, at in enumerate(times):
                    db.add(
                        ChatMessage(
                            id=f'{chat_id}-{i}',
                            chat_id=chat_id,
                            user_id=user_id,
                            role='assistant',
                            model_id=model,
                            created_at=at,
                            updated_at=at,
                        )
                    )
            await db.commit()

    asyncio.run(build())
    return group_id, model


def _total(counts, model):
    return sum(by_model.get(model, 0) for by_model in counts.values())


@pytest.mark.parametrize('method', ['get_hourly_message_counts_by_model', 'get_daily_message_counts_by_model'])
def test_a_group_counts_only_its_members_messages(world, method):
    group_id, model = world
    count = getattr(ChatMessages, method)

    everyone = asyncio.run(count(start_date=T1 - 60, end_date=T2 + 60))
    members = asyncio.run(count(start_date=T1 - 60, end_date=T2 + 60, group_id=group_id))

    assert _total(everyone, model) == 3
    assert _total(members, model) == 1


def test_the_hourly_chart_route_passes_the_group(world, monkeypatch):
    group_id, model = world
    seen = []
    real = ChatMessages.get_hourly_message_counts_by_model

    async def spy(**kwargs):
        seen.append(kwargs.get('group_id'))
        return await real(**kwargs)

    monkeypatch.setattr(analytics.ChatMessages, 'get_hourly_message_counts_by_model', spy)

    response = asyncio.run(
        analytics.get_daily_stats(
            start_date=T1 - 60, end_date=T2 + 60, group_id=group_id, granularity='hourly', user=None, db=None
        )
    )

    assert seen == [group_id]
    assert sum(entry.models.get(model, 0) for entry in response.data) == 1
