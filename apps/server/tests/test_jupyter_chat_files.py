"""The Jupyter engine gets the chat's uploaded files.

The Pyodide engine is handed `metadata['files']`; the Jupyter engine used to
get only the code, so a CSV attached to a chat could not be read from a
code block. Now utils/code_interpreter.py copies each file the user may read
into a directory per run on the Jupyter server, starts the kernel there, and
deletes the directory afterwards. These pin which files are copied, how the
run talks to the server, and the prompt that tells the model where they are.
"""

import asyncio
from types import SimpleNamespace

import pytest

from local_llm.config import CODE_INTERPRETER_JUPYTER_PROMPT, CODE_INTERPRETER_PYODIDE_PROMPT
from local_llm.utils import code_interpreter as ci
from local_llm.utils import middleware

OWNER = SimpleNamespace(id='owner')


@pytest.fixture
def stored_files(tmp_path, monkeypatch):
    """Files by id, each backed by a real file on disk; returns the dict to add to."""
    from local_llm.models.files import Files
    from local_llm.storage.provider import Storage
    from local_llm.utils.access_control import files as access

    files: dict = {}
    readable_by_grant: set[str] = set()

    def add(file_id, filename, user_id='owner', content=b'a,b\n1,2\n', size=None, granted=False):
        path = tmp_path / file_id
        path.write_bytes(content if size is None else b'x' * size)
        files[file_id] = SimpleNamespace(id=file_id, user_id=user_id, filename=filename, path=str(path))
        if granted:
            readable_by_grant.add(file_id)

    async def get_file_by_id(file_id, db=None):
        return files.get(file_id)

    async def has_access(file_id, access_type, user, db=None, user_group_ids=None):
        return access_type == 'read' and file_id in readable_by_grant

    monkeypatch.setattr(Files, 'get_file_by_id', get_file_by_id)
    monkeypatch.setattr(access, 'has_access_to_file', has_access)
    monkeypatch.setattr(Storage, 'get_file', lambda path: path)
    return add


def _items(*ids, kind='file'):
    return [{'type': kind, 'id': i, 'name': f'name-{i}'} for i in ids]


def test_copies_the_users_own_files_by_their_filename(stored_files):
    stored_files('f1', 'sales.csv')
    files, notes = asyncio.run(ci.chat_files(_items('f1'), OWNER))

    assert [name for name, _ in files] == ['sales.csv']
    assert notes == []


def test_another_users_file_needs_read_access(stored_files):
    stored_files('mine', 'a.csv')
    stored_files('theirs', 'b.csv', user_id='someone-else')
    stored_files('shared', 'c.csv', user_id='someone-else', granted=True)
    files, _ = asyncio.run(ci.chat_files(_items('mine', 'theirs', 'shared'), OWNER))

    assert [name for name, _ in files] == ['a.csv', 'c.csv']


def test_only_uploaded_files_count(stored_files):
    stored_files('f1', 'a.csv')
    items = [
        *_items('f1', kind='collection'),
        *_items('f1', kind='web_search'),
        {'type': 'image', 'url': 'data:image/png;base64,xx'},
        {'type': 'file'},
        'not a dict',
    ]
    files, notes = asyncio.run(ci.chat_files(items, OWNER))

    assert files == [] and notes == []


def test_no_user_copies_nothing(stored_files):
    stored_files('f1', 'a.csv')
    assert asyncio.run(ci.chat_files(_items('f1'), None)) == ([], [])


def test_names_are_reduced_to_a_base_name_and_made_unique(stored_files):
    stored_files('f1', '../../etc/passwd')
    stored_files('f2', 'data.csv')
    stored_files('f3', 'data.csv')
    stored_files('f4', 'C:\\Users\\me\\data.csv')
    files, _ = asyncio.run(ci.chat_files(_items('f1', 'f2', 'f3', 'f4'), OWNER))

    assert [name for name, _ in files] == ['passwd', 'data.csv', 'data (2).csv', 'data (3).csv']


def test_files_over_the_limits_are_left_out_with_a_note(stored_files, monkeypatch):
    monkeypatch.setattr(ci, 'MAX_FILE_BYTES', 10)
    monkeypatch.setattr(ci, 'MAX_TOTAL_BYTES', 15)
    stored_files('small', 'small.csv', size=8)
    stored_files('big', 'big.csv', size=11)
    stored_files('second', 'second.csv', size=8)
    files, notes = asyncio.run(ci.chat_files(_items('small', 'big', 'second'), OWNER))

    assert [name for name, _ in files] == ['small.csv']
    assert [note.split(':')[0] for note in notes] == ['big.csv', 'second.csv']


