"""The folder sync diff sees every linked copy at one path, not just one (#639).

A knowledge base can hold two linked files at one path and name: a modified
file's old copy whose removal failed, or one a cut-off status stream left
behind. The diff indexed the base's files by (path, filename) from a query
with no order, so it kept whichever copy came last. When that was the current
copy, the stale one was never reported and its text stayed retrievable for
good; when it was the stale one, every later sync reported the file modified.

Run from apps/server:

    python -m pytest tests/test_knowledge_sync_linked_copies.py
"""

import asyncio
from types import SimpleNamespace

import pytest

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


def test_an_identical_extra_copy_is_left_alone(monkeypatch):
    # Removing a file also deletes chunks by its text hash, which would take the
    # kept copy's chunks with it.
    twin = ('twin', 'a.txt', 'Y', 'text-Y', 1)

    diff = _diff(monkeypatch, [('a.txt', 'Y')], [CURRENT, twin])

    assert diff.deleted == []
    assert diff.unmodified_count == 1


@pytest.mark.parametrize('order', ['resaved-last', 'current-last'])
def test_an_extra_copy_with_the_kept_copys_text_is_left_alone(monkeypatch, order):
    # Other bytes, same text (a .docx saved again): its chunks are the kept copy's.
    resaved = ('resaved', 'a.txt', 'Y2', 'text-Y', 1)
    linked = [CURRENT, resaved] if order == 'resaved-last' else [resaved, CURRENT]

    diff = _diff(monkeypatch, [('a.txt', 'Y')], linked)

    assert diff.deleted == []
    assert diff.modified == []
    assert diff.unmodified_count == 1


def test_a_copy_of_a_stale_copys_text_is_still_uploaded(monkeypatch):
    # b.txt holds the text of a.txt's stale copy, which this sync deletes, so it
    # is the only copy left and goes up.
    diff = _diff(monkeypatch, [('a.txt', 'Y'), ('b.txt', 'X')], [STALE, CURRENT])

    assert diff.added == [{'filename': 'b.txt', 'path': ''}]
    assert [d['file_id'] for d in diff.deleted] == ['stale']
