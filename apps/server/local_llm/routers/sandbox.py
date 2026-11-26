from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import AsyncExitStack
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession

from local_llm.constants import ERROR_MESSAGES
from local_llm.internal.db import get_async_session
from local_llm.models.files import Files
from local_llm.sandbox.limits import HTML_MAX_BYTES
from local_llm.sandbox.manager import (
    ListingBusy,
    SandboxManager,
    SandboxRefused,
    WorkspaceBusy,
    WorkspaceChanged,
    WorkspaceNotFound,
)
from local_llm.sandbox.outputs import (
    WRITE_BACK_MAX_BYTES,
    OutputChanged,
    decode_html,
    is_sandbox_output,
    output_path,
    with_policy,
    write_back,
)
from local_llm.sandbox.telemetry import package_report
from local_llm.sandbox.types import SandboxError, WorkspaceListing
from local_llm.sandbox.workspace import WorkspaceError
from local_llm.sandbox.workspaces import WorkspaceRecord
from local_llm.storage.provider import Storage
from local_llm.utils.access_control.files import has_access_to_file
from local_llm.utils.auth import get_admin_user, get_verified_user
from local_llm.utils.chat_id import is_saved_chat_id

log = logging.getLogger(__name__)

router = APIRouter()

_HTML_TYPES = ('text/html', 'application/xhtml+xml')
#: How long a write back waits for the chat's sandbox (the lock a running `bash` holds, or a start) before it
#: answers 409 `busy`.
WRITE_BACK_WAIT_S = 20.0
_NOT_TEXT_TYPES = ('image/', 'audio/', 'video/', 'application/pdf')


@router.get('/status')
async def get_sandbox_status(request: Request, user=Depends(get_admin_user)):
    """Whether the sandbox engine can run, and if not, why: the admin settings page shows it."""
    manager = getattr(request.app.state, 'sandbox', None)
    if manager is None:
        return {'ready': False, 'reason': 'The sandbox manager is not running'}
    reason = await manager.ready()
    return {'ready': reason is None, 'reason': reason}


@router.get('/packages')
async def get_package_report(
    include_harness: bool = False,
    limit: int = Query(500, ge=1, le=5000),
    user=Depends(get_verified_user),
):
    """The package telemetry's report (sandbox/telemetry.py, T21), for admins.

    `packages`: per Python distribution or R namespace, the distinct users
    and chats using it, its imports and installs (each counted once per
    call), its last use (epoch seconds) and its source (`image`,
    `wheelhouse` or `other`, by infra/sandbox's image-freeze lists and
    requirements.lock), most users first. `misses`: per kind and name, the
    distinct users and chats that met it, its events and when it was last
    seen, most users first: the review queue for the allowlist and the
    images, a request signal rather than a vetting of the package. Harness
    runs are left out unless `include_harness`. At most `limit` rows of
    each. 403 for a signed-in user who is not an admin; 503 when the events
    cannot be read.
    """
    if user.role != 'admin':
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=ERROR_MESSAGES.ACCESS_PROHIBITED)
    try:
        return await package_report(include_harness=include_harness, limit=limit)
    except Exception:
        log.exception('could not build the sandbox package report')
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail='The package report is unavailable')


def _read_capped(path: str) -> bytes | None:
    """The file's bytes, or None when it is over HTML_MAX_BYTES; read at most one byte past the cap."""
    with open(path, 'rb') as handle:
        data = handle.read(HTML_MAX_BYTES + 1)
    return None if len(data) > HTML_MAX_BYTES else data


