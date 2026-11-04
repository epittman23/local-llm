"""Durable one-shot timers backed by internal child chats."""

from __future__ import annotations

import asyncio
import copy
import datetime as dt
import logging
import re
import time
from typing import Literal, cast
from uuid import uuid4

from fastapi import Request
from sqlalchemy import select, update
from starlette.datastructures import Headers

from local_llm.internal.db import get_async_db
from local_llm.models.chat_messages import ChatMessages
from local_llm.models.chats import Chat, ChatForm, Chats
from local_llm.models.users import UserModel, Users
from local_llm.tasks import has_active_tasks
from local_llm.utils.json_codec import JSONCodec
from local_llm.utils.misc import get_message_list

log = logging.getLogger(__name__)

_RELATIVE_TIME = re.compile(r'^(?:\+|in\s+)?(\d+)\s*(s|sec(?:onds?)?|m|min(?:utes?)?|h|hours?|d|days?)$')
_RFC3339_TIME = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$')
_TIME_UNITS_NS = {
    's': 1_000_000_000,
    'm': 60 * 1_000_000_000,
    'h': 60 * 60 * 1_000_000_000,
    'd': 24 * 60 * 60 * 1_000_000_000,
}
_timer_locks: dict[str, asyncio.Lock] = {}


def parse_timer_at(value: str) -> int:
    """Normalize a relative offset or timezone-aware RFC 3339 timestamp."""
    raw = value.strip()
    now = time.time_ns()
    relative = _RELATIVE_TIME.fullmatch(raw.lower())
    if relative:
        count = int(relative.group(1))
        if count <= 0:
            raise ValueError('at must be in the future.')
        return now + count * _TIME_UNITS_NS[relative.group(2)[0]]

    if not _RFC3339_TIME.fullmatch(raw):
        raise ValueError(
            'at must be a relative time such as 10s or in 10 seconds, or an RFC 3339 timestamp with a timezone.'
        )
    try:
        parsed = dt.datetime.fromisoformat(raw.replace('Z', '+00:00'))
    except ValueError as exc:
        raise ValueError(
            'at must be a relative time such as 10s or in 10 seconds, or an RFC 3339 timestamp with a timezone.'
        ) from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError('absolute at values must include an explicit timezone.')

    due_at = int(parsed.timestamp() * 1_000_000_000)
    if due_at <= now:
        raise ValueError('at must be in the future.')
    return due_at


async def create_timer(
    *,
    prompt: str,
    at: str,
    cancel_on: list[Literal['chat.read', 'chat.user_message']] | None,
    request: Request,
    user_data: dict,
    metadata: dict,
    parent_chat_id: str,
    parent_message_id: str | None,
) -> str:
    prompt = prompt.strip()
    if not prompt:
        return 'Error: prompt must not be empty.'
    if not parent_chat_id or not user_data.get('id'):
        return 'Error: chat and user context are required.'

    try:
        due_at = parse_timer_at(at)
    except ValueError as exc:
        return f'Error: {exc}'

    selected_events = cancel_on or []
    allowed_events = {'chat.read', 'chat.user_message'}
    if any(event not in allowed_events for event in selected_events):
        return 'Error: cancel_on accepts only chat.read and chat.user_message.'
    selected_events = list(dict.fromkeys(selected_events))

    model_id = metadata.get('model_id') or (metadata.get('model') or {}).get('id')
    if not model_id:
        return 'Error: model context is required.'
    if metadata.get('direct'):
        return 'Error: timers are unavailable for direct connections.'

    chat_id = str(uuid4())
    user_message_id = str(uuid4())
    user = UserModel(**user_data)
    run = {
        'model_id': model_id,
        'session_id': metadata.get('session_id'),
        'tool_ids': copy.deepcopy(metadata.get('tool_ids') or []),
        'skill_ids': copy.deepcopy(metadata.get('skill_ids') or []),
        'system_prompt': metadata.get('system_prompt'),
        'filter_ids': copy.deepcopy(metadata.get('filter_ids') or []),
        'terminal_id': metadata.get('terminal_id'),
        'features': copy.deepcopy(metadata.get('features') or {}),
        'files': copy.deepcopy(metadata.get('files') or []),
        'variables': copy.deepcopy(metadata.get('variables') or {}),
    }

    chat = await Chats.insert_new_chat(
        chat_id,
        user.id,
        ChatForm(
            chat={
                'id': chat_id,
                'title': f'Timer: {prompt[:60]}',
                'models': [model_id],
                'history': {
                    'currentId': user_message_id,
                    'messages': {
                        user_message_id: {
                            'id': user_message_id,
                            'parentId': None,
                            'childrenIds': [],
                            'role': 'user',
                            'content': prompt,
                            'timestamp': int(time.time()),
                            'models': [model_id],
                        },
                    },
                },
                'messages': [{'role': 'user', 'content': prompt}],
            }
        ),
        internal_meta={
            'internal': True,
            'type': 'timer',
            'parent_chat_id': parent_chat_id,
            'parent_message_id': parent_message_id,
            'timer_at': due_at,
            'status': 'pending',
            'timer_model_id': model_id,
            'timer_task_message_id': user_message_id,
            'cancel_on': selected_events,
            'run': run,
        },
        timer_at=due_at,
    )
    if not chat:
        return 'Error: failed to create timer.'

    return JSONCodec.dumps(
        {
            'status': 'set',
            'at': dt.datetime.fromtimestamp(due_at / 1_000_000_000, dt.UTC).isoformat().replace('+00:00', 'Z'),
            'cancel_on': selected_events,
        },
        ensure_ascii=False,
    )


