"""Characterization tests for two built-in tools in tools/builtin.py.

replace_note_content and query_knowledge_files were refactored for ruff's
complexity limit with no tests of their own, so these pin what they did
before the refactor: the JSON each returns, and for the note tool the
update it writes, for the knowledge tool every access check made and which
collections were searched. Notes, knowledge bases, files, access grants,
groups, the vector search and external knowledge are fakes that record
their calls. Each case was recorded from the untouched functions into
fixtures/note_and_knowledge_tools.json and must not change.

The golden file is only ever written by hand, never by this test. To record
it again (only for an intended behaviour change, reviewed as such), run
`BUILTIN_TOOLS_GOLDEN_RECORD=1 pytest tests/test_note_and_knowledge_tools.py`.
"""

import asyncio
import copy
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from local_llm.models import access_grants, files, knowledge, notes
from local_llm.retrieval import external
from local_llm.retrieval import utils as retrieval_utils
from local_llm.tools import builtin

GOLDEN = Path(__file__).parent / 'fixtures' / 'note_and_knowledge_tools.json'
RECORD = os.environ.get('BUILTIN_TOOLS_GOLDEN_RECORD') == '1'

USER = {
    'id': 'u1', 'name': 'Ada', 'email': 'ada@example.invalid', 'role': 'user',
    'profile_image_url': '', 'last_active_at': 0, 'updated_at': 0, 'created_at': 0,
}  # fmt: skip
ADMIN = {**USER, 'id': 'a1', 'role': 'admin'}
TEXT = 'Hello world. This is a note.'

# --- replace_note_content cases: (case id, kwargs, world) ---
NOTE_CASES = [
    ('no_request', {'note_id': 'n1', 'content': 'x'}, {'request': False}),
    ('no_user', {'note_id': 'n1', 'content': 'x'}, {'user': None}),
    ('note_missing', {'note_id': 'nope', 'content': 'x'}, {}),
    ('write_denied', {'note_id': 'n1', 'content': 'x'}, {'writable': False}),
    ('admin_skips_write_check', {'note_id': 'n1', 'content': 'x'}, {'writable': False, 'user': ADMIN}),
    ('whole_content', {'note_id': 'n1', 'content': 'new text', 'title': 'New title'}, {}),
    ('content_required', {'note_id': 'n1'}, {}),
    ('title_alone_needs_content', {'note_id': 'n1', 'title': 'only title'}, {}),
    ('operations_empty', {'note_id': 'n1', 'operations': []}, {}),
    ('operations_not_a_list', {'note_id': 'n1', 'operations': {'action': 'replace'}}, {}),
    ('operation_not_an_object', {'note_id': 'n1', 'operations': ['replace']}, {}),
    ('replace_operation', {'note_id': 'n1', 'operations': [{'action': 'replace', 'content': 'all new'}]}, {}),
    (
        'replace_must_be_alone',
        {'note_id': 'n1', 'operations': [{'action': 'replace', 'content': 'a'}, {'action': 'replace', 'content': 'b'}]},
        {},
    ),
    ('replace_content_not_string', {'note_id': 'n1', 'operations': [{'action': 'replace', 'content': 5}]}, {}),
    ('unknown_action', {'note_id': 'n1', 'operations': [{'action': 'append', 'content': 'x'}]}, {}),
    (
        'range_one',
        {'note_id': 'n1', 'operations': [{'action': 'replace_range', 'start': 0, 'end': 5, 'content': 'Howdy'}]},
        {},
    ),
    (
        'range_several_out_of_order',
        {
            'note_id': 'n1',
            'operations': [
                {'action': 'replace_range', 'start': 13, 'end': 17, 'content': 'That', 'expected': 'This'},
                {'action': 'replace_range', 'start': 0, 'end': 5, 'content': 'Hi'},
            ],
        },
        {},
    ),
    (
        'range_not_integers',
        {'note_id': 'n1', 'operations': [{'action': 'replace_range', 'start': '0', 'end': 5, 'content': 'x'}]},
        {},
    ),
    (
        'range_content_not_string',
        {'note_id': 'n1', 'operations': [{'action': 'replace_range', 'start': 0, 'end': 5}]},
        {},
    ),
    (
        'range_negative',
        {'note_id': 'n1', 'operations': [{'action': 'replace_range', 'start': -1, 'end': 5, 'content': 'x'}]},
        {},
    ),
    (
        'range_backwards',
        {'note_id': 'n1', 'operations': [{'action': 'replace_range', 'start': 5, 'end': 2, 'content': 'x'}]},
        {},
    ),
    (
        'range_past_end',
        {'note_id': 'n1', 'operations': [{'action': 'replace_range', 'start': 0, 'end': 999, 'content': 'x'}]},
        {},
    ),
    (
        'range_expected_mismatch',
        {
            'note_id': 'n1',
            'operations': [{'action': 'replace_range', 'start': 0, 'end': 5, 'content': 'x', 'expected': 'Bye'}],
        },
        {},
    ),
    (
        'ranges_overlap',
        {
            'note_id': 'n1',
            'operations': [
                {'action': 'replace_range', 'start': 0, 'end': 8, 'content': 'a'},
                {'action': 'replace_range', 'start': 6, 'end': 10, 'content': 'b'},
            ],
        },
        {},
    ),
    (
        'note_without_content',
        {'note_id': 'n_empty', 'operations': [{'action': 'replace_range', 'start': 0, 'end': 0, 'content': 'first'}]},
        {},
    ),
    ('stop_tasks_fails', {'note_id': 'n1', 'content': 'x'}, {'stop_fails': True}),
    ('update_fails', {'note_id': 'n1', 'content': 'x'}, {'update': None}),
    ('update_raises', {'note_id': 'n1', 'content': 'x'}, {'update': 'raise'}),
]

