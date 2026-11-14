from __future__ import annotations

import logging

import black
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel
from starlette.responses import FileResponse

from local_llm.config import ENABLE_ADMIN_EXPORT
from local_llm.constants import ERROR_MESSAGES
from local_llm.models.chats import ChatTitleMessagesForm
from local_llm.models.config import Config
from local_llm.utils.access_control import has_permission
from local_llm.utils.auth import get_admin_user, get_verified_user
from local_llm.utils.misc import get_gravatar_url
from local_llm.utils.pdf_generator import PDFGenerator

log = logging.getLogger(__name__)

router = APIRouter()


@router.get('/gravatar')
async def get_gravatar(email: str, user=Depends(get_verified_user)):
    return get_gravatar_url(email)


class CodeForm(BaseModel):
    code: str
    # The chat whose sandbox runs the code: required by /code/execute (400 without it), ignored by /code/format.
    chat_id: str | None = None


@router.post('/code/format')
async def format_code(form_data: CodeForm, user=Depends(get_admin_user)):
    try:
        formatted_code = black.format_str(form_data.code, mode=black.Mode())
        return {'code': formatted_code}
    except black.NothingChanged:
        return {'code': form_data.code}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post('/code/execute')
async def execute_code(request: Request, form_data: CodeForm, user=Depends(get_verified_user)):
    if not await Config.get('code_execution.enable'):
        raise HTTPException(
            status_code=403,
            detail=ERROR_MESSAGES.FEATURE_DISABLED('Code execution'),
        )

    # Only the sandbox runs code; any other stored value, such as a removed engine's until T43's migration rewrites
    # it, is refused.
    if await Config.get('code_execution.engine') == 'sandbox':
        return await _execute_in_sandbox(request, form_data, user)
    raise HTTPException(
        status_code=400,
        detail=ERROR_MESSAGES.DEFAULT('Code execution engine not supported'),
    )


async def _execute_in_sandbox(request: Request, form_data: CodeForm, user) -> dict:
    """Run a code block's Python in its chat's sandbox, as the tag path does (owner decisions Q2, Q25).

    The chat must be one the user may run code in (Q14): a saved chat its
    owner's, or an admin's while ENABLE_ADMIN_CHAT_ACCESS is on; any other is
    a 404, the same answer as for a chat that does not exist. The user must
    also hold the `features.code_interpreter` permission (admins always do),
    since the run reaches the chat's persistent workspace that the code
    interpreter uses (Q26); without it the answer is 403, as it is while the
    code interpreter is switched off for everyone (Q29). An unsaved
    chat's sandbox is the user's own (Q12). The outputs are stored and
    counted in the chat's cap, returned under `files` for the block to show,
    and linked to no message (Q25). The chat's attachments are not synced:
    this route does not know them, so /workspace/uploads stays as the chat's
    last call left it.
    """
    from local_llm.models.chats import Chats, admin_reaches_other_chats
    from local_llm.tools.builtin import run_code_in_sandbox
    from local_llm.utils.chat_id import is_saved_chat_id

    if not await Config.get('code_interpreter.enable'):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail='Code interpreter is disabled')
    if user.role != 'admin' and not await has_permission(
        user.id, 'features.code_interpreter', await Config.get('user.permissions')
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=ERROR_MESSAGES.ACCESS_PROHIBITED)
    chat_id = form_data.chat_id
    if not chat_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail='Running code in the sandbox needs the chat it belongs to (chat_id)',
        )
    if is_saved_chat_id(chat_id):
        chat = await Chats.get_chat_by_id(chat_id)
        if chat is None or (chat.user_id != user.id and not admin_reaches_other_chats(user)):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ERROR_MESSAGES.NOT_FOUND)
    run = await run_code_in_sandbox(
        form_data.code,
        request=request,
        user=user.model_dump(),
        chat_id=chat_id,
        message_id=None,
        metadata={'chat_id': chat_id},
        sync=False,
    )
    return run


class ChatForm(BaseModel):
    title: str
    messages: list[dict]


@router.post('/pdf')
async def download_chat_as_pdf(form_data: ChatTitleMessagesForm, user=Depends(get_verified_user)):
    try:
        pdf_bytes = PDFGenerator(form_data).generate_chat_pdf()

        return Response(
            content=pdf_bytes,
            media_type='application/pdf',
            headers={'Content-Disposition': 'attachment;filename=chat.pdf'},
        )
    except Exception as e:
        log.exception(f'Error generating PDF: {e}')
        raise HTTPException(status_code=400, detail=str(e))


@router.get('/db/download')
async def download_db(user=Depends(get_admin_user)):
    """Download the raw SQLite database file (admin-only, SQLite deployments only)."""
    if not ENABLE_ADMIN_EXPORT:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=ERROR_MESSAGES.ACCESS_PROHIBITED)

    # Lazy import avoids circular dependency at module load time
    from local_llm.internal.db import engine

    if engine.name != 'sqlite':
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=ERROR_MESSAGES.DB_NOT_SQLITE)

    return FileResponse(
        str(engine.url.database),
        media_type='application/octet-stream',
        filename='webui.db',
    )
