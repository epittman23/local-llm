"""benchmarks/serving/fingerprint.py - the serving-configuration fingerprint.

Ported from `_vramlog_config` in local-llm's scripts/shell/vram-log.sh (lines
122-153 at the time of the port).

**This module's output is load-bearing in a way that fails silently.** Every
row in the benchmark_* tables is keyed by `config_id`, and
`benchmarks/stats.py:parse_config_text` parses the six lines below back into
the typed columns beside it. Change a separator, a default spelling, or the
order of a field, and nothing raises: the same serving configuration is simply
filed under a new id from then on, and every historical measurement stops
comparing against every new one. The Compare and Report pages go on answering,
with the wrong answer.

`docs/serving-baseline/fingerprints.json` in the repo root holds 24 captures
taken from the shell implementation before it was retired, including four
cases that are expected to *collide* with another case. The test in
backend/tests/test_serving_fingerprint.py checks this module against all of
them. Do not change anything here without re-running it.

Two things are deliberately excluded from the hash, and both exclusions are
load-bearing:

  The llama.cpp build string, so that a rebuild does not fragment a
  configuration's history into before and after.

  --metrics and -lv, which change what the server reports about itself but not
  what it computes. They are passed on every run (the telemetry recorder
  scrapes /metrics, and -lv 4 is what makes llama.cpp print the model-load
  detail the run's load-info row records) but they are not part of what makes
  a configuration a configuration.

What a test actually sent, and what the server's load log said, are likewise
observations of a *run* rather than settings, so they are recorded against the
run and not fingerprinted -- otherwise a run that served no request would be a
different configuration from one that did.
"""

from __future__ import annotations

import hashlib

from open_webui.benchmarks.serving.profiles import ResolvedConfig

#: What an unset field renders as. A literal, not a formatting accident: the
#: parser on the other side reads it back, so it has to stay exactly this.
UNSET = 'n/a'

#: Rendered when a profile passes no sampler flags at all, i.e. the server's
#: own defaults govern.
DEFAULT_SAMPLERS = 'llama.cpp defaults'

#: Length of the truncated sha1. Every config_id ever recorded is this wide.
CONFIG_ID_LENGTH = 8


def _format_samplers(samplers: tuple[str, ...]) -> str:
    """`--temp 1.0 --top-p 0.95` -> `temp 1.0 | top-p 0.95`.

    Flags are consumed in pairs with the leading dashes stripped. A trailing
    flag with no value renders with an empty value rather than being dropped,
    matching the shell's `${LLAMA_P_SAMPLERS[i+1]:-}`: a malformed sampler list
    should be visible in the config text, not silently tidied away.
    """
    if not samplers:
        return DEFAULT_SAMPLERS

    parts = []
    for i in range(0, len(samplers), 2):
        flag = samplers[i].removeprefix('--')
        value = samplers[i + 1] if i + 1 < len(samplers) else ''
        parts.append(f'{flag} {value}')
    return ' | '.join(parts)


def config_lines(config: ResolvedConfig) -> list[str]:
    """The six human-readable configuration lines that the id is hashed over.

    These are stored verbatim in benchmark_config.config_text, because that
    text is what the hash covers.
    """
    return [
        (
            f'arch: {config.arch} | ngl: {config.ngl} | ctx: {config.ctx} (total) | '
            f'parallel: {config.parallel} | threads: {config.threads} | '
            f'moe: {config.moe if config.moe is not None else UNSET}'
        ),
        f'override-tensors: {config.override_tensors or UNSET}',
        f'speculative: {" ".join(config.spec) if config.spec else "off"}',
        (
            f'cache: k={config.cache_k} v={config.cache_v} | fa: {config.flash_attn} | '
            f'batch: {config.batch} | ubatch: {config.ubatch}'
        ),
        f'reasoning effort: {config.reasoning_effort or UNSET}',
        f'samplers: {_format_samplers(config.samplers)}',
    ]


def config_id(config: ResolvedConfig, lines: list[str] | None = None) -> str:
    """The 8-character fingerprint: sha1 over the alias followed by the six lines.

    Every value is newline-terminated, including the last -- the shell built
    this with `printf '%s\\n' "$alias" "${lines[@]}" | sha1sum`, which appends a
    newline after each argument. A missing trailing newline changes the digest.

    The alias is hashed but is not one of the six lines: it identifies *what*
    is being served, while the lines describe how.
    """
    lines = config_lines(config) if lines is None else lines
    payload = ''.join(f'{value}\n' for value in [config.alias, *lines])
    return hashlib.sha1(payload.encode()).hexdigest()[:CONFIG_ID_LENGTH]
