from __future__ import annotations

import asyncio
import os

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from local_llm.constants import ERROR_MESSAGES
from local_llm.internal.db import get_async_session
from local_llm.models.files import Files
from local_llm.sandbox.limits import HTML_MAX_BYTES
from local_llm.sandbox.outputs import decode_html, is_sandbox_output, with_policy
from local_llm.storage.provider import Storage
from local_llm.utils.access_control.files import has_access_to_file
from local_llm.utils.auth import get_admin_user, get_verified_user

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
