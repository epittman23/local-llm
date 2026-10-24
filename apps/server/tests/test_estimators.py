"""benchmarks/analysis/estimators.py against values worked by hand.

Every expected value here comes from the formula, written out in the test,
never from calling the library the estimator itself uses -- a test that asks
statsmodels to agree with statsmodels checks nothing.

Run from apps/server:

    python -m pytest tests/test_estimators.py
"""

from __future__ import annotations

import math
import random

import numpy as np
import pytest
from scipy import stats as sps

from local_llm.benchmarks.analysis import estimators as E

Z = 1.959963984540054  # z_{0.975}
Z80 = 0.8416212335729143  # z_{0.80}


def hand_wilson(passed: float, n: float) -> tuple[float, float]:
    p = passed / n
    d = 1 + Z * Z / n
    centre = (p + Z * Z / (2 * n)) / d
    half = Z * math.sqrt(p * (1 - p) / n + Z * Z / (4 * n * n)) / d
    return (max(0.0, centre - half), min(1.0, centre + half))


def scores(values, clusters=None, minutes=None, samples=1) -> dict[str, E.ProblemScore]:
    clusters = clusters or [None] * len(values)
    minutes = minutes or [1.0] * len(values)
    return {
        str(i): E.ProblemScore(str(i), float(v), samples, c, m)
        for i, (v, c, m) in enumerate(zip(values, clusters, minutes, strict=True))
    }


def rec(item, outcome, wall_ms=60000, cluster=None):
    return {'item_id': item, 'outcome': outcome, 'wall_ms': wall_ms, 'cluster': cluster}


# ---------------------------------------------------------------------------
# per-problem scores
# ---------------------------------------------------------------------------
def test_problem_scores_average_within_a_problem_and_ignore_skipped():
    out = E.problem_scores(
        [
            rec('a', 'pass', 60000),
            rec('a', 'fail_assert', 120000),
            rec('b', 'pass', 30000, cluster='k'),
            rec('c', 'skipped'),
        ]
    )
    assert set(out) == {'a', 'b'}
    assert out['a'].score == 0.5 and out['a'].n_samples == 2 and out['a'].minutes == 1.5
    assert not out['a'].binary
    assert out['b'].binary and out['b'].cluster == 'k' and out['b'].minutes == 0.5


# ---------------------------------------------------------------------------
# standard errors
# ---------------------------------------------------------------------------
def test_iid_standard_error_is_sample_sd_over_root_n():
    vals = [1, 0, 1, 1, 0, 1]
    m = 4 / 6
    s = math.sqrt(sum((v - m) ** 2 for v in vals) / 5)
    est = E.mean_se(vals)
    assert est.mean == pytest.approx(m)
    assert est.se == pytest.approx(s / math.sqrt(6))
    assert est.kind == 'iid'


def test_clustered_standard_error_is_cr1_by_hand():
    # Clusters a:(1,0) b:(1,1) c:(0,1); mean 4/6. Residual sums per cluster:
    # a: 1/3 - 2/3 = -1/3, b: 2/3, c: -1/3. Sum of squares 6/9 = 2/3.
    # CR1 = sqrt(G/(G-1) * 2/3) / n = sqrt(3/2 * 2/3) / 6 = 1/6.
    est = E.mean_se([1, 0, 1, 1, 0, 1], ['a', 'a', 'b', 'b', 'c', 'c'])
    assert est.se == pytest.approx(1 / 6)
    assert est.n_clusters == 3 and est.kind == 'cluster'
    assert 'few clusters' in est.note


def test_one_problem_and_one_cluster_are_not_estimable():
    assert E.mean_se([1.0]).se is None
    assert E.mean_se([1.0]).note == 'not estimable (1 problem)'
    one = E.mean_se([1, 0, 1], ['x', 'x', 'x'])
    assert one.se is None and one.n_clusters == 1 and one.note == 'not estimable (1 cluster)'
    assert one.mean == pytest.approx(2 / 3)


def test_problems_without_a_cluster_are_their_own_cluster():
    est = E.mean_se([1, 0, 1, 0], ['x', 'x', None, None])
    assert est.n_clusters == 3


# ---------------------------------------------------------------------------
# intervals
# ---------------------------------------------------------------------------
def test_wilson_matches_the_formula():
    assert E.wilson(7, 8) == pytest.approx(hand_wilson(7, 8))
    assert E.wilson(0, 10) == pytest.approx(hand_wilson(0, 10))


