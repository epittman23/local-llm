"""benchmarks/prescreen/sweep.py - one pre-screen, end to end.

`Prescreen.prepare()` checks everything that can be checked before the GPU
is touched (the profile, the grid, the binary, the weights, the database)
and opens the sweep's row and its Optuna study, so a refusal reaches the
request that asked for it. `Prescreen.run()` then:

1. **searches**: trial 0 is the profile's own configuration, so every study
   measures what it is trying to beat. Under `grid` every feasible point
   follows, in pruning order (grid.py); under `tpe` a seeded TPE proposes a
   trial budget's worth. Each trial is a point row and an Optuna trial, told
   through the ask-and-tell interface from a worker thread, since Optuna's
   calls block.
2. **re-measures** the top three in fresh processes. Prompt processing
   varied by 12-22% of its mean between repetitions in the recorded thread
   sweep, and a lucky run would otherwise lead the list. Candidates rank by
   the mean of both measurements.
3. **load-checks** the leading candidates at the profile's own context
   (D11). llama-bench sizes its context to the test, so a point can pass
   here and still run out of memory at 64K in llama-server.

The benchmark_prescreen_* rows are the record; Optuna's study is a view of
the search for the dashboard. Nothing here serves a model for anything but
the load check, which records no telemetry and no run.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import signal
import socket
import time
from collections import deque
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TYPE_CHECKING

import aiohttp

from local_llm.benchmarks.prescreen import PrescreenRefused, bench, study
from local_llm.benchmarks.prescreen.grid import (
    PrescreenGrid,
    as_overrides,
    baseline_params,
    load_grid,
    pruned_by,
    pruning_order,
)
from local_llm.benchmarks.serving.fingerprint import config_id, config_lines
from local_llm.benchmarks.serving.gpu import sample_gpu
from local_llm.benchmarks.serving.launcher import (
    DEFAULT_PORT,
    LauncherError,
    ServeProcess,
    resolve_model_path,
)
from local_llm.benchmarks.serving.profiles import (
    ARCH_DENSE,
    Overrides,
    ProfileError,
    ResolvedConfig,
    ServingProfile,
    resolve,
)
from local_llm.benchmarks.tuning.tune_probe import OOM_PATTERN
from local_llm.models.benchmarks.prescreen import (
    BenchmarkPrescreenPointModel,
    BenchmarkPrescreenPoints,
    BenchmarkPrescreenSweeps,
)
from local_llm.models.benchmarks.profiles import BenchmarkProfiles

if TYPE_CHECKING:  # optuna is imported where it is used: it is slow to import
    import optuna

log = logging.getLogger(__name__)

#: How many leading points are measured a second time.
REMEASURE = 3

#: How a trial's outcome is told to Optuna. OOM, pruned and invalid points
#: complete as infeasible so TPE learns where memory runs out; a point that
#: failed for any other reason says nothing about memory and is a FAIL.
INFEASIBLE = frozenset({'oom', 'pruned', 'invalid'})


@dataclass
class PrescreenOptions:
    profile: str | None = None
    grid: str | None = None
    sampler: str = 'auto'
    trials: int = 40
    seed: int = 0
    objective: str = 'tg'
    n_prompt: int = 512
    n_gen: int = 128
    reps: int = 5
    point_timeout: int = 900
    ctx_checks: int = 3
    load_timeout: int = 600

    def check(self) -> None:
        if self.sampler not in ('auto', 'grid', 'tpe'):
            raise PrescreenRefused(f"sampler must be auto, grid or tpe, not '{self.sampler}'")
        if self.objective not in ('tg', 'pp', 'both'):
            raise PrescreenRefused(f"objective must be tg, pp or both, not '{self.objective}'")
        for name in ('n_prompt', 'n_gen', 'reps', 'point_timeout', 'load_timeout', 'trials'):
            if getattr(self, name) < 1:
                raise PrescreenRefused(f'{name} must be at least 1')
        if self.ctx_checks < 0:
            raise PrescreenRefused('ctx_checks cannot be negative')


def _llama_bin() -> str:
    return os.environ.get('LLAMA_BIN') or str(Path.home() / 'llama.cpp/build/bin')


def _nvidia_smi() -> str:
    # The same override Tune's GPU probe reads, so a test can stand in for the card.
    return os.environ.get('LLAMA_TUNE_NVIDIA_SMI', 'nvidia-smi')


# ---------------------------------------------------------------------------
# crash recovery: a sweep whose backend is gone
# ---------------------------------------------------------------------------
def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def _group_is(pgid: int, names: tuple[str, ...]) -> bool:
    """Whether the group's leader is still one of the binaries a pre-screen starts.

    A recorded group id outlives its process, and the number can be reused
    by anything at all, so an orphan is signalled only once its command line
    says it is ours.
    """
    try:
        argv = Path(f'/proc/{pgid}/cmdline').read_bytes().split(b'\0')[:2]
    except OSError:
        return False
    # The second element too: a script in LLAMA_BIN runs as `interpreter script`.
    return any(Path(a.decode(errors='replace')).name in names for a in argv)


async def kill_orphan(pgid: int | None, *, grace: float = 3.0) -> bool:
    """SIGTERM, then SIGKILL, to a llama-bench or load-check server an earlier backend left running."""
    if not pgid or pgid <= 1 or not _group_is(pgid, ('llama-bench', 'llama-server')):
        return False
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pgid, sig)
        except (ProcessLookupError, PermissionError, OSError):
            return True
        await asyncio.sleep(grace)
    return True


async def reclaim_stale(active: str | None = None) -> int:
    """Close the sweeps whose backend is gone, and stop what they left running.

    The sweep row carries the backend's pid, so a dead backend is
    detectable rather than merely likely, as with Tune's sweeps. A sweep
    still running under another live backend process is refused rather
    than closed: two pre-screens would share one GPU.
    """
    closed = 0
    for row in await BenchmarkPrescreenSweeps.list_sweeps(limit=1000, running_only=True):
        if row.sweep_id == active:
            continue
        if row.pid and row.pid != os.getpid() and _alive(row.pid):
            raise PrescreenRefused(f'pre-screen {row.sweep_id} is running in another backend process (pid {row.pid})')
        for point in await BenchmarkPrescreenPoints.sweep_points(row.sweep_id):
            await kill_orphan(point.pgid)
            if point.status == 'running':
                await BenchmarkPrescreenPoints.set_point(
                    point.point_id,
                    status='cancelled',
                    reason='the backend running it is gone',
                    ended_at=int(time.time()),
                )
        await BenchmarkPrescreenSweeps.close_sweep(
            row.sweep_id, status='stale', reason='the backend running it is gone'
        )
        closed += 1
    return closed


# ---------------------------------------------------------------------------
# ranking: shared by the sweep and the page
# ---------------------------------------------------------------------------
def _mean(values: list[float | None]) -> float:
    measured = [v for v in values if v is not None]
    return sum(measured) / len(measured) if measured else 0.0


def _dominates(a: dict, b: dict) -> bool:
    return a['pp'] >= b['pp'] and a['tg'] >= b['tg'] and (a['pp'] > b['pp'] or a['tg'] > b['tg'])


def rank(points: list[BenchmarkPrescreenPointModel], objective: str, baseline: dict | None = None) -> list[dict]:
    """The measured search points, best first, each with the mean of its measurements.

    A point's re-measurement (a `remeasure` row pointing at it) is averaged
    with the original. `tg` and `pp` rank by that mean; `both` ranks by
    Pareto layer, then by generation. `changes` is what differs from the
    profile, under the profile's own field names, for the Serve page or a new
    profile version.
    """
    by_point: dict[int, list[BenchmarkPrescreenPointModel]] = {}
    for p in points:
        if p.status != 'ok':
            continue
        key = p.remeasure_of if p.phase == 'remeasure' else p.point_id
        if key is not None:
            by_point.setdefault(key, []).append(p)
    rows = []
    for p in points:
        if p.phase != 'search' or p.status != 'ok':
            continue
        runs = by_point.get(p.point_id, [p])
        rows.append(
            {
                'point_id': p.point_id,
                'optuna_trial_number': p.optuna_trial_number,
                'is_baseline': p.is_baseline,
                'overrides': p.overrides,
                'changes': {
                    var.removeprefix('LLAMA_').lower(): value
                    for var, value in sorted(p.overrides.items())
                    if baseline is None or str(baseline.get(var)) != value
                },
                'config_id': p.config_id,
                'measurements': len(runs),
                'pp': _mean([r.pp_avg_ts for r in runs]),
                'tg': _mean([r.tg_avg_ts for r in runs]),
                'pp_runs': [r.pp_avg_ts for r in runs],
                'tg_runs': [r.tg_avg_ts for r in runs],
                'peak_vram_mib': max((r.peak_vram_mib for r in runs if r.peak_vram_mib is not None), default=None),
                'ctx_check': p.ctx_check,
                'ctx_check_free_mib': p.ctx_check_free_mib,
                'ctx_check_reason': p.ctx_check_reason,
            }
        )
    if objective == 'both':
        layer, remaining = 0, list(rows)
        while remaining:
            front = [r for r in remaining if not any(_dominates(o, r) for o in remaining if o is not r)]
            for r in front:
                r['pareto_layer'] = layer
            remaining = [r for r in remaining if r not in front]
            layer += 1
        rows.sort(key=lambda r: (r['pareto_layer'], -r['tg'], r['point_id']))
    else:
        rows.sort(key=lambda r: (-r[objective], r['point_id']))
    for i, r in enumerate(rows):
        r['rank'] = i + 1
    return rows


# ---------------------------------------------------------------------------
# the sweep
# ---------------------------------------------------------------------------
class Prescreen:
    def __init__(self, opts: PrescreenOptions, *, database_url: str | None = None, database_schema: str | None = None):
        self.opts = opts
        self.database_url = database_url
        self.database_schema = database_schema
        self.cancel = asyncio.Event()
        #: The point being measured right now, for the page's live status.
        self.current: dict | None = None
        # Set by prepare(); nothing reads them before it returns.
        self.sweep_id: str
        self.profile: ServingProfile
        self.grid: PrescreenGrid
        self.config: ResolvedConfig
        self.study: optuna.Study
        self.storage = None
        self.sampler = opts.sampler
        self.version_id: int | None = None
        self.binary = bench.llama_bench_path(_llama_bin())
        self.nvidia_smi = _nvidia_smi()
        self.ooms: list[tuple[int, ResolvedConfig]] = []
        #: llama-bench argv -> the point that measured it, for a repeated proposal.
        self.measured: dict[tuple[str, ...], tuple[int, str, list[float]]] = {}
        self._recorded_build = False

    # -- before the GPU ---------------------------------------------------
    async def prepare(self) -> str:
        """Check everything, then open the sweep's row and study. Returns the sweep id."""
        o = self.opts
        o.check()
        entry = await (BenchmarkProfiles.get_by_name(o.profile) if o.profile else BenchmarkProfiles.get_default())
        if entry is None:
            raise PrescreenRefused(f"no profile '{o.profile}'" if o.profile else 'no default profile')
        self.profile = entry.to_serving_profile()
        self.version_id = entry.version.version_id
        self.grid = load_grid(o.grid or entry.profile.name)
        if self.grid.profile != entry.profile.name:
            raise PrescreenRefused(
                f"grid '{self.grid.name}' is for profile '{self.grid.profile}', not '{entry.profile.name}'"
            )
        if self.profile.arch == ARCH_DENSE and 'LLAMA_MOE' in self.grid.knobs:
            raise PrescreenRefused(f'{self.grid.path.name}: LLAMA_MOE on a dense profile; --n-cpu-moe would be dropped')
        try:
            self.config = resolve(self.profile)
        except ProfileError as e:
            raise PrescreenRefused(str(e)) from e
        if not os.access(self.binary, os.X_OK):
            raise PrescreenRefused(f'llama-bench not found at {self.binary}')
        model = resolve_model_path(self.config.model_path)
        if not await asyncio.to_thread(os.path.isfile, model):
            raise PrescreenRefused(f'model not found: {model}')
        bench.build_argv(self.config, n_prompt=o.n_prompt, n_gen=o.n_gen, reps=o.reps)  # refuses what cannot run

        self.baseline = baseline_params(self.grid, self.config)
        self.dists = study.distributions(self.grid.knobs, self.baseline)
        self.plan = self._grid_plan()
        if self.sampler == 'auto':
            self.sampler = 'grid' if len(self.plan) <= study.GRID_LIMIT else 'tpe'

        await reclaim_stale()
        url = study.storage_url(self.database_url, self.database_schema)
        self.storage = await asyncio.to_thread(study.open_storage, url)
        host = await asyncio.to_thread(bench.host_info, self.nvidia_smi)
        size = await asyncio.to_thread(os.path.getsize, model)
        self.sweep_id = BenchmarkPrescreenSweeps.new_id()
        name = f'prescreen-{self.sweep_id}'
        await BenchmarkPrescreenSweeps.open_sweep(
            self.sweep_id,
            pid=os.getpid(),
            profile=entry.profile.name,
            profile_version_id=self.version_id,
            sampler=self.sampler,
            seed=o.seed,
            trial_budget=o.trials if self.sampler == 'tpe' else len(self.plan) + 1,
            objective=o.objective,
            study_name=name,
            grid_path=str(self.grid.path.relative_to(self.grid.path.parents[2])),
            grid_sha=self.grid.sha,
            n_prompt=o.n_prompt,
            n_gen=o.n_gen,
            reps=o.reps,
            point_timeout=o.point_timeout,
            ctx_checks=o.ctx_checks,
            model_file=Path(model).name,
            model_bytes=size,
            **host,
        )
        try:
            self.study = await asyncio.to_thread(self._create_study, name)
        except Exception as e:
            await BenchmarkPrescreenSweeps.close_sweep(self.sweep_id, status='failed', reason=f'optuna: {e}')
            await asyncio.to_thread(study.close_storage, self.storage)
            raise
        return self.sweep_id

    def _create_study(self, name: str):
        import optuna

        created = optuna.create_study(
            study_name=name,
            storage=self.storage,
            sampler=study.make_sampler(self.sampler, self.opts.seed),
            directions=study.directions(self.opts.objective),
        )
        created.set_user_attr('profile', self.grid.profile)
        created.set_user_attr('grid_sha', self.grid.sha)
        created.set_user_attr('sweep_id', self.sweep_id)
        return created

    def _grid_plan(self) -> list[dict]:
        """Every feasible grid point, in pruning order, the baseline left out (it is trial 0)."""
        plan = []
        for params in self.grid.combinations():
            overrides = as_overrides(params)
            if self.grid.violated(overrides, self.config):
                continue
            try:
                resolved = resolve(self.profile, Overrides.from_env(overrides))
            except ProfileError:
                continue
            if params == self.baseline:
                continue
            plan.append((pruning_order(resolved), params))
        plan.sort(key=lambda item: item[0])
        return [params for _, params in plan]

    # -- the run -------------------------------------------------------------
    async def run(self) -> str:
        """Search, re-measure, load-check, and close the sweep. Returns how it ended."""
        status, reason = 'done', None
        try:
            await self._search()
            if not self.cancel.is_set():
                await self._remeasure()
            if not self.cancel.is_set():
                await self._ctx_checks()
            if self.cancel.is_set():
                status, reason = 'cancelled', 'cancelled'
        except asyncio.CancelledError:
            await asyncio.shield(self._close('cancelled', 'the backend stopped it'))
            raise
        except Exception as e:  # recorded on the sweep, and logged with its traceback
            log.exception('pre-screen %s failed', self.sweep_id)
            status, reason = 'failed', str(e) or e.__class__.__name__
        await self._close(status, reason)
        return status

    async def _close(self, status: str, reason: str | None) -> None:
        self.current = None
        await BenchmarkPrescreenSweeps.close_sweep(self.sweep_id, status=status, reason=reason)
        if self.storage is not None:
            await asyncio.to_thread(study.close_storage, self.storage)
            self.storage = None

    async def _search(self) -> None:
        queue = [self.baseline, *self.plan] if self.sampler == 'grid' else [self.baseline]
        budget = len(queue) if self.sampler == 'grid' else self.opts.trials
        for i in range(budget):
            if self.cancel.is_set():
                return
            if i < len(queue):
                await asyncio.to_thread(self.study.enqueue_trial, queue[i])
            trial = await asyncio.to_thread(self.study.ask, self.dists)
            await self._trial(trial)

    async def _trial(self, trial) -> None:
        params = trial.params
        overrides = as_overrides(params)
        is_baseline = trial.number == 0
        fields = {'phase': 'search', 'optuna_trial_number': trial.number, 'is_baseline': is_baseline}

        try:
            resolved = resolve(self.profile, Overrides.from_env(overrides))
        except ProfileError as e:
            await self._record_skip(trial, overrides, 'invalid', str(e), fields)
            return
        cid = config_id(resolved, config_lines(resolved))
        broken = None if is_baseline else self.grid.violated(overrides, self.config)
        if broken:
            await self._record_skip(trial, overrides, 'invalid', f'constraint: {broken}', fields, config_id=cid)
            return
        argv = bench.build_argv(resolved, n_prompt=self.opts.n_prompt, n_gen=self.opts.n_gen, reps=self.opts.reps)
        earlier = self.measured.get(tuple(argv))
        if earlier is not None:
            point_id, status, told = earlier
            await self._record_skip(
                trial,
                overrides,
                'repeat',
                f'the same command as point {point_id}',
                fields,
                config_id=cid,
                told=(status, told),
            )
            return
        oom = pruned_by(resolved, self.ooms)
        if oom is not None:
            await self._record_skip(
                trial,
                overrides,
                'pruned',
                f'needs more VRAM than point {oom}, which ran out',
                fields,
                config_id=cid,
                pruned_by=oom,
            )
            return

        point_id, result = await self._measure(resolved, argv, overrides, config_id=cid, **fields)
        if result.status == 'oom':
            self.ooms.append((point_id, resolved))
        told = study.values(self.opts.objective, *self._throughput(result))
        self.measured[tuple(argv)] = (point_id, result.status, told)
        await self._tell(trial, result.status, told)

    @staticmethod
    def _throughput(result: bench.PointResult) -> tuple[float | None, float | None]:
        if result.parsed is None:
            return None, None
        return result.parsed['pp']['avg_ts'], result.parsed['tg']['avg_ts']

    async def _record_skip(
        self,
        trial,
        overrides: dict,
        status: str,
        reason: str,
        fields: dict,
        *,
        config_id=None,
        pruned_by=None,
        told=None,
    ) -> None:
        await BenchmarkPrescreenPoints.open_point(
            self.sweep_id,
            overrides=overrides,
            config_id=config_id,
            status=status,
            reason=reason,
            pruned_by=pruned_by,
            ended_at=int(time.time()),
            **fields,
        )
        if told is not None:
            await self._tell(trial, *told)
        else:
            await self._tell(trial, status, study.values(self.opts.objective, None, None))

    async def _tell(self, trial, status: str, told: list[float]) -> None:
        from optuna.trial import TrialState

        def tell():
            if status == 'ok' or status in INFEASIBLE:
                study.mark_feasible(trial, status == 'ok')
                self.study.tell(trial, told)
            else:
                self.study.tell(trial, state=TrialState.FAIL)

        await asyncio.to_thread(tell)

    async def _measure(
        self, resolved: ResolvedConfig, argv: list[str], overrides: dict, **fields
    ) -> tuple[int, bench.PointResult]:
        point_id = await BenchmarkPrescreenPoints.open_point(self.sweep_id, overrides=overrides, argv=argv, **fields)
        self.current = {
            'point_id': point_id,
            'phase': fields['phase'],
            'overrides': overrides,
            'started_at': int(time.time()),
        }

        async def on_spawn(pgid: int) -> None:
            await BenchmarkPrescreenPoints.set_point(point_id, pgid=pgid)

        try:
            result = await bench.run_point(
                self.binary,
                argv,
                point_timeout=self.opts.point_timeout,
                cancel=self.cancel,
                on_spawn=on_spawn,
                nvidia_smi=self.nvidia_smi,
            )
        except asyncio.CancelledError:
            await asyncio.shield(
                BenchmarkPrescreenPoints.set_point(
                    point_id, status='cancelled', reason='the backend stopped it', ended_at=int(time.time())
                )
            )
            raise
        finally:
            self.current = None
        parsed = result.parsed or {}
        await BenchmarkPrescreenPoints.set_point(
            point_id,
            status=result.status,
            reason=result.reason,
            ended_at=int(time.time()),
            pp_avg_ts=parsed.get('pp', {}).get('avg_ts'),
            pp_stddev_ts=parsed.get('pp', {}).get('stddev_ts'),
            pp_samples_ts=parsed.get('pp', {}).get('samples_ts'),
            tg_avg_ts=parsed.get('tg', {}).get('avg_ts'),
            tg_stddev_ts=parsed.get('tg', {}).get('stddev_ts'),
            tg_samples_ts=parsed.get('tg', {}).get('samples_ts'),
            raw_jsonl=result.stdout or None,
            stderr_tail=result.stderr_tail or None,
            peak_vram_mib=result.peak_vram_mib,
            peak_power_w=result.peak_power_w,
            peak_temp_c=result.peak_temp_c,
            throttle_reasons=result.throttle_reasons,
        )
        if result.parsed and not self._recorded_build:
            self._recorded_build = True
            await BenchmarkPrescreenSweeps.set_sweep(
                self.sweep_id, **{k: parsed[k] for k in ('build_commit', 'build_number', 'gpu_info', 'cpu_info')}
            )
        return point_id, result

    async def _ranked(self) -> list[dict]:
        points = await BenchmarkPrescreenPoints.sweep_points(self.sweep_id)
        return rank(points, self.opts.objective, as_overrides(self.baseline))

    async def _remeasure(self) -> None:
        """The leaders, measured again in fresh processes."""
        points = {p.point_id: p for p in await BenchmarkPrescreenPoints.sweep_points(self.sweep_id)}
        for row in (await self._ranked())[:REMEASURE]:
            if self.cancel.is_set():
                return
            point = points[row['point_id']]
            resolved = resolve(self.profile, Overrides.from_env(point.overrides))
            argv = bench.build_argv(resolved, n_prompt=self.opts.n_prompt, n_gen=self.opts.n_gen, reps=self.opts.reps)
            await self._measure(
                resolved,
                argv,
                point.overrides,
                config_id=point.config_id,
                phase='remeasure',
                remeasure_of=point.point_id,
                is_baseline=point.is_baseline,
            )

    async def _ctx_checks(self) -> None:
        """Load the leading candidates in llama-server at the profile's own context (D11)."""
        points = {p.point_id: p for p in await BenchmarkPrescreenPoints.sweep_points(self.sweep_id)}
        for row in (await self._ranked())[: self.opts.ctx_checks]:
            if self.cancel.is_set():
                return
            point = points[row['point_id']]
            resolved = resolve(self.profile, Overrides.from_env(point.overrides))
            self.current = {
                'point_id': point.point_id,
                'phase': 'ctx_check',
                'overrides': point.overrides,
                'started_at': int(time.time()),
            }
            try:
                outcome, free, reason = await self._load_check(point.point_id, resolved)
            finally:
                self.current = None
            await BenchmarkPrescreenPoints.set_point(
                point.point_id, ctx_check=outcome, ctx_check_free_mib=free, ctx_check_reason=reason
            )

    async def _load_check(self, point_id: int, config: ResolvedConfig) -> tuple[str, int | None, str | None]:
        port = int(os.environ.get('LLAMA_PORT') or DEFAULT_PORT)
        if await asyncio.to_thread(_port_open, port):
            return 'skipped', None, f'port {port} is already in use'
        job = ServeProcess(config=config, port=port, record_telemetry=False, profile_version_id=self.version_id)
        try:
            await job.start()
        except LauncherError as e:
            return 'load_error', None, str(e)
        if job.server_proc is not None:
            await BenchmarkPrescreenPoints.set_point(point_id, pgid=job.server_proc.pid)
        tail: deque[str] = deque(maxlen=60)

        async def drain() -> None:
            with contextlib.suppress(ValueError, OSError):
                async for line in job.lines():
                    tail.append(line)

        drainer = asyncio.create_task(drain())
        try:
            async with aiohttp.ClientSession() as session:
                deadline = time.monotonic() + self.opts.load_timeout
                while time.monotonic() < deadline:
                    if self.cancel.is_set():
                        return 'skipped', None, 'cancelled'
                    if await _healthy(session, port):
                        reading = await asyncio.to_thread(sample_gpu, self.nvidia_smi)
                        free = None
                        if reading and reading['mem_total_mib'] is not None and reading['mem_used_mib'] is not None:
                            free = reading['mem_total_mib'] - reading['mem_used_mib']
                        return 'ok', free, None
                    if not job.running:
                        text = '\n'.join(tail)
                        last = ' / '.join([ln for ln in tail if ln.strip()][-3:])[:400] or 'no output'
                        return ('oom_at_ctx' if OOM_PATTERN.search(text) else 'load_error'), None, last
                    await asyncio.sleep(1.0)
                return 'timeout', None, f'no /health within {self.opts.load_timeout}s'
        finally:
            await job.stop()
            drainer.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await drainer

    def status(self) -> dict:
        return {
            'sweep_id': self.sweep_id,
            'current': self.current,
            'options': asdict(self.opts),
            'sampler': self.sampler,
        }


def _port_open(port: int) -> bool:
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=1):
            return True
    except OSError:
        return False


async def _healthy(session: aiohttp.ClientSession, port: int) -> bool:
    """llama-server answers /health with 503 while it loads and 200 once it can serve."""
    try:
        async with session.get(f'http://127.0.0.1:{port}/health', timeout=aiohttp.ClientTimeout(total=3)) as r:
            return r.status == 200
    except (TimeoutError, aiohttp.ClientError, OSError, ValueError):
        return False
