"""Watch the upstream model requests and code runs that one call of the chat pipeline makes.

The benchmark harness (benchmarks/evaluation/harness.py) answers an item
through the app's chat pipeline, and nothing in the pipeline's result says
which connection answered it, what was actually sent, or how long the code
blocks ran. Inside `tracing()`, routers/openai.py notes each upstream request
(its URL and the exact body sent) and utils/code_interpreter.py notes each
code run's duration; outside it, both notes are no-ops, so ordinary chats are
untouched.

The ContextVars hold lists, appended to and never reassigned: asyncio copies
the context into tasks started inside the call, and a reassignment there
would never reach the caller, while an append to the shared list does.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field

_requests: ContextVar[list | None] = ContextVar('upstream_requests', default=None)
_code_runs: ContextVar[list | None] = ContextVar('code_run_ms', default=None)


@dataclass
class Trace:
    #: (request URL, JSON body sent), one per upstream request, in order.
    requests: list[tuple[str, str]] = field(default_factory=list)
    #: Milliseconds per code run.
    code_runs_ms: list[float] = field(default_factory=list)


@contextmanager
def tracing() -> Iterator[Trace]:
    trace = Trace()
    requests_token = _requests.set(trace.requests)
    runs_token = _code_runs.set(trace.code_runs_ms)
    try:
        yield trace
    finally:
        _requests.reset(requests_token)
        _code_runs.reset(runs_token)


def note_request(url: str, body: str) -> None:
    requests = _requests.get()
    if requests is not None:
        requests.append((url, body))


def note_code_run(ms: float) -> None:
    runs = _code_runs.get()
    if runs is not None:
        runs.append(ms)
