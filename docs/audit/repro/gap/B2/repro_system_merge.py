from local_llm.utils.anthropic import convert_anthropic_to_openai_payload
from local_llm.utils.misc import merge_system_messages, strip_empty_content_blocks

# Anthropic-style request with a two-block system prompt (as Claude Code / SDK clients send)
payload = {
    'model': 'm', 'max_tokens': 100,
    'system': [
        {'type': 'text', 'text': 'Block one: identity.'},
        {'type': 'text', 'text': 'Block two: the long instructions.', 'cache_control': {'type': 'ephemeral'}},
    ],
    'messages': [{'role': 'user', 'content': 'hi'}],
}
openai = convert_anthropic_to_openai_payload(payload)
print('converted system:', openai['messages'][0])
# what process_chat_payload -> normalize_messages_for_model does
msgs = merge_system_messages(strip_empty_content_blocks(openai['messages']))
print('after normalize :', msgs[0])

# OpenAI-format multi-part system message, one system message only
msgs2 = [{'role': 'system', 'content': [{'type': 'text', 'text': 'A'}, {'type': 'text', 'text': 'B'}]},
         {'role': 'user', 'content': 'q'}]
print('openai list system after merge:', merge_system_messages(msgs2)[0])
