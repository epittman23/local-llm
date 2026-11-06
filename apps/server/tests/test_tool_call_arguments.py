"""Tool-call arguments that are not a JSON object are a parse error, not a crash (#166).

A model's tool call carries its arguments as a string. Both readers, the
streaming reply's `_parse_tool_params` and `execute_tool_call_for_output`
(approved tool calls, run when a paused reply resumes), accepted any JSON
value and then called `.items()` on it, so arguments such as `[]`, `1` or
`"x"` raised AttributeError and ended the whole reply with an error, where
malformed JSON already gets a "could not be parsed" result the model can
recover from. A Python literal holding a set or bytes failed the same way
when it was written back as JSON. The string `null` was already unreadable
to the streaming reader and stays so.

Run from apps/server:

    python -m pytest tests/test_tool_call_arguments.py
"""

import asyncio

import pytest

from local_llm.utils import middleware

NOT_OBJECTS = ['[]', '[1, 2]', '1', '"x"', 'true', 'null', "['a']", "{'q': {1}}", "{'q': b'x'}", 7]


def _call(arguments):
    return {'id': 'c1', 'type': 'function', 'function': {'name': 'lookup', 'arguments': arguments}}


@pytest.mark.parametrize('arguments', NOT_OBJECTS)
def test_arguments_that_are_not_an_object_cannot_be_read(arguments):
    call = _call(arguments)

    assert middleware._parse_tool_params(call) is None
    # Left as the model wrote them, as malformed JSON is.
    assert call['function']['arguments'] == arguments


@pytest.mark.parametrize(
    ('arguments', 'params', 'written'),
    [
        ('{"q": 1}', {'q': 1}, '{"q":1}'),
        ("{'q': 1}", {'q': 1}, '{"q":1}'),  # a Python literal
        ('', {}, '{}'),
        ('  ', {}, '{}'),
        (None, {}, '{}'),
        ({'q': 1}, {'q': 1}, '{"q":1}'),  # already an object
    ],
)
def test_an_object_or_no_arguments_are_read(arguments, params, written):
    call = _call(arguments)

    assert middleware._parse_tool_params(call) == params
    assert call['function']['arguments'].replace(' ', '') == written


@pytest.mark.parametrize('arguments', NOT_OBJECTS + ['{not json'])
def test_an_approved_call_with_unreadable_arguments_gets_a_parse_error(arguments):
    ran = []

    async def lookup(**kwargs):
        ran.append(kwargs)
        return 'found'

    metadata = {
        'tools': {
            'lookup': {
                'spec': {'name': 'lookup', 'parameters': {'properties': {'q': {'type': 'string'}}}},
                'type': 'local',
                'callable': lookup,
            }
        }
    }

    result = asyncio.run(
        middleware.execute_tool_call_for_output(None, {}, None, metadata, None, None, _call(arguments))
    )

    assert result['tool_call_id'] == 'c1'
    assert result['content'].startswith('Error: Tool call arguments could not be parsed.')
    assert ran == []
