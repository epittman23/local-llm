"""add the llama-bench pre-screen tables, and the optuna schema its studies live in

Revision ID: c8e1f5a2d907
Revises: b7d2c4e6f813
Create Date: 2026-10-28

The pre-screen (docs/plans/benchmark-upgrade.md, section 7.4) runs
llama-bench over a grid of offload and batch flags, one process per point,
to find candidates worth a full Tests run. Its numbers are raw llama-bench
throughput, not serving measurements, so they get tables of their own and
never join benchmark_run or benchmark_result.

- `benchmark_prescreen_sweep`: one row per pre-screen, with the context
  every number needs (model file, llama.cpp build, GPU, driver, RAM,
  kernel, grid sha, llama-bench settings).
- `benchmark_prescreen_point`: one row per measured, pruned or skipped
  point, and one per re-measurement of a leading point.
- `CREATE SCHEMA optuna`, and nothing in it. Optuna creates and migrates
  its own tables there (the owner's decision D13, 2026-10-19). Its own
  Alembic history keeps its `alembic_version` table in that schema, apart
  from this app's in `public`. Postgres only: SQLite has no schemas, and
  the pre-screen refuses to run without Postgres.
"""

import sqlalchemy as sa
from alembic import op

revision: str = 'c8e1f5a2d907'
down_revision: str | None = 'b7d2c4e6f813'
branch_labels = None
depends_on = None

SCHEMA_NOTE = (
    'benchmark_prescreen_sweep and benchmark_prescreen_point added: raw llama-bench '
    'throughput from the pre-screen, kept apart from serving runs and never shown on '
    'Compare or Report. The optuna schema holds Optuna\'s copy of each pre-screen study, '
    'created and migrated by Optuna itself; the benchmark_prescreen_* tables are the '
    'record. config_id is unchanged.'
)

SWEEP_STATUSES = "('running','done','cancelled','failed','stale')"
SAMPLERS = "('grid','tpe')"
OBJECTIVES = "('tg','pp','both')"
POINT_STATUSES = (
    "('running','ok','oom','load_error','crash','timeout','parse_error','pruned','invalid','repeat','cancelled')"
)
PHASES = "('search','remeasure')"
CTX_CHECKS = "('ok','oom_at_ctx','load_error','timeout','skipped')"


