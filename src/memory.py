"""
Conversation memory.

Keeps a message history in memory during a session and persists it to a JSON
file, so a session can be resumed later. Each session is identified by a
name (e.g. "default", "tax-questions") and stored under sessions/.
"""

import json
from pathlib import Path

SESSIONS_DIR = Path(__file__).resolve().parent.parent / "sessions"
SESSIONS_DIR.mkdir(exist_ok=True)


class Conversation:
    def __init__(self, session: str = "default", system: str | None = None):
        self.session = session
        self.path = SESSIONS_DIR / f"{session}.json"
        self.messages: list[dict] = []

        if self.path.exists():
            self.messages = json.loads(self.path.read_text())
        elif system:
            self.messages.append({"role": "system", "content": system})

    def add(self, role: str, content: str) -> None:
        self.messages.append({"role": role, "content": content})
        self._save()

    def as_list(self) -> list[dict]:
        return list(self.messages)

    def clear(self) -> None:
        self.messages = []
        self._save()

    def _save(self) -> None:
        self.path.write_text(json.dumps(self.messages, indent=2))
