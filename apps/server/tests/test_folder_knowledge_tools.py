"""With native function calling, a shared folder's notes and knowledge bases reach the chat (#755).

A chat in a folder the user may read gets the folder's entries as attached
knowledge, tagged `source: 'folder'` (`_apply_folder`, then
`get_attached_knowledge`). The built-in knowledge tools accepted a note or a
knowledge base only for an admin, its owner or a direct grant, so a user who
reads the folder but has no grant of their own got neither, while the
folder's files went through. On the legacy path all three do (#358).

The entries here come from the real `get_attached_knowledge`, so the tag is
the one the server sets; notes, knowledge bases, files and grants are fakes,
and no grant is ever held.

Run from apps/server:

    python -m pytest tests/test_folder_knowledge_tools.py
"""

import asyncio
import json
from types import SimpleNamespace

import pytest

from local_llm.models import access_grants, files, knowledge, notes
from local_llm.tools import builtin, knowledge_fs
from local_llm.utils import tools
from local_llm.utils.access_control import files as file_access

USER = {
    'id': 'u1', 'name': 'Ada', 'email': 'ada@example.invalid', 'role': 'user',
    'profile_image_url': '', 'last_active_at': 0, 'updated_at': 0, 'created_at': 0,
}  # fmt: skip
REQUEST = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))
ENTRIES = [{'type': 'note', 'id': 'n1'}, {'type': 'collection', 'id': 'kb1'}]

NOTE = SimpleNamespace(
    id='n1', user_id='owner', title='Plan', data={'content': {'md': 'the plan'}}, updated_at=1, created_at=1
)
KB = SimpleNamespace(id='kb1', user_id='owner', name='Handbook', description='', meta={})
FILE = SimpleNamespace(
    id='f1', user_id='owner', filename='policy.md', data={'content': 'policy text'}, meta={}, updated_at=1, created_at=1
)


def _from_folder():
    return tools.get_attached_knowledge({}, {'folder_knowledge': [dict(e) for e in ENTRIES]})


def _from_model():
    return tools.get_attached_knowledge({'info': {'meta': {'knowledge': [dict(e) for e in ENTRIES]}}}, {})


@pytest.fixture(autouse=True)
def _world(monkeypatch):
    async def note(note_id, db=None):
        return NOTE if note_id == NOTE.id else None

    async def kb(knowledge_id, db=None):
        return KB if knowledge_id == KB.id else None

    async def file(file_id, db=None):
        return FILE if file_id == FILE.id else None

    async def kbs_of_file(file_id, db=None):
        return [KB] if file_id == FILE.id else []

    async def file_page(knowledge_id, skip=0, limit=0):
        return 1, [(FILE.id, FILE.filename)][:limit]

    async def kb_files(knowledge_id, db=None):
        return [FILE]

    async def search_files(knowledge_id, user_id, filter, skip=0, limit=0):
        return SimpleNamespace(items=[FILE])

    async def kb_files_with_dirs(knowledge_id):
        return [(FILE, None)]

    async def no(*_a, **_k):
        return False

    async def none(*_a, **_k):
        return []

    monkeypatch.setattr(notes.Notes, 'get_note_by_id', note)
    monkeypatch.setattr(knowledge.Knowledges, 'get_knowledge_by_id', kb)
    monkeypatch.setattr(knowledge.Knowledges, 'get_knowledges_by_file_id', kbs_of_file)
    monkeypatch.setattr(knowledge.Knowledges, 'get_file_page_by_id', file_page)
    monkeypatch.setattr(knowledge.Knowledges, 'get_files_by_id', kb_files)
    monkeypatch.setattr(knowledge.Knowledges, 'search_files_by_id', search_files)
    monkeypatch.setattr(knowledge.Knowledges, 'get_files_with_directory_ids', kb_files_with_dirs)
    monkeypatch.setattr(files.Files, 'get_file_by_id', file)
    monkeypatch.setattr(access_grants.AccessGrants, 'has_access', no)
    monkeypatch.setattr(file_access, 'has_access_to_file', no)
    monkeypatch.setattr(builtin.Groups, 'get_groups_by_member_id', none)


def _run(tool, **kwargs):
    return asyncio.run(tool(__request__=REQUEST, __user__=USER, **kwargs))


def _call(tool, **kwargs):
    return json.loads(_run(tool, **kwargs))


def _listed(model_knowledge):
    got = _call(builtin.list_knowledge, __model_knowledge__=model_knowledge)
    return [kb['id'] for kb in got['knowledge_bases']], [n['id'] for n in got['notes']]


def _searched(model_knowledge):
    search = builtin._KnowledgeSearch(USER, [])
    asyncio.run(search.add_model_knowledge(model_knowledge))
    return search.collection_names, [n['note_id'] for n in search.note_results]


def test_list_knowledge_lists_a_folders_note_and_knowledge_base():
    assert _listed(_from_folder()) == (['kb1'], ['n1'])


def test_query_knowledge_files_searches_a_folders_note_and_knowledge_base():
    assert _searched(_from_folder()) == (['kb1'], ['n1'])


def test_view_note_reads_a_folders_note():
    assert _call(builtin.view_note, note_id='n1', __model_knowledge__=_from_folder())['content'] == 'the plan'


def test_search_knowledge_files_searches_a_folders_knowledge_base():
    got = _call(builtin.search_knowledge_files, query='policy', __model_knowledge__=_from_folder())
    assert [f['id'] for f in got] == ['f1']


def test_grep_knowledge_files_searches_a_folders_knowledge_base():
    got = _run(builtin.grep_knowledge_files, pattern='policy', __model_knowledge__=_from_folder())
    assert 'policy text' in got


@pytest.mark.parametrize('tool', [builtin.view_file, builtin.view_knowledge_file])
def test_a_file_in_a_folders_knowledge_base_can_be_read(tool):
    assert _call(tool, file_id='f1', __model_knowledge__=_from_folder())['content'] == 'policy text'


def test_kb_exec_reaches_a_folders_knowledge_base():
    got = asyncio.run(knowledge_fs._get_accessible_kb_ids(USER, _from_folder()))
    assert [kb_id for kb_id, _, _ in got] == ['kb1']


def test_the_same_entries_attached_to_the_model_still_need_a_grant():
    assert _listed(_from_model()) == ([], [])
    assert _searched(_from_model()) == ([], [])
    assert _call(builtin.view_note, note_id='n1', __model_knowledge__=_from_model()) == {'error': 'Access denied'}
    assert asyncio.run(knowledge_fs._get_accessible_kb_ids(USER, _from_model())) == []
    assert _call(builtin.view_knowledge_file, file_id='f1', __model_knowledge__=_from_model()) == {
        'error': 'Access denied'
    }
    assert _call(builtin.view_file, file_id='f1', __model_knowledge__=_from_model()) == {'error': 'File not found'}


def test_a_note_named_by_id_without_the_folder_still_needs_a_grant():
    assert _call(builtin.view_note, note_id='n1', __model_knowledge__=[]) == {'error': 'Access denied'}
