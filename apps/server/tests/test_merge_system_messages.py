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


def test_text_added_to_a_list_system_message_reaches_the_model_once():
    """Memory, RAG and the model's prompt are added to the system message before or after the merge."""
    from local_llm.utils.misc import add_or_update_system_message

    messages = [{'role': 'system', 'content': [{'type': 'text', 'text': 'A'}, {'type': 'text', 'text': 'B'}]}, USER]
    messages = add_or_update_system_message('MEMORY', messages, append=True)

    assert merge_system_messages(messages)[0] == {'role': 'system', 'content': 'A\nB\nMEMORY'}


def test_a_model_prompt_before_a_cached_block_is_added_once_and_leaves_the_block_alone():
    from local_llm.utils.misc import add_or_update_system_message

    cached = {'type': 'text', 'text': 'Reference', 'cache_control': {'type': 'ephemeral'}}
    merged = merge_system_messages(
        [{'role': 'system', 'content': [{'type': 'text', 'text': 'Identity'}, cached]}, USER]
    )
    out = add_or_update_system_message('MODEL PROMPT', merged, append=False)

    assert out[0]['content'] == [{'type': 'text', 'text': 'MODEL PROMPT\nIdentity'}, cached]


def test_ollama_keeps_parts_apart():
    from local_llm.utils.payload import convert_messages_openai_to_ollama

    out = convert_messages_openai_to_ollama(
        [{'role': 'system', 'content': [{'type': 'text', 'text': 'Identity'}, {'type': 'text', 'text': 'Ref'}]}]
    )

    assert out[0]['content'] == 'Identity\nRef'


def test_the_tool_loop_records_the_whole_system_prompt(monkeypatch):
    """_record_system_prompt's copy is what the native tool loop restores after a round."""
    import asyncio

    from local_llm.utils import middleware

    async def unchanged(prompt, metadata, user):
        return prompt

    messages = [{'role': 'system', 'content': [{'type': 'text', 'text': 'A'}, {'type': 'text', 'text': 'B'}]}, USER]
    metadata: dict = {}
    monkeypatch.setattr(middleware, 'resolve_system_prompt', unchanged)
    asyncio.run(middleware._record_system_prompt({'messages': messages}, metadata, None, None))

    assert metadata['system_prompt'] == 'A\nB'
