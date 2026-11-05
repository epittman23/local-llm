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
        # Each page starts at the number of the line its first character is on.
        assert page['content'].split(':', 1)[0] == str(CONTENT[:offset].count('\n') + 1)
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


# --- #513: a page's edges ------------------------------------------------------


def _page(tool, **kwargs):
    return json.loads(asyncio.run(tool('f1', __request__=REQUEST, __user__=USER, **kwargs)))


@pytest.mark.parametrize('tool', [builtin.view_file, builtin.view_knowledge_file])
def test_a_page_ending_on_a_newline_does_not_number_the_next_line_too(tool):
    first_line = CONTENT.split('\n')[0]
    page = _page(tool, offset=0, max_chars=len(first_line) + 1, line_numbers=True)
    next_page = _page(tool, offset=page['next_offset'], max_chars=20, line_numbers=True)

    assert page['content'] == f'1: {first_line}\n'
    assert next_page['content'].startswith('2: ')


@pytest.mark.parametrize('tool', [builtin.view_file, builtin.view_knowledge_file])
def test_a_page_starting_mid_line_says_its_first_line_is_continued(tool):
    mid = _page(tool, offset=3, max_chars=20, line_numbers=True)
    start = _page(tool, offset=0, max_chars=20, line_numbers=True)
    next_line = _page(tool, offset=CONTENT.index('\n') + 1, max_chars=20, line_numbers=True)

    assert mid['first_line_continued'] is True
    assert mid['content'].startswith('1: ')
    assert 'first_line_continued' not in start
    assert 'first_line_continued' not in next_line


@pytest.mark.parametrize('tool', [builtin.view_file, builtin.view_knowledge_file])
@pytest.mark.parametrize(('start_line', 'end_line'), [(200, None), (70, 80), (10, 5)])
def test_a_line_range_that_selects_nothing_says_so_instead_of_a_reversed_range(tool, start_line, end_line):
    page = _page(tool, start_line=start_line, end_line=end_line)

    assert page['content'] == ''
    assert 'showing_lines' not in page
    assert page['total_lines'] == 60
    assert page['note']
    assert not page.get('truncated')


@pytest.mark.parametrize('tool', [builtin.view_file, builtin.view_knowledge_file])
def test_a_line_range_still_reads_as_before(tool):
    page = _page(tool, start_line=59, end_line=70)

    assert page['showing_lines'] == '59-60'
    assert page['content'].split('\n')[0].startswith('59: ')
    assert 'note' not in page


@pytest.mark.parametrize('tool', [builtin.view_file, builtin.view_knowledge_file])
def test_a_numbered_page_past_the_end_is_empty_not_an_error(tool):
    page = _page(tool, offset=len(CONTENT) + 5, max_chars=20, line_numbers=True)

    assert 'error' not in page
    assert page['returned_chars'] == 0
    assert 'first_line_continued' not in page


@pytest.mark.parametrize('tool', [builtin.view_file, builtin.view_knowledge_file])
def test_the_note_says_which_end_of_the_range_selects_nothing(tool):
    assert 'start_line is past the end' in _page(tool, start_line=200)['note']
    assert 'end_line is before start_line' in _page(tool, start_line=10, end_line=5)['note']
