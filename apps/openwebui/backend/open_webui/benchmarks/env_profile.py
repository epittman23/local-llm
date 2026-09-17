"""benchmarks/env_profile.py - resolve the serving profile, and what's actually running.

Ported from local-llm's scripts/llama_test.py (outer repo): profile(), port()
and served_model(). Kept in its own small module rather than folded into
runner.py because it is a different kind of dependency from the rest of that
file -- a serving-profile lookup, not this app's request/grade/record logic.

Until 2026-09-14 this shelled out to scripts/llama-env.sh (via LLAMA_ENV_SH),
the outer local-llm repo's own serving-profile layer, because that script was
the single source of truth for serving configuration. It no longer is: the
profiles live in this app's own database now (models/benchmark_profiles.py),
seeded from main.sh's profile table by migration 5a1f0c3e9b27 and editable
from the Serve page (routers/benchmarks/profiles.py) -- see
docs/migration-plan.md's Phase 2. `profile()` reads a profile from there and
resolves it through benchmarks/serving/profiles.resolve(), the same function
benchmarks/serving/launcher.py uses to build a server's actual argv, so what
this module reports can never disagree with what would actually be served.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import aiohttp

from open_webui.benchmarks.serving.launcher import DEFAULT_PORT, resolve_model_path
from open_webui.benchmarks.serving.profiles import Overrides, ProfileError, ResolvedConfig, resolve
from open_webui.models.benchmark_profiles import BenchmarkProfiles

log = logging.getLogger(__name__)


async def profile_names() -> list[str]:
    """The defined, non-archived profile names, from the database.

    A database error resolves to [], the same "unrecorded"/degrade posture
    this took when the script behind it could be missing or fail -- a
    misconfigured deployment should show an empty picker, not a 500 (see
    this module's docstring on why that matters for a JSON API client).
    """
    try:
        entries = await BenchmarkProfiles.list_profiles()
    except Exception:
        log.exception('could not list serving profiles')
        return []
    return [entry.profile.name for entry in entries]


async def profile(name: str | None) -> dict:
    """Resolve a serving profile (by name, or the default) from the database.

    LLAMA_* overrides in this process's own environment are applied, the
    same as the shell original's `_lllm_profile` did -- in practice this is
    always the profile's base definition, since nothing sets those variables
    on the backend process itself; a start request's overrides
    (routers/benchmarks/serve.py) apply to the process it launches, not to
    this one.

    A failure here (no such profile, the database is unreachable, or the
    overrides don't resolve -- e.g. --parallel smuggled into a LLAMA_SPEC
    override) resolves to {}, the same "unrecorded" posture the original CLI
    took, rather than an error: a hand-started server with no profile is a
    normal, supported case.
    """
    try:
        entry = await BenchmarkProfiles.get_by_name(name) if name else await BenchmarkProfiles.get_default()
    except Exception:
        log.exception('could not look up serving profile %r', name)
        return {}
    if entry is None:
        return {}
    try:
        resolved = resolve(entry.to_serving_profile(), Overrides.from_env(os.environ))
    except ProfileError:
        log.exception('could not resolve overrides for serving profile %r', name)
        return {}
    return _to_profile_json(resolved)


def _to_profile_json(config: ResolvedConfig) -> dict:
    """The shape `lllm-profile-json` produced, field for field and (mostly)
    type for type: `benchmarks/tune_schedule.py`'s `profile_key()`/
    `Grid.violated()` and the Serve page's frontend both still read this
    dict by those exact keys, and the knob values are still strings (as
    `jq`'s `--arg` always produced) rather than the native ints `resolve()`
    itself carries, so neither caller needs to change to keep working.
    """
    model_path = resolve_model_path(config.model_path)
    return {
        'name': config.name,
        'arch': config.arch,
        'model': model_path,
        'alias': config.alias,
        'port': int(os.environ.get('LLAMA_PORT') or DEFAULT_PORT),
        'ctx': str(config.ctx),
        'threads': str(config.threads),
        'ngl': str(config.ngl),
        'moe': str(config.moe) if config.moe is not None else '',
        'parallel': str(config.parallel),
        'ot': config.override_tensors or '',
        'reasoning': config.reasoning_effort or '',
        'cache_k': config.cache_k,
        'cache_v': config.cache_v,
        'batch': str(config.batch),
        'ubatch': str(config.ubatch),
        'fa': config.flash_attn,
        'spec': list(config.spec),
        'extra': list(config.extra),
        'samplers': list(config.samplers),
        'weights_present': Path(model_path).is_file(),
    }


def port(prof: dict) -> int:
    return int(os.environ.get('LLAMA_PORT') or prof.get('port') or DEFAULT_PORT)


async def served_model(session: aiohttp.ClientSession, p: int, prof: dict) -> str:
    """What the server is actually serving, falling back to the profile alias.

    The model name is read from GET /v1/models, not taken from the profile:
    the profile says what *would* be served, and the server is already
    serving something -- trusting the profile alone previously labelled a run
    with the wrong one.
    """
    alias = prof.get('alias', '')
    try:
        async with session.get(f'http://127.0.0.1:{p}/v1/models', timeout=aiohttp.ClientTimeout(total=5)) as resp:
            data = await resp.json(content_type=None)
        served = (data.get('data') or [{}])[0].get('id', '')
    except (TimeoutError, aiohttp.ClientError, ValueError, IndexError, OSError):
        return alias
    if served and alias and served != alias:
        log.warning(
            "port %s is serving '%s', not profile '%s's '%s' - testing what is running",
            p,
            served,
            prof.get('name', '?'),
            alias,
        )
    return served or alias
