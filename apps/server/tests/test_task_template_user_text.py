"""A task prompt fills in its own variables, never ones inside the user's text (#305).

Each task template (title, tags, follow-ups, queries, ...) put the user's
prompt and messages in first, then expanded the whole text, so a message
mentioning {{USER_EMAIL}} or {{MESSAGES}} (a Jinja question, say) had them
filled in: the user's email, or the whole conversation again.

Run from apps/server:

    python -m pytest tests/test_task_template_user_text.py
"""

import asyncio
from types import SimpleNamespace

from local_llm.utils import task

USER = SimpleNamespace(model_dump=lambda: {'name': 'Ada', 'email': 'ada@example.invalid'})
QUESTION = 'In Jinja, how do I print {{USER_EMAIL}} and {{MESSAGES}}?'
MESSAGES = [{'role': 'user', 'content': QUESTION}]


def _run(coroutine):
    return asyncio.run(coroutine)


def test_a_title_prompt_keeps_the_users_placeholders_as_written():
    template = 'Name this chat for {{USER_NAME}}.\n{{MESSAGES:END:2}}'

    prompt = _run(task.title_generation_template(template, MESSAGES, USER))

    assert 'Name this chat for Ada.' in prompt
    assert QUESTION in prompt
    assert 'ada@example.invalid' not in prompt
    assert prompt.count(QUESTION) == 1


def test_a_query_prompt_keeps_a_prompt_placeholder_inside_a_message():
    messages = [{'role': 'user', 'content': 'What does {{prompt}} do in a template?'}]

    prompt = _run(task.query_generation_template('Q: {{prompt}}\nHistory: {{MESSAGES}}', messages, USER))

    assert prompt.count('{{prompt}}') == 2  # once from the prompt, once from the history


def test_every_task_template_fills_its_own_variables():
    template = 'For {{USER_NAME}}: {{prompt}}'
    prompts = [
        _run(task.tags_generation_template(template, MESSAGES, USER)),
        _run(task.follow_up_generation_template(template, MESSAGES, USER)),
        _run(task.image_prompt_generation_template(template, MESSAGES, USER)),
        _run(task.emoji_generation_template(template, QUESTION, USER)),
        _run(task.autocomplete_generation_template(template + ' {{TYPE}}', QUESTION, MESSAGES, 'search', USER)),
    ]

    for prompt in prompts:
        assert prompt.startswith(f'For Ada: {QUESTION}')
        assert 'ada@example.invalid' not in prompt


def test_prompt_truncation_still_applies():
    prompt = _run(task.emoji_generation_template('{{prompt:start:5}}|{{prompt:end:3}}', 'abcdefghij', USER))

    assert prompt == 'abcde|hij'
