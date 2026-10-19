"""Elo in routers/evaluations.py is order-dependent, and the feedback query has no ORDER BY."""

from local_llm.models.feedbacks import LeaderboardFeedbackData
from local_llm.routers.evaluations import _calculate_elo


def fb(i, winner, loser):
    return LeaderboardFeedbackData(id=f'f{i}', data={'model_id': winner, 'rating': 1, 'sibling_model_ids': [loser]})


rows = [fb(1, 'A', 'B'), fb(2, 'A', 'B'), fb(3, 'B', 'C'), fb(4, 'C', 'A'), fb(5, 'C', 'A')]


def table(stats):
    return {k: round(v['rating']) for k, v in sorted(stats.items())}


print('insertion order :', table(_calculate_elo(rows)))
print('reversed order  :', table(_calculate_elo(list(reversed(rows)))))
# The same five verdicts after feedback f1 is edited (an UPDATE moves the row to the heap's end).
moved = rows[1:] + rows[:1]
print('f1 moved to end :', table(_calculate_elo(moved)))

# Similarity weights are raw cosine similarities; a negative one inverts the verdict.
single = [fb(9, 'A', 'B')]
print('weight  1.0     :', table(_calculate_elo(single, {'f9': 1.0})))
print('weight -0.2     :', table(_calculate_elo(single, {'f9': -0.2})))

# Two models, one win each: who ranks first depends only on which row the database returns first.
pair = [fb(10, 'A', 'B'), fb(11, 'B', 'A')]
print('A>B then B>A    :', table(_calculate_elo(pair)))
print('B>A then A>B    :', table(_calculate_elo(list(reversed(pair)))))
