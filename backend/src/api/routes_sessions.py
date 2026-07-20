"""Session listing/creation/history endpoints, backing the sidebar."""

import uuid

from fastapi import APIRouter, HTTPException

from src.memory import Conversation, SESSIONS_DIR, list_sessions
from src.api.schemas import (
    CreateSessionRequest,
    CreateSessionResponse,
    SessionInfo,
    SessionMessage,
)

router = APIRouter()


@router.get("/api/sessions")
def get_sessions() -> list[SessionInfo]:
    return [SessionInfo(**s) for s in list_sessions()]


@router.post("/api/sessions")
def create_session(body: CreateSessionRequest) -> CreateSessionResponse:
    name = body.name or f"web-{uuid.uuid4().hex[:8]}"
    Conversation(session=name)
    return CreateSessionResponse(name=name)


@router.get("/api/sessions/{name}/messages")
def get_session_messages(name: str) -> list[SessionMessage]:
    if not (SESSIONS_DIR / name / "messages.json").exists():
        raise HTTPException(status_code=404, detail=f"Session '{name}' not found.")
    conversation = Conversation(session=name)
    return [
        SessionMessage(role=m["role"], content=m.get("content", ""))
        for m in conversation.as_list()
        if m["role"] != "system"
    ]
