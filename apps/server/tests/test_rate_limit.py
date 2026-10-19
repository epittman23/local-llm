"""The rate limiter's window, short windows, and memory bound.

Time is driven by monkeypatching time.time, so nothing here sleeps.

Run from apps/server:

    python -m pytest tests/test_rate_limit.py
"""

from __future__ import annotations

import pytest

from local_llm.utils import rate_limit
from local_llm.utils.rate_limit import RateLimiter


@pytest.fixture
def clock(monkeypatch):
    now = {'t': 1_000_000.0}
    monkeypatch.setattr(rate_limit.time, 'time', lambda: now['t'])
    return now


def test_window_counts_ceil_window_over_bucket_buckets(clock):
    limiter = RateLimiter(None, limit=3, window=180)
    assert limiter.num_buckets == 3
    for _ in range(3):
        assert not limiter.is_limited('a')
    # 180 s later the first three attempts are outside the window.
    clock['t'] += 180
    assert limiter.get_count('a') == 0
    assert not limiter.is_limited('a')


def test_attempts_inside_the_window_count(clock):
    limiter = RateLimiter(None, limit=2, window=180)
    limiter.is_limited('a')
    clock['t'] += 60
    limiter.is_limited('a')
    clock['t'] += 60
    assert limiter.is_limited('a')  # three in 120 s


def test_a_short_window_is_not_widened_to_a_minute(clock):
    limiter = RateLimiter(None, limit=1, window=10)
    assert limiter.bucket_size == 10 and limiter.num_buckets == 1
    limiter.is_limited('a')
    assert limiter.is_limited('a')
    clock['t'] += 10
    assert not limiter.is_limited('a')


def test_distinct_keys_do_not_accumulate(clock):
    limiter = RateLimiter(None, limit=5, window=60)
    for i in range(1000):
        limiter.is_limited(f'user{i}@example.com')
    assert len(limiter._memory_store) == 1000
    clock['t'] += 120
    limiter.is_limited('late@example.com')
    assert list(limiter._memory_store) == ['late@example.com']


def test_limiters_do_not_share_counts(clock):
    a = RateLimiter(None, limit=1, window=60)
    b = RateLimiter(None, limit=1, window=60)
    a.is_limited('k')
    assert b.get_count('k') == 0
