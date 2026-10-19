"""B6 repros: monkeypatch the DB-backed callees of local_llm.tools.builtin and call the tools."""

import asyncio
import json
from types import SimpleNamespace as NS

import local_llm.tools.builtin as b

USER = {'id': 'u1', 'role': 'user', 'name': 'U', 'email': 'u@x', 'timezone': 'UTC', 'last_active_at': 0, 'updated_at': 0, 'created_at': 0}
REQ = NS(app=NS(state=NS(EMBEDDING_FUNCTION=lambda *a, **k: None, RERANKING_FUNCTION=None, redis=None)))


async def no_groups(*a, **k):
    return []


b.Groups.get_groups_by_member_id = no_groups


# ---------------------------------------------------------------- 1. view_file next_offset with line_numbers
async def repro_view_file():
    import local_llm.models.files as files_mod

    content = '\n'.join(f'line{i:03d}' for i in range(1, 101))  # 100 lines x 7 chars + newlines
    f = NS(id='f1', user_id='u1', filename='a.txt', data={'content': content}, updated_at=0, created_at=0)

    async def get_file(fid):
        return f

    files_mod.Files.get_file_by_id = get_file
    seen = []
    offset = 0
    for _ in range(3):
        r = json.loads(await b.view_file('f1', offset=offset, max_chars=80, line_numbers=True, __request__=REQ, __user__=USER))
        seen.append((r.get('offset'), r.get('returned_chars'), r.get('next_offset'), r['content'].split('\n')[0], r['content'].split('\n')[-1]))
        offset = r['next_offset']
    print('view_file pages (offset, returned_chars, next_offset, first line, last line):')
    for s in seen:
        print('  ', s)
    print('  raw content[80:90] =', repr(content[80:90]), ' (page 2 should start here)')


# ---------------------------------------------------------------- 2. search_notes / search_chats end_timestamp post-filter
async def repro_search_dates():
    # 20 notes matching "meeting": 15 updated recently (ns), 5 last year. The DB returns newest first.
    now = 1_790_000_000
    old = now - 400 * 86400
    notes = [NS(id=f'new{i}', title='meeting', data={'content': {'md': 'meeting'}}, updated_at=(now - i) * 10**9) for i in range(15)]
    notes += [NS(id=f'old{i}', title='meeting', data={'content': {'md': 'meeting'}}, updated_at=(old - i) * 10**9) for i in range(5)]

    async def search_notes(user_id, filter, skip, limit):
        return NS(items=notes[skip : skip + limit])

    b.Notes.search_notes = search_notes
    r = json.loads(await b.search_notes('meeting', count=5, end_timestamp=now - 300 * 86400, __request__=REQ, __user__=USER))
    print('search_notes(end_timestamp=300 days ago) ->', r, '(5 notes match the range)')

    chats = [NS(id=f'new{i}', title='meeting', chat={'history': {'messages': {}}}, updated_at=now - i) for i in range(15)]
    chats += [NS(id=f'old{i}', title='meeting', chat={'history': {'messages': {}}}, updated_at=old - i) for i in range(5)]

    async def search_chats(user_id, search_text, include_archived, skip, limit):
        return chats[skip : skip + limit]

    b.Chats.get_chats_by_user_id_and_search_text = search_chats
    r = json.loads(await b.search_chats('meeting', count=5, end_timestamp=now - 300 * 86400, __request__=REQ, __user__=USER))
    print('search_chats(end_timestamp=300 days ago) ->', r, '(5 chats match the range)')


# ---------------------------------------------------------------- 3. query_chat_files keeps only the first file's chunks
async def repro_query_chat_files():
    import local_llm.models.files as files_mod
    import local_llm.retrieval.utils as rutils

    async def get_file(fid):
        return NS(id=fid, user_id='u1', filename=f'{fid}.pdf', meta={}, updated_at=0)

    files_mod.Files.get_file_by_id = get_file

    async def get_many(*keys):
        return {'rag.top_k': 5}

    b.Config.get_many = get_many

    async def get_sources_from_items(**kw):
        # what get_sources_from_items returns: one source per item, in item order, each with up to k chunks
        return [
            {'source': {'id': 'A'}, 'document': [f'A chunk {i}' for i in range(5)], 'metadata': [{'file_id': 'A'}] * 5, 'distances': [0.31, 0.30, 0.29, 0.28, 0.27]},
            {'source': {'id': 'B'}, 'document': [f'B chunk {i}' for i in range(5)], 'metadata': [{'file_id': 'B'}] * 5, 'distances': [0.92, 0.90, 0.88, 0.85, 0.80]},
        ]

    rutils.get_sources_from_items = get_sources_from_items
    files = [{'type': 'file', 'id': 'A'}, {'type': 'file', 'id': 'B'}]
    r = json.loads(await b.query_chat_files('q', __request__=REQ, __user__=USER, __files__=files))
    print('query_chat_files (no file_id, 2 files) ->', r if isinstance(r, dict) else [(c['file_id'], c['distance']) for c in r])


# ---------------------------------------------------------------- 4. query_knowledge_files: external hits always cut; one failing external KB fails the whole search
async def repro_query_knowledge_files():
    import local_llm.models.knowledge as kmod
    import local_llm.retrieval.external as ext
    import local_llm.retrieval.utils as rutils

    kbs = [NS(id='kb-int', meta={}, user_id='u1', name='int'), NS(id='kb-ext', meta={'source': 'external'}, user_id='u1', name='ext')]

    async def search_kbs(user_id, filter, skip, limit):
        return NS(items=kbs)

    kmod.Knowledges.search_knowledge_bases = search_kbs

    async def query_collection(request, collection_names, queries, embedding_function, k):
        return {'documents': [[f'int {i}' for i in range(k)]], 'metadatas': [[{'file_id': 'x'}] * k], 'distances': [[0.2] * k]}

    rutils.query_collection = query_collection

    async def ext_ok(request, knowledge, queries, count, user=None):
        return {'documents': [['ext best']], 'metadatas': [[{}]], 'distances': [[0.99]]}

    ext.retrieve_external_knowledge = ext_ok
    r = json.loads(await b.query_knowledge_files('q', __request__=REQ, __user__=USER))
    print('query_knowledge_files (internal + external KB) ->', r if isinstance(r, dict) else [(c['content'], c.get('distance')) for c in r])

    async def ext_fail(request, knowledge, queries, count, user=None):
        raise RuntimeError('External knowledge connection is disabled')

    ext.retrieve_external_knowledge = ext_fail
    r = json.loads(await b.query_knowledge_files('q', __request__=REQ, __user__=USER))
    print('query_knowledge_files (external connection disabled) ->', r)


# ---------------------------------------------------------------- 5. view_channel_thread: reply authors have no name
async def repro_thread_names():
    import local_llm.models.messages as mmod

    # get_thread_replies_by_message_id builds 'user' from _resolve_user_info, which is None for a non-webhook author
    reply = NS(id='r1', meta=None, user_id='u2')
    print('Messages._resolve_user_info(non-webhook reply) ->', await mmod.Messages._resolve_user_info(reply, db=None))


async def main():
    await repro_view_file()
    await repro_search_dates()
    await repro_query_chat_files()
    await repro_query_knowledge_files()
    await repro_thread_names()


asyncio.run(main())
