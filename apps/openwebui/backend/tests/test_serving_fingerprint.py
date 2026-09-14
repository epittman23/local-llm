"""Golden-value tests for the serving-configuration fingerprint.

These check the Python serving layer against values captured from the bash
implementation it replaced, before that implementation was deleted. See
docs/serving-baseline/README.md at the repo root for what each case pins and
why this matters more than a normal regression test: a drifting fingerprint
does not raise, it silently refiles a serving configuration under a new id and
makes every historical measurement uncomparable with every new one.

Run from the backend directory:

    python -m pytest tests/test_serving_fingerprint.py
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from open_webui.benchmarks.serving.fingerprint import config_id, config_lines
from open_webui.benchmarks.serving.profiles import Overrides, ProfileError, ServingProfile, resolve

#: backend/tests/ -> backend/ -> apps/openwebui/ -> apps/ -> repo root
REPO_ROOT = Path(__file__).resolve().parents[4]
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


@pytest.mark.parametrize('case_name', [c['case'] for c in _load('fingerprints.json')['cases']])
def test_config_id_matches_shell(case_name, baseline, profiles):
    case = _cases(baseline)[case_name]
    resolved = _resolved(case, profiles)
    assert config_id(resolved) == case['config_id'], case['note']


@pytest.mark.parametrize('case_name', [c['case'] for c in _load('fingerprints.json')['cases']])
def test_config_lines_match_shell(case_name, baseline, profiles):
    """The lines matter as much as the digest: stats.py parses them back."""
    case = _cases(baseline)[case_name]
    resolved = _resolved(case, profiles)
    assert config_lines(resolved) == case['lines'], case['note']


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
    ids = {config_id(_resolved(cases[name], profiles)) for name in invariant['cases']}
    assert len(ids) == 1, f'{invariant["id"]}: {invariant["why"]}'


def test_parallel_in_spec_override_is_refused(profiles):
    """The one guard rail that fails loudly rather than correcting itself.

    Passing --parallel through a speculative override would hand it to
    llama-server twice and record it as the profile's slot count rather than
    the served one.
    """
    with pytest.raises(ProfileError, match='--parallel'):
        resolve(profiles['qwen38'], Overrides(spec=('--parallel', '4')))


def test_moe_override_on_dense_is_dropped_not_refused(profiles):
    """The other guard rail corrects quietly, because a dense profile should still serve."""
    resolved = resolve(profiles['qwen38'], Overrides(moe=30))
    assert resolved.moe is None
    assert 'moe: n/a' in config_lines(resolved)[0]
