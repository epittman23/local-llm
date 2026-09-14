"""benchmarks/serving/profiles.py - serving profile shape and override resolution.

Ported from `_lllm_profile` in local-llm's scripts/shell/main.sh (lines 80-246
at the time of the port). The profile table itself is not here: profiles live
in Postgres now, and a row is read into a `ServingProfile`. This module owns
the *shape* and the resolution rules, so that the fingerprint and the launcher
have one place to agree on what a configuration actually is.

Two things from the shell are preserved verbatim because they were paid for in
measurement rather than reasoning:

  --parallel is always passed explicitly, never left to llama.cpp. Omitting it
  is not "the default 1": llama-server defaults it to -1 = auto, and auto means
  4 slots *and* kv_unified = true (build 10597: common/arg.cpp:1400,
  tools/server/server.cpp:152-155). A spec-off run without it would serve a
  different attention/KV configuration than the speculative run it is supposed
  to be the baseline for -- measured on this hardware as 15.63 t/s prefill at
  n_slots=4 against 26.38 t/s at n_slots=1.

  --n-cpu-moe is meaningful only for mixture-of-experts models, so a dense
  profile must never carry it. The shell dropped it with a warning rather than
  failing; `resolve` does the same, for the same reason: a dense profile that
  somehow acquires an MoE value should still serve.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

log = logging.getLogger(__name__)

ARCH_DENSE = 'dense'
ARCH_MOE = 'moe'

#: Defaults matching the `: "${LLAMA_P_*:=...}"` block in main.sh:199-207. These
#: are profile fields rather than literals in the launcher so that the flags
#: actually passed and the flags recorded in the fingerprint come from one
#: place and cannot drift apart.
DEFAULT_PARALLEL = 1
DEFAULT_CACHE_K = 'q8_0'
DEFAULT_CACHE_V = 'q8_0'
DEFAULT_BATCH = 512
DEFAULT_UBATCH = 512
DEFAULT_FLASH_ATTN = 'on'
DEFAULT_REASONING_EFFORT = 'medium'


class ProfileError(ValueError):
    """A profile or override combination the serving layer refuses to run."""


@dataclass(frozen=True)
class ServingProfile:
    """One serving configuration's definition, independent of any overrides."""

    name: str
    arch: str
    alias: str
    model_path: str
    ctx: int
    threads: int
    ngl: int
    hf_repo: str = ''
    hf_pattern: str = ''
    moe: int | None = None
    override_tensors: str | None = None
    parallel: int = DEFAULT_PARALLEL
    cache_k: str = DEFAULT_CACHE_K
    cache_v: str = DEFAULT_CACHE_V
    batch: int = DEFAULT_BATCH
    ubatch: int = DEFAULT_UBATCH
    spec: tuple[str, ...] = ()
    samplers: tuple[str, ...] = ()
    extra: tuple[str, ...] = ()
    #: None means "not a thinking model". Otherwise the effort used when no
    #: override is given. The shell encoded this implicitly, by baking
    #: ${LLAMA_REASONING:-medium} into LLAMA_P_EXTRA at resolution time and
    #: then testing that array for the substring 'reasoning_effort'. Modelling
    #: it as a field is equivalent for every profile that has ever existed and
    #: does not require string-matching a JSON blob to find out whether a knob
    #: applies.
    reasoning_effort_default: str | None = None
    notes: str = ''

    @classmethod
    def from_definition(cls, name: str, definition: Mapping[str, Any]) -> ServingProfile:
        """Build a profile from a stored definition: a version row, or seed data.

        Keys outside DEFINITION_FIELDS are ignored, so a whole row -- ids,
        timestamps and all -- can be passed as it is. A None where the field
        has a real default (hf_repo, cache_k, ...) takes the default; a None
        where None is meaningful (moe, override_tensors,
        reasoning_effort_default) is kept.
        """
        fields = {key: definition[key] for key in DEFINITION_FIELDS if key in definition}
        for key in ('hf_repo', 'hf_pattern', 'notes', 'parallel', 'cache_k', 'cache_v', 'batch', 'ubatch'):
            if fields.get(key) is None:
                fields.pop(key, None)
        for key in ('spec', 'samplers', 'extra'):
            fields[key] = tuple(fields.get(key) or ())
        return cls(name=name, **fields)


