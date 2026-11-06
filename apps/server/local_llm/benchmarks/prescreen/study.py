"""benchmarks/prescreen/study.py - Optuna's storage, in the `optuna` schema, and the samplers.

Every pre-screen is an Optuna study (the owner's decision D9, 2026-10-19),
stored in the app's own Postgres in a schema of its own (D13). Optuna's
RDB storage creates generic tables (`studies`, `trials`, `version_info`,
...) and runs its own Alembic migrations against the default
`alembic_version` table, the same one this app's migration history uses in
`public`. With `optuna` the only schema on the connection's search path,
every unqualified name Optuna uses resolves to `optuna.*`, and the app's
tables are invisible to it.

The search path is set in the URL (`options=-csearch_path=optuna`), not in
`engine_kwargs`. The plan said `engine_kwargs`, but `RDBStorage.upgrade()`
hands Alembic the bare URL (optuna 5.0.0, storages/_rdb/storage.py
`_create_alembic_config`), and Alembic builds a fresh engine from it. A
search path held anywhere but the URL would therefore be lost exactly when
Optuna migrates its tables, and the upgrade would run in `public`.

The benchmark_prescreen_* tables are the record. Deleting a study in the
dashboard removes only Optuna's copy.

Nothing here imports the app (`local_llm.env` and the rest): the dashboard
process opens its storage through this module.
"""

from __future__ import annotations

import logging
import os
from typing import Literal

from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError

from local_llm.benchmarks.prescreen import PrescreenRefused

log = logging.getLogger(__name__)

SCHEMA = 'optuna'
SEARCH_PATH_OPTION = f'-csearch_path={SCHEMA}'

#: The constraint every trial carries: 0 when the point ran, 1 when it could
#: not (an OOM, a point pruned by one, a broken constraint).
CONSTRAINT = 'infeasible'

#: Up to this many grid points, a pre-screen measures every one; above it,
#: TPE chooses a trial budget's worth (section 7.4 of the plan).
GRID_LIMIT = 120


def storage_url(database_url: str | None = None, database_schema: str | None = None) -> str:
    """The app's DATABASE_URL, as a psycopg URL whose only schema is `optuna`.

    Refuses, saying why, when the database is not Postgres (SQLite has no
    schemas), or when the app itself runs in the `optuna` schema
    (DATABASE_SCHEMA), which would put the app's tables and Optuna's in one
    place.
    """
    raw = database_url if database_url is not None else os.environ.get('DATABASE_URL', '')
    schema = database_schema if database_schema is not None else os.environ.get('DATABASE_SCHEMA')
    if schema == SCHEMA:
        raise PrescreenRefused(
            f"DATABASE_SCHEMA is '{SCHEMA}', the schema the pre-screen keeps Optuna's studies in; "
            'run the app in another schema'
        )
    try:
        url = make_url(raw.replace('postgres://', 'postgresql://', 1))
    except ArgumentError as e:
        raise PrescreenRefused('the pre-screen needs DATABASE_URL to name a Postgres database') from e
    if url.get_backend_name() != 'postgresql':
        raise PrescreenRefused(
            f'the pre-screen stores its Optuna studies in Postgres; DATABASE_URL is {url.get_backend_name()}'
        )
    options = url.query.get('options')
    if isinstance(options, tuple):
        options = ' '.join(options)
    if options and 'search_path' in options:
        raise PrescreenRefused('DATABASE_URL already sets a search_path in its options; the pre-screen sets its own')
    options = f'{options} {SEARCH_PATH_OPTION}' if options else SEARCH_PATH_OPTION
    return (
        url.set(drivername='postgresql+psycopg')
        .update_query_dict({'options': options})
        .render_as_string(hide_password=False)
    )


def open_storage(url: str | None = None):
    """An RDBStorage in the `optuna` schema, upgraded to this Optuna's head.

    Optuna's own Alembic is a second migration authority in the database,
    limited to that schema. uv.lock pins Optuna's version, so its schema
    changes only in a deliberate dependency bump. On first use after one,
    the stored version differs from the head this Optuna ships, and the
    storage is upgraded here, with a log line, rather than left to fail.
    """
    import optuna

    storage = optuna.storages.RDBStorage(url or storage_url(), skip_compatibility_check=True)
    current, head = storage.get_current_version(), storage.get_head_version()
    if current != head:
        log.warning('upgrading the optuna schema from %s to %s (optuna %s)', current, head, optuna.__version__)
        storage.upgrade()
    return storage


def close_storage(storage) -> None:
    storage.remove_session()
    storage.engine.dispose()


def mark_feasible(trial, feasible: bool) -> None:
    """Set the trial's constraint, before it is told.

    TPE leaves FAIL trials out when it models the space, so a configuration
    that runs out of memory would keep being proposed. A trial that cannot
    run is therefore completed with throughput 0 and a violated constraint,
    which is how Optuna learns feasibility (`Trial.set_constraint`, which
    replaced `constraints_func` in optuna 5.0.0). Every trial carries one,
    feasible or not.
    """
    trial.set_constraint(CONSTRAINT, 0.0 if feasible else 1.0)


def distributions(knobs: dict[str, list], baseline: dict) -> dict:
    """One categorical distribution per knob, the baseline's value included.

    Categorical even for counts: a grid lists a handful of values, often not
    evenly spaced (`256, 512, 1024, 2048`), and Optuna has no distribution
    for "these numbers, in order". The profile's own value joins the list
    when the grid leaves it out, so trial 0 can be the baseline.
    """
    from optuna.distributions import CategoricalDistribution

    out = {}
    for var in sorted(knobs):
        values = list(knobs[var])
        if baseline.get(var) is not None and baseline[var] not in values:
            values.append(baseline[var])
        out[var] = CategoricalDistribution(values)
    return out


def make_sampler(kind: str, seed: int):
    """The study's sampler.

    `tpe` is a seeded multivariate TPE, which reads each trial's constraint
    (`mark_feasible()`). For `grid`,
    every point is enqueued with all its parameters fixed, in the order that
    lets monotone pruning apply, so no sampler ever chooses one. Optuna's
    GridSampler is not used: it visits its grid in a seeded shuffle, which
    defeats the pruning order.
    """
    import optuna

    if kind == 'tpe':
        return optuna.samplers.TPESampler(multivariate=True, seed=seed)
    return optuna.samplers.RandomSampler(seed=seed)


def directions(objective: str) -> list[Literal['maximize']]:
    """`tg` or `pp` is one objective; `both` is (pp, tg), so the dashboard shows the Pareto front."""
    return ['maximize', 'maximize'] if objective == 'both' else ['maximize']


def values(objective: str, pp: float | None, tg: float | None) -> list[float]:
    """The values a trial is told: tokens per second, 0 for a point that did not run."""
    pp, tg = pp or 0.0, tg or 0.0
    if objective == 'both':
        return [pp, tg]
    return [pp if objective == 'pp' else tg]
