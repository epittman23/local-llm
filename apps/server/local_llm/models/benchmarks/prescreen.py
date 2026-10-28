import time
import uuid

from pydantic import BaseModel, ConfigDict
from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    Float,
    ForeignKey,
    Index,
    Integer,
    Text,
    insert,
    select,
    update,
)
from sqlalchemy.ext.asyncio import AsyncSession

from local_llm.internal.db import Base, get_async_db_context
from local_llm.models.benchmarks.profiles import BenchmarkProfileVersion

####################
# Benchmark Pre-screen DB Schema
#
# Raw llama-bench throughput from the pre-screen
# (local_llm/benchmarks/prescreen/), migration c8e1f5a2d907. Kept apart from
# benchmark_run and benchmark_result on purpose: llama-bench measures the
# model at a test-sized context, not a served configuration, so none of
# these numbers may be compared with a Tests run. Optuna's own copy of each
# study lives in the `optuna` schema; these two tables are the record.
#
# A point is identified by point_id, not config_id. config_id here is the
# fingerprint the point would have if served with these overrides, so that a
# candidate can be matched to a later Tests run, and is not a foreign key:
# nothing is served, so benchmark_config has no row for it.
####################

SWEEP_STATUSES = ('running', 'done', 'cancelled', 'failed', 'stale')
SAMPLERS = ('grid', 'tpe')
OBJECTIVES = ('tg', 'pp', 'both')
POINT_STATUSES = (
    'running',
    'ok',
    'oom',
    'load_error',
    'crash',
    'timeout',
    'parse_error',
    'pruned',
    'invalid',
    'repeat',
    'cancelled',
)
PHASES = ('search', 'remeasure')
CTX_CHECKS = ('ok', 'oom_at_ctx', 'load_error', 'timeout', 'skipped')


class BenchmarkPrescreenSweep(Base):
    __tablename__ = 'benchmark_prescreen_sweep'
    __table_args__ = (
        CheckConstraint(f'status IN {SWEEP_STATUSES!r}', name='ck_benchmark_prescreen_sweep_status'),
        CheckConstraint(f'sampler IN {SAMPLERS!r}', name='ck_benchmark_prescreen_sweep_sampler'),
        CheckConstraint(f'objective IN {OBJECTIVES!r}', name='ck_benchmark_prescreen_sweep_objective'),
    )
    sweep_id = Column(Text, primary_key=True)
    started_at = Column(BigInteger, nullable=False)
    ended_at = Column(BigInteger, nullable=True)
    status = Column(Text, nullable=False)
    status_reason = Column(Text, nullable=True)
    pid = Column(Integer, nullable=True)
    profile = Column(Text, nullable=False)
    profile_version_id = Column(Integer, ForeignKey(BenchmarkProfileVersion.version_id), nullable=True)
    sampler = Column(Text, nullable=False)
    seed = Column(Integer, nullable=False)
    trial_budget = Column(Integer, nullable=True)
    objective = Column(Text, nullable=False)
    study_name = Column(Text, nullable=False)
    grid_path = Column(Text, nullable=False)
    grid_sha = Column(Text, nullable=False)
    n_prompt = Column(Integer, nullable=False)
    n_gen = Column(Integer, nullable=False)
    reps = Column(Integer, nullable=False)
    point_timeout = Column(Integer, nullable=False)
    ctx_checks = Column(Integer, nullable=False)
    model_file = Column(Text, nullable=False)
    model_bytes = Column(BigInteger, nullable=True)
    build_commit = Column(Text, nullable=True)
    build_number = Column(Integer, nullable=True)
    gpu_info = Column(Text, nullable=True)
    cpu_info = Column(Text, nullable=True)
    driver_version = Column(Text, nullable=True)
    vram_total_mib = Column(Integer, nullable=True)
    ram_total_mib = Column(Integer, nullable=True)
    kernel = Column(Text, nullable=True)


class BenchmarkPrescreenSweepModel(BaseModel):
    sweep_id: str
    started_at: int
    ended_at: int | None = None
    status: str
    status_reason: str | None = None
    pid: int | None = None
    profile: str
    profile_version_id: int | None = None
    sampler: str
    seed: int
    trial_budget: int | None = None
    objective: str
    study_name: str
    grid_path: str
    grid_sha: str
    n_prompt: int
    n_gen: int
    reps: int
    point_timeout: int
    ctx_checks: int
    model_file: str
    model_bytes: int | None = None
    build_commit: str | None = None
    build_number: int | None = None
    gpu_info: str | None = None
    cpu_info: str | None = None
    driver_version: str | None = None
    vram_total_mib: int | None = None
    ram_total_mib: int | None = None
    kernel: str | None = None

    model_config = ConfigDict(from_attributes=True)


