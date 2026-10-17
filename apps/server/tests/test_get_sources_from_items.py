"""Characterization tests for retrieval/utils.py's get_sources_from_items.

It decides which attached files, notes, chats, URLs and knowledge bases a
query may draw from, and was refactored for ruff's complexity limit with no
tests of its own. These pin what it did before the refactor, access
decisions included: for each case, the sources returned, every access check
made, which collections were searched or read in full, and how the input
items were changed. Folders, notes, chats, files, knowledge bases, access
grants, URL fetching, external knowledge and the vector store are a small
fake world that records each call; message reconstruction runs for real.
Each case was recorded from the untouched function into
fixtures/get_sources_from_items.json and must not change.

The golden file is only ever written by hand, never by this test. To record
it again (only for an intended behaviour change, reviewed as such), run
`SOURCES_GOLDEN_RECORD=1 pytest tests/test_get_sources_from_items.py`.
"""

import asyncio
import copy
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from local_llm.retrieval import utils as retrieval

GOLDEN = Path(__file__).parent / 'fixtures' / 'get_sources_from_items.json'
RECORD = os.environ.get('SOURCES_GOLDEN_RECORD') == '1'

USER = {'id': 'u1', 'role': 'user'}
ADMIN = {'id': 'a1', 'role': 'admin'}

FOLDERS = {
    'fold1': {'owner': 'u1', 'files': [{'type': 'file', 'id': 'f_folder'}, {'type': 'collection', 'id': 'kb_folder'}]},
    'fold_other': {'owner': 'x', 'files': [{'type': 'file', 'id': 'f_denied'}]},
    'chat_folder': {'owner': 'u1', 'files': []},
}
FOLDER_ACCESS = {'fold1', 'chat_folder'}  # folders u1 may read
NOTES = {
    'n_own': {'user_id': 'u1', 'title': 'My note', 'md': '# mine'},
    'n_shared': {'user_id': 'x', 'title': 'Shared note', 'md': 'shared'},
    'n_denied': {'user_id': 'x', 'title': 'Private note', 'md': 'private'},
    'n_no_md': {'user_id': 'u1', 'title': 'Empty note', 'md': None},
}
HISTORY = {
    'currentId': 'm2',
    'messages': {
        'm1': {'id': 'm1', 'parentId': None, 'role': 'user', 'content': 'question'},
        'm2': {'id': 'm2', 'parentId': 'm1', 'role': 'assistant', 'content': 'answer'},
    },
}
CHATS = {
    'ch_own': {'user_id': 'u1', 'title': 'Own chat', 'history': HISTORY, 'folder_id': None},
    'ch_shared': {'user_id': 'x', 'title': 'Shared chat', 'history': HISTORY, 'folder_id': None},
    'ch_folder': {'user_id': 'x', 'title': 'Folder chat', 'history': HISTORY, 'folder_id': 'chat_folder'},
    'ch_folder_denied': {'user_id': 'x', 'title': 'Other folder chat', 'history': HISTORY, 'folder_id': 'fold_other'},
    'ch_denied': {'user_id': 'x', 'title': 'Private chat', 'history': HISTORY, 'folder_id': None},
    'ch_empty': {'user_id': 'u1', 'title': 'Empty chat', 'history': {}, 'folder_id': None},
}
FILES = {
    'f_own': {'user_id': 'u1', 'filename': 'own.txt', 'content': 'own content'},
    'f_granted': {'user_id': 'x', 'filename': 'granted.txt', 'content': 'granted content'},
    'f_denied': {'user_id': 'x', 'filename': 'denied.txt', 'content': 'denied content'},
    'f_folder': {'user_id': 'x', 'filename': 'folder.txt', 'content': 'folder content'},
}
FILE_GRANTS = {'f_granted'}
KNOWLEDGE = {
    'kb_own': {'user_id': 'u1', 'meta': None, 'files': ['f_own', 'f_granted']},
    'kb_shared': {'user_id': 'x', 'meta': {}, 'files': ['f_denied']},
    'kb_denied': {'user_id': 'x', 'meta': {}, 'files': ['f_denied']},
    'kb_external': {'user_id': 'u1', 'meta': {'source': 'external'}, 'files': []},
    'kb_folder': {'user_id': 'x', 'meta': {}, 'files': ['f_folder']},
}
GRANTS = {('note', 'n_shared'), ('shared_chat', 'ch_shared'), ('knowledge', 'kb_shared')}


