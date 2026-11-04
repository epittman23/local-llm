"""A leaderboard search never reverses a result (#204).

With a search query, the leaderboard weights each feedback's Elo update by
the cosine similarity between the query and the feedback's tags. Cosine
similarity runs from -1 to 1, and `_compute_similarities` passed a negative
value through, so for a feedback whose tags point away from the query the
winner lost points and the loser gained them. A similarity below 0 is now 0:
no relevance, so no change, as for a feedback without tags.

Run from apps/server:

    python -m pytest tests/test_leaderboard_similarity_weight.py
"""

from __future__ import annotations

import pytest

from local_llm.models.feedbacks import LeaderboardFeedbackData
from local_llm.routers import evaluations

# Two-dimensional "embeddings": the query points along x; each tag's angle
# to it sets its cosine similarity.
VECTORS = {
    'query': [1.0, 0.0],
    'same': [1.0, 0.0],
    'related': [0.6, 0.8],
    'opposite': [-0.2, 0.98],
    'reversed': [-1.0, 0.0],
}


class _Model:
    def encode(self, texts):
        import numpy as np

        return np.array([VECTORS[text] for text in texts])


@pytest.fixture(autouse=True)
def model(monkeypatch):
    monkeypatch.setattr(evaluations, '_get_embedding_model', lambda: _Model())


def _feedback(id, tags):
    return LeaderboardFeedbackData(id=id, data={'model_id': 'A', 'rating': 1, 'sibling_model_ids': ['B'], 'tags': tags})


def test_a_tag_pointing_away_from_the_query_weighs_nothing():
    weights = evaluations._compute_similarities(
        [_feedback('f-opposite', ['opposite']), _feedback('f-reversed', ['reversed'])], 'query'
    )

    assert weights == {'f-opposite': 0.0, 'f-reversed': 0.0}


def test_related_tags_keep_their_similarity():
    weights = evaluations._compute_similarities(
        [_feedback('f-same', ['same']), _feedback('f-related', ['related', 'reversed'])], 'query'
    )

    assert weights['f-same'] == pytest.approx(1.0)
    assert weights['f-related'] == pytest.approx(0.6)


def test_a_search_never_turns_a_win_into_points_lost():
    feedbacks = [_feedback('f1', ['opposite'])]

    stats = evaluations._calculate_elo(feedbacks, evaluations._compute_similarities(feedbacks, 'query'))

    assert stats['A']['rating'] >= 1000.0
    assert stats['B']['rating'] <= 1000.0
    assert (stats['A']['won'], stats['B']['lost']) == (1, 1)
