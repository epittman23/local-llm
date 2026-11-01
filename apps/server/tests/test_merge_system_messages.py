"""merge_system_messages keeps every part of a list-content system message (#187).

Every chat completion passes through merge_system_messages, which folds the
system messages into one at the front (some chat templates, Qwen's among
them, need exactly one). It rebuilt each from get_content_from_message,
which returns only the first text part, so an API client's list-content
system prompt lost every part after the first, and their cache_control.

Run from apps/server:

    python -m pytest tests/test_merge_system_messages.py
"""

from local_llm.utils.anthropic import _system_message
from local_llm.utils.misc import merge_system_messages

USER = {'role': 'user', 'content': 'hi'}


def test_plain_parts_are_joined_into_one_string():
    messages = [
        {'role': 'system', 'content': [{'type': 'text', 'text': 'A'}, {'type': 'text', 'text': 'B'}]},
        USER,
        {'role': 'system', 'content': 'C'},
    ]

    assert merge_system_messages(messages) == [{'role': 'system', 'content': 'A\nB\nC'}, USER]


def test_a_cached_part_keeps_its_cache_control():
    cached = {'type': 'text', 'text': 'Long reference text', 'cache_control': {'type': 'ephemeral'}}
    messages = [{'role': 'system', 'content': [{'type': 'text', 'text': 'Identity'}, cached]}, USER]

    merged = merge_system_messages(messages)

    assert merged == [
        {'role': 'system', 'content': [{'type': 'text', 'text': 'Identity'}, cached]},
        USER,
    ]


def test_an_anthropic_system_prompt_arrives_whole():
    system = _system_message([{'type': 'text', 'text': 'Block one: identity.'}, {'type': 'text', 'text': 'Block two.'}])

    merged = merge_system_messages([system, USER])

    assert merged[0] == {'role': 'system', 'content': 'Block one: identity.\nBlock two.'}


def test_strings_only_are_unchanged():
    messages = [{'role': 'system', 'content': 'A'}, USER, {'role': 'system', 'content': 'B'}]

    assert merge_system_messages(messages) == [{'role': 'system', 'content': 'A\nB'}, USER]
    assert merge_system_messages([USER]) == [USER]