def test_all_pass_falls_back_to_wilson_at_n():
    est = E.mean_se([1] * 8)
    assert est.se == 0
    lo, hi = E.rate_interval(est, binary=True)
    assert lo == pytest.approx(0.6755924, abs=1e-6) and hi == 1.0


def test_all_fail_clustered_falls_back_to_wilson_at_g():
    est = E.mean_se([0] * 6, ['a', 'a', 'b', 'b', 'c', 'c'])
    assert E.rate_interval(est, binary=True) == pytest.approx(hand_wilson(0, 3))


def test_single_sample_unclustered_interval_is_plain_wilson():
    est = E.mean_se([1] * 7 + [0])
    assert E.rate_interval(est, binary=True) == pytest.approx(hand_wilson(7, 8))


def test_repeated_samples_use_the_design_effect():
    # Scores 1, 1, 0.5, 0: mean 0.625, s^2 = (0.375^2*2 + 0.125^2 + 0.625^2)/3
    # = 0.6875/3, SE^2 = s^2/4 = 0.6875/12, n_eff = p(1-p)/SE^2 = 4.0909...
    est = E.mean_se([1, 1, 0.5, 0])
    n_eff = 0.625 * 0.375 / (0.6875 / 12)
    assert E.rate_interval(est, binary=False) == pytest.approx(hand_wilson(0.625 * n_eff, n_eff))


def test_single_problem_interval_is_wilson_at_one():
    assert E.rate_interval(E.mean_se([1.0]), binary=True) == pytest.approx(hand_wilson(1, 1))
    assert E.rate_interval(E.mean_se([0.5]), binary=False) is None


# ---------------------------------------------------------------------------
# paired comparisons
# ---------------------------------------------------------------------------
def test_exact_mcnemar_by_hand():
    a = scores([1, 1, 1, 1, 1, 0, 1, 1])
    b = scores([0, 0, 0, 1, 1, 1, 0, 1])
    out = E.paired(a, b)
    # Discordant: a-only 4 (items 0,1,2,6), b-only 1 (item 5).
    # Two-sided binomial on 5 trials: 2 * (C(5,0) + C(5,1)) / 2^5 = 12/32.
    assert out.test == 'exact McNemar'
    assert out.discordant == (4, 1)
    assert out.p == pytest.approx(12 / 32)
    assert out.mean_diff == pytest.approx(3 / 8)


def test_no_discordant_problems_gives_p_one_and_no_mde():
    a = scores([1, 0, 1, 1])
    out = E.paired(a, scores([1, 0, 1, 1]))
    assert out.p == 1.0 and out.discordant == (0, 0)
    assert out.se == 0 and E.mde(out.se) is None


def test_paired_t_with_repeated_samples_by_hand():
    a = scores([1.0, 0.5, 1.0, 0.5], samples=2)
    b = scores([0.5, 0.5, 0.0, 0.0], samples=2)
    out = E.paired(a, b)
    d = [0.5, 0.0, 1.0, 0.5]
    m = 0.5
    se = math.sqrt(sum((x - m) ** 2 for x in d) / 3) / 2
    assert out.test == 'paired t'
    assert out.se == pytest.approx(se)
    assert out.statistic == pytest.approx(m / se)
    assert out.p == pytest.approx(2 * sps.t.sf(m / se, 3))
    half = sps.t.ppf(0.975, 3) * se
    assert out.ci == pytest.approx((m - half, m + half))


def test_clustered_pair_uses_the_cluster_robust_test():
    cl = ['a', 'a', 'b', 'b', 'c', 'c']
    a = scores([1, 1, 1, 0, 1, 1], cl)
    b = scores([0, 1, 0, 0, 1, 0], cl)
    out = E.paired(a, b)
    assert out.test == 'paired t (cluster-robust)'
    assert out.n_clusters == 3
    # df = G - 1 = 2
    assert out.p == pytest.approx(2 * sps.t.sf(abs(out.statistic), 2))


def test_correlation_is_pearson_and_na_for_a_constant_score():
    a = scores([1, 0, 1, 1, 0])
    b = scores([1, 0, 0, 1, 0])
    xa, xb = np.array([1, 0, 1, 1, 0.0]), np.array([1, 0, 0, 1, 0.0])
    r = ((xa - xa.mean()) * (xb - xb.mean())).sum() / math.sqrt(
        ((xa - xa.mean()) ** 2).sum() * ((xb - xb.mean()) ** 2).sum()
    )
    assert E.paired(a, b).corr == pytest.approx(r)
    assert E.paired(scores([1, 1, 1, 1]), b).corr is None


