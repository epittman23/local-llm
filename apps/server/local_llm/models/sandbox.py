"""The sandbox's own records (docs/guides/sandbox.md): one row per persistent workspace volume, and the package
telemetry's events.

The sandbox manager (sandbox/manager.py) writes and reads the workspaces through sandbox/workspaces.py's
DatabaseWorkspaces; nothing else should. The package telemetry (sandbox/telemetry.py, T21) appends the events, and
the admin report (GET /api/v1/sandbox/packages) reads them through SandboxPackageEvents.
"""

from collections.abc import Iterable, Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict
from sqlalchemy import BigInteger, CheckConstraint, Column, Index, Integer, Text, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from local_llm.internal.db import Base, get_async_db_context

#: Why a workspace waits for its user's answer before it may be deleted (owner decision Q15).
PENDING_REASONS = ('cap', 'expired')


class SandboxWorkspace(Base):
    """A saved chat's persistent workspace volume, and whether its deletion waits for the user's answer.

    The row is written when the manager creates the volume (or finds one
    without a row), so it survives restarts; it goes with the volume.

    Columns:
        key: The backend key the volume is named after (for a saved chat, its id).
        user_id: Whose workspace it is: the chat's owner, whoever ran the code.
        chat_id: The chat it belongs to.
        created_at, last_used_at: Epoch seconds; the manager moves `last_used_at` at the end of every session.
        pending_reason: None, or why it waits to be deleted: `cap` (the user is at the workspace limit and
            another chat needs one) or `expired` (unused for the retention days).
        pending_since: When it started waiting, epoch seconds.
        pending_for_chat_id: For `cap`, the chat whose new workspace waits for room.
    """

    __tablename__ = 'sandbox_workspace'
    __table_args__ = (
        CheckConstraint(
            "pending_reason IS NULL OR pending_reason IN ('cap', 'expired')", name='ck_sandbox_workspace_pending'
        ),
    )

    key = Column(Text, primary_key=True)
    user_id = Column(Text, nullable=False, index=True)
    chat_id = Column(Text, nullable=False)
    created_at = Column(BigInteger, nullable=False)
    last_used_at = Column(BigInteger, nullable=False)
    pending_reason = Column(Text, nullable=True)
    pending_since = Column(BigInteger, nullable=True)
    pending_for_chat_id = Column(Text, nullable=True)


####################
# Sandbox package telemetry (T21)
#
# One row per event: a Python distribution imported or an R namespace loaded
# by a process in a sandbox (the images' sitecustomize.py and Rprofile.site),
# a wheel downloaded from the pip mirror, or a miss (a module, a package, a
# command or a LaTeX file that was not there). Raw events are kept, not
# counts, so a report computed wrongly can be recomputed from the same rows.
####################

#: Kinds of use: a Python distribution imported, an R namespace loaded, a wheel installed from the mirror.
USE_KINDS = ('import', 'r_import', 'install')
#: Kinds of miss: an uncaught ModuleNotFoundError, pip's "No matching distribution found for", bash's
#: "command not found", LaTeX's "File `...' not found", and R's "there is no package called".
MISS_KINDS = ('module_miss', 'pip_miss', 'command_miss', 'latex_miss', 'r_miss')


class SandboxPackageEvent(Base):
    """One package telemetry event from a sandbox.

    Columns:
        event_id: Its row number.
        ts: When it happened, epoch seconds (the guest's time for an import, checked to be plausible; the
            collection's otherwise).
        chat_id: The chat whose sandbox it came from (an unsaved chat's own id for an ephemeral sandbox).
        kind: One of USE_KINDS or MISS_KINDS.
        name: The distribution (PEP 503 normalised), R namespace, module, command or file.
        version: The version, for an import or an install; None otherwise.
        image_digest: The id of the image the sandbox ran ('' when the backend had not seen it).
        lock_sha: SHA-256 of infra/sandbox/requirements.lock when it was recorded ('' when unreadable).
        harness_run_id: The benchmark harness's suite run id for a harness run's events; None for a chat's.
    """

    __tablename__ = 'sandbox_package_events'
    __table_args__ = (Index('ix_sandbox_package_events_name_kind', 'name', 'kind'),)

    event_id = Column(Integer, primary_key=True, autoincrement=True)
    ts = Column(BigInteger, nullable=False)
    chat_id = Column(Text, nullable=False)
    kind = Column(Text, nullable=False)
    name = Column(Text, nullable=False)
    version = Column(Text, nullable=True)
    image_digest = Column(Text, nullable=False)
    lock_sha = Column(Text, nullable=False)
    harness_run_id = Column(Text, nullable=True)


