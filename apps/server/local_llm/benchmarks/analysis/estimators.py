"""benchmarks/analysis/estimators.py - error bars for pass rates and their differences.

The methods are those of Evan Miller, "Adding Error Bars to Evals: A
Statistical Approach to Language Model Evaluations" (arXiv:2411.00640), applied
to what this store holds: one row per problem per suite run, so "several
samples of a problem" means the same configuration run more than once.

  * Scores are averaged within each problem first. A problem asked twice is one
    problem, not two independent observations of the configuration.
  * Problems that share a cluster (DS-1000 perturbations of one StackOverflow
    question, LiveCodeBench problems of one contest) are not independent, and
    the standard error is cluster-robust when the rows carry a cluster.
  * Two configurations are compared on the problems both answered, as paired
    differences, which removes problem difficulty from the comparison.

Compare and Report both call this module, so the two pages cannot disagree
about a number. Pure functions over plain values: no database, no I/O.

Every estimator that a library provides comes from that library (statsmodels
for cluster-robust errors, Wilson, McNemar and Holm; scipy for the t and
normal distributions and Pearson's r). What is written out here is the glue,
the edge-case rules, and the two things no library provides: the
compact letter display and the cluster-aware delta method for passes per
minute. tests/test_estimators.py checks each against values worked by hand,
never against the library that computed them.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy import stats as sps
from statsmodels.regression.linear_model import OLS
from statsmodels.stats.contingency_tables import mcnemar
from statsmodels.stats.multitest import multipletests
from statsmodels.stats.proportion import proportion_confint

PASS = 'pass'
GRADED = {'pass', 'fail_assert', 'fail_error', 'fail_timeout', 'no_code'}

ALPHA = 0.05
POWER = 0.80

#: Below this many clusters a cluster-robust standard error is itself noisy
#: enough that it is reported with a warning rather than on its own.
FEW_CLUSTERS = 20


# ---------------------------------------------------------------------------
# per-problem scores
# ---------------------------------------------------------------------------
@dataclass
class ProblemScore:
    """One problem's outcome under one configuration, averaged over its samples."""

    item: str
    score: float
    n_samples: int
    cluster: str | None = None
    #: Mean wall-clock minutes per sample: the denominator of passes per minute.
    minutes: float = 0.0

    @property
    def binary(self) -> bool:
        """A single pass/fail observation, which is what McNemar is exact for."""
        return self.n_samples == 1 and self.score in (0.0, 1.0)


def problem_scores(records: list[dict]) -> dict[str, ProblemScore]:
    """item_id -> its score, from result rows of one configuration in one block.

    Rows that were not graded (skipped) are ignored. A problem's cluster is
    taken from its rows; rows of one problem never disagree about it, since
    the cluster is a property of the dataset item.
    """
    grouped: dict[str, list[dict]] = {}
    for r in records:
        if r.get('outcome') in GRADED:
            grouped.setdefault(str(r.get('item_id')), []).append(r)
    out = {}
    for item, rows in grouped.items():
        passes = sum(1 for r in rows if r.get('outcome') == PASS)
        minutes = sum(float(r.get('wall_ms') or 0) for r in rows) / 60000 / len(rows)
        cluster = next((r.get('cluster') for r in rows if r.get('cluster')), None)
        out[item] = ProblemScore(item, passes / len(rows), len(rows), cluster, minutes)
    return out


# ---------------------------------------------------------------------------
# a mean and its standard error
# ---------------------------------------------------------------------------
@dataclass
class Estimate:
    mean: float | None
    se: float | None
    n: int
    #: None when the problems are treated as independent.
    n_clusters: int | None = None
    #: Why `se` is missing, or a caution about it. Empty when there is nothing to say.
    note: str = ''

    @property
    def kind(self) -> str:
        return 'cluster' if self.n_clusters is not None else 'iid'


def _cluster_codes(clusters: list[str | None]) -> list[int] | None:
    """Integer cluster ids, or None when no value carries a cluster.

    A problem with no cluster in a clustered set is its own cluster: it shares
    nothing with any other problem.
    """
    if not any(clusters):
        return None
    codes: dict[str, int] = {}
    out = []
    for i, c in enumerate(clusters):
        key = c if c else f'\0singleton-{i}'
        out.append(codes.setdefault(key, len(codes)))
    return out


