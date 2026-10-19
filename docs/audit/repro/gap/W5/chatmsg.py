import local_llm.routers.ollama as o
cases = [
  {'role': 'assistant', 'content': None, 'tool_calls': [{'function': {'name': 'f', 'arguments': {}}}]},
  {'role': 'assistant', 'tool_calls': [{'function': {'name': 'f', 'arguments': {}}}], 'content': None},
  {'role': 'assistant'},
  {'role': 'assistant', 'content': None},
]
for c in cases:
    try:
        m = o.ChatMessage(**c); print('OK  ', c, '->', m.model_dump(exclude_none=True))
    except Exception as e:
        print('FAIL', c, '->', str(e).splitlines()[1:3])