class BenchmarkPrescreenPoint(Base):
    __tablename__ = 'benchmark_prescreen_point'
    __table_args__ = (
        CheckConstraint(f'status IN {POINT_STATUSES!r}', name='ck_benchmark_prescreen_point_status'),
        CheckConstraint(f'phase IN {PHASES!r}', name='ck_benchmark_prescreen_point_phase'),
        CheckConstraint(
            f'ctx_check IS NULL OR ctx_check IN {CTX_CHECKS!r}', name='ck_benchmark_prescreen_point_ctx_check'
        ),
        Index('ix_benchmark_prescreen_point_sweep_id', 'sweep_id'),
    )
    point_id = Column(Integer, primary_key=True, autoincrement=True)
    sweep_id = Column(Text, ForeignKey('benchmark_prescreen_sweep.sweep_id', ondelete='CASCADE'), nullable=False)
    phase = Column(Text, nullable=False)
    optuna_trial_number = Column(Integer, nullable=True)
    remeasure_of = Column(Integer, ForeignKey('benchmark_prescreen_point.point_id', ondelete='CASCADE'), nullable=True)
    is_baseline = Column(Boolean, nullable=False)
    overrides = Column(JSON, nullable=False)
    argv = Column(JSON, nullable=True)
    config_id = Column(Text, nullable=True)
    status = Column(Text, nullable=False)
    reason = Column(Text, nullable=True)
    pruned_by = Column(Integer, ForeignKey('benchmark_prescreen_point.point_id', ondelete='SET NULL'), nullable=True)
    pgid = Column(Integer, nullable=True)
    started_at = Column(BigInteger, nullable=False)
    ended_at = Column(BigInteger, nullable=True)
    pp_avg_ts = Column(Float, nullable=True)
    pp_stddev_ts = Column(Float, nullable=True)
    pp_samples_ts = Column(JSON, nullable=True)
    tg_avg_ts = Column(Float, nullable=True)
    tg_stddev_ts = Column(Float, nullable=True)
    tg_samples_ts = Column(JSON, nullable=True)
    raw_jsonl = Column(Text, nullable=True)
    stderr_tail = Column(Text, nullable=True)
    peak_vram_mib = Column(Integer, nullable=True)
    peak_power_w = Column(Float, nullable=True)
    peak_temp_c = Column(Integer, nullable=True)
    throttle_reasons = Column(Text, nullable=True)
    ctx_check = Column(Text, nullable=True)
    ctx_check_free_mib = Column(Integer, nullable=True)
    ctx_check_reason = Column(Text, nullable=True)


class BenchmarkPrescreenPointModel(BaseModel):
    point_id: int
    sweep_id: str
    phase: str
    optuna_trial_number: int | None = None
    remeasure_of: int | None = None
    is_baseline: bool
    overrides: dict
    argv: list[str] | None = None
    config_id: str | None = None
    status: str
    reason: str | None = None
    pruned_by: int | None = None
    pgid: int | None = None
    started_at: int
    ended_at: int | None = None
    pp_avg_ts: float | None = None
    pp_stddev_ts: float | None = None
    pp_samples_ts: list[float] | None = None
    tg_avg_ts: float | None = None
    tg_stddev_ts: float | None = None
    tg_samples_ts: list[float] | None = None
    raw_jsonl: str | None = None
    stderr_tail: str | None = None
    peak_vram_mib: int | None = None
    peak_power_w: float | None = None
    peak_temp_c: int | None = None
    throttle_reasons: str | None = None
    ctx_check: str | None = None
    ctx_check_free_mib: int | None = None
    ctx_check_reason: str | None = None

    model_config = ConfigDict(from_attributes=True)


#: The columns a caller may set on a sweep after it is opened. Identity and
#: the settings that define the search are fixed at open_sweep().
SWEEP_UPDATABLE = (
    'status',
    'status_reason',
    'build_commit',
    'build_number',
    'gpu_info',
    'cpu_info',
)

#: The same for a point: what it is (sweep, phase, trial, overrides) is
#: fixed when it is opened; what happened to it is not.
POINT_UPDATABLE = (
    'status',
    'reason',
    'pruned_by',
    'pgid',
    'argv',
    'ended_at',
    'pp_avg_ts',
    'pp_stddev_ts',
    'pp_samples_ts',
    'tg_avg_ts',
    'tg_stddev_ts',
    'tg_samples_ts',
    'raw_jsonl',
    'stderr_tail',
    'peak_vram_mib',
    'peak_power_w',
    'peak_temp_c',
    'throttle_reasons',
    'ctx_check',
    'ctx_check_free_mib',
    'ctx_check_reason',
)