def mean_se(values: list[float], clusters: list[str | None] | None = None) -> Estimate:
    """The mean of per-problem values and its standard error.

    Independent problems: s/sqrt(n), with s the sample standard deviation
    (n-1). Clustered problems: the cluster-robust (CR1) standard error of an
    intercept-only regression, i.e. sqrt(G/(G-1) * sum_c (sum_{i in c} e_i)^2) / n
    -- statsmodels' default small-sample correction, which for one regressor
    reduces to G/(G-1).
    """
    n = len(values)
    if n == 0:
        return Estimate(None, None, 0, note='no problems')
    y = np.asarray(values, dtype=float)
    mean = float(y.mean())
    codes = _cluster_codes(clusters) if clusters is not None else None

    if codes is None:
        if n < 2:
            return Estimate(mean, None, n, note='not estimable (1 problem)')
        return Estimate(mean, float(y.std(ddof=1) / math.sqrt(n)), n)

    g = len(set(codes))
    if g < 2:
        return Estimate(mean, None, n, n_clusters=g, note='not estimable (1 cluster)')
    fit = OLS(y, np.ones(n)).fit(cov_type='cluster', cov_kwds={'groups': np.asarray(codes)})
    note = f'few clusters ({g}): the standard error is itself unreliable' if g < FEW_CLUSTERS else ''
    return Estimate(mean, float(fit.bse[0]), n, n_clusters=g, note=note)


# ---------------------------------------------------------------------------
# a pass rate's interval
# ---------------------------------------------------------------------------
def wilson(count: float, nobs: float, alpha: float = ALPHA) -> tuple[float, float]:
    lo, hi = proportion_confint(count, nobs, alpha=alpha, method='wilson')
    return (max(0.0, float(lo)), min(1.0, float(hi)))


def rate_interval(est: Estimate, binary: bool, alpha: float = ALPHA) -> tuple[float, float] | None:
    """A Wilson interval at the design-effect-adjusted sample size.

    Wilson rather than mean +/- z*SE because the normal interval collapses to
    a point at 0% and 100% and spills outside [0, 1] near them, which is
    where a good configuration on an easy benchmark sits. Clustering and
    repeated samples change how much information n problems carry, so the
    interval is computed at the effective n that makes the binomial variance
    match the estimated one, n_eff = p(1-p)/SE^2 (Kish's design effect). With
    one sample per problem and no clusters the outcomes are binomial and the
    interval is plain Wilson at n; the sample-variance estimate would put
    n_eff at n-1 there, which is an artefact of the n-1, not information.

    At p = 0 or 1 the estimated variance is 0 and n_eff is undefined, so the
    interval falls back to n problems, or G clusters when clustered: the
    conservative count of independent units.
    """
    p = est.mean
    if p is None:
        return None
    if binary and est.n_clusters is None:
        return wilson(p * est.n, est.n, alpha)
    if est.se is None:
        if est.n == 1 and binary:
            return wilson(p, 1, alpha)
        return None
    if est.se == 0 or p in (0.0, 1.0):
        units = est.n_clusters if est.n_clusters is not None else est.n
        return wilson(p * units, units, alpha)
    n_eff = p * (1 - p) / (est.se * est.se)
    return wilson(p * n_eff, n_eff, alpha)


# ---------------------------------------------------------------------------
# two configurations on their shared problems
# ---------------------------------------------------------------------------
@dataclass
class Paired:
    n_shared: int
    mean_diff: float | None = None
    se: float | None = None
    ci: tuple[float, float] | None = None
    corr: float | None = None
    test: str = ''
    statistic: float | None = None
    p: float | None = None
    n_clusters: int | None = None
    note: str = ''
    #: McNemar's discordant counts, when that test was used: a passed and b failed, and the reverse.
    discordant: tuple[int, int] | None = None

    @property
    def tested(self) -> bool:
        return self.p is not None


