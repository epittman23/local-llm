"""Paging view_file / view_knowledge_file with line numbers reads every character (#178).

next_offset and returned_chars were computed from the line-numbered text,
so the "12: " prefixes pushed the next page past text never returned.

Run from apps/server:

    python -m pytest tests/test_view_file_paging.py
"""

import asyncio
import json
import re
from types import SimpleNamespace

import pytest

from local_llm.tools import builtin

CONTENT = '\n'.join(f'line {i:03d} ' + 'x' * (i % 7) for i in range(1, 61))
FILE = SimpleNamespace(id='f1', filename='f.txt', data={'content': CONTENT}, user_id='u1', updated_at=1, created_at=1)
USER = {'id': 'u1', 'role': 'user'}
REQUEST = SimpleNamespace()


@pytest.fixture(autouse=True)
def one_file(monkeypatch):
    from local_llm.models.files import Files
    from local_llm.models.knowledge import Knowledges

    async def get_file(file_id):
        return FILE

    async def allowed(*_a, **_k):
        return True

    async def none(*_a, **_k):
        return []

    monkeypatch.setattr(Files, 'get_file_by_id', get_file)
    monkeypatch.setattr(builtin, '_has_read_access_to_file', allowed)
    monkeypatch.setattr(builtin.Groups, 'get_groups_by_member_id', none)
    monkeypatch.setattr(Knowledges, 'get_knowledges_by_file_id', none)


def _read_all(tool) -> tuple[str, list[int]]:
    """Page through with line numbers on, stripping each line's number back off."""
    raw, offsets, offset = '', [], 0
    while True:
        page = json.loads(
            asyncio.run(tool('f1', offset=offset, max_chars=200, line_numbers=True, __request__=REQUEST, __user__=USER))
        )
        raw += '\n'.join(re.sub(r'^\d+: ', '', line, count=1) for line in page['content'].split('\n'))
        offsets.append(offset)
        if not page.get('truncated'):
            return raw, offsets
        assert page['returned_chars'] == 200
        offset = page['next_offset']


@pytest.mark.parametrize('tool', [builtin.view_file, builtin.view_knowledge_file])
def test_paging_with_line_numbers_returns_the_whole_file_once(tool):
    raw, offsets = _read_all(tool)

    assert raw == CONTENT
    assert offsets == list(range(0, len(CONTENT), 200))
