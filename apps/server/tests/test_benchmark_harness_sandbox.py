"""A benchmark's sandbox calls always run on the `data` image (tools/builtin.py's _sandbox_session).

The harness spec (benchmarks/evaluation/harness.py) names the `data` image's
digest, so a harness request must never reach another image, whatever the
model passes. These run the real tools on a SandboxManager over a FakeBackend,
and record the image each session was opened with.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from local_llm.benchmarks.evaluation import harness
from local_llm.models.users import Users
from local_llm.sandbox import SandboxError, SandboxManager, SandboxSettings
from local_llm.sandbox.fake import FakeBackend
from local_llm.sandbox.limits import TIMEOUT_DEFAULT_S
from local_llm.sandbox.workspaces import MemoryWorkspaces
from local_llm.tools import builtin
from local_llm.utils import upstream_trace

CHAT = '11111111-1111-4111-8111-111111111111'
PORT = 8090
LOCAL = f'http://127.0.0.1:{PORT}/v1/chat/completions'
HCTX = {'model_entry': 'coder', 'base_model': 'qwen25c', 'port': PORT, 'timeout': 30, 'max_tokens': 2048}


class _Chats:
    async def usable(self, chat_id, user):
        return chat_id == CHAT and user.id == 'u1'

    async def updated_at(self, chat_ids):
        return {}


async def _settings() -> SandboxSettings:
    return SandboxSettings()


class _Rig:
    """A manager on a FakeBackend, user u1 signed in, and the image of every session it opened."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, *, harness: bool | None) -> None:
        backend = FakeBackend()
        # What ready() learns from a real backend; the harness spec names the `data` digest.
        backend.image_ids = {'data': 'sha256:data-1', 'web': 'sha256:web-1'}
        self.manager = manager = SandboxManager(
            backend, workspaces=MemoryWorkspaces(), chats=_Chats(), settings=_settings
        )
        self.images: list[str | None] = []
        opened = manager.session

        def session(chat, account, *, image=None, on_wait=None):
            self.images.append(image)
            return opened(chat, account, image=image, on_wait=on_wait)

        monkeypatch.setattr(manager, 'session', session)
        state = SimpleNamespace() if harness is None else SimpleNamespace(benchmark_harness=harness)
        self.request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(sandbox=manager)), state=state)

        async def get_user_by_id(user_id, db=None):
            return SimpleNamespace(id=user_id, role='user')

        async def configured_timeout() -> int:
            return TIMEOUT_DEFAULT_S

        monkeypatch.setattr(Users, 'get_user_by_id', get_user_by_id)
        monkeypatch.setattr(builtin, 'configured_timeout', configured_timeout)

    async def acall(self, tool, chat_id=CHAT, **kwargs):
        async def emit(event: dict) -> None:
            return None

        out = await tool(
            **kwargs, __request__=self.request, __user__={'id': 'u1'}, __chat_id__=chat_id, __event_emitter__=emit
        )
        return json.loads(out) if out.startswith('{') else out

    def call(self, tool, **kwargs):
        return asyncio.run(self.acall(tool, **kwargs))


def test_a_harness_bash_call_asking_for_web_runs_on_data(monkeypatch):
    rig = _Rig(monkeypatch, harness=True)
    rig.call(builtin.bash, command='printf hi', image='web')

    assert rig.images == ['data']


def test_a_harness_write_file_call_opens_its_session_on_data(monkeypatch):
    rig = _Rig(monkeypatch, harness=True)
    rig.call(builtin.write_file, path='a.txt', content='x')

    assert rig.images == ['data']


def test_a_harness_view_call_opens_its_session_on_data(monkeypatch):
    rig = _Rig(monkeypatch, harness=True)
    rig.call(builtin.view, path='.')

    assert rig.images == ['data']


@pytest.mark.parametrize('harness', [False, None])
def test_outside_a_benchmark_the_image_the_model_asked_for_is_kept(monkeypatch, harness):
    rig = _Rig(monkeypatch, harness=harness)
    rig.call(builtin.bash, command='printf hi', image='web')

    assert rig.images == ['web']


def test_outside_a_benchmark_a_file_tool_names_no_image(monkeypatch):
    rig = _Rig(monkeypatch, harness=False)
    rig.call(builtin.view, path='.')

    assert rig.images == [None]


def test_a_harness_call_with_an_invalid_image_is_still_refused_before_a_session_opens(monkeypatch):
    rig = _Rig(monkeypatch, harness=True)
    result = rig.call(builtin.bash, command='printf hi', image='gpu')

    assert isinstance(result, dict)
    assert "image must be 'data' or 'web', not 'gpu'" in result['error']
    assert rig.images == []


NOTE = "This benchmark run uses the 'data' image; image 'web' was not used."


