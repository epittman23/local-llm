"""W8: get_sources_from_items isolation + folder notes; leaderboard tags=None.

Module globals that retrieval/utils.py imported by name are monkeypatched in that module.
"""

import asyncio
from types import SimpleNamespace as NS

import local_llm.retrieval.utils as ru

USER = NS(id='u1', role='user')


class FakeConfig:
    @staticmethod
    async def get(key, default=None):
        return False  # rag.bypass_embedding_and_retrieval


async def _get_file(fid):
    return NS(id=fid, user_id='u1', filename='notes.txt', data={'content': 'file body'})


async def _get_kb(kid):
    if kid == 'ext1':
        return NS(id='ext1', user_id='u1', meta={'source': 'external', 'external': {'connection_id': 'conn'}})
    return None


async def _external_fails(*a, **k):
    raise RuntimeError('External knowledge connection is disabled')


async def _filter(names, user, access_type='read'):
    return set(names)


async def _query_collection(request, collection_names, queries, embedding_function, k):
    return {'distances': [[0.9]], 'documents': [['chunk from file']], 'metadatas': [[{'source': 'notes.txt'}]]}


ru.Config = FakeConfig
ru.Files = NS(get_file_by_id=_get_file)
ru.Knowledges = NS(get_knowledge_by_id=_get_kb)
ru.retrieve_external_knowledge = _external_fails
ru.filter_accessible_collections = _filter
ru.query_collection = _query_collection


async def middleware_like(items):
    # utils/middleware.py ~1966-1987: try: sources = await get_sources_from_items(...) except: log
    sources = []
    try:
        sources = await ru.get_sources_from_items(
            request=None, items=items, queries=['q'], embedding_function=None, k=3,
            reranking_function=None, k_reranker=3, r=0.0, hybrid_bm25_weight=0.5,
            hybrid_search=False, full_context=False, user=USER,
        )
    except Exception as e:
        print('   get_sources_from_items raised:', type(e).__name__, e)
    return sources


async def main():
    print('=== A. One failing external knowledge base drops every other attachment ===')
    s = await middleware_like([{'type': 'file', 'id': 'f1'}])
    print('   file only            -> sources:', [x['document'] for x in s])
    s = await middleware_like([{'type': 'file', 'id': 'f1'}, {'type': 'collection', 'id': 'ext1'}])
    print('   file + external KB   -> sources:', [x['document'] for x in s])

    print('=== B. A note delegated through a readable folder is dropped ===')

    async def get_folder(fid):
        return NS(id=fid, user_id='owner', parent_id=None, data={})

    async def folder_access(user_id, folder, perm, db=None):
        return True  # u1 holds a read grant on the folder

    async def owner_files(folder):
        # get_accessible_folder_files keeps the owner's note (FOLDER_FILE_TYPES includes 'note')
        return [{'type': 'file', 'id': 'f_owner'}, {'type': 'note', 'id': 'n_owner'}]

    async def get_note(nid):
        return NS(id=nid, user_id='owner', title='Owner note', data={'content': {'md': 'note body'}})

    async def no_direct_grant(**kw):
        return False

    async def file_of_owner(fid):
        return NS(id=fid, user_id='owner', filename='owner.txt', data={'content': 'owner file body'})

    ru.Folders = NS(get_folder_by_id=get_folder)
    ru.has_folder_access = folder_access
    ru.get_owner_accessible_folder_files = owner_files
    ru.Notes = NS(get_note_by_id=get_note)
    ru.AccessGrants = NS(has_access=no_direct_grant)
    ru.Files = NS(get_file_by_id=file_of_owner)

    async def no_file_access(*a, **k):
        return False

    ru.has_access_to_file = no_file_access
    s = await middleware_like([{'type': 'folder', 'id': 'fold1'}])
    print('   folder items resolved ->', [(x['source'].get('type'), x['source'].get('id')) for x in s])


asyncio.run(main())

