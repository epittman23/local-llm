"""Tests for stored profile definitions, and for the seed migration's data.

The seed tests are the ones that matter. The migration that moves the serving
profiles into Postgres (5a1f0c3e9b27) carries a frozen literal copy of them.
These check that literal against the golden fingerprints captured from the
shell before it was retired, and against the captured profile settings field
by field -- with no database. A transcription slip in the seed shows up here
as a failing test, rather than months later as a configuration served under
the wrong flags or filed under the wrong config_id.

Run from apps/server:

    python -m pytest tests/test_serving_profiles.py
"""

from __future__ import annotations

import importlib.util
import json
import re
import tomllib
from pathlib import Path

import pytest

from local_llm.benchmarks.serving.fingerprint import SHELL_LINES, config_id, config_lines
from local_llm.benchmarks.serving.profiles import (
    SPEC_OPTIONS,
    Overrides,
    ProfileError,
    ServingProfile,
    SpeculativeArgsError,
    check_speculative_args,
    resolve,
    validate_definition,
)

SERVER_DIR = Path(__file__).resolve().parents[1]
#: apps/server/tests/ -> apps/server/ -> apps/ -> repo root
REPO_ROOT = Path(__file__).resolve().parents[3]
BASELINE_DIR = REPO_ROOT / 'docs' / 'serving-baseline'
MIGRATION = SERVER_DIR / 'local_llm' / 'migrations' / 'versions' / '5a1f0c3e9b27_add_benchmark_serving_profiles.py'


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
    """Every captured shell case, recomputed from the seed literal: the shell's lines and hash."""
    profile = ServingProfile.from_definition(case['profile'], seed[case['profile']]['definition'])
    resolved = resolve(profile, Overrides.from_env(case['env']))
    lines = config_lines(resolved)[:SHELL_LINES]
    assert lines == case['lines'], case['note']
    assert config_id(resolved, lines=lines) == case['config_id'], case['note']


def _v2_cases() -> list[dict]:
    path = REPO_ROOT / 'docs' / 'serving-baseline' / 'fingerprints-v2.json'
    return [c for c in json.loads(path.read_text())['cases'] if 'profile_extra' not in c] if path.exists() else []


@pytest.mark.parametrize('case', _v2_cases(), ids=lambda c: c['case'])
def test_seed_reproduces_the_nine_line_fingerprints(case, seed):
    """The same cases in the form #127 introduced, from the seed literal rather than the captures."""
    profile = ServingProfile.from_definition(case['profile'], seed[case['profile']]['definition'])
    resolved = resolve(profile, Overrides.from_env(case['env']))
    assert config_lines(resolved) == case['lines'], case['note']
    assert config_id(resolved) == case['config_id'], case['note']


def test_seed_matches_captured_profiles_field_by_field(seed):
    """Everything outside the fingerprint, too: hf_repo, pattern, model path.

    The fingerprint tests above cannot see a wrong weights directory or
    Hugging Face pattern, because neither is fingerprinted (only the weights
    file's basename is). This one can.
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
    for entry in seed.values():
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
        ({'spec': ['off']}, 'leave spec empty'),
        ({'spec': ['--spec-type', 'draft-mtp', '--host', '0.0.0.0']}, "'--host' is not a speculative"),
    ],
    ids=[
        'moe-on-dense',
        'bad-arch',
        'parallel-in-spec',
        'parallel-in-extra',
        'reasoning-in-extra',
        'unknown',
        'spec-off',
        'host-in-spec',
    ],
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
    module = pytest.importorskip('local_llm.models.benchmarks.profiles', reason='needs the backend venv')

    for name in ('validate_definition', 'ProfileError', 'ServingProfile'):
        assert hasattr(module, name), f'{name} is referenced but not imported'

    # The two call sites that were broken.
    table = module.BenchmarkProfiles
    assert callable(table.create)
    assert callable(table.add_version)


# docs/history/bug-review-2026-09-27.md M8 and L9


@pytest.mark.parametrize('field', ['reasoning_effort_default', 'override_tensors'])
def test_blank_optional_text_is_stored_as_none(valid, field):
    assert validate_definition({**valid, field: '  '})[field] is None


def test_blank_reasoning_effort_does_not_make_a_thinking_model(valid):
    profile = ServingProfile.from_definition('example', {**valid, 'reasoning_effort_default': ''})
    assert resolve(profile).reasoning_effort is None


@pytest.mark.parametrize('args', [['-np', '2'], ['--parallel=2']])
def test_short_and_inline_parallel_forms_are_refused(valid, args):
    with pytest.raises(ProfileError, match='parallel'):
        validate_definition({**valid, 'extra': args})
    with pytest.raises(ProfileError, match='parallel'):
        resolve(ServingProfile.from_definition('example', valid), Overrides(spec=tuple(args)))


# ---------------------------------------------------------------------------
# Speculative arguments hold only speculative-decoding options
# ---------------------------------------------------------------------------

DATA_DIR = SERVER_DIR / 'local_llm' / 'benchmarks' / 'data'


def _grid_spec_values() -> list[str]:
    """Every LLAMA_SPEC a tuning or pre-screen grid offers, and every one the serving baseline records."""
    values = set()
    for path in sorted([*(DATA_DIR / 'tuning').glob('*.toml'), *(DATA_DIR / 'prescreen').glob('*.toml')]):
        knob = tomllib.loads(path.read_text()).get('knob', {}).get('LLAMA_SPEC')
        values.update(knob['values'] if knob else [])

    def walk(node):
        if isinstance(node, dict):
            for key, child in node.items():
                if key == 'LLAMA_SPEC':
                    values.add(child)
                walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)

    for name in ('fingerprints.json', 'fingerprints-v2.json'):
        walk(_load_json(name))
    return sorted(values)


def test_the_grids_offer_speculative_flags():
    """The parametrize below must not be vacuous: qwen38's grid offers draft depths."""
    assert '--spec-type draft-mtp --spec-draft-n-max 4' in _grid_spec_values()