# --- query_knowledge_files cases: (case id, kwargs, world) ---
KB_CASES = [
    ('kb_no_request', {'query': 'q'}, {'request': False}),
    ('kb_no_user', {'query': 'q'}, {'user': None}),
    ('kb_no_embedding_function', {'query': 'q'}, {'embedding': False}),
    ('all_accessible', {'query': 'q'}, {}),
    ('all_accessible_none_found', {'query': 'q'}, {'search': []}),
    ('specific_ids', {'query': 'q', 'knowledge_ids': ['kb_own', 'kb_shared', 'kb_denied', 'nope', 'kb_external']}, {}),
    ('specific_ids_admin', {'query': 'q', 'knowledge_ids': ['kb_denied']}, {'user': ADMIN}),
    ('ids_as_json_string', {'query': 'q', 'knowledge_ids': '["kb_own"]'}, {}),
    ('ids_as_plain_string', {'query': 'q', 'knowledge_ids': 'kb_own'}, {}),
    ('ids_none_string', {'query': 'q', 'knowledge_ids': 'null'}, {}),
    ('count_as_string', {'query': 'q', 'count': '2'}, {}),
    ('count_unparseable', {'query': 'q', 'count': 'lots'}, {}),
    (
        'model_knowledge',
        {'query': 'q'},
        {
            'model_knowledge': [
                {'type': 'collection', 'id': 'kb_own'},
                {'type': 'collection', 'id': 'kb_denied'},
                {'type': 'collection', 'id': 'kb_external'},
                {'type': 'file', 'id': 'f1'},
                {'type': 'file', 'id': 'f_missing'},
                {'type': 'note', 'id': 'n1'},
                {'type': 'note', 'id': 'n_shared'},
                {'type': 'note', 'id': 'n_denied'},
                {'type': 'other', 'id': 'x'},
            ]
        },
    ),
    (
        'model_knowledge_wins_over_ids',
        {'query': 'q', 'knowledge_ids': ['kb_shared']},
        {'model_knowledge': [{'type': 'note', 'id': 'n1'}]},
    ),
    (
        'results_trimmed_to_count',
        {'query': 'q', 'count': 2},
        {'model_knowledge': [{'type': 'note', 'id': 'n1'}, {'type': 'collection', 'id': 'kb_own'}]},
    ),
    ('search_without_documents', {'query': 'q', 'knowledge_ids': ['kb_own']}, {'search_result': {'ids': [[]]}}),
    ('search_returns_nothing', {'query': 'q', 'knowledge_ids': ['kb_own']}, {'search_result': None}),
    (
        'search_fewer_distances',
        {'query': 'q', 'knowledge_ids': ['kb_own']},
        {'search_result': {'documents': [['a', 'b']], 'metadatas': [[{'name': 'n'}, {}]], 'distances': [[0.1]]}},
    ),
    (
        'search_fewer_metadatas',
        {'query': 'q', 'knowledge_ids': ['kb_own']},
        {'search_result': {'documents': [['a', 'b']], 'metadatas': [[{'source': 's'}]], 'distances': [[0.1, 0.2]]}},
    ),
    (
        'external_short_metadata',
        {'query': 'q', 'knowledge_ids': ['kb_external']},
        {'external_result': {'documents': [['e1', 'e2']], 'metadatas': [[{'name': 'only one'}]]}},
    ),
    (
        'search_null_metadata',
        {'query': 'q', 'knowledge_ids': ['kb_own']},
        {'search_result': {'documents': [['a', 'b']], 'metadatas': [[None, {'name': 'n'}]], 'distances': [[0.1, 0.2]]}},
    ),
    (
        'external_null_metadata',
        {'query': 'q', 'knowledge_ids': ['kb_external']},
        {'external_result': {'documents': [['e1']], 'metadatas': [[None]], 'distances': [[0.3]]}},
    ),
    ('search_raises', {'query': 'q', 'knowledge_ids': ['kb_own']}, {'search_result': 'raise'}),
]

