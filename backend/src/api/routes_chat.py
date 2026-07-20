"""Streaming chat endpoint, backing the web frontend's ChatModelAdapter."""

import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from src.assistant import TASK_MODELS, ask_stream
from src.memory import Conversation
from src.api.schemas import ChatStreamRequest

router = APIRouter()


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def _stream_reply(prompt: str, task: str, conversation: Conversation | None):
    try:
        for delta in ask_stream(prompt, task=task, conversation=conversation):
            yield _sse({"type": "delta", "text": delta})
    except Exception as exc:
        yield _sse({"type": "error", "message": str(exc)})
        return
    yield _sse({"type": "done"})


@router.post("/api/chat/stream")
def chat_stream(body: ChatStreamRequest) -> StreamingResponse:
    if body.task not in TASK_MODELS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown task '{body.task}'. Expected one of {list(TASK_MODELS)}.",
        )

    conversation = Conversation(session=body.session) if body.session else None

    return StreamingResponse(
        _stream_reply(body.prompt, body.task, conversation),
        media_type="text/event-stream",
    )