class BenchmarkPrescreenSweepTable:
    @staticmethod
    def new_id() -> str:
        return f'{int(time.time())}-{uuid.uuid4().hex[:6]}'

    async def open_sweep(self, sweep_id: str, db: AsyncSession | None = None, **fields) -> str:
        async with get_async_db_context(db) as db:
            db.add(BenchmarkPrescreenSweep(sweep_id=sweep_id, started_at=int(time.time()), status='running', **fields))
            await db.commit()
            return sweep_id

    async def set_sweep(self, sweep_id: str, db: AsyncSession | None = None, **fields) -> None:
        sets = {k: v for k, v in fields.items() if k in SWEEP_UPDATABLE}
        if not sets:
            return
        async with get_async_db_context(db) as db:
            result = await db.execute(select(BenchmarkPrescreenSweep).filter_by(sweep_id=sweep_id))
            row = result.scalars().first()
            if row:
                for k, v in sets.items():
                    setattr(row, k, v)
                await db.commit()

    async def close_sweep(
        self, sweep_id: str, *, status: str, reason: str | None = None, db: AsyncSession | None = None
    ) -> None:
        """Record how a sweep ended. Only a running sweep is closed, so a
        stale-sweep reclaim never overwrites a sweep that already closed."""
        async with get_async_db_context(db) as db:
            await db.execute(
                update(BenchmarkPrescreenSweep)
                .where(BenchmarkPrescreenSweep.sweep_id == sweep_id, BenchmarkPrescreenSweep.status == 'running')
                .values(status=status, status_reason=reason, ended_at=int(time.time()))
            )
            await db.commit()

    async def get_by_id(self, sweep_id: str, db: AsyncSession | None = None) -> BenchmarkPrescreenSweepModel | None:
        async with get_async_db_context(db) as db:
            result = await db.execute(select(BenchmarkPrescreenSweep).filter_by(sweep_id=sweep_id))
            row = result.scalars().first()
            return BenchmarkPrescreenSweepModel.model_validate(row) if row else None

    async def list_sweeps(
        self, limit: int = 20, *, running_only: bool = False, db: AsyncSession | None = None
    ) -> list[BenchmarkPrescreenSweepModel]:
        async with get_async_db_context(db) as db:
            query = select(BenchmarkPrescreenSweep)
            if running_only:
                query = query.filter(BenchmarkPrescreenSweep.status == 'running')
            query = query.order_by(BenchmarkPrescreenSweep.started_at.desc()).limit(limit)
            result = await db.execute(query)
            return [BenchmarkPrescreenSweepModel.model_validate(row) for row in result.scalars().all()]


class BenchmarkPrescreenPointTable:
    async def open_point(
        self,
        sweep_id: str,
        *,
        phase: str,
        overrides: dict,
        is_baseline: bool = False,
        optuna_trial_number: int | None = None,
        remeasure_of: int | None = None,
        config_id: str | None = None,
        status: str = 'running',
        db: AsyncSession | None = None,
        **fields,
    ) -> int:
        async with get_async_db_context(db) as db:
            result = await db.execute(
                insert(BenchmarkPrescreenPoint)
                .values(
                    sweep_id=sweep_id,
                    phase=phase,
                    overrides=overrides,
                    is_baseline=is_baseline,
                    optuna_trial_number=optuna_trial_number,
                    remeasure_of=remeasure_of,
                    config_id=config_id,
                    status=status,
                    started_at=int(time.time()),
                    **{k: v for k, v in fields.items() if k in POINT_UPDATABLE},
                )
                .returning(BenchmarkPrescreenPoint.point_id)
            )
            point_id = result.scalar_one()
            await db.commit()
            return point_id

    async def set_point(self, point_id: int, db: AsyncSession | None = None, **fields) -> None:
        sets = {k: v for k, v in fields.items() if k in POINT_UPDATABLE}
        if not sets:
            return
        async with get_async_db_context(db) as db:
            result = await db.execute(select(BenchmarkPrescreenPoint).filter_by(point_id=point_id))
            row = result.scalars().first()
            if row:
                for k, v in sets.items():
                    setattr(row, k, v)
                await db.commit()

    async def sweep_points(self, sweep_id: str, db: AsyncSession | None = None) -> list[BenchmarkPrescreenPointModel]:
        async with get_async_db_context(db) as db:
            result = await db.execute(
                select(BenchmarkPrescreenPoint).filter_by(sweep_id=sweep_id).order_by(BenchmarkPrescreenPoint.point_id)
            )
            return [BenchmarkPrescreenPointModel.model_validate(row) for row in result.scalars().all()]


BenchmarkPrescreenSweeps = BenchmarkPrescreenSweepTable()
BenchmarkPrescreenPoints = BenchmarkPrescreenPointTable()
