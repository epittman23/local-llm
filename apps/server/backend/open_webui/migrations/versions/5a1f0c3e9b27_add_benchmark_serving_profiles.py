"""add benchmark serving profiles

Moves the serving profiles out of local-llm's scripts/shell/main.sh
(`_lllm_profile`) and into two tables: benchmark_profile (identity) and
benchmark_profile_version (append-only definitions). Seeds the four profiles
that existed in main.sh on 2026-09-14 as version 1 of each, and adds a
nullable benchmark_run.profile_version_id so a run can record exactly which
definition it served.

The seed is a frozen literal copy, not read from docs/serving-baseline/ at
run time: a migration must produce the same rows forever, whatever happens
to files elsewhere in the repo later. It was taken from
docs/serving-baseline/profiles.json, with two deliberate differences:

  model_path keeps the `{LLAMA_MODELS}` placeholder rather than a resolved
  absolute path, so a row does not bake in one machine's home directory.
  The launcher resolves it against the serving host's LLAMA_MODELS.

  qwen38's `--chat-template-kwargs {"reasoning_effort":"medium"}` is not
  stored in `extra`; it is `reasoning_effort_default = 'medium'`. A literal
  there would fingerprint as an override but launch as the literal.

None of this changes any config_id: the fingerprint was ported to Python and
checked against all 37 configurations already stored in benchmark_config,
plus 24 captured shell cases, before this migration existed.

Revision ID: 5a1f0c3e9b27
Revises: b3f8a1d94e70
Create Date: 2026-09-14
"""

import time
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = '5a1f0c3e9b27'
down_revision: Union[str, None] = 'b3f8a1d94e70'
branch_labels = None
depends_on = None


SEED_NOTE = (
    'Seeded from scripts/shell/main.sh (_lllm_profile) on 2026-09-14, when the '
    'serving profiles moved into the database.'
)

SCHEMA_NOTE = (
    '2026-09-14: serving profiles moved from scripts/shell/main.sh into '
    'benchmark_profile / benchmark_profile_version, and benchmark_run gained '
    'profile_version_id. NULL there means the run predates database-stored '
    'profiles (or served a hand-started server); it does not mean "no profile". '
    'No config_id changed: the fingerprint moved from bash to Python and was '
    'verified identical against every configuration stored at the time.'
)