async def claim_due_timers(now_ns: int, limit: int = 10) -> list[tuple[str, str]]:
    """Claim due timers by moving them from pending to running."""
    async with get_async_db() as db:
        stmt = (
            select(Chat)
            .where(Chat.timer_at <= now_ns)
            .where(Chat.meta['status'].as_string() == 'pending')
            .order_by(Chat.timer_at)
            .limit(limit)
        )
        if db.bind.dialect.name == 'postgresql':
            stmt = stmt.with_for_update(skip_locked=True)

        result = await db.execute(stmt)

        claimed = []
        for row in result.scalars().all():
            claim_id = str(uuid4())
            row.meta = {
                **(row.meta or {}),
                'status': 'running',
                'timer_started_at': now_ns,
                'timer_claim_id': claim_id,
            }
            row.timer_at = None
            row.updated_at = int(time.time())
            claimed.append((row.id, claim_id))
        await db.commit()
        return claimed


async def cancel_timers_for_chat(
    parent_chat_id: str, event: Literal['chat.read', 'chat.user_message'], user_id: str
) -> None:
    """Owner-scoped: without the user filter, reading a chat cancels every user's timers on it."""
    async with get_async_db() as db:
        result = await db.execute(
            select(Chat)
            .where(Chat.timer_at.isnot(None))
            .where(Chat.user_id == user_id)
            .where(Chat.meta['parent_chat_id'].as_string() == parent_chat_id)
            .where(Chat.meta['status'].as_string() == 'pending')
        )
        now_ns = int(time.time_ns())
        for row in result.scalars().all():
            meta = row.meta or {}
            if event not in (meta.get('cancel_on') or []):
                continue
            row.meta = {
                **meta,
                'status': 'cancelled',
                'timer_cancelled_at': now_ns,
                'timer_cancelled_by': event,
            }
            row.timer_at = None
            row.updated_at = int(time.time())
        await db.commit()


# Longer than a run takes to write its messages and become completed: a timer
# still running after this was left by a restart, or by an error that could
# not be recorded (#270).
STALE_RUNNING_NS = 10 * 60 * 1_000_000_000


async def recover_stale_timers(now_ns: int) -> list[str]:
    """Put timers left running back to pending, due again at their own time.

    A timer is completed in the same commit that writes its messages, so one
    still running has posted nothing yet. Only internal timer chats are
    looked at: an imported or other chat can carry any meta.
    """
    async with get_async_db() as db:
        stmt = (
            select(Chat)
            .where(Chat.meta['type'].as_string() == 'timer')
            .where(Chat.meta['internal'].as_boolean().is_(True))
            .where(Chat.meta['status'].as_string() == 'running')
        )
        if db.get_bind().dialect.name == 'postgresql':
            stmt = stmt.with_for_update(skip_locked=True)
        result = await db.execute(stmt)
        recovered: list[str] = []
        for row in result.scalars().all():
            meta = cast(dict, row.meta or {})
            started = meta.get('timer_started_at')
            if isinstance(started, int) and now_ns - started < STALE_RUNNING_NS:
                continue
            due = meta.get('timer_at')
            await db.execute(
                update(Chat)
                .where(Chat.id == row.id)
                .values(
                    meta={**meta, 'status': 'pending', 'timer_claim_id': None, 'timer_started_at': None},
                    timer_at=due if isinstance(due, int) else now_ns,
                    updated_at=int(time.time()),
                )
            )
            recovered.append(str(row.id))
        await db.commit()
    if recovered:
        log.warning('Timers left running put back to pending: %s', ', '.join(recovered))
    return recovered


