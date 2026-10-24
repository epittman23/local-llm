"""Watch the upstream model requests and code runs that one call of the chat pipeline makes.

The benchmark harness (benchmarks/evaluation/harness.py) answers an item
through the app's chat pipeline, and nothing in the pipeline's result says
which connection answered it, what was actually sent, or how long the code
blocks ran. Inside `tracing()`, routers/openai.py notes each upstream request
(its URL and the exact body sent) and utils/code_interpreter.py notes each
code run's duration; outside it, both notes are no-ops, so ordinary chats are
untouched.

The ContextVar holds one Trace, appended to and never reassigned: asyncio
copies the context into tasks started inside the call, and a reassignment
there would never reach the caller, while an append to the shared Trace does.

`tracing(allow=...)` also stops a request before it is sent: the router
notes it first, and an URL the predicate refuses raises UpstreamRefused, so
the prompt never reaches that host.
"""

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field


class UpstreamRefused(RuntimeError):
    """An upstream request the tracing caller does not allow; raised before it is sent."""


@dataclass
class Trace:
    #: (request URL, JSON body), one per upstream request, in order; a
    #: refused one is noted too, so the caller sees where it would have gone.
    requests: list[tuple[str, str]] = field(default_factory=list)
    #: Milliseconds per code run.
    code_runs_ms: list[float] = field(default_factory=list)
    #: Code runs that failed in the code interpreter itself (Jupyter down, a
    #: refused token), as opposed to code that raised.
    code_run_failures: list[str] = field(default_factory=list)
    allow: Callable[[str], bool] | None = None


_trace: ContextVar[Trace | None] = ContextVar('upstream_trace', default=None)


@contextmanager
def tracing(allow: Callable[[str], bool] | None = None) -> Iterator[Trace]:
    trace = Trace(allow=allow)
    token = _trace.set(trace)
    try:
        yield trace
    finally:
        _trace.reset(token)


def note_request(url: str, body: str) -> None:
    trace = _trace.get()
    if trace is None:
        return
    trace.requests.append((url, body))
    if trace.allow is not None and not trace.allow(url):
        raise UpstreamRefused(f'refused to send a request to {url}')


def note_code_run(ms: float, failure: str = '') -> None:
    trace = _trace.get()
    if trace is None:
        return
    trace.code_runs_ms.append(ms)
    if failure:
        trace.code_run_failures.append(failure)
