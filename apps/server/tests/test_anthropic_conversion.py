"""Characterization tests for the Anthropic Messages API conversion.

convert_anthropic_to_openai_payload and openai_stream_to_anthropic_stream
were refactored for ruff's complexity limit with no tests of their own, so
these pin what they did before the refactor: every case's output was
recorded from the untouched functions into fixtures/anthropic_conversion.json
and must not change. The stream is compared byte for byte, since key order
inside each SSE event is what a client receives.

The golden file is only ever written by hand, never by this test. To record
it again (only for an intended behaviour change, reviewed as such), run
`ANTHROPIC_GOLDEN_RECORD=1 pytest tests/test_anthropic_conversion.py`.
"""

import asyncio
import copy
import json
import os
import uuid
from pathlib import Path

import pytest

from local_llm.utils.anthropic import convert_anthropic_to_openai_payload, openai_stream_to_anthropic_stream

GOLDEN = Path(__file__).parent / 'fixtures' / 'anthropic_conversion.json'
RECORD = os.environ.get('ANTHROPIC_GOLDEN_RECORD') == '1'

B64 = 'iVBORw0KGgo='
CACHE = {'type': 'ephemeral'}

# (case id, payload, passthrough_params)
PAYLOAD_CASES = [
    ('minimal', {}, None),
    ('model_and_string_message', {'model': 'm', 'messages': [{'role': 'user', 'content': 'hi'}]}, None),
    ('role_defaults_to_user', {'messages': [{'content': 'hi'}]}, None),
    ('system_string', {'system': 'be brief', 'messages': []}, None),
    ('system_empty_string_is_dropped', {'system': '', 'messages': []}, None),
    (
        'system_blocks_single_text_flattens',
        {'system': [{'type': 'text', 'text': 'rules'}], 'messages': []},
        None,
    ),
    (
        'system_blocks_mixed',
        {
            'system': [
                {'type': 'text', 'text': 'a', 'cache_control': CACHE},
                'plain string',
                {'type': 'image', 'source': {}},
                7,
            ],
            'messages': [],
        },
        None,
    ),
    ('system_blocks_all_skipped', {'system': [{'type': 'image'}], 'messages': []}, None),
    ('system_other_type_is_dropped', {'system': 42, 'messages': []}, None),
    (
        'content_list_text_and_cache',
        {
            'messages': [
                {'role': 'user', 'content': [{'type': 'text', 'text': 'one'}]},
                {'role': 'user', 'content': [{'type': 'text', 'text': 'two', 'cache_control': CACHE}]},
                {'role': 'user', 'content': [{'text': 'no type means text'}, {'type': 'text'}]},
            ]
        },
        None,
    ),
    (
        'thinking_blocks_are_kept_verbatim',
        {
            'messages': [
                {
                    'role': 'assistant',
                    'content': [
                        {'type': 'thinking', 'thinking': 'hmm', 'signature': 'sig'},
                        {'type': 'redacted_thinking', 'data': 'xx', 'cache_control': CACHE},
                        {'type': 'text', 'text': 'answer'},
                    ],
                }
            ]
        },
        None,
    ),
    (
        'images',
        {
            'messages': [
                {
                    'role': 'user',
                    'content': [
                        {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/jpeg', 'data': B64}},
                        {'type': 'image', 'source': {'type': 'base64', 'data': B64}, 'cache_control': CACHE},
                        {'type': 'image', 'source': {'type': 'url', 'url': 'https://x/i.png'}},
                        {'type': 'image', 'source': {'type': 'url'}},
                        {'type': 'image', 'source': {'type': 'file', 'file_id': 'f1'}},
                        {'type': 'image'},
                        {'type': 'video', 'source': {}},
                    ],
                }
            ]
        },
        None,
    ),
    (
        'only_unknown_blocks_adds_no_message',
        {'messages': [{'role': 'user', 'content': [{'type': 'video'}]}]},
        None,
    ),
    ('empty_content_list_adds_no_message', {'messages': [{'role': 'user', 'content': []}]}, None),
    (
        'non_string_non_list_content',
        {
            'messages': [
                {'role': 'user', 'content': None},
                {'role': 'user'},
                {'role': 'user', 'content': 0},
                {'role': 'user', 'content': 12},
                {'role': 'user', 'content': {'a': 1}},
            ]
        },
        None,
    ),
    (
        'tool_use_inputs',
        {
            'messages': [
                {
                    'role': 'assistant',
                    'content': [
                        {'type': 'tool_use', 'id': 't1', 'name': 'f', 'input': {'q': 'x', 'n': [1, 2]}},
                        {'type': 'tool_use', 'id': 't2', 'name': 'g', 'input': 'raw string'},
                        {'type': 'tool_use', 'id': 't3', 'name': 'h'},
                        {'type': 'tool_use', 'input': [1, 2]},
                    ],
                }
            ]
        },
        None,
    ),
    (
        'tool_use_with_text_and_cache',
        {
            'messages': [
                {
                    'role': 'assistant',
                    'content': [
                        {'type': 'text', 'text': 'calling', 'cache_control': CACHE},
                        {'type': 'tool_use', 'id': 't1', 'name': 'f', 'input': {}},
                    ],
                },
                {
                    'role': 'assistant',
                    'content': [
                        {'type': 'text', 'text': 'only text'},
                        {'type': 'tool_use', 'id': 't2', 'name': 'f', 'input': {}},
                    ],
                },
            ]
        },
        None,
    ),
    (
        'tool_results_string_and_error',
        {
            'messages': [
                {
                    'role': 'user',
                    'content': [
                        {'type': 'tool_result', 'tool_use_id': 't1', 'content': 'ok'},
                        {'type': 'tool_result', 'tool_use_id': 't2', 'content': 'bad', 'is_error': True},
                        {'type': 'tool_result', 'tool_use_id': 't3'},
                        {'type': 'tool_result', 'content': 5},
                        {'type': 'tool_result', 'tool_use_id': 't4', 'content': 5, 'is_error': True},
                    ],
                }
            ]
        },
        None,
    ),
    (
        'tool_result_list_text_only_flattens',
        {
            'messages': [
                {
                    'role': 'user',
                    'content': [
                        {
                            'type': 'tool_result',
                            'tool_use_id': 't1',
                            'content': [{'type': 'text', 'text': 'a'}, {'text': 'b'}, 'skipped string', 3],
                        },
                        {'type': 'tool_result', 'tool_use_id': 't2', 'content': [], 'is_error': True},
                        {'type': 'tool_result', 'tool_use_id': 't3', 'content': [{'type': 'video'}]},
                    ],
                }
            ]
        },
        None,
    ),
    (
        'tool_result_list_multimodal',
        {
            'messages': [
                {
                    'role': 'user',
                    'content': [
                        {
                            'type': 'tool_result',
                            'tool_use_id': 't1',
                            'is_error': True,
                            'content': [
                                {'type': 'text', 'text': 'see image'},
                                {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/gif', 'data': B64}},
                                {'type': 'image', 'source': {'type': 'base64', 'data': B64}, 'cache_control': CACHE},
                                {'type': 'image', 'source': {'type': 'url', 'url': 'https://x/y.png'}},
                                {'type': 'image', 'source': {'type': 'url'}, 'cache_control': CACHE},
                                {'type': 'image', 'source': {'type': 'file'}},
                                {'type': 'image'},
                            ],
                        },
                        {'type': 'text', 'text': 'after the result'},
                    ],
                }
            ]
        },
        None,
    ),
    (
        'tool_result_cache_control_keeps_list',
        {
            'messages': [
                {
                    'role': 'user',
                    'content': [
                        {
                            'type': 'tool_result',
                            'tool_use_id': 't1',
                            'content': [{'type': 'text', 'text': 'cached', 'cache_control': CACHE}],
                        }
                    ],
                }
            ]
        },
        None,
    ),
    (
        'tool_result_documents_and_search_results',
        {
            'messages': [
                {
                    'role': 'user',
                    'content': [
                        {
                            'type': 'tool_result',
                            'tool_use_id': 't1',
                            'content': [
                                {
                                    'type': 'document',
                                    'title': 'Spec',
                                    'context': 'ctx',
                                    'source': {'type': 'text', 'data': 'body'},
                                },
                                {'type': 'document', 'source': {'type': 'text', 'data': ''}},
                                {'type': 'document', 'source': {'type': 'base64', 'data': 'pdfbytes'}},
                                {'type': 'document'},
                                {
                                    'type': 'search_result',
                                    'title': 'Hit',
                                    'source': 'https://s',
                                    'content': [
                                        {'type': 'text', 'text': 'l1'},
                                        {'type': 'image'},
                                        'str',
                                        {'type': 'text', 'text': 'l2'},
                                    ],
                                },
                                {'type': 'search_result'},
                            ],
                        },
                        {
                            'type': 'tool_result',
                            'tool_use_id': 't2',
                            'content': [
                                {'type': 'document', 'title': 'D'},
                                {'type': 'image', 'source': {'type': 'url', 'url': 'u'}},
                            ],
                        },
                    ],
                }
            ]
        },
        None,
    ),
    (
        'tool_results_come_before_their_message',
        {
            'messages': [
                {
                    'role': 'user',
                    'content': [
                        {'type': 'text', 'text': 'first'},
                        {'type': 'tool_result', 'tool_use_id': 't1', 'content': 'r'},
                        {'type': 'tool_use', 'id': 'u1', 'name': 'f', 'input': {}},
                    ],
                }
            ]
        },
        None,
    ),
    ('max_tokens', {'max_tokens': 99}, None),
    (
        'common_parameters',
        {
            'temperature': 0.2,
            'top_p': 0.9,
            'top_k': 40,
            'stop_sequences': ['END'],
            'stream': True,
            'metadata': {'user_id': 'u'},
            'service_tier': 'auto',
        },
        None,
    ),
    ('passthrough_none_drops_unknown', {'model': 'm', 'seed': 1, 'logprobs': True}, None),
    ('passthrough_comma_string', {'seed': 1, 'logprobs': True, 'user': 'x'}, 'seed, logprobs ,, missing'),
    ('passthrough_list', {'seed': 1, 'logprobs': True}, ['logprobs', 2, ' ']),
    ('passthrough_single_name', {'seed': 1}, ['seed']),
    ('passthrough_invalid_type', {'seed': 1}, 5),
    ('passthrough_star', {'model': 'm', 'seed': 1, 'max_tokens': 5, 'temperature': 0.5, 'n': 2}, '*'),
    (
        'passthrough_star_then_overrides',
        {
            'response_format': {'type': 'text'},
            'stop': ['raw'],
            'stop_sequences': ['converted'],
            'output_config': {'format': {'type': 'json_object'}},
        },
        '*',
    ),
    (
        'output_config_effort',
        {'output_config': {'effort': 'high'}},
        None,
    ),
    (
        'reasoning_effort_beats_output_config',
        {'reasoning_effort': 'low', 'output_config': {'effort': 'high'}},
        None,
    ),
    (
        'output_config_json_schema',
        {
            'output_config': {
                'format': {
                    'type': 'json_schema',
                    'name': 'thing',
                    'schema': {'type': 'object'},
                    'description': 'd',
                    'strict': True,
                }
            }
        },
        None,
    ),
    ('output_config_json_schema_defaults', {'output_config': {'format': {'type': 'json_schema'}}}, None),
    ('output_config_other_format', {'output_config': {'format': {'type': 'text'}}}, None),
    ('output_config_non_dict_format', {'output_config': {'format': 'json'}}, None),
    ('output_config_non_dict', {'output_config': 'high'}, None),
    (
        'tools',
        {
            'tools': [
                {'name': 'f', 'description': 'd', 'input_schema': {'type': 'object'}},
                {'name': 'g', 'cache_control': CACHE},
                {},
            ]
        },
        None,
    ),
    ('tools_empty', {'tools': []}, None),
    ('tool_choice_auto', {'tool_choice': {'type': 'auto'}}, None),
    ('tool_choice_default_type', {'tool_choice': {}}, None),
    ('tool_choice_any', {'tool_choice': {'type': 'any'}}, None),
    ('tool_choice_tool', {'tool_choice': {'type': 'tool', 'name': 'f'}}, None),
    ('tool_choice_tool_no_name', {'tool_choice': {'type': 'tool'}}, None),
    ('tool_choice_none_type', {'tool_choice': {'type': 'none'}}, None),
    ('tool_choice_non_dict', {'tool_choice': 'auto'}, None),
]


def _data(obj) -> dict:
    return {'data': obj}


def _delta(**delta) -> dict:
    return _data({'choices': [{'delta': delta}]})


def _tool(index=0, id=None, name=None, args=None) -> dict:
    call = {'index': index}
    if id is not None:
        call['id'] = id
    function = {}
    if name is not None:
        function['name'] = name
    if args is not None:
        function['arguments'] = args
    if function:
        call['function'] = function
    return call


def _finish(reason) -> dict:
    return _data({'choices': [{'delta': {}, 'finish_reason': reason}]})


# (case id, chunks, model, input_tokens). A chunk is {'data': obj} (one SSE
# data line), {'raw': str} (sent as is), {'bytes': str} (sent utf-8 encoded),
# or {'raise': msg} (the source generator raises RuntimeError(msg)).
STREAM_CASES = [
    ('empty_stream', [], '', None),
    ('empty_stream_with_model_and_tokens', [], 'm', 12),
    (
        'text_only',
        [_delta(role='assistant'), _delta(content='Hel'), _delta(content='lo'), _finish('stop')],
        'm',
        None,
    ),
    (
        'line_handling',
        [
            {'raw': ': keep-alive\n\nevent: ping\n\n'},
            {'raw': 'data: {}\n\n'},
            {'raw': 'data: [DONE]\n\n'},
            {'raw': 'data: not json\n\n'},
            {'raw': 'data: {"choices": []}\n\n'},
            {
                'raw': 'data: {"choices": [{"delta": {"content": "a"}}]}\n'
                'data: {"choices": [{"delta": {"content": "b"}}]}'
            },
            {'bytes': 'data: {"choices": [{"delta": {"content": "c"}}]}\n\n'},
            {'raw': '   data:{"choices": [{"delta": {"content": "d"}}]}   '},
            # A JSON value that is not an object raises inside the loop; the one
            # try/except around the whole loop ends the conversion there.
            {'raw': 'data: "a string"\n\n'},
            {'raw': 'data: {"choices": [{"delta": {"content": "never sent"}}]}\n\n'},
        ],
        '',
        None,
    ),
    (
        'thinking_then_text',
        [
            _delta(reasoning_content='Let me '),
            _delta(reasoning='think'),
            _delta(thinking='.'),
            _delta(content='Answer'),
            _delta(reasoning_content='ignored once text is open'),
            _finish('stop'),
        ],
        'm',
        None,
    ),
    (
        'thinking_from_message_and_blocks',
        [
            _data({'choices': [{'delta': {}, 'message': {'reasoning_content': 'from message'}}]}),
            _data({'choices': [{'delta': {}, 'message': {'reasoning': 'from message reasoning'}}]}),
            _delta(thinking_blocks=['not a dict', {'thinking': ''}, {'content': 'block content'}]),
            _delta(thinking_blocks=[{'text': 'block text'}, {'thinking': 'second, unused'}]),
            _data({'choices': [{'delta': {}, 'message': {'thinking_blocks': [{'thinking': 'message block'}]}}]}),
            _delta(thinking_blocks=[{}]),
        ],
        '',
        None,
    ),
    (
        'thinking_left_open_at_end',
        [_delta(reasoning_content='still thinking')],
        '',
        None,
    ),
    (
        'thinking_then_tool_call',
        [
            _delta(reasoning_content='plan'),
            _delta(tool_calls=[_tool(0, 'call_1', 'search', '{"q": "x"}')]),
            _delta(reasoning_content='after a tool, ignored'),
            _finish('tool_calls'),
        ],
        '',
        None,
    ),
    (
        'text_then_tool_call_in_pieces',
        [
            _delta(content='Looking it up.'),
            _delta(tool_calls=[_tool(0, 'call_1', 'search')]),
            _delta(tool_calls=[_tool(0, args='{"q": ')]),
            _delta(tool_calls=[_tool(0, args='"x"}')]),
            _delta(tool_calls=[_tool(0, args=' ')]),
            _delta(content='text after a tool is dropped'),
            _finish('tool_calls'),
        ],
        'm',
        3,
    ),
    (
        'parallel_tools_sharing_an_index',
        [
            _delta(tool_calls=[_tool(0, 'call_a', 'f', '{"a": 1}')]),
            _delta(tool_calls=[_tool(0, 'call_b', 'g', '{"b": ')]),
            _delta(tool_calls=[_tool(0, args='2}')]),
            _delta(tool_calls=[_tool(1, 'call_c', 'h'), _tool(2, 'call_d', 'k', '{}')]),
            _delta(tool_calls=[_tool(1, args='{"c": 3}')]),
            _delta(tool_calls=[_tool(0, 'call_a', args='{"ignored": true}')]),
            _finish('tool_calls'),
        ],
        '',
        None,
    ),
    (
        'tool_without_id_gets_fallback_id',
        [
            _delta(tool_calls=[_tool(0, name='f', args='{"x"')]),
            _delta(tool_calls=[_tool(0, args=': 1}')]),
        ],
        '',
        None,
    ),
    (
        'tool_name_arrives_after_arguments',
        [
            _delta(tool_calls=[_tool(0, 'call_1', args='{"early": ')]),
            _delta(tool_calls=[_tool(0, name='late_name')]),
            _delta(tool_calls=[_tool(0, args='true}')]),
        ],
        '',
        None,
    ),
    (
        'tool_without_name_never_starts',
        [
            _delta(tool_calls=[_tool(0, 'call_1', args='{"x": 1}')]),
            _delta(tool_calls=[{'index': 1, 'function': None}]),
            _finish('tool_calls'),
        ],
        '',
        None,
    ),
    (
        'tool_arguments_not_an_object',
        [
            _delta(tool_calls=[_tool(0, 'call_1', 'f', '[1, ')]),
            _delta(tool_calls=[_tool(0, args='2]')]),
            _delta(tool_calls=[_tool(1, 'call_2', 'g', '"str')]),
            _delta(tool_calls=[_tool(2, 'call_3', 'h', '{"open": ')]),
            _delta(tool_calls=[_tool(2, args='"}"')]),
        ],
        '',
        None,
    ),
    (
        'tool_calls_on_message_object',
        [
            _delta(content='x'),
            _data(
                {
                    'choices': [
                        {
                            'delta': {},
                            'message': {'tool_calls': [_tool(0, 'call_m', 'from_message', '{}')]},
                            'finish_reason': 'tool_calls',
                        }
                    ]
                }
            ),
        ],
        '',
        None,
    ),
    (
        'tool_name_updated_only_if_empty',
        [
            _delta(tool_calls=[_tool(0, 'call_1', 'first', '{')]),
            _delta(tool_calls=[_tool(0, 'call_1', 'second', '}')]),
        ],
        '',
        None,
    ),
    (
        'finish_reasons',
        [_delta(content='a'), _finish('length'), _finish('content_filter'), _finish('length')],
        '',
        None,
    ),
    ('finish_reason_unknown', [_delta(content='a'), _finish('weird')], '', None),
    (
        'usage_openai_style',
        [
            _delta(content='a'),
            _data(
                {
                    'choices': [],
                    'usage': {
                        'prompt_tokens': 100,
                        'completion_tokens': 7,
                        'prompt_tokens_details': {'cached_tokens': 30},
                    },
                }
            ),
        ],
        '',
        5,
    ),
    (
        'usage_anthropic_style',
        [
            _data(
                {
                    'choices': [{'delta': {'content': 'a'}, 'finish_reason': 'stop'}],
                    'usage': {
                        'input_tokens': 9,
                        'output_tokens': 4,
                        'cache_creation_input_tokens': 2,
                        'cache_read_input_tokens': 1,
                        'output_tokens_details': {'reasoning_tokens': 3},
                        'server_tool_use': {'web_search_requests': 1},
                        'service_tier': 'standard',
                    },
                }
            ),
            _data({'choices': [], 'usage': {'prompt_tokens': 2, 'cache_creation_input_tokens': 5}}),
            _data({'choices': [], 'usage': 'not a dict'}),
            _data({'choices': [], 'usage': {'prompt_tokens_details': 'nope', 'output_tokens_details': 'nope'}}),
        ],
        '',
        None,
    ),
    (
        'malformed_chunk_stops_the_conversion',
        [
            _delta(content='before'),
            _data({'choices': [{'delta': None}]}),
            _delta(content='after, never sent'),
            _finish('length'),
        ],
        '',
        None,
    ),
    (
        'source_raises_with_blocks_open',
        [
            _delta(reasoning_content='thinking'),
            _delta(tool_calls=[_tool(0, 'call_1', 'f', '{"partial": ')]),
            {'raise': 'connection reset'},
        ],
        'm',
        None,
    ),
    (
        'source_raises_with_text_open',
        [_delta(content='half'), {'raise': 'boom'}],
        '',
        None,
    ),
]


@pytest.fixture
def fixed_uuid(monkeypatch):
    """uuid.uuid4 returns UUID(int=1), UUID(int=2), ... so ids are stable."""
    counter = iter(range(1, 10_000))
    monkeypatch.setattr(uuid, 'uuid4', lambda: uuid.UUID(int=next(counter)))


async def _source(chunks):
    for chunk in chunks:
        if 'raise' in chunk:
            raise RuntimeError(chunk['raise'])
        if 'bytes' in chunk:
            yield chunk['bytes'].encode()
        elif 'raw' in chunk:
            yield chunk['raw']
        else:
            yield f'data: {json.dumps(chunk["data"])}\n\n'


def _run_stream(chunks, model, input_tokens) -> list[str]:
    async def collect():
        return [
            event.decode()
            async for event in openai_stream_to_anthropic_stream(
                _source(chunks), model=model, input_tokens=input_tokens
            )
        ]

    return asyncio.run(collect())


def _golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding='utf-8'))


