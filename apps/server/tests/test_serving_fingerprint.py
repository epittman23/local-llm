"""Golden-value tests for the serving-configuration fingerprint.

These check the Python serving layer against values captured from the bash
implementation it replaced, before that implementation was deleted: the first
SHELL_LINES lines and their hash. Since #127 (2026-10-19) the fingerprint has
three more lines, pinned by fingerprints-v2.json. See
docs/serving-baseline/README.md at the repo root for what each case pins and
why this matters more than a normal regression test: a drifting fingerprint
does not raise, it silently refiles a serving configuration under a new id and
makes every historical measurement uncomparable with every new one.

Run from apps/server:

    python -m pytest tests/test_serving_fingerprint.py
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import pytest

from local_llm.benchmarks.analysis import compare, stats
from local_llm.benchmarks.serving.fingerprint import SHELL_LINES, config_id, config_lines
from local_llm.benchmarks.serving.profiles import Overrides, ProfileError, ServingProfile, resolve, validate_definition

#: apps/server/tests/ -> apps/server/ -> apps/ -> repo root
REPO_ROOT = Path(__file__).resolve().parents[3]
BASELINE_DIR = REPO_ROOT / 'docs' / 'serving-baseline'


def _load(name: str):
    path = BASELINE_DIR / name
    if not path.exists():  # pragma: no cover - only when run outside the repo
        pytest.skip(f'serving baseline not found at {path}')
    return json.loads(path.read_text())


@pytest.fixture(scope='module')
def baseline():
    return _load('fingerprints.json')


@pytest.fixture(scope='module')
def profiles() -> dict[str, ServingProfile]:
    """The four seeded profiles, as ServingProfile objects.

    Read from the captured seed data rather than hand-written here, so that
    this file also exercises the shape the seed migration has to produce: a
    typo in the seed data shows up as a fingerprint mismatch rather than as
    quietly wrong serving flags months later.
    """
    out = {}
    for row in _load('profiles.json'):
        extra = tuple(row.get('extra') or ())
        # The shell baked ${LLAMA_REASONING:-medium} into LLAMA_P_EXTRA and
        # then tested that array for the substring. The dataclass models the
        # capability as a field instead; derive it here the way the seed
        # migration will.
        reasoning_default = 'medium' if any('reasoning_effort' in arg for arg in extra) else None
        # And, as the seed migration stores it, the budget is not an extra
        # argument: the launcher builds that flag from the field.
        if reasoning_default:
            extra = ()
        out[row['name']] = ServingProfile(
            name=row['name'],
            arch=row['arch'],
            alias=row['alias'],
            model_path=row['model_path'],
            hf_repo=row['hf_repo'],
            hf_pattern=row['hf_pattern'],
            ctx=row['ctx'],
            threads=row['threads'],
            ngl=row['ngl'],
            moe=row['moe'],
            override_tensors=row['override_tensors'],
            parallel=row['parallel'],
            cache_k=row['cache_k'],
            cache_v=row['cache_v'],
            batch=row['batch'],
            ubatch=row['ubatch'],
            spec=tuple(row['spec']),
            samplers=tuple(row['samplers']),
            extra=extra,
            reasoning_effort_default=reasoning_default,
        )
    return out


def _cases(baseline):
    return {case['case']: case for case in baseline['cases']}


def _resolved(case, profiles):
    return resolve(profiles[case['profile']], Overrides.from_env(case['env']))


def test_baseline_is_present(baseline):
    """Guards against the fixture silently vanishing and the suite passing empty."""
    assert len(baseline['cases']) == 24
    assert baseline['invariants']


def _shell_id(resolved) -> str:
    """The id over the shell's lines alone, as it hashed them."""
    return config_id(resolved, lines=config_lines(resolved)[:SHELL_LINES])


@pytest.mark.parametrize('case_name', [c['case'] for c in _load('fingerprints.json')['cases']])
def test_config_id_matches_shell(case_name, baseline, profiles):
    case = _cases(baseline)[case_name]
    resolved = _resolved(case, profiles)
    assert _shell_id(resolved) == case['config_id'], case['note']


@pytest.mark.parametrize('case_name', [c['case'] for c in _load('fingerprints.json')['cases']])
def test_config_lines_match_shell(case_name, baseline, profiles):
    """The lines matter as much as the digest: stats.py parses them back."""
    case = _cases(baseline)[case_name]
    resolved = _resolved(case, profiles)
    assert config_lines(resolved)[:SHELL_LINES] == case['lines'], case['note']


@pytest.mark.parametrize('case_name', [c['case'] for c in _load('fingerprints.json')['cases']])
def test_alias_matches_shell(case_name, baseline, profiles):
    case = _cases(baseline)[case_name]
    assert _resolved(case, profiles).alias == case['alias']


@pytest.mark.parametrize('invariant', _load('fingerprints.json')['invariants'], ids=lambda i: i['id'])
def test_invariants_hold(invariant, baseline, profiles):
    """Cases that must produce the *same* fingerprint as each other.

    This is the part with real assertive power. An implementation that passes
    every individual case above but breaks one of these has almost certainly
    hard-coded its way to the right answers: each invariant encodes a rule
    about what the fingerprint covers, not just a value it happens to produce.
    """
    cases = _cases(baseline)
    ids = {_shell_id(_resolved(cases[name], profiles)) for name in invariant['cases']}
    assert len(ids) == 1, f'{invariant["id"]}: {invariant["why"]}'


