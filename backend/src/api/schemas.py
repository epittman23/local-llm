"""Pydantic request/response models for the FastAPI layer."""

from pydantic import BaseModel


class ChatStreamRequest(BaseModel):
    prompt: str
    task: str = "reasoning"
    session: str | None = None


class SessionInfo(BaseModel):
    name: str
    message_count: int
    updated_at: float


class CreateSessionRequest(BaseModel):
    name: str | None = None


class CreateSessionResponse(BaseModel):
    name: str


class SessionMessage(BaseModel):
    role: str
    content: str
