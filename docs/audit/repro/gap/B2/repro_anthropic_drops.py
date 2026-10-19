import json
from local_llm.utils.anthropic import convert_anthropic_to_openai_payload
p = {'model': 'm', 'max_tokens': 10,
     'tools': [{'name': 'get_x', 'input_schema': {'type': 'object', 'properties': {}}}],
     'tool_choice': {'type': 'none'},
     'messages': [{'role': 'user', 'content': [
         {'type': 'document', 'title': 'Q3 report', 'source': {'type': 'text', 'media_type': 'text/plain', 'data': 'Revenue was 42.'}},
         {'type': 'text', 'text': 'What was revenue?'}]}]}
out = convert_anthropic_to_openai_payload(p)
print(json.dumps(out['messages']))
print('tool_choice' in out, out.get('tool_choice'))
