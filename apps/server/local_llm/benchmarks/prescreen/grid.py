"""benchmarks/prescreen/grid.py - a pre-screen's search space, and the order it is walked in.

A pre-screen grid is data/prescreen/<profile>.toml, in Tune's format
(`[knob.LLAMA_*] values = [...]`, `[[constraint]] expr = "..."`), parsed by
Tune's own `Grid`, so the two share one constraint parser and one sha. They
are separate files because the two measure different things: Tune serves
each candidate, so its grids carry knobs llama-bench cannot measure
(speculative decoding, the reasoning budget, the context size). A
pre-screen grid may only name the knobs in `KNOBS`.

The one thing this module adds is order. On a failed load or context,
llama-bench gives up, so a point that runs out of memory implies every point
that needs more memory than it fails too. `pruned_by()` finds that point,
and `points()` puts each group's points in the order that lets the first
OOM prune the rest.
"""

from __future__ import annotations

import itertools
import tomllib
from pathlib import Path

from local_llm.benchmarks.paths import PRESCREEN_DIR
from local_llm.benchmarks.prescreen import PrescreenRefused
from local_llm.benchmarks.serving.profiles import ResolvedConfig
from local_llm.benchmarks.tuning.tune_schedule import Grid, TuneRefused, profile_key

#: The overrides llama-bench can measure, each a flag it takes
#: (benchmarks/prescreen/bench.py's build_argv).
KNOBS = frozenset(
    {
        'LLAMA_NGL',
        'LLAMA_MOE',
        'LLAMA_BATCH',
        'LLAMA_UBATCH',
        'LLAMA_THREADS',
        'LLAMA_CACHE_K',
        'LLAMA_CACHE_V',
        'LLAMA_FA',
    }
)


def defaults(config: ResolvedConfig) -> dict:
    """A resolved configuration's values under the keys a grid's constraints use.

    `profile_key('LLAMA_UBATCH')` is `ubatch`, and so on, so a constraint
    can name a knob the grid does not sweep and still read the profile's
    value for it. `fa` is the one key whose field is spelled differently.
    """
    return {
        'ngl': config.ngl,
        'moe': config.moe,
        'batch': config.batch,
        'ubatch': config.ubatch,
        'threads': config.threads,
        'cache_k': config.cache_k,
        'cache_v': config.cache_v,
        'fa': config.flash_attn,
        'ctx': config.ctx,
    }


class PrescreenGrid:
    """A parsed pre-screen grid: Tune's `Grid`, restricted to `KNOBS`."""

    def __init__(self, path: Path, data: dict):
        try:
            self.grid = Grid(path, data)
        except TuneRefused as e:
            raise PrescreenRefused(str(e).removeprefix('llama-tune: ')) from e
        unknown = sorted(set(self.grid.knobs) - KNOBS)
        if unknown:
            raise PrescreenRefused(
                f'{path.name}: llama-bench cannot measure {", ".join(unknown)}; '
                f'a pre-screen grid may only name {", ".join(sorted(KNOBS))}'
            )
        self.path = path
        self.name = path.stem
        self.profile = self.grid.profile
        self.sha = self.grid.sha
        self.knobs = self.grid.knobs

    def violated(self, overrides: dict, config: ResolvedConfig) -> str | None:
        """The first constraint these overrides break, in the grid's own words."""
        try:
            return self.grid.violated(overrides, defaults(config))
        except TuneRefused as e:
            raise PrescreenRefused(str(e).removeprefix('llama-tune: ')) from e

    def size(self) -> int:
        """Every combination of the knobs' values, before constraints."""
        n = 1
        for values in self.knobs.values():
            n *= len(values)
        return n

    def combinations(self) -> list[dict]:
        """Every combination of the knobs' values, as typed values, in declared order."""
        names = sorted(self.knobs)
        return [dict(zip(names, combo, strict=True)) for combo in itertools.product(*(self.knobs[n] for n in names))]


def grid_names() -> list[str]:
    return sorted(p.stem for p in PRESCREEN_DIR.glob('*.toml'))


def load_grid(name: str) -> PrescreenGrid:
    """A grid by name only, never a path: the name comes from a request."""
    if name not in grid_names():
        known = ', '.join(grid_names()) or 'none'
        raise PrescreenRefused(f"no pre-screen grid '{name}' (defined: {known})")
    path = PRESCREEN_DIR / f'{name}.toml'
    with path.open('rb') as fh:
        data = tomllib.load(fh)
    return PrescreenGrid(path, data)


# ---------------------------------------------------------------------------
# monotone pruning
# ---------------------------------------------------------------------------
def vram_key(config: ResolvedConfig) -> tuple:
    """Everything that sizes VRAM except the two offload counts.

    Two points with equal keys differ in memory only through `ngl` and
    `moe`, so one can imply the other's OOM. `threads` is left out: CPU
    threads allocate nothing on the card. Anything else that differs (a
    larger batch, an f16 cache) changes the compute buffer or the KV cache,
    and the points are not compared.
    """
    return (
        config.model_path,
        config.batch,
        config.ubatch,
        config.cache_k,
        config.cache_v,
        config.flash_attn,
        config.override_tensors,
    )


def needs_more_vram(config: ResolvedConfig, than: ResolvedConfig) -> bool:
    """Whether `config` puts at least as much on the card as `than`.

    More GPU layers (`ngl`) and fewer layers' experts left in system RAM
    (`moe`) both mean more VRAM, so `config` needs at least as much when
    neither count moves the other way.
    """
    if vram_key(config) != vram_key(than):
        return False
    if config.ngl < than.ngl:
        return False
    if config.moe is not None and than.moe is not None and config.moe > than.moe:
        return False
    return (config.moe is None) == (than.moe is None)


def pruned_by(config: ResolvedConfig, ooms: list[tuple[int, ResolvedConfig]]) -> int | None:
    """The point id of a recorded OOM that implies this one, or None."""
    for point_id, oom in ooms:
        if needs_more_vram(config, oom):
            return point_id
    return None


def pruning_order(config: ResolvedConfig) -> tuple:
    """Sort key: within a VRAM group, the least memory first.

    `ngl` ascending, `moe` descending, so the first point to run out of
    memory prunes the rest of its group. Groups and threads are ordered
    only so the walk is deterministic.
    """
    return (
        tuple('' if v is None else str(v) for v in vram_key(config)),
        config.ngl,
        -(config.moe or 0),
        config.threads,
    )


def as_overrides(params: dict) -> dict[str, str]:
    """Trial parameters (typed, as Optuna holds them) as LLAMA_* override strings."""
    return {var: str(value) for var, value in sorted(params.items())}


def baseline_params(grid: PrescreenGrid, config: ResolvedConfig) -> dict:
    """The profile's own value for each knob the grid sweeps."""
    values = defaults(config)
    return {var: values[profile_key(var)] for var in sorted(grid.knobs)}