NOTES = {
    'n1': {
        'user_id': 'u1',
        'title': 'My note',
        'data': {'content': {'md': TEXT, 'json': {'doc': 1}, 'html': '<p/>'}, 'other': 1},
    },
    'n_empty': {'user_id': 'u1', 'title': 'Empty', 'data': None},
    'n_shared': {'user_id': 'x', 'title': 'Shared', 'data': {'content': {'md': 'shared md'}}},
    'n_denied': {'user_id': 'x', 'title': 'Private', 'data': {'content': {'md': 'private md'}}},
}
KNOWLEDGE = {
    'kb_own': {'user_id': 'u1', 'name': 'Own', 'meta': None},
    'kb_shared': {'user_id': 'x', 'name': 'Shared', 'meta': {}},
    'kb_denied': {'user_id': 'x', 'name': 'Denied', 'meta': {}},
    'kb_external': {'user_id': 'u1', 'name': 'External', 'meta': {'source': 'external'}},
}
GRANTS = {('knowledge', 'kb_shared'), ('note', 'n_shared')}
DEFAULT_SEARCH = {
    'documents': [['chunk one', 'chunk two']],
    'metadatas': [[{'source': 'a.pdf', 'file_id': 'fa'}, {'name': 'b.txt'}]],
    'distances': [[0.11, 0.22]],
}


def _run_note(kwargs: dict, world: dict, monkeypatch) -> dict:
    log = []

    async def get_note_by_id(note_id):
        n = NOTES.get(note_id)
        return (
            SimpleNamespace(id=note_id, user_id=n['user_id'], title=n['title'], data=copy.deepcopy(n['data']))
            if n
            else None
        )

    async def has_write_access(note, user_id):
        log.append(['write_access', note.id, user_id])
        return world.get('writable', True)

    async def stop_item_tasks(redis, key):
        log.append(['stop_tasks', key])
        if world.get('stop_fails'):
            raise RuntimeError('redis down')

    async def update_note_by_id(note_id, form):
        log.append(['update', note_id, form.model_dump(exclude_none=True)])
        if world.get('update') == 'raise':
            raise RuntimeError('db down')
        if 'update' in world and world['update'] is None:
            return None
        return SimpleNamespace(id=note_id, title=form.title or NOTES[note_id]['title'], updated_at=1234)

    async def emit_note_updated(request, user, note):
        log.append(['emit_updated', note.id, user.get('id')])

    monkeypatch.setattr(builtin.Notes, 'get_note_by_id', get_note_by_id)
    monkeypatch.setattr(builtin, '_has_write_access_to_note', has_write_access)
    monkeypatch.setattr(builtin, 'stop_item_tasks', stop_item_tasks)
    monkeypatch.setattr(builtin.Notes, 'update_note_by_id', update_note_by_id)
    monkeypatch.setattr(builtin, '_emit_note_updated', emit_note_updated)
    request = (
        SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(redis='<redis>')))
        if world.get('request', True)
        else None
    )
    user = world.get('user', USER)
    returned = asyncio.run(builtin.replace_note_content(**copy.deepcopy(kwargs), __request__=request, __user__=user))
    return {'returned': json.loads(returned), 'calls': log}


