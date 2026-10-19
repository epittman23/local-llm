"""Repro: add_users_to_group with a duplicate in the list silently drops earlier new members."""
import asyncio
from sqlalchemy import UniqueConstraint, select

from local_llm.internal.db import Base, async_engine, AsyncSessionLocal
from local_llm.models.groups import Groups, GroupForm, GroupMember

# The real DB has uq_group_member_group_user from migration 37f288994c47; the ORM table lacks it.
GroupMember.__table__.append_constraint(UniqueConstraint('group_id', 'user_id', name='uq_group_member_group_user'))


async def main():
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    g = await Groups.insert_new_group('admin', GroupForm(name='g', description=''))
    await Groups.add_users_to_group(g.id, ['existing'])
    print('before:', sorted(await Groups.get_group_user_ids_by_id(g.id)))
    res = await Groups.add_users_to_group(g.id, ['alice', 'existing', 'bob'])
    print('returned group:', res is not None)
    print('after :', sorted(await Groups.get_group_user_ids_by_id(g.id)))
    # Duplicate in the request itself
    g2 = await Groups.insert_new_group('admin', GroupForm(name='g2', description=''))
    await Groups.add_users_to_group(g2.id, ['carol', 'carol'])
    print('g2 after [carol, carol]:', sorted(await Groups.get_group_user_ids_by_id(g2.id)))

asyncio.run(main())
