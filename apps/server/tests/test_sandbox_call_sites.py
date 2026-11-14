"""The sandbox engine's call sites (T20): the tag path, the Run endpoint, sub-agents, and what the tools share.

Pins, without Docker or Kata (SandboxManager on a FakeBackend):
- the `bash` tool's timeout, left out, is the admin's setting
  (`code_interpreter.sandbox.timeout`), with a cleared or invalid setting
  meaning 60;
- every sandbox call is recorded with note_code_run, as failed only when the
  sandbox itself failed, never for the model's own mistake or its command's
  exit status or timeout;
- run_code_in_sandbox, shared by the tag path and the Run endpoint, writes
  the block to /workspace/.runs/<n>.py with n counting up, runs it with
  `python` on the `data` image, and collects /workspace/outputs as `bash`
  does: linked to the message when there is one (the tag path), stored but
  linked to nothing without one (the Run endpoint), owner decision Q25;
- the FakeBackend lists /workspace/.runs as the real script does;
- the tag path runs a `<code_interpreter>` block there with its code
  unchanged, answers "not configured" under a stored `jupyter` engine, and tells the model which files were attached;
- each engine gets its own prompt on each function-calling path;
- a request with both a terminal and the sandbox engine is refused (Q24),
  and terminal events go out for terminal tools only;
- the Run endpoint needs a chat id under the sandbox engine and refuses a
  chat the user may not run code in (Q14);
- a sub-agent works in its parent chat's sandbox, with the parent's
  attachments, taking no second slot (Q6), and a background one keeps the
  code interpreter on the sandbox engine.

Run from apps/server:

    python -m pytest tests/test_sandbox_call_sites.py
"""

import asyncio
import json
import subprocess
import types
import uuid
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from local_llm.models import chats as chats_model
from local_llm.models.users import UserModel, Users
from local_llm.routers import utils as utils_router
from local_llm.sandbox import SandboxManager, SandboxSettings, runs, wrap_command
from local_llm.sandbox import outputs as sandbox_outputs
from local_llm.sandbox.fake import FakeBackend, FakeExecRequest, FakeFile, FakeRun, FakeWorkspace, interpret
from local_llm.sandbox.limits import HELPER_TIMEOUT_S, TIMEOUT_DEFAULT_S
from local_llm.sandbox.workspace import GUEST_SHELL
from local_llm.sandbox.workspaces import MemoryWorkspaces
from local_llm.tools import builtin
from local_llm.utils import middleware, misc, subagents
from local_llm.utils.auth import get_verified_user
from local_llm.utils.upstream_trace import tracing

CHAT = '11111111-1111-4111-8111-111111111111'
SUBAGENT_CHAT = '33333333-3333-4333-8333-333333333333'
MESSAGE = 'message-1'
PNG = b'\x89PNG\r\n\x1a\n' + b'\0' * 32


def _user(user_id: str = 'u1', role: str = 'user') -> UserModel:
    stamps = {'last_active_at': 0, 'updated_at': 0, 'created_at': 0}
    return UserModel(id=user_id, email=f'{user_id}@example.com', name=user_id, role=role, **stamps)


class _Chats:
    async def usable(self, chat_id, user):
        return chat_id == CHAT and user.id == 'u1'

    async def updated_at(self, chat_ids):
        return {}


async def _settings() -> SandboxSettings:
    return SandboxSettings()


async def _python(request: FakeExecRequest) -> FakeRun:
    """`python /workspace/.runs/<n>.py` as a tiny language: `save <name>` writes a PNG to /workspace/outputs,
    `fail` exits 1 with a traceback, any other line is printed. Everything else goes to the fake's bash."""
    command = request.argv[6] if request.argv[3:6] == ['/bin/bash', '-lc', '--'] else ''
    if not command.startswith('python /workspace/.runs/'):
        return await interpret(request)
    code = request.workspace.read(command.split(' ', 1)[1]).decode()
    printed = []
    for line in code.splitlines():
        if line.startswith('save '):
            request.workspace.mkdir('/workspace/outputs', parents=True) if request.workspace._get(
                '/workspace/outputs'
            ) is None else None
            request.workspace.write(f'/workspace/outputs/{line[5:]}', PNG)
        elif line == 'fail':
            return FakeRun(1, stderr=b'Traceback (most recent call last):\nValueError: no\n')
        else:
            printed.append(line)
    return FakeRun(0, ''.join(f'{line}\n' for line in printed).encode())