#: Every field a stored profile definition carries. Anything else in a
#: definition handed to validate_definition is rejected, not silently dropped.
DEFINITION_FIELDS = (
    'arch',
    'alias',
    'model_path',
    'hf_repo',
    'hf_pattern',
    'ctx',
    'threads',
    'ngl',
    'moe',
    'override_tensors',
    'parallel',
    'cache_k',
    'cache_v',
    'batch',
    'ubatch',
    'spec',
    'samplers',
    'extra',
    'reasoning_effort_default',
    'notes',
)

REQUIRED_FIELDS = frozenset({'arch', 'alias', 'model_path', 'ctx', 'threads', 'ngl'})


def validate_definition(definition: Mapping[str, Any]) -> dict[str, Any]:
    """Check a profile definition before it is stored, and normalise its lists.

    Stricter than `resolve` on purpose. `resolve` corrects a one-off
    *override* -- an MoE value on a dense model is dropped with a warning, so
    the server still starts -- but a stored *definition* with the same mistake
    is simply wrong, and is refused so that it cannot be saved and then
    quietly corrected on every launch.
    """
    unknown = set(definition) - set(DEFINITION_FIELDS)
    if unknown:
        raise ProfileError(f'unknown profile fields: {", ".join(sorted(unknown))}')
    missing = REQUIRED_FIELDS - set(definition)
    if missing:
        raise ProfileError(f'missing profile fields: {", ".join(sorted(missing))}')

    if definition['arch'] not in (ARCH_DENSE, ARCH_MOE):
        raise ProfileError(f"arch must be '{ARCH_DENSE}' or '{ARCH_MOE}'")
    if definition['arch'] == ARCH_DENSE and definition.get('moe') is not None:
        raise ProfileError('--n-cpu-moe is not applicable to a dense model; leave moe empty')

    spec = list(definition.get('spec') or [])
    extra = list(definition.get('extra') or [])
    if '--parallel' in spec or '--parallel' in extra:
        raise ProfileError('--parallel is its own field; it does not belong in the speculative or extra arguments')
    # The thinking budget is a field, and the launcher builds
    # --chat-template-kwargs from the *resolved* effort. A literal here would
    # be fingerprinted as the override but launched as the literal.
    if any('reasoning_effort' in arg for arg in extra):
        raise ProfileError('set the thinking budget with reasoning_effort_default, not in extra arguments')

    return {**definition, 'spec': spec, 'samplers': list(definition.get('samplers') or []), 'extra': extra}


@dataclass(frozen=True)
class Overrides:
    """The LLAMA_* one-off overrides, as typed fields.

    In the shell these could only be environment variables, and the Serve
    page's form mapped its fields back to variable names by a spelling
    convention (see routers/benchmarks/serve.py's module docstring). Nothing
    needs that indirection once they are parameters.

    `spec` is three-valued on purpose, matching `[[ -n "${LLAMA_SPEC+x}" ]]`:
    None means "not set, keep the profile's flags", an empty tuple means off,
    and a non-empty tuple replaces the profile's flags wholesale. That last
    case is the A/B this whole mechanism exists for.
    """

    model_path: str | None = None
    ctx: int | None = None
    threads: int | None = None
    ngl: int | None = None
    moe: int | None = None
    override_tensors: str | None = None
    parallel: int | None = None
    cache_k: str | None = None
    cache_v: str | None = None
    batch: int | None = None
    ubatch: int | None = None
    spec: tuple[str, ...] | None = None
    reasoning: str | None = None
    flash_attn: str = DEFAULT_FLASH_ATTN
    flash_attn_legacy: bool = False

    @classmethod
    def from_env(cls, env: dict[str, str]) -> Overrides:
        """Build overrides from LLAMA_* environment variables.

        Exists to reproduce the shell's exact semantics for the golden-value
        tests in docs/serving-baseline/, and for anything still invoked with an
        environment rather than arguments. New callers should construct
        `Overrides` directly.
        """

        def _int(key: str) -> int | None:
            raw = env.get(key)
            return int(raw) if raw not in (None, '') else None

        spec: tuple[str, ...] | None = None
        if 'LLAMA_SPEC' in env:
            raw = env['LLAMA_SPEC']
            # An unset variable keeps the profile's flags; an empty or
            # literal-"off" value turns speculation off. These are different
            # states, which is why `spec` is three-valued.
            spec = () if raw in ('', 'off') else tuple(raw.split())

        return cls(
            model_path=env.get('LLAMA_MODEL') or None,
            ctx=_int('LLAMA_CTX'),
            threads=_int('LLAMA_THREADS'),
            ngl=_int('LLAMA_NGL'),
            moe=_int('LLAMA_MOE'),
            override_tensors=env.get('LLAMA_OT') or None,
            parallel=_int('LLAMA_PARALLEL'),
            cache_k=env.get('LLAMA_CACHE_K') or None,
            cache_v=env.get('LLAMA_CACHE_V') or None,
            batch=_int('LLAMA_BATCH'),
            ubatch=_int('LLAMA_UBATCH'),
            spec=spec,
            reasoning=env.get('LLAMA_REASONING') or None,
            flash_attn=env.get('LLAMA_FA') or DEFAULT_FLASH_ATTN,
            flash_attn_legacy=env.get('LLAMA_FA_LEGACY') == '1',
        )


