"""How one sandbox command is wrapped, how its output is capped, and how its result is read.

Every model command runs as
`/usr/bin/timeout --kill-after=5 <t> /bin/bash -lc -- <command>` in the
guest (wrap_command), so the guest's own `timeout` ends it even if the
host-side call is slow to notice. wrap_argv builds that `timeout` prefix for
any argv and require_wrapped checks it: every backend's `exec` calls
require_wrapped first, so the timeout the guest enforces and the `timeout_s`
the backend reads the result with can never disagree. Absolute paths keep a
`timeout` or `bash` the model put on `PATH` out of the prefix.

The timeout has one source of truth. The caller clamps the model's
requested value once with clamp_timeout and passes the result to both the
wrapper and `exec`. The wrappers clamp too, so a model's raw value can
never reach the guest unclamped, while require_wrapped and `exec` refuse
a value outside the range rather than clamp it again. So the guest's timeout is exactly the `timeout_s`
the backend's host-side deadline (`timeout_s + HOST_DEADLINE_SLACK_S`) and
result_from are computed from.

Each stream is capped at STREAM_CAP_CHARS characters, the first and last
halves kept, so a runaway `print` cannot fill the model's context window, and
the cap is applied as bytes arrive, so a 10 MB stream is never held in memory.

`timeout` exits 124 when the command ends after SIGTERM, and 137 when it had
to send SIGKILL after the grace period. Neither code proves a timeout on its
own: the model's own `timeout 10 ...` or `exit 124` gives 124 early, and the
guest's OOM killer gives 137, which the T02 spike saw after a few seconds. So
result_from counts either only when the command ran long enough for the
guest's `timeout` to have produced it, or when the backend's host-side
deadline fired.
"""

import codecs
import math
from collections import deque

from local_llm.sandbox.limits import (
    KILL_GRACE_S,
    MAX_COMMAND_BYTES,
    STREAM_CAP_CHARS,
    TIMEOUT_MAX_S,
    TIMEOUT_MIN_S,
)
from local_llm.sandbox.types import ExecResult

_TIMEOUT_BIN = '/usr/bin/timeout'
_BASH = ['/bin/bash', '-lc', '--']
# Bytes decoded per step by StreamCap.feed, so one huge chunk is never
# decoded into one equally huge string.
_FEED_SLICE_BYTES = 64 * 1024


def clamp_timeout(timeout_s: int) -> int:
    """Clamp a requested timeout to TIMEOUT_MIN_S..TIMEOUT_MAX_S seconds.

    The caller clamps a model's value once with this and passes the result
    to both the wrapper and `exec`, which refuses an unclamped value.

    Raises:
        TypeError: `timeout_s` is not an int (a bool or a float is refused).
    """
    if type(timeout_s) is not int:
        raise TypeError(f'timeout_s must be an int, not {type(timeout_s).__name__}')
    return max(TIMEOUT_MIN_S, min(TIMEOUT_MAX_S, timeout_s))


def _check_timeout(timeout_s: int) -> int:
    """Return `timeout_s` when it is an int within TIMEOUT_MIN_S..TIMEOUT_MAX_S, else raise; it never clamps.

    For `exec` and require_wrapped, whose caller has already clamped the
    value (clamp_timeout), so a value that differs from what the guest
    enforces is refused, not silently corrected.

    Raises:
        TypeError: `timeout_s` is not an int (a bool or a float is refused).
        ValueError: `timeout_s` is outside TIMEOUT_MIN_S..TIMEOUT_MAX_S.
    """
    if type(timeout_s) is not int:
        raise TypeError(f'timeout_s must be an int, not {type(timeout_s).__name__}')
    if not TIMEOUT_MIN_S <= timeout_s <= TIMEOUT_MAX_S:
        raise ValueError(
            f'timeout_s {timeout_s} is outside {TIMEOUT_MIN_S}..{TIMEOUT_MAX_S}; clamp it once with clamp_timeout '
            'and pass the same value to wrap_command and exec'
        )
    return timeout_s


def _prefix(timeout_s: int) -> list[str]:
    # `timeout_s` is already within range: clamped by a wrapper, or checked by require_wrapped.
    return [_TIMEOUT_BIN, f'--kill-after={KILL_GRACE_S}', str(timeout_s)]


def _check_args(argv: list[str]) -> None:
    for arg in argv:
        if not isinstance(arg, str):
            raise TypeError(f'argv elements must be str, not {type(arg).__name__}')
        if '\0' in arg:
            raise ValueError('argv elements cannot contain NUL')