def _run_kb(kwargs: dict, world: dict, monkeypatch) -> dict:
    log = []

    async def groups_by_member(user_id):
        return [SimpleNamespace(id='g1'), SimpleNamespace(id='g2')]

    async def get_knowledge_by_id(kb_id):
        k = KNOWLEDGE.get(kb_id)
        return SimpleNamespace(id=kb_id, user_id=k['user_id'], name=k['name'], meta=k['meta']) if k else None

    async def has_access(user_id, resource_type, resource_id, permission, user_group_ids=None):
        log.append(
            [
                'grant',
                user_id,
                resource_type,
                resource_id,
                permission,
                sorted(user_group_ids) if user_group_ids else None,
            ]
        )
        return (resource_type, resource_id) in GRANTS

    async def get_file_by_id(file_id):
        log.append(['file', file_id])
        return SimpleNamespace(id=file_id) if file_id == 'f1' else None

    async def get_note_by_id(note_id):
        n = NOTES.get(note_id)
        return (
            SimpleNamespace(id=note_id, user_id=n['user_id'], title=n['title'], data=copy.deepcopy(n['data']))
            if n
            else None
        )

    async def search_knowledge_bases(user_id, filter, skip, limit):
        log.append(['search_kbs', user_id, filter, skip, limit])
        ids = world.get('search', ['kb_own', 'kb_external'])
        return SimpleNamespace(items=[SimpleNamespace(id=i, meta=KNOWLEDGE[i]['meta']) for i in ids])

    async def query_collection(request, collection_names, queries, embedding_function, k):
        log.append(['vector_search', list(collection_names), queries, k, embedding_function(['x'], 'p')])
        result = world.get('search_result', DEFAULT_SEARCH)
        if result == 'raise':
            raise RuntimeError('vector store down')
        return copy.deepcopy(result)

    async def retrieve_external(request, knowledge_base, queries, count, user):
        log.append(['external', knowledge_base.id, queries, count, user.id])
        return copy.deepcopy(
            world.get('external_result', {'documents': [['ext doc']], 'metadatas': [[{}]], 'distances': [[0.5]]})
        )

    def embedding(queries, prefix=None, user=None):
        return f'<embedded {queries} prefix={prefix} for {user.id}>'

    monkeypatch.setattr(builtin.Groups, 'get_groups_by_member_id', groups_by_member)
    monkeypatch.setattr(knowledge.Knowledges, 'get_knowledge_by_id', get_knowledge_by_id)
    monkeypatch.setattr(access_grants.AccessGrants, 'has_access', has_access)
    monkeypatch.setattr(files.Files, 'get_file_by_id', get_file_by_id)
    monkeypatch.setattr(notes.Notes, 'get_note_by_id', get_note_by_id)
    monkeypatch.setattr(knowledge.Knowledges, 'search_knowledge_bases', search_knowledge_bases)
    monkeypatch.setattr(retrieval_utils, 'query_collection', query_collection)
    monkeypatch.setattr(external, 'retrieve_external_knowledge', retrieve_external)

    state = SimpleNamespace(EMBEDDING_FUNCTION=embedding) if world.get('embedding', True) else SimpleNamespace()
    request = SimpleNamespace(app=SimpleNamespace(state=state)) if world.get('request', True) else None
    returned = asyncio.run(
        builtin.query_knowledge_files(
            **copy.deepcopy(kwargs),
            __request__=request,
            __user__=world.get('user', USER),
            __model_knowledge__=copy.deepcopy(world.get('model_knowledge')),
        )
    )
    return {'returned': json.loads(returned), 'calls': log}


CASES = [(f'note:{c}', 'note', k, w) for c, k, w in NOTE_CASES] + [(f'kb:{c}', 'kb', k, w) for c, k, w in KB_CASES]


def _run(tool, kwargs, world, monkeypatch):
    return (_run_note if tool == 'note' else _run_kb)(kwargs, world, monkeypatch)


def _golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding='utf-8'))


def test_case_ids_are_unique():
    ids = [case[0] for case in CASES]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize(('case_id', 'tool', 'kwargs', 'world'), CASES, ids=[c[0] for c in CASES])
def test_tool_matches_golden(monkeypatch, case_id, tool, kwargs, world):
    observed = _run(tool, kwargs, world, monkeypatch)
    if RECORD:
        pytest.skip('recording')
    assert observed == _golden()[case_id]


def test_record_golden(monkeypatch):
    """Writes the golden file, only when BUILTIN_TOOLS_GOLDEN_RECORD=1."""
    if not RECORD:
        pytest.skip('set BUILTIN_TOOLS_GOLDEN_RECORD=1 to record the golden file')
    golden = {}
    for case_id, tool, kwargs, world in CASES:
        with monkeypatch.context() as m:
            golden[case_id] = _run(tool, kwargs, world, m)
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