def test_cases_have_unique_ids():
    for cases in (PAYLOAD_CASES, STREAM_CASES):
        ids = [case[0] for case in cases]
        assert len(ids) == len(set(ids))


@pytest.mark.parametrize(('case_id', 'payload', 'passthrough'), PAYLOAD_CASES, ids=[c[0] for c in PAYLOAD_CASES])
def test_payload_conversion_matches_golden(case_id, payload, passthrough):
    before = copy.deepcopy(payload)
    result = convert_anthropic_to_openai_payload(payload, passthrough)
    assert payload == before, 'the input payload must not be mutated'
    if RECORD:
        pytest.skip('recording')
    assert result == _golden()['payload'][case_id]


@pytest.mark.parametrize(('case_id', 'chunks', 'model', 'input_tokens'), STREAM_CASES, ids=[c[0] for c in STREAM_CASES])
def test_stream_conversion_matches_golden(fixed_uuid, case_id, chunks, model, input_tokens):
    events = _run_stream(chunks, model, input_tokens)
    if RECORD:
        pytest.skip('recording')
    assert events == _golden()['stream'][case_id]


def test_record_golden(fixed_uuid, monkeypatch):
    """Writes the golden file, only when ANTHROPIC_GOLDEN_RECORD=1."""
    if not RECORD:
        pytest.skip('set ANTHROPIC_GOLDEN_RECORD=1 to record the golden file')
    golden = {'payload': {}, 'stream': {}}
    for case_id, payload, passthrough in PAYLOAD_CASES:
        golden['payload'][case_id] = convert_anthropic_to_openai_payload(copy.deepcopy(payload), passthrough)
    for case_id, chunks, model, input_tokens in STREAM_CASES:
        counter = iter(range(1, 10_000))
        monkeypatch.setattr(uuid, 'uuid4', lambda c=counter: uuid.UUID(int=next(c)))
        golden['stream'][case_id] = _run_stream(chunks, model, input_tokens)
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