@pytest.mark.parametrize('value', _grid_spec_values())
def test_every_spec_a_grid_or_the_baseline_uses_still_resolves(seed, value):
    profile = ServingProfile.from_definition('qwen38', seed['qwen38']['definition'])
    resolved = resolve(profile, Overrides.from_env({'LLAMA_SPEC': value}))
    assert resolved.spec == tuple(value.split()) or value in ('', 'off')


@pytest.mark.parametrize(
    'args',
    [
        ['--host', '0.0.0.0'],
        ['--spec-type', 'draft-mtp', '--port', '9999'],
        ['--spec-type', 'ngram-mod', '--log-file', '/tmp/x'],
        ['--spec-type', 'draft-mtp', '--api-key', 'k'],
        ['--spec-type', 'draft-mtp', '-m', 'other.gguf'],
        ['--spec-type', 'draft-mtp', '--model', 'other.gguf'],
        ['--spec-type', 'draft-mtp', '-c', '128'],
        ['--host=0.0.0.0'],
        ['--spec-type=draft-mtp'],
        ['--spec-draft-hf', 'someone/model'],
        ['-hfd', 'someone/model'],
        ['draft-mtp'],
        ['on'],
    ],
)
def test_an_override_with_anything_but_speculative_options_is_refused(seed, args):
    profile = ServingProfile.from_definition('qwen38', seed['qwen38']['definition'])
    with pytest.raises(SpeculativeArgsError):
        resolve(profile, Overrides(spec=tuple(args)))
    with pytest.raises(SpeculativeArgsError):
        validate_definition({**seed['qwen38']['definition'], 'spec': args})


@pytest.mark.parametrize(
    'args',
    [
        ['--spec-type', 'draft-mtp', '--spec-draft-n-max', '3'],
        ['--spec_type', 'ngram-mod', '--spec-ngram-mod-n-min', '48'],
        ['-md', '/models/draft.gguf', '-ngld', '-1', '--spec-draft-p-min', '0.5'],
        ['--spec-default'],
        ['--no-spec-draft-backend-sampling', '-ctkd', 'q8_0'],
    ],
)
def test_speculative_options_and_their_values_pass(args):
    check_speculative_args(args)


def test_a_stored_versions_spec_is_not_rechecked_at_launch(seed):
    """validate_definition runs on save, so a version stored before the rule still serves."""
    profile = ServingProfile.from_definition(
        'qwen38', {**seed['qwen38']['definition'], 'spec': ['--spec-type', 'x', '--foo']}
    )
    assert resolve(profile).spec == ('--spec-type', 'x', '--foo')


def test_spec_options_hold_no_server_or_model_flag():
    assert not SPEC_OPTIONS & {'--host', '--port', '-m', '--model', '--api-key', '--log-file', '-c', '--parallel'}


def test_the_serve_pages_copy_of_the_speculative_options_matches():
    """Serve decides from its own copy whether to take a link's spec; the server's list is the one enforced."""
    source = (REPO_ROOT / 'apps' / 'web' / 'src' / 'routes' / 'benchmarks' / 'resultLinks.ts').read_text()
    block = source[source.index('export const SPEC_OPTIONS') :]
    block = block[: block.index(']);')]
    assert set(re.findall(r"'([^']+)'", block)) == SPEC_OPTIONS
