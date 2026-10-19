"""Mirror main.py chat_completion -> _fan_out_chat -> middleware/openai param handling for a 2-model chat.

Model A (primary, picked first) has workspace params temperature=0.2, max_tokens=512, system "A system".
Model B (second column) has its own workspace params temperature=0.9, system "B system".
The request (chat controls) carries custom_params {"reasoning": {"effort": "high"}}.
"""

from local_llm.utils.misc import merge_model_params
from local_llm.utils.payload import apply_model_params_to_body_openai, apply_params_to_form_data

A_params = {'temperature': 0.2, 'max_tokens': 512, 'system': 'A system'}
B_params = {'temperature': 0.9, 'system': 'B system'}

form_data = {
    'model': 'A',
    'messages': [{'role': 'user', 'content': 'hi'}],
    'params': {'custom_params': {'reasoning': {'effort': 'high'}}},
}

# main.py:1085-1096 _merge_chat_params with the PRIMARY model's info only
request_params = {k: v for k, v in form_data['params'].items() if v is not None}
form_data['params'] = merge_model_params(A_params, request_params)

# main.py:1698-1702 per-model form_data (shallow copy)
per_model = []
for target in ('A', 'B'):
    per_model.append({**form_data, 'model': target, 'metadata': {}})

print('params dict shared between tasks:', per_model[0]['params'] is per_model[1]['params'])

# Tasks run in creation order; each reaches apply_params_to_form_data before its first await
# (middleware.py:2959-2961), then the openai router applies the target model's own params
# (openai.py:1471-1474).
own = {'A': A_params, 'B': B_params}
for fd in per_model:
    target = fd['model']
    model_system_prompt = (fd.get('params') or {}).get('system')
    fd2 = apply_params_to_form_data(fd, {'owned_by': 'openai'})
    p = dict(own[target])
    p.pop('system', None)
    fd2 = apply_model_params_to_body_openai(p, fd2)
    sent = {k: v for k, v in fd2.items() if k not in ('messages', 'metadata')}
    print(f'model {target}: model_system_prompt={model_system_prompt!r} payload={sent}')
