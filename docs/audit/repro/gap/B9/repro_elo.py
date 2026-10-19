"""Repro: leaderboard Elo (routers/evaluations._calculate_elo) edge cases."""
from local_llm.models.feedbacks import LeaderboardFeedbackData as F
from local_llm.routers.evaluations import _calculate_elo

# 1. Regenerated reply: siblings are the same model (feedback.ts builds sibling_model_ids from all childrenIds).
fb = [F(id='a', data={'model_id': 'M', 'rating': 1, 'sibling_model_ids': ['M']})]
print('1. thumbs-up on a regenerated reply ->', _calculate_elo(fb))

# 2. Order dependence: same three feedbacks, two row orders (the SELECT has no ORDER BY).
f1 = F(id='1', data={'model_id': 'A', 'rating': 1, 'sibling_model_ids': ['B']})
f2 = F(id='2', data={'model_id': 'B', 'rating': 1, 'sibling_model_ids': ['C']})
f3 = F(id='3', data={'model_id': 'C', 'rating': 1, 'sibling_model_ids': ['A']})
f4 = F(id='4', data={'model_id': 'A', 'rating': 1, 'sibling_model_ids': ['C']})
for order in ([f1, f2, f3, f4], [f4, f3, f2, f1]):
    s = _calculate_elo(order)
    print('2. order', [f.id for f in order], {k: round(v['rating']) for k, v in s.items()},
          'ranking:', sorted(s, key=lambda k: -round(s[k]['rating'])))

# 3. Negative similarity weight from the query search inverts a loss into a gain.
fl = [F(id='x', data={'model_id': 'A', 'rating': -1, 'sibling_model_ids': ['B']})]
print('3. A lost, weight -0.2 ->', {k: (round(v['rating'], 1), v['won'], v['lost']) for k, v in _calculate_elo(fl, {'x': -0.2}).items()})

# 4. One win each way: the leader is whichever row the database returns last.
g1 = F(id='g1', data={'model_id': 'A', 'rating': 1, 'sibling_model_ids': ['B']})
g2 = F(id='g2', data={'model_id': 'B', 'rating': 1, 'sibling_model_ids': ['A']})
for order in ([g1, g2], [g2, g1]):
    s = _calculate_elo(order)
    print('4. order', [f.id for f in order], {k: round(v['rating']) for k, v in s.items()})
