"""A sub-agent limit of -1 means unlimited for tool iterations and output too (#193).

`_subagent_limits` documents -1 as unlimited, but only the two concurrency
limits honoured it. `max_iterations = -1` reached the tool-call loop as
`iterations < -1`, which is never true, so a sub-agent could not make a
single tool call; and `max_output = -1` made `len(summary) > -1` true for
every summary: its last character was dropped and the truncation marker
appended. -1 now becomes None for both, which the tool-call loop and the
truncation read as no limit. Any other value below 1 is 1.

Run from apps/server:

    python -m pytest tests/test_subagent_unlimited.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from local_llm.utils import subagents


def _limits(**values):
    return subagents._subagent_limits({f'subagents.{key}': value for key, value in values.items()})


def test_minus_one_is_no_limit_for_iterations_and_output():
    assert _limits(max_iterations=-1, max_output=-1)[2:] == (None, None)


def test_minus_one_still_means_unlimited_concurrency():
    assert _limits(max_concurrent=-1, max_async=-1)[:2] == (-1, -1)


def test_unset_or_zero_limits_take_the_defaults():
    assert _limits() == (20, 20, 30, 30_000)
    assert _limits(max_concurrent=0, max_async=0, max_iterations=0, max_output=0) == (20, 20, 30, 30_000)


def test_other_values_below_one_are_one():
    assert _limits(max_concurrent=-5, max_async=-5, max_iterations=-5, max_output=-5) == (1, 1, 1, 1)


def test_positive_limits_are_kept():
    assert _limits(max_concurrent=3, max_async=4, max_iterations=7, max_output=10) == (3, 4, 7, 10)


@pytest.fixture
def run(monkeypatch):
    """A sub-agent run whose completion writes `content`; returns (run, the child request's state)."""
    states = []

    def build_request(request, user_id, internal):
        child = SimpleNamespace(state=SimpleNamespace())
        states.append(child.state)
        return child

    async def handler(request, form_data, user=None):
        return None

    async def release():
        return None

    monkeypatch.setattr(subagents, '_build_request', build_request)

    def make(content, max_iterations, max_output):
        async def get_message(chat_id, message_id):
            return {'content': content}

        monkeypatch.setattr(subagents.Chats, 'get_message_by_id_and_message_id', get_message)
        agent = object.__new__(subagents._SubagentRun)
        agent.request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(CHAT_COMPLETION_HANDLER=handler)))
        agent.user = SimpleNamespace(id='u1')
        agent.chat_id, agent.assistant_message_id = 'c1', 'm1'
        agent.max_iterations, agent.max_output = max_iterations, max_output
        agent._completion_form = lambda: {}
        agent.release = release
        return agent, states

    return make


def test_an_unlimited_run_keeps_its_whole_summary_and_has_no_iteration_cap(run):
    agent, states = run('x' * 50_000, *_limits(max_iterations=-1, max_output=-1)[2:])

    result = asyncio.run(agent.run_reserved())

    assert result == {'status': 'completed', 'summary': 'x' * 50_000, 'error': None}
    assert states[0].max_tool_call_iterations is None


def test_a_limited_run_is_still_truncated(run):
    agent, states = run('x' * 50, 7, 10)

    result = asyncio.run(agent.run_reserved())

    assert result['summary'] == 'x' * 10 + '\n\n[output truncated]'
    assert states[0].max_tool_call_iterations == 7
