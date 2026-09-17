"""benchmarks/serving/launcher.py - build and run a llama-server invocation.

Ported from `lllm-serve` in local-llm's scripts/shell/main.sh (lines 303-415
at the time of the port) and from `lllm-vram-log` in
scripts/shell/vram-log.sh (lines 170-238): the two were always one operation
-- the server and its telemetry recorder start and stop together -- and
splitting them across two files was a shell fact (a second script, sourced
for its profile-parsing functions), not a design this port needs to keep.

`build_argv`, `dense_partial_offload_warning`, `resolve_model_path` and
`telemetry_argv` are pure functions, tested in `tests/test_launcher.py`
without spawning anything. `ServeProcess` is the part that actually spawns
`llama-server` and the telemetry recorder; it has not been exercised against
real hardware in the session that wrote it, the same posture
docs/CLAUDE.md's 2026-09-06 decisions-log entry already takes for this
project's other unattended-GPU-run code -- starting a real server has real
side effects (VRAM, a running process, a recorded benchmark_run row) that
need standing authorization to trigger, which a porting session does not
have by default.
"""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import signal
import sys
import tempfile
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

from open_webui.benchmarks.serving.build_info import llama_server_build
from open_webui.benchmarks.serving.fingerprint import config_id, config_lines
from open_webui.benchmarks.serving.model_name import split_model
from open_webui.benchmarks.serving.profiles import ARCH_DENSE, ResolvedConfig

#: Matches main.sh:341's `${LLAMA_LOG_VERBOSITY:-4}` -- the verbosity at
#: which llama.cpp prints the model-load detail (n_layer, the GPU/CPU layer
#: split, buffer sizes, resolve_fused_ops) the telemetry recorder parses out
#: of the server log. Neither this nor --metrics changes inference, so
#: neither is part of the fingerprint (see fingerprint.py).
DEFAULT_LOG_VERBOSITY = 4

DEFAULT_HOST = '0.0.0.0'
DEFAULT_PORT = 8090


class LauncherError(RuntimeError):
    """A configuration that cannot be launched: a missing binary or weights."""


def resolve_model_path(model_path: str, *, llama_models: str | None = None) -> str:
    """Substitute the `{LLAMA_MODELS}` template a stored definition carries.

    A profile definition keeps the template rather than a resolved absolute
    path (see migration 5a1f0c3e9b27's docstring), so this is the one place
    that turns it into a real path, against *this* serving host's
    LLAMA_MODELS -- matching main.sh:50's `${LLAMA_MODELS:=$HOME/models}`.
    """
    base = llama_models or os.environ.get('LLAMA_MODELS') or str(Path.home() / 'models')
    return model_path.replace('{LLAMA_MODELS}', base)


def flash_attn_args(flash_attn: str) -> list[str]:
    """The flash-attention flag(s) for a resolved `flash_attn` value.

    `ResolvedConfig.flash_attn` is either a normal value (`'on'`, `'off'`,
    `'auto'`, passed as `-fa <value>`) or the literal string
    `'legacy --flash-attn 1'` that `resolve()` produces when
    `Overrides.flash_attn_legacy` is set -- see profiles.py's docstring and
    fingerprint.py's `fa-legacy` golden case, which is what fixes this
    contract in place.
    """
    if flash_attn.startswith('legacy '):
        return shlex.split(flash_attn.removeprefix('legacy '))
    return ['-fa', flash_attn]


def build_argv(
    config: ResolvedConfig,
    *,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    log_verbosity: int = DEFAULT_LOG_VERBOSITY,
    llama_models: str | None = None,
) -> list[str]:
    """The full `llama-server` argument list for a resolved configuration.

    Mirrors main.sh:329-357's `args` array exactly, including flag order --
    order is not fingerprinted, but keeping it identical makes this diffable
    against the shell original. `--chat-template-kwargs` for the reasoning
    budget is new relative to the shell: there it was baked into a profile's
    LLAMA_P_EXTRA at definition time (main.sh:134-135); here
    `reasoning_effort` is its own resolved field (see profiles.py), so the
    launcher builds the flag instead of the profile carrying a literal that
    would fingerprint as an override but launch as a constant.
    """
    args = [
        '-m',
        resolve_model_path(config.model_path, llama_models=llama_models),
        '-ngl',
        str(config.ngl),
        '-c',
        str(config.ctx),
        '-t',
        str(config.threads),
        '--cache-type-k',
        config.cache_k,
        '--cache-type-v',
        config.cache_v,
        '-b',
        str(config.batch),
        '--ubatch-size',
        str(config.ubatch),
        '--jinja',
        '--metrics',
        '--parallel',
        str(config.parallel),
        '-lv',
        str(log_verbosity),
        '--alias',
        config.alias,
        '--host',
        host,
        '--port',
        str(port),
    ]
    args += flash_attn_args(config.flash_attn)

    if config.moe is not None:
        args += ['--n-cpu-moe', str(config.moe)]
    if config.override_tensors:
        args += ['-ot', config.override_tensors]
    args += list(config.spec)
    args += list(config.samplers)
    if config.reasoning_effort is not None:
        kwargs = json.dumps({'reasoning_effort': config.reasoning_effort}, separators=(',', ':'))
        args += ['--chat-template-kwargs', kwargs]
    args += list(config.extra)
    return args