def test_no_shared_problems_is_not_tested():
    a = {'x': E.ProblemScore('x', 1, 1)}
    b = {'y': E.ProblemScore('y', 0, 1)}
    out = E.paired(a, b)
    assert out.n_shared == 0 and not out.tested and out.note == 'n/a (no shared problems)'


def test_identical_nonzero_shift_everywhere_is_maximally_significant():
    out = E.paired(scores([1.0, 1.0, 1.0], samples=2), scores([0.5, 0.5, 0.5], samples=2))
    assert out.se == 0 and out.p == 0.0


# ---------------------------------------------------------------------------
# multiplicity, groups, power
# ---------------------------------------------------------------------------
def test_holm_by_hand():
    # Sorted 0.01, 0.03, 0.04 -> 3*0.01, 2*0.03, max(0.06, 1*0.04).
    assert E.holm([0.01, 0.04, 0.03]) == pytest.approx([0.03, 0.06, 0.06])
    assert E.holm([]) == []


def test_letters_non_transitive():
    assert E.letters(['A', 'B', 'C'], {frozenset({'A', 'C'})}) == {'A': 'a', 'B': 'ab', 'C': 'b'}


def test_letters_four_levels():
    diff = {frozenset({'A', 'C'}), frozenset({'A', 'D'}), frozenset({'B', 'D'})}
    assert E.letters(['A', 'B', 'C', 'D'], diff) == {'A': 'a', 'B': 'ab', 'C': 'bc', 'D': 'c'}


def test_letters_no_differences_and_all_different():
    assert E.letters(['A', 'B'], set()) == {'A': 'a', 'B': 'a'}
    all_diff = {frozenset({'A', 'B'}), frozenset({'A', 'C'}), frozenset({'B', 'C'})}
    assert E.letters(['A', 'B', 'C'], all_diff) == {'A': 'a', 'B': 'b', 'C': 'c'}


def test_mde_by_hand():
    assert E.mde(0.05) == pytest.approx((Z + Z80) * 0.05)
    # Holm worst case for m = 3 holds the first test to alpha/3.
    assert E.mde(0.05, m=3) == pytest.approx((sps.norm.ppf(1 - 0.05 / 6) + Z80) * 0.05)
    assert E.mde(None) is None


# ---------------------------------------------------------------------------
# passes per minute
# ---------------------------------------------------------------------------
def test_passes_per_minute_delta_method_by_hand():
    s = list(scores([1, 0, 1, 1], minutes=[2.0, 1.0, 3.0, 2.0]).values())
    out = E.passes_per_minute(s)
    r = 3 / 8
    e = [1 - r * 2, 0 - r * 1, 1 - r * 3, 1 - r * 2]
    se = math.sqrt(4 / 3 * sum(x * x for x in e) / 64)
    assert out.value == pytest.approx(r)
    assert out.se == pytest.approx(se)
    assert out.ci == pytest.approx((r * math.exp(-Z * se / r), r * math.exp(Z * se / r)))


def test_passes_per_minute_agrees_with_a_bootstrap_over_problems():
    rng = random.Random(7)
    vals = [1 if rng.random() < 0.7 else 0 for _ in range(400)]
    mins = [rng.uniform(0.5, 4.0) for _ in range(400)]
    s = list(scores(vals, minutes=mins).values())
    out = E.passes_per_minute(s)
    p, w = np.array(vals, float), np.array(mins)
    res = sps.bootstrap((p, w), lambda a, b: a.sum() / b.sum(), paired=True, n_resamples=4000, random_state=1)
    assert out.se == pytest.approx(res.standard_error, rel=0.1)


def test_passes_per_minute_edge_cases():
    assert E.passes_per_minute([]).value is None
    one = E.passes_per_minute(list(scores([1], minutes=[2.0]).values()))
    assert one.value == 0.5 and one.se is None and 'not estimable' in one.note
    zero = E.passes_per_minute(list(scores([0, 0], minutes=[1.0, 1.0]).values()))
    assert zero.value == 0 and zero.ci is None and 'no passes' in zero.note
    assert E.passes_per_minute(list(scores([1, 1], minutes=[0.0, 0.0]).values())).value is None


# ---------------------------------------------------------------------------
# the summary Compare and Report use
# ---------------------------------------------------------------------------
def test_summarise_combines_the_pieces():
    out = E.summarise([rec(str(i), 'pass' if i < 6 else 'fail_assert') for i in range(8)])
    assert out.rate.mean == pytest.approx(6 / 8)
    assert out.ci == pytest.approx(hand_wilson(6, 8))
    assert out.ppm.value == pytest.approx(6 / 8)
    assert out.n_samples == 8
