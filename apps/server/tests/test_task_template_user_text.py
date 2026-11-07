"""A task prompt fills in its own variables, never ones inside the user's text (#305).

Each task template (title, tags, follow-ups, queries, ...) put the user's
prompt and messages in first, then expanded the whole text, so a message
mentioning {{USER_EMAIL}} or {{MESSAGES}} (a Jinja question, say) had them
filled in: the user's email, or the whole conversation again. Context
compaction's summary prompt and the mixture-of-agents prompt did the same
with their own sections (#648).

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
    # Passed before the fix too (the prompt went in before the messages); it
    # guards the order the tokens are swapped back in.
    messages = [{'role': 'user', 'content': 'What does {{prompt}} do in a template?'}]

    prompt = _run(task.query_generation_template('Q: {{prompt}}\nHistory: {{MESSAGES}}', messages, USER))

    assert prompt.count('{{prompt}}') == 2  # once from the prompt, once from the history


def test_a_prompt_mentioning_messages_does_not_repeat_the_conversation():
    messages = [
        {'role': 'assistant', 'content': 'Hello there.'},
        {'role': 'user', 'content': 'What does {{MESSAGES}} hold?'},
    ]

    prompt = _run(task.query_generation_template('Q: {{prompt}}\nHistory: {{MESSAGES}}', messages, USER))

    assert 'Q: What does {{MESSAGES}} hold?' in prompt
    assert prompt.count('Hello there.') == 1


def test_a_message_without_text_leaves_no_prompt_placeholder():
    messages = [{'role': 'user', 'content': [{'type': 'image_url', 'image_url': {'url': 'data:,'}}]}]

    prompt = _run(task.title_generation_template('P=[{{prompt}}] S=[{{prompt:start:5}}]', messages, USER))

    assert prompt == 'P=[] S=[]'


def test_a_filled_in_value_is_not_read_for_placeholders():
    user = SimpleNamespace(model_dump=lambda: {'name': 'Ada', 'bio': 'I write {{MESSAGES}} and {{prompt}}.'})

    prompt = _run(task.title_generation_template('Bio: {{USER_BIO}}\n{{MESSAGES}}', MESSAGES, user))

    assert prompt.startswith('Bio: I write {{MESSAGES}} and {{prompt}}.\n')
    assert prompt.count(QUESTION) == 1


def test_an_autocomplete_type_goes_in_as_written():
    for kind in ('{{PROMPT}}{{USER_EMAIL}}', '\x000\x00', '\x005\x00'):
        prompt = _run(task.autocomplete_generation_template('<t>{{TYPE}}</t>{{PROMPT}}', 'abc', None, kind, USER))

        assert prompt == f'<t>{kind}</t>abc'


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


def _summary_prompt(monkeypatch, compacted, recent, previous_summary=None, template=''):
    from local_llm.utils import chat, context_compaction

    seen = []

    async def get_many(*keys):
        return {}

    async def generate_chat_completion(request, form_data, user):
        seen.append(form_data['messages'][0]['content'])
        return {'choices': [{'message': {'content': 'summary'}}]}

    monkeypatch.setattr(context_compaction, 'Config', SimpleNamespace(get_many=get_many))
    monkeypatch.setattr(chat, 'generate_chat_completion', generate_chat_completion)
    request = SimpleNamespace(state=SimpleNamespace())
    models = {'m': {'id': 'm', 'info': {'params': {}}}}

    _run(
        context_compaction._generate_summary(request, USER, 'm', models, compacted, recent, previous_summary, template)
    )
    return seen[0]


def test_a_compaction_prompt_keeps_the_users_placeholders_as_written(monkeypatch):
    # #648: the summary prompt filled its sections in turn over the whole text.
    asked = 'Why do {{RECENT_MESSAGES}}, {{PREVIOUS_SUMMARY}} and {{USER_EMAIL}} stay empty?'
    compacted = [{'role': 'user', 'content': asked}]
    recent = [{'role': 'assistant', 'content': 'Kept in context.'}]

    prompt = _summary_prompt(monkeypatch, compacted, recent, 'Earlier summary.')

    assert asked in prompt
    assert prompt.count('Kept in context.') == 1
    assert prompt.count('Earlier summary.') == 1
    assert 'ada@example.invalid' not in prompt


def test_a_previous_summary_goes_in_as_written(monkeypatch):
    summary = 'The user asked about {{USER_EMAIL}} and {{COMPACTED_MESSAGES}}.'
    compacted = [{'role': 'user', 'content': 'Compacted away.'}]

    prompt = _summary_prompt(monkeypatch, compacted, [], summary)

    assert summary in prompt
    assert prompt.count('Compacted away.') == 1
    assert 'ada@example.invalid' not in prompt


def test_a_compaction_prompt_fills_its_own_variables(monkeypatch):
    template = 'For {{USER_NAME}}: {{prompt}} | {{PREVIOUS_SUMMARY}} | {{COMPACTED_MESSAGES}} | {{RECENT_MESSAGES}}'
    compacted = [{'role': 'user', 'content': 'Old.'}]
    recent = [{'role': 'user', 'content': 'New.'}]

    prompt = _summary_prompt(monkeypatch, compacted, recent, 'Before.', template)

    assert prompt == 'For Ada: New. | Before. | USER: Old. | USER: New.'


def test_a_moa_prompt_mentioning_responses_does_not_repeat_them():
    # #648: the prompt went in first, then {{responses}} was replaced over the whole text.
    prompt = _run(
        task.moa_response_generation_template('Q: "{{prompt}}"\nA: {{responses}}', 'What is {{responses}}?', ['one'])
    )

    assert prompt == 'Q: "What is {{responses}}?"\nA: """one"""'


def test_a_moa_response_goes_in_as_written():
    # Passed before the fix too (the prompt went in before the responses).
    prompt = _run(
        task.moa_response_generation_template('Q: {{prompt}}\nA: {{responses}}', 'x', ['{{prompt}} {{USER_NAME}}'])
    )

    assert prompt == 'Q: x\nA: """{{prompt}} {{USER_NAME}}"""'