#: Frozen copy. Order is main.sh's LLAMA_PROFILE_NAMES; qwen38 was
#: LLAMA_DEFAULT_PROFILE.
SEED = [
    {
        'name': 'qwen38',
        'display_name': 'Qwen3.8 27B (dense)',
        'is_default': True,
        'definition': {
            'arch': 'dense',
            'alias': 'qwen3.8-27b',
            'model_path': '{LLAMA_MODELS}/qwen38-27b/Qwen3.8-27B-UD-Q3_K_XL.gguf',
            'hf_repo': 'unsloth/Qwen3.8-27B-GGUF',
            'hf_pattern': '*UD-Q3_K_XL*',
            'ctx': 16384,
            'threads': 12,
            'ngl': 20,
            'moe': None,
            'override_tensors': r'output\.weight=CUDA0,blk\.64\..*=CUDA0',
            'parallel': 1,
            'cache_k': 'q8_0',
            'cache_v': 'q8_0',
            'batch': 512,
            'ubatch': 512,
            'spec': ['--spec-type', 'draft-mtp', '--spec-draft-n-max', '2'],
            'samplers': ['--temp', '1.0', '--top-p', '0.95', '--top-k', '20', '--min-p', '0.0'],
            'extra': [],
            'reasoning_effort_default': 'medium',
            'notes': (
                'Dense 27B: every parameter is read on every forward pass, so -ngl has '
                'to be tuned by hand against the 6 GB of VRAM rather than set to 99. A '
                'dense model fails to allocate at -ngl 99 on this hardware.\n\n'
                '-ngl 20 is a placeholder: tune it before trusting it.\n\n'
                'Context is deliberately conservative at 16384. The model supports '
                '262144, but the KV cache competes directly with the weights for VRAM.\n\n'
                'Override-tensors pin the output projection and the last block to the '
                'GPU regardless of -ngl. There are 65 blocks (blk.0 to blk.64), and those '
                'two are hot on every token, so they earn their VRAM even when most '
                'layers stay on the CPU.\n\n'
                "Speculative decoding drafts off the model's own MTP head: the weights "
                'carry qwen35.nextn_predict_layers=1 and blk.64.nextn.* tensors, so no '
                'separate draft model is needed, and that head sits in blk.64, which the '
                'tensor override already pins to the GPU. Draft depth 2 is conservative: '
                'rejected drafts cost real compute on a CPU-bound model.\n\n'
                "Samplers are Qwen3.8's recommended thinking-mode set.\n\n"
                "Reasoning effort defaults to medium: xhigh is the model's own default "
                'and is punishing at 3-4 tokens/s.'
            ),
        },
    },
    {
        'name': 'qwen36',
        'display_name': 'Qwen3.6 35B-A3B (MoE)',
        'is_default': False,
        'definition': {
            'arch': 'moe',
            'alias': 'qwen3.6-35b-a3b',
            'model_path': '{LLAMA_MODELS}/qwen36-35b-a3b/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf',
            'hf_repo': 'unsloth/Qwen3.6-35B-A3B-GGUF',
            'hf_pattern': '*UD-Q4_K_XL*',
            'ctx': 65536,
            'threads': 6,
            'ngl': 99,
            'moe': 34,
            'override_tensors': None,
            'parallel': 1,
            'cache_k': 'q8_0',
            'cache_v': 'q8_0',
            'batch': 512,
            'ubatch': 512,
            'spec': [],
            'samplers': [],
            'extra': [],
            'reasoning_effort_default': None,
            'notes': (
                'Sparse MoE, ~3B active of 35B. All layers are offloaded (-ngl 99) and '
                'the expert tensors of 34 layers stay in system RAM (--n-cpu-moe 34), '
                'the measured optimum on 6 GB of VRAM. Generation is bound by system-RAM '
                'bandwidth for those experts, so thread count barely moves it; 6 threads '
                'is the default because nothing above it pays for itself.'
            ),
        },
    },
    {
        'name': 'qwen25c',
        'display_name': 'Qwen2.5-Coder 7B (dense, fits VRAM)',
        'is_default': False,
        'definition': {
            'arch': 'dense',
            'alias': 'qwen2.5-coder-7b',
            'model_path': '{LLAMA_MODELS}/qwen25-coder-7b/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',
            'hf_repo': 'unsloth/Qwen2.5-Coder-7B-Instruct-GGUF',
            'hf_pattern': '*Q4_K_M*',
            'ctx': 16384,
            'threads': 6,
            'ngl': 99,
            'moe': None,
            'override_tensors': None,
            'parallel': 1,
            'cache_k': 'q8_0',
            'cache_v': 'q8_0',
            'batch': 512,
            'ubatch': 512,
            'spec': [],
            'samplers': ['--temp', '0.7', '--top-p', '0.8', '--top-k', '20', '--repeat-penalty', '1.1'],
            'extra': [],
            'reasoning_effort_default': None,
            'notes': (
                'The first profile whose weights fit in VRAM outright: 4.36 GiB of 6, so '
                '-ngl 99 puts all 28 blocks and the output head on the GPU and nothing '
                'is read from system RAM. There is no -ngl to tune and no tensor override '
                'to pin; the larger profiles have those only because their models are '
                '3-5x the size of this card.\n\n'
                "Context is 16384, not the model's full 32768. This GGUF is 28 layers "
                'with 4 KV heads of 128, so a q8_0 KV cache costs ~29.7 KiB/token: ~476 '
                'MiB at 16K, ~952 MiB at 32K, on top of 4.36 GiB of weights and the '
                'compute buffer. The full window fits inside 6 GiB only with less room '
                'than the 300 MiB VRAM-headroom warning allows. Raise it with a context '
                'override and check headroom if the context is worth more than the '
                'margin.\n\n'
                'Threads only assemble batches here; no layer runs on the CPU.\n\n'
                "Samplers are Qwen2.5-Coder's own generation_config.json, not the Qwen3.8 "
                'thinking-mode set. Benchmark requests pin temperature to 0 in the request '
                'body regardless, so these govern chat traffic.\n\n'
                'No speculative decoding: Qwen2.5 predates the nextn/MTP tensors qwen38 '
                'drafts from, and no draft model is worth 4.36 GiB of this card. No '
                'reasoning effort: not a thinking model, so there is no budget to set '
                'and no reasoning_content in its responses.'
            ),
        },
    },
    {
        'name': 'qwen3c',
        'display_name': 'Qwen3-Coder 30B-A3B (MoE)',
        'is_default': False,
        'definition': {
            'arch': 'moe',
            'alias': 'qwen3-coder-30b-a3b',
            'model_path': '{LLAMA_MODELS}/qwen3-coder-30b-a3b/Qwen3-Coder-30B-A3B-Instruct-Q4_1.gguf',
            'hf_repo': 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF',
            'hf_pattern': '*Q4_1*',
            'ctx': 65536,
            'threads': 6,
            'ngl': 99,
            'moe': 34,
            'override_tensors': None,
            'parallel': 1,
            'cache_k': 'q8_0',
            'cache_v': 'q8_0',
            'batch': 512,
            'ubatch': 512,
            'spec': [],
            'samplers': [],
            'extra': [],
            'reasoning_effort_default': None,
            'notes': (
                "Sparse MoE, coding only. This copies qwen36's MoE shape (-ngl 99, "
                '--n-cpu-moe 34, q8_0 KV cache, 65536 context, 6 threads) as an '
                'unverified starting point, not a tuned configuration. main.sh labelled '
                '--n-cpu-moe 34 "measured optimum on 6 GB VRAM", but that measurement '
                "was qwen36's; nothing about this profile had been measured when it was "
                'seeded.'
            ),
        },
    },
]


