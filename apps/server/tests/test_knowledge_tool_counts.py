"""The knowledge tools count and page a base's files without loading their text (#186).

`list_knowledge_bases` and `search_knowledge_bases` loaded every file of every
base on the page, extracted text included, only to count them, though the
search they run already returns each base's `file_count`. `list_knowledge`
loaded a base's files the same way and paged them in Python, in whatever order
the database gave, so pages could repeat or skip files. These run against the
suite's migrated SQLite database.

Run from apps/server:

    python -m pytest tests/test_knowledge_tool_counts.py
"""

import asyncio
import json
import uuid
from types import SimpleNamespace

from local_llm.models.files import FileForm, Files
from local_llm.models.knowledge import KnowledgeForm, Knowledges
from local_llm.models.users import Users
from local_llm.tools import builtin


def _run(coro):
    return asyncio.run(coro)


async def _base(n_files: int):
    tag = uuid.uuid4().hex[:8]
    user = await Users.insert_new_user(f'u{tag}', 'Ada', f'u{tag}@example.invalid', role='user')
    kb = await Knowledges.insert_new_knowledge(user.id, KnowledgeForm(name=f'Notes {tag}', description=''))
    ids = []
    for i in range(n_files):
        f = await Files.insert_new_file(
            user.id,
            FileForm(
                id=str(uuid.uuid4()),
                hash=f'h{i}',
                filename=f'doc{i:02}.txt',
                path=f'/s/{i}',
                data={'content': 'x' * 100},
            ),
        )
        await Knowledges.add_file_to_knowledge_by_id(kb.id, f.id, user.id)
        ids.append(f.id)
    return user, kb, ids


def _no_full_files(monkeypatch):
    async def refuse(*args, **kwargs):
        raise AssertionError('loaded every file, text included, to count them')

    monkeypatch.setattr(Knowledges, 'get_files_by_id', refuse)


def test_a_bases_files_are_paged_oldest_first_then_by_name():
    _user, kb, ids = _run(_base(5))

    total, page = _run(Knowledges.get_file_page_by_id(kb.id, skip=2, limit=2))

    assert total == 5
    assert [f[0] for f in page] == ids[2:4]
    assert [f[1] for f in page] == ['doc02.txt', 'doc03.txt']


def test_list_knowledge_pages_a_base_without_loading_its_files(monkeypatch):
    user, kb, ids = _run(_base(3))
    _no_full_files(monkeypatch)

    out = json.loads(
        _run(
            builtin.list_knowledge(
                knowledge_id=kb.id,
                skip=1,
                count=1,
                __request__=SimpleNamespace(),
                __user__={'id': user.id, 'role': 'admin'},
                __model_knowledge__=[{'type': 'collection', 'id': kb.id}],
            )
        )
    )

    (entry,) = out['knowledge_bases']
    assert entry['file_count'] == 3
    assert entry['files'] == [{'id': ids[1], 'filename': 'doc01.txt'}]
    assert (entry['files_total'], entry['has_more']) == (3, True)


def test_listing_and_searching_bases_count_without_loading_files(monkeypatch):
    user, kb, _ids = _run(_base(4))
    _no_full_files(monkeypatch)

    for tool, args in ((builtin.list_knowledge_bases, {}), (builtin.search_knowledge_bases, {'query': kb.name})):
        out = json.loads(_run(tool(**args, count=50, __request__=SimpleNamespace(), __user__={'id': user.id})))
        assert [b['file_count'] for b in out if b['id'] == kb.id] == [4], tool.__name__
