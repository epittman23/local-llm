"""Run model-written code in one microVM per chat (docs/proposals/sandbox-code-interpreter.md).

The manager (T11) is the only code that talks to a backend; this package's
root exports the interface it codes against. The fixed limits are in
sandbox/limits.py, and the in-memory FakeBackend for tests is in
sandbox/fake.py, deliberately not exported here.
"""

from local_llm.sandbox.backend import SandboxBackend
from local_llm.sandbox.exec import StreamCap, clamp_timeout, require_wrapped, result_from, wrap_argv, wrap_command
from local_llm.sandbox.types import (
    ExecResult,
    FileEntry,
    FileStat,
    ImageKey,
    SandboxError,
    SandboxInfo,
    SandboxNotRunning,
    SandboxSpec,
    SandboxUnavailable,
    validate_chat_id,
    volume_name,
)

__all__ = [
    'ExecResult',
    'FileEntry',
    'FileStat',
    'ImageKey',
    'SandboxBackend',
    'SandboxError',
    'SandboxInfo',
    'SandboxNotRunning',
    'SandboxSpec',
    'SandboxUnavailable',
    'StreamCap',
    'clamp_timeout',
    'require_wrapped',
    'result_from',
    'validate_chat_id',
    'volume_name',
    'wrap_argv',
    'wrap_command',
]
