"""Repro: POST /files/{id}/data/content/update by a knowledge-base write grantee.

The route admits the grantee (has_access_to_file(write) is True for a file the
KB owner owns), but process_file only looks the file up by (id, caller id) for
non-admins, so it raises 404. The route swallows that, swallows the per-KB
failures too, and answers 200 with the OLD content. Nothing is saved.
"""

import asyncio
import types

import local_llm.routers.files as files_router
import local_llm.routers.retrieval as retrieval

OWNER = types.SimpleNamespace(id='owner', role='user', email='o@x', name='o')
GRANTEE = types.SimpleNamespace(id='grantee', role='user', email='g@x', name='g')

FILE = types.SimpleNamespace(
    id='f1',
    user_id=OWNER.id,
    filename='notes.md',
    path=None,
    hash='h',
    meta={'name': 'notes.md'},
    data={'content': 'OLD CONTENT', 'status': 'completed'},
)

saved = {'content': None}
process_calls = []


class FakeFiles:
    async def get_file_by_id(self, id, db=None):
        return FILE if id == FILE.id else None

    async def get_file_by_id_and_user_id(self, id, user_id, db=None):
        return FILE if (id == FILE.id and user_id == FILE.user_id) else None

    async def update_file_data_by_id(self, id, data, db=None):
        saved.update(data)


class FakeKnowledges:
    async def get_knowledges_by_file_id(self, file_id, db=None):
        return [types.SimpleNamespace(id='kb1')]


class FakeVec:
    async def query(self, **kw):
        return types.SimpleNamespace(ids=[['old-chunk']])

    async def delete(self, **kw):
        print('vector delete called', kw)


async def fake_has_access_to_file(file_id, access_type, user, db=None):
    # KB owner owns the file, grantee has write on the KB -> True (see utils/access_control/files.py)
    return True


async def fake_config_get(key, default=None):
    return None


async def fake_publish_event(*a, **k):
    pass


async def fake_get_retrieval_config():
    return types.SimpleNamespace(BYPASS_EMBEDDING_AND_RETRIEVAL=False)


real_process_file = retrieval.process_file


async def traced_process_file(request, form_data, user=None, db=None):
    try:
        return await real_process_file(request, form_data, user=user, db=db)
    except Exception as e:  # record, then re-raise like the real call
        process_calls.append((form_data.collection_name, type(e).__name__, getattr(e, 'status_code', None)))
        raise


files_router.Files = FakeFiles()
retrieval.Files = FakeFiles()
files_router.Knowledges = FakeKnowledges()
files_router.ASYNC_VECTOR_DB_CLIENT = FakeVec()
files_router.has_access_to_file = fake_has_access_to_file
files_router.Config = types.SimpleNamespace(get=fake_config_get)
files_router.publish_event = fake_publish_event
retrieval.get_retrieval_config = fake_get_retrieval_config
files_router.process_file = traced_process_file


async def main():
    result = await files_router.update_file_data_content_by_id(
        request=types.SimpleNamespace(),
        id='f1',
        form_data=files_router.ContentForm(content='NEW CONTENT'),
        user=GRANTEE,
        db=None,
    )
    print('route returned (HTTP 200):', result)
    print('process_file failures swallowed:', process_calls)
    print('content written to the file row:', saved['content'])


asyncio.run(main())