def paired(a: dict[str, ProblemScore], b: dict[str, ProblemScore], alpha: float = ALPHA) -> Paired:
    """Configuration a against b, as paired differences on the problems both answered.

    The test is exact McNemar when every shared problem is a single pass/fail
    observation and the problems are independent: that is the case it is
    exact for. Otherwise (repeated samples, or clusters) it is a paired t test
    on the per-problem differences with the matching standard error, on n-1
    degrees of freedom, or G-1 when clustered.
    """
    shared = sorted(set(a) & set(b))
    out = Paired(n_shared=len(shared))
    if not shared:
        out.note = 'n/a (no shared problems)'
        return out

    xa = np.array([a[i].score for i in shared])
    xb = np.array([b[i].score for i in shared])
    d = list(xa - xb)
    clusters = [a[i].cluster or b[i].cluster for i in shared]
    est = mean_se(d, clusters)
    out.mean_diff, out.se, out.n_clusters, out.note = est.mean, est.se, est.n_clusters, est.note

    if len(shared) >= 3 and xa.std() > 0 and xb.std() > 0:
        out.corr = float(sps.pearsonr(xa, xb).statistic)

    df = (est.n_clusters - 1) if est.n_clusters is not None else (len(shared) - 1)
    if est.se is not None and est.se > 0 and df > 0:
        half = float(sps.t.ppf(1 - alpha / 2, df)) * est.se
        out.ci = (est.mean - half, est.mean + half)

    exact_case = est.n_clusters is None and all(a[i].binary and b[i].binary for i in shared)
    if exact_case:
        b_ = int(sum(1 for x, y in zip(xa, xb, strict=True) if x == 1 and y == 0))
        c_ = int(sum(1 for x, y in zip(xa, xb, strict=True) if x == 0 and y == 1))
        out.test = 'exact McNemar'
        out.discordant = (b_, c_)
        if b_ + c_ == 0:
            out.statistic, out.p = 0.0, 1.0
        else:
            res = mcnemar([[0, b_], [c_, 0]], exact=True)
            out.statistic, out.p = float(res.statistic), float(res.pvalue)
        return out

    out.test = 'paired t (cluster-robust)' if est.n_clusters is not None else 'paired t'
    if est.se is None or df <= 0:
        return out
    if est.se == 0:
        # Every shared problem moved by the same amount. With no variance the
        # t statistic is undefined: identical scores everywhere is no evidence
        # of a difference, and an identical nonzero shift everywhere is as
        # strong as the design allows.
        out.statistic = 0.0 if est.mean == 0 else math.copysign(math.inf, est.mean)
        out.p = 1.0 if est.mean == 0 else 0.0
        return out
    t = est.mean / est.se
    out.statistic, out.p = float(t), float(2 * sps.t.sf(abs(t), df))
    return out


def holm(pvalues: list[float], alpha: float = ALPHA) -> list[float]:
    """Holm-adjusted p-values, in input order."""
    if not pvalues:
        return []
    return [float(p) for p in multipletests(pvalues, alpha=alpha, method='holm')[1]]


def mde(se: float | None, m: int = 1, alpha: float = ALPHA, power: float = POWER) -> float | None:
    """The smallest difference this comparison detects with the given power.

    (z_{1-a/2} + z_{power}) * SE, from the observed standard error of the
    paired difference (Miller, section 5). `m` is the number of tests in the
    Holm family; the worst-case Holm threshold is alpha/m, which is the
    level the first comparison in the family is held to. None when the
    standard error is unknown or zero: with no observed variance there is
    nothing to scale a detectable difference by.
    """
    if se is None or se <= 0:
        return None
    level = alpha / max(m, 1)
    return float((sps.norm.ppf(1 - level / 2) + sps.norm.ppf(power)) * se)