class FakeResponse:
    def __init__(self, body=None):
        self.body = body or {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def raise_for_status(self):
        pass

    async def json(self):
        return self.body


class FakeSession:
    def __init__(self):
        self.calls = []

    def put(self, url, params=None, json=None):
        self.calls.append(('PUT', url, json))
        return FakeResponse()

    def post(self, url, params=None, json=None):
        self.calls.append(('POST', url, json))
        return FakeResponse({'id': 'k1'})

    def delete(self, url, params=None):
        self.calls.append(('DELETE', url, None))
        return FakeResponse()

    async def close(self):
        pass


def _run_without_executing(tmp_path, files):
    async def go():
        executor = ci.JupyterCodeExecuter('http://jupyter', 'print(1)', token='t', files=files)
        await executor.session.close()
        executor.session = FakeSession()
        session = executor.session

        async def no_ws():
            pass

        executor.execute_code = no_ws
        async with executor:
            await executor.run()
        return session.calls

    return asyncio.run(go())


def test_a_run_copies_the_files_starts_the_kernel_there_and_deletes_both(tmp_path):
    (tmp_path / 'sales.csv').write_bytes(b'a,b\n1,2\n')
    calls = _run_without_executing(tmp_path, [('sales.csv', str(tmp_path / 'sales.csv'))])

    run_dir = calls[1][1].removeprefix('api/contents/')
    assert run_dir.startswith(f'{ci.UPLOADS_DIR}/')
    assert calls == [
        ('PUT', f'api/contents/{ci.UPLOADS_DIR}', {'type': 'directory'}),
        ('PUT', f'api/contents/{run_dir}', {'type': 'directory'}),
        ('PUT', f'api/contents/{run_dir}/sales.csv', {'type': 'file', 'format': 'base64', 'content': 'YSxiCjEsMgo='}),
        ('POST', 'api/kernels', {'path': run_dir}),
        ('DELETE', 'api/kernels/k1', None),
        ('DELETE', f'api/contents/{run_dir}', None),
    ]


def test_a_run_without_files_still_gets_its_own_directory(tmp_path):
    # Otherwise the kernel would start at the server root, and whatever the
    # code wrote would stay there for the next run.
    calls = _run_without_executing(tmp_path, [])

    run_dir = calls[1][1].removeprefix('api/contents/')
    assert calls == [
        ('PUT', f'api/contents/{ci.UPLOADS_DIR}', {'type': 'directory'}),
        ('PUT', f'api/contents/{run_dir}', {'type': 'directory'}),
        ('POST', 'api/kernels', {'path': run_dir}),
        ('DELETE', 'api/kernels/k1', None),
        ('DELETE', f'api/contents/{run_dir}', None),
    ]


def test_notes_are_appended_to_stderr(monkeypatch):
    class Executor:
        def __init__(self, *args):
            self.failure = ''

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def run(self):
            return ci.ResultModel(stdout='ok', stderr='warning')

    monkeypatch.setattr(ci, 'JupyterCodeExecuter', Executor)
    result = asyncio.run(ci.execute_code_jupyter('http://jupyter', 'x', notes=['big.csv: not copied']))

    assert result == {'stdout': 'ok', 'stderr': 'warning\nbig.csv: not copied', 'result': ''}


@pytest.mark.parametrize(
    ('engine', 'function_calling', 'expected', 'absent'),
    [
        ('jupyter', 'legacy', CODE_INTERPRETER_JUPYTER_PROMPT, CODE_INTERPRETER_PYODIDE_PROMPT),
        ('jupyter', 'native', CODE_INTERPRETER_JUPYTER_PROMPT, CODE_INTERPRETER_PYODIDE_PROMPT),
        ('pyodide', 'legacy', CODE_INTERPRETER_PYODIDE_PROMPT, CODE_INTERPRETER_JUPYTER_PROMPT),
        ('pyodide', 'native', CODE_INTERPRETER_PYODIDE_PROMPT, CODE_INTERPRETER_JUPYTER_PROMPT),
    ],
)
def test_the_prompt_names_the_engines_own_environment(monkeypatch, engine, function_calling, expected, absent):
    async def get(key, default=None):
        return {'code_interpreter.engine': engine, 'code_interpreter.prompt_template': ''}.get(key, default)

    monkeypatch.setattr(middleware.Config, 'get', get)
    form = {'messages': [{'role': 'system', 'content': 'base'}, {'role': 'user', 'content': 'hi'}]}
    asyncio.run(middleware._apply_code_interpreter(form, {'params': {'function_calling': function_calling}}))

    text = '\n'.join(m['content'] for m in form['messages'])
    assert expected in text
    assert absent not in text
