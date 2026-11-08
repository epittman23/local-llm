"""A knowledge upload whose base step fails leaves no orphan, and sync skips content the base has (#310).

An upload from a knowledge base page is processed on its own, then again
into the base's collection and linked. When that second step failed (most
often DUPLICATE_CONTENT, for a file whose text the base already has), the
file row, its stored upload and its `file-{id}` collection stayed behind,
unlinked. Folder sync compares paths, so every sync uploaded such a file
again and leaked another copy.

Now the orphan is discarded a few seconds after it is marked failed, once
the client polling its status has read the failure. And the sync diff
counts a new path whose bytes match a file already in the base as
unmodified, so it is not uploaded at all.

Run from apps/server (any LLLM_SECRET_KEY of 32 characters or more):

    LLLM_SECRET_KEY=... python -m pytest tests/test_knowledge_upload_orphans.py
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from local_llm.routers import files as files_router
from local_llm.routers import knowledge as knowledge_router


def _orphan_world(monkeypatch, *, status='failed', linked=False):
    done: list[str] = []

    async def get_file(file_id, db=None):
        return SimpleNamespace(id=file_id, path='/uploads/f1', hash='h1', data={'status': status})

    async def knowledges_of(file_id, db=None):
        return [SimpleNamespace(id='kb1')] if linked else []

    class _Vectors:
        async def has_collection(self, collection_name):
            return True

        async def delete(self, collection_name, filter=None):
            done.append(f'vectors {collection_name} {filter}')

        async def delete_collection(self, collection_name):
            done.append(f'collection {collection_name}')

    async def delete_row(file_id, db=None):
        done.append(f'row {file_id}')
        return True

    monkeypatch.setattr(files_router.Files, 'get_file_by_id', get_file)
    monkeypatch.setattr(files_router.Knowledges, 'get_knowledges_by_file_id', knowledges_of)
    monkeypatch.setattr(files_router, 'ASYNC_VECTOR_DB_CLIENT', _Vectors())
    monkeypatch.setattr(files_router.Files, 'delete_file_by_id', delete_row)
    monkeypatch.setattr(files_router.Storage, 'delete_file', lambda path: done.append(f'storage {path}'))
    return done


def test_an_orphan_is_discarded_with_its_upload_and_vectors_but_not_by_hash(monkeypatch):
    done = _orphan_world(monkeypatch)

    asyncio.run(files_router._discard_orphan_upload('f1', 'kb1', delay=0))

    assert done == [
        # By file id only: the base's other file with the same content shares the hash.
        "vectors kb1 {'file_id': 'f1'}",
        'collection file-f1',
        'storage /uploads/f1',
        'row f1',
    ]


def test_a_file_linked_or_retried_meanwhile_is_kept(monkeypatch):
    assert _run_kept(monkeypatch, linked=True) == []
    assert _run_kept(monkeypatch, status='completed') == []


def _run_kept(monkeypatch, **world):
    done = _orphan_world(monkeypatch, **world)
    asyncio.run(files_router._discard_orphan_upload('f1', 'kb1', delay=0))
    return done


def test_a_discard_that_fails_is_logged_and_does_not_raise(monkeypatch, caplog):
    _orphan_world(monkeypatch)

    async def vectors_down(collection_name, filter=None):
        raise RuntimeError('vector store unreachable')

    monkeypatch.setattr(files_router.ASYNC_VECTOR_DB_CLIENT, 'delete', vectors_down)

    with caplog.at_level('ERROR'):
        asyncio.run(files_router._discard_orphan_upload('f1', 'kb1', delay=0))

    assert 'Could not discard knowledge upload f1' in caplog.text


def test_a_failed_base_step_marks_the_file_failed_and_schedules_its_discard(monkeypatch):
    scheduled: list[str] = []
    marked: list[dict] = []

    async def config_get(key, default=None):
        return default

    async def process_file_for(request, form, user=None, db=None, **_options):
        if form.collection_name:
            raise RuntimeError('Duplicate content detected')

    async def knowledge(id, db=None):
        return SimpleNamespace(id=id, user_id='u1')

    async def update_data(file_id, data, db=None):
        marked.append(data)

    def run_in_background(coroutine):
        scheduled.append(coroutine.__name__)
        coroutine.close()

    monkeypatch.setattr(files_router.Config, 'get', config_get)
    monkeypatch.setattr(files_router, 'process_file_for', process_file_for)
    monkeypatch.setattr(files_router.Knowledges, 'get_knowledge_by_id', knowledge)
    monkeypatch.setattr(files_router.Files, 'update_file_data_by_id', update_data)
    monkeypatch.setattr(files_router, 'run_in_background', run_in_background)
    monkeypatch.setattr(files_router, '_cleanup_local_cache', lambda path: None)

    asyncio.run(
        files_router.process_uploaded_file(
            SimpleNamespace(),
            SimpleNamespace(content_type='text/plain'),
            '/uploads/f1',
            SimpleNamespace(id='f1'),
            {'knowledge_id': 'kb1'},
            SimpleNamespace(id='u1', role='user'),
            db=object(),
        )
    )

    assert marked[-1]['status'] == 'failed'
    assert 'Duplicate content' in marked[-1]['error']
    assert scheduled == ['_discard_orphan_upload']


# --- the sync diff ---------------------------------------------------------


def _diff(monkeypatch, manifest, linked):
    async def access(*args, **kwargs):
        return None

    async def files_with_dirs(id, db=None):
        return [
            (SimpleNamespace(id=f'id-{name}', filename=name, hash=None, meta={'file_hash': sha}, updated_at=None), None)
            for name, sha in linked
        ]

    async def no_dirs(id, db=None):
        return []

    monkeypatch.setattr(knowledge_router, '_verify_knowledge_write_access', access)
    monkeypatch.setattr(knowledge_router.Knowledges, 'get_files_with_directory_ids', files_with_dirs)
    monkeypatch.setattr(knowledge_router.Knowledges, 'get_all_directories', no_dirs)
    form = knowledge_router.SyncDiffForm(
        manifest=[knowledge_router.FileManifestEntry(filename=n, path='', checksum=c, size=1) for n, c in manifest]
    )
    return asyncio.run(knowledge_router.sync_knowledge_diff('kb1', form, user=None, db=None))


def test_a_new_copy_of_content_the_base_keeps_is_not_uploaded(monkeypatch):
    diff = _diff(monkeypatch, [('LICENSE', 'abc'), ('vendor-LICENSE', 'abc')], linked=[('LICENSE', 'abc')])

    assert diff.added == []
    assert diff.unmodified_count == 2


def test_a_copy_of_content_this_sync_deletes_is_still_uploaded(monkeypatch):
    # The original left the folder: the copy is now the only one, so it goes up.
    diff = _diff(monkeypatch, [('renamed-LICENSE', 'abc')], linked=[('LICENSE', 'abc')])

    assert diff.added == [{'filename': 'renamed-LICENSE', 'path': ''}]
    assert [d['file_id'] for d in diff.deleted] == ['id-LICENSE']


def test_new_files_with_new_content_are_still_added(monkeypatch):
    diff = _diff(monkeypatch, [('LICENSE', 'abc'), ('README', 'def')], linked=[('LICENSE', 'abc')])

    assert diff.added == [{'filename': 'README', 'path': ''}]


def test_a_copy_of_content_this_sync_replaces_is_still_uploaded(monkeypatch):
    # a.txt changed from X to Y, so its stored X goes as stale in this sync;
    # the new b.txt holding X is then the only copy, and must go up.
    diff = _diff(monkeypatch, [('a.txt', 'Y'), ('b.txt', 'X')], linked=[('a.txt', 'X')])

    assert [m['filename'] for m in diff.modified] == ['a.txt']
    assert diff.added == [{'filename': 'b.txt', 'path': ''}]
    assert diff.unmodified_count == 0