@dataclass(frozen=True)
class ResolvedConfig:
    """A profile with its overrides applied and guard rails enforced.

    This is what both the fingerprint and the launcher read, so that the flags
    passed to llama-server and the flags recorded against the run cannot
    disagree.
    """

    name: str
    alias: str
    arch: str
    model_path: str
    ctx: int
    threads: int
    ngl: int
    moe: int | None
    override_tensors: str | None
    parallel: int
    cache_k: str
    cache_v: str
    batch: int
    ubatch: int
    flash_attn: str
    spec: tuple[str, ...] = ()
    samplers: tuple[str, ...] = ()
    #: Already resolved to the value that will be served, or None for a model
    #: with no thinking budget to set.
    reasoning_effort: str | None = None
    extra: tuple[str, ...] = ()


def resolve(profile: ServingProfile, overrides: Overrides | None = None) -> ResolvedConfig:
    """Apply overrides to a profile, enforcing the two guard rails.

    Raises `ProfileError` if --parallel is smuggled in through a speculative
    override: it would be passed to llama-server twice, and recorded as the
    profile's slot count rather than the served one, which is the exact
    confusion an explicit parallel field exists to end.
    """
    overrides = overrides or Overrides()

    spec = profile.spec if overrides.spec is None else overrides.spec
    if '--parallel' in spec:
        raise ProfileError('--parallel does not belong in a speculative override; set the parallel field instead')

    moe = profile.moe if overrides.moe is None else overrides.moe
    if profile.arch == ARCH_DENSE and moe is not None:
        log.warning(
            '--n-cpu-moe is not applicable to dense model %r; ignoring',
            profile.name,
        )
        moe = None

    if profile.reasoning_effort_default is None:
        reasoning_effort = None
    else:
        # An empty override falls back to the default, matching
        # ${LLAMA_REASONING:-medium} rather than treating '' as a value.
        reasoning_effort = overrides.reasoning or profile.reasoning_effort_default

    flash_attn = 'legacy --flash-attn 1' if overrides.flash_attn_legacy else overrides.flash_attn

    def _pick(override, base):
        return base if override is None else override

    return ResolvedConfig(
        name=profile.name,
        alias=profile.alias,
        arch=profile.arch,
        model_path=_pick(overrides.model_path, profile.model_path),
        ctx=_pick(overrides.ctx, profile.ctx),
        threads=_pick(overrides.threads, profile.threads),
        ngl=_pick(overrides.ngl, profile.ngl),
        moe=moe,
        override_tensors=_pick(overrides.override_tensors, profile.override_tensors),
        parallel=_pick(overrides.parallel, profile.parallel),
        cache_k=_pick(overrides.cache_k, profile.cache_k),
        cache_v=_pick(overrides.cache_v, profile.cache_v),
        batch=_pick(overrides.batch, profile.batch),
        ubatch=_pick(overrides.ubatch, profile.ubatch),
        flash_attn=flash_attn,
        spec=tuple(spec),
        samplers=profile.samplers,
        reasoning_effort=reasoning_effort,
        extra=profile.extra,
    )