def _case(
    case_id, items, *, user=USER, queries=('what?',), full_context=False, bypass_retrieval=False, bypass_access=False
):
    return (
        case_id,
        {
            'items': items,
            'user': user,
            'queries': list(queries),
            'full_context': full_context,
            'bypass_retrieval': bypass_retrieval,
            'bypass_access': bypass_access,
        },
    )


FULL_FILE = {'data': {'content': 'inline content', 'metadata': {'page': 1}}, 'meta': {'name': 'inline.txt'}}
CASES = [
    _case('no_items', []),
    # --- raw text ---
    _case('text_full_with_file', [{'type': 'text', 'context': 'full', 'file': FULL_FILE, 'data': 'dropped'}]),
    _case('text_full_without_file_uses_collection', [{'type': 'text', 'context': 'full', 'collection_name': 'col-a'}]),
    _case('text_collection', [{'type': 'text', 'collection_name': 'col-a'}]),
    _case('text_file', [{'type': 'text', 'file': FULL_FILE}]),
    _case('text_content', [{'type': 'text', 'id': 't1', 'name': 'Pasted', 'content': 'pasted text'}]),
    _case('text_no_user', [{'type': 'text', 'collection_name': 'col-a'}, {'type': 'text', 'content': 'x'}], user=None),
    # --- notes ---
    _case('note_own', [{'type': 'note', 'id': 'n_own'}]),
    _case('note_shared', [{'type': 'note', 'id': 'n_shared'}]),
    _case('note_denied', [{'type': 'note', 'id': 'n_denied'}]),
    _case('note_admin', [{'type': 'note', 'id': 'n_denied'}], user=ADMIN),
    _case('note_missing', [{'type': 'note', 'id': 'nope'}]),
    _case('note_without_markdown', [{'type': 'note', 'id': 'n_no_md'}]),
    # --- chats ---
    _case('chat_own', [{'type': 'chat', 'id': 'ch_own'}]),
    _case('chat_shared', [{'type': 'chat', 'id': 'ch_shared'}]),
    _case('chat_via_folder', [{'type': 'chat', 'id': 'ch_folder'}]),
    _case('chat_folder_denied', [{'type': 'chat', 'id': 'ch_folder_denied'}]),
    _case('chat_denied', [{'type': 'chat', 'id': 'ch_denied'}]),
    _case('chat_admin', [{'type': 'chat', 'id': 'ch_denied'}], user=ADMIN),
    _case('chat_missing', [{'type': 'chat', 'id': 'nope'}]),
    _case('chat_without_history', [{'type': 'chat', 'id': 'ch_empty'}]),
    # --- URLs ---
    _case('url', [{'type': 'url', 'url': 'https://example.com/page'}]),
    _case('url_without_docs', [{'type': 'url', 'url': 'https://example.com/empty'}]),
    # --- files ---
    _case(
        'file_full_inline', [{'type': 'file', 'id': 'f_any', 'name': 'Inline', 'context': 'full', 'file': FULL_FILE}]
    ),
    _case('file_full_own', [{'type': 'file', 'id': 'f_own', 'context': 'full'}]),
    _case('file_full_granted', [{'type': 'file', 'id': 'f_granted', 'context': 'full', 'file': {'data': {}}}]),
    _case('file_full_denied', [{'type': 'file', 'id': 'f_denied', 'context': 'full'}]),
    _case('file_full_admin', [{'type': 'file', 'id': 'f_denied', 'context': 'full'}], user=ADMIN),
    _case('file_full_missing', [{'type': 'file', 'id': 'nope', 'context': 'full'}]),
    _case('file_full_without_id', [{'type': 'file', 'context': 'full'}]),
    _case('file_bypass_retrieval', [{'type': 'file', 'id': 'f_own'}], bypass_retrieval=True),
    _case('file_chunks_own', [{'type': 'file', 'id': 'f_own'}]),
    _case('file_chunks_legacy', [{'type': 'file', 'id': 'f_own', 'legacy': True}]),
    _case('file_chunks_denied', [{'type': 'file', 'id': 'f_denied'}]),
    _case('file_chunks_without_id', [{'type': 'file'}]),
    _case(
        'file_chunks_bypass_access',
        [{'type': 'file', 'id': 'f_denied'}, {'type': 'file', 'id': 'f_x', 'legacy': True}],
        bypass_access=True,
    ),
    _case('file_chunks_full_context', [{'type': 'file', 'id': 'f_own'}], full_context=True),
    _case('file_chunks_search_fails', [{'type': 'file', 'id': 'f_granted'}]),
    # --- knowledge bases ---
    _case('collection_own_chunks', [{'type': 'collection', 'id': 'kb_own'}]),
    _case('collection_shared_full', [{'type': 'collection', 'id': 'kb_shared', 'context': 'full'}]),
    _case('collection_bypass_retrieval', [{'type': 'collection', 'id': 'kb_own'}], bypass_retrieval=True),
    _case('collection_denied', [{'type': 'collection', 'id': 'kb_denied'}]),
    _case('collection_admin', [{'type': 'collection', 'id': 'kb_denied'}], user=ADMIN),
    _case('collection_missing', [{'type': 'collection', 'id': 'nope'}]),
    _case(
        'collection_external',
        [{'type': 'collection', 'id': 'kb_external'}, {'type': 'collection', 'id': 'kb_external'}],
    ),
    _case(
        'collection_legacy_names_validated',
        [
            {
                'type': 'collection',
                'id': 'kb_own',
                'legacy': True,
                'collection_names': ['file-f_own', 'file-f_denied', 'kb_own'],
            }
        ],
    ),
    _case(
        'collection_legacy_no_valid_names',
        [{'type': 'collection', 'id': 'kb_own', 'legacy': True, 'collection_names': ['file-f_denied']}],
    ),
    _case('collection_legacy_without_names', [{'type': 'collection', 'id': 'kb_own', 'legacy': True}]),
    _case(
        'collection_legacy_bypass_access',
        [{'type': 'collection', 'id': 'kb_own', 'legacy': True, 'collection_names': ['anything']}],
        bypass_access=True,
    ),
    # --- folders ---
    _case('folder_expands_to_its_files', [{'type': 'folder', 'id': 'fold1'}]),
    _case('folder_listed_twice', [{'type': 'folder', 'id': 'fold1'}, {'type': 'folder', 'id': 'fold1'}]),
    _case('folder_denied', [{'type': 'folder', 'id': 'fold_other'}]),
    _case('folder_admin', [{'type': 'folder', 'id': 'fold_other'}], user=ADMIN),
    _case('folder_missing_or_without_id', [{'type': 'folder', 'id': 'nope'}, {'type': 'folder'}]),
    _case('folder_without_user', [{'type': 'folder', 'id': 'fold1'}, {'type': 'text', 'content': 'x'}], user=None),
    _case(
        'folder_grants_file_access',
        [{'type': 'folder', 'id': 'fold1'}, {'type': 'file', 'id': 'f_folder', 'context': 'full'}],
    ),
    # --- other item shapes ---
    _case(
        'docs_item',
        [{'docs': [{'content': 'doc a', 'metadata': {'source': 'a'}}, {'content': 'doc b', 'metadata': None}]}],
    ),
    _case('web_search_collection', [{'type': 'web_search', 'collection_name': 'web-search-abc'}]),
    _case('web_search_without_collection', [{'type': 'web_search'}]),
    _case('untyped_collection_name_ignored', [{'collection_name': 'col-a'}, {'collection_names': ['col-b']}]),
    _case(
        'untyped_collection_names_bypass',
        [{'collection_name': 'col-a'}, {'collection_names': ['col-b', 'col-c']}],
        bypass_access=True,
    ),
    _case('unknown_item', [{'type': 'mystery', 'id': 'x'}]),
    _case('collection_access_filtered_out', [{'type': 'text', 'collection_name': 'deny-me'}]),
    _case('already_extracted_collection_skipped', [{'type': 'file', 'id': 'f_own'}, {'type': 'file', 'id': 'f_own'}]),
    _case('collection_without_metadatas_dropped', [{'type': 'text', 'collection_name': 'no-metadatas'}]),
    _case('collection_without_documents_dropped', [{'type': 'text', 'collection_name': 'no-documents'}]),
    _case('collection_with_empty_documents_dropped', [{'type': 'text', 'collection_name': 'empty-documents'}]),
    _case(
        'everything_together',
        [
            {'type': 'note', 'id': 'n_own'},
            {'type': 'file', 'id': 'f_granted', 'context': 'full'},
            {'type': 'collection', 'id': 'kb_own'},
            {'type': 'url', 'url': 'https://example.com/page'},
        ],
        queries=('a', 'b'),
    ),
]