def dense_partial_offload_warning(config: ResolvedConfig) -> str | None:
    """main.sh:361-365's warning, or None when it does not apply.

    Scoped to a dense profile that is *partially* offloaded, same as the
    shell: at -ngl 99 there is no layer count being chosen, so the warning
    would have nothing to say.
    """
    if config.arch == ARCH_DENSE and config.ngl != 99:
        return (
            f'dense model {config.name!r}, partial offload (ngl={config.ngl}). Watch '
            "'n_layer' in the load log and confirm VRAM headroom before treating "
            '-ngl as tuned.'
        )
    return None


def percent_encode_password(password: str) -> str:
    """Percent-encode a Postgres password for interpolation into a DSN URL.

    Ported from the `jq -rn --arg v "$POSTGRES_PASSWORD" '$v|@uri'` fix in
    main.sh's `lllm-backend` / vram-log.sh's `lllm-vram-log` (see the
    2026-08-23 decisions-log entry this closes out in Python): an unescaped
    '/' or '+' -- both appear in this repo's own generated passwords --
    breaks psycopg's stricter conninfo parser, which silently dropped every
    telemetry sample on every run until that fix. `safe=''` so no character
    is left unescaped, matching `@uri`'s behaviour.
    """
    return urllib.parse.quote(password, safe='')


def build_database_url(
    password: str,
    *,
    host: str = 'localhost',
    port: int = 5432,
    database: str = 'openwebui',
    user: str = 'openwebui',
) -> str:
    """A Postgres DSN with the password percent-encoded.

    `ServeProcess` below does **not** call this: the backend process this
    launcher runs inside already has a correctly-encoded `DATABASE_URL` in
    its own environment (set once, by whatever starts uvicorn), and the
    telemetry recorder inherits it as a child process. Deriving a second
    DATABASE_URL here from a raw password would be a second place that
    encoding could be gotten wrong or drift from the first -- exactly the
    class of bug the 2026-08-23 entry above describes. This function exists
    for the one caller that legitimately has no DATABASE_URL yet: whatever
    ports `lllm-backend` itself in Phase 2c.
    """
    return f'postgresql://{user}:{percent_encode_password(password)}@{host}:{port}/{database}'


def telemetry_argv(
    config: ResolvedConfig,
    *,
    resolved_model_path: str,
    port: int,
    llama_build: str,
    server_log: str,
    interval: float = 5.0,
    wait: int = 600,
) -> list[str]:
    """The `open_webui.benchmarks.telemetry_recorder` argv for this run.

    `config_id`/`config_lines` come from fingerprint.py, `model`/`quant` from
    model_name.split_model on the resolved model path's basename -- the same
    two sources `_vramlog_config` and `_vramlog_split_model` were in the
    shell, so this cannot drift from what the server was actually launched
    with. `ngl` is passed through unconditionally: the recorder only uses it
    to derive the layer split when the server's own load log does not report
    one (see telemetry_recorder.py's `--ngl` help text).
    """
    lines = config_lines(config)
    cfg_id = config_id(config, lines)
    basename = Path(resolved_model_path).name.removesuffix('.gguf')
    model_name, quant = split_model(basename)

    argv = [
        '-m',
        'open_webui.benchmarks.telemetry_recorder',
        '--config-id',
        cfg_id,
        '--alias',
        config.alias,
        '--model',
        model_name,
        '--quant',
        quant,
        '--build',
        llama_build,
        '--port',
        str(port),
        '--ngl',
        str(config.ngl),
        '--interval',
        str(interval),
        '--wait',
        str(wait),
        '--server-log',
        server_log,
    ]
    for line in lines:
        argv += ['--config-line', line]
    return argv


