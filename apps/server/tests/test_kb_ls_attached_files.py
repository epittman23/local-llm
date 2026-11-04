"""A model's directly attached files are listed once, not inside every knowledge base (#276).

`_get_accessible_files` added the model's directly attached files to its
result even when asked for one knowledge base's files, so `kb_exec ls` showed
each attached file as a root file of every base, as well as under "Attached
Files", which misled the model about where the file lives.

Run from apps/server:

    python -m pytest tests/test_kb_ls_attached_files.py
"""

import asyncio
from types import SimpleNamespace

from local_llm.models import files as files_model
from local_llm.models import knowledge as knowledge_model
from local_llm.tools import knowledge_fs


def _file(fid: str, name: str):
    return SimpleNamespace(id=fid, filename=name, meta={'size': 10}, updated_at=1_700_000_000)


def _install(monkeypatch):
    async def accessible_kbs(user, model_knowledge, knowledge_id=None):
        bases = [('kb1', 'Handbook', None), ('kb2', 'Notes', None)]
        return [b for b in bases if knowledge_id in (None, b[0])]

    async def kb_files(kb_id):
        return {'kb1': [(_file('k1', 'policy.md'), None)], 'kb2': [(_file('k2', 'todo.md'), None)]}[kb_id]

    async def no_dirs(kb_id, parent_id=None):
        return []

    async def attached(fid):
        return _file(fid, 'attached.pdf') if fid == 'a1' else None

    monkeypatch.setattr(knowledge_fs, '_get_accessible_kb_ids', accessible_kbs)
    monkeypatch.setattr(knowledge_model.Knowledges, 'get_files_with_directory_ids', kb_files)
    monkeypatch.setattr(knowledge_model.Knowledges, 'get_directories', no_dirs)
    monkeypatch.setattr(files_model.Files, 'get_file_by_id', attached)


MODEL_KNOWLEDGE = [
    {'type': 'collection', 'id': 'kb1'},
    {'type': 'collection', 'id': 'kb2'},
    {'type': 'file', 'id': 'a1'},
]


def test_ls_lists_an_attached_file_once_under_attached_files(monkeypatch):
    _install(monkeypatch)

    out = asyncio.run(knowledge_fs._kb_ls([], set(), {'id': 'u1'}, MODEL_KNOWLEDGE))

    assert out.count('attached.pdf') == 1
    bases, attached = out.split('Attached Files:')
    assert 'attached.pdf' not in bases
    assert 'attached.pdf' in attached
    assert 'policy.md' in bases and 'todo.md' in bases


def test_one_knowledge_bases_files_do_not_include_attached_files(monkeypatch):
    _install(monkeypatch)

    files = asyncio.run(knowledge_fs._get_accessible_files({'id': 'u1'}, MODEL_KNOWLEDGE, knowledge_id='kb1'))

    assert [f['id'] for f in files] == ['k1']


def test_all_files_still_include_attached_ones(monkeypatch):
    _install(monkeypatch)

    files = asyncio.run(knowledge_fs._get_accessible_files({'id': 'u1'}, MODEL_KNOWLEDGE))

    assert sorted(f['id'] for f in files) == ['a1', 'k1', 'k2']


def test_ls_with_only_attached_files_lists_them(monkeypatch):
    _install(monkeypatch)

    async def no_kbs(user, model_knowledge, knowledge_id=None):
        return []

    monkeypatch.setattr(knowledge_fs, '_get_accessible_kb_ids', no_kbs)

    out = asyncio.run(knowledge_fs._kb_ls([], set(), {'id': 'u1'}, [{'type': 'file', 'id': 'a1'}]))

    assert out.startswith('Attached Files:')
    assert out.count('attached.pdf') == 1
