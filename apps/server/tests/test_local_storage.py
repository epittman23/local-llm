"""Uploads stored under an earlier DATA_DIR are still found.

File rows keep the absolute path an upload was written to, so rows from
before DATA_DIR moved (apps/server/backend/data until 2026-10-10) point at a
directory that no longer exists, while the bytes sit in the current
UPLOAD_DIR.
"""

from local_llm.storage import provider
from local_llm.storage.provider import LocalStorageProvider


def test_a_path_under_an_old_data_dir_resolves_to_upload_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(provider, 'UPLOAD_DIR', str(tmp_path))
    (tmp_path / 'abc_report.pdf').write_bytes(b'%PDF')

    stored = '/home/someone/local-llm/apps/server/backend/data/uploads/abc_report.pdf'
    assert LocalStorageProvider.get_file(stored) == str(tmp_path / 'abc_report.pdf')


def test_an_existing_path_is_returned_unchanged(tmp_path, monkeypatch):
    monkeypatch.setattr(provider, 'UPLOAD_DIR', str(tmp_path / 'uploads'))
    elsewhere = tmp_path / 'abc_report.pdf'
    elsewhere.write_bytes(b'%PDF')

    assert LocalStorageProvider.get_file(str(elsewhere)) == str(elsewhere)


def test_a_missing_file_keeps_its_stored_path(tmp_path, monkeypatch):
    monkeypatch.setattr(provider, 'UPLOAD_DIR', str(tmp_path))
    stored = '/nowhere/uploads/missing.pdf'
    assert LocalStorageProvider.get_file(stored) == stored
