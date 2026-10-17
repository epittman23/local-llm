"""Characterization tests for the knowledge-base `grep` command (tools/knowledge_fs.py's _kb_grep).

It was refactored for ruff's complexity limit with no tests of its own, so
these pin what it did before the refactor: the exact text it returns for
each case. File access is replaced by a small fake knowledge base (files,
directories, and what a reference resolves to); the matcher runs for real.
Each case's output was recorded from the untouched function into
fixtures/kb_grep.json and must not change.

The golden file is only ever written by hand, never by this test. To record
it again (only for an intended behaviour change, reviewed as such), run
`KB_GREP_GOLDEN_RECORD=1 pytest tests/test_kb_grep.py`.
"""

import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from local_llm.models import files as files_model
from local_llm.tools import knowledge_fs

GOLDEN = Path(__file__).parent / 'fixtures' / 'kb_grep.json'
RECORD = os.environ.get('KB_GREP_GOLDEN_RECORD') == '1'

# A small knowledge base: kb1 has docs/ (d1) with docs/api/ (d2), plus root files; kb2 has one file.
FILES = {
    'f1': {
        'filename': 'readme.md',
        'content': 'Hello World\nhello again\nbye',
        'directory_id': None,
        'knowledge_id': 'kb1',
    },
    'f2': {'filename': 'guide.md', 'content': 'Install\nRun hello\n', 'directory_id': 'd1', 'knowledge_id': 'kb1'},
    'f3': {
        'filename': 'auth.py',
        'content': 'def hello():\n    return "HELLO"\nx = 1',
        'directory_id': 'd2',
        'knowledge_id': 'kb1',
    },
    'f4': {'filename': 'notes.txt', 'content': 'nothing here', 'directory_id': None, 'knowledge_id': 'kb2'},
    'f5': {'filename': 'empty.md', 'content': '', 'directory_id': 'd1', 'knowledge_id': 'kb1'},
    'f6': {'filename': 'gone.md', 'content': None, 'directory_id': None, 'knowledge_id': 'kb1'},
    'f7': {'filename': 'deleted.md', 'content': 'hello', 'directory_id': None, 'knowledge_id': 'kb1', 'deleted': True},
    'f8': {'filename': 'direct.md', 'content': 'attached hello', 'directory_id': None, 'knowledge_id': None},
}
DIRS = {('docs', 'kb1'): 'd1', ('docs/api', 'kb1'): 'd2', ('empty_dir', 'kb1'): 'd9'}
DESCENDANTS = {'d1': {'d1', 'd2'}, 'd2': {'d2'}, 'd9': {'d9'}}
RESOLVE = {
    'readme.md': 'f1',
    'f3': 'f3',
    'notes.txt': 'f4',
    'empty.md': 'f5',
    'ambiguous.md': {'error': 'Ambiguous filename "ambiguous.md". Use full path to disambiguate:\n  a  b'},
}

# (case id, args, flags, piped_input, settings)
CASES = [
    ('no_args', [], set(), None, {}),
    ('invalid_regex', ['(unclosed'], {'E'}, None, {}),
    ('quantifier_too_large', ['a{5000}'], {'E'}, None, {}),
    ('piped_matches', ['hello'], set(), 'hello one\nnope\nsay hello', {}),
    ('piped_case_insensitive', ['HELLO'], {'i'}, 'hello one\nnope\nHeLLo', {}),
    ('piped_count', ['hello'], {'c'}, 'hello\nhello\nno', {}),
    ('piped_count_zero', ['zzz'], {'c'}, 'hello', {}),
    ('piped_files_with_match', ['hello'], {'l'}, 'hello', {}),
    ('piped_files_without_match', ['zzz'], {'l'}, 'hello', {}),
    ('piped_no_match', ['zzz'], set(), 'hello', {}),
    ('piped_regex_auto', ['one|two'], set(), 'one\nthree\ntwo', {}),
    ('piped_empty_input', ['x'], set(), '', {}),
    ('single_file', ['hello', 'readme.md'], set(), None, {}),
    ('single_file_case_insensitive', ['hello', 'readme.md'], {'i'}, None, {}),
    ('single_file_count', ['hello', 'readme.md'], {'c'}, None, {}),
    ('single_file_count_zero', ['zzz', 'readme.md'], {'c'}, None, {}),
    ('single_file_files_with_match', ['hello', 'f3'], {'l'}, None, {}),
    ('single_file_files_without_match', ['zzz', 'f3'], {'l'}, None, {}),
    ('single_file_no_match', ['zzz', 'notes.txt'], set(), None, {}),
    ('single_file_empty', ['x', 'empty.md'], set(), None, {}),
    ('single_file_ambiguous', ['hello', 'ambiguous.md'], set(), None, {}),
    ('unresolved_file_is_a_directory', ['hello', 'docs'], set(), None, {}),
    ('unresolved_file_and_no_such_directory', ['hello', 'nowhere'], set(), None, {}),
    ('file_with_directory_scope', ['hello', 'readme.md', 'docs/'], set(), None, {}),
    ('last_file_ref_wins', ['hello', 'notes.txt', 'readme.md'], set(), None, {}),
    ('directory_scope', ['hello', 'docs/'], set(), None, {}),
    ('nested_directory_scope', ['hello', '/docs/api/'], {'i'}, None, {}),
    ('directory_with_no_files', ['hello', 'empty_dir/'], set(), None, {}),
    ('extension_glob', ['hello', '*.py'], {'i'}, None, {}),
    ('extension_dot', ['hello', '.md'], set(), None, {}),
    ('extension_and_directory', ['hello', 'docs/', '*.md'], set(), None, {}),
    ('extension_matches_nothing', ['hello', '*.rs'], set(), None, {}),
    ('all_files', ['hello'], set(), None, {}),
    ('all_files_case_insensitive', ['hello'], {'i'}, None, {}),
    ('all_files_count', ['hello'], {'c', 'i'}, None, {}),
    ('all_files_count_zero', ['zzz'], {'c'}, None, {}),
    ('all_files_names_only', ['hello'], {'l'}, None, {}),
    ('all_files_names_only_zero', ['zzz'], {'l'}, None, {}),
    ('all_files_count_and_names', ['hello'], {'c', 'l'}, None, {}),
    ('all_files_no_match', ['zzz'], set(), None, {}),
    ('all_files_regex_flag', ['^def|^x'], {'E'}, None, {}),
    ('trailing_whitespace_trimmed', ['again'], set(), None, {}),
    ('too_many_files', ['hello'], set(), None, {'max_files': 3}),
    ('too_many_files_after_filter', ['hello', '*.md'], set(), None, {'max_files': 2}),
    ('matches_truncated', ['hello'], {'i'}, None, {'max_matches': 2}),
    ('matches_exactly_at_limit', ['hello'], set(), None, {'max_matches': 4}),
    ('no_model_knowledge', ['hello'], set(), None, {'direct_files': False}),
]


