from __future__ import annotations

import asyncio
import copy
import datetime as dt
import time
from uuid import uuid4

from fastapi import Request
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select
from starlette.datastructures import Headers

from local_llm.internal.db import get_async_db
from local_llm.models.chat_messages import ChatMessages
from local_llm.models.chats import Chat, ChatForm, Chats
from local_llm.models.config import Config
from local_llm.models.users import UserModel, Users
from local_llm.tasks import create_task, has_active_tasks
from local_llm.utils.auth import create_token
from local_llm.utils.json_codec import JSONCodec
from local_llm.utils.misc import get_message_list

DEFAULT_SUBAGENT_SYSTEM_PROMPT = """You are a sub-agent working on a specific task assigned by the lead agent.

You have full access to the workspace — you can read, write, edit files, and run commands.
Focus exclusively on your assigned task. Do NOT work on anything outside your scope.

When done, end with a clear summary:
- What you did
- What files you changed (if any)
- Any issues or open questions
"""

MUTATING_MEMORY_TOOLS = {
    'add_memory',
    'delete_memory',
    'replace_memory_content',
    'update_memory',
}

_background_active: set[str] = set()
_background_lock = asyncio.Lock()
_foreground_semaphore: asyncio.Semaphore | None = None
_parent_locks: dict[str, asyncio.Lock] = {}


def _build_request(source: Request, user_id: str, *, internal: bool) -> Request:
    scope = {
        'type': 'http',
        'asgi': {'version': '3.0', 'spec_version': '2.0'},
        'method': 'POST',
        'path': '/api/v1/subagents/internal',
        'query_string': b'',
        'headers': Headers({}).raw,
        'client': ('127.0.0.1', 0),
        'server': ('127.0.0.1', 80),
        'scheme': 'http',
        'app': source.app,
    }
    request = Request(scope)
    token = create_token(
        data={'id': user_id, 'typ': 'subagent'},
        expires_delta=dt.timedelta(hours=1),
    )
    request.state.token = HTTPAuthorizationCredentials(scheme='Bearer', credentials=token)
    request.state.enable_api_keys = False
    if internal:
        request.state.internal = True
    return request


