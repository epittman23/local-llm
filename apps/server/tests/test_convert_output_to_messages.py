"""Characterization tests for utils/misc.py's convert_output_to_messages.

It was refactored for ruff's complexity limit with no tests of its own, so
these pin what it did before the refactor: every case's output was recorded
from the untouched function into fixtures/convert_output_to_messages.json
and must not change.

The golden file is only ever written by hand, never by this test. To record
it again (only for an intended behaviour change, reviewed as such), run
`OUTPUT_MESSAGES_GOLDEN_RECORD=1 pytest tests/test_convert_output_to_messages.py`.
"""

import copy
import json
import os
from pathlib import Path

import pytest

from local_llm.utils.misc import convert_output_to_messages

GOLDEN = Path(__file__).parent / 'fixtures' / 'convert_output_to_messages.json'
RECORD = os.environ.get('OUTPUT_MESSAGES_GOLDEN_RECORD') == '1'


def _msg(*texts):
    return {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': t} for t in texts]}


def _call(call_id, name='f', arguments='{}', status='completed'):
    item = {'type': 'function_call', 'call_id': call_id, 'name': name, 'status': status}
    if arguments is not None:
        item['arguments'] = arguments
    return item


def _out(call_id, *parts):
    return {'type': 'function_call_output', 'call_id': call_id, 'output': list(parts)}


def _text(text):
    return {'type': 'input_text', 'text': text}


def _image(url):
    return {'type': 'input_image', 'image_url': url}


def _reasoning(summary=None, content=None, **extra):
    item = {'type': 'reasoning', **extra}
    if summary is not None:
        item['summary'] = summary
    if content is not None:
        item['content'] = content
    return item


SIGNED = {'type': 'reasoning.text', 'format': 'anthropic-claude-v1', 'text': 't', 'signature': 's'}
UNSIGNED = {'type': 'reasoning.text', 'format': 'anthropic-claude-v1', 'text': 't'}
OTHER_FORMAT = {'type': 'reasoning.encrypted', 'format': 'openai-responses-v1', 'data': 'x'}
TOOL_ROUND = [_msg('calling'), _call('c1', arguments='{"q": 1}'), _out('c1', _text('result'))]

# (case id, output, kwargs)
CASES = [
    ('none', None, {}),
    ('empty_list', [], {}),
    ('not_a_list', {'type': 'message'}, {}),
    ('one_message', [_msg('Hello', ' world')], {}),
    (
        'message_parts',
        [
            {
                'type': 'message',
                'content': [
                    {'type': 'output_text', 'text': 'kept'},
                    {'type': 'refusal', 'refusal': 'no'},
                    {'type': 'output_text'},
                    {'type': 'output_text', 'text': ''},
                ],
            },
            {'type': 'message', 'content': [{'type': 'output_text', 'text': ''}]},
            {'type': 'message'},
        ],
        {},
    ),
    ('messages_join_with_newline', [_msg('first'), _msg('second'), _msg('third')], {}),
    ('tool_round', TOOL_ROUND, {}),
    ('tool_round_then_message', [*TOOL_ROUND, _msg('done')], {}),
    (
        'arguments_forms',
        [
            _call('c1', arguments={'a': [1, 2]}),
            _call('c2', arguments=None),
            _call('c3', arguments=[1]),
            _out('c1', _text('one')),
            _out('c2', _text('two')),
            _out('c3', _text('three')),
        ],
        {},
    ),
    (
        'call_statuses',
        [
            _call('done', status='completed'),
            _call('failed', status='failed'),
            _call('rejected', status='rejected'),
            _call('running', status='in_progress'),
            _call('no_status', status=None),
            _out('done', _text('a')),
            _out('failed', _text('b')),
            _out('rejected', _text('c')),
            _out('running', _text('d')),
            _out('no_status', _text('e')),
        ],
        {},
    ),
    (
        'unpaired_calls_and_outputs_are_dropped',
        [
            _msg('before'),
            _call('no_output'),
            _out('no_call', _text('orphan')),
            {'type': 'function_call', 'status': 'completed'},
            {'type': 'function_call_output', 'output': [_text('no id')]},
        ],
        {},
    ),
    (
        'tool_output_parts',
        [
            _call('c1'),
            _out('c1', _text('a'), _text(42), {'type': 'input_text'}, _image('u1'), _image(''), {'type': 'other'}),
            _call('c2'),
            {'type': 'function_call_output', 'call_id': 'c2'},
        ],
        {},
    ),
    (
        'tool_images_kept_in_tool_message',
        [_call('c1'), _out('c1', _text('see'), _image('u1'), _image('u2')), _msg('after')],
        {},
    ),
    (
        'tool_images_flattened',
        [
            _call('c1'),
            _call('c2'),
            _out('c1', _text('see'), _image('u1')),
            _out('c2', _image('u2')),
            _msg('after'),
            _call('c3'),
            _out('c3', _image('u3')),
        ],
        {'flatten_tool_images': True},
    ),
    (
        'tool_outputs_flush_before_other_items',
        [
            _call('c1'),
            _out('c1', _text('r1')),
            _reasoning(summary=[{'type': 'summary_text', 'text': 'think'}]),
            _call('c2'),
            _out('c2', _text('r2')),
            {'type': 'unknown_item'},
            _msg('end'),
        ],
        {'reasoning_format': 'reasoning_content'},
    ),
    (
        'reasoning_skipped_without_format',
        [_reasoning(summary=[{'type': 'summary_text', 'text': 'hidden'}]), _msg('answer')],
        {},
    ),
    (
        'reasoning_thinking_field',
        [
            _reasoning(summary=[{'type': 'summary_text', 'text': 'a'}, {'type': 'output_text', 'text': 'b'}]),
            _reasoning(summary=[], content=[{'type': 'reasoning_text', 'text': 'from content'}]),
            _reasoning(summary=[{'type': 'no_text'}]),
            _msg('answer'),
        ],
        {'reasoning_format': 'thinking'},
    ),
    (
        'reasoning_content_field',
        [_reasoning(content=[{'text': 'only content'}]), _call('c1'), _out('c1', _text('r'))],
        {'reasoning_format': 'reasoning_content'},
    ),
    (
        'reasoning_think_tags',
        [
            _reasoning(summary=[{'type': 'summary_text', 'text': 'default tags'}]),
            _reasoning(
                summary=[{'type': 'summary_text', 'text': 'custom'}],
                start_tag='<reasoning>',
                end_tag='</reasoning>',
            ),
            _reasoning(summary=[]),
            _msg('answer'),
        ],
        {'reasoning_format': 'think_tags'},
    ),
    (
        'reasoning_unknown_format',
        [_reasoning(summary=[{'type': 'summary_text', 'text': 'x'}]), _msg('answer')],
        {'reasoning_format': 'something_else'},
    ),
    (
        'reasoning_details_need_raw',
        [_reasoning(summary=[{'type': 'summary_text', 'text': 'x'}], reasoning_details=[SIGNED]), _msg('a')],
        {},
    ),
    (
        'reasoning_details_raw_without_format',
        [
            _reasoning(
                summary=[{'type': 'summary_text', 'text': 'x'}],
                reasoning_details=[SIGNED, UNSIGNED, OTHER_FORMAT, 'bad'],
            ),
            _reasoning(reasoning_details=SIGNED),
            _reasoning(reasoning_details=[UNSIGNED]),
            _reasoning(reasoning_details=[]),
            _msg('a'),
        ],
        {'raw': True},
    ),
    (
        'reasoning_details_raw_with_format',
        [
            _reasoning(summary=[{'type': 'summary_text', 'text': 'x'}], reasoning_details=[OTHER_FORMAT]),
            _call('c1'),
            _out('c1', _text('r')),
        ],
        {'raw': True, 'reasoning_format': 'thinking'},
    ),
    (
        'reasoning_only_message',
        [_reasoning(summary=[{'type': 'summary_text', 'text': 'just thinking'}])],
        {'reasoning_format': 'reasoning_content'},
    ),
    (
        'code_interpreter',
        [
            {'type': 'open_webui:code_interpreter', 'code': 'print(1)', 'output': {'stdout': '1\n', 'result': 'r'}},
            {'type': 'open_webui:code_interpreter', 'code': '', 'output': {'result': 'only result'}},
            {'type': 'open_webui:code_interpreter', 'code': 'x', 'output': {'stdout': '', 'result': ''}},
            {'type': 'open_webui:code_interpreter', 'code': 'y', 'output': 'plain output'},
            {'type': 'open_webui:code_interpreter', 'output': 5},
            {'type': 'open_webui:code_interpreter'},
            _msg('after'),
        ],
        {},
    ),
    ('code_interpreter_raw', [{'type': 'open_webui:code_interpreter', 'code': 'z', 'output': 'o'}], {'raw': True}),
    (
        'other_extension_items_skipped',
        [_msg('a'), {'type': 'open_webui:status', 'text': 'x'}, {'type': 'open_webui:files'}, _msg('b')],
        {},
    ),
    ('item_without_type', [{'content': 'x'}, _msg('a')], {}),
    (
        'interleaved_rounds',
        [
            _msg('step 1'),
            _call('c1', name='search', arguments='{"q": "a"}'),
            _out('c1', _text('found a')),
            _msg('step 2'),
            _call('c2', name='search', arguments='{"q": "b"}'),
            _call('c3', name='fetch', arguments='{"u": "x"}', status='failed'),
            _out('c2', _text('found b')),
            _out('c3', _text('error')),
            _msg('final'),
        ],
        {},
    ),
]


def _golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding='utf-8'))


def test_case_ids_are_unique():
    ids = [case[0] for case in CASES]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize(('case_id', 'output', 'kwargs'), CASES, ids=[c[0] for c in CASES])
def test_matches_golden(case_id, output, kwargs):
    before = copy.deepcopy(output)
    result = convert_output_to_messages(copy.deepcopy(output) if output is not None else None, **kwargs)
    assert output == before
    if RECORD:
        pytest.skip('recording')
    assert result == _golden()[case_id]


def test_record_golden():
    """Writes the golden file, only when OUTPUT_MESSAGES_GOLDEN_RECORD=1."""
    if not RECORD:
        pytest.skip('set OUTPUT_MESSAGES_GOLDEN_RECORD=1 to record the golden file')
    golden = {case_id: convert_output_to_messages(copy.deepcopy(output), **kwargs) for case_id, output, kwargs in CASES}
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
