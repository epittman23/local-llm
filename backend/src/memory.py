"""
Conversation memory.

Keeps a message history in memory during a session and persists it to disk,
so a session can be resumed later. Each session is identified by a name
(e.g. "default", "tax-questions") and gets its own folder under sessions/,
containing the raw message log (messages.json) and a human-readable
transcript (transcript.md).
"""

import json
from pathlib import Path
from openai.types.chat.chat_completion_message_param import ChatCompletionMessageParam
from typing import Iterable, Literal, cast

SESSIONS_DIR = Path(__file__).resolve().parent.parent / "sessions"
SESSIONS_DIR.mkdir(exist_ok=True)

ROLE_LABELS = {"system": "System", "user": "User", "assistant": "Assistant"}


class Conversation:
    def __init__(self, session: str = "default", system: str | None = None):
        self.session = session
        self.dir = SESSIONS_DIR / session
        self.dir.mkdir(parents=True, exist_ok=True)
        self.json_path = self.dir / "messages.json"
        self.md_path = self.dir / "transcript.md"
        self.messages: list[ChatCompletionMessageParam] = []

        if self.json_path.exists():
            self.messages = json.loads(self.json_path.read_text())
        elif system:
            self.messages.append({"role": "system", "content": system})

    def add(self, role: Literal["system", "user", "assistant"], content: str) -> None:
        self.messages.append(cast(ChatCompletionMessageParam, {"role": role, "content": content}))
        self._save()

    def as_list(
        self,
    ) -> Iterable[ChatCompletionMessageParam]:
        return list(self.messages)

    def clear(self) -> None:
        self.messages = []
        self._save()

    def _save(self) -> None:
        self.json_path.write_text(json.dumps(self.messages, indent=2))
        self.md_path.write_text(self._render_markdown())

    def _render_markdown(self) -> str:
        lines = [f"# {self.session}", ""]
        for message in self.messages:
            role = cast(str, message["role"])
            lines.append(f"## {ROLE_LABELS.get(role, role.title())}")
            lines.append("")
            lines.append(cast(str, message.get("content", "")))
            lines.append("")
        return "\n".join(lines)


def list_sessions() -> list[dict]:
    """
    List all saved sessions under SESSIONS_DIR, most recently updated first.

    Returns:
        A list of {"name", "message_count", "updated_at"} dicts, one per
        session. message_count excludes the injected system prompt so it
        reflects actual conversation turns. updated_at is a Unix timestamp
        taken from messages.json's mtime.
    """
    sessions = []
    for session_dir in SESSIONS_DIR.iterdir():
        json_path = session_dir / "messages.json"
        if not session_dir.is_dir() or not json_path.exists():
            continue
        messages = json.loads(json_path.read_text())
        turn_count = sum(1 for m in messages if m.get("role") != "system")
        sessions.append({
            "name": session_dir.name,
            "message_count": turn_count,
            "updated_at": json_path.stat().st_mtime,
        })
    sessions.sort(key=lambda s: s["updated_at"], reverse=True)
    return sessions
