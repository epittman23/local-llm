"""add benchmark_result.cluster

Revision ID: c7e2a9d41b05
Revises: 5a1f0c3e9b27
Create Date: 2026-10-19

The problem's cluster, written at result time from the adapter's
`[item] cluster_fields`, so Compare and Report can compute cluster-robust
standard errors from the database alone, without the dataset file being
present or unchanged. NULL means the problem is treated as independent.
"""

import sqlalchemy as sa
from alembic import op

revision: str = 'c7e2a9d41b05'
down_revision: str | None = '5a1f0c3e9b27'
branch_labels = None
depends_on = None

SCHEMA_NOTE = (
    'benchmark_result.cluster added: the cluster a problem belongs to, for '
    'cluster-robust standard errors (DS-1000: library and '
    'perturbation_origin_id). NULL means independent. Compare and Report now '
    'average within each problem before comparing, and compare configurations '
    'as paired differences on shared problems, with Holm across the pairs.'
)


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = {c['name'] for c in inspector.get_columns('benchmark_result')}
    if 'cluster' not in columns:
        op.add_column('benchmark_result', sa.Column('cluster', sa.Text(), nullable=True))

    note = sa.table('benchmark_schema_note', sa.column('noted_on', sa.Text), sa.column('note', sa.Text))
    exists = conn.execute(sa.select(sa.func.count()).select_from(note).where(note.c.note == SCHEMA_NOTE)).scalar()
    if not exists:
        conn.execute(note.insert().values(noted_on='2026-10-19', note=SCHEMA_NOTE))


def downgrade():
    conn = op.get_bind()
    note = sa.table('benchmark_schema_note', sa.column('note', sa.Text))
    conn.execute(note.delete().where(note.c.note == SCHEMA_NOTE))
    op.drop_column('benchmark_result', 'cluster')