def _accessible(include_direct: bool) -> list[dict]:
    return [
        {
            'id': fid,
            'filename': f['filename'],
            'directory_id': f['directory_id'],
            'knowledge_id': f['knowledge_id'],
            'knowledge_name': f'name-{f["knowledge_id"]}' if f['knowledge_id'] else None,
        }
        for fid, f in FILES.items()
        if include_direct or f['knowledge_id']
    ]


def _file_record(fid: str) -> dict:
    f = FILES[fid]
    return {'id': fid, 'filename': f['filename'], 'content': f['content'] or ''}


def _run(args, flags, piped_input, settings, monkeypatch) -> str:
    include_direct = settings.get('direct_files', True)

    async def resolve_file(ref, user, model_knowledge):
        target = RESOLVE.get(ref)
        if isinstance(target, dict):
            return target
        return _file_record(target) if target else None

    async def accessible_files(user, model_knowledge, knowledge_id=None):
        return _accessible(include_direct)

    async def resolve_dir_path(path, knowledge_id):
        return DIRS.get((path, knowledge_id))

    async def descendant_dir_ids(dir_id, knowledge_id):
        return set(DESCENDANTS[dir_id])

    async def get_file_by_id(fid):
        f = FILES.get(fid)
        if not f or f.get('deleted'):
            return None
        data = None if f['content'] is None else {'content': f['content']}
        return SimpleNamespace(id=fid, filename=f['filename'], data=data)

    monkeypatch.setattr(knowledge_fs, '_resolve_file', resolve_file)
    monkeypatch.setattr(knowledge_fs, '_get_accessible_files', accessible_files)
    monkeypatch.setattr(knowledge_fs, '_resolve_dir_path', resolve_dir_path)
    monkeypatch.setattr(knowledge_fs, '_get_descendant_dir_ids', descendant_dir_ids)
    monkeypatch.setattr(files_model.Files, 'get_file_by_id', get_file_by_id)
    monkeypatch.setattr(knowledge_fs, 'KB_EXEC_MAX_GREP_FILES', settings.get('max_files', 100))
    monkeypatch.setattr(knowledge_fs, 'KNOWLEDGE_GREP_MAX_MATCHES', settings.get('max_matches', 50))

    async def grep():
        with knowledge_fs.match_budget():
            return await knowledge_fs._kb_grep(
                list(args), set(flags), {'id': 'u1'}, [{'type': 'collection'}], piped_input
            )

    return asyncio.run(grep())


def _golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding='utf-8'))


def test_case_ids_are_unique():
    ids = [case[0] for case in CASES]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize(('case_id', 'args', 'flags', 'piped_input', 'settings'), CASES, ids=[c[0] for c in CASES])
def test_grep_matches_golden(monkeypatch, case_id, args, flags, piped_input, settings):
    result = _run(args, flags, piped_input, settings, monkeypatch)
    if RECORD:
        pytest.skip('recording')
    assert result == _golden()[case_id]


def test_record_golden(monkeypatch):
    """Writes the golden file, only when KB_GREP_GOLDEN_RECORD=1."""
    if not RECORD:
        pytest.skip('set KB_GREP_GOLDEN_RECORD=1 to record the golden file')
    golden = {}
    for case_id, args, flags, piped_input, settings in CASES:
        with monkeypatch.context() as m:
            golden[case_id] = _run(args, flags, piped_input, settings, m)
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
