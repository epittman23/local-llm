"""Tests for stored profile definitions, and for the seed migration's data.

The seed tests are the ones that matter. The migration that moves the serving
profiles into Postgres (5a1f0c3e9b27) carries a frozen literal copy of them.
These check that literal against the golden fingerprints captured from the
shell before it was retired, and against the captured profile settings field
by field -- with no database. A transcription slip in the seed shows up here
as a failing test, rather than months later as a configuration served under
the wrong flags or filed under the wrong config_id.

Run from the backend directory:

    python -m pytest tests/test_serving_profiles.py
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest
from open_webui.benchmarks.serving.fingerprint import config_id, config_lines
from open_webui.benchmarks.serving.profiles import (
    Overrides,
    ProfileError,
    ServingProfile,
    resolve,
    validate_definition,
)

BACKEND = Path(__file__).resolve().parents[1]
#: backend/tests/ -> backend/ -> apps/openwebui/ -> apps/ -> repo root
REPO_ROOT = Path(__file__).resolve().parents[4]
BASELINE_DIR = REPO_ROOT / 'docs' / 'serving-baseline'
MIGRATION = BACKEND / 'open_webui' / 'migrations' / 'versions' / '5a1f0c3e9b27_add_benchmark_serving_profiles.py'


def _load_json(name: str):
    path = BASELINE_DIR / name
    if not path.exists():  # pragma: no cover - only when run outside the repo
        pytest.skip(f'serving baseline not found at {path}')
    return json.loads(path.read_text())


def _golden_cases():
    return _load_json('fingerprints.json')['cases']


@pytest.fixture(scope='module')
def seed() -> dict[str, dict]:
    """The migration's SEED literal, loaded straight from the revision file."""
    spec = importlib.util.spec_from_file_location('benchmark_profiles_seed_migration', MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return {entry['name']: entry for entry in module.SEED}


# ---------------------------------------------------------------------------
# The seed migration's data
# ---------------------------------------------------------------------------


def test_seed_holds_exactly_the_shell_profiles(seed):
    assert set(seed) == {'qwen38', 'qwen36', 'qwen25c', 'qwen3c'}
    defaults = [name for name, entry in seed.items() if entry['is_default']]
    assert defaults == ['qwen38'], "main.sh's LLAMA_DEFAULT_PROFILE was qwen38"


@pytest.mark.parametrize('case', _golden_cases(), ids=lambda c: c['case'])
def test_seed_reproduces_golden_fingerprints(case, seed):
    """Every captured shell case, recomputed from the seed literal."""
    profile = ServingProfile.from_definition(case['profile'], seed[case['profile']]['definition'])
    resolved = resolve(profile, Overrides.from_env(case['env']))
    assert config_lines(resolved) == case['lines'], case['note']
    assert config_id(resolved) == case['config_id'], case['note']


def test_seed_matches_captured_profiles_field_by_field(seed):
    """Everything outside the fingerprint, too: hf_repo, pattern, model path.

    The fingerprint test above cannot see a wrong weights path or Hugging Face
    pattern, because neither is fingerprinted. This one can.
    """
    captured = {row['name']: row for row in _load_json('profiles.json')}
    assert set(captured) == set(seed)
    for name, row in captured.items():
        definition = seed[name]['definition']
        for key, value in row.items():
            if key in ('name', 'extra'):
                continue
            assert definition[key] == value, f'{name}.{key}'


def test_seed_moves_the_thinking_budget_out_of_extra(seed):
    """The one deliberate difference from the capture.

    The shell baked --chat-template-kwargs {"reasoning_effort":"medium"}
    into qwen38's extra arguments. Stored that way, an override would be
    fingerprinted as the override but launched as the literal, so the seed
    carries it as reasoning_effort_default instead.
    """
    captured = {row['name']: row for row in _load_json('profiles.json')}
    for name, row in captured.items():
        definition = seed[name]['definition']
        assert definition['extra'] == []
        thinking = any('reasoning_effort' in arg for arg in row['extra'])
        assert definition['reasoning_effort_default'] == ('medium' if thinking else None), name


def test_seed_definitions_are_valid(seed):
    for name, entry in seed.items():
        validate_definition(entry['definition'])


def test_seed_notes_are_present(seed):
    """The rationale is most of the point of moving profiles into the database."""
    for name, entry in seed.items():
        assert len(entry['definition']['notes']) > 80, name


# ---------------------------------------------------------------------------
# validate_definition
# ---------------------------------------------------------------------------


@pytest.fixture
def valid() -> dict:
    return {
        'arch': 'moe',
        'alias': 'example',
        'model_path': '{LLAMA_MODELS}/example.gguf',
        'ctx': 4096,
        'threads': 4,
        'ngl': 99,
        'moe': 10,
    }


def test_valid_definition_round_trips(valid):
    normalised = validate_definition(valid)
    profile = ServingProfile.from_definition('example', normalised)
    assert profile.moe == 10
    assert profile.spec == () and profile.samplers == () and profile.extra == ()
    assert profile.parallel == 1 and profile.cache_k == 'q8_0'


@pytest.mark.parametrize(
    ('change', 'message'),
    [
        ({'arch': 'dense'}, 'dense'),
        ({'arch': 'sparse'}, 'arch'),
        ({'spec': ['--spec-type', 'draft-mtp', '--parallel', '2']}, '--parallel'),
        ({'extra': ['--parallel', '2']}, '--parallel'),
        ({'extra': ['--chat-template-kwargs', '{"reasoning_effort":"high"}']}, 'reasoning_effort_default'),
        ({'colour': 'blue'}, 'unknown'),
    ],
    ids=['moe-on-dense', 'bad-arch', 'parallel-in-spec', 'parallel-in-extra', 'reasoning-in-extra', 'unknown'],
)
def test_invalid_definitions_are_refused(valid, change, message):
    with pytest.raises(ProfileError, match=message):
        validate_definition({**valid, **change})


def test_missing_required_field_is_refused(valid):
    del valid['alias']
    with pytest.raises(ProfileError, match='missing'):
        validate_definition(valid)


def test_from_definition_ignores_row_metadata(valid):
    """A whole database row can be handed over, ids and timestamps included."""
    row = {**valid, 'version_id': 7, 'profile_id': 3, 'version': 2, 'created_at': 0, 'note': 'x', 'hf_repo': None}
    profile = ServingProfile.from_definition('example', row)
    assert profile.hf_repo == ''
    assert profile.name == 'example'


# ---------------------------------------------------------------------------
# Import guard
# ---------------------------------------------------------------------------


def test_profile_table_module_imports_and_resolves_its_names():
    """The CRUD layer's module-level names must actually resolve.

    Everything else in this file is deliberately database-free, which leaves
    the DB-touching methods on BenchmarkProfileTable with no coverage at all.
    That is how `validate_definition` came to be *called* by two of them
    without being imported: nothing executed those lines, so the NameError
    would not have surfaced until the first profile was created or edited
    through the UI.

    Importing the module executes its import block and binds every global, so
    a missing or misspelled import fails here instead. Skipped where the
    backend's own dependencies are not installed -- this needs the real
    backend venv, not a bare interpreter.
    """
    pytest.importorskip('markdown', reason='needs the backend venv')
    module = pytest.importorskip('open_webui.models.benchmark_profiles', reason='needs the backend venv')

    for name in ('validate_definition', 'ProfileError', 'ServingProfile'):
        assert hasattr(module, name), f'{name} is referenced but not imported'

    # The two call sites that were broken.
    table = module.BenchmarkProfiles
    assert callable(table.create)
    assert callable(table.add_version)