@router.get('/outputs/{id}/html')
async def get_sandbox_output_html(
    id: str, user=Depends(get_verified_user), db: AsyncSession = Depends(get_async_session)
):
    """An HTML sandbox output as JSON `{"html": ...}`, its policy (sandbox/outputs.py, with_policy) inserted first.

    JSON, so it never renders on the app's origin; the frontend shows it as
    the `srcdoc` of an iframe sandboxed to `allow-scripts`. The same access
    rule as the file content routes; 404 for a file that is not a sandbox
    output or not HTML, and 413 over HTML_MAX_BYTES.
    """
    file = await Files.get_file_by_id(id, db=db)
    allowed = file is not None and (
        file.user_id == user.id or user.role == 'admin' or await has_access_to_file(id, 'read', user, db=db)
    )
    if file is None or not allowed or not is_sandbox_output(file.meta) or not file.path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ERROR_MESSAGES.NOT_FOUND)
    meta = file.meta or {}
    name = str(meta.get('name') or file.filename).lower()
    if meta.get('content_type') not in _HTML_TYPES and not name.endswith(('.html', '.htm', '.xhtml')):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ERROR_MESSAGES.NOT_FOUND)
    local = await asyncio.to_thread(Storage.get_file, file.path)
    if not await asyncio.to_thread(os.path.isfile, local):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ERROR_MESSAGES.NOT_FOUND)
    data = await asyncio.to_thread(_read_capped, local)
    if data is None:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f'The document is over the {HTML_MAX_BYTES // (1024 * 1024)} MiB limit for showing it',
        )
    return JSONResponse({'html': with_policy(decode_html(data))}, headers={'X-Content-Type-Options': 'nosniff'})


class WriteBackForm(BaseModel):
    """`force` replaces the workspace file although it changed since this output last held it; nothing else is read."""

    model_config = ConfigDict(extra='forbid')

    force: bool = False


def _read_version(path: str) -> bytes:
    """The stored version's bytes, at most WRITE_BACK_MAX_BYTES plus one."""
    with open(path, 'rb') as handle:
        return handle.read(WRITE_BACK_MAX_BYTES + 1)


@router.post('/outputs/{id}/write-back')
async def write_back_sandbox_output(
    request: Request,
    id: str,
    form_data: WriteBackForm,
    user=Depends(get_verified_user),
    db: AsyncSession = Depends(get_async_session),
):
    """Write the saved version `id` (or the output itself) over its own file in the chat's sandbox workspace.

    Only the owner may: another user, an admin and a grantee get the same
    404 as a missing file. `id` may be an output's root or one of its
    versions; the path is the root's `meta.sandbox_path`, set by the server,
    and the content is the stored version, never anything in the request.
    The sandbox is started if it is stopped (the manager's admission and slot
    rules apply). Unless `force`, the file in the workspace must be one this
    document held (the root's or a version's content), else 409
    `{"code": "changed", "missing": <bool>}`; a sandbox that
    stays busy (a running `bash` holds it) for WRITE_BACK_WAIT_S is 409
    `{"code": "busy"}`. Returns `{"path", "bytes"}`, the path relative to
    /workspace. 404: not the owner's, not a sandbox output with a recorded
    path, a temporary chat; 400: not UTF-8 text; 413: over 256 KiB; 503: the
    sandbox could not write it (public text only).
    """
    not_found = HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ERROR_MESSAGES.NOT_FOUND)
    manager = _manager(request)
    if manager is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail='The sandbox is not running')
    file = await Files.get_file_by_id(id, db=db)
    if file is None or file.user_id != user.id:
        raise not_found
    root_id = (file.meta or {}).get('version_of') or file.id
    root = file if root_id == file.id else await Files.get_file_by_id(root_id, db=db)
    if root is None or root.user_id != user.id or not is_sandbox_output(root.meta) or not file.path:
        raise not_found
    meta = root.meta or {}
    chat_id = meta.get('chat_id')
    path = output_path(meta)
    if path is None or type(chat_id) is not str or not is_saved_chat_id(chat_id):
        raise not_found
    not_text = HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST, detail='Only a text file can be saved to the workspace'
    )
    if str(meta.get('content_type') or '').startswith(_NOT_TEXT_TYPES):
        raise not_text
    local = await asyncio.to_thread(Storage.get_file, file.path)
    if not await asyncio.to_thread(os.path.isfile, local):
        raise not_found
    data = await asyncio.to_thread(_read_version, local)
    if len(data) > WRITE_BACK_MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f'A file can be saved to the workspace up to {WRITE_BACK_MAX_BYTES // 1024} KiB',
        )
    try:
        data.decode('utf-8')
    except UnicodeDecodeError:
        raise not_text from None
    if not data or b'\0' in data:
        raise not_text
    try:
        async with AsyncExitStack() as stack:
            try:
                session = await asyncio.wait_for(
                    stack.enter_async_context(manager.session(chat_id, user)), WRITE_BACK_WAIT_S
                )
            except TimeoutError:
                return JSONResponse(
                    status_code=status.HTTP_409_CONFLICT,
                    content={
                        'code': 'busy',
                        'detail': 'The workspace is busy. Try again when the reply has finished.',
                    },
                )
            await write_back(session, root, path, data, file.id, force=form_data.force)
            await _mark_written_back(file.id, path, db)
    except OutputChanged as exc:
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={
                'code': 'changed',
                'missing': exc.missing,
                'detail': 'The file in the workspace changed after this version. Replace it anyway?',
            },
        )
    except SandboxRefused:
        raise not_found from None
    except (SandboxError, WorkspaceError) as exc:
        log.warning('could not write file %s back for user %s: %s', file.id, user.id, exc)
        public = exc.public if isinstance(exc, SandboxError) else None
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=public or 'The file could not be written to the workspace',
        ) from None
    log.info('wrote file %s back into the workspace for user %s', file.id, user.id)
    return {'path': path.removeprefix('/workspace/'), 'bytes': len(data)}