def wrap_argv(argv: list[str], timeout_s: int) -> list[str]:
    """Build the argv that runs `argv` under the guest's `timeout`.

    Args:
        argv: The command and its arguments, a list of str passed on untouched.
        timeout_s: The requested timeout, clamped with clamp_timeout; pass
            the clamped value to `exec` too.

    Returns:
        `['/usr/bin/timeout', '--kill-after=5', '<t>', *argv]`.

    Raises:
        ValueError: `argv` is empty, or an element contains NUL.
        TypeError: `argv` is not a list (a str is refused, never split into
            characters), an element is not a str, or `timeout_s` is not an
            int.
    """
    if not isinstance(argv, list):
        raise TypeError(f'argv must be a list of str, not {type(argv).__name__}')
    if not argv:
        raise ValueError('argv cannot be empty')
    _check_args(argv)
    return [*_prefix(clamp_timeout(timeout_s)), *argv]


def wrap_command(command: str, timeout_s: int) -> list[str]:
    """Build the argv that runs the bash `command` under the guest's `timeout`.

    Args:
        command: The bash command, passed as one argv element: never quoted,
            split or altered here.
        timeout_s: The requested timeout, clamped with clamp_timeout; pass
            the clamped value to `exec` too.

    Returns:
        `['/usr/bin/timeout', '--kill-after=5', '<t>', '/bin/bash', '-lc', '--', command]`.

    Raises:
        ValueError: `command` contains NUL, or its UTF-8 encoding is longer
            than MAX_COMMAND_BYTES; the message says to put the script in a
            file instead.
        TypeError: `command` is not exactly a str (a subclass is refused),
            or `timeout_s` is not an int.
    """
    if type(command) is not str:
        raise TypeError(f'command must be a str, not {type(command).__name__}')
    if '\0' in command:
        raise ValueError('the command cannot contain a NUL character')
    size = len(command.encode('utf-8'))
    if size > MAX_COMMAND_BYTES:
        raise ValueError(
            f'the command is {size} bytes, over the {MAX_COMMAND_BYTES}-byte limit for one command; '
            'write the script to a file with write_file and run that file instead'
        )
    return wrap_argv([*_BASH, command], timeout_s)


def require_wrapped(argv: list[str], timeout_s: int) -> None:
    """Check that `argv` is what wrap_argv builds for `timeout_s`; every backend's `exec` calls it first.

    `timeout_s` is checked, never clamped: it must be the
    value the caller clamped once and gave the wrapper, so the guest's
    timeout is exactly `timeout_s`.

    Raises:
        ValueError: `timeout_s` is outside TIMEOUT_MIN_S..TIMEOUT_MAX_S, or
            `argv` does not start with exactly the three-element timeout
            prefix for `timeout_s`, has nothing after it, or has an element
            containing NUL.
        TypeError: An element is not a str, or `timeout_s` is not an int.
    """
    prefix = _prefix(_check_timeout(timeout_s))
    if not isinstance(argv, list) or len(argv) <= len(prefix) or argv[: len(prefix)] != prefix:
        raise ValueError(f'argv must start with {prefix!r} and name a command (build it with wrap_argv)')
    _check_args(argv)


