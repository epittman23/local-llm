"""The manager's record of each persistent workspace: whose it is, its last use, and a deletion waiting for its user.

Owner decision Q15 (docs/plans/sandbox-implementation.md, T24): a user holds
at most `max_workspaces` persistent workspaces, and none is deleted for that
cap or for the retention expiry without the user's answer. The manager
(sandbox/manager.py) keeps one WorkspaceRecord per persistent volume
through a WorkspaceStore: DatabaseWorkspaces on the app's database (the
`sandbox_workspace` table, models/sandbox.py), which survives restarts, or
MemoryWorkspaces, the in-memory stand-in tests use. Ephemeral sandboxes
(unsaved chats) have no record and do not count.
"""

from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Any, Literal, Protocol

#: Why a workspace waits for its user's answer before it is deleted.
PendingReason = Literal['cap', 'expired']


@dataclass(frozen=True)
class WorkspaceRecord:
    """One persistent workspace volume.

    Attributes:
        key: The backend key its volume is named after (a saved chat's id).
        user_id: Whose it is: the chat's owner, whoever ran the code (an admin may, Q14).
        chat_id: The chat it belongs to.
        created_at: When the manager recorded it, epoch seconds.
        last_used_at: When a session on it last ended (or the user kept it), epoch seconds.
        pending_reason: None, or why it waits for its user's answer before it may be deleted.
        pending_since: When it started waiting, epoch seconds.
        pending_for: For `cap`, the chat whose new workspace waits for room.
    """

    key: str
    user_id: str
    chat_id: str
    created_at: int
    last_used_at: int
    pending_reason: PendingReason | None = None
    pending_since: int | None = None
    pending_for: str | None = None


class WorkspaceStore(Protocol):
    """Where the manager keeps the WorkspaceRecords; every method raises on a storage error, never half-answers."""

    async def get(self, key: str) -> WorkspaceRecord | None:
        """The record of `key`, or None."""
        ...

    async def of_user(self, user_id: str) -> list[WorkspaceRecord]:
        """Every record of the user, least recently used first."""
        ...

    async def all(self) -> list[WorkspaceRecord]:
        """Every record."""
        ...

    async def add(self, record: WorkspaceRecord) -> bool:
        """Insert `record`; False, changing nothing, when its key has one already."""
        ...

    async def touch(self, key: str, now: int) -> None:
        """Record a use of `key` at `now`; a use answers an `expired` request, which is cleared."""
        ...

    async def set_pending(self, key: str, reason: PendingReason, since: int, pending_for: str | None) -> None:
        """Mark `key` as waiting for its user's answer."""
        ...

    async def clear_pending(self, key: str, *, last_used_at: int | None = None) -> None:
        """Clear `key`'s waiting deletion, and with `last_used_at`, move its last use there."""
        ...

    async def delete(self, key: str) -> None:
        """Drop the record of `key`; a no-op when there is none."""
        ...

    async def owner_of(self, chat_id: str) -> str | None:
        """The owner of the saved chat `chat_id`, or None when it has no row."""
        ...

    async def chat_titles(self, chat_ids: list[str]) -> dict[str, str]:
        """Each existing chat's title; a chat with no row, or no title, is left out."""
        ...


def _record(row: Any) -> WorkspaceRecord:
    """A `sandbox_workspace` row as a WorkspaceRecord."""
    return WorkspaceRecord(
        key=row.key,
        user_id=row.user_id,
        chat_id=row.chat_id,
        created_at=int(row.created_at),
        last_used_at=int(row.last_used_at),
        pending_reason=row.pending_reason,
        pending_since=None if row.pending_since is None else int(row.pending_since),
        pending_for=row.pending_for_chat_id,
    )


