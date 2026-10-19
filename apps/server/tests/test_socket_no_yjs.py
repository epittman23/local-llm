"""The unported Yjs socket handlers are gone.

They let any signed-in user join any non-note document id, which shared a
namespace with chat and channel generations, and so cancel another user's
reply. The React frontend never used them.

Run from apps/server:

    python -m pytest tests/test_socket_no_yjs.py
"""

from __future__ import annotations

from local_llm.socket import main as socket_main


def test_no_ydoc_events_are_registered():
    events = set(socket_main.sio.handlers.get('/', {}))
    assert 'connect' in events or 'user-join' in events
    assert not [e for e in events if e.startswith('ydoc:')]