async def _mark_written_back(file_id: str, path: str, db: AsyncSession) -> None:
    """Record on the version row that it is the workspace file's content now, so the next listing of the outputs
    sees a row with that hash as the file's last (outputs.chat_usage); the write stands when this fails."""
    try:
        # update_file_metadata_by_id answers None, rather than raising, for a row it could not update.
        marked = await Files.update_file_metadata_by_id(
            file_id, {'sandbox_path': path, 'written_back_ns': time.time_ns()}, db=db
        )
    except Exception:
        log.warning('could not record that file %s was written back', file_id, exc_info=True)
        return
    if marked is None:
        log.warning('could not record that file %s was written back', file_id)


# The workspace cap and deletion dialog (owner decision Q15, T24). Every route acts only on the caller's own
# workspaces: the records are read by the caller's id, so another user's workspace is the same 404 as a missing one.


_UNREADABLE = 'The workspaces could not be read'


def _manager(request: Request) -> SandboxManager | None:
    return getattr(request.app.state, 'sandbox', None)


def _contents(listing: WorkspaceListing) -> dict[str, Any]:
    return {
        'files': [
            {'path': e.path, 'size': e.size, 'mtime': e.mtime, 'truncated': e.truncated} for e in listing.entries
        ],
        'file_count': listing.files,
        'total_bytes': listing.bytes,
        'complete': listing.complete,
    }


async def _listed(manager: SandboxManager, record: WorkspaceRecord) -> tuple[dict[str, Any] | None, str | None]:
    """The workspace's contents for the dialog, or None and why not; an error's details are only logged."""
    key = record.key
    try:
        listing = await manager.workspace_contents(key, record.last_used_at)
    except (SandboxError, ValueError):
        log.warning('could not list workspace %s for its deletion dialog', key, exc_info=True)
        return None, 'The contents could not be listed.'
    if listing is None:
        return None, 'The workspace has no files left on disk.'
    return _contents(listing), None


async def _records(manager: SandboxManager, user_id: str) -> list[WorkspaceRecord]:
    try:
        return await manager.workspaces_of(user_id)
    except Exception:
        log.exception('could not read the workspace records of user %s', user_id)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=_UNREADABLE) from None


@router.get('/pending/ids')
async def get_pending_workspace_ids(request: Request, user=Depends(get_verified_user)):
    """The ids of the caller's workspaces that wait for an answer: one cheap query, polled after each reply."""
    manager = _manager(request)
    if manager is None:
        return {'ids': []}
    return {'ids': [r.key for r in await _records(manager, user.id) if r.pending_reason is not None]}