def _index_exists(inspector, index_name, table_name):
    return any(idx['name'] == index_name for idx in inspector.get_indexes(table_name))


def _seed(conn):
    """Insert the four profiles, but only into an empty table.

    Guarded on emptiness rather than on "the table was just created", so a
    table that exists for any other reason is never double-seeded, and a
    re-run of this migration is a no-op.
    """
    profile = sa.table(
        'benchmark_profile',
        sa.column('profile_id', sa.Integer),
        sa.column('name', sa.Text),
        sa.column('display_name', sa.Text),
        sa.column('is_default', sa.Boolean),
        sa.column('created_at', sa.BigInteger),
    )
    if conn.execute(sa.select(sa.func.count()).select_from(profile)).scalar():
        return

    version = sa.table(
        'benchmark_profile_version',
        sa.column('profile_id', sa.Integer),
        sa.column('version', sa.Integer),
        sa.column('created_at', sa.BigInteger),
        sa.column('created_by', sa.Text),
        sa.column('note', sa.Text),
        sa.column('arch', sa.Text),
        sa.column('alias', sa.Text),
        sa.column('model_path', sa.Text),
        sa.column('hf_repo', sa.Text),
        sa.column('hf_pattern', sa.Text),
        sa.column('ctx', sa.Integer),
        sa.column('threads', sa.Integer),
        sa.column('ngl', sa.Integer),
        sa.column('moe', sa.Integer),
        sa.column('override_tensors', sa.Text),
        sa.column('parallel', sa.Integer),
        sa.column('cache_k', sa.Text),
        sa.column('cache_v', sa.Text),
        sa.column('batch', sa.Integer),
        sa.column('ubatch', sa.Integer),
        sa.column('spec', sa.JSON),
        sa.column('samplers', sa.JSON),
        sa.column('extra', sa.JSON),
        sa.column('reasoning_effort_default', sa.Text),
        sa.column('notes', sa.Text),
    )

    now = int(time.time())
    for entry in SEED:
        conn.execute(
            profile.insert().values(
                name=entry['name'],
                display_name=entry['display_name'],
                is_default=entry['is_default'],
                created_at=now,
            )
        )
        profile_id = conn.execute(sa.select(profile.c.profile_id).where(profile.c.name == entry['name'])).scalar_one()
        conn.execute(
            version.insert().values(
                profile_id=profile_id,
                version=1,
                created_at=now,
                created_by=None,
                note=SEED_NOTE,
                **entry['definition'],
            )
        )


