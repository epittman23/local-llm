"""A file has no phantom line after its last newline, and start_line / end_line are coerced (#666).

Lines split on '\\n' only, as grep, sed and the character mode's numbering
already do, so a number grep reports is the number view_file reads.

Run from apps/server:

    python -m pytest tests/test_file_tool_lines.py
"""

import asyncio
import json
from types import SimpleNamespace

import pytest

from local_llm.tools import builtin, knowledge_fs

USER = {'id': 'u1', 'role': 'user'}
REQUEST = SimpleNamespace()
TOOLS = [builtin.view_file, builtin.view_knowledge_file]


@pytest.fixture
def serve(monkeypatch):
    """Serve `content` as the one file, to the builtin tools and to the shell tools."""
    from local_llm.models.files import Files
    from local_llm.models.knowledge import Knowledges

    async def allowed(*_a, **_k):
        return True

    async def none(*_a, **_k):
        return []

    def set_content(content):
        file = SimpleNamespace(
            id='f1', filename='f.txt', data={'content': content}, user_id='u1', updated_at=1, created_at=1
        )

        async def get_file(file_id):
            return file

        async def resolve(*_a, **_k):
            return {'content': content}

        monkeypatch.setattr(Files, 'get_file_by_id', get_file)
        monkeypatch.setattr(knowledge_fs, '_resolve_file', resolve)

    monkeypatch.setattr(builtin, '_has_read_access_to_file', allowed)
    monkeypatch.setattr(builtin.Groups, 'get_groups_by_member_id', none)
    monkeypatch.setattr(Knowledges, 'get_knowledges_by_file_id', none)
    return set_content


def _page(tool, **kwargs):
    return json.loads(asyncio.run(tool('f1', __request__=REQUEST, __user__=USER, **kwargs)))


@pytest.mark.parametrize('tool', TOOLS)
def test_a_trailing_newline_is_not_a_line(tool, serve):
    serve('a\nb\nc\n')
    page = _page(tool, start_line=1)

    assert page['total_lines'] == 3
    assert page['content'] == '1: a\n2: b\n3: c'
    assert page['showing_lines'] == '1-3'
    assert 'truncated' not in page


@pytest.mark.parametrize('tool', TOOLS)
def test_a_file_without_a_trailing_newline_counts_as_before(tool, serve):
    serve('a\nb\nc')
    page = _page(tool, start_line=1)

    assert page['total_lines'] == 3
    assert page['content'] == '1: a\n2: b\n3: c'


@pytest.mark.parametrize('tool', TOOLS)
def test_the_last_page_does_not_point_at_a_phantom_line(tool, serve):
    serve(''.join(f'l{i}\n' for i in range(1, 201)))
    first = _page(tool, start_line=1)
    last = _page(tool, start_line=first['next_start_line'])

    assert first['next_start_line'] == 101
    assert last['showing_lines'] == '101-200'
    assert 'next_start_line' not in last
    assert 'truncated' not in last


@pytest.mark.parametrize('tool', TOOLS)
def test_a_blank_last_line_is_still_a_line(tool, serve):
    serve('a\n\n')
    page = _page(tool, start_line=1)

    assert page['total_lines'] == 2
    assert page['content'] == '1: a\n2: '


@pytest.mark.parametrize('tool', TOOLS)
def test_other_line_separators_do_not_split_a_line(tool, serve):
    serve('a\rb\x0cc\r\nd\n')
    page = _page(tool, start_line=1)

    assert page['total_lines'] == 2
    assert page['content'].startswith('1: a\rb\x0cc\r\n2: d')


@pytest.mark.parametrize('tool', TOOLS)
def test_the_character_mode_page_at_the_end_has_no_phantom_line(tool, serve):
    serve('a\nb\n')
    page = _page(tool, offset=4, max_chars=20, line_numbers=True)

    assert page['content'] == ''


@pytest.mark.parametrize('tool', TOOLS)
@pytest.mark.parametrize('end_line', ['3', 3])
def test_a_line_range_given_as_text_reads_as_a_number(tool, serve, end_line):
    serve('a\nb\nc\nd\n')
    page = _page(tool, start_line='2', end_line=end_line)

    assert page['showing_lines'] == '2-3'


@pytest.mark.parametrize('tool', TOOLS)
@pytest.mark.parametrize(('start_line', 'end_line'), [('x', None), ('5.0', None), (1, 'x'), (1, '2.5'), (1.5, None)])
def test_a_line_that_is_not_an_integer_is_a_friendly_error(tool, serve, start_line, end_line):
    serve('a\nb\nc\n')
    page = _page(tool, start_line=start_line, end_line=end_line)

    assert 'line' in page['error']
    assert 'invalid literal' not in page['error']


@pytest.mark.parametrize('tool', TOOLS)
@pytest.mark.parametrize('zero', [0, '0', '', None])
def test_an_end_line_of_zero_is_unset_in_either_form(tool, serve, zero):
    serve(''.join(f'l{i}\n' for i in range(1, 201)))
    page = _page(tool, start_line=1, end_line=zero)

    assert page['showing_lines'] == '1-100'


@pytest.mark.parametrize('tool', TOOLS)
@pytest.mark.parametrize('zero', [0, '0'])
def test_a_start_line_of_zero_starts_at_the_first_line_in_either_form(tool, serve, zero):
    serve('a\nb\nc\n')

    assert _page(tool, start_line=zero)['showing_lines'] == '1-3'


def test_cat_n_does_not_number_a_phantom_line(serve):
    serve('a\nb\n')

    assert asyncio.run(knowledge_fs._kb_cat(['f1'], {'n'}, USER, None)) == '1: a\n2: b'


def test_head_and_tail_count_a_trailing_newline_as_no_line(serve):
    serve('a\nb\nc\n')

    assert asyncio.run(knowledge_fs._kb_head(['-2', 'f1'], set(), USER, None)) == 'a\nb\n[showing 2 of 3 lines]'
    assert asyncio.run(knowledge_fs._kb_tail(['-2', 'f1'], set(), USER, None)) == 'b\nc\n[showing last 2 of 3 lines]'
    assert asyncio.run(knowledge_fs._kb_head(['-5', 'f1'], set(), USER, None)) == 'a\nb\nc'
    assert asyncio.run(knowledge_fs._kb_tail(['-5', 'f1'], set(), USER, None)) == 'a\nb\nc'


def test_piped_tail_does_not_end_on_a_phantom_line(serve):
    assert asyncio.run(knowledge_fs._kb_tail(['-1'], set(), USER, None, piped_input='a\nb\n')) == 'b'