# ---------------------------------------------------------------------------
# groups instead of a strict ranking
# ---------------------------------------------------------------------------
def letters(order: list[str], different: set[frozenset[str]]) -> dict[str, str]:
    """Compact letter display: levels sharing a letter are not distinguishable.

    Piepho's insert-and-absorb algorithm (Computational Statistics & Data
    Analysis 2004). Start with one column holding every level; for each pair
    found different, split every column holding both into two, one without
    each; then drop any column contained in another. Letters are assigned in
    the order of each column's best member in `order` (best first), so the
    top group is always `a`.

    Unlike a ranking, this survives non-transitive results: A may be
    indistinguishable from B and B from C while A and C differ, and then B
    carries both letters.
    """
    if not order:
        return {}
    columns: list[set[str]] = [set(order)]
    for pair in sorted(different, key=lambda p: sorted(p)):
        x, y = sorted(pair)
        nxt = []
        for col in columns:
            if x in col and y in col:
                nxt += [col - {x}, col - {y}]
            else:
                nxt.append(col)
        # absorb: drop duplicates and any column contained in another
        unique: list[set[str]] = []
        for col in nxt:
            if col and col not in unique:
                unique.append(col)
        columns = [c for c in unique if not any(c < other for other in unique)]
    rank = {lv: i for i, lv in enumerate(order)}
    columns.sort(key=lambda c: (min(rank[lv] for lv in c), sorted(rank[lv] for lv in c)))
    out = {lv: '' for lv in order}
    for i, col in enumerate(columns):
        mark = _letter(i)
        for lv in col:
            out[lv] += mark
    return out


def _letter(i: int) -> str:
    alphabet = 'abcdefghijklmnopqrstuvwxyz'
    return alphabet[i] if i < len(alphabet) else f'{alphabet[i % 26]}{i // 26}'


# ---------------------------------------------------------------------------
# passes per minute
# ---------------------------------------------------------------------------
@dataclass
class Ratio:
    value: float | None
    se: float | None = None
    ci: tuple[float, float] | None = None
    note: str = ''
    method: str = 'delta method'


def passes_per_minute(scores: list[ProblemScore], alpha: float = ALPHA) -> Ratio:
    """Passes per minute with a cluster-aware delta-method interval.

    R = sum(p_i) / sum(w_i): the mean passes per problem over the mean
    minutes per problem, which is the pooled passes per minute when every
    problem has the same number of samples. A ratio of two sums is not a
    mean, so its standard error comes from the delta method: linearise
    around R with residuals e_i = p_i - R w_i, sum them within clusters
    (each problem is its own cluster when there are none), and
    Var(R) = G/(G-1) * sum_c (sum_{i in c} e_i)^2 / (sum_i w_i)^2 -- the same
    CR1 correction the pass-rate standard error uses.

    The interval is formed on the log scale and transformed back, so it
    stays positive: log R +/- z * SE/R.
    """
    if not scores:
        return Ratio(None, note='no problems')
    p = np.array([s.score for s in scores])
    w = np.array([s.minutes for s in scores])
    total_w = float(w.sum())
    if total_w <= 0:
        return Ratio(None, note='no wall-clock time recorded')
    r = float(p.sum() / total_w)
    codes = _cluster_codes([s.cluster for s in scores]) or list(range(len(scores)))
    g = len(set(codes))
    if g < 2:
        return Ratio(r, note='not estimable (1 cluster)' if len(scores) > 1 else 'not estimable (1 problem)')
    e = p - r * w
    sums: dict[int, float] = {}
    for code, value in zip(codes, e, strict=True):
        sums[code] = sums.get(code, 0.0) + float(value)
    var = g / (g - 1) * sum(v * v for v in sums.values()) / (total_w * total_w)
    se = math.sqrt(var)
    if r == 0:
        return Ratio(r, se, note='no passes: the log-scale interval is undefined')
    z = float(sps.norm.ppf(1 - alpha / 2))
    half = z * se / r
    return Ratio(r, se, (r * math.exp(-half), r * math.exp(half)))


# ---------------------------------------------------------------------------
# one configuration's summary
# ---------------------------------------------------------------------------
@dataclass
class Summary:
    scores: dict[str, ProblemScore]
    rate: Estimate
    ci: tuple[float, float] | None
    ppm: Ratio
    n_samples: int = 0
    extra: dict = field(default_factory=dict)


def summarise(records: list[dict], alpha: float = ALPHA) -> Summary:
    """Per-problem scores, the pass rate with its interval, and passes per minute."""
    scores = problem_scores(records)
    values = list(scores.values())
    clusters = [s.cluster for s in values]
    est = mean_se([s.score for s in values], clusters if any(clusters) else None)
    binary = all(s.binary for s in values)
    return Summary(
        scores=scores,
        rate=est,
        ci=rate_interval(est, binary, alpha),
        ppm=passes_per_minute(values, alpha),
        n_samples=sum(s.n_samples for s in values),
    )