@dataclass
class ServeProcess:
    """Owns one llama-server invocation and its telemetry recorder.

    Mirrors `lllm-serve` + `lllm-vram-log` together: both are started here,
    both are stopped here, and the server-log tempfile that bridges them
    (llama-server's stdout/stderr, parsed by the recorder for the model-load
    detail) is deleted only once the recorder has read it -- reordering
    that, as main.sh:412's comment notes, would race the recorder against
    its own input.

    `start_new_session=True` on both children, same reasoning as
    benchmarks/proc.py's `Command`: each owns a process group so `stop()`
    can signal the whole tree, not just the direct child.
    """

    config: ResolvedConfig
    host: str | None = None
    port: int | None = None
    llama_bin: str = ''
    log_verbosity: int = DEFAULT_LOG_VERBOSITY
    record_telemetry: bool = True

    server_proc: asyncio.subprocess.Process | None = None
    telemetry_proc: asyncio.subprocess.Process | None = None
    server_log_path: Path | None = None
    warning: str | None = None

    def __post_init__(self) -> None:
        self.llama_bin = self.llama_bin or os.environ.get('LLAMA_BIN') or str(Path.home() / 'llama.cpp/build/bin')
        self.host = self.host or os.environ.get('LLAMA_HOST') or DEFAULT_HOST
        self.port = self.port or int(os.environ.get('LLAMA_PORT') or DEFAULT_PORT)

    async def start(self) -> None:
        binary = Path(self.llama_bin) / 'llama-server'
        if not os.access(binary, os.X_OK):
            raise LauncherError(f'llama-server not found at {self.llama_bin}')

        model_path = resolve_model_path(self.config.model_path)
        if not Path(model_path).is_file():
            raise LauncherError(f'model not found: {model_path}')

        self.warning = dense_partial_offload_warning(self.config)

        argv = build_argv(self.config, host=self.host, port=self.port, log_verbosity=self.log_verbosity)

        server_log = None
        if self.record_telemetry:
            fd, path = tempfile.mkstemp(prefix='lllm-serve-', suffix='.log')
            os.close(fd)
            self.server_log_path = Path(path)
            server_log = open(self.server_log_path, 'wb')

        try:
            self.server_proc = await asyncio.create_subprocess_exec(
                str(binary),
                *argv,
                stdout=server_log if server_log else asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
            )
        finally:
            if server_log:
                server_log.close()

        if self.record_telemetry:
            build = await llama_server_build(self.llama_bin)
            tel_argv = telemetry_argv(
                self.config,
                resolved_model_path=model_path,
                port=self.port,
                llama_build=build,
                server_log=str(self.server_log_path),
            )
            if 'DATABASE_URL' not in os.environ:
                raise LauncherError('DATABASE_URL is not set; the telemetry recorder cannot connect to Postgres')

            self.telemetry_proc = await asyncio.create_subprocess_exec(
                sys.executable,
                *tel_argv,
                start_new_session=True,
            )

    def _signal(self, proc: asyncio.subprocess.Process | None, sig: int) -> bool:
        if proc is None or proc.returncode is not None:
            return False
        try:
            os.killpg(os.getpgid(proc.pid), sig)
            return True
        except (ProcessLookupError, PermissionError, OSError):
            return False

    async def stop(self, grace: float = 5.0) -> int:
        """Stop the server, then the recorder, then clean up the log file.

        Order matters: the recorder is told to stop only after the server
        has actually exited, so it has seen the server's final /metrics
        state and can close its run as 'clean' rather than 'stale'.
        """
        rc = -1
        if self.server_proc is not None:
            self._signal(self.server_proc, signal.SIGTERM)
            try:
                rc = await asyncio.wait_for(self.server_proc.wait(), timeout=grace)
            except TimeoutError:
                self._signal(self.server_proc, signal.SIGKILL)
                rc = await self.server_proc.wait()

        if self.telemetry_proc is not None:
            self._signal(self.telemetry_proc, signal.SIGTERM)
            try:
                await asyncio.wait_for(self.telemetry_proc.wait(), timeout=grace)
            except TimeoutError:
                self._signal(self.telemetry_proc, signal.SIGKILL)
                await self.telemetry_proc.wait()

        # After the recorder has read it, not before -- it is the recorder's
        # input (main.sh:411-412).
        if self.server_log_path is not None:
            self.server_log_path.unlink(missing_ok=True)

        return rc

    @property
    def running(self) -> bool:
        return self.server_proc is not None and self.server_proc.returncode is None

    async def wait(self) -> int:
        """Wait for the server to exit on its own, then tear down the recorder."""
        if self.server_proc is None:
            return -1
        rc = await self.server_proc.wait()
        await self.stop()
        return rc
