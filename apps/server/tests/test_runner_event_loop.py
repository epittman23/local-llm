"""Grading and suite preparation do not block the backend's event loop (#140).

A grade runs a subprocess for up to the item's timeout, and preparing a suite
probes the grading interpreter; on the event loop either one stalled every
other request the backend was serving. A ticker measures the stall.

Run from apps/server:

    python -m pytest tests/test_runner_event_loop.py
"""

from __future__ import annotations

import asyncio
import time

from local_llm.benchmarks.evaluation import runner

SLOW = 1.5  # seconds a blocking call takes
TICK = 0.05


async def _longest_gap_while(coro) -> float:
    gaps: list[float] = []
    done = asyncio.Event()

    async def ticker():
        last = time.monotonic()
        while not done.is_set():
            await asyncio.sleep(TICK)
            now = time.monotonic()
            gaps.append(now - last)
            last = now

    tick = asyncio.create_task(ticker())
    await asyncio.sleep(TICK * 2)  # the ticker is running before the call starts
    try:
        await coro
    except runner.SuiteLoadError:
        pass
    finally:
        done.set()
        await tick
    return max(gaps)


def test_grading_an_item_leaves_the_event_loop_free(monkeypatch):
    async def ask(*_a, **_k):
        ans = runner.Answer()
        ans.content = '```python\nprint(1)\n```'
        return ans

    async def add_result(record, answer):
        return 1

    def slow_grade(adapter, item, content):
        time.sleep(SLOW)
        return 'pass', ''

    monkeypatch.setattr(runner, 'ask', ask)
    monkeypatch.setattr(runner, 'render_prompt', lambda adapter, item: 'prompt')
    monkeypatch.setattr(runner, 'item_cluster', lambda adapter, item: 'c')
    monkeypatch.setattr(runner, 'grade', slow_grade)
    monkeypatch.setattr(runner.BenchmarkResults, 'add_result', add_result)
    ctx = {
        'suite_run_id': 's',
        'run_id': 'r',
        'model': 'm',
        'config_id': 'c',
        'profile': {},
        'port': 0,
        'stream': False,
        'revisions': {},
        'tier': 't',
        'seed': 0,
        'params': {},
    }
    row = {'adapter': {}, 'item': {}, 'benchmark': 'mbpp', 'item_id': '1'}

    gap = asyncio.run(_longest_gap_while(runner.run_item(None, row, ctx)))
    assert gap < 0.5, f'the event loop stalled for {gap:.2f}s'


def test_preparing_a_suite_leaves_the_event_loop_free(monkeypatch):
    def slow_adapters():
        time.sleep(SLOW)
        raise runner.SuiteLoadError('stop here')

    monkeypatch.setattr(runner, 'load_adapters', slow_adapters)
    gap = asyncio.run(_longest_gap_while(runner.prepare_suite(None, suite_name='smoke')))
    assert gap < 0.5, f'the event loop stalled for {gap:.2f}s'


def _block() -> None:
    time.sleep(SLOW)


def test_the_ticker_would_see_a_stall():
    # The measurement itself: a blocking call on the loop shows as a long gap.
    # Blocking the loop is the point here, so the sleep runs on it directly.
    async def blocks():
        _block()

    assert asyncio.run(_longest_gap_while(blocks())) > SLOW - 0.2