class _Rig:
    """A manager on a FakeBackend that runs `_python`, user u1 signed in, and outputs stored in memory."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, *, manager: bool = True, timeout: int = TIMEOUT_DEFAULT_S):
        self.backend = FakeBackend(_python)
        state = SimpleNamespace()
        if manager:
            state.sandbox = SandboxManager(
                self.backend, workspaces=MemoryWorkspaces(), chats=_Chats(), settings=_settings
            )
        self.request = SimpleNamespace(app=SimpleNamespace(state=state), state=SimpleNamespace())
        self.events: list[dict] = []
        self.stored: list[dict] = []
        self.linked: list[dict] = []

        async def get_user_by_id(user_id, db=None):
            return SimpleNamespace(id=user_id, role='user') if user_id == 'u1' else None

        async def configured_timeout() -> int:
            return timeout

        async def store(request, user, chat_id, data, name, media_type, meta, digest):
            file_id = str(uuid.uuid4())
            self.stored.append({'chat_id': chat_id, 'name': name, 'meta': meta})
            descriptor = {'type': 'file', 'id': file_id, 'url': f'/files/{file_id}', 'name': name}
            return {'file_id': file_id, 'url': descriptor['url']}, descriptor

        async def chat_usage(chat_id, user_id=None):
            self.stored.append({'usage_of': chat_id})
            return 0, {}

        async def insert_chat_files(chat_id, message_id, file_ids, user_id):
            self.linked.append({'chat_id': chat_id, 'message_id': message_id, 'file_ids': file_ids})

        monkeypatch.setattr(Users, 'get_user_by_id', get_user_by_id)
        monkeypatch.setattr(builtin, 'configured_timeout', configured_timeout)
        monkeypatch.setattr(sandbox_outputs, '_store', store)
        monkeypatch.setattr(sandbox_outputs, 'chat_usage', chat_usage)
        monkeypatch.setattr(chats_model.Chats, 'insert_chat_files', insert_chat_files)

    async def emit(self, event: dict) -> None:
        self.events.append(event)

    async def bash(self, chat_id: str = CHAT, **kwargs) -> dict:
        out = await builtin.bash(
            **kwargs, __request__=self.request, __user__={'id': 'u1'}, __chat_id__=chat_id, __event_emitter__=self.emit
        )
        return json.loads(out)

    async def run(self, code, *, chat_id: str = CHAT, message_id: str | None = MESSAGE, **kwargs) -> dict:
        return await builtin.run_code_in_sandbox(
            code,
            request=self.request,
            user={'id': 'u1'},
            chat_id=chat_id,
            message_id=message_id,
            metadata={'chat_id': chat_id, 'files': []},
            event_emitter=self.emit,
            **kwargs,
        )

    def execs(self) -> list[list[str]]:
        return [args['argv'] for name, args in self.backend.calls if name == 'exec']

    def creates(self) -> list[dict]:
        return [args for name, args in self.backend.calls if name == 'create']

    def file(self, path: str) -> bytes | None:
        entry = self.backend.sandboxes[CHAT].entry(path)
        return None if entry is None else entry.content


# --- the configured timeout ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ('stored', 'used'),
    [
        (TIMEOUT_DEFAULT_S, TIMEOUT_DEFAULT_S),
        (120, 120),
        (300, 300),
        (None, TIMEOUT_DEFAULT_S),
        (0, TIMEOUT_DEFAULT_S),
        (301, TIMEOUT_DEFAULT_S),
        ('90', TIMEOUT_DEFAULT_S),
        (True, TIMEOUT_DEFAULT_S),
    ],
)
def test_the_configured_timeout_is_the_setting_or_60_when_it_is_cleared_or_invalid(monkeypatch, stored, used):
    asked = []

    async def get(key, default=None):
        asked.append((key, default))
        return stored

    monkeypatch.setattr(builtin.Config, 'get', get)
    assert asyncio.run(builtin.configured_timeout()) == used
    assert asked == [('code_interpreter.sandbox.timeout', TIMEOUT_DEFAULT_S)]


def test_bash_without_a_timeout_uses_the_configured_one_and_an_explicit_one_wins(monkeypatch):
    rig = _Rig(monkeypatch, timeout=120)

    async def go():
        await rig.bash(command='printf a')
        await rig.bash(command='printf b', timeout_s=5)

    asyncio.run(go())
    assert rig.execs()[-2:] == [wrap_command('printf a', 120), wrap_command('printf b', 5)]


# --- note_code_run ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ('kwargs', 'failed'),
    [
        ({'command': 'printf hi'}, False),
        ({'command': 'cat missing.txt'}, False),
        ({'command': 'sleep 100', 'timeout_s': 1}, False),
        ({'command': 'printf \0'}, False),
        ({'command': 'x' * 100_001}, False),
        ({'command': 'printf hi', 'chat_id': '22222222-2222-4222-8222-222222222222'}, True),
    ],
    ids=['ok', 'exit status 1', 'timed out', 'NUL', 'too long', 'refused chat'],
)
def test_bash_records_every_call_and_fails_only_for_the_sandbox_itself(monkeypatch, kwargs, failed):
    rig = _Rig(monkeypatch)
    with tracing() as trace:
        result = asyncio.run(rig.bash(**kwargs))
    assert len(trace.code_runs_ms) == 1
    assert trace.code_run_failures == (['sandbox: SandboxRefused'] if failed else [])
    if kwargs['command'] == 'x' * 100_001:
        # The model's mistake comes back as an error it can act on, naming the way round it.
        assert 'write the script to a file with write_file' in result['error']


def test_bash_records_a_failure_when_the_server_has_no_sandbox(monkeypatch):
    rig = _Rig(monkeypatch, manager=False)
    with tracing() as trace:
        result = asyncio.run(rig.bash(command='printf hi'))
    assert result == {'error': 'The sandbox is not available on this server'}
    assert trace.code_run_failures == ['sandbox: SandboxUnavailable']


# --- the runs listing --------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ('names', 'number'),
    [
        ([], 0),
        (['1.py'], 1),
        (['1.py', '10.py', '2.py'], 10),
        (['notes.py', '0.py', '01.py', '7.py', '-3.py', '3.pyc', '1234567890.py', '999999999.py.bak'], 7),
        (['999999999.py', '5.py'], 999999999),
    ],
)
def test_the_highest_run_ignores_names_that_are_not_plain_numbers(names, number):
    assert runs.highest(names) == number


def _fake_runs(files: dict[str, FakeFile]) -> FakeRun:
    request = FakeExecRequest(CHAT, runs.list_argv(), HELPER_TIMEOUT_S, None, FakeWorkspace(files))
    return asyncio.run(interpret(request))


def _d(mode: int = 0o755) -> FakeFile:
    return FakeFile(content=None, uid=1000, mode=mode)


def _f(data: bytes = b'x') -> FakeFile:
    return FakeFile(content=data, uid=1000, mode=0o644)


def test_the_fake_lists_runs_as_the_real_script_does(tmp_path):
    tree = {'.runs': _d(), '.runs/2.py': _f(), '.runs/10.py': _f(), '.runs/a.txt': _f(), '.runs/.12.py': _f()}
    tree.update({'.runs/11.py': _d(), '.runs/012.py': _f(), '.runs/1234567890.py': _f(), '.runs/x\n13.py': _f()})
    fake = _fake_runs({'/workspace': _d(), **{f'/workspace/{k}': v for k, v in tree.items()}})
    root = tmp_path / '.runs'
    root.mkdir()
    for name, entry in tree.items():
        if name != '.runs':
            path = tmp_path / name
            path.mkdir() if entry.content is None else path.write_bytes(entry.content)
    real = subprocess.run(
        [*GUEST_SHELL, '-c', runs.LIST_SCRIPT.replace(runs.RUNS_DIR, str(root)), 'x'], capture_output=True
    )
    assert (fake.returncode, fake.stdout, fake.stderr) == (real.returncode, real.stdout, real.stderr)
    # A directory named like a run counts too: its name is taken, so the next run must pass it.
    assert fake.stdout == b'11\n'


def test_the_runs_listing_prints_one_number_however_many_runs_there_are():
    files = {'/workspace': _d(), '/workspace/.runs': _d()}
    files.update({f'/workspace/.runs/{n}.py': _f() for n in range(1, 5001)})
    assert _fake_runs(files).stdout == b'5000\n'


@pytest.mark.parametrize('kind', ['missing', 'file', 'symlink'])
def test_the_runs_listing_is_zero_without_a_real_runs_directory(tmp_path, kind):
    files = {'/workspace': _d(), '/workspace/real': _d(), '/workspace/real/5.py': _f()}
    root = tmp_path / '.runs'
    (tmp_path / 'real').mkdir()
    (tmp_path / 'real' / '5.py').write_bytes(b'x')
    if kind == 'file':
        files['/workspace/.runs'] = _f()
        root.write_bytes(b'x')
    elif kind == 'symlink':
        files['/workspace/.runs'] = FakeFile(content=None, uid=1000, mode=0o777, link='real')
        root.symlink_to(tmp_path / 'real')
    fake = _fake_runs(files)
    real = subprocess.run(
        [*GUEST_SHELL, '-c', runs.LIST_SCRIPT.replace(runs.RUNS_DIR, str(root)), 'x'], capture_output=True
    )
    expected = (0, b'0\n', b'')
    assert (fake.returncode, fake.stdout, fake.stderr) == (real.returncode, real.stdout, real.stderr) == expected


# --- run_code_in_sandbox -------------------------------------------------------------------------------------------


def test_each_block_is_written_to_the_next_run_file_and_run_with_python(monkeypatch):
    rig = _Rig(monkeypatch, timeout=90)

    async def go():
        return await rig.run('hello'), await rig.run('again')

    first, second = asyncio.run(go())
    assert (first['stdout'], first['path'], first['returncode']) == ('hello\n', '/workspace/.runs/1.py', 0)
    assert (second['stdout'], second['path']) == ('again\n', '/workspace/.runs/2.py')
    assert (first['result'], first['outputs'], first['files'], first['timed_out']) == ('', [], [], False)
    assert rig.file('/workspace/.runs/1.py') == b'hello'
    assert rig.file('/workspace/.runs/2.py') == b'again'
    assert wrap_command('python /workspace/.runs/2.py', 90) in rig.execs()
    assert [create['spec'].image for create in rig.creates()] == ['data']


def test_a_run_counts_on_from_the_runs_already_in_the_workspace(monkeypatch):
    rig = _Rig(monkeypatch)

    async def go():
        await rig.bash(command='mkdir .runs')
        await rig.bash(command='printf x > .runs/7.py')
        await rig.bash(command='printf x > .runs/notes.py')
        return await rig.run('next')

    assert asyncio.run(go())['path'] == '/workspace/.runs/8.py'


def test_a_run_switches_a_web_sandbox_to_the_data_image_keeping_its_files(monkeypatch):
    rig = _Rig(monkeypatch)

    async def go():
        await rig.bash(command='printf kept > keep.txt', image='web')
        return await rig.run('ok')

    assert asyncio.run(go())['stdout'] == 'ok\n'
    assert [create['spec'].image for create in rig.creates()] == ['web', 'data']
    assert rig.file('/workspace/keep.txt') == b'kept'


def test_a_failing_block_is_its_result_not_a_sandbox_failure(monkeypatch):
    rig = _Rig(monkeypatch)
    with tracing() as trace:
        run = asyncio.run(rig.run('fail'))
    assert (run['returncode'], run['stdout']) == (1, '')
    assert 'ValueError: no' in run['stderr']
    assert len(trace.code_runs_ms) == 1 and trace.code_run_failures == []


def test_a_run_reports_the_sandbox_failing_as_an_error_and_records_it(monkeypatch):
    rig = _Rig(monkeypatch, manager=False)
    with tracing() as trace:
        run = asyncio.run(rig.run('hello'))
    assert run == {'error': 'The sandbox is not available on this server'}
    assert trace.code_run_failures == ['sandbox: SandboxUnavailable']


def test_code_that_is_not_text_starts_no_sandbox(monkeypatch):
    rig = _Rig(monkeypatch)
    with tracing() as trace:
        run = asyncio.run(rig.run(b'print(1)'))
    assert run == {'error': 'the code must be text, not bytes'}
    assert rig.backend.calls == []
    assert trace.code_run_failures == []


def test_a_run_with_a_message_attaches_its_outputs_to_it_and_sends_the_files_event(monkeypatch):
    rig = _Rig(monkeypatch)
    run = asyncio.run(rig.run('save fig.png\ndone'))
    assert [item['path'] for item in run['outputs']] == ['outputs/fig.png']
    assert [entry['name'] for entry in run['files']] == ['fig.png']
    assert [link['message_id'] for link in rig.linked] == [MESSAGE]
    assert [event['type'] for event in rig.events] == ['files']
    assert [entry['chat_id'] for entry in rig.stored if 'name' in entry] == [CHAT]


def test_a_run_without_a_message_stores_its_outputs_but_links_nothing_and_sends_no_event(monkeypatch):
    rig = _Rig(monkeypatch)
    run = asyncio.run(rig.run('save fig.png', message_id=None))
    assert [entry['name'] for entry in run['files']] == ['fig.png']
    assert rig.linked == [] and rig.events == []
    # Counted in the chat's cap all the same.
    assert {'usage_of': CHAT} in rig.stored


def test_a_bash_call_after_a_run_does_not_attach_the_runs_outputs_again(monkeypatch):
    rig = _Rig(monkeypatch)

    async def go():
        await rig.run('save fig.png', message_id=None)
        return await rig.bash(command='printf hi')

    assert asyncio.run(go())['outputs'] == []


def test_a_run_in_a_benchmark_lists_its_outputs_but_stores_none(monkeypatch):
    rig = _Rig(monkeypatch)
    rig.request.state.benchmark_harness = True
    run = asyncio.run(rig.run('save fig.png'))
    assert [item['path'] for item in run['outputs']] == ['outputs/fig.png']
    assert run['files'] == [] and rig.stored == [] and rig.linked == []


def test_a_run_without_sync_leaves_the_uploads_alone(monkeypatch):
    rig = _Rig(monkeypatch)
    synced = []

    async def sync_uploads(session, items, account, owner):
        synced.append(items)
        return []

    monkeypatch.setattr(builtin, 'sync_uploads', sync_uploads)

    async def go():
        await rig.run('one')
        await rig.run('two', sync=False)

    asyncio.run(go())
    assert synced == [[]]


# --- the tag path ------------------------------------------------------------------------------------------------


def test_the_outputs_note_names_what_was_attached_what_was_not_and_a_timeout():
    outputs = [
        {'path': 'outputs/a.png', 'file_id': 'f1'},
        {'path': 'outputs/b.csv', 'file_id': 'f2'},
        {'path': 'outputs/c.bin', 'reason': 'too big'},
        {'path': 'outputs/d.txt'},
    ]
    assert middleware.sandbox_outputs_note(outputs, timed_out=True) == (
        '\n[The code was stopped at its time limit.]'
        '\n[Attached to the reply: outputs/a.png, outputs/b.csv]'
        '\n[New in /workspace/outputs, not attached: outputs/d.txt]'
        '\n[Not attached: outputs/c.bin (too big)]'
    )
    assert middleware.sandbox_outputs_note([]) == ''


def _reply(monkeypatch, engine: str, run: dict | None = None):
    calls = []

    async def get(key, default=None):
        return {'code_interpreter.engine': engine}.get(key, default)

    async def run_code_in_sandbox(code, **kwargs):
        calls.append({'code': code, **kwargs})
        return run

    monkeypatch.setattr(middleware.Config, 'get', get)
    monkeypatch.setattr(builtin, 'run_code_in_sandbox', run_code_in_sandbox)
    reply = object.__new__(middleware._StreamingReply)
    reply.request = SimpleNamespace()
    reply.user = _user()
    reply.metadata = {'chat_id': CHAT, 'message_id': MESSAGE, 'files': []}

    async def emit(event):
        pass

    reply.event_emitter = emit
    reply._execute_code_in_sandbox = types.MethodType(middleware._StreamingReply._execute_code_in_sandbox, reply)
    return reply, calls


def test_the_tag_path_runs_a_block_in_the_sandbox_with_its_code_unchanged(monkeypatch):
    run = {
        'stdout': 'hi\n',
        'stderr': 'warning\n',
        'result': '',
        'timed_out': False,
        'outputs': [{'path': 'outputs/fig.png', 'file_id': 'f1'}],
    }
    reply, calls = _reply(monkeypatch, 'sandbox', run)
    out = asyncio.run(middleware._StreamingReply._execute_code(reply, {'code': 'print("hi")'}))
    # The model is shown stdout only (utils/misc.py), so stderr and the outputs note are put there.
    stdout = 'hi\n\n[stderr]\nwarning\n\n[Attached to the reply: outputs/fig.png]'
    assert out == {'stdout': stdout, 'stderr': '', 'result': ''}
    item = {'type': 'open_webui:code_interpreter', 'code': 'print("hi")', 'output': out}
    assert (
        misc._code_interpreter_contents(item)[1] == f'<code_interpreter_output>\n{stdout}\n</code_interpreter_output>'
    )
    (call,) = calls
    assert call['code'] == 'print("hi")'
    assert (call['chat_id'], call['message_id'], call['what']) == (CHAT, MESSAGE, 'the code block')
    assert call['user']['id'] == 'u1' and call['event_emitter'] is reply.event_emitter


def test_the_tag_path_shows_the_model_a_sandbox_failure(monkeypatch):
    reply, _ = _reply(monkeypatch, 'sandbox', {'error': 'The sandbox is not available on this server'})
    out = asyncio.run(middleware._StreamingReply._execute_code(reply, {'code': 'print(1)'}))
    assert out == {'stdout': 'The sandbox is not available on this server', 'stderr': '', 'result': ''}


def test_execute_code_itself_answers_not_configured_for_a_stored_jupyter_engine_and_runs_nothing(monkeypatch):
    # Detection no longer lets a block reach this function under such an engine; it stays the inert last resort.
    reply, calls = _reply(monkeypatch, 'jupyter')
    out = asyncio.run(middleware._StreamingReply._execute_code(reply, {'code': 'print(1)'}))
    assert out['stdout'] == 'Code interpreter engine not configured.'
    assert calls == []


def _detects(monkeypatch, engine) -> bool:
    """Whether the tag path detects code blocks, with every authorization gate open and the engine as given."""

    async def get(key, default=None):
        return {'code_interpreter.enable': True, 'code_interpreter.engine': engine}.get(key, default)

    monkeypatch.setattr(middleware.Config, 'get', get)
    reply = object.__new__(middleware._StreamingReply)
    reply.user = SimpleNamespace(id='u1', role='admin')
    reply.model = {'id': 'm', 'info': {'meta': {}}}
    reply.metadata = {'params': {'function_calling': 'legacy'}, 'features': {'code_interpreter': True}}
    return asyncio.run(middleware._StreamingReply._detect_code_interpreter(reply))


@pytest.mark.parametrize(
    ('engine', 'detected'), [('sandbox', True), ('pyodide', False), ('jupyter', False), ('cloud', False)]
)
def test_the_tag_path_detects_code_blocks_only_under_a_live_engine(monkeypatch, engine, detected):
    assert _detects(monkeypatch, engine) is detected


def test_the_tag_path_adds_no_stderr_section_when_there_is_none(monkeypatch):
    run = {'stdout': 'ok\n', 'stderr': '', 'result': '', 'timed_out': False, 'outputs': []}
    reply, _ = _reply(monkeypatch, 'sandbox', run)
    out = asyncio.run(middleware._StreamingReply._execute_code(reply, {'code': 'print(1)'}))
    assert out == {'stdout': 'ok\n', 'stderr': '', 'result': ''}


@pytest.mark.parametrize(
    ('legacy', 'expected', 'other'),
    [
        (True, 'CODE_INTERPRETER_SANDBOX_TAG_PROMPT', 'CODE_INTERPRETER_SANDBOX_PROMPT'),
        (False, 'CODE_INTERPRETER_SANDBOX_PROMPT', 'CODE_INTERPRETER_SANDBOX_TAG_PROMPT'),
    ],
)
def test_the_sandbox_gets_its_tag_or_tool_prompt_on_each_path(monkeypatch, legacy, expected, other):
    async def get(key, default=None):
        return {'code_interpreter.engine': 'sandbox', 'code_interpreter.prompt_template': ''}.get(key, default)

    monkeypatch.setattr(middleware.Config, 'get', get)
    form = {'messages': [{'role': 'system', 'content': 'sys'}, {'role': 'user', 'content': 'hi'}]}
    metadata = {'params': {'function_calling': 'legacy'}} if legacy else {}
    asyncio.run(middleware._apply_code_interpreter(form, metadata))
    added = form['messages'][-1 if legacy else 0]['content']
    assert added.endswith(getattr(middleware, expected))
    assert getattr(middleware, other) not in added


@pytest.mark.parametrize('legacy', [True, False])
@pytest.mark.parametrize('engine', ['pyodide', 'jupyter', 'cloud'])
def test_a_non_live_engine_gets_no_code_interpreter_prompt(monkeypatch, engine, legacy):
    async def get(key, default=None):
        return {'code_interpreter.engine': engine, 'code_interpreter.prompt_template': ''}.get(key, default)

    monkeypatch.setattr(middleware.Config, 'get', get)
    messages = [{'role': 'system', 'content': 'sys'}, {'role': 'user', 'content': 'hi'}]
    form = {'messages': [dict(m) for m in messages]}
    metadata = {'params': {'function_calling': 'legacy'}} if legacy else {}
    asyncio.run(middleware._apply_code_interpreter(form, metadata))
    assert form['messages'] == messages


def test_the_tag_prompt_speaks_of_code_blocks_and_the_tool_prompt_of_tools():
    assert '`bash`' not in middleware.CODE_INTERPRETER_SANDBOX_TAG_PROMPT
    assert '/workspace/.runs/<n>.py' in middleware.CODE_INTERPRETER_SANDBOX_TAG_PROMPT
    assert '`bash`' in middleware.CODE_INTERPRETER_SANDBOX_PROMPT


# --- a terminal and the sandbox (Q24) --------------------------------------------------------------------------


def _config(monkeypatch, **values):
    stored = {'code_interpreter.enable': True, 'code_interpreter.engine': 'sandbox', **values}

    async def get(key, default=None):
        return stored.get(key, default)

    monkeypatch.setattr(middleware.Config, 'get', get)


@pytest.mark.parametrize(
    ('terminal_id', 'features', 'meta', 'config', 'refused'),
    [
        ('t1', {'code_interpreter': True}, {}, {}, True),
        (None, {'code_interpreter': True}, {}, {}, False),
        ('t1', {}, {}, {}, False),
        ('t1', {'code_interpreter': True}, {'capabilities': {'terminal': False}}, {}, False),
        ('t1', {'code_interpreter': True}, {'capabilities': {'code_interpreter': False}}, {}, False),
        ('t1', {'code_interpreter': True}, {'builtinTools': {'code_interpreter': False}}, {}, False),
        ('t1', {'code_interpreter': True}, {}, {'code_interpreter.enable': False}, False),
        ('t1', {'code_interpreter': True}, {}, {'code_interpreter.engine': 'pyodide'}, False),
        ('t1', {'code_interpreter': True}, {'capabilities': {'builtin_tools': False}}, {}, False),
        ('t1', {'code_interpreter': True}, {}, {'no session': True}, False),
        ('t1', {'code_interpreter': True}, {'capabilities': {'builtin_tools': False}}, {'legacy': True}, True),
        ('t1', {'code_interpreter': True}, {}, {'no session': True, 'legacy': True}, True),
    ],
    ids=[
        'both',
        'no terminal',
        'no code interpreter',
        'model without terminal',
        'model without code',
        'tool off',
        'code interpreter off',
        'another engine',
        'native without builtin tools',
        'native without a session',
        'tag path without builtin tools',
        'tag path without a session',
    ],  # fmt: skip
)
def test_a_request_with_a_terminal_and_the_sandbox_is_refused(
    monkeypatch, terminal_id, features, meta, config, refused
):
    metadata = {} if config.pop('no session', False) else {'session_id': 's1'}
    if config.pop('legacy', False):
        metadata['params'] = {'function_calling': 'legacy'}
    _config(monkeypatch, **config)
    call = middleware._refuse_terminal_with_sandbox(
        _user(role='admin'), {'info': {'meta': meta}}, metadata, terminal_id, features
    )
    if refused:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(call)
        assert (exc.value.status_code, exc.value.detail) == (400, middleware.TERMINAL_WITH_SANDBOX)
    else:
        assert asyncio.run(call) is None


def test_a_user_without_the_code_interpreter_permission_is_not_refused(monkeypatch):
    _config(monkeypatch)

    async def may_use(user, feature):
        assert feature == 'code_interpreter'
        return False

    monkeypatch.setattr(middleware, '_may_use_feature', may_use)
    model, metadata = {'info': {'meta': {}}}, {'session_id': 's1'}
    call = middleware._refuse_terminal_with_sandbox(_user(), model, metadata, 't1', {'code_interpreter': True})
    assert asyncio.run(call) is None


@pytest.mark.parametrize(('tool_type', 'sent'), [('terminal', True), ('builtin', False), ('', False)])
def test_terminal_events_go_out_for_terminal_tools_only(tool_type, sent):
    events = []

    async def emit(event):
        events.append(event)

    asyncio.run(middleware.terminal_event_handler('write_file', {'path': 'a.txt'}, '{}', emit, tool_type=tool_type))
    assert events == ([{'type': 'terminal:write_file', 'data': {'path': 'a.txt'}}] if sent else [])


# --- the Run endpoint --------------------------------------------------------------------------------------------


@pytest.fixture
def endpoint(monkeypatch):
    world = {'user': _user(), 'engine': 'sandbox', 'enable': True, 'chats': {}, 'runs': [], 'may': True, 'asked': []}

    async def get(key, default=None):
        return {
            'code_execution.enable': world['enable'],
            'code_execution.engine': world['engine'],
            'user.permissions': world.get('permissions'),
            'code_interpreter.enable': world.get('interpreter', True),
        }.get(key, default)

    async def get_chat_by_id(chat_id, db=None):
        return world['chats'].get(chat_id)

    async def run_code_in_sandbox(code, **kwargs):
        world['runs'].append({'code': code, **kwargs})
        return {'stdout': 'ran\n', 'stderr': '', 'result': '', 'outputs': [], 'files': []}

    async def has_permission(user_id, key, permissions):
        world['asked'].append((user_id, key))
        return world['may']

    monkeypatch.setattr(utils_router.Config, 'get', get)
    monkeypatch.setattr(utils_router, 'has_permission', has_permission)
    monkeypatch.setattr(chats_model.Chats, 'get_chat_by_id', get_chat_by_id)
    monkeypatch.setattr(builtin, 'run_code_in_sandbox', run_code_in_sandbox)
    app = FastAPI()
    app.include_router(utils_router.router)
    app.dependency_overrides[get_verified_user] = lambda: world['user']
    world['client'] = TestClient(app)
    return world


def test_the_run_endpoint_needs_a_chat_under_the_sandbox_engine(endpoint):
    response = endpoint['client'].post('/code/execute', json={'code': 'print(1)'})
    assert response.status_code == 400
    assert 'chat_id' in response.json()['detail']
    assert endpoint['runs'] == []


@pytest.mark.parametrize('engine', ['jupyter', 'pyodide', None, '', 'other'])
def test_the_run_endpoint_answers_400_under_any_engine_but_the_sandbox(endpoint, engine):
    endpoint['engine'] = engine
    endpoint['chats'][CHAT] = SimpleNamespace(id=CHAT, user_id='u1')
    response = endpoint['client'].post('/code/execute', json={'code': 'print(1)', 'chat_id': CHAT})
    assert response.status_code == 400
    assert 'engine not supported' in response.json()['detail']
    assert endpoint['runs'] == []


def test_the_run_endpoint_runs_in_the_owners_chat_without_a_message_or_an_upload_sync(endpoint):
    endpoint['chats'][CHAT] = SimpleNamespace(id=CHAT, user_id='u1')
    response = endpoint['client'].post('/code/execute', json={'code': 'print(1)', 'chat_id': CHAT})
    assert response.status_code == 200
    assert response.json()['stdout'] == 'ran\n'
    (run,) = endpoint['runs']
    assert (run['code'], run['chat_id'], run['message_id'], run['sync']) == ('print(1)', CHAT, None, False)
    assert run['user']['id'] == 'u1' and run['metadata'] == {'chat_id': CHAT}


@pytest.mark.parametrize(
    ('owner', 'role', 'admin_access', 'allowed'),
    [
        (None, 'user', True, False),
        ('someone-else', 'user', True, False),
        ('someone-else', 'admin', False, False),
        ('someone-else', 'admin', True, True),
    ],
    ids=['no such chat', "another user's", 'admin, access off', 'admin, access on'],
)
def test_the_run_endpoint_refuses_a_chat_the_user_may_not_run_code_in(
    monkeypatch, endpoint, owner, role, admin_access, allowed
):
    monkeypatch.setattr(chats_model, 'ENABLE_ADMIN_CHAT_ACCESS', admin_access)
    endpoint['user'] = _user('u1', role)
    if owner is not None:
        endpoint['chats'][CHAT] = SimpleNamespace(id=CHAT, user_id=owner)
    response = endpoint['client'].post('/code/execute', json={'code': 'print(1)', 'chat_id': CHAT})
    assert response.status_code == (200 if allowed else 404)
    assert len(endpoint['runs']) == (1 if allowed else 0)


def test_the_run_endpoint_refuses_a_user_without_the_code_interpreter_permission(endpoint):
    # Q26: under the sandbox engine the Run button reaches the chat's persistent workspace.
    endpoint['may'] = False
    endpoint['chats'][CHAT] = SimpleNamespace(id=CHAT, user_id='u1')
    response = endpoint['client'].post('/code/execute', json={'code': 'print(1)', 'chat_id': CHAT})
    assert response.status_code == 403
    assert endpoint['asked'] == [('u1', 'features.code_interpreter')]
    assert endpoint['runs'] == []


@pytest.mark.parametrize(('group_grants', 'allowed'), [(True, True), (False, False)], ids=['a group grants', 'none'])
def test_the_run_endpoint_asks_the_real_permission_rule(monkeypatch, endpoint, group_grants, allowed):
    # Through access_control.has_permission itself: the defaults deny, so only a group can grant.
    from local_llm.utils import access_control

    async def groups(user_id, db=None):
        grant = {'features': {'code_interpreter': True}}
        return [SimpleNamespace(permissions=grant)] if group_grants else []

    monkeypatch.setattr(utils_router, 'has_permission', access_control.has_permission)
    monkeypatch.setattr(access_control.Groups, 'get_groups_by_member_id', groups)
    endpoint['permissions'] = {'features': {'code_interpreter': False}}
    endpoint['chats'][CHAT] = SimpleNamespace(id=CHAT, user_id='u1')
    response = endpoint['client'].post('/code/execute', json={'code': 'x', 'chat_id': CHAT})
    assert response.status_code == (200 if allowed else 403)
    assert len(endpoint['runs']) == (1 if allowed else 0)


@pytest.mark.parametrize('role', ['user', 'admin'])
def test_the_run_endpoint_refuses_everyone_while_the_code_interpreter_is_switched_off(endpoint, role):
    # Q29: the global switch counts too, for admins as well, as it does on every other path into the workspace.
    endpoint['interpreter'] = False
    endpoint['user'] = _user('u1', role)
    endpoint['chats'][CHAT] = SimpleNamespace(id=CHAT, user_id='u1')
    response = endpoint['client'].post('/code/execute', json={'code': 'x', 'chat_id': CHAT})
    assert response.status_code == 403
    assert endpoint['runs'] == []


def test_the_run_endpoint_lets_an_admin_run_without_asking_for_the_permission(endpoint):
    endpoint['may'] = False
    endpoint['user'] = _user('a1', 'admin')
    endpoint['chats'][CHAT] = SimpleNamespace(id=CHAT, user_id='a1')
    response = endpoint['client'].post('/code/execute', json={'code': 'print(1)', 'chat_id': CHAT})
    assert response.status_code == 200
    assert endpoint['asked'] == [] and len(endpoint['runs']) == 1


def test_the_run_endpoint_asks_for_the_permission_only_under_the_sandbox_engine(endpoint):
    endpoint['may'] = False
    endpoint['engine'] = 'pyodide'
    assert endpoint['client'].post('/code/execute', json={'code': 'x', 'chat_id': CHAT}).status_code == 400
    assert endpoint['asked'] == []


def test_the_run_endpoint_runs_an_unsaved_chat_in_the_users_own_sandbox(endpoint):
    response = endpoint['client'].post('/code/execute', json={'code': 'x', 'chat_id': 'local:abc'})
    assert response.status_code == 200
    assert endpoint['runs'][0]['chat_id'] == 'local:abc'


def test_the_run_endpoint_returns_a_sandbox_error_as_it_is(monkeypatch, endpoint):
    async def failing(code, **kwargs):
        return {'error': 'The sandbox is not available on this server'}

    monkeypatch.setattr(builtin, 'run_code_in_sandbox', failing)
    endpoint['chats'][CHAT] = SimpleNamespace(id=CHAT, user_id='u1')
    response = endpoint['client'].post('/code/execute', json={'code': 'x', 'chat_id': CHAT})
    assert (response.status_code, response.json()) == (200, {'error': 'The sandbox is not available on this server'})


def test_the_run_endpoint_keeps_its_other_answers(endpoint):
    endpoint['engine'] = 'pyodide'
    assert endpoint['client'].post('/code/execute', json={'code': 'x', 'chat_id': CHAT}).status_code == 400
    endpoint['enable'] = False
    assert endpoint['client'].post('/code/execute', json={'code': 'x'}).status_code == 403
    assert endpoint['runs'] == []


# --- sub-agents (Q6) ---------------------------------------------------------------------------------------------


def test_the_sandbox_chat_is_the_parent_chat_for_a_sub_agents_request():
    assert builtin.sandbox_chat(None, CHAT) == CHAT
    assert builtin.sandbox_chat(SimpleNamespace(state=SimpleNamespace()), CHAT) == CHAT
    sub = SimpleNamespace(state=SimpleNamespace(sandbox_chat_id=CHAT))
    assert builtin.sandbox_chat(sub, SUBAGENT_CHAT) == CHAT
    assert builtin.shares_parent_sandbox(sub) is True
    assert builtin.shares_parent_sandbox(None) is False
    # Only a non-empty str set by the server counts.
    for odd in (5, '', None):
        request = SimpleNamespace(state=SimpleNamespace(sandbox_chat_id=odd))
        assert builtin.sandbox_chat(request, CHAT) == CHAT
        assert builtin.shares_parent_sandbox(request) is False


def test_a_sub_agent_sees_the_parents_files_and_takes_no_second_sandbox(monkeypatch):
    rig = _Rig(monkeypatch)
    sub_request = SimpleNamespace(app=rig.request.app, state=SimpleNamespace(sandbox_chat_id=CHAT))

    async def go():
        await rig.bash(command='printf parent > shared.txt')
        out = await builtin.bash(
            command='cat shared.txt',
            __request__=sub_request,
            __user__={'id': 'u1'},
            __chat_id__=SUBAGENT_CHAT,
            __message_id__='sub-message',
        )
        return json.loads(out)

    result = asyncio.run(go())
    assert result['stdout'] == 'parent'
    assert len(rig.creates()) == 1
    assert {args['chat_id'] for name, args in rig.backend.calls if name == 'exec'} == {CHAT}


def test_a_sub_agents_outputs_attach_to_its_message_and_count_against_the_parent_chat(monkeypatch):
    rig = _Rig(monkeypatch)
    rig.request.state = SimpleNamespace(sandbox_chat_id=CHAT)

    async def go():
        await rig.bash(command='mkdir outputs')
        out = await builtin.bash(
            command='printf x > outputs/sub.txt',
            __request__=rig.request,
            __user__={'id': 'u1'},
            __chat_id__=SUBAGENT_CHAT,
            __message_id__='sub-message',
            __event_emitter__=rig.emit,
        )
        return json.loads(out)

    asyncio.run(go())
    assert rig.linked == [
        {'chat_id': SUBAGENT_CHAT, 'message_id': 'sub-message', 'file_ids': rig.linked[0]['file_ids']}
    ]
    assert [entry['chat_id'] for entry in rig.stored if 'name' in entry] == [CHAT]
    assert {'usage_of': CHAT} in rig.stored


def test_a_sub_agents_request_carries_the_parent_chat():
    child = SimpleNamespace(state=SimpleNamespace())
    subagents._share_parent_sandbox(child, SimpleNamespace(state=SimpleNamespace()), CHAT)
    assert child.state.sandbox_chat_id == CHAT
    # A sub-agent of a sub-agent keeps the outermost chat's sandbox.
    grandchild = SimpleNamespace(state=SimpleNamespace())
    subagents._share_parent_sandbox(grandchild, child, SUBAGENT_CHAT)
    assert grandchild.state.sandbox_chat_id == CHAT
    bare = SimpleNamespace(state=SimpleNamespace())
    subagents._share_parent_sandbox(bare, SimpleNamespace(), CHAT)
    assert bare.state.sandbox_chat_id == CHAT


def test_a_request_sharing_the_parents_sandbox_never_syncs_its_uploads(monkeypatch):
    rig = _Rig(monkeypatch)
    synced = []

    async def sync_uploads(session, items, account, owner):
        synced.append(items)
        return []

    monkeypatch.setattr(builtin, 'sync_uploads', sync_uploads)
    sub_request = SimpleNamespace(app=rig.request.app, state=SimpleNamespace(sandbox_chat_id=CHAT))

    async def go():
        # The parent's own call syncs its files; the sub-agent's, carrying a stale or partial list, does not.
        await builtin.bash(
            command='printf hi', __request__=rig.request, __user__={'id': 'u1'}, __metadata__=_meta(['a', 'b'])
        )
        for tool, kwargs in ((builtin.bash, {'command': 'printf hi'}), (builtin.view, {'path': '.'})):
            await tool(**kwargs, __request__=sub_request, __user__={'id': 'u1'}, __metadata__=_meta(['a']))

    asyncio.run(go())
    assert synced == [[{'id': 'a'}, {'id': 'b'}]]


def _meta(file_ids: list[str]) -> dict:
    return {'chat_id': CHAT, 'files': [{'id': file_id} for file_id in file_ids]}


def test_a_sub_agents_completion_runs_on_a_request_sharing_the_parents_sandbox(monkeypatch):
    seen = []

    async def handler(request, form_data, user=None):
        seen.append(request.state)

    async def get_message(chat_id, message_id):
        return {'content': 'done'}

    async def release():
        return None

    monkeypatch.setattr(subagents.Chats, 'get_message_by_id_and_message_id', get_message)
    monkeypatch.setattr(
        subagents, '_build_request', lambda source, user_id, internal: SimpleNamespace(state=SimpleNamespace())
    )
    agent = object.__new__(subagents._SubagentRun)
    agent.request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(CHAT_COMPLETION_HANDLER=handler)),
        state=SimpleNamespace(),
    )
    agent.user = SimpleNamespace(id='u1')
    agent.chat_id, agent.assistant_message_id, agent.parent_chat_id = SUBAGENT_CHAT, 'm1', CHAT
    agent.max_iterations, agent.max_output = None, None
    agent._completion_form = lambda: {}
    agent.release = release
    asyncio.run(agent.run_reserved())
    (state,) = seen
    assert state.sandbox_chat_id == CHAT


@pytest.mark.parametrize(('engine', 'kept'), [('sandbox', True), ('jupyter', False), ('pyodide', False)])
def test_a_background_sub_agent_keeps_the_code_interpreter_only_on_the_sandbox_engine(monkeypatch, engine, kept):
    async def get(key, default=None):
        return engine if key == 'code_interpreter.engine' else default

    monkeypatch.setattr(subagents.Config, 'get', get)
    run = asyncio.run(subagents._run_settings({'features': {'code_interpreter': True}}, background=True))
    assert ('code_interpreter' in run['features']) is kept
    foreground = asyncio.run(subagents._run_settings({'features': {'code_interpreter': True}}, background=False))
    assert foreground['features'] == {'code_interpreter': True}


def test_a_run_whose_file_cannot_be_written_is_the_models_error_and_loses_no_outputs(monkeypatch):
    rig = _Rig(monkeypatch)

    async def go():
        await rig.bash(command='printf x > .runs')
        await rig.bash(command='mkdir outputs')
        await builtin.write_file(
            path='outputs/note.txt', content='n', __request__=rig.request, __user__={'id': 'u1'}, __chat_id__=CHAT
        )
        failed = await rig.run('hello')
        after = await rig.bash(command='printf hi')
        return failed, after

    with tracing() as trace:
        failed, after = asyncio.run(go())
    assert 'error' in failed
    assert trace.code_run_failures == []
    # The listing from before the failed run was put back, so the next bash call still attaches the note.
    assert [item['path'] for item in after['outputs']] == ['outputs/note.txt']


@pytest.mark.parametrize('tool', ['view', 'write_file', 'str_replace'])
def test_the_file_tools_record_the_sandboxs_failures_but_not_the_models_mistakes(monkeypatch, tool):
    kwargs = {'view': {'path': '.'}, 'write_file': {'path': 'a.txt', 'content': 'x'}}.get(
        tool, {'path': 'a.txt', 'old_str': 'x', 'new_str': 'y'}
    )
    down = _Rig(monkeypatch, manager=False)
    with tracing() as trace:
        asyncio.run(getattr(builtin, tool)(**kwargs, __request__=down.request, __user__={'id': 'u1'}, __chat_id__=CHAT))
    assert trace.code_run_failures == ['sandbox: SandboxUnavailable']
    rig = _Rig(monkeypatch)
    with tracing() as trace:
        out = asyncio.run(
            getattr(builtin, tool)(
                path='../etc/passwd',
                **{k: v for k, v in kwargs.items() if k != 'path'},
                __request__=rig.request,
                __user__={'id': 'u1'},
                __chat_id__=CHAT,
            )  # fmt: skip
        )
    assert 'error' in json.loads(out)
    assert trace.code_run_failures == [] and trace.code_runs_ms == []
