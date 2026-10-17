"""Characterization tests for utils/memory.py's add_memory_context.

It was refactored for ruff's complexity limit with no tests of its own, so
these pin what it did before the refactor: the messages it leaves in
form_data (the memory block it renders into the system message, or no
change), and the vector query it makes. The user's stored memories, the
vector search and the config are fakes; path ranking, message helpers and
section building run for real. Each case was recorded from the untouched
function into fixtures/add_memory_context.json and must not change.

The golden file is only ever written by hand, never by this test. To record
it again (only for an intended behaviour change, reviewed as such), run
`MEMORY_CONTEXT_GOLDEN_RECORD=1 pytest tests/test_add_memory_context.py`.
"""

import asyncio
import copy
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from local_llm.models import memories as memories_model
from local_llm.routers import memories as memories_router
from local_llm.utils import memory

GOLDEN = Path(__file__).parent / 'fixtures' / 'add_memory_context.json'
RECORD = os.environ.get('MEMORY_CONTEXT_GOLDEN_RECORD') == '1'


def _mem(mid, content, path=None, type='context', updated_at=0):
    return {'id': mid, 'content': content, 'path': path, 'type': type, 'updated_at': updated_at}


STORED = [
    _mem('u1', 'Prefers metric units', type='user', updated_at=5),
    _mem('u2', 'Name is Ada', path='profile', type='user', updated_at=3),
    _mem('u3', 'allergic to nuts', path='profile/health', type='user', updated_at=1),
    _mem('c1', 'Kitchen has a gas stove', path='home/kitchen', updated_at=9),
    _mem('c2', 'Fridge is older', path='home/kitchen/fridge', updated_at=8),
    _mem('c3', 'Garden faces south', path='home/garden', updated_at=7),
    _mem('c4', 'Project deadline is Friday', path='work/project', updated_at=6),
]
USER_ONLY = [m for m in STORED if m['type'] == 'user']
CONTEXT_ONLY = [m for m in STORED if m['type'] != 'user']


def _msgs(*texts, system=None):
    messages = [{'role': 'system', 'content': system}] if system is not None else []
    return messages + [{'role': 'user', 'content': t} for t in texts]


VECTOR_HITS = {
    'documents': [
        [
            'work/project\nProject deadline is Friday',
            'Likes jazz',
            '',
            'home/kitchen\nKitchen has a gas stove',
            'orphan doc',
        ]
    ],
    'metadatas': [[{'path': 'work/project', 'type': 'context'}, {'type': 'user'}, {}, {'path': 'home/kitchen'}]],
    'ids': [['c4', 'v1', 'v2', 'c1']],
}