class SandboxPackageEventModel(BaseModel):
    event_id: int
    ts: int
    chat_id: str
    kind: str
    name: str
    version: str | None = None
    image_digest: str
    lock_sha: str
    harness_run_id: str | None = None

    model_config = ConfigDict(from_attributes=True)


_COLUMNS = ('ts', 'chat_id', 'kind', 'name', 'version', 'image_digest', 'lock_sha', 'harness_run_id')


class SandboxPackageEventsTable:
    async def add_events(self, events: Iterable[Mapping[str, Any]], db: AsyncSession | None = None) -> int:
        """Insert the events (each a mapping of the columns but `event_id`) in one transaction; how many."""
        rows = [SandboxPackageEvent(**{name: event.get(name) for name in _COLUMNS}) for event in events]
        if not rows:
            return 0
        async with get_async_db_context(db) as db:
            db.add_all(rows)
            await db.commit()
        return len(rows)

    async def get_events(self, chat_id: str, db: AsyncSession | None = None) -> list[SandboxPackageEventModel]:
        """Every event of one chat, oldest first."""
        async with get_async_db_context(db) as db:
            result = await db.execute(
                select(SandboxPackageEvent)
                .where(SandboxPackageEvent.chat_id == chat_id)
                .order_by(SandboxPackageEvent.ts, SandboxPackageEvent.event_id)
            )
            return [SandboxPackageEventModel.model_validate(row) for row in result.scalars()]

    async def uses(
        self, *, include_harness: bool = False, limit: int = 500, db: AsyncSession | None = None
    ) -> list[dict[str, Any]]:
        """Per package (language and name): distinct chats, imports, installs and last use, most chats first.

        A Python distribution's imports and installs count together (`python`); an R namespace is `r`. Harness
        rows (harness_run_id set) are left out unless `include_harness`.
        """
        event = SandboxPackageEvent
        language = case((event.kind == 'r_import', 'r'), else_='python').label('language')
        chats = func.count(func.distinct(event.chat_id)).label('chats')
        imports = func.sum(case((event.kind.in_(('import', 'r_import')), 1), else_=0)).label('imports')
        installs = func.sum(case((event.kind == 'install', 1), else_=0)).label('installs')
        last_used = func.max(event.ts).label('last_used')
        query = select(language, event.name, chats, imports, installs, last_used).where(event.kind.in_(USE_KINDS))
        if not include_harness:
            query = query.where(event.harness_run_id.is_(None))
        query = (
            query.group_by(language, event.name)
            .order_by(chats.desc(), imports.desc(), last_used.desc(), event.name)
            .limit(limit)
        )
        async with get_async_db_context(db) as db:
            rows = (await db.execute(query)).all()
        return [
            {
                'language': row.language,
                'name': row.name,
                'chats': int(row.chats),
                'imports': int(row.imports or 0),
                'installs': int(row.installs or 0),
                'last_used': int(row.last_used),
            }
            for row in rows
        ]

    async def misses(
        self, *, include_harness: bool = False, limit: int = 500, db: AsyncSession | None = None
    ) -> list[dict[str, Any]]:
        """Per miss (kind and name): distinct chats, events and last seen, most chats first (the review queue)."""
        event = SandboxPackageEvent
        chats = func.count(func.distinct(event.chat_id)).label('chats')
        events = func.count().label('events')
        last_seen = func.max(event.ts).label('last_seen')
        query = select(event.kind, event.name, chats, events, last_seen).where(event.kind.in_(MISS_KINDS))
        if not include_harness:
            query = query.where(event.harness_run_id.is_(None))
        query = (
            query.group_by(event.kind, event.name)
            .order_by(chats.desc(), events.desc(), last_seen.desc(), event.kind, event.name)
            .limit(limit)
        )
        async with get_async_db_context(db) as db:
            rows = (await db.execute(query)).all()
        return [
            {
                'kind': row.kind,
                'name': row.name,
                'chats': int(row.chats),
                'events': int(row.events),
                'last_seen': int(row.last_seen),
            }
            for row in rows
        ]


SandboxPackageEvents = SandboxPackageEventsTable()
