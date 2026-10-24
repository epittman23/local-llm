"""Behaviour pinned by the fixes for ruff's flake8-bugbear findings B023 and B034.

The `tree` command and the terminal tool loader defined closures inside
loops; both now take what they use as arguments. The tool description
split passes maxsplit by keyword.

Run from apps/server:

    python -m pytest tests/test_bugbear_fixes.py
"""

from __future__ import annotations

import asyncio

from local_llm.tools import knowledge_fs
from local_llm.utils import tools


def _tree() -> dict:
    return {
        'dirs': {
            'd1': {'id': 'd1', 'name': 'docs', 'parent_id': None},
            'd2': {'id': 'd2', 'name': 'api', 'parent_id': 'd1'},
        },
        'files': [
            {'filename': 'readme.md', 'directory_id': None},
            {'filename': 'guide.md', 'directory_id': 'd1'},
            {'filename': 'spec.yaml', 'directory_id': 'd2'},
        ],
    }


def test_render_tree_draws_the_tree_it_is_given():
    assert knowledge_fs._render_tree(_tree(), None) == [
        '  ├── 📁 docs/',
        '  │   ├── 📁 api/',
        '  │   │   └── spec.yaml',
        '  │   └── guide.md',
        '  └── readme.md',
    ]


def test_render_tree_starts_from_a_subdirectory():
    assert knowledge_fs._render_tree(_tree(), 'd2', '    ') == ['    └── spec.yaml']


def test_terminal_tool_functions_keep_their_own_name_and_server(monkeypatch):
    calls = []

    async def fake_execute_tool_server(**kwargs):
        calls.append(kwargs)
        return kwargs['name']

    monkeypatch.setattr(tools, 'execute_tool_server', fake_execute_tool_server)
    server = {'url': 'http://terminal.invalid'}
    made = {
        name: tools._terminal_tool_function(name, server, {'h': '1'}, {'c': '2'})
        for name in ('run_command', 'display_file')
    }

    assert asyncio.run(made['run_command'](command='ls', page=2)) == 'run_command'
    assert asyncio.run(made['display_file'](path='a.txt', page=2)) == 'display_file'

    assert calls == [
        {
            'url': 'http://terminal.invalid',
            'headers': {'h': '1'},
            'cookies': {'c': '2'},
            'name': 'run_command',
            'params': {'command': 'ls', 'page': 2},
            'server_data': server,
        },
        {
            'url': 'http://terminal.invalid',
            'headers': {'h': '1'},
            'cookies': {'c': '2'},
            'name': 'display_file',
            # display_file renders inline: the page argument is not forwarded.
            'params': {'path': 'a.txt'},
            'server_data': server,
        },
    ]


def test_tool_description_is_the_docstring_before_the_first_field():
    def tool():
        """Add two numbers.

        :param a: first
        :return: the sum, with :param mentioned again
        """

    assert tools._tool_description(tool, 'tool').strip() == 'Add two numbers.'


def test_tool_description_falls_back_to_the_name():
    def tool():
        pass

    assert tools._tool_description(tool, 'tool') == 'tool'


def test_openapi_operations_become_tools_whatever_their_path():
    spec = {
        'paths': {
            '/a': {'get': {'operationId': 'get_a', 'summary': 'Get A'}},
            '/b/{id}': {
                'parameters': [{'name': 'id', 'in': 'path', 'required': True, 'schema': {'type': 'string'}}],
                'post': {'operationId': 'post_b', 'description': 'Post B'},
            },
            '/ignored': 'not a path item',
        }
    }

    payload = tools.convert_openapi_to_tool_payload(spec)

    assert [(t['name'], t['description']) for t in payload] == [('get_a', 'Get A'), ('post_b', 'Post B')]
    assert payload[1]['parameters']['required'] == ['id']


def test_the_tree_command_draws_each_knowledge_base_from_its_own_tree(monkeypatch):
    trees = {
        'kb1': _tree(),
        'kb2': {'dirs': {}, 'files': [{'filename': 'only.txt', 'directory_id': None}]},
    }

    async def kb_ids(user, model_knowledge):
        return [('kb1', 'First', ''), ('kb2', 'Second', 'notes')]

    async def build(kb_id):
        return trees[kb_id]

    monkeypatch.setattr(knowledge_fs, '_get_accessible_kb_ids', kb_ids)
    monkeypatch.setattr(knowledge_fs, '_build_directory_tree', build)

    out = asyncio.run(knowledge_fs._kb_tree([], set(), {'id': 'u1'}, None))

    assert out.split('\n') == [
        'Knowledge Base: First (kb1)',
        '  ├── 📁 docs/',
        '  │   ├── 📁 api/',
        '  │   │   └── spec.yaml',
        '  │   └── guide.md',
        '  └── readme.md',
        '',
        '  2 directories, 3 files',
        '',
        'Knowledge Base: Second (kb2)',
        '  notes',
        '  └── only.txt',
        '',
        '  0 directories, 1 files',
    ]
