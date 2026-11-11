"""Run model-written code in one microVM per chat (docs/proposals/sandbox-code-interpreter.md).

The manager (sandbox/manager.py) is the only code that talks to a backend;
this package's root exports it and the interface it codes against. The fixed
limits are in sandbox/limits.py, and the in-memory FakeBackend for tests is
in sandbox/fake.py, deliberately not exported here.
"""

from local_llm.sandbox.backend import SandboxBackend
from local_llm.sandbox.exec import StreamCap, clamp_timeout, require_wrapped, result_from, wrap_argv, wrap_command
from local_llm.sandbox.manager import (
    SETTING_KEYS,
    ChatLookup,
    DatabaseChats,
    SandboxManager,
    SandboxRefused,
    SandboxSession,
    SandboxSettings,
    settings_from_config,
)
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
    'SETTING_KEYS',
    'ChatLookup',
    'DatabaseChats',
    'ExecResult',
    'FileEntry',
    'FileStat',
    'ImageKey',
    'SandboxBackend',
    'SandboxError',
    'SandboxInfo',
    'SandboxManager',
    'SandboxNotRunning',
    'SandboxRefused',
    'SandboxSession',
    'SandboxSettings',
    'SandboxSpec',
    'SandboxUnavailable',
    'StreamCap',
    'clamp_timeout',
    'require_wrapped',
    'result_from',
    'settings_from_config',
    'validate_chat_id',
    'volume_name',
    'wrap_argv',
    'wrap_command',
]
