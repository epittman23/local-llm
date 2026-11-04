"""A number cleared in admin Interface settings saves as its default (#248).

The Interface tab sends a cleared number field as null. Three of them were
plain `int` on the server: the autocomplete input's maximum length, and
context compaction's token threshold and retention percentage. So clearing
one refused the whole save with a 422, and since the tab saves its task and
chat settings in two requests at once, the other half could be applied
while this one was refused. A null now means the setting's default; any
other value is validated as before.

Run from apps/server:

    python -m pytest tests/test_interface_cleared_numbers.py
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from local_llm import config
from local_llm.routers.chats import ChatConfigForm
from local_llm.routers.tasks import TaskConfigForm

TASK = {
    'TASK_MODEL': None,
    'TASK_MODEL_EXTERNAL': None,
    'ENABLE_TITLE_GENERATION': True,
    'TITLE_GENERATION_PROMPT_TEMPLATE': '',
    'IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE': '',
    'ENABLE_AUTOCOMPLETE_GENERATION': True,
    'AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH': 200,
    'AUTOCOMPLETE_GENERATION_PROMPT_TEMPLATE': '',
    'TAGS_GENERATION_PROMPT_TEMPLATE': '',
    'FOLLOW_UP_GENERATION_PROMPT_TEMPLATE': '',
    'ENABLE_FOLLOW_UP_GENERATION': True,
    'ENABLE_TAGS_GENERATION': True,
    'ENABLE_SEARCH_QUERY_GENERATION': True,
    'ENABLE_RETRIEVAL_QUERY_GENERATION': True,
    'QUERY_GENERATION_PROMPT_TEMPLATE': '',
    'TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE': '',
    'ENABLE_VOICE_MODE_PROMPT': False,
    'VOICE_MODE_PROMPT_TEMPLATE': None,
}
CHAT = {
    'ENABLE_CONTEXT_COMPACTION': True,
    'CONTEXT_COMPACTION_TOKEN_THRESHOLD': 50_000,
    'CONTEXT_COMPACTION_TOKEN_CAP': None,
    'CONTEXT_COMPACTION_RETENTION_PERCENTAGE': 30,
    'CONTEXT_COMPACTION_PROMPT_TEMPLATE': '',
}


def test_a_cleared_autocomplete_length_is_its_default():
    form = TaskConfigForm(**{**TASK, 'AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH': None})

    # The default is what a fresh install is seeded with.
    assert form.AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH == config.DEFAULT_CONFIG['task.autocomplete.input_max_length']


@pytest.mark.parametrize(
    ('field', 'key'),
    [
        ('CONTEXT_COMPACTION_TOKEN_THRESHOLD', 'chat.context_compaction.token_threshold'),
        ('CONTEXT_COMPACTION_RETENTION_PERCENTAGE', 'chat.context_compaction.retention_percentage'),
    ],
)
def test_a_cleared_compaction_number_is_its_default(field, key):
    form = ChatConfigForm(**{**CHAT, field: None})

    assert getattr(form, field) == config.DEFAULT_CONFIG[key]


def test_a_left_out_retention_and_a_cleared_one_agree():
    left_out = {k: v for k, v in CHAT.items() if k != 'CONTEXT_COMPACTION_RETENTION_PERCENTAGE'}

    assert (
        ChatConfigForm(**left_out).CONTEXT_COMPACTION_RETENTION_PERCENTAGE
        == ChatConfigForm(
            **{**CHAT, 'CONTEXT_COMPACTION_RETENTION_PERCENTAGE': None}
        ).CONTEXT_COMPACTION_RETENTION_PERCENTAGE
    )


def test_values_that_are_set_are_kept():
    assert TaskConfigForm(**TASK).AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH == 200
    form = ChatConfigForm(**CHAT)
    assert (form.CONTEXT_COMPACTION_TOKEN_THRESHOLD, form.CONTEXT_COMPACTION_RETENTION_PERCENTAGE) == (50_000, 30)
    assert form.CONTEXT_COMPACTION_TOKEN_CAP is None


@pytest.mark.parametrize(
    ('form', 'data', 'field'),
    [
        (TaskConfigForm, TASK, 'AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH'),
        (ChatConfigForm, CHAT, 'CONTEXT_COMPACTION_TOKEN_THRESHOLD'),
        (ChatConfigForm, CHAT, 'CONTEXT_COMPACTION_RETENTION_PERCENTAGE'),
    ],
)
def test_a_value_that_is_not_a_number_is_still_refused(form, data, field):
    with pytest.raises(ValidationError):
        form(**{**data, field: 'lots'})
