"""Fire-and-forget asyncio tasks that cannot be garbage-collected mid-run.

The event loop holds only a weak reference to a task, so a task created by
`asyncio.create_task()` and not stored anywhere can be collected, and
silently stop, before it finishes (ruff RUF006). `run_in_background()` keeps
a strong reference until the task is done.
"""

from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from typing import Any

_running: set[asyncio.Task] = set()


def run_in_background(coro: Coroutine[Any, Any, Any]) -> asyncio.Task:
    """Schedule coro on the running loop and hold it until it finishes.

    Raises RuntimeError, as asyncio.create_task() does, when no loop is
    running. A failure is left to the loop's exception handler (logged when
    the finished task is collected) unless the caller adds a done callback.
    """
    task = asyncio.create_task(coro)
    _running.add(task)
    task.add_done_callback(_running.discard)
    return task
