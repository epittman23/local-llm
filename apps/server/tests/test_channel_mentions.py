"""Mentions in a channel message become plain text in a model's prompt (docs/history/code-review.md L4)."""

from local_llm.utils.channels import extract_mentions, replace_all_mentions, replace_mentions


def test_channel_mentions_become_hash_labels():
    text = 'ask <@M:gpt|GPT> about <#C:c1|general> and <@U:u1|Ann>'
    assert replace_all_mentions(text) == 'ask GPT about #general and Ann'


def test_label_less_mentions_use_the_id():
    assert replace_all_mentions('<@M:gpt-4o> in <#C:c1>') == 'gpt-4o in #c1'
    assert replace_all_mentions('<#C:c1|general>', use_label=False) == '#c1'


def test_the_early_port_form_still_reads():
    # `<@C:...>` was written by the React port before `<#C:...>`.
    assert replace_all_mentions('see <@C:c1|general>') == 'see general'


def test_replace_mentions_alone_is_unchanged():
    assert replace_mentions('<#C:c1|general>') == '<#C:c1|general>'
    assert extract_mentions('<@M:gpt|GPT> <#C:c1|general>') == [{'id_type': 'M', 'id': 'gpt'}]
