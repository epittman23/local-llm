"""A model is not its own leaderboard opponent, and an empty id is none (#278).

sibling_model_ids holds the model of every other reply to the same prompt,
so a regeneration by the same model put the winner among its own opponents:
the Elo update played the model against itself, leaving its rating where it
was but counting a win and a loss. A reply with no model id became a
phantom '' entry. Stored feedback still holds such lists, so the leaderboard
skips them rather than relying on the frontend no longer sending them.

Run from apps/server:

    python -m pytest tests/test_leaderboard_self_opponent.py
"""

from local_llm.models.feedbacks import LeaderboardFeedbackData
from local_llm.routers.evaluations import _calculate_elo


def _feedback(rating: int, siblings: list) -> LeaderboardFeedbackData:
    return LeaderboardFeedbackData(id='f', data={'model_id': 'm', 'rating': rating, 'sibling_model_ids': siblings})


def test_a_regeneration_by_the_same_model_is_not_an_opponent():
    assert _calculate_elo([_feedback(1, ['m'])]) == {}
    assert _calculate_elo([_feedback(-1, ['m'])]) == {}


def test_an_empty_sibling_id_is_not_an_opponent():
    assert _calculate_elo([_feedback(1, ['', None])]) == {}


def test_only_the_real_opponents_count():
    assert _calculate_elo([_feedback(1, ['m', '', 'b'])]) == _calculate_elo([_feedback(1, ['b'])])
    stats = _calculate_elo([_feedback(1, ['m', '', 'b'])])
    assert round(stats['m']['rating']) == 1016
    assert round(stats['b']['rating']) == 984
    assert (stats['m']['won'], stats['m']['lost'], stats['b']['won'], stats['b']['lost']) == (1, 0, 0, 1)
