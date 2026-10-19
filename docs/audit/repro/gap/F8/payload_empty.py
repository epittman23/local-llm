from local_llm.utils.payload import apply_params_to_form_data
fd = {'model': 'qwen/qwen3.6-27b', 'messages': [], 'params': {'temperature': '', 'seed': '', 'stop': None}}
print(apply_params_to_form_data(fd, {'id': 'qwen/qwen3.6-27b', 'owned_by': 'openai'}))
