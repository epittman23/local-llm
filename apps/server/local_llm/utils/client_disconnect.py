"""Stop an upstream request when the client waiting on it goes away (#614).

A chat completion that a client waits on (a direct call to
`/openai/chat/completions`, or `/api/chat/completions` without a chat, as the
Playground sends) waits for the upstream's response headers inside the
request. The app's middleware is pure ASGI, so a client that disconnects in
the meantime injects no cancellation: the backend kept waiting, and the
upstream kept working, until its headers came. A local `llama-server` then
spent the whole prompt processing on a request nobody would read.

`unless_client_leaves` races the upstream request against the client's
disconnect and cancels the request when the client goes first, which closes
its connection to the upstream.

Only a request whose client still waits on the answer may be watched. A
chat's reply runs as a background task after its HTTP request was answered,
and that request then reads as disconnected, so watching it would cancel
every reply. `watched_request` therefore returns the request only for the
route itself, or in the task that entered `client_waits()`, which the path
that answers in the request sets. Tasks that task starts (a memory review,
an event handler) inherit the context but are other tasks, and may outlive
the request, so they are not watched.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable, Iterator
from contextvars import ContextVar
from typing import Any

log = logging.getLogger(__name__)

# How often the client is checked while the upstream has not answered.
POLL_SECONDS = 0.25

# The task whose client waits on its answer, if any (see client_waits).
_client_waits: ContextVar[asyncio.Task[Any] | None] = ContextVar('client_waits', default=None)


class ClientDisconnected(Exception):
    """The client went away before the upstream answered."""


@contextlib.contextmanager
def client_waits() -> Iterator[None]:
    """Mark the requests this task makes inside as ones a client waits on in the request itself.

    Only this task: one it starts inside may outlive the request.
    """
    token = _client_waits.set(asyncio.current_task())
    try:
        yield
    finally:
        _client_waits.reset(token)


def watched_request(request: Any, endpoint: Callable[..., Any]) -> Any | None:
    """The request to watch for a disconnect, or None when no client waits on this call.

    Watched: the HTTP request of `endpoint` itself, or a call made by the task
    that entered `client_waits()`. Not watched: an internal call, such as a
    chat's reply running as a background task after its request was answered,
    or a task started inside `client_waits()`.
    """
    scope = getattr(request, 'scope', None)
    if not isinstance(scope, dict) or scope.get('type') != 'http' or not hasattr(request, 'is_disconnected'):
        return None
    waiting = _client_waits.get()
    if (waiting is not None and waiting is asyncio.current_task()) or scope.get('endpoint') is endpoint:
        return request
    return None


async def _until_disconnected(request: Any) -> None:
    while not await request.is_disconnected():
        await asyncio.sleep(POLL_SECONDS)


async def unless_client_leaves[T](request: Any | None, awaitable: Awaitable[T]) -> T:
    """Await `awaitable`, cancelling it and raising ClientDisconnected if the client of `request` leaves first.

    With no request to watch, this is a plain await.
    """
    if request is None:
        return await awaitable
    work = asyncio.ensure_future(awaitable)
    watcher = asyncio.ensure_future(_until_disconnected(request))
    try:
        await asyncio.wait({work, watcher}, return_when=asyncio.FIRST_COMPLETED)
        if not work.done() and watcher.exception() is not None:
            # The client cannot be read; wait for the upstream as before.
            log.debug('Could not watch the client for a disconnect: %r', watcher.exception())
            return await work
    except BaseException:
        work.cancel()
        raise
    finally:
        watcher.cancel()
    if work.done():
        return work.result()
    work.cancel()
    try:
        result = await work
    except asyncio.CancelledError:
        pass
    else:
        # Finished just as it was cancelled: let the response go.
        close = getattr(result, 'close', None)
        if callable(close):
            close()
    raise ClientDisconnected()
