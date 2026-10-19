"""benchmarks/analysis/report.py: the sections that state conclusions.

`_assemble()` is the report's pure compute-and-render phase, so these run it
on fixture rows with figures off: no database, no matplotlib.

Run from apps/server:

    python -m pytest tests/test_report.py
"""

from __future__ import annotations

import pytest

from local_llm.benchmarks.analysis import report
from local_llm.benchmarks.analysis.report_figures import Figures


class Rows:
    """Result rows with increasing timestamps, the order the report reads them in."""

    def __init__(self):
        self.rows: list[dict] = []

    def add(self, item, ok, *, config='aaaa', system=None, benchmark='mbpp', window=None, wall_ms=30000, cluster=None):
        self.rows.append(
            {
                'tier': 'smoke',
                'model': 'm',
                'config_id': config,
                'benchmark': benchmark,
                'adapter_sha': f'{benchmark}-ad',
                'system_sha': system,
                'system_name': 'p' if system else None,
                'item_id': str(item),
                'outcome': 'pass' if ok else 'fail_assert',
                'at': len(self.rows) + 1,
                'run_id': None,
                'timings': {'predicted_n': 10, 'predicted_ms': 1000, 'prompt_n': 5, 'prompt_ms': 100},
                'params': {'temperature': 0},
                'wall_ms': wall_ms,
                'dataset_revision': 'rev',
                'item_window': window,
                'cluster': cluster(item) if callable(cluster) else cluster,
            }
        )

    def run(self, outcomes, **kw):
        for i, ok in enumerate(outcomes):
            self.add(i, ok, **kw)


def build(rows: Rows) -> report.ReportResult:
    return report._assemble(rows.rows, {}, {}, [], {'tier': None}, Figures(enabled=False))


def section(md: str, title: str) -> str:
    start = md.index(title)
    nxt = md.find('\n## ', start + 1)
    return md[start : nxt if nxt != -1 else None]


# ---------------------------------------------------------------------------
# the headline follows the statistics (#128)
# ---------------------------------------------------------------------------
def test_headline_states_a_system_prompt_difference_that_survives_correction():
    rows = Rows()
    rows.run([True] * 30)
    rows.run([i < 10 for i in range(30)], system='sha1')
    head = section(build(rows).markdown, '## Headline')
    assert 'System prompts differ in 1 of 1 block(s)' in head
    assert 'No system prompt differs' not in head


def test_headline_null_keeps_the_null_wording():
    rows = Rows()
    rows.run([i % 2 == 0 for i in range(20)])
    rows.run([i % 2 == 0 for i in range(19)] + [True], system='sha1')
    head = section(build(rows).markdown, '## Headline')
    assert 'No system prompt differs from another in any of the 1 block(s)' in head


def test_floor_sentence_appears_only_when_every_difference_is_below_the_floor():
    # Ten items asked twice under the baseline; five flip, so the floor is 50%.
    below = Rows()
    below.run([True] * 10)
    below.run([i < 5 for i in range(10)])
    below.run([True] * 9 + [False], system='sha1')
    head = section(build(below).markdown, '## Headline')
    assert 'none of them is distinguishable from noise' in head

    above = Rows()
    above.run([True] * 10)
    above.run([i < 9 for i in range(10)])
    above.run([False] * 10, system='sha1')
    head = section(build(above).markdown, '## Headline')
    assert 'is above that floor' in head
    assert 'none of them is distinguishable from noise' not in head


def test_a_significant_difference_below_the_floor_asks_for_confirmation_not_dismissal():
    # Floor 50% from ten repeated items; 30 items where the prompt loses 9
    # (30 pp): significant after correction, but below the floor.
    rows = Rows()
    rows.run([True] * 10)
    rows.run([i < 5 for i in range(10)])
    rows.run([True] * 30, benchmark='ds1000')
    rows.run([i >= 9 for i in range(30)], benchmark='ds1000', system='sha1')
    head = section(build(rows).markdown, '## Headline')
    assert 'System prompts differ' in head
    assert 'Confirm the difference above with a re-run' in head
    assert 'none of them is distinguishable from noise' not in head


def test_headline_reports_configuration_groups():
    rows = Rows()
    rows.run([True] * 30)
    rows.run([i < 12 for i in range(30)], config='bbbb')
    head = section(build(rows).markdown, '## Headline')
    assert 'Configurations differ in 1 of 1 block(s)' in head
    assert 'group a = m @ aaaa' in head


