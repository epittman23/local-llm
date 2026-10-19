"""Feedback tags: validated on submission, and tolerated on read.

Run from apps/server:

    python -m pytest tests/test_feedback_tags.py
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from local_llm.models.feedbacks import LeaderboardFeedbackData, RatingData
from local_llm.routers.evaluations import _get_top_tags


def test_rating_data_rejects_non_string_tags():
    assert RatingData(tags=['python', 'math']).tags == ['python', 'math']
    with pytest.raises(ValidationError):
        RatingData(tags=[{'x': 1}])
    with pytest.raises(ValidationError):
        RatingData(tags={'x': 1})


def test_leaderboard_survives_malformed_stored_tags():
    rows = [
        LeaderboardFeedbackData(id='1', data={'model_id': 'm', 'tags': None}),
        LeaderboardFeedbackData(id='2', data={'model_id': 'm', 'tags': [{'x': 1}, 'python']}),
        LeaderboardFeedbackData(id='3', data={'model_id': 'm', 'tags': {'x': 1}}),
        LeaderboardFeedbackData(id='4', data={'model_id': 'm', 'tags': ['python']}),
    ]
    assert _get_top_tags(rows) == {'m': [{'tag': 'python', 'count': 2}]}
