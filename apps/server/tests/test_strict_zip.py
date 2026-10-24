"""zip(strict=True) where both sides are built to the same length (ruff B905).

A mismatch now raises instead of silently dropping the tail. These pin the
ordinary result of two of those functions, and that a malformed input is
refused rather than truncated.

Run from apps/server:

    python -m pytest tests/test_strict_zip.py
"""

from __future__ import annotations

import pytest

from local_llm.benchmarks.tuning import tune_schedule as ts
from local_llm.retrieval import utils as retrieval_utils


def _result(distances, documents, metadatas) -> dict:
    return {'distances': [distances], 'documents': [documents], 'metadatas': [metadatas]}


def test_query_results_are_merged_best_first_and_cut_to_k():
    merged = retrieval_utils.merge_and_sort_query_results(
        [
            _result([0.2, 0.9], ['low', 'high'], [{'n': 1}, {'n': 2}]),
            # The same chunk again, scoring better this time.
            _result([0.5, 0.7], ['low', 'mid'], [{'n': 1}, {'n': 3}]),
        ],
        k=2,
    )

    assert merged == {'distances': [[0.9, 0.7]], 'documents': [['high', 'mid']], 'metadatas': [[{'n': 2}, {'n': 3}]]}


def test_no_query_results_merge_to_empty_lists():
    assert retrieval_utils.merge_and_sort_query_results([_result([], [], [])], k=3) == {
        'distances': [[]],
        'documents': [[]],
        'metadatas': [[]],
    }


def test_a_query_result_with_fewer_scores_than_documents_is_refused():
    with pytest.raises(ValueError):
        retrieval_utils.merge_and_sort_query_results([_result([0.1], ['a', 'b'], [{}, {}])], k=2)


def test_a_schedule_counts_each_rounds_item_visits():
    schedule = ts.plan_schedule(tier_size=100, candidates=8, round_items=4)

    assert schedule.survivors == [8, 4, 2]
    assert schedule.slices == [(0, 4), (4, 12), (12, 28)]
    assert schedule.item_visits == 8 * 4 + 4 * 8 + 2 * 16
    assert [row[-1] for row in schedule.rows()] == ['32', '32', '32']
