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