class DatabaseWorkspaces:
    """The WorkspaceStore on the app's database: the `sandbox_workspace` table (models/sandbox.py)."""

    async def get(self, key: str) -> WorkspaceRecord | None:
        from sqlalchemy import select

        from local_llm.internal.db import get_async_db_context
        from local_llm.models.sandbox import SandboxWorkspace

        async with get_async_db_context() as db:
            row = (await db.execute(select(SandboxWorkspace).where(SandboxWorkspace.key == key))).scalars().first()
            return None if row is None else _record(row)

    async def of_user(self, user_id: str) -> list[WorkspaceRecord]:
        from sqlalchemy import select

        from local_llm.internal.db import get_async_db_context
        from local_llm.models.sandbox import SandboxWorkspace

        async with get_async_db_context() as db:
            rows = (
                await db.execute(
                    select(SandboxWorkspace)
                    .where(SandboxWorkspace.user_id == user_id)
                    .order_by(SandboxWorkspace.last_used_at, SandboxWorkspace.key)
                )
            ).scalars()
            return [_record(row) for row in rows]

    async def all(self) -> list[WorkspaceRecord]:
        from sqlalchemy import select

        from local_llm.internal.db import get_async_db_context
        from local_llm.models.sandbox import SandboxWorkspace

        async with get_async_db_context() as db:
            return [_record(row) for row in (await db.execute(select(SandboxWorkspace))).scalars()]

    async def add(self, record: WorkspaceRecord) -> bool:
        from sqlalchemy import select

        from local_llm.internal.db import get_async_db_context
        from local_llm.models.sandbox import SandboxWorkspace

        async with get_async_db_context() as db:
            # The manager adds a key only under its lock, so nothing can insert it between the check and the insert.
            if (await db.execute(select(SandboxWorkspace.key).where(SandboxWorkspace.key == record.key))).first():
                return False
            db.add(
                SandboxWorkspace(
                    key=record.key,
                    user_id=record.user_id,
                    chat_id=record.chat_id,
                    created_at=record.created_at,
                    last_used_at=record.last_used_at,
                    pending_reason=record.pending_reason,
                    pending_since=record.pending_since,
                    pending_for_chat_id=record.pending_for,
                )
            )
            await db.commit()
            return True

    async def _update(self, key: str, values: dict[str, Any], *, only_reason: str | None = None) -> None:
        from sqlalchemy import update

        from local_llm.internal.db import get_async_db_context
        from local_llm.models.sandbox import SandboxWorkspace

        statement = update(SandboxWorkspace).where(SandboxWorkspace.key == key)
        if only_reason is not None:
            statement = statement.where(SandboxWorkspace.pending_reason == only_reason)
        async with get_async_db_context() as db:
            await db.execute(statement.values(**values))
            await db.commit()

    async def touch(self, key: str, now: int) -> None:
        await self._update(key, {'last_used_at': now})
        await self._update(
            key, {'pending_reason': None, 'pending_since': None, 'pending_for_chat_id': None}, only_reason='expired'
        )

    async def set_pending(self, key: str, reason: PendingReason, since: int, pending_for: str | None) -> None:
        await self._update(key, {'pending_reason': reason, 'pending_since': since, 'pending_for_chat_id': pending_for})

    async def clear_pending(self, key: str, *, last_used_at: int | None = None) -> None:
        values: dict[str, Any] = {'pending_reason': None, 'pending_since': None, 'pending_for_chat_id': None}
        if last_used_at is not None:
            values['last_used_at'] = last_used_at
        await self._update(key, values)

    async def delete(self, key: str) -> None:
        from sqlalchemy import delete

        from local_llm.internal.db import get_async_db_context
        from local_llm.models.sandbox import SandboxWorkspace

        async with get_async_db_context() as db:
            await db.execute(delete(SandboxWorkspace).where(SandboxWorkspace.key == key))
            await db.commit()

    async def owner_of(self, chat_id: str) -> str | None:
        from sqlalchemy import select

        from local_llm.internal.db import get_async_db_context
        from local_llm.models.chats import Chat

        async with get_async_db_context() as db:
            owner = (await db.execute(select(Chat.user_id).where(Chat.id == chat_id))).scalar()
        return owner if isinstance(owner, str) and owner else None

    async def chat_titles(self, chat_ids: list[str]) -> dict[str, str]:
        if not chat_ids:
            return {}
        from sqlalchemy import select

        from local_llm.internal.db import get_async_db_context
        from local_llm.models.chats import Chat

        async with get_async_db_context() as db:
            rows = (await db.execute(select(Chat.id, Chat.title).where(Chat.id.in_(chat_ids)))).all()
        return {chat_id: title for chat_id, title in rows if isinstance(title, str) and title}


class MemoryWorkspaces:
    """An in-memory WorkspaceStore, for tests: no database, nothing kept across instances.

    Attributes:
        records: Every record, by key; a test may change it, for example to age `last_used_at`.
        owners: Each saved chat's owner; a chat not in it is owned by `default_owner` (None: it has no row).
        titles: Each chat's title.
    """

    def __init__(
        self,
        owners: Mapping[str, str] | None = None,
        *,
        default_owner: str | None = 'owner',
        titles: Mapping[str, str] | None = None,
    ) -> None:
        self.records: dict[str, WorkspaceRecord] = {}
        self.owners: dict[str, str] = dict(owners or {})
        self.default_owner = default_owner
        self.titles: dict[str, str] = dict(titles or {})

    async def get(self, key: str) -> WorkspaceRecord | None:
        return self.records.get(key)

    async def of_user(self, user_id: str) -> list[WorkspaceRecord]:
        mine = [r for r in self.records.values() if r.user_id == user_id]
        return sorted(mine, key=lambda r: (r.last_used_at, r.key))

    async def all(self) -> list[WorkspaceRecord]:
        return list(self.records.values())

    async def add(self, record: WorkspaceRecord) -> bool:
        if record.key in self.records:
            return False
        self.records[record.key] = record
        return True

    async def touch(self, key: str, now: int) -> None:
        record = self.records.get(key)
        if record is None:
            return
        record = replace(record, last_used_at=now)
        if record.pending_reason == 'expired':
            record = replace(record, pending_reason=None, pending_since=None, pending_for=None)
        self.records[key] = record

    async def set_pending(self, key: str, reason: PendingReason, since: int, pending_for: str | None) -> None:
        if key in self.records:
            self.records[key] = replace(
                self.records[key], pending_reason=reason, pending_since=since, pending_for=pending_for
            )

    async def clear_pending(self, key: str, *, last_used_at: int | None = None) -> None:
        record = self.records.get(key)
        if record is None:
            return
        record = replace(record, pending_reason=None, pending_since=None, pending_for=None)
        if last_used_at is not None:
            record = replace(record, last_used_at=last_used_at)
        self.records[key] = record

    async def delete(self, key: str) -> None:
        self.records.pop(key, None)

    async def owner_of(self, chat_id: str) -> str | None:
        return self.owners.get(chat_id, self.default_owner)

    async def chat_titles(self, chat_ids: list[str]) -> dict[str, str]:
        return {c: self.titles[c] for c in chat_ids if c in self.titles}
