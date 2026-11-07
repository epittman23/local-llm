"""The folder sync diff sees every linked copy at one path, not just one (#639).

A knowledge base can hold two linked files at one path and name: a modified
file's old copy whose removal failed, or one a cut-off status stream left
behind. The diff indexed the base's files by (path, filename) from a query
with no order, so it kept whichever copy came last. When that was the current
copy, the stale one was never reported and its text stayed retrievable for
good; when it was the stale one, every later sync reported the file modified.

An extra copy holding text a kept copy holds was left in place, since removing
it deleted chunks by text hash, the kept copy's included. Removal now keeps
another linked file's chunks (#792), so it is reported deleted too (#813).

Run from apps/server:

    python -m pytest tests/test_knowledge_sync_linked_copies.py
"""

import asyncio
import uuid
from types import SimpleNamespace

import pytest

from local_llm.models.files import FileForm, Files
from local_llm.models.knowledge import KnowledgeForm, Knowledges
from local_llm.models.users import Users
from local_llm.routers import knowledge as knowledge_router


def _diff(monkeypatch, manifest, linked):
    """`manifest` is [(filename, checksum)]; `linked` is [(id, filename, checksum, text hash, updated_at)]."""

    async def access(*args, **kwargs):
        return None

    async def files_with_dirs(id, db=None):
        return [
            (SimpleNamespace(id=fid, filename=name, hash=text, meta={'file_hash': sha}, updated_at=at), None)
            for fid, name, sha, text, at in linked
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


CURRENT = ('current', 'a.txt', 'Y', 'text-Y', 2)
STALE = ('stale', 'a.txt', 'X', 'text-X', 1)


@pytest.mark.parametrize('linked', [[CURRENT, STALE], [STALE, CURRENT]], ids=['stale-last', 'current-last'])
def test_a_stale_copy_beside_the_current_one_is_deleted(monkeypatch, linked):
    diff = _diff(monkeypatch, [('a.txt', 'Y')], linked)

    assert [d['file_id'] for d in diff.deleted] == ['stale']
    assert diff.modified == []
    assert diff.added == []
    assert diff.unmodified_count == 1


def test_two_stale_copies_replace_the_newest_and_delete_the_other(monkeypatch):
    # The newest old copy stays until the new version is up (#317); the other goes now.
    older = ('older', 'a.txt', 'W', 'text-W', 1)
    newer = ('newer', 'a.txt', 'X', 'text-X', 2)

    for linked in ([older, newer], [newer, older]):
        diff = _diff(monkeypatch, [('a.txt', 'Y')], linked)

        assert diff.modified == [{'filename': 'a.txt', 'path': '', 'stale_file_id': 'newer'}]
        assert [d['file_id'] for d in diff.deleted] == ['older']


def test_every_copy_of_a_file_gone_from_the_folder_is_deleted(monkeypatch):
    diff = _diff(monkeypatch, [], [CURRENT, STALE])

    assert sorted(d['file_id'] for d in diff.deleted) == ['current', 'stale']


@pytest.mark.parametrize('order', ['twin-last', 'current-last'])
def test_an_identical_extra_copy_is_deleted(monkeypatch, order):
    # Either copy may stay, since both match the folder; exactly one goes.
    twin = ('twin', 'a.txt', 'Y', 'text-Y', 1)
    linked = [CURRENT, twin] if order == 'twin-last' else [twin, CURRENT]

    diff = _diff(monkeypatch, [('a.txt', 'Y')], linked)

    assert len(diff.deleted) == 1
    assert diff.deleted[0]['file_id'] in {'current', 'twin'}
    assert diff.modified == []
    assert diff.unmodified_count == 1


@pytest.mark.parametrize('order', ['resaved-last', 'current-last'])
def test_an_extra_copy_with_the_kept_copys_text_is_deleted(monkeypatch, order):
    # Other bytes, same text (a .docx saved again).
    resaved = ('resaved', 'a.txt', 'Y2', 'text-Y', 1)
    linked = [CURRENT, resaved] if order == 'resaved-last' else [resaved, CURRENT]

    diff = _diff(monkeypatch, [('a.txt', 'Y')], linked)

    assert [d['file_id'] for d in diff.deleted] == ['resaved']
    assert diff.modified == []
    assert diff.unmodified_count == 1


def test_a_file_gone_from_the_folder_holding_text_kept_at_another_path_is_deleted(monkeypatch):
    gone = ('gone', 'b.txt', 'Z', 'text-Y', 1)

    diff = _diff(monkeypatch, [('a.txt', 'Y')], [CURRENT, gone])

    assert [d['file_id'] for d in diff.deleted] == ['gone']
    assert diff.unmodified_count == 1


def test_an_extra_copy_holding_text_kept_at_another_path_is_deleted(monkeypatch):
    b_current = ('b-current', 'b.txt', 'Q', 'text-Q', 2)
    b_extra = ('b-extra', 'b.txt', 'Z', 'text-Y', 1)

    diff = _diff(monkeypatch, [('a.txt', 'Y'), ('b.txt', 'Q')], [CURRENT, b_current, b_extra])

    assert [d['file_id'] for d in diff.deleted] == ['b-extra']
    assert diff.unmodified_count == 2


def test_a_copy_of_a_stale_copys_text_is_still_uploaded(monkeypatch):
    # b.txt holds the text of a.txt's stale copy, which this sync deletes, so it
    # is the only copy left and goes up.
    diff = _diff(monkeypatch, [('a.txt', 'Y'), ('b.txt', 'X')], [STALE, CURRENT])

    assert diff.added == [{'filename': 'b.txt', 'path': ''}]
    assert [d['file_id'] for d in diff.deleted] == ['stale']


def test_an_older_copy_with_the_replaced_copys_text_is_deleted(monkeypatch):
    # a.docx saved again with the same text: the newest old copy stays until the
    # new version is up (#317), and the older one, holding that text too, goes
    # first, so the new version is not refused as duplicate content once the
    # replaced copy is gone.
    older = ('older', 'a.txt', 'W', 'text-X', 0)

    diff = _diff(monkeypatch, [('a.txt', 'Y')], [older, STALE])

    assert diff.modified == [{'filename': 'a.txt', 'path': '', 'stale_file_id': 'stale'}]
    assert [d['file_id'] for d in diff.deleted] == ['older']


class ChunkStore:
    """Chunks by collection; a delete drops those whose metadata matches every filter key."""

    def __init__(self):
        self.chunks: dict[str, list[dict]] = {}

    def add(self, collection_name, **metadata):
        self.chunks.setdefault(collection_name, []).append(metadata)

    async def delete(self, collection_name, ids=None, filter=None):
        if filter is None:
            self.chunks.pop(collection_name, None)
            return
        self.chunks[collection_name] = [
            c for c in self.chunks.get(collection_name, []) if any(c.get(k) != v for k, v in filter.items())
        ]

    def owners(self, collection_name):
        return sorted(c.get('file_id') or '-' for c in self.chunks.get(collection_name, []))


def test_syncing_away_an_extra_copy_with_the_kept_text_keeps_the_kept_copys_chunks(monkeypatch):
    # The diff and the cleanup a folder sync runs, against the suite's temporary
    # SQLite database: the extra copy goes, and its text stays found through
    # the copy the sync keeps (#792).
    store = ChunkStore()

    async def publish(*_a, **_k):
        return None

    monkeypatch.setattr(knowledge_router, 'ASYNC_VECTOR_DB_CLIENT', store)
    monkeypatch.setattr(knowledge_router, 'publish_event', publish)
    monkeypatch.setattr(knowledge_router.Storage, 'delete_file', lambda path: None)

    async def scenario():
        tag = uuid.uuid4().hex[:8]
        user = await Users.insert_new_user(f'u{tag}', 'Ada', f'u{tag}@example.invalid', role='user')
        kb = await Knowledges.insert_new_knowledge(user.id, KnowledgeForm(name='Notes', description=''))
        ids = {}
        for name, sha in (('current', 'Y'), ('resaved', 'Y2')):
            f = await Files.insert_new_file(
                user.id,
                FileForm(
                    id=f'{name}-{tag}',
                    hash=f'text-{tag}',
                    filename='a.txt',
                    path=f'/store/{name}',
                    meta={'file_hash': sha},
                ),
            )
            await Knowledges.add_file_to_knowledge_by_id(kb.id, f.id, user.id)
            store.add(kb.id, file_id=f.id, hash=f'text-{tag}')
            ids[name] = f.id
        user = SimpleNamespace(id=user.id, role='user')
        form = knowledge_router.SyncDiffForm(
            manifest=[knowledge_router.FileManifestEntry(filename='a.txt', path='', checksum='Y', size=1)]
        )
        diff = await knowledge_router.sync_knowledge_diff(kb.id, form, user=user, db=None)
        cleanup = knowledge_router.SyncCleanupForm(file_ids=[d['file_id'] for d in diff.deleted], dir_ids=diff.rmdir)
        result = await knowledge_router.sync_knowledge_cleanup(kb.id, cleanup, user=user, db=None)
        linked = {f.id for f in await Knowledges.get_files_by_id(kb.id)}
        return kb, ids, diff, result, linked

    kb, ids, diff, result, linked = asyncio.run(scenario())

    assert [d['file_id'] for d in diff.deleted] == [ids['resaved']]
    assert result == {'status': True, 'kept': []}
    assert linked == {ids['current']}
    assert store.owners(kb.id) == [ids['current']]