@router.get('/pending')
async def get_pending_workspaces(request: Request, user=Depends(get_verified_user)):
    """The caller's workspaces that wait for an answer, each with its contents, for the deletion dialog.

    For a `cap` request, also the caller's other workspaces, any of which the
    user may remove instead. Listing a stopped workspace may start a helper
    VM per workspace (SandboxManager.workspace_contents), so a stopped
    workspace's listing is kept until its next use, and each user runs one
    of these at a time: a second while the first runs is 429. 503 when the
    records, the settings or the chat titles cannot be read.
    """
    manager = _manager(request)
    if manager is None:
        return {'pending': [], 'max_workspaces': None, 'retention_days': None}
    try:
        async with manager.pending_listing(user.id):
            return await _pending(manager, user.id)
    except ListingBusy:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail='The workspaces are being listed already'
        ) from None


async def _pending(manager: SandboxManager, user_id: str) -> dict[str, Any]:
    records = await _records(manager, user_id)
    waiting = [r for r in records if r.pending_reason is not None]
    chats = {r.chat_id for r in records} | {r.pending_for for r in waiting if r.pending_for}
    try:
        settings = await manager.current_settings()
        titles = await manager.chat_titles(sorted(chats)) if waiting else {}
    except Exception:
        log.exception('could not read the settings or chat titles for user %s', user_id)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=_UNREADABLE) from None
    listings = await asyncio.gather(*(_listed(manager, r) for r in waiting))
    pending = []
    for record, (contents, error) in zip(waiting, listings, strict=True):
        item: dict[str, Any] = {
            'id': record.key,
            'chat_id': record.chat_id,
            'chat_title': titles.get(record.chat_id),
            'reason': record.pending_reason,
            'since': record.pending_since,
            'created_at': record.created_at,
            'last_used_at': record.last_used_at,
            'contents': contents,
            'contents_error': error,
        }
        if record.pending_reason == 'cap':
            item['waiting_chat_id'] = record.pending_for
            item['waiting_chat_title'] = titles.get(record.pending_for or '')
            item['workspaces'] = [
                {
                    'id': other.key,
                    'chat_id': other.chat_id,
                    'chat_title': titles.get(other.chat_id),
                    'last_used_at': other.last_used_at,
                }
                for other in records
                if other.key != record.key
            ]
        pending.append(item)
    return {'pending': pending, 'max_workspaces': settings.max_workspaces, 'retention_days': settings.retention_days}


class PendingAnswer(BaseModel):
    """The user's answer: `remove` or `keep`; for a `cap` request, `remove` may name another workspace to delete."""

    model_config = ConfigDict(extra='forbid')

    action: Literal['remove', 'keep']
    workspace: str | None = None
    #: The request's `since` as the dialog showed it; a request changed since then is not answered (409).
    since: int


@router.post('/pending/{id}')
async def answer_pending_workspace(
    request: Request, id: str, form_data: PendingAnswer, user=Depends(get_verified_user)
):
    """Remove or keep the caller's workspace `id` that waits for an answer (SandboxManager.answer_pending).

    404 when `id` (or `workspace`) is not one of the caller's waiting workspaces, another user's included; 400
    for an answer that does not fit the request; 409 while the workspace to remove is running code, or when the
    request is no longer the one shown (`since`); 502 when the backend could not remove it, which then stays, or
    its record could not be dropped; 503 when the records cannot be read or written.
    """
    manager = _manager(request)
    if manager is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail='The sandbox is not running')
    try:
        await manager.answer_pending(user.id, id, form_data.action, form_data.workspace, form_data.since)
    except WorkspaceNotFound:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ERROR_MESSAGES.NOT_FOUND) from None
    except WorkspaceBusy:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The workspace's chat is running code; try again once its reply has finished",
        ) from None
    except WorkspaceChanged:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail='This request changed since it was shown (answered or replaced); look at the list again',
        ) from None
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from None
    except SandboxError:
        log.exception('could not remove a workspace for user %s', user.id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail='The workspace could not be removed; try again'
        ) from None
    except Exception:
        log.exception('could not read or change the workspace records of user %s', user.id)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=_UNREADABLE) from None
    return {'ok': True}