@pytest.mark.parametrize('image', [None, 'data', 'web'])
def test_outside_a_benchmark_the_image_is_unchanged_and_there_is_no_note(image):
    request = SimpleNamespace(state=SimpleNamespace(benchmark_harness=False))

    assert builtin._harness_image(request, image) == (image, None)


def test_a_request_with_no_state_is_not_a_benchmark():
    assert builtin._harness_image(SimpleNamespace(), 'web') == ('web', None)
    assert builtin._harness_image(None, None) == (None, None)


@pytest.mark.parametrize('image', [None, 'data'])
def test_in_a_benchmark_no_image_or_data_runs_on_data_without_a_note(image):
    request = SimpleNamespace(state=SimpleNamespace(benchmark_harness=True))

    assert builtin._harness_image(request, image) == ('data', None)


def test_in_a_benchmark_web_runs_on_data_with_a_note():
    request = SimpleNamespace(state=SimpleNamespace(benchmark_harness=True))

    assert builtin._harness_image(request, 'web') == ('data', NOTE)


def test_a_harness_bash_call_asking_for_web_is_told_it_ran_on_data(monkeypatch):
    rig = _Rig(monkeypatch, harness=True)
    result = rig.call(builtin.bash, command='printf hi', image='web')

    assert isinstance(result, dict) and NOTE in result['stderr']


def test_a_harness_bash_call_asking_for_data_gets_no_note(monkeypatch):
    rig = _Rig(monkeypatch, harness=True)
    result = rig.call(builtin.bash, command='printf hi', image='data')

    assert isinstance(result, dict) and 'benchmark run' not in result['stderr']


def test_a_harness_view_call_gets_no_image_note(monkeypatch):
    rig = _Rig(monkeypatch, harness=True)
    result = rig.call(builtin.view, path='.')

    assert 'benchmark run' not in json.dumps(result)


def test_a_harness_run_in_the_sandbox_gets_no_image_note(monkeypatch):
    rig = _Rig(monkeypatch, harness=True)

    async def go():
        return await builtin.run_code_in_sandbox(
            'print(1)',
            request=rig.request,
            user={'id': 'u1'},
            chat_id=CHAT,
            message_id=None,
            metadata=None,
        )

    assert 'benchmark run' not in json.dumps(asyncio.run(go()))
    assert rig.images == ['data']


def _traced_session(rig):
    async def go():
        with upstream_trace.tracing() as trace:
            try:
                async with builtin._sandbox_session(rig.request, {'id': 'u1'}, CHAT, None, None):
                    pass
            except SandboxError:
                pass
        return trace.sandbox_keys

    return asyncio.run(go())


def test_a_session_notes_the_key_of_its_sandbox_once_entered(monkeypatch):
    rig = _Rig(monkeypatch, harness=True)

    assert _traced_session(rig) == [CHAT]


def test_a_session_that_fails_to_start_notes_no_sandbox(monkeypatch):
    rig = _Rig(monkeypatch, harness=True)

    def session(chat, account, *, image=None, on_wait=None):
        raise SandboxError('could not start')

    monkeypatch.setattr(rig.manager, 'session', session)

    assert _traced_session(rig) == []


def test_an_item_whose_sandbox_was_released_between_two_tool_calls_is_refused(monkeypatch):
    rig = _Rig(monkeypatch, harness=True)
    chats: list[str] = []

    async def run(hctx, prompt, errs):
        chats.append(hctx['chat_id'])
        upstream_trace.note_request(LOCAL, '{}')
        await rig.acall(builtin.bash, chat_id=hctx['chat_id'], command='printf one')
        # What an eviction or the idle reaper does to the item's sandbox between two calls.
        await rig.manager.release(hctx['chat_id'])
        await rig.acall(builtin.bash, chat_id=hctx['chat_id'], command='printf two')
        return {'output': []}

    monkeypatch.setattr(harness, '_run_pipeline', run)
    hctx = {**HCTX, 'engine': 'sandbox', 'sandbox': rig.manager}

    with pytest.raises(harness.HarnessRefused, match='sandbox was replaced while it ran'):
        asyncio.run(harness.ask(hctx, 'item'))
    assert chats and chats[0].startswith('temporary:benchmark-')


def test_an_item_that_keeps_its_sandbox_across_two_tool_calls_is_graded(monkeypatch):
    rig = _Rig(monkeypatch, harness=True)

    async def run(hctx, prompt, errs):
        upstream_trace.note_request(LOCAL, '{}')
        await rig.acall(builtin.bash, chat_id=hctx['chat_id'], command='printf one')
        await rig.acall(builtin.bash, chat_id=hctx['chat_id'], command='printf two')
        return {'output': []}

    monkeypatch.setattr(harness, '_run_pipeline', run)
    hctx = {**HCTX, 'engine': 'sandbox', 'sandbox': rig.manager}

    assert asyncio.run(harness.ask(hctx, 'item')).spec['sandbox_image'] == 'sha256:data-1'