class StreamCap:
    """A bounded collector for one output stream, fed bytes as they arrive.

    It keeps the first and last halves of `limit` characters and counts the
    rest. Bytes are decoded incrementally as UTF-8 (invalid bytes become
    U+FFFD), so a character split across chunks is kept whole, and limits
    count characters, not bytes. It never holds more than about `limit`
    characters, whatever the input size, and decodes a large chunk in
    slices of at most 64 KiB, so one huge chunk does not double peak memory.
    That bound holds only if the caller feeds chunks as they arrive: reading
    a whole output first and feeding it at once already holds all of it.
    `limit` is at least 2, so the head and the tail each keep a character.

    `render()` and `truncated` finish the stream: a trailing incomplete
    character is flushed (as one U+FFFD), and later `feed` calls raise.
    Finishing is idempotent, so either can be read first.
    """

    def __init__(self, limit: int = STREAM_CAP_CHARS) -> None:
        """Make an empty collector.

        Raises:
            ValueError: `limit` is below 2.
        """
        if limit < 2:
            raise ValueError(f'StreamCap: limit {limit} is below 2')
        self._head_limit = limit // 2
        self._tail_limit = limit - self._head_limit
        self._decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
        self._head: list[str] = []
        self._head_len = 0
        self._tail: deque[str] = deque(maxlen=self._tail_limit)
        self._dropped = 0
        self._finished = False

    def feed(self, chunk: bytes) -> None:
        """Add the next bytes of the stream.

        Raises:
            ValueError: The stream was already finished by `render()` or `truncated`.
        """
        if self._finished:
            raise ValueError('StreamCap: feed after the stream was finished')
        view = memoryview(chunk)
        for start in range(0, len(view), _FEED_SLICE_BYTES):
            self._add(self._decoder.decode(view[start : start + _FEED_SLICE_BYTES]))

    def _add(self, text: str) -> None:
        room = self._head_limit - self._head_len
        if room > 0 and text:
            self._head.append(text[:room])
            self._head_len += min(room, len(text))
            text = text[room:]
        if not text:
            return
        overflow = len(self._tail) + len(text) - self._tail_limit
        if overflow > 0:
            self._dropped += overflow
        # Only the last tail_limit characters can survive; the deque's maxlen
        # evicts the oldest of them as the new ones arrive.
        self._tail.extend(text[-self._tail_limit :])

    def _finish(self) -> None:
        if not self._finished:
            self._add(self._decoder.decode(b'', final=True))
            self._finished = True

    @property
    def truncated(self) -> bool:
        """Whether any characters were dropped. Finishes the stream."""
        self._finish()
        return self._dropped > 0

    def render(self) -> str:
        """The kept text: all of it, or `<head>\\n[... N characters truncated ...]\\n<tail>`. Finishes the stream."""
        self._finish()
        head = ''.join(self._head)
        tail = ''.join(self._tail)
        if not self._dropped:
            return head + tail
        return f'{head}\n[... {self._dropped} characters truncated ...]\n{tail}'


def result_from(
    returncode: int,
    *,
    stdout: StreamCap,
    stderr: StreamCap,
    elapsed_s: float,
    timeout_s: int,
    deadline_hit: bool = False,
) -> ExecResult:
    """Build the ExecResult of a finished command.

    With `t` the clamped `timeout_s`, `timed_out` is set when the backend's
    host-side deadline fired (`deadline_hit`), when the return code is 124
    and the command ran at least `t` (`timeout` ended it after SIGTERM), or
    when it is 137 and the command ran at least `t + KILL_GRACE_S` (the
    point at which `timeout` escalates to SIGKILL). An earlier 124 is the
    command's own (its own `timeout`, or `exit 124`), and an earlier 137 an
    ordinary kill such as the guest's OOM killer; neither is a timeout.

    Args:
        returncode: The command's exit status. When the host-side deadline
            fired and the backend ended the exec itself, whatever the
            backend reports; it should pass 124.
        stdout: The command's standard output.
        stderr: The command's standard error, a different StreamCap.
        elapsed_s: Seconds from the start of the exec to the process's exit
            as the daemon reports it (exec_inspect), not to the end of the
            streams, which a backgrounded child holding them open can
            delay. Finite and not negative.
        timeout_s: The timeout the command was wrapped with, which `exec`
            has already checked is in range; clamped here too, the same way
            wrap_argv clamps it.
        deadline_hit: The backend's deadline (`timeout_s +
            HOST_DEADLINE_SLACK_S`) fired and it ended the exec itself.

    Returns:
        The result, with both streams rendered and `truncated` set when
        either lost characters.

    Raises:
        ValueError: `stdout` and `stderr` are the same object, or
            `elapsed_s` is negative or not finite.
        TypeError: `timeout_s` is not an int.
    """
    # Checked before either stream is rendered, so a refused call leaves both unfinished.
    if stdout is stderr:
        raise ValueError('result_from: stdout and stderr must be different StreamCaps')
    if not math.isfinite(elapsed_s) or elapsed_s < 0:
        raise ValueError(f'result_from: elapsed_s {elapsed_s!r} must be finite and not negative')
    t = clamp_timeout(timeout_s)
    timed_out = (
        deadline_hit or (returncode == 124 and elapsed_s >= t) or (returncode == 137 and elapsed_s >= t + KILL_GRACE_S)
    )
    return ExecResult(
        returncode=returncode,
        stdout=stdout.render(),
        stderr=stderr.render(),
        timed_out=timed_out,
        truncated=stdout.truncated or stderr.truncated,
        duration_ms=round(elapsed_s * 1000),
    )