def upgrade():
    conn = op.get_bind()
    tables = set(sa.inspect(conn).get_table_names())

    if 'benchmark_prescreen_sweep' not in tables:
        op.create_table(
            'benchmark_prescreen_sweep',
            sa.Column('sweep_id', sa.Text(), primary_key=True),
            sa.Column('started_at', sa.BigInteger(), nullable=False),
            sa.Column('ended_at', sa.BigInteger(), nullable=True),
            sa.Column('status', sa.Text(), nullable=False),
            sa.Column('status_reason', sa.Text(), nullable=True),
            sa.Column('pid', sa.Integer(), nullable=True),
            sa.Column('profile', sa.Text(), nullable=False),
            sa.Column(
                'profile_version_id',
                sa.Integer(),
                sa.ForeignKey('benchmark_profile_version.version_id'),
                nullable=True,
            ),
            sa.Column('sampler', sa.Text(), nullable=False),
            sa.Column('seed', sa.Integer(), nullable=False),
            sa.Column('trial_budget', sa.Integer(), nullable=True),
            sa.Column('objective', sa.Text(), nullable=False),
            sa.Column('study_name', sa.Text(), nullable=False),
            sa.Column('grid_path', sa.Text(), nullable=False),
            sa.Column('grid_sha', sa.Text(), nullable=False),
            sa.Column('n_prompt', sa.Integer(), nullable=False),
            sa.Column('n_gen', sa.Integer(), nullable=False),
            sa.Column('reps', sa.Integer(), nullable=False),
            sa.Column('point_timeout', sa.Integer(), nullable=False),
            sa.Column('ctx_checks', sa.Integer(), nullable=False),
            sa.Column('model_file', sa.Text(), nullable=False),
            sa.Column('model_bytes', sa.BigInteger(), nullable=True),
            sa.Column('build_commit', sa.Text(), nullable=True),
            sa.Column('build_number', sa.Integer(), nullable=True),
            sa.Column('gpu_info', sa.Text(), nullable=True),
            sa.Column('cpu_info', sa.Text(), nullable=True),
            sa.Column('driver_version', sa.Text(), nullable=True),
            sa.Column('vram_total_mib', sa.Integer(), nullable=True),
            sa.Column('ram_total_mib', sa.Integer(), nullable=True),
            sa.Column('kernel', sa.Text(), nullable=True),
            sa.CheckConstraint(f'status IN {SWEEP_STATUSES}', name='ck_benchmark_prescreen_sweep_status'),
            sa.CheckConstraint(f'sampler IN {SAMPLERS}', name='ck_benchmark_prescreen_sweep_sampler'),
            sa.CheckConstraint(f'objective IN {OBJECTIVES}', name='ck_benchmark_prescreen_sweep_objective'),
        )

    if 'benchmark_prescreen_point' not in tables:
        op.create_table(
            'benchmark_prescreen_point',
            sa.Column('point_id', sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column(
                'sweep_id',
                sa.Text(),
                sa.ForeignKey('benchmark_prescreen_sweep.sweep_id', ondelete='CASCADE'),
                nullable=False,
            ),
            sa.Column('phase', sa.Text(), nullable=False),
            sa.Column('optuna_trial_number', sa.Integer(), nullable=True),
            sa.Column(
                'remeasure_of',
                sa.Integer(),
                sa.ForeignKey('benchmark_prescreen_point.point_id', ondelete='CASCADE'),
                nullable=True,
            ),
            sa.Column('is_baseline', sa.Boolean(), nullable=False),
            sa.Column('overrides', sa.JSON(), nullable=False),
            sa.Column('argv', sa.JSON(), nullable=True),
            sa.Column('config_id', sa.Text(), nullable=True),
            sa.Column('status', sa.Text(), nullable=False),
            sa.Column('reason', sa.Text(), nullable=True),
            sa.Column(
                'pruned_by',
                sa.Integer(),
                sa.ForeignKey('benchmark_prescreen_point.point_id', ondelete='SET NULL'),
                nullable=True,
            ),
            sa.Column('pgid', sa.Integer(), nullable=True),
            sa.Column('started_at', sa.BigInteger(), nullable=False),
            sa.Column('ended_at', sa.BigInteger(), nullable=True),
            sa.Column('pp_avg_ts', sa.Float(), nullable=True),
            sa.Column('pp_stddev_ts', sa.Float(), nullable=True),
            sa.Column('pp_samples_ts', sa.JSON(), nullable=True),
            sa.Column('tg_avg_ts', sa.Float(), nullable=True),
            sa.Column('tg_stddev_ts', sa.Float(), nullable=True),
            sa.Column('tg_samples_ts', sa.JSON(), nullable=True),
            sa.Column('raw_jsonl', sa.Text(), nullable=True),
            sa.Column('stderr_tail', sa.Text(), nullable=True),
            sa.Column('peak_vram_mib', sa.Integer(), nullable=True),
            sa.Column('peak_power_w', sa.Float(), nullable=True),
            sa.Column('peak_temp_c', sa.Integer(), nullable=True),
            sa.Column('throttle_reasons', sa.Text(), nullable=True),
            sa.Column('ctx_check', sa.Text(), nullable=True),
            sa.Column('ctx_check_free_mib', sa.Integer(), nullable=True),
            sa.Column('ctx_check_reason', sa.Text(), nullable=True),
            sa.CheckConstraint(f'status IN {POINT_STATUSES}', name='ck_benchmark_prescreen_point_status'),
            sa.CheckConstraint(f'phase IN {PHASES}', name='ck_benchmark_prescreen_point_phase'),
            sa.CheckConstraint(
                f'ctx_check IS NULL OR ctx_check IN {CTX_CHECKS}', name='ck_benchmark_prescreen_point_ctx_check'
            ),
        )
        op.create_index('ix_benchmark_prescreen_point_sweep_id', 'benchmark_prescreen_point', ['sweep_id'])

    if conn.dialect.name == 'postgresql':
        op.execute('CREATE SCHEMA IF NOT EXISTS optuna')

    note = sa.table('benchmark_schema_note', sa.column('noted_on', sa.Text), sa.column('note', sa.Text))
    exists = conn.execute(sa.select(sa.func.count()).select_from(note).where(note.c.note == SCHEMA_NOTE)).scalar()
    if not exists:
        conn.execute(note.insert().values(noted_on='2026-10-28', note=SCHEMA_NOTE))


def downgrade():
    conn = op.get_bind()
    note = sa.table('benchmark_schema_note', sa.column('note', sa.Text))
    conn.execute(note.delete().where(note.c.note == SCHEMA_NOTE))
    if conn.dialect.name == 'postgresql':
        # Optuna's copy of the studies only; the record is the two tables below.
        op.execute('DROP SCHEMA IF EXISTS optuna CASCADE')
    op.drop_index('ix_benchmark_prescreen_point_sweep_id', table_name='benchmark_prescreen_point')
    op.drop_table('benchmark_prescreen_point')
    op.drop_table('benchmark_prescreen_sweep')