async def execute_due_timer(app, timer_id: str, claim_id: str | None = None) -> None:
    """Run a claimed timer; an error marks it failed, rather than leaving it running (#270)."""
    try:
        await _execute_due_timer(app, timer_id, claim_id)
    except Exception as exc:
        log.exception('Timer %s failed', timer_id)
        try:
            await _record_timer_error(timer_id, claim_id, str(exc)[:500])
        except Exception:
            log.exception('Timer %s: its error could not be recorded', timer_id)


async def _record_timer_error(timer_id: str, claim_id: str | None, error: str) -> None:
    """Mark the timer failed, unless it has been claimed again since (a run that outlived recovery)."""
    async with get_async_db() as db:
        row = await db.get(Chat, timer_id)
        if not row:
            return
        meta = cast(dict, row.meta or {})
        if claim_id is not None and meta.get('timer_claim_id') not in (claim_id, None):
            log.warning("Timer %s: claimed again since, so this run's error is not recorded", timer_id)
            return
        await db.execute(
            update(Chat)
            .where(Chat.id == timer_id)
            .values(meta={**meta, 'status': 'error', 'timer_error': error}, updated_at=int(time.time()))
        )
        await db.commit()


async def _execute_due_timer(app, timer_id: str, claim_id: str | None) -> None:
    lock = _timer_locks.setdefault(timer_id, asyncio.Lock())
    async with lock:
        from local_llm.socket.main import sio
        from local_llm.utils.subagents import _parent_locks

        timer = await Chats.get_chat_by_id(timer_id)
        if not timer:
            return
        meta = timer.meta or {}
        if meta.get('status') != 'running':
            return
        if claim_id is not None and meta.get('timer_claim_id') != claim_id:
            return

        parent_chat_id = meta.get('parent_chat_id') or ''
        parent = await Chats.get_chat_by_id_and_user_id(parent_chat_id, timer.user_id)
        if not parent:
            await _set_timer_state(timer_id, 'error', timer_error='parent chat no longer exists')
            return

        prompt_message_id = meta.get('timer_task_message_id')
        prompt_message = await Chats.get_message_by_id_and_message_id(timer_id, prompt_message_id)
        if not prompt_message:
            await _set_timer_state(timer_id, 'error', timer_error='timer task message is missing')
            return

        user = await Users.get_user_by_id(timer.user_id)
        if not user:
            await _set_timer_state(timer_id, 'error', timer_error='timer user no longer exists')
            return

        run = meta.get('run') or {}
        model_id = run.get('model_id') or meta.get('timer_model_id')
        if not model_id:
            await _set_timer_state(timer_id, 'error', timer_error='model context is missing')
            return

        prompt = prompt_message.get('content') or ''
        if isinstance(prompt, list):
            prompt = ''.join(
                str(part.get('text', '')) for part in prompt if isinstance(part, dict) and part.get('type') == 'text'
            )

        user_message_id = str(uuid4())
        assistant_message_id = str(uuid4())
        user_message = None
        assistant_message = None
        message_list = []
        parent_lock = _parent_locks.setdefault(parent_chat_id, asyncio.Lock())
        async with parent_lock:
            async with get_async_db() as db:
                stmt = select(Chat).where(Chat.id == parent_chat_id, Chat.user_id == timer.user_id)
                if db.bind.dialect.name == 'postgresql':
                    stmt = stmt.with_for_update()
                result = await db.execute(stmt)
                parent = result.scalar_one_or_none()
                if not parent:
                    await _set_timer_state(timer_id, 'error', timer_error='parent chat no longer exists')
                    return
                if await has_active_tasks(app.state.redis, parent_chat_id):
                    timer_row = await db.get(Chat, timer_id)
                    if timer_row:
                        timer_meta = timer_row.meta or {}
                        timer_row.meta = {
                            **timer_meta,
                            'status': 'pending',
                            'timer_claim_id': None,
                            'timer_started_at': None,
                        }
                        timer_row.timer_at = timer_meta.get('timer_at')
                        timer_row.updated_at = int(time.time())
                    await db.commit()
                    return

                parent_chat = copy.deepcopy(parent.chat or {})
                history = parent_chat.setdefault('history', {})
                messages = history.setdefault('messages', {})
                done_assistants = [
                    message
                    for message in messages.values()
                    if message.get('role') == 'assistant' and message.get('done') is not False
                ]
                parent_id = (
                    max(done_assistants, key=lambda message: message.get('timestamp', 0)).get('id')
                    if done_assistants
                    else meta.get('parent_message_id')
                )
                message_list = get_message_list(messages, parent_id)

                user_message = {
                    'id': user_message_id,
                    'parentId': parent_id,
                    'childrenIds': [assistant_message_id],
                    'role': 'user',
                    'content': prompt,
                    'model': model_id,
                    'meta': {'internal': True, 'type': 'timer', 'timer_id': timer_id},
                    'timestamp': int(time.time()),
                }
                assistant_message = {
                    'id': assistant_message_id,
                    'parentId': user_message_id,
                    'childrenIds': [],
                    'role': 'assistant',
                    'content': '',
                    'done': False,
                    'model': model_id,
                    'timestamp': int(time.time()),
                }
                messages[user_message_id] = user_message
                messages[assistant_message_id] = assistant_message
                if parent_id and parent_id in messages:
                    children = messages[parent_id].setdefault('childrenIds', [])
                    if user_message_id not in children:
                        children.append(user_message_id)

                parent.chat = parent_chat
                history['currentId'] = assistant_message_id
                parent.updated_at = int(time.time())
                timer_row = await db.get(Chat, timer_id)
                if timer_row:
                    timer_row.meta = {
                        **(timer_row.meta or {}),
                        'status': 'completed',
                        'timer_completed_at': int(time.time_ns()),
                    }
                    timer_row.updated_at = int(time.time())
                await db.commit()
            await ChatMessages.upsert_message(user_message_id, parent_chat_id, timer.user_id, user_message)
            await ChatMessages.upsert_message(assistant_message_id, parent_chat_id, timer.user_id, assistant_message)

        await sio.emit(
            'events',
            {
                'chat_id': parent_chat_id,
                'message_id': assistant_message_id,
                'data': {'type': 'chat:reload'},
            },
            room=f'user:{timer.user_id}',
        )
        form_data = {
            'model': model_id,
            'messages': [
                *([{'role': 'system', 'content': run.get('system_prompt')}] if run.get('system_prompt') else []),
                *message_list,
                {'role': 'user', 'content': prompt},
            ],
            'stream': True,
            'chat_id': parent_chat_id,
            'id': assistant_message_id,
            'parent_id': user_message.get('parentId'),
            'user_message': user_message,
            'session_id': run.get('session_id') or f'timer:{parent_chat_id}',
            'background_tasks': {},
            'tool_ids': run.get('tool_ids') or [],
            'skill_ids': run.get('skill_ids') or [],
            'filter_ids': run.get('filter_ids') or [],
            'features': run.get('features') or {},
            'files': run.get('files') or [],
            'variables': run.get('variables') or {},
        }
        if run.get('terminal_id'):
            form_data['terminal_id'] = run['terminal_id']
        request = Request(
            {
                'type': 'http',
                'asgi': {'version': '3.0', 'spec_version': '2.0'},
                'method': 'POST',
                'path': '/api/v1/timers/internal',
                'query_string': b'',
                'headers': Headers({}).raw,
                'client': ('127.0.0.1', 0),
                'server': ('127.0.0.1', 80),
                'scheme': 'http',
                'app': app,
            }
        )
        request.state.token = None
        request.state.enable_api_keys = False
        try:
            await app.state.CHAT_COMPLETION_HANDLER(request, form_data, user=user)
        except Exception as exc:
            log.exception(f'Timer {timer_id} completion failed')
            await _set_timer_state(timer_id, 'error', timer_error=str(exc)[:500])


async def _set_timer_state(timer_id: str, status: str, **fields) -> None:
    async with get_async_db() as db:
        row = await db.get(Chat, timer_id)
        if not row:
            return
        row.meta = {**(row.meta or {}), 'status': status, **fields}
        row.updated_at = int(time.time())
        await db.commit()