def _ns(**kw):
    return SimpleNamespace(**kw)


def _run(spec: dict, monkeypatch) -> dict:
    log = []

    async def config_get(key, default=None):
        assert key == 'rag.bypass_embedding_and_retrieval', key
        return spec['bypass_retrieval']

    async def get_folder_by_id(folder_id):
        log.append(['folder', folder_id])
        f = FOLDERS.get(folder_id)
        return _ns(id=folder_id, user_id=f['owner']) if f else None

    async def has_folder_access(user_id, folder, permission, db=None):
        log.append(['folder_access', user_id, folder.id, permission])
        return folder.id in FOLDER_ACCESS

    async def owner_accessible_folder_files(folder):
        return copy.deepcopy(FOLDERS[folder.id]['files'])

    async def get_note_by_id(note_id):
        n = NOTES.get(note_id)
        return (
            _ns(
                id=note_id, user_id=n['user_id'], title=n['title'], data={'content': {'md': n['md']}} if n['md'] else {}
            )
            if n
            else None
        )

    async def has_access(user_id, resource_type, resource_id, permission):
        log.append(['grant', user_id, resource_type, resource_id, permission])
        return (resource_type, resource_id) in GRANTS

    async def get_chat_by_id(chat_id):
        c = CHATS.get(chat_id)
        if not c:
            return None
        return _ns(
            id=chat_id,
            user_id=c['user_id'],
            title=c['title'],
            folder_id=c['folder_id'],
            chat={'history': copy.deepcopy(c['history'])},
        )

    async def get_content_from_url(request, url):
        log.append(['fetch_url', url])
        return ('page text', ['doc']) if url.endswith('/page') else ('', [])

    async def get_file_by_id(file_id):
        f = FILES.get(file_id)
        return (
            _ns(id=file_id, user_id=f['user_id'], filename=f['filename'], data={'content': f['content']}) if f else None
        )

    async def has_access_to_file(file_id, permission, user):
        log.append(['file_access', file_id, permission, user.id])
        return file_id in FILE_GRANTS

    async def get_knowledge_by_id(kb_id):
        k = KNOWLEDGE.get(kb_id)
        return _ns(id=kb_id, user_id=k['user_id'], meta=k['meta']) if k else None

    async def get_files_by_id(kb_id):
        log.append(['kb_files', kb_id])
        return [
            _ns(id=fid, filename=FILES[fid]['filename'], data={'content': FILES[fid]['content']})
            for fid in KNOWLEDGE[kb_id]['files']
        ]

    async def retrieve_external_knowledge(request, knowledge_base, queries, count, user):
        log.append(['external', knowledge_base.id, list(queries), count])
        return {'documents': [['external doc']], 'metadatas': [[{'source': 'ext'}]]}

    async def filter_accessible_collections(collection_names, user):
        names = sorted(collection_names)
        log.append(['filter_collections', names, user.id])
        return {n for n in names if not n.startswith('deny-')}

    def all_items(collection_names):
        names = sorted(collection_names)
        log.append(['read_all', names])
        return {'documents': [[f'all of {n}' for n in names]], 'metadatas': [[{'collection': n} for n in names]]}

    async def query_collection(request, collection_names, queries, embedding_function, k):
        names = sorted(collection_names)
        log.append(['search', names, list(queries), k])
        if any('granted' in n for n in names):
            raise RuntimeError('vector store down')
        if names == ['no-metadatas']:
            return {'documents': [['orphan']]}
        if names == ['no-documents']:
            return {'ids': [['x']]}
        if names == ['empty-documents']:
            return {'documents': [], 'metadatas': []}
        return {
            'documents': [[f'hit in {n}' for n in names]],
            'metadatas': [[{'collection': n} for n in names]],
            'distances': [[0.1 * (i + 1) for i in range(len(names))]],
        }

    monkeypatch.setattr(retrieval.Config, 'get', config_get)
    monkeypatch.setattr(retrieval.Folders, 'get_folder_by_id', get_folder_by_id)
    monkeypatch.setattr(retrieval, 'has_folder_access', has_folder_access)
    monkeypatch.setattr(retrieval, 'get_owner_accessible_folder_files', owner_accessible_folder_files)
    monkeypatch.setattr(retrieval.Notes, 'get_note_by_id', get_note_by_id)
    monkeypatch.setattr(retrieval.AccessGrants, 'has_access', has_access)
    monkeypatch.setattr(retrieval.Chats, 'get_chat_by_id', get_chat_by_id)
    monkeypatch.setattr(retrieval, 'get_content_from_url', get_content_from_url)
    monkeypatch.setattr(retrieval.Files, 'get_file_by_id', get_file_by_id)
    monkeypatch.setattr(retrieval, 'has_access_to_file', has_access_to_file)
    monkeypatch.setattr(retrieval.Knowledges, 'get_knowledge_by_id', get_knowledge_by_id)
    monkeypatch.setattr(retrieval.Knowledges, 'get_files_by_id', get_files_by_id)
    monkeypatch.setattr(retrieval, 'retrieve_external_knowledge', retrieve_external_knowledge)
    monkeypatch.setattr(retrieval, 'filter_accessible_collections', filter_accessible_collections)
    monkeypatch.setattr(retrieval, 'get_all_items_from_collections', all_items)
    monkeypatch.setattr(retrieval, 'query_collection', query_collection)
    monkeypatch.setattr(retrieval, 'BYPASS_RETRIEVAL_ACCESS_CONTROL', spec['bypass_access'])

    items = copy.deepcopy(spec['items'])
    user = _ns(**spec['user']) if spec['user'] else None
    sources = asyncio.run(
        retrieval.get_sources_from_items(
            None,
            items,
            spec['queries'],
            embedding_function='<embed>',
            k=4,
            reranking_function=None,
            k_reranker=None,
            r=0.0,
            hybrid_bm25_weight=0.5,
            hybrid_search=False,
            full_context=spec['full_context'],
            user=user,
        )
    )
    return json.loads(json.dumps({'sources': sources, 'calls': log, 'items_after': items}))


def _golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding='utf-8'))


def test_case_ids_are_unique():
    ids = [case[0] for case in CASES]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize(('case_id', 'spec'), CASES, ids=[c[0] for c in CASES])
def test_sources_match_golden(monkeypatch, case_id, spec):
    observed = _run(spec, monkeypatch)
    if RECORD:
        pytest.skip('recording')
    assert observed == _golden()[case_id]


def test_record_golden(monkeypatch):
    """Writes the golden file, only when SOURCES_GOLDEN_RECORD=1."""
    if not RECORD:
        pytest.skip('set SOURCES_GOLDEN_RECORD=1 to record the golden file')
    golden = {}
    for case_id, spec in CASES:
        with monkeypatch.context() as m:
            golden[case_id] = _run(spec, m)
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