def _add_schema_note(conn):
    note = sa.table(
        'benchmark_schema_note',
        sa.column('noted_on', sa.Text),
        sa.column('note', sa.Text),
    )
    exists = conn.execute(sa.select(sa.func.count()).select_from(note).where(note.c.note == SCHEMA_NOTE)).scalar()
    if not exists:
        conn.execute(note.insert().values(noted_on='2026-09-14', note=SCHEMA_NOTE))


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    tables = inspector.get_table_names()

    if 'benchmark_profile' not in tables:
        op.create_table(
            'benchmark_profile',
            sa.Column('profile_id', sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column('name', sa.Text(), nullable=False, unique=True),
            sa.Column('display_name', sa.Text(), nullable=False),
            sa.Column('is_default', sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column('created_at', sa.BigInteger(), nullable=False),
            sa.Column('archived_at', sa.BigInteger(), nullable=True),
        )

    inspector.clear_cache()
    if not _index_exists(inspector, 'ux_benchmark_profile_default', 'benchmark_profile'):
        op.create_index(
            'ux_benchmark_profile_default',
            'benchmark_profile',
            ['is_default'],
            unique=True,
            postgresql_where=sa.text('is_default'),
            sqlite_where=sa.text('is_default'),
        )

    if 'benchmark_profile_version' not in tables:
        op.create_table(
            'benchmark_profile_version',
            sa.Column('version_id', sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column('profile_id', sa.Integer(), sa.ForeignKey('benchmark_profile.profile_id'), nullable=False),
            sa.Column('version', sa.Integer(), nullable=False),
            sa.Column('created_at', sa.BigInteger(), nullable=False),
            sa.Column('created_by', sa.Text(), nullable=True),
            sa.Column('note', sa.Text(), nullable=True),
            sa.Column('arch', sa.Text(), nullable=False),
            sa.Column('alias', sa.Text(), nullable=False),
            sa.Column('model_path', sa.Text(), nullable=False),
            sa.Column('hf_repo', sa.Text(), nullable=False, server_default=''),
            sa.Column('hf_pattern', sa.Text(), nullable=False, server_default=''),
            sa.Column('ctx', sa.Integer(), nullable=False),
            sa.Column('threads', sa.Integer(), nullable=False),
            sa.Column('ngl', sa.Integer(), nullable=False),
            sa.Column('moe', sa.Integer(), nullable=True),
            sa.Column('override_tensors', sa.Text(), nullable=True),
            sa.Column('parallel', sa.Integer(), nullable=False, server_default='1'),
            sa.Column('cache_k', sa.Text(), nullable=False, server_default='q8_0'),
            sa.Column('cache_v', sa.Text(), nullable=False, server_default='q8_0'),
            sa.Column('batch', sa.Integer(), nullable=False, server_default='512'),
            sa.Column('ubatch', sa.Integer(), nullable=False, server_default='512'),
            sa.Column('spec', sa.JSON(), nullable=False),
            sa.Column('samplers', sa.JSON(), nullable=False),
            sa.Column('extra', sa.JSON(), nullable=False),
            sa.Column('reasoning_effort_default', sa.Text(), nullable=True),
            sa.Column('notes', sa.Text(), nullable=False, server_default=''),
            sa.UniqueConstraint('profile_id', 'version', name='uq_benchmark_profile_version'),
            sa.CheckConstraint("arch IN ('dense','moe')", name='ck_benchmark_profile_version_arch'),
            sa.CheckConstraint("arch <> 'dense' OR moe IS NULL", name='ck_benchmark_profile_version_dense_moe'),
        )

    inspector.clear_cache()
    run_columns = {c['name'] for c in inspector.get_columns('benchmark_run')}
    if 'profile_version_id' not in run_columns:
        # batch mode so the FK can be added on SQLite too; on Postgres this is
        # a plain ALTER TABLE.
        with op.batch_alter_table('benchmark_run') as batch:
            batch.add_column(sa.Column('profile_version_id', sa.Integer(), nullable=True))
            batch.create_foreign_key(
                'fk_benchmark_run_profile_version',
                'benchmark_profile_version',
                ['profile_version_id'],
                ['version_id'],
            )

    _seed(conn)
    _add_schema_note(conn)


def downgrade():
    conn = op.get_bind()
    with op.batch_alter_table('benchmark_run') as batch:
        batch.drop_constraint('fk_benchmark_run_profile_version', type_='foreignkey')
        batch.drop_column('profile_version_id')
    op.drop_table('benchmark_profile_version')
    op.drop_index('ux_benchmark_profile_default', table_name='benchmark_profile')
    op.drop_table('benchmark_profile')
    note = sa.table('benchmark_schema_note', sa.column('note', sa.Text))
    conn.execute(note.delete().where(note.c.note == SCHEMA_NOTE))