async def process_pending_internal_messages(
    source_request: Request,
    parent_chat_id: str,
    user_id: str,
    run: dict,
) -> None:
    lock = _parent_locks.setdefault(parent_chat_id, asyncio.Lock())
    while await has_active_tasks(source_request.app.state.redis, parent_chat_id):
        await asyncio.sleep(0.25)

    async with lock:
        if await has_active_tasks(source_request.app.state.redis, parent_chat_id):
            return

        user = await Users.get_user_by_id(user_id)
        if not user:
            return

        async with get_async_db() as db:
            stmt = select(Chat).where(Chat.id == parent_chat_id, Chat.user_id == user_id)
            if db.bind.dialect.name == 'postgresql':
                stmt = stmt.with_for_update()
            result = await db.execute(stmt)
            chat = result.scalar_one_or_none()
            if not chat:
                return

            history = copy.deepcopy((chat.chat or {}).get('history') or {})
            messages = history.get('messages') or {}
            pending = [
                message
                for message in messages.values()
                for meta in [message.get('meta') or {}]
                if message.get('role') == 'user'
                and not message.get('childrenIds')
                and (
                    (
                        meta.get('internal') is True
                        and meta.get('type') == 'subagent'
                        and meta.get('status') in (None, 'pending')
                    )
                    or (meta.get('internal') is True and meta.get('type') == 'timer')
                )
            ]
            if not pending:
                return

            first = pending[0]
            first_meta = first.get('meta') or {}
            kind = 'timer' if first_meta.get('internal') is True and first_meta.get('type') == 'timer' else 'subagent'
            parent_id = first.get('parentId')
            if kind == 'timer' and first_meta.get('timer_id'):
                timer = await Chats.get_chat_by_id(first_meta['timer_id'])
                run = {**run, **(((timer.meta or {}).get('run') if timer else None) or {})}
            model_id = first.get('model') or run['model_id']
            if kind == 'timer':
                batch = [first]
            else:
                batch = [
                    message
                    for message in pending
                    for meta in [message.get('meta') or {}]
                    if message.get('parentId') == parent_id
                    and (message.get('model') or model_id) == model_id
                    and (
                        meta.get('internal') is True
                        and meta.get('type') == 'subagent'
                        and meta.get('status') in (None, 'pending')
                    )
                ]
            combined_content = '\n\n'.join(message.get('content', '') for message in batch if message.get('content'))
            if kind == 'timer':
                timer_ids = [
                    message['meta']['timer_id'] for message in batch if (message.get('meta') or {}).get('timer_id')
                ]
                combined_meta = {'internal': True, 'type': 'timer'}
                if len(timer_ids) == 1:
                    combined_meta['timer_id'] = timer_ids[0]
                elif timer_ids:
                    combined_meta['timer_ids'] = timer_ids
            else:
                delegation_ids = [
                    message['meta']['delegation_id']
                    for message in batch
                    if (message.get('meta') or {}).get('delegation_id')
                ]
                subagent_chat_ids = [
                    message['meta']['subagent_chat_id']
                    for message in batch
                    if (message.get('meta') or {}).get('subagent_chat_id')
                ]
                combined_meta = {'internal': True, 'type': 'subagent'}
                if len(delegation_ids) == 1:
                    combined_meta['delegation_id'] = delegation_ids[0]
                elif delegation_ids:
                    combined_meta['delegation_ids'] = delegation_ids
                if len(subagent_chat_ids) == 1:
                    combined_meta['subagent_chat_id'] = subagent_chat_ids[0]
                elif subagent_chat_ids:
                    combined_meta['subagent_chat_ids'] = subagent_chat_ids

            reuse_message = len(batch) == 1 and (first.get('meta') or {}).get('status') != 'pending'
            user_message_id = first['id'] if reuse_message else str(uuid4())
            removed_ids = set()
            if not reuse_message:
                removed_ids = {message['id'] for message in batch}
                for message_id in removed_ids:
                    messages.pop(message_id, None)
                if parent_id and parent_id in messages:
                    messages[parent_id]['childrenIds'] = [
                        child_id
                        for child_id in messages[parent_id].get('childrenIds', [])
                        if child_id not in removed_ids
                    ]

            assistant_message_id = str(uuid4())
            message_list = get_message_list(messages, parent_id)
            system_prompt = run.get('system_prompt')
            user_message = {
                'id': user_message_id,
                'parentId': parent_id,
                'childrenIds': [assistant_message_id],
                'role': 'user',
                'content': combined_content,
                'model': model_id,
                'meta': combined_meta,
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

            if parent_id and parent_id in messages:
                parent_children = [
                    child_id for child_id in messages[parent_id].get('childrenIds', []) if child_id != user_message_id
                ]
                parent_children.append(user_message_id)
                messages[parent_id]['childrenIds'] = parent_children
            messages[user_message_id] = {**messages.get(user_message_id, {}), **user_message}
            messages[assistant_message_id] = assistant_message
            history['messages'] = messages
            history['currentId'] = assistant_message_id
            chat.chat = {**(chat.chat or {}), 'history': history}
            chat.updated_at = int(time.time())
            await db.commit()

        if removed_ids:
            await ChatMessages.delete_message_ids_by_chat_id(parent_chat_id, removed_ids)
        await ChatMessages.upsert_message(user_message_id, parent_chat_id, user_id, user_message)
        await ChatMessages.upsert_message(assistant_message_id, parent_chat_id, user_id, assistant_message)

        from local_llm.socket.main import sio

        await sio.emit(
            'events',
            {
                'chat_id': parent_chat_id,
                'message_id': assistant_message_id,
                'data': {'type': 'chat:reload'},
            },
            room=f'user:{user.id}',
        )

        form_data = {
            'model': model_id,
            'messages': [
                *([{'role': 'system', 'content': system_prompt}] if system_prompt else []),
                *message_list,
                {'role': 'user', 'content': combined_content},
            ],
            'stream': True,
            'chat_id': parent_chat_id,
            'id': assistant_message_id,
            'parent_id': parent_id,
            'user_message': user_message,
            'session_id': run.get('session_id') or f'{kind}-result:{parent_chat_id}',
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

        request = _build_request(source_request, user.id, internal=False)
        await source_request.app.state.CHAT_COMPLETION_HANDLER(request, form_data, user=user)


def _subagent_limits(config: dict) -> tuple[int, int, int, int]:
    """(max concurrent foreground, max background, max tool iterations, max output chars); -1 means unlimited."""
    max_concurrent = int(config.get('subagents.max_concurrent') or 20)
    max_async = int(config.get('subagents.max_async') or 20)
    max_iterations = int(config.get('subagents.max_iterations') or 30)
    max_output = int(config.get('subagents.max_output') or 30_000)
    if max_concurrent != -1:
        max_concurrent = max(1, max_concurrent)
    if max_async != -1:
        max_async = max(1, max_async)
    return max_concurrent, max_async, max_iterations, max_output


async def _run_settings(metadata: dict, background: bool) -> dict:
    """What the sub-agent inherits from the parent's request.

    In the background it gets no tool servers, and no code interpreter unless that runs on Jupyter.
    """
    features = copy.deepcopy(metadata.get('features') or {})
    if (
        background
        and features.get('code_interpreter')
        and await Config.get('code_interpreter.engine', 'pyodide') != 'jupyter'
    ):
        features.pop('code_interpreter')
    return {
        'model_id': metadata.get('model_id') or (metadata.get('model') or {}).get('id'),
        'session_id': metadata.get('session_id'),
        'tool_ids': copy.deepcopy(metadata.get('tool_ids') or []),
        'skill_ids': copy.deepcopy(metadata.get('skill_ids') or []),
        'system_prompt': metadata.get('system_prompt'),
        'tool_servers': [] if background else copy.deepcopy(metadata.get('tool_servers') or []),
        'filter_ids': copy.deepcopy(metadata.get('filter_ids') or []),
        'terminal_id': metadata.get('terminal_id'),
        'features': features,
        'files': copy.deepcopy(metadata.get('files') or []),
        'variables': copy.deepcopy(metadata.get('variables') or {}),
        'direct': bool(metadata.get('direct')),
    }


def _nested_file_id(file: dict):
    return file.get('file', {}).get('id') if isinstance(file.get('file'), dict) else None


def _select_files(metadata: dict, file_ids: list[str] | None) -> tuple[list, str | None]:
    """The parent's attached files the sub-agent asked for (by id, url or nested file id), or an error."""
    if not file_ids:
        return [], None
    requested_file_ids = {str(file_id) for file_id in file_ids if file_id}
    files = [
        copy.deepcopy(file)
        for file in metadata.get('files') or []
        if str(file.get('id') or '') in requested_file_ids
        or str(file.get('url') or '') in requested_file_ids
        or str(_nested_file_id(file) or '') in requested_file_ids
    ]
    found_file_ids = {
        str(value) for file in files for value in (file.get('id'), file.get('url'), _nested_file_id(file)) if value
    }
    missing_file_ids = sorted(requested_file_ids - found_file_ids)
    if missing_file_ids:
        return files, f'Error: file_ids not attached or unavailable: {", ".join(missing_file_ids)}'
    return files, None


def _message_text(message: dict) -> str:
    """A completion message's text: its content (text parts joined), else the text of its output items."""
    summary = message.get('content') or ''
    if isinstance(summary, list):
        summary = ''.join(
            str(item.get('text', '')) for item in summary if isinstance(item, dict) and item.get('type') == 'text'
        )
    if not summary:
        summary = ''.join(
            str(part.get('text', ''))
            for item in message.get('output') or []
            if item.get('type') == 'message'
            for part in item.get('content') or []
            if part.get('type') == 'output_text'
        )
    return summary


def _background_result_text(delegation_id: str, task: str, context: str, chat_id: str, result: dict, duration: str):
    """The message a finished background sub-agent leaves in its parent chat."""
    lines = [
        f'[ASYNC SUBAGENT COMPLETE - {delegation_id}]',
        (
            'A background subagent you dispatched earlier has finished. '
            'The original task source is included so you can decide whether '
            'to use the result or continue without it.'
        ),
        '',
        f'Original task: {task}',
    ]
    if context:
        lines.append(f'Context provided: {context}')
    lines.extend(
        [
            f'Subagent chat: {chat_id}',
            f'Status: {result.get("status", "completed")}   Duration: {duration}',
            '--- RESULT ---',
        ]
    )
    if result.get('status') == 'completed':
        lines.append(result.get('summary') or 'Subagent completed without a final summary.')
    else:
        if result.get('status') == 'interrupted':
            lines.append('The subagent was interrupted before completing.')
        else:
            detail = f' {result.get("error")}' if result.get('error') else ''
            lines.append(f'The subagent did not complete successfully.{detail}')
        if result.get('summary'):
            lines.extend(['Partial output:', result['summary']])
    return '\n'.join(lines)


class _SubagentRun:
    """One delegation: its slot, its sub-agent chat, and running it in the foreground or background."""

    def __init__(self, *, task, context, background, run, limits, config, request, user_data, parent_chat_id,
                 parent_message_id):  # fmt: skip
        self.task = task
        self.context = context
        self.background = background
        self.run = run
        self.max_concurrent, self.max_async, self.max_iterations, self.max_output = limits
        self.config = config
        self.request = request
        self.user_data = user_data
        self.parent_chat_id = parent_chat_id
        self.parent_message_id = parent_message_id
        self.delegation_id = f'deleg_{uuid4().hex[:8]}'
        self.foreground_semaphore = None

    async def reserve(self) -> str | None:
        """Takes a background slot or a foreground semaphore permit; an error when no background slot is free."""
        global _foreground_semaphore
        if self.background:
            async with _background_lock:
                if self.max_async != -1 and len(_background_active) >= self.max_async:
                    return (
                        f'Error: Async subagent capacity reached ({self.max_async} running). '
                        'Wait for one to finish or increase subagents.max_async.'
                    )
                _background_active.add(self.delegation_id)
        elif self.max_concurrent != -1:
            if _foreground_semaphore is None:
                _foreground_semaphore = asyncio.Semaphore(self.max_concurrent)
            self.foreground_semaphore = _foreground_semaphore
            await self.foreground_semaphore.acquire()
        return None

    async def release(self) -> None:
        if self.background:
            async with _background_lock:
                _background_active.discard(self.delegation_id)
        elif self.foreground_semaphore:
            self.foreground_semaphore.release()

    async def create_chat(self) -> str | None:
        """Creates the sub-agent's chat with its prompt; an error (with the slot released) if that fails."""
        mode = 'background' if self.background else 'foreground'
        try:
            self.user = UserModel(**self.user_data)
            self.chat_id = str(uuid4())
            self.user_message_id = str(uuid4())
            self.assistant_message_id = str(uuid4())
            self.prompt = f'{self.task}\n\n## Context\n{self.context}' if self.context else self.task
            prompt_files = copy.deepcopy(self.run.get('files') or [])
            self.user_message = {
                'id': self.user_message_id,
                'parentId': None,
                'childrenIds': [self.assistant_message_id],
                'role': 'user',
                'content': self.prompt,
                'timestamp': int(time.time()),
                'models': [self.run['model_id']],
                **({'files': prompt_files} if prompt_files else {}),
            }
            chat = await Chats.insert_new_chat(
                self.chat_id,
                self.user.id,
                ChatForm(
                    chat={
                        'id': self.chat_id,
                        'title': f'Sub-agent: {self.task[:60]}',
                        'models': [self.run['model_id']],
                        'history': {
                            'currentId': self.assistant_message_id,
                            'messages': {
                                self.user_message_id: self.user_message,
                                self.assistant_message_id: {
                                    'id': self.assistant_message_id,
                                    'parentId': self.user_message_id,
                                    'childrenIds': [],
                                    'role': 'assistant',
                                    'content': '',
                                    'done': False,
                                    'model': self.run['model_id'],
                                    'timestamp': int(time.time()),
                                },
                            },
                        },
                        'messages': [
                            {
                                'role': 'user',
                                'content': self.prompt,
                                **({'files': prompt_files} if prompt_files else {}),
                            }
                        ],
                        'files': prompt_files,
                    }
                ),
                internal_meta={
                    'internal': True,
                    'type': 'subagent',
                    'parent_chat_id': self.parent_chat_id,
                    'parent_message_id': self.parent_message_id,
                    'delegation_id': self.delegation_id,
                    'mode': mode,
                },
            )
            if not chat:
                raise RuntimeError('Failed to create sub-agent chat')
        except Exception as exc:
            await self.release()
            prefix = 'background ' if self.background else ''
            return f'Error: failed to create {prefix}sub-agent: {exc}'
        return None

    def _completion_form(self) -> dict:
        run = self.run
        parent_system_prompt = run.get('system_prompt') or ''
        subagent_system_prompt = (
            str(self.config.get('subagents.system_prompt') or '').strip() or DEFAULT_SUBAGENT_SYSTEM_PROMPT
        )
        form_data = {
            'model': run['model_id'],
            'messages': [
                {
                    'role': 'system',
                    'content': (
                        f'{parent_system_prompt}\n\n{subagent_system_prompt}'
                        if parent_system_prompt
                        else subagent_system_prompt
                    ),
                },
                {'role': 'user', 'content': self.prompt},
            ],
            'stream': True,
            'chat_id': self.chat_id,
            'id': self.assistant_message_id,
            'parent_id': None,
            'user_message': self.user_message,
            'session_id': run.get('session_id') or f'subagent:{self.chat_id}',
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
        if run.get('tool_servers'):
            form_data['tool_servers'] = run['tool_servers']
        return form_data

    async def run_reserved(self) -> dict:
        """Runs the sub-agent's completion in its slot and returns its status, summary and error."""
        try:
            child_request = _build_request(self.request, self.user.id, internal=True)
            child_request.state.max_tool_call_iterations = self.max_iterations
            await self.request.app.state.CHAT_COMPLETION_HANDLER(child_request, self._completion_form(), user=self.user)
            message = await Chats.get_message_by_id_and_message_id(self.chat_id, self.assistant_message_id)
            if not message:
                return {
                    'status': 'error',
                    'summary': '',
                    'error': 'Sub-agent chat or completion message no longer exists.',
                }
            summary = _message_text(message)
            if len(summary) > self.max_output:
                summary = f'{summary[: self.max_output]}\n\n[output truncated]'
            error = message.get('error')
            return {
                'status': 'error' if error else 'completed',
                'summary': summary or ('Sub-agent produced no output.' if not error else ''),
                'error': error,
            }
        except asyncio.CancelledError:
            await self._mark_failed('Sub-agent cancelled.')
            raise
        except Exception as exc:
            await self._mark_failed(str(exc))
            raise
        finally:
            await self.release()

    async def _mark_failed(self, content: str) -> None:
        await Chats.upsert_message_to_chat_by_id_and_message_id(
            self.chat_id,
            self.assistant_message_id,
            {'done': True, 'error': {'content': content}},
        )

    async def run_background(self) -> dict:
        """Runs the sub-agent, posts its result into the parent chat, and wakes the parent if it is idle."""
        started_at = time.time()
        cancelled = False
        try:
            result = await self.run_reserved()
        except asyncio.CancelledError:
            result = {'status': 'interrupted', 'summary': '', 'error': 'cancelled'}
            cancelled = True
        except Exception as exc:
            result = {'status': 'error', 'summary': '', 'error': str(exc)}

        duration = f'{time.time() - started_at:.1f}s'
        pending_message_id = str(uuid4())
        pending_message = {
            'id': pending_message_id,
            'parentId': None,
            'childrenIds': [],
            'role': 'user',
            'content': _background_result_text(
                self.delegation_id, self.task, self.context, self.chat_id, result, duration
            ),
            'model': self.run['model_id'],
            'meta': {
                'internal': True,
                'type': 'subagent',
                'delegation_id': self.delegation_id,
                'subagent_chat_id': self.chat_id,
            },
            'timestamp': int(time.time()),
        }

        if not await self._post_result(pending_message):
            if cancelled:
                raise asyncio.CancelledError
            return result

        if pending_message['meta'].get('status') == 'pending':
            from local_llm.socket.main import sio

            await sio.emit(
                'events',
                {
                    'chat_id': self.parent_chat_id,
                    'message_id': pending_message_id,
                    'data': {'type': 'chat:reload'},
                },
                room=f'user:{self.user.id}',
            )
        if not await has_active_tasks(self.request.app.state.redis, self.parent_chat_id):
            await process_pending_internal_messages(self.request, self.parent_chat_id, self.user.id, self.run)
        if cancelled:
            raise asyncio.CancelledError
        return result

    async def _post_result(self, pending_message: dict) -> bool:
        """Adds the result message under the parent's latest finished reply; False if the parent chat is gone.

        While the parent is still running, the message is marked pending, to be picked up when it finishes.
        """
        lock = _parent_locks.setdefault(self.parent_chat_id, asyncio.Lock())
        async with lock:
            async with get_async_db() as db:
                stmt = select(Chat).where(Chat.id == self.parent_chat_id, Chat.user_id == self.user.id)
                if db.bind.dialect.name == 'postgresql':
                    stmt = stmt.with_for_update()
                result_row = await db.execute(stmt)
                parent = result_row.scalar_one_or_none()
                if not parent:
                    return False

                updated_chat = copy.deepcopy(parent.chat or {})
                updated_history = updated_chat.setdefault('history', {})
                updated_messages = updated_history.setdefault('messages', {})
                done_assistants = [
                    message
                    for message in updated_messages.values()
                    if message.get('role') == 'assistant' and message.get('done') is not False
                ]
                result_parent_id = (
                    max(done_assistants, key=lambda message: message.get('timestamp', 0)).get('id')
                    if done_assistants
                    else self.parent_message_id
                )
                pending_message['parentId'] = result_parent_id
                if await has_active_tasks(self.request.app.state.redis, self.parent_chat_id):
                    pending_message['meta']['status'] = 'pending'
                updated_messages[pending_message['id']] = pending_message
                if result_parent_id and result_parent_id in updated_messages:
                    children = updated_messages[result_parent_id].setdefault('childrenIds', [])
                    if pending_message['id'] not in children:
                        children.append(pending_message['id'])
                updated_history['messages'] = updated_messages
                parent.chat = {**(parent.chat or {}), **updated_chat, 'history': updated_history}
                parent.updated_at = int(time.time())
                await db.commit()

            await ChatMessages.upsert_message(
                message_id=pending_message['id'],
                chat_id=self.parent_chat_id,
                user_id=self.user.id,
                data=pending_message,
            )
        return True


async def delegate(
    task: str,
    context: str,
    background: bool,
    *,
    file_ids: list[str] | None = None,
    request: Request,
    user_data: dict,
    metadata: dict,
    parent_chat_id: str,
    parent_message_id: str | None,
) -> str:
    """Runs a task in a sub-agent chat: in the foreground (returning its summary) or the background."""
    task = task.strip()
    if not task:
        return 'Error: task must not be empty.'
    if not parent_chat_id or not user_data.get('id'):
        return 'Error: chat and user context are required.'

    config = await Config.get_many(
        'subagents.background_enabled',
        'subagents.max_concurrent',
        'subagents.max_async',
        'subagents.max_iterations',
        'subagents.max_output',
        'subagents.system_prompt',
    )
    limits = _subagent_limits(config)
    if background and not config.get('subagents.background_enabled'):
        return 'Error: background sub-agents are disabled in settings.'

    run = await _run_settings(metadata, background)
    if not run.get('model_id'):
        return 'Error: model context is required.'
    if run.get('direct'):
        return 'Error: sub-agents are unavailable for direct connections.'
    run['files'], error = _select_files(metadata, file_ids)
    if error:
        return error

    subagent = _SubagentRun(
        task=task,
        context=context,
        background=background,
        run=run,
        limits=limits,
        config=config,
        request=request,
        user_data=user_data,
        parent_chat_id=parent_chat_id,
        parent_message_id=parent_message_id,
    )
    error = await subagent.reserve() or await subagent.create_chat()
    if error:
        return error

    try:
        _, child_task = await create_task(
            request.app.state.redis,
            subagent.run_background() if background else subagent.run_reserved(),
            id=subagent.chat_id,
        )
    except Exception as exc:
        await subagent.release()
        return f'Error: {exc}'

    if background:
        return JSONCodec.dumps(
            {
                'status': 'dispatched',
                'delegation_id': subagent.delegation_id,
                'subagent_chat_id': subagent.chat_id,
                'mode': 'background',
                'task': task,
            },
            ensure_ascii=False,
        )

    try:
        result = await child_task
    except asyncio.CancelledError:
        if asyncio.current_task() and asyncio.current_task().cancelling():
            raise
        return 'Error: sub-agent was cancelled.'
    except Exception as exc:
        return f'Error: {exc}'

    if result.get('status') != 'completed':
        return f'Error: {result.get("error") or "sub-agent failed."}'
    return result.get('summary') or 'Sub-agent produced no output.'