# ---------------------------------------------------------------------------
# the configuration comparison
# ---------------------------------------------------------------------------
def test_configuration_section_names_its_methods_and_pairs():
    rows = Rows()
    rows.run([True] * 30)
    rows.run([i < 12 for i in range(30)], config='bbbb')
    body = section(build(rows).markdown, '## 5. Configuration comparison')
    assert 'delta-method' in body and 'Wilson' in body and 'Holm' in body
    assert '| m @ aaaa | m @ bbbb |     30 |' in body
    assert 'exact McNemar' in body


def test_underpowered_comparison_is_explained():
    rows = Rows()
    rows.run([True, True, True, True, False, True, True, False])
    rows.run([True, True, True, False, True, True, False, False], config='bbbb')
    body = section(build(rows).markdown, '## 5. Configuration comparison')
    assert 'n = 8 shared problems' in body and 'this comparison is underpowered' in body


def test_a_clustered_underpowered_pair_reports_its_cluster_robust_se():
    rows = Rows()
    by_three = lambda item: f'q{int(item) // 3}'  # noqa: E731
    rows.run([i % 4 != 0 for i in range(30)], benchmark='ds1000', cluster=by_three)
    rows.run([i % 5 != 0 for i in range(30)], benchmark='ds1000', config='bbbb', cluster=by_three)
    body = section(build(rows).markdown, '## 5. Configuration comparison')
    assert 'cluster-robust SE of the paired difference' in body and '(10 clusters)' in body
    assert 'SD of the paired difference' not in body


def test_one_configuration_per_block_has_nothing_to_compare():
    rows = Rows()
    rows.run([True, False])
    body = section(build(rows).markdown, '## 5. Configuration comparison')
    assert 'No block in scope has more than one configuration' in body


# ---------------------------------------------------------------------------
# power at each block's own n and corrected alpha (#133)
# ---------------------------------------------------------------------------
def test_power_uses_each_blocks_n_and_the_holm_alpha():
    rows = Rows()
    # Block 1 (mbpp): 12 items, three system levels, so m = 2 and alpha 0.025.
    rows.run([True] * 12)
    rows.run([i < 8 for i in range(12)], system='sha1')
    rows.run([i < 10 for i in range(12)], system='sha2')
    # Block 2 (ds1000): 20 items, two levels, so m = 1 and alpha 0.05.
    rows.run([True] * 20, benchmark='ds1000')
    rows.run([i < 15 for i in range(20)], benchmark='ds1000', system='sha1')
    body = section(build(rows).markdown, '## 6. Power')
    assert '|    12 |' in body and '(alpha 0.025)' in body
    assert '|    20 |' in body and '(alpha 0.05)' in body
    # The pooled count (32) describes no test the report runs.
    assert '|    32 |' not in body
    mde_12 = report.detectable_effect(12, 6 / 24, alpha=0.025)
    expected = 'none reachable' if mde_12 is None else f'{100 * mde_12:.0f} pp (alpha 0.025)'
    assert expected in body


def test_detectable_effect_is_larger_at_the_corrected_alpha():
    nominal = report.detectable_effect(200, 0.3)
    corrected = report.detectable_effect(200, 0.3, alpha=0.025)
    assert nominal is not None and corrected is not None
    assert corrected > nominal


# ---------------------------------------------------------------------------
# windows
# ---------------------------------------------------------------------------
def test_windows_are_shown_and_returned():
    rows = Rows()
    rows.run([True, False], benchmark='livecodebench', window='2025-01-01..2025-04-06')
    result = build(rows)
    assert result.windows == ['2025-01-01..2025-04-06']
    assert '**Release-date windows in scope: 2025-01-01..2025-04-06.**' in result.markdown
    assert 'release-date windows' in section(result.markdown, '## 1. Provenance')


def test_no_window_reads_none():
    rows = Rows()
    rows.run([True])
    result = build(rows)
    assert result.windows == []
    assert '| release-date windows ' in result.markdown
    assert 'Release-date windows in scope' not in result.markdown


@pytest.mark.parametrize('title', ['## 6. Power', '## 7. Throughput', '## 8. Throttle audit'])
def test_sections_are_renumbered(title):
    rows = Rows()
    rows.run([True] * 10)
    rows.run([i < 5 for i in range(10)], system='sha1')
    assert title in build(rows).markdown
