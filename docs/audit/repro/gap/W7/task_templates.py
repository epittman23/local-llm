import asyncio
import types

from local_llm.utils.task import replace_messages_variable, replace_prompt_variable, title_generation_template

msgs = [
    {'role': 'user', 'content': 'first question'},
    {'role': 'assistant', 'content': 'first answer'},
    {'role': 'user', 'content': 'In Jinja, how do I print {{USER_EMAIL}} and {{MESSAGES}}?'},
]
user = types.SimpleNamespace(model_dump=lambda: {'id': 'u1', 'name': 'Eli', 'email': 'eli@example.com'})


async def main():
    out = await title_generation_template('Title for: {{prompt}}', msgs, user)
    print('--- title task prompt built from the last user message ---')
    print(out)
    print('--- END:0 / prompt:end:0 ---')
    print(repr(replace_messages_variable('{{MESSAGES:END:0}}', msgs)))
    print(repr(replace_prompt_variable('{{prompt:end:0}}', 'abcdef')))


asyncio.run(main())
