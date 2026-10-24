"""The sign test before a tune cut pairs the two candidates item by item.

Sweep.eliminate() once zipped two log_ratios() lists, one per candidate.
Each list drops the items its candidate did not serve, so once one of them
missed an item the zip paired one item's ratio with another's, and the
sign test judged the cut on differences between unrelated items.

Run from apps/server:

    python -m pytest tests/test_tune_pairing.py
"""

from __future__ import annotations

import math

import pytest

from local_llm.benchmarks.tuning import tune_schedule as ts

ITEMS = [('b', '1'), ('b', '2'), ('b', '3'), ('b', '4')]


def _matrix(**tps_by_sha: list[float | None]) -> dict:
    return {
        (*key, sha): {'gen_tps': tps}
        for sha, series in tps_by_sha.items()
        for key, tps in zip(ITEMS, series, strict=True)
        if tps is not None
    }


def test_differences_are_taken_per_item():
    m = _matrix(base=[10, 10, 10, 10], hi=[20, 10, 40, 10], lo=[10, 20, 10, 20])

    got = ts.paired_log_ratio_differences(m, 'hi', 'lo', 'base', ITEMS)

    assert got == pytest.approx([math.log(2), -math.log(2), math.log(4), -math.log(2)])


def test_an_item_one_candidate_missed_is_left_out_not_shifted():
    # lo has no result for item 2. Zipping the two log_ratios() lists paired
    # hi's item 2 with lo's item 3, and so on down the list.
    m = _matrix(base=[10, 10, 10, 10], hi=[20, 30, 40, 50], lo=[20, None, 40, 50])

    assert ts.paired_log_ratio_differences(m, 'hi', 'lo', 'base', ITEMS) == pytest.approx([0.0, 0.0, 0.0])
    assert ts.sign_test(ts.paired_log_ratio_differences(m, 'hi', 'lo', 'base', ITEMS)) == (1.0, 0)


def test_an_item_the_baseline_missed_or_served_at_zero_is_left_out():
    m = _matrix(base=[10, None, 0, 10], hi=[20, 20, 20, 20], lo=[10, 10, 10, 10])

    assert ts.paired_log_ratio_differences(m, 'hi', 'lo', 'base', ITEMS) == pytest.approx([math.log(2)] * 2)


def test_log_ratios_is_unchanged():
    m = _matrix(base=[10, 10, 0, 10], hi=[20, None, 20, 5])

    assert ts.log_ratios(m, 'hi', 'base', ITEMS) == pytest.approx([math.log(2), math.log(0.5)])
