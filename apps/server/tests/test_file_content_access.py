"""Who GET /files/{id}/content serves, and how (canvas Phase 4e).

The canvas opens a knowledge file a reply cites by fetching this route, so it
is the only access check on that path: the owner, an admin or a user with read
access to the file (through a knowledge base) gets the bytes; anyone else gets
a 404, which sends no data. `has_access_to_file` itself (which knowledge bases
confer read) is covered by test_file_and_folder_access.py; here it is replaced
by a stub that names the one user it lets in, so the route's own decision is
what is tested.

Run from apps/server:

    python -m pytest tests/test_file_content_access.py
"""

import asyncio
import io
import uuid

import pytest
from fastapi import HTTPException

from local_llm.models.files import FileForm, Files
from local_llm.models.users import Users
from local_llm.routers import files as files_router
from local_llm.storage.provider import Storage


async def _user(role='user'):
    tag = uuid.uuid4().hex[:8]
    return await Users.insert_new_user(f'u{tag}', f'User {tag}', f'u{tag}@example.invalid', role=role)


async def _file(owner, name, content_type, data=b'cited text\n'):
    file_id = str(uuid.uuid4())
    _, path = Storage.upload_file(io.BytesIO(data), f'{file_id}_{name}', {})
    return await Files.insert_new_file(
        owner.id,
        FileForm(
            id=file_id, filename=name, path=path, meta={'name': name, 'content_type': content_type, 'size': len(data)}
        ),
    )


def _only_for(monkeypatch, reader):
    async def has_access(file_id, access_type, user, db=None, **_k):
        return user.id == reader.id and access_type == 'read'

    monkeypatch.setattr(files_router, 'has_access_to_file', has_access)


def _get(file_id, user, attachment=False):
    return files_router.get_file_content_by_id(file_id, user=user, attachment=attachment, db=None)


def _disposition(response):
    return response.headers.get('content-disposition')


def test_a_reader_through_a_knowledge_base_gets_the_file_and_a_stranger_gets_a_404(monkeypatch):
    async def scenario():
        owner, reader, stranger = await _user(), await _user(), await _user()
        file = await _file(owner, 'notes.txt', 'text/plain')
        _only_for(monkeypatch, reader)
        served = await _get(file.id, reader)
        with pytest.raises(HTTPException) as refused:
            await _get(file.id, stranger)
        return served, refused.value

    served, refused = asyncio.run(scenario())

    assert served.status_code == 200
    assert refused.status_code == 404


def test_the_owner_and_an_admin_get_the_file_without_a_grant(monkeypatch):
    async def scenario():
        owner, admin, reader = await _user(), await _user('admin'), await _user()
        file = await _file(owner, 'notes.txt', 'text/plain')
        _only_for(monkeypatch, reader)
        return await _get(file.id, owner), await _get(file.id, admin)

    owned, administered = asyncio.run(scenario())

    assert owned.status_code == administered.status_code == 200


def test_a_missing_file_is_a_404_for_everyone(monkeypatch):
    async def scenario():
        reader = await _user()
        _only_for(monkeypatch, reader)
        with pytest.raises(HTTPException) as refused:
            await _get(str(uuid.uuid4()), reader)
        return refused.value

    assert asyncio.run(scenario()).status_code == 404


def test_a_file_is_an_attachment_unless_it_is_plain_text_or_a_pdf(monkeypatch):
    async def scenario():
        owner = await _user()
        _only_for(monkeypatch, owner)
        out = {}
        for name, content_type in (
            ('notes.txt', 'text/plain'),
            ('page.html', 'text/html'),
            ('notes.md', 'text/markdown'),
            ('paper.pdf', 'application/pdf'),
        ):
            file = await _file(owner, name, content_type)
            out[name] = await _get(file.id, owner)
        plain = await _file(owner, 'again.txt', 'text/plain')
        out['asked'] = await _get(plain.id, owner, attachment=True)
        return out

    out = asyncio.run(scenario())

    assert _disposition(out['notes.txt']) is None
    assert _disposition(out['page.html']).startswith('attachment')
    assert _disposition(out['notes.md']).startswith('attachment')
    assert _disposition(out['paper.pdf']).startswith('inline')
    assert _disposition(out['asked']).startswith('attachment')
