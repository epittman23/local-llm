"""Tag models and database operations."""

from __future__ import annotations

import logging

from pydantic import BaseModel, ConfigDict
from sqlalchemy import JSON, Column, Index, PrimaryKeyConstraint, String, delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

# local imports
from local_llm.internal.db import Base, get_async_db_context

log = logging.getLogger(__name__)


class Tag(Base):  # database table mapping for tag entity
    __tablename__ = 'tag'
    id = Column(String)
    name = Column(String, index=True)  # tag label
    user_id = Column(String, index=True)  # user identifier
    meta = Column(JSON, nullable=True)

    __table_args__ = (
        PrimaryKeyConstraint('id', 'user_id', name='pk_id_user_id'),
        Index('user_id_idx', 'user_id'),
    )

    # Unique constraint ensuring (id, user_id) is unique, not just the `id` column
    __table_args__ = (PrimaryKeyConstraint('id', 'user_id', name='pk_id_user_id'),)


class TagModel(BaseModel):
    id: str
    name: str
    user_id: str
    meta: dict | None = None
    model_config = ConfigDict(from_attributes=True)  # allows ORM model binding


# --- tag schema forms ---
# Forms
####################


class TagChatIdForm(BaseModel):
    name: str
    chat_id: str


# The insert that can skip a conflict, for each database the app runs on.
INSERTS = {'postgresql': pg_insert, 'sqlite': sqlite_insert}


class TagTable:
    async def insert_new_tag(
        self,
        name: str,
        user_id: str,
        db: AsyncSession | None = None,
    ) -> TagModel | None:
        """Create a new tag, deriving the id from the name."""
        async with get_async_db_context(db) as db:
            tag_id = name.replace(' ', '_').lower()
            try:
                record = Tag(id=tag_id, user_id=user_id, name=name)
                db.add(record)
                await db.commit()
                return TagModel.model_validate(record) if record else None
            except Exception as e:
                log.exception('Error inserting tag %r: %s', name, e)
                return None  # insertion failed

    async def get_tag_by_name_and_user_id(
        self, name: str, user_id: str, db: AsyncSession | None = None
    ) -> TagModel | None:
        try:
            id = name.replace(' ', '_').lower()
            async with get_async_db_context(db) as db:
                result = await db.execute(select(Tag).filter_by(id=id, user_id=user_id))
                tag = result.scalars().first()
                return TagModel.model_validate(tag) if tag else None
        except Exception:
            return None

    async def get_tags_by_user_id(self, user_id: str, db: AsyncSession | None = None) -> list[TagModel]:
        async with get_async_db_context(db) as db:
            result = await db.execute(select(Tag).filter_by(user_id=user_id))
            return [TagModel.model_validate(tag) for tag in result.scalars().all()]

    async def get_tags_by_ids_and_user_id(
        self, ids: list[str], user_id: str, db: AsyncSession | None = None
    ) -> list[TagModel]:
        async with get_async_db_context(db) as db:
            result = await db.execute(select(Tag).filter(Tag.id.in_(ids), Tag.user_id == user_id))
            return [TagModel.model_validate(tag) for tag in result.scalars().all()]

    async def delete_tag_by_name_and_user_id(self, name: str, user_id: str, db: AsyncSession | None = None) -> bool:
        try:
            async with get_async_db_context(db) as db:
                id = name.replace(' ', '_').lower()
                result = await db.execute(delete(Tag).filter_by(id=id, user_id=user_id))
                log.debug('res: %s', result.rowcount)
                await db.commit()
                return True
        except Exception as e:
            log.error(f'delete_tag: {e}')
            return False

    async def delete_tags_by_ids_and_user_id(
        self, ids: list[str], user_id: str, db: AsyncSession | None = None
    ) -> bool:
        """Delete all tags whose id is in *ids* for the given user, in one query."""
        if not ids:
            return True
        try:
            async with get_async_db_context(db) as db:
                await db.execute(delete(Tag).filter(Tag.id.in_(ids), Tag.user_id == user_id))
                await db.commit()
                return True
        except Exception as e:
            log.error(f'delete_tags_by_ids: {e}')
            return False

    async def ensure_tags_exist(self, names: list[str], user_id: str, db: AsyncSession | None = None) -> None:
        """Create tag rows for any *names* that don't already exist for *user_id*.

        Names that normalise to the same id ('Python', 'python') are one tag;
        the first spelling is kept as its name.
        """
        if not names:
            return
        names_by_id: dict[str, str] = {}
        for name in names:
            names_by_id.setdefault(name.replace(' ', '_').lower(), name)
        # Sorted, so two inserts for one user lock their rows in the same order
        # and cannot deadlock on Postgres.
        rows = [{'id': tag_id, 'name': name, 'user_id': user_id} for tag_id, name in sorted(names_by_id.items())]
        async with get_async_db_context(db) as db:
            # One insert that skips tags already there, not a check and then an
            # insert: two tag writes finishing together for one user could both
            # find a tag missing, and the second then hit the key (#531).
            dialect = (await db.connection()).dialect.name
            if dialect not in INSERTS:
                raise NotImplementedError(f'Unsupported dialect: {dialect}')
            insert = INSERTS[dialect]
            await db.execute(insert(Tag).values(rows).on_conflict_do_nothing(index_elements=['id', 'user_id']))
            await db.commit()


Tags = TagTable()  # singleton tag repository
