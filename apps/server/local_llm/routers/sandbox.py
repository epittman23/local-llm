from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from local_llm.utils.auth import get_admin_user

router = APIRouter()


@router.get('/status')
async def get_sandbox_status(request: Request, user=Depends(get_admin_user)):
    """Whether the sandbox engine can run, and if not, why: the admin settings page shows it."""
    manager = getattr(request.app.state, 'sandbox', None)
    if manager is None:
        return {'ready': False, 'reason': 'The sandbox manager is not running'}
    reason = await manager.ready()
    return {'ready': reason is None, 'reason': reason}