# (case id, settings)
CASES = [
    (
        'memory_disabled_for_model',
        {'model': {'info': {'meta': {'capabilities': {'memory': False}}}}, 'messages': _msgs('hi')},
    ),
    ('no_messages', {'messages': []}),
    ('only_blank_user_messages', {'messages': _msgs('   ', '')}),
    ('only_assistant_messages', {'messages': [{'role': 'assistant', 'content': 'hello'}]}),
    ('user_memories_only', {'memories': USER_ONLY, 'messages': _msgs('hi there')}),
    ('nothing_to_add', {'memories': [], 'messages': _msgs('hi there')}),
    ('neighborhood_from_path_hints', {'memories': CONTEXT_ONLY, 'messages': _msgs('what about the kitchen fridge?')}),
    ('all_sections', {'memories': STORED, 'vector': VECTOR_HITS, 'messages': _msgs('kitchen plans and the project')}),
    ('vector_hits_only', {'memories': [], 'vector': VECTOR_HITS, 'messages': _msgs('anything')}),
    ('vector_search_fails', {'memories': STORED, 'vector': 'raise', 'messages': _msgs('kitchen')}),
    ('vector_result_without_documents', {'memories': USER_ONLY, 'vector': 'no_documents', 'messages': _msgs('x')}),
    (
        'vector_result_empty_documents',
        {'memories': USER_ONLY, 'vector': {'documents': [], 'metadatas': None, 'ids': None}, 'messages': _msgs('x')},
    ),
    (
        'vector_result_without_metadata_or_ids',
        {'memories': [], 'vector': {'documents': [['a', 'b']], 'metadatas': None, 'ids': None}, 'messages': _msgs('x')},
    ),
    (
        'vector_metadata_path_not_a_prefix',
        {
            'memories': [],
            'vector': {'documents': [['no prefix here']], 'metadatas': [[{'path': 'some/path'}]], 'ids': [['z1']]},
            'messages': _msgs('x'),
        },
    ),
    ('last_seven_user_messages', {'memories': USER_ONLY, 'messages': _msgs(*[f'message {i}' for i in range(10)])}),
    ('query_keeps_last_4000_chars', {'memories': USER_ONLY, 'messages': _msgs('a' * 3000, 'b' * 3000)}),
    (
        'multimodal_user_content',
        {
            'memories': USER_ONLY,
            'messages': [
                {
                    'role': 'user',
                    'content': [
                        {'type': 'text', 'text': 'look at this'},
                        {'type': 'image_url', 'image_url': {'url': 'x'}},
                    ],
                }
            ],
        },
    ),
    ('existing_system_message', {'memories': USER_ONLY, 'messages': _msgs('hi', system='You are helpful.')}),
    (
        'replaces_previous_memory_block',
        {
            'memories': USER_ONLY,
            'messages': _msgs('hi', system='Be brief.\n<memory_context>\nold stuff\n</memory_context>\nAlways cite.'),
        },
    ),
    (
        'unterminated_memory_block_left_alone',
        {'memories': USER_ONLY, 'messages': _msgs('hi', system='Start <memory_context> never closed')},
    ),
    (
        'system_message_with_list_content',
        {'memories': USER_ONLY, 'messages': _msgs('hi', system=[{'type': 'text', 'text': 'listed'}])},
    ),
    (
        'char_limits_from_config',
        {
            'memories': STORED,
            'vector': VECTOR_HITS,
            'config': {'user': 300, 'context': 260},
            'messages': _msgs('kitchen project'),
        },
    ),
    (
        'char_limits_below_minimum',
        {'memories': STORED, 'config': {'user': 10, 'context': 1}, 'messages': _msgs('kitchen')},
    ),
    (
        'char_limits_invalid',
        {'memories': STORED, 'config': {'user': 'lots', 'context': 'many'}, 'messages': _msgs('kitchen')},
    ),
    (
        'char_limits_zero_means_default',
        {'memories': STORED, 'config': {'user': 0, 'context': None}, 'messages': _msgs('kitchen')},
    ),
]


def _run(settings: dict, monkeypatch) -> dict:
    calls = {'vector_query': None}
    stored = [SimpleNamespace(**m) for m in settings.get('memories', [])]
    vector = settings.get('vector')
    config = settings.get('config', {})

    async def get_memories_by_user_id(user_id):
        return list(stored)

    async def query_memory(request, form_data, user):
        calls['vector_query'] = {'content': form_data.content, 'k': form_data.k}
        if vector == 'raise':
            raise RuntimeError('vector store down')
        if vector == 'no_documents':
            return SimpleNamespace()
        return SimpleNamespace(**copy.deepcopy(vector)) if vector else None

    async def get_many(*keys):
        return {
            'memories.user_char_limit': config.get('user'),
            'memories.context_char_limit': config.get('context'),
        }

    monkeypatch.setattr(memories_model.Memories, 'get_memories_by_user_id', get_memories_by_user_id)
    monkeypatch.setattr(memories_router, 'query_memory', query_memory)
    monkeypatch.setattr(memory.Config, 'get_many', get_many)

    form_data = {'model': 'm', 'messages': copy.deepcopy(settings['messages'])}
    result = asyncio.run(memory.add_memory_context(None, form_data, SimpleNamespace(id='u1'), settings.get('model')))
    return {'same_object': result is form_data, 'messages': result['messages'], **calls}


def _golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding='utf-8'))


def test_case_ids_are_unique():
    ids = [case[0] for case in CASES]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize(('case_id', 'settings'), CASES, ids=[c[0] for c in CASES])
def test_memory_context_matches_golden(monkeypatch, case_id, settings):
    observed = _run(settings, monkeypatch)
    if RECORD:
        pytest.skip('recording')
    assert observed == _golden()[case_id]


def test_record_golden(monkeypatch):
    """Writes the golden file, only when MEMORY_CONTEXT_GOLDEN_RECORD=1."""
    if not RECORD:
        pytest.skip('set MEMORY_CONTEXT_GOLDEN_RECORD=1 to record the golden file')
    golden = {}
    for case_id, settings in CASES:
        with monkeypatch.context() as m:
            golden[case_id] = _run(settings, m)
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
