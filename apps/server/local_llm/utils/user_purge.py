"""Remove a user and everything they own, for both the admin route and SCIM.

Deleting a user used to remove their group memberships, chats and user row
and nothing else: memories, files, notes, the API key, stored OAuth access and
refresh tokens and (on the SCIM path) the password hash stayed behind. This
is the one routine both delete paths call, so they cannot drift apart again.

What happens to each kind of data is a stated policy, not an accident of
which helper existed:

  Deleted, because nobody else can see or relies on it:
    sign-in credential, API key, OAuth sessions, memories (and their vector
    collection), feedback, prompt history, tags, pinned notes, chats and their
    messages and shares, folders, automations and their runs, calendar
    attendance, group and channel memberships, reactions, grants naming the
    user, notes and calendars shared with no one, and the user's files that
    nothing else references (row, stored object and vector collection).

  Reassigned to an administrator, because other users may rely on it:
    notes and calendars someone was granted, knowledge bases (with their
    directories and file links), models, prompts, skills, tools, functions,
    channels and their webhooks, groups, events in calendars the user did not
    own, and files a knowledge base or channel references.

  Kept as written: messages posted in channels, which belong to the
  conversation other members are part of; they show as a deleted user.

When no other administrator exists, what would be reassigned is deleted
instead, except files still referenced by something that survives.
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from local_llm.internal.db import get_async_db_context

log = logging.getLogger(__name__)


async def _successor_id(user_id: str, session: AsyncSession) -> str | None:
    from local_llm.models.users import User

    row = (
        await session.execute(
            select(User.id).where(User.role == 'admin', User.id != user_id).order_by(User.created_at).limit(1)
        )
    ).first()
    return row[0] if row else None


async def _shared_ids(session: AsyncSession, resource_type: str, ids: list[str], user_id: str) -> set[str]:
    """Which of these resources grant access to anyone besides their owner."""
    from local_llm.models.access_grants import AccessGrant

    if not ids:
        return set()
    rows = await session.execute(
        select(AccessGrant.resource_id).where(
            AccessGrant.resource_type == resource_type,
            AccessGrant.resource_id.in_(ids),
            ~((AccessGrant.principal_type == 'user') & (AccessGrant.principal_id == user_id)),
        )
    )
    return {r[0] for r in rows.all()}


async def purge_user(user_id: str, db: AsyncSession | None = None) -> bool:
    """Delete or reassign everything the user owns, then the user. True on success."""
    from local_llm.models.access_grants import AccessGrant
    from local_llm.models.auths import Auth
    from local_llm.models.automations import Automation, AutomationRun
    from local_llm.models.calendar import Calendar, CalendarEvent, CalendarEventAttendee
    from local_llm.models.channels import Channel, ChannelFile, ChannelMember, ChannelWebhook
    from local_llm.models.chats import Chats
    from local_llm.models.feedbacks import Feedback
    from local_llm.models.files import File
    from local_llm.models.folders import Folder
    from local_llm.models.functions import Function
    from local_llm.models.groups import Group, Groups
    from local_llm.models.knowledge import Knowledge, KnowledgeDirectory, KnowledgeFile
    from local_llm.models.memories import Memory
    from local_llm.models.messages import MessageReaction
    from local_llm.models.models import Model
    from local_llm.models.notes import Note, PinnedNote
    from local_llm.models.oauth_sessions import OAuthSession
    from local_llm.models.prompt_history import PromptHistory
    from local_llm.models.prompts import Prompt
    from local_llm.models.skills import Skill
    from local_llm.models.tags import Tag
    from local_llm.models.tools import Tool
    from local_llm.models.users import ApiKey, User

    await Groups.remove_user_from_all_groups(user_id)

    removed_files: list[tuple[str, str | None]] = []
    async with get_async_db_context(db) as session:
        if not await Chats.delete_chats_by_user_id(user_id, db=session):
            return False
        successor = await _successor_id(user_id, session)

        # Private records.
        for table in (ApiKey, OAuthSession, Memory, Feedback, PromptHistory, Tag, PinnedNote, Folder):
            await session.execute(delete(table).where(table.user_id == user_id))
        for table in (CalendarEventAttendee, ChannelMember, MessageReaction):
            await session.execute(delete(table).where(table.user_id == user_id))
        automation_ids = select(Automation.id).where(Automation.user_id == user_id)
        await session.execute(delete(AutomationRun).where(AutomationRun.automation_id.in_(automation_ids)))
        await session.execute(delete(Automation).where(Automation.user_id == user_id))
        await session.execute(
            delete(AccessGrant).where(AccessGrant.principal_type == 'user', AccessGrant.principal_id == user_id)
        )

        # Notes and calendars: deleted unless shared, then reassigned.
        note_ids = [r[0] for r in (await session.execute(select(Note.id).where(Note.user_id == user_id))).all()]
        shared_notes = await _shared_ids(session, 'note', note_ids, user_id) if successor else set()
        private_notes = [i for i in note_ids if i not in shared_notes]
        if private_notes:
            await session.execute(delete(AccessGrant).where(AccessGrant.resource_type == 'note',
                                                            AccessGrant.resource_id.in_(private_notes)))  # fmt: skip
            await session.execute(delete(Note).where(Note.id.in_(private_notes)))
        if shared_notes:
            await session.execute(update(Note).where(Note.id.in_(shared_notes)).values(user_id=successor))

        cal_ids = [r[0] for r in (await session.execute(select(Calendar.id).where(Calendar.user_id == user_id))).all()]
        shared_cals = await _shared_ids(session, 'calendar', cal_ids, user_id) if successor else set()
        private_cals = [i for i in cal_ids if i not in shared_cals]
        if private_cals:
            await session.execute(delete(CalendarEvent).where(CalendarEvent.calendar_id.in_(private_cals)))
            await session.execute(delete(AccessGrant).where(AccessGrant.resource_type == 'calendar',
                                                            AccessGrant.resource_id.in_(private_cals)))  # fmt: skip
            await session.execute(delete(Calendar).where(Calendar.id.in_(private_cals)))
        if shared_cals:
            await session.execute(update(Calendar).where(Calendar.id.in_(shared_cals)).values(user_id=successor))

        # Workspace resources and events in other calendars: reassigned, or deleted with no successor.
        reassigned = (Knowledge, KnowledgeDirectory, KnowledgeFile, Model, Prompt, Skill, Tool, Function,
                      Channel, ChannelWebhook, ChannelFile, Group, CalendarEvent)  # fmt: skip
        for table in reassigned:
            if successor:
                await session.execute(update(table).where(table.user_id == user_id).values(user_id=successor))
            else:
                await session.execute(delete(table).where(table.user_id == user_id))

        # Files: kept (reassigned) when a knowledge base or channel still references them.
        referenced = select(KnowledgeFile.file_id).union(select(ChannelFile.file_id))
        rows = await session.execute(
            select(File.id, File.path).where(File.user_id == user_id, File.id.not_in(referenced))
        )
        removed_files = [(r[0], r[1]) for r in rows.all()]
        if removed_files:
            await session.execute(delete(File).where(File.id.in_([f[0] for f in removed_files])))
        await session.execute(
            update(File).where(File.user_id == user_id).values(user_id=successor)
            if successor
            else delete(File).where(File.user_id == user_id)
        )

        await session.execute(delete(Auth).where(Auth.id == user_id))
        await session.execute(delete(User).where(User.id == user_id))
        await session.commit()

    await _remove_stored_data(user_id, removed_files)
    return True


async def _remove_stored_data(user_id: str, files: list[tuple[str, str | None]]) -> None:
    """Storage and vector cleanup, after the rows are gone. Best effort, logged."""
    try:
        from local_llm.retrieval.vector.async_client import ASYNC_VECTOR_DB_CLIENT
        from local_llm.storage.provider import Storage
    except Exception as e:  # pragma: no cover - optional backends
        log.warning('User %s: storage or vector store unavailable for cleanup: %s', user_id, e)
        return

    try:
        await ASYNC_VECTOR_DB_CLIENT.delete_collection(f'user-memory-{user_id}')
    except Exception as e:
        log.debug('User %s: no memory collection to delete: %s', user_id, e)
    for file_id, path in files:
        try:
            if path:
                await asyncio.to_thread(Storage.delete_file, path)
            await ASYNC_VECTOR_DB_CLIENT.delete(collection_name=f'file-{file_id}')
        except Exception as e:
            log.warning('User %s: could not remove stored file %s: %s', user_id, file_id, e)
