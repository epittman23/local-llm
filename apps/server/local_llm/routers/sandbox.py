from __future__ import annotations

import asyncio
import logging
import os
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
    WorkspaceBusy,
    WorkspaceChanged,
    WorkspaceNotFound,
)
from local_llm.sandbox.outputs import decode_html, is_sandbox_output, with_policy
from local_llm.sandbox.telemetry import package_report
from local_llm.sandbox.types import SandboxError, WorkspaceListing
from local_llm.sandbox.workspaces import WorkspaceRecord
from local_llm.storage.provider import Storage
from local_llm.utils.access_control.files import has_access_to_file
from local_llm.utils.auth import get_admin_user, get_verified_user

log = logging.getLogger(__name__)

router = APIRouter()

_HTML_TYPES = ('text/html', 'application/xhtml+xml')


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