def test_parallel_in_spec_override_is_refused(profiles):
    """The one guard rail that fails loudly rather than correcting itself.

    Passing --parallel through a speculative override would hand it to
    llama-server twice and record it as the profile's slot count rather than
    the served one.
    """
    with pytest.raises(ProfileError, match='--parallel'):
        resolve(profiles['qwen38'], Overrides(spec=('--parallel', '4')))


@pytest.mark.parametrize('flag', ['-fit', '--fit', '--fit=on'])
def test_fit_in_a_profile_is_refused(profiles, flag):
    """The launcher passes -fit off and fingerprints it; a profile's own would contradict that line."""
    args = (flag,) if '=' in flag else (flag, 'on')
    with pytest.raises(ProfileError, match='-fit'):
        resolve(profiles['qwen36'], Overrides(spec=args))
    with pytest.raises(ProfileError, match='-fit'):
        resolve(dataclasses.replace(profiles['qwen36'], extra=args), Overrides())
    with pytest.raises(ProfileError, match='-fit'):
        validate_definition(
            {'arch': 'moe', 'alias': 'a', 'model_path': 'm.gguf', 'ctx': 1, 'threads': 1, 'ngl': 1, 'extra': list(args)}
        )


def test_moe_override_on_dense_is_dropped_not_refused(profiles):
    """The other guard rail corrects quietly, because a dense profile should still serve."""
    resolved = resolve(profiles['qwen38'], Overrides(moe=30))
    assert resolved.moe is None
    assert 'moe: n/a' in config_lines(resolved)[0]


# ---------------------------------------------------------------------------
# the nine-line form (#127): model basename, extra arguments, fit
# ---------------------------------------------------------------------------
def _v2_resolved(case, profiles):
    profile = profiles[case['profile']]
    if 'profile_extra' in case:
        profile = dataclasses.replace(profile, extra=tuple(case['profile_extra']))
    return resolve(profile, Overrides.from_env(case['env']))


@pytest.fixture(scope='module')
def v2():
    data = _load('fingerprints-v2.json')
    return data, {case['case']: case for case in data['cases']}


def test_v2_covers_every_shell_case(baseline, v2):
    assert set(_cases(baseline)) <= set(v2[1])


@pytest.mark.parametrize('case_name', [c['case'] for c in _load('fingerprints-v2.json')['cases']])
def test_config_id_and_lines_match_v2(case_name, v2, profiles):
    case = v2[1][case_name]
    resolved = _v2_resolved(case, profiles)
    assert config_lines(resolved) == case['lines'], case['note']
    assert config_id(resolved) == case['config_id'], case['note']


@pytest.mark.parametrize('invariant', _load('fingerprints-v2.json')['invariants'], ids=lambda i: i['id'])
def test_v2_invariants_hold(invariant, v2, profiles):
    ids = {config_id(_v2_resolved(v2[1][name], profiles)) for name in invariant['cases']}
    assert len(ids) == 1, f'{invariant["id"]}: {invariant["why"]}'


@pytest.mark.parametrize('pair', _load('fingerprints-v2.json')['distinct'], ids=lambda i: i['id'])
def test_v2_distinct_cases_differ(pair, v2, profiles):
    ids = {config_id(_v2_resolved(v2[1][name], profiles)) for name in pair['cases']}
    assert len(ids) == len(pair['cases']), f'{pair["id"]}: {pair["why"]}'


def test_the_new_lines_parse_back_and_count_as_flags(v2, profiles):
    lines = config_lines(_v2_resolved(v2[1]['extra-arg'], profiles))
    fields = stats.parse_config_text('\n'.join(lines))
    assert (fields['model'], fields['extra'], fields['fit']) == ('Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf', '--no-mmap', 'off')
    base = config_lines(_v2_resolved(v2[1]['base-qwen36'], profiles))
    assert compare.differing(compare.flags_of(base), compare.flags_of(lines)) == ['extra']
    quant = config_lines(_v2_resolved(v2[1]['model-other-quant'], profiles))
    qwen38 = config_lines(_v2_resolved(v2[1]['base-qwen38'], profiles))
    assert compare.differing(compare.flags_of(qwen38), compare.flags_of(quant)) == ['model']


def test_text_recorded_before_the_new_lines_still_parses(baseline):
    fields = stats.parse_config_text('\n'.join(_cases(baseline)['base-qwen38']['lines']))
    assert fields['ngl'] == 20 and fields['model'] is None and fields['extra'] is None and fields['fit'] is None


def test_extra_arguments_are_quoted_so_different_splits_differ(profiles):
    one = dataclasses.replace(profiles['qwen36'], extra=('--override-kv', 'a b'))
    two = dataclasses.replace(profiles['qwen36'], extra=('--override-kv', 'a', 'b'))
    lines = config_lines(resolve(one, Overrides()))
    assert "extra: --override-kv 'a b'" in lines
    assert config_id(resolve(one, Overrides())) != config_id(resolve(two, Overrides()))
