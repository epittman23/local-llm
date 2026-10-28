"""benchmarks/prescreen - llama-bench over a grid of offload and batch flags.

A cheap first pass before Tune or a Tests run: one llama-bench process per
point, an Optuna study choosing the points, and the leading candidates
checked for a load at the profile's own context. The numbers are raw
llama-bench throughput at a test-sized context, never a serving
measurement, so they are recorded in benchmark_prescreen_* and never shown
on Compare or Report (docs/plans/benchmark-upgrade.md, section 7.4).

- `grid` reads data/prescreen/<profile>.toml and orders its points.
- `bench` builds one llama-bench command, runs it and classifies the result.
- `study` is Optuna's storage in the `optuna` schema, and the samplers.
- `sweep` runs a pre-screen end to end.
- `dashboard` is optuna-dashboard's own loopback process.

Kept free of imports at package level: `python -m
local_llm.benchmarks.prescreen.dashboard` runs outside the app and must not
load it. `PrescreenRefused` lives here for the same reason, so `study` can
raise it without importing anything that does.
"""


class PrescreenRefused(RuntimeError):
    """The pre-screen declined to run, and says why: a bad grid, a busy GPU, no Postgres, ..."""
