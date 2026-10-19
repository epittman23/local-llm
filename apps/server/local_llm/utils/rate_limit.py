import math
import time

from local_llm.env import REDIS_KEY_PREFIX


class RateLimiter:
    """
    General-purpose rate limiter using Redis with a rolling window strategy.
    Falls back to in-memory storage if Redis is not available.

    The window is counted in fixed buckets: the current bucket plus as many
    earlier ones as make up the window, ceil(window / bucket_size) in all,
    so a 180 s window with 60 s buckets counts the last 120-180 s. A bucket
    is never wider than the window, so a short window still means what it
    says.
    """

    def __init__(
        self,
        redis_client,
        limit: int,
        window: int,
        bucket_size: int = 60,
        enabled: bool = True,
    ):
        """
        :param redis_client: Redis client instance or None
        :param limit: Max allowed events in the window
        :param window: Time window in seconds
        :param bucket_size: Bucket resolution, capped at the window
        :param enabled: Turn on/off rate limiting globally
        """
        self.r = redis_client
        self.limit = limit
        self.window = max(1, int(window))
        self.bucket_size = max(1, min(int(bucket_size), self.window))
        self.num_buckets = math.ceil(self.window / self.bucket_size)
        self.enabled = enabled
        # Per instance: limiters with different windows must not share counts.
        # Keys whose buckets have all expired are removed (see _sweep), so a
        # spray of distinct keys -- sign-in is keyed by the submitted email --
        # cannot grow this without bound.
        self._memory_store: dict[str, dict[int, int]] = {}
        self._last_sweep = 0

    def _bucket_key(self, key: str, bucket_index: int) -> str:
        return f'{REDIS_KEY_PREFIX}:ratelimit:{key.lower()}:{bucket_index}'

    def _current_bucket(self) -> int:
        return int(time.time()) // self.bucket_size

    def _bucket_indexes(self, now_bucket: int) -> list[int]:
        return [now_bucket - i for i in range(self.num_buckets)]

    def _redis_available(self) -> bool:
        return self.r is not None

    def is_limited(self, key: str) -> bool:
        """
        Main rate-limit check.
        Gracefully handles missing or failing Redis.
        """
        if not self.enabled:
            return False

        if self._redis_available():
            try:
                return self._is_limited_redis(key)
            except Exception:
                return self._is_limited_memory(key)
        else:
            return self._is_limited_memory(key)

    def get_count(self, key: str) -> int:
        if not self.enabled:
            return 0

        if self._redis_available():
            try:
                return self._get_count_redis(key)
            except Exception:
                return self._get_count_memory(key)
        else:
            return self._get_count_memory(key)

    def remaining(self, key: str) -> int:
        used = self.get_count(key)
        return max(0, self.limit - used)

    def _is_limited_redis(self, key: str) -> bool:
        now_bucket = self._current_bucket()
        bucket_key = self._bucket_key(key, now_bucket)

        attempts = self.r.incr(bucket_key)
        if attempts == 1:
            self.r.expire(bucket_key, self.window + self.bucket_size)

        counts = self.r.mget([self._bucket_key(key, b) for b in self._bucket_indexes(now_bucket)])
        total = sum(int(c) for c in counts if c)

        return total > self.limit

    def _get_count_redis(self, key: str) -> int:
        counts = self.r.mget([self._bucket_key(key, b) for b in self._bucket_indexes(self._current_bucket())])
        return sum(int(c) for c in counts if c)

    def _prune(self, store: dict[int, int], now_bucket: int) -> None:
        oldest = now_bucket - self.num_buckets + 1
        for b in [b for b in store if b < oldest]:
            del store[b]

    def _sweep(self, now_bucket: int) -> None:
        """Drop every key with nothing left in the window, at most once per bucket."""
        if now_bucket == self._last_sweep:
            return
        self._last_sweep = now_bucket
        for key in list(self._memory_store):
            store = self._memory_store[key]
            self._prune(store, now_bucket)
            if not store:
                del self._memory_store[key]

    def _is_limited_memory(self, key: str) -> bool:
        now_bucket = self._current_bucket()
        self._sweep(now_bucket)

        store = self._memory_store.setdefault(key, {})
        store[now_bucket] = store.get(now_bucket, 0) + 1
        self._prune(store, now_bucket)

        return sum(store.values()) > self.limit

    def _get_count_memory(self, key: str) -> int:
        now_bucket = self._current_bucket()
        store = self._memory_store.get(key)
        if not store:
            return 0
        self._prune(store, now_bucket)
        if not store:
            del self._memory_store[key]
            return 0
        return sum(store.values())
