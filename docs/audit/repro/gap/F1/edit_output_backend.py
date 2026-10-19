from local_llm.utils.middleware import process_messages_with_output, MESSAGE_REPLAY_KEYS
output = [{'type': 'message', 'id': 'o1', 'role': 'assistant', 'status': 'completed',
           'content': [{'type': 'output_text', 'text': 'The answer is 41.'}]}]
# What the port saves after "Edit -> Save": content edited, output untouched.
db = [
    {'id': 'u', 'role': 'user', 'content': 'what is 6*7?'},
    {'id': 'a', 'role': 'assistant', 'content': 'The answer is 42.', 'output': output},
    {'id': 'u2', 'role': 'user', 'content': 'and doubled?'},
]
msgs = [{k: v for k, v in m.items() if k in MESSAGE_REPLAY_KEYS} for m in db]
print(process_messages_with_output(msgs))
