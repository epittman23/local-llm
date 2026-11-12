"""The sandbox manager (local_llm/sandbox/manager.py), against FakeBackend and a dict-backed chat lookup.

Pins, without Docker, Kata or a database (except for DatabaseChats):

- one command at a time per sandbox, and at most `max_running` sandboxes
  running: a session that has waited `wait_notice_s` for a slot says so once,
  and proceeds when a slot is released or reaped, or by stopping the least
  recently used sandbox idle for `evict_idle_s`, or gives up after
  `slot_wait_timeout_s` (Q13);
- a slot is freed only once a stop or destroy confirms its sandbox gone: a
  create that fails or is cancelled (and runs on anyway, as T14's thread
  would), a failed image switch and a sandbox reported not running are
  cleaned up first, and one whose cleanup fails stays in doubt, keeping its
  slot until the reaper stops it, so no more than `max_running` ever run;
- the idle reaper stops (never destroys) a persistent sandbox idle for exactly
  `idle_minutes`, keeps its volume, and leaves a sandbox in use alone;
- the retention sweep destroys an expired or orphaned stopped volume, and a
  stopped ephemeral one nobody maps, keeps live, running and in-use ones,
  looks the doomed chats up again before destroying, and destroys no orphan
  when most chats are missing;
- an image switch is one create on the same volume, keeping the files and the
  slot;
- the startup sweep and `shutdown` clean up leftovers and log per-key failures;
- unknown or malformed chat ids, chats the user may not use (Q14), callers
  without a str user id and over-long unsaved ids are refused before the
  backend is called; an unsaved chat gets an ephemeral sandbox keyed by a
  fresh UUID per (chat id, user id) (Q5, Q12), destroyed on release, and a
  failed or cancelled start leaves no mapping behind;
- a session's backend calls (exec, put_files, get_files, stat) end before the
  session does, a cancelled caller included: an exec is cancelled once and
  its kill awaited, through a second cancellation, other calls run to their
  end, a call that has not ended within `cancel_wait_s` gets the sandbox
  stopped first, and a call that ends cancelled on its own is a SandboxError
  (T12's security reviews);
- the settings read from config, the maintenance loop, and DatabaseChats on a
  real temporary SQLite database.

Run from apps/server (any LLLM_SECRET_KEY of 32 characters or more):

    LLLM_SECRET_KEY=... python -m pytest tests/test_sandbox_manager.py
"""

import asyncio
import importlib
import logging
import pkgutil
import time
import uuid
from types import SimpleNamespace
from typing import cast

import pytest

import local_llm.models as models_pkg
import local_llm.models.chats as chats_model
import local_llm.sandbox.manager as manager_module
from local_llm.internal.db import Base, async_engine, get_async_db_context
from local_llm.models.chats import Chat, Chats
from local_llm.models.config import Config
from local_llm.models.folders import Folder
from local_llm.sandbox import (
    DatabaseChats,
    SandboxError,
    SandboxManager,
    SandboxNotRunning,
    SandboxRefused,
    SandboxSettings,
    SandboxSpec,
    SandboxUnavailable,
    clamp_timeout,
    settings_from_config,
    wrap_command,
)
from local_llm.sandbox.fake import FakeBackend
from local_llm.sandbox.manager import EVICT_IDLE_S, MAX_UNSAVED_CHAT_ID_LEN, SETTING_KEYS, SLOT_WAIT_TIMEOUT_S

for _module in pkgutil.iter_modules(models_pkg.__path__):
    importlib.import_module(f'local_llm.models.{_module.name}')

USER = SimpleNamespace(id='u1', role='user')
OTHER = SimpleNamespace(id='u2', role='user')

CHAT_A, CHAT_B, CHAT_C, CHAT_D, CHAT_E = (str(uuid.UUID(int=n)) for n in (101, 102, 103, 104, 105))
FIVE = [CHAT_A, CHAT_B, CHAT_C, CHAT_D, CHAT_E]

UPPER = str(uuid.UUID(int=0xABCDEF)).upper()
DAY = 86_400
WALL_NOW = 50_000_000


class FakeChats:
    """A dict-backed ChatLookup: `rows` maps a chat id to its `updated_at`; only u1 may use the chats in `exist`."""

    def __init__(self, rows: dict[str, int] | None = None) -> None:
        self.rows = dict(rows or {})
        self.exist = set(self.rows)
        self.usable_calls: list[tuple[str, object]] = []
        self.updated_calls: list[list[str]] = []

    async def usable(self, chat_id, user):
        self.usable_calls.append((chat_id, user))
        return chat_id in self.exist and user.id == 'u1'

    async def updated_at(self, chat_ids):
        self.updated_calls.append(list(chat_ids))
        return {c: self.rows[c] for c in chat_ids if c in self.rows}


class Clock:
    """A controllable monotonic clock."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


class Backend(FakeBackend):
    """A FakeBackend whose create runs on when its caller is cancelled, as T14's `asyncio.to_thread` call would.

    Attributes:
        peak: The most sandboxes ever running at once.
        gate: When set to an Event, create waits for it before it does anything.
        create_started: Set once a create has begun.
        fail_after_create: Make create start the container, then raise, as a daemon error after the start would.
        stop_error, destroy_error: Raised (after recording the call) by stop and destroy instead of acting.
    """

    def __init__(self) -> None:
        super().__init__()
        self.peak = 0
        self.gate: asyncio.Event | None = None
        self.create_started = asyncio.Event()
        self.fail_after_create = False
        self.stop_error: Exception | None = None
        self.destroy_error: Exception | None = None

    def running(self) -> list[str]:
        return [key for key, box in self.sandboxes.items() if box.running]

    async def create(self, chat_id, spec):
        async def work():
            self.create_started.set()
            if self.gate is not None:
                await self.gate.wait()
            await FakeBackend.create(self, chat_id, spec)
            self.peak = max(self.peak, len(self.running()))
            if self.fail_after_create:
                raise SandboxError('the container started, then the daemon failed')

        # Shielded: cancelling the caller leaves the work running, as a thread would be.
        await asyncio.shield(asyncio.ensure_future(work()))

    async def stop(self, chat_id):
        if self.stop_error is not None:
            self.calls.append(('stop', {'chat_id': chat_id}))
            raise self.stop_error
        await super().stop(chat_id)

    async def destroy(self, chat_id):
        if self.destroy_error is not None:
            self.calls.append(('destroy', {'chat_id': chat_id}))
            raise self.destroy_error
        await super().destroy(chat_id)


class Rig:
    """A manager on a Backend with a changeable SandboxSettings, a Clock and FakeChats, all of them visible."""

    def __init__(
        self,
        *,
        max_running: int = 4,
        idle_minutes: int = 30,
        retention_days: int = 7,
        evict_idle_s: float = EVICT_IDLE_S,
        slot_wait_timeout_s: float = SLOT_WAIT_TIMEOUT_S,
    ) -> None:
        self.backend = Backend()
        self.chats = FakeChats({c: WALL_NOW for c in FIVE})
        self.clock = Clock()
        self.wall = float(WALL_NOW)
        self.settings = SandboxSettings(
            max_running=max_running, idle_minutes=idle_minutes, retention_days=retention_days
        )
        self.settings_reads = 0
        self.manager = SandboxManager(
            self.backend,
            settings=self._read_settings,
            chats=self.chats,
            clock=self.clock,
            wall_clock=lambda: self.wall,
            wait_notice_s=0.05,
            evict_idle_s=evict_idle_s,
            slot_wait_timeout_s=slot_wait_timeout_s,
        )

    async def _read_settings(self) -> SandboxSettings:
        self.settings_reads += 1
        return self.settings

    def names(self, *only: str) -> list[str]:
        """The backend's calls so far, by method name, optionally only the named methods."""
        return [name for name, _ in self.backend.calls if not only or name in only]

    def keys(self, name: str) -> list[object]:
        return [kwargs['chat_id'] for call, kwargs in self.backend.calls if call == name]

    async def use(self, chat_id: str, user=USER, image=None) -> str:
        """Open and close a session on the chat; the sandbox is left running. Returns its key."""
        async with self.manager.session(chat_id, user, image=image) as s:
            return s.key

    async def make_volume(self, key: str, *, running: bool = False, ephemeral: bool = False) -> None:
        """Put a sandbox straight into the backend, as a previous process would have left it."""
        await self.backend.create(key, SandboxSpec(key, 'data', ephemeral=ephemeral))
        if not running:
            await self.backend.stop(key)
        self.backend.calls.clear()

    def state(self) -> dict:
        """What the manager holds: slots used, each tracked key's image (None in doubt), locks, unsaved-chat mappings.

        The only place the tests read the manager's private state.
        """
        m = self.manager
        return {
            'used': len(m._tracked),
            'running': {key: tracked.image for key, tracked in m._tracked.items()},
            'locks': dict(m._locks),
            'unsaved': dict(m._unsaved),
        }


def run(coro):
    return asyncio.run(coro)


async def settle(rounds: int = 20) -> None:
    """Let every ready task run."""
    for _ in range(rounds):
        await asyncio.sleep(0)


# Locks and slots.


def test_two_sessions_on_one_chat_run_one_after_the_other():
    async def scenario():
        rig = Rig()
        order: list[str] = []

        async def worker(name: str) -> None:
            async with rig.manager.session(CHAT_A, USER):
                order.append(f'enter {name}')
                await settle()
                order.append(f'exit {name}')

        await asyncio.gather(worker('a'), worker('b'))
        return order

    assert run(scenario()) == ['enter a', 'exit a', 'enter b', 'exit b']


def test_sessions_on_different_chats_overlap():
    async def scenario():
        rig = Rig()
        order: list[str] = []

        async def worker(chat: str, name: str) -> None:
            async with rig.manager.session(chat, USER):
                order.append(f'enter {name}')
                await settle()
                order.append(f'exit {name}')

        await asyncio.gather(worker(CHAT_A, 'a'), worker(CHAT_B, 'b'))
        return order

    assert run(scenario()) == ['enter a', 'enter b', 'exit a', 'exit b']


def test_a_session_starts_the_default_image_once_and_reuses_the_running_sandbox():
    async def scenario():
        rig = Rig()
        first = await rig.use(CHAT_A)
        second = await rig.use(CHAT_A)
        return rig, first, second

    rig, first, second = run(scenario())
    assert first == second == CHAT_A
    assert rig.names() == ['create']
    assert rig.backend.sandboxes[CHAT_A].image == 'data'


def test_a_session_with_an_image_starts_that_image():
    async def scenario():
        rig = Rig()
        await rig.use(CHAT_A, image='web')
        return rig

    assert run(scenario()).backend.sandboxes[CHAT_A].image == 'web'


def test_an_invalid_image_is_refused_before_the_backend_is_called():
    async def scenario():
        rig = Rig()
        with pytest.raises(ValueError):
            await rig.use(CHAT_A, image='bogus')
        return rig

    rig = run(scenario())
    assert rig.backend.calls == []


@pytest.mark.parametrize('how', ['release', 'reap'])
def test_a_fifth_chat_waits_for_a_slot_is_told_once_and_proceeds_when_one_frees(how):
    async def scenario():
        rig = Rig(max_running=4)
        for chat in FIVE[:4]:
            await rig.use(chat)
        notices: list[str] = []
        noticed = asyncio.Event()

        async def on_wait():
            notices.append('waiting')
            noticed.set()

        async def fifth():
            async with rig.manager.session(CHAT_E, USER, on_wait=on_wait) as s:
                return s.key

        task = asyncio.create_task(fifth())
        await asyncio.wait_for(noticed.wait(), 2)
        waiting = (task.done(), list(notices), rig.names('create'))
        if how == 'release':
            await rig.manager.release(CHAT_A)
        else:
            rig.clock.now = 30 * 60
            await rig.manager.reap_idle()
        key = await asyncio.wait_for(task, 2)
        return waiting, notices, key, rig

    waiting, notices, key, rig = run(scenario())
    assert waiting == (False, ['waiting'], ['create'] * 4)
    assert notices == ['waiting']
    assert key == CHAT_E
    assert rig.keys('create')[-1] == CHAT_E


def test_a_session_that_finds_a_free_slot_never_calls_on_wait():
    async def scenario():
        rig = Rig(max_running=4)
        notices: list[str] = []

        async def on_wait():
            notices.append('waiting')

        async with rig.manager.session(CHAT_A, USER, on_wait=on_wait):
            pass
        return notices

    assert run(scenario()) == []


def test_a_waiting_session_without_on_wait_still_proceeds_when_a_slot_frees():
    async def scenario():
        rig = Rig(max_running=1)
        await rig.use(CHAT_A)
        task = asyncio.create_task(rig.use(CHAT_B))
        await asyncio.sleep(0.15)
        assert not task.done()
        await rig.manager.release(CHAT_A)
        return await asyncio.wait_for(task, 2)

    assert run(scenario()) == CHAT_B


def test_a_changed_max_running_applies_to_the_next_start():
    async def scenario():
        rig = Rig(max_running=1)
        await rig.use(CHAT_A)
        rig.settings = SandboxSettings(max_running=2)
        await asyncio.wait_for(rig.use(CHAT_B), 1)
        return rig

    rig = run(scenario())
    assert rig.keys('create') == [CHAT_A, CHAT_B]


def test_cancelling_a_session_waiting_for_a_slot_leaves_no_slot_or_lock_held():
    async def scenario():
        rig = Rig(max_running=1)
        await rig.use(CHAT_A)
        waiter = asyncio.create_task(rig.use(CHAT_B))
        await asyncio.sleep(0.1)
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        # The slot is still A's alone: freeing it lets a later session on B start, so nothing leaked.
        await rig.manager.release(CHAT_A)
        key = await asyncio.wait_for(rig.use(CHAT_B), 1)
        return rig, key

    rig, key = run(scenario())
    assert key == CHAT_B
    assert rig.keys('create') == [CHAT_A, CHAT_B]
    assert rig.state()['locks'] == {}


def test_an_exception_inside_the_block_releases_the_lock():
    async def scenario():
        rig = Rig()
        with pytest.raises(RuntimeError, match='boom'):
            async with rig.manager.session(CHAT_A, USER):
                raise RuntimeError('boom')
        return await asyncio.wait_for(rig.use(CHAT_A), 1)

    assert run(scenario()) == CHAT_A


def test_a_failed_create_frees_the_slot_and_propagates():
    async def scenario():
        rig = Rig(max_running=1)
        rig.backend.ready_reason = 'no kvm'
        with pytest.raises(SandboxUnavailable, match='no kvm'):
            await rig.use(CHAT_A)
        rig.backend.ready_reason = None
        # Had the failed start kept the only slot, this would wait forever.
        await asyncio.wait_for(rig.use(CHAT_B), 1)
        return rig

    rig = run(scenario())
    assert rig.keys('create') == [CHAT_A, CHAT_B]
    assert set(rig.backend.sandboxes) == {CHAT_B}


# A slot is freed only once its sandbox is confirmed gone.


@pytest.mark.parametrize('chat', [CHAT_A, 'temporary:t'], ids=['persistent', 'ephemeral'])
def test_a_create_cancelled_mid_flight_is_cleaned_up_once_the_backend_call_ends_and_only_then_frees_the_slot(chat):
    async def scenario():
        rig = Rig(max_running=1)
        rig.backend.gate = asyncio.Event()
        first = asyncio.create_task(rig.use(chat))
        await rig.backend.create_started.wait()
        first.cancel()
        await settle()
        # The backend's create still runs: the cancelled session waits for it, holding its lock and slot.
        held = (first.done(), rig.state()['used'])
        second = asyncio.create_task(rig.use(CHAT_B))
        await settle()
        blocked = not second.done()
        rig.backend.gate.set()
        with pytest.raises(asyncio.CancelledError):
            await first
        key = await asyncio.wait_for(second, 1)
        return rig, held, blocked, key

    rig, held, blocked, key = run(scenario())
    assert held == (False, 1)
    assert blocked
    assert key == CHAT_B
    assert rig.backend.peak == 1
    assert rig.backend.running() == [CHAT_B]
    assert list(rig.state()['running']) == [CHAT_B]
    assert rig.state()['unsaved'] == {}
    created = rig.keys('create')[0]
    if chat == CHAT_A:
        assert rig.keys('stop') == [CHAT_A]
        assert CHAT_A in rig.backend.sandboxes
    else:
        assert rig.keys('destroy') == [created]
        assert created not in rig.backend.sandboxes


def test_a_cancelled_create_whose_cleanup_fails_keeps_its_slot_until_the_reaper_stops_it(caplog):
    async def scenario():
        rig = Rig(max_running=1, slot_wait_timeout_s=0.2)
        rig.backend.gate = asyncio.Event()
        rig.backend.stop_error = SandboxError('docker is down')
        first = asyncio.create_task(rig.use(CHAT_A))
        await rig.backend.create_started.wait()
        first.cancel()
        rig.backend.gate.set()
        with pytest.raises(asyncio.CancelledError):
            await first
        tracked = rig.state()['running']
        # Its slot is still held, and a sandbox in doubt is never evicted: another chat cannot start.
        with pytest.raises(SandboxError, match='^no free sandbox: '):
            await rig.use(CHAT_B)
        running_then = rig.backend.running()
        rig.backend.stop_error = None
        await rig.manager.reap_idle()
        await asyncio.wait_for(rig.use(CHAT_B), 1)
        return rig, tracked, running_then

    with caplog.at_level(logging.ERROR, logger='local_llm.sandbox.manager'):
        rig, tracked, running_then = run(scenario())
    assert tracked == {CHAT_A: None}
    assert running_then == [CHAT_A]
    assert rig.backend.running() == [CHAT_B]
    assert rig.backend.peak == 1
    assert f'could not clean up sandbox {CHAT_A}' in caplog.text


def test_a_second_cancellation_does_not_interrupt_the_cleanup():
    async def scenario():
        rig = Rig(max_running=1)
        rig.backend.gate = asyncio.Event()
        real_stop = rig.backend.stop
        stop_gate = asyncio.Event()
        stopping = asyncio.Event()

        async def slow_stop(chat_id):
            stopping.set()
            await stop_gate.wait()
            await real_stop(chat_id)

        rig.backend.stop = slow_stop
        task = asyncio.create_task(rig.use(CHAT_A))
        await rig.backend.create_started.wait()
        task.cancel()
        rig.backend.gate.set()
        await stopping.wait()
        task.cancel()
        await settle()
        still_cleaning = not task.done()
        stop_gate.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        return rig, still_cleaning

    rig, still_cleaning = run(scenario())
    assert still_cleaning
    assert rig.backend.running() == []
    assert rig.state() == {'used': 0, 'running': {}, 'locks': {}, 'unsaved': {}}


def test_a_create_that_fails_after_its_session_was_cancelled_is_logged_at_debug_and_cleaned_up(caplog):
    async def scenario():
        rig = Rig(max_running=1)
        rig.backend.gate = asyncio.Event()
        rig.backend.fail_after_create = True
        task = asyncio.create_task(rig.use(CHAT_A))
        await rig.backend.create_started.wait()
        task.cancel()
        await settle()
        rig.backend.gate.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        return rig

    with caplog.at_level(logging.DEBUG, logger='local_llm.sandbox.manager'):
        rig = run(scenario())
    # The cancellation wins over the create's error, which is logged rather than lost.
    assert 'a sandbox backend call failed after its caller was cancelled' in caplog.text
    assert 'the container started, then the daemon failed' in caplog.text
    assert rig.keys('stop') == [CHAT_A]
    assert rig.backend.running() == []
    assert rig.state() == {'used': 0, 'running': {}, 'locks': {}, 'unsaved': {}}


@pytest.mark.parametrize('chat', [CHAT_A, 'temporary:t'], ids=['persistent', 'ephemeral'])
def test_a_failed_create_that_left_a_container_running_cleans_it_up_and_frees_the_slot(chat):
    async def scenario():
        rig = Rig(max_running=1)
        rig.backend.fail_after_create = True
        with pytest.raises(SandboxError, match='daemon failed'):
            await rig.use(chat)
        after = (rig.backend.running(), rig.state())
        rig.backend.fail_after_create = False
        await asyncio.wait_for(rig.use(CHAT_B), 1)
        return rig, after

    rig, (running, state) = run(scenario())
    assert running == []
    assert state == {'used': 0, 'running': {}, 'locks': {}, 'unsaved': {}}
    assert rig.backend.peak == 1
    if chat == CHAT_A:
        assert rig.keys('stop') == [CHAT_A]
        assert not rig.backend.sandboxes[CHAT_A].running
    else:
        assert rig.keys('destroy') == rig.keys('create')[:1]
        assert set(rig.backend.sandboxes) == {CHAT_B}


def test_a_failed_create_during_an_image_switch_that_left_a_container_cleans_it_up_before_freeing_the_slot():
    async def scenario():
        rig = Rig(max_running=1)
        await rig.use(CHAT_A, image='data')
        rig.backend.fail_after_create = True
        with pytest.raises(SandboxError, match='daemon failed'):
            await rig.use(CHAT_A, image='web')
        after = (rig.backend.running(), rig.state())
        rig.backend.fail_after_create = False
        await asyncio.wait_for(rig.use(CHAT_B), 1)
        return rig, after

    rig, (running, state) = run(scenario())
    assert running == []
    assert state['used'] == 0
    assert state['running'] == {}
    # The cleanup's stop alone: the switch itself is a create.
    assert rig.keys('stop') == [CHAT_A]
    assert rig.backend.peak == 1


@pytest.mark.parametrize('chat', [CHAT_A, 'temporary:t'], ids=['persistent', 'ephemeral'])
def test_a_sandbox_reported_not_running_while_it_still_runs_is_stopped_before_its_slot_is_freed(chat):
    async def scenario():
        rig = Rig(max_running=1)
        real_stat = rig.backend.stat

        async def flaky_stat(chat_id, path):
            raise SandboxNotRunning('inspect said not running')

        async with rig.manager.session(chat, USER) as s:
            key = s.key
            rig.backend.stat = flaky_stat
            with pytest.raises(SandboxNotRunning):
                await s.stat('/workspace')
        rig.backend.stat = real_stat
        after = rig.backend.running()
        await asyncio.wait_for(rig.use(CHAT_B), 1)
        return rig, key, after

    rig, key, after = run(scenario())
    assert after == []
    assert rig.backend.peak == 1
    assert rig.backend.running() == [CHAT_B]
    if chat == CHAT_A:
        assert rig.keys('stop') == [CHAT_A]
        assert CHAT_A in rig.backend.sandboxes
    else:
        assert rig.keys('destroy') == [key]
        assert rig.state()['unsaved'] == {}


def test_a_sandbox_reported_not_running_whose_stop_fails_keeps_its_slot_until_the_reaper_stops_it(caplog):
    async def scenario():
        rig = Rig(max_running=1, slot_wait_timeout_s=0.2)

        async def flaky_stat(chat_id, path):
            raise SandboxNotRunning('inspect said not running')

        real_stat = rig.backend.stat
        async with rig.manager.session(CHAT_A, USER) as s:
            rig.backend.stat = flaky_stat
            rig.backend.stop_error = SandboxError('docker is down')
            with pytest.raises(SandboxNotRunning):
                await s.stat('/workspace')
        rig.backend.stat = real_stat
        tracked = rig.state()['running']
        rig.clock.now = 10**6
        with pytest.raises(SandboxError, match='^no free sandbox: '):
            await rig.use(CHAT_B)
        running_then = rig.backend.running()
        rig.backend.stop_error = None
        await rig.manager.reap_idle()
        await asyncio.wait_for(rig.use(CHAT_B), 1)
        return rig, tracked, running_then

    with caplog.at_level(logging.ERROR, logger='local_llm.sandbox.manager'):
        rig, tracked, running_then = run(scenario())
    assert tracked == {CHAT_A: None}
    assert running_then == [CHAT_A]
    assert rig.backend.running() == [CHAT_B]
    assert rig.backend.peak == 1
    assert f'could not clean up sandbox {CHAT_A}' in caplog.text


def test_a_session_on_a_sandbox_in_doubt_creates_it_again_on_the_slot_it_holds():
    async def scenario():
        rig = Rig(max_running=1)

        async def flaky_stat(chat_id, path):
            raise SandboxNotRunning('inspect said not running')

        real_stat = rig.backend.stat
        async with rig.manager.session(CHAT_A, USER) as s:
            await s.put_files('d', [('f', b'kept', 0o444)])
            rig.backend.stat = flaky_stat
            rig.backend.stop_error = SandboxError('docker is down')
            with pytest.raises(SandboxNotRunning):
                await s.stat('/workspace')
        rig.backend.stat = real_stat
        rig.backend.stop_error = None
        in_doubt = (rig.state()['running'], rig.state()['used'])
        async with rig.manager.session(CHAT_A, USER) as s:
            files = await s.get_files(['/workspace/d/f'], 10)
        return rig, in_doubt, files

    rig, in_doubt, files = run(scenario())
    assert in_doubt == ({CHAT_A: None}, 1)
    assert files == {'/workspace/d/f': b'kept'}
    assert rig.names('create', 'stop') == ['create', 'stop', 'create']
    assert rig.state()['running'] == {CHAT_A: 'data'}
    assert rig.state()['used'] == 1


@pytest.mark.parametrize('chat', [CHAT_A, 'temporary:t'], ids=['persistent', 'ephemeral'])
def test_a_create_in_flight_when_the_manager_shuts_down_is_cleaned_up_and_the_session_raises(chat):
    async def scenario():
        rig = Rig()
        rig.backend.gate = asyncio.Event()
        task = asyncio.create_task(rig.use(chat))
        await rig.backend.create_started.wait()
        await rig.manager.shutdown(stop_running=True)
        rig.backend.gate.set()
        with pytest.raises(SandboxError, match='the sandbox manager has shut down'):
            await task
        return rig

    rig = run(scenario())
    assert rig.backend.running() == []
    assert rig.state() == {'used': 0, 'running': {}, 'locks': {}, 'unsaved': {}}
    if chat == CHAT_A:
        assert rig.keys('stop') == [CHAT_A]
        assert CHAT_A in rig.backend.sandboxes
    else:
        # Destroyed, though shutdown had already cleared the unsaved-chat mappings.
        assert rig.keys('destroy') == rig.keys('create')
        assert rig.backend.sandboxes == {}


# Eviction when no slot is free (Q13).


def test_the_eviction_constants_are_the_owners():
    assert (EVICT_IDLE_S, SLOT_WAIT_TIMEOUT_S) == (60, 120)


def test_a_session_with_no_free_slot_stops_the_least_recently_used_idle_sandbox_and_takes_its_slot():
    async def scenario():
        rig = Rig(max_running=3)
        await rig.use(CHAT_A)
        rig.clock.now = 10
        await rig.use(CHAT_B)
        release_c = asyncio.Event()

        async def hold_c():
            async with rig.manager.session(CHAT_C, USER):
                await release_c.wait()

        holder = asyncio.create_task(hold_c())
        await settle()
        # A and B idle for long, C idle too but in use.
        rig.clock.now = 10_000
        rig.backend.calls.clear()
        await asyncio.wait_for(rig.use(CHAT_D), 1)
        first = (rig.keys('stop'), sorted(rig.backend.running()))
        await asyncio.wait_for(rig.use(CHAT_E), 1)
        second = (rig.keys('stop'), sorted(rig.backend.running()))
        release_c.set()
        await holder
        return rig, first, second

    rig, first, second = run(scenario())
    assert first == ([CHAT_A], sorted([CHAT_B, CHAT_C, CHAT_D]))
    assert second == ([CHAT_A, CHAT_B], sorted([CHAT_C, CHAT_D, CHAT_E]))
    assert rig.names('destroy') == []
    assert {CHAT_A, CHAT_B} <= set(rig.backend.sandboxes)
    assert rig.backend.peak == 3


def test_no_sandbox_idle_for_less_than_evict_idle_s_or_in_use_is_evicted_and_the_wait_ends_with_nothing_held():
    async def scenario():
        rig = Rig(max_running=2, slot_wait_timeout_s=0.2)
        await rig.use(CHAT_A)
        release_b = asyncio.Event()

        async def hold_b():
            async with rig.manager.session(CHAT_B, USER):
                await release_b.wait()

        holder = asyncio.create_task(hold_b())
        await settle()
        rig.clock.now = EVICT_IDLE_S - 1
        notices: list[str] = []

        async def on_wait():
            notices.append('waiting')

        with pytest.raises(SandboxError, match='^no free sandbox: '):
            async with rig.manager.session('temporary:late', OTHER, on_wait=on_wait):
                pass
        after = rig.state()
        stops = rig.keys('stop')
        # At exactly evict_idle_s, A qualifies.
        rig.clock.now = EVICT_IDLE_S
        await asyncio.wait_for(rig.use(CHAT_C), 1)
        release_b.set()
        await holder
        return rig, notices, after, stops

    rig, notices, after, stops = run(scenario())
    assert notices == ['waiting']
    assert stops == []
    assert after['used'] == 2
    assert set(after['running']) == {CHAT_A, CHAT_B}
    assert set(after['locks']) == {CHAT_B}
    assert after['unsaved'] == {}
    assert rig.keys('stop') == [CHAT_A]


def test_an_evicted_ephemeral_sandbox_is_destroyed_and_its_key_forgotten():
    async def scenario():
        rig = Rig(max_running=1)
        key = await rig.use('temporary:x')
        rig.clock.now = EVICT_IDLE_S
        await asyncio.wait_for(rig.use(CHAT_A), 1)
        return rig, key

    rig, key = run(scenario())
    assert rig.keys('destroy') == [key]
    assert key not in rig.backend.sandboxes
    assert rig.state()['unsaved'] == {}
    assert rig.backend.running() == [CHAT_A]


def test_an_evicted_persistent_sandbox_keeps_its_files_and_its_next_call_starts_it_again():
    async def scenario():
        rig = Rig(max_running=1)
        async with rig.manager.session(CHAT_A, USER) as s:
            await s.put_files('d', [('f', b'kept', 0o444)])
        rig.clock.now = EVICT_IDLE_S
        await asyncio.wait_for(rig.use(CHAT_B), 1)
        rig.clock.now = 2 * EVICT_IDLE_S
        async with rig.manager.session(CHAT_A, USER) as s:
            files = await s.get_files(['/workspace/d/f'], 10)
        return rig, files

    rig, files = run(scenario())
    assert files == {'/workspace/d/f': b'kept'}
    assert rig.names('create', 'stop', 'destroy') == ['create', 'stop', 'create', 'stop', 'create']
    assert rig.keys('stop') == [CHAT_A, CHAT_B]


def test_a_waiting_session_tries_eviction_again_as_sandboxes_age(monkeypatch):
    monkeypatch.setattr(manager_module, '_SLOT_RETRY_S', 0.01)

    async def scenario():
        rig = Rig(max_running=1)
        await rig.use(CHAT_A)
        waiter = asyncio.create_task(rig.use(CHAT_B))
        await asyncio.sleep(0.05)
        waiting = not waiter.done()
        # Nothing frees a slot or announces the aging: only the periodic retry sees it.
        rig.clock.now = EVICT_IDLE_S
        key = await asyncio.wait_for(waiter, 1)
        return rig, waiting, key

    rig, waiting, key = run(scenario())
    assert waiting
    assert key == CHAT_B
    assert rig.keys('stop') == [CHAT_A]


def test_a_sandbox_that_fails_to_stop_for_eviction_is_left_in_doubt_for_the_reaper_and_the_wait_times_out(caplog):
    async def scenario():
        rig = Rig(max_running=1, slot_wait_timeout_s=0.2)
        await rig.use(CHAT_A)
        rig.clock.now = EVICT_IDLE_S
        rig.backend.stop_error = SandboxError('stuck')
        with pytest.raises(SandboxError, match='^no free sandbox: ') as refused:
            await rig.use(CHAT_B)
        after = (rig.state(), rig.backend.running(), rig.keys('stop'))
        # Not idle for idle_minutes, but in doubt: the next reap retries it.
        rig.backend.stop_error = None
        await rig.manager.reap_idle()
        return rig, after, str(refused.value)

    with caplog.at_level(logging.ERROR, logger='local_llm.sandbox.manager'):
        rig, (state, running, stops), message = run(scenario())
    assert state['running'] == {CHAT_A: None}
    assert state['used'] == 1
    assert running == [CHAT_A]
    # Tried once: in doubt, it is no longer a candidate for the waiting session's later attempts.
    assert stops == [CHAT_A]
    assert 'failed to stop' in message
    assert f'could not stop idle sandbox {CHAT_A} to free a slot' in caplog.text
    assert rig.keys('stop') == [CHAT_A, CHAT_A]
    assert rig.state()['running'] == {}
    assert rig.backend.running() == []


def test_when_the_least_recently_used_idle_sandbox_cannot_be_stopped_the_next_one_is_evicted(caplog):
    async def scenario():
        rig = Rig(max_running=2)
        await rig.use(CHAT_A)
        rig.clock.now = 1
        await rig.use(CHAT_B)
        rig.clock.now = 1000
        real_stop = rig.backend.stop

        async def stop(chat_id):
            if chat_id == CHAT_A:
                rig.backend.calls.append(('stop', {'chat_id': chat_id}))
                raise SandboxError('stuck')
            await real_stop(chat_id)

        rig.backend.stop = stop
        key = await asyncio.wait_for(rig.use(CHAT_C), 1)
        return rig, key

    with caplog.at_level(logging.ERROR, logger='local_llm.sandbox.manager'):
        rig, key = run(scenario())
    assert key == CHAT_C
    assert rig.keys('stop') == [CHAT_A, CHAT_B]
    assert sorted(rig.backend.running()) == sorted([CHAT_A, CHAT_C])
    assert rig.state()['running'] == {CHAT_A: None, CHAT_C: 'data'}
    assert f'could not stop idle sandbox {CHAT_A} to free a slot' in caplog.text


def test_eviction_passes_over_a_sandbox_put_in_doubt_while_an_earlier_candidates_stop_failed():
    async def scenario():
        rig = Rig(max_running=2, slot_wait_timeout_s=0.2)
        await rig.use(CHAT_A)
        rig.clock.now = 1
        await rig.use(CHAT_B)
        rig.clock.now = 1000
        stop_gate = asyncio.Event()
        stopping = asyncio.Event()

        async def stuck_stop(chat_id):
            rig.backend.calls.append(('stop', {'chat_id': chat_id}))
            stopping.set()
            await stop_gate.wait()
            raise SandboxError('stuck')

        rig.backend.stop = stuck_stop
        rig.backend.destroy_error = SandboxError('stuck too')
        waiter = asyncio.create_task(rig.use(CHAT_C))
        await stopping.wait()
        # While A's stop hangs, B, the next candidate, is released and its destroy fails: B is in doubt.
        with pytest.raises(SandboxError, match='stuck too'):
            await rig.manager.release(CHAT_B)
        stop_gate.set()
        with pytest.raises(SandboxError, match='^no free sandbox: '):
            await waiter
        return rig

    rig = run(scenario())
    assert rig.keys('stop') == [CHAT_A]
    assert rig.keys('destroy') == [CHAT_B]
    assert rig.state()['running'] == {CHAT_A: None, CHAT_B: None}


def test_a_session_cancelled_while_it_evicts_leaves_the_victim_forgotten_and_its_next_session_works():
    async def scenario():
        rig = Rig(max_running=1)
        await rig.use(CHAT_A)
        rig.clock.now = EVICT_IDLE_S
        stop_gate = asyncio.Event()
        stopping = asyncio.Event()

        async def gated_stop(chat_id):
            async def work():
                stopping.set()
                await stop_gate.wait()
                await FakeBackend.stop(rig.backend, chat_id)

            # Shielded: cancelling the caller leaves the stop running, as T14's thread would.
            await asyncio.shield(asyncio.ensure_future(work()))

        rig.backend.stop = gated_stop
        evictor = asyncio.create_task(rig.use(CHAT_B))
        await stopping.wait()
        evictor.cancel()
        await settle()
        still_stopping = not evictor.done()
        stop_gate.set()
        with pytest.raises(asyncio.CancelledError):
            await evictor
        after = (rig.backend.running(), rig.state())
        t = clamp_timeout(10)
        async with rig.manager.session(CHAT_A, USER) as s:
            result = await s.exec(wrap_command('printf %s hi', t), t)
        return rig, still_stopping, after, result

    rig, still_stopping, (running, state), result = run(scenario())
    assert still_stopping
    assert running == []
    assert state == {'used': 0, 'running': {}, 'locks': {}, 'unsaved': {}}
    assert result.stdout == 'hi'
    assert rig.keys('create') == [CHAT_A, CHAT_A]


# Image switch.


def test_an_image_switch_is_a_single_create_with_the_new_image_that_keeps_the_files_and_the_slot():
    async def scenario():
        rig = Rig(max_running=1)
        async with rig.manager.session(CHAT_A, USER, image='data') as s:
            await s.put_files('in', [('a.txt', b'hello', 0o444)])
        rig.backend.calls.clear()
        async with rig.manager.session(CHAT_A, USER, image='web') as s:
            got = await s.get_files(['/workspace/in/a.txt'], 100)
        # The slot is still taken by A: a second chat has to wait.
        other = asyncio.create_task(rig.use(CHAT_B))
        await asyncio.sleep(0.05)
        blocked = not other.done()
        other.cancel()
        return rig, got, blocked

    rig, got, blocked = run(scenario())
    assert got == {'/workspace/in/a.txt': b'hello'}
    assert rig.names('stop', 'destroy', 'create') == ['create']
    (spec,) = [kwargs['spec'] for name, kwargs in rig.backend.calls if name == 'create']
    assert (spec.chat_id, spec.image) == (CHAT_A, 'web')
    assert rig.backend.sandboxes[CHAT_A].image == 'web'
    assert rig.state()['running'] == {CHAT_A: 'web'}
    assert blocked


def test_a_failed_create_during_an_image_switch_frees_the_slot():
    async def scenario():
        rig = Rig(max_running=1)
        await rig.use(CHAT_A, image='data')
        rig.backend.ready_reason = 'no kvm'
        with pytest.raises(SandboxUnavailable):
            await rig.use(CHAT_A, image='web')
        rig.backend.ready_reason = None
        await asyncio.wait_for(rig.use(CHAT_B), 1)
        return rig

    assert CHAT_B in run(scenario()).backend.sandboxes


# Session methods.


def test_session_methods_run_the_backend_with_the_sessions_key():
    async def scenario():
        rig = Rig()
        t = clamp_timeout(10)
        async with rig.manager.session(CHAT_A, USER) as s:
            result = await s.exec(wrap_command('printf %s hi', t), t)
            await s.put_files('d', [('f', b'xyz', 0o444)])
            files = await s.get_files(['/workspace/d/f'], 10)
            stat = await s.stat('/workspace/d/f')
            missing = await s.stat('/workspace/nope')
        return result, files, stat, missing

    result, files, stat, missing = run(scenario())
    assert result.stdout == 'hi'
    assert files == {'/workspace/d/f': b'xyz'}
    assert stat is not None
    assert (stat.kind, stat.size) == ('file', 3)
    assert missing is None


def test_session_methods_after_the_block_raise_sandbox_error():
    async def scenario():
        rig = Rig()
        async with rig.manager.session(CHAT_A, USER) as s:
            pass
        t = clamp_timeout(10)
        outcomes = []
        for call in (
            lambda: s.exec(wrap_command('true', t), t),
            lambda: s.put_files('d', []),
            lambda: s.get_files([], 1),
            lambda: s.stat('/workspace'),
        ):
            try:
                await call()
            except SandboxError:
                outcomes.append('refused')
        return rig, outcomes

    rig, outcomes = run(scenario())
    assert outcomes == ['refused'] * 4
    assert rig.names() == ['create']


@pytest.mark.parametrize('method', ['exec', 'put_files', 'get_files', 'stat'])
def test_a_sandbox_not_running_frees_the_slot_and_the_next_session_starts_it_again_on_the_same_key(method):
    async def scenario():
        rig = Rig(max_running=1)
        async with rig.manager.session(CHAT_A, USER) as s:
            await s.put_files('d', [('f', b'kept', 0o444)])
            rig.backend.sandboxes[CHAT_A].running = False
            t = clamp_timeout(10)
            calls = {
                'exec': lambda: s.exec(wrap_command('true', t), t),
                'put_files': lambda: s.put_files('d', []),
                'get_files': lambda: s.get_files([], 1),
                'stat': lambda: s.stat('/workspace/d'),
            }
            with pytest.raises(SandboxNotRunning):
                await calls[method]()
        # The slot came back, so another chat can start under max_running=1.
        await asyncio.wait_for(rig.use(CHAT_B), 1)
        await rig.manager.release(CHAT_B)
        async with rig.manager.session(CHAT_A, USER) as s:
            files = await s.get_files(['/workspace/d/f'], 10)
        return rig, s.key, files

    rig, key, files = run(scenario())
    assert key == CHAT_A
    assert rig.keys('create') == [CHAT_A, CHAT_B, CHAT_A]
    assert files == {'/workspace/d/f': b'kept'}


# The idle reaper.


def test_the_reaper_waits_for_idle_minutes_and_stops_at_exactly_that_time():
    async def scenario():
        rig = Rig(idle_minutes=30)
        await rig.use(CHAT_A)
        rig.backend.calls.clear()
        rig.clock.now = 29 * 60 + 59
        await rig.manager.reap_idle()
        before = rig.names('stop')
        rig.clock.now = 30 * 60
        await rig.manager.reap_idle()
        return before, rig

    before, rig = run(scenario())
    assert before == []
    assert rig.keys('stop') == [CHAT_A]
    assert rig.names('destroy') == []


def test_the_reaper_measures_idleness_from_the_end_of_the_last_session():
    async def scenario():
        rig = Rig(idle_minutes=30)
        await rig.use(CHAT_A)
        rig.clock.now = 20 * 60
        await rig.use(CHAT_A)
        rig.backend.calls.clear()
        rig.clock.now = 49 * 60
        await rig.manager.reap_idle()
        early = rig.names('stop')
        rig.clock.now = 50 * 60
        await rig.manager.reap_idle()
        return early, rig.names('stop')

    assert run(scenario()) == ([], ['stop'])


def test_a_reaped_persistent_sandbox_keeps_its_files_for_a_later_session():
    async def scenario():
        rig = Rig()
        async with rig.manager.session(CHAT_A, USER) as s:
            await s.put_files('d', [('f', b'still here', 0o444)])
        rig.clock.now = 31 * 60
        await rig.manager.reap_idle()
        stopped = not rig.backend.sandboxes[CHAT_A].running
        async with rig.manager.session(CHAT_A, USER) as s:
            files = await s.get_files(['/workspace/d/f'], 100)
        return stopped, files, rig

    stopped, files, rig = run(scenario())
    assert stopped
    assert files == {'/workspace/d/f': b'still here'}
    assert rig.names('stop', 'create', 'destroy') == ['create', 'stop', 'create']


def test_the_reaper_never_stops_a_sandbox_in_use():
    async def scenario():
        rig = Rig()
        async with rig.manager.session(CHAT_A, USER):
            rig.clock.now = 10 * 60 * 60
            rig.backend.calls.clear()
            await rig.manager.reap_idle()
            during = rig.names()
        return during, rig

    during, rig = run(scenario())
    assert during == []
    assert rig.backend.sandboxes[CHAT_A].running


def test_the_reaper_skips_a_sandbox_a_session_takes_while_an_earlier_one_is_being_stopped():
    async def scenario():
        rig = Rig()
        await rig.use(CHAT_A)
        await rig.use(CHAT_B)
        rig.clock.now = 31 * 60
        real_stop = rig.backend.stop
        entered = asyncio.Event()
        proceed = asyncio.Event()

        async def slow_stop(chat_id):
            if chat_id == CHAT_A:
                entered.set()
                await proceed.wait()
            await real_stop(chat_id)

        rig.backend.stop = slow_stop
        reaper = asyncio.create_task(rig.manager.reap_idle())
        await entered.wait()
        # B is next in the reaper's list; a session takes it before the reaper gets there.
        release_b = asyncio.Event()

        async def hold_b():
            async with rig.manager.session(CHAT_B, USER):
                await release_b.wait()

        session = asyncio.create_task(hold_b())
        await settle()
        proceed.set()
        await reaper
        release_b.set()
        await session
        return rig

    rig = run(scenario())
    assert rig.keys('stop') == [CHAT_A]
    assert rig.backend.sandboxes[CHAT_B].running


def test_the_reaper_skips_a_sandbox_released_while_it_was_stopping_an_earlier_one():
    async def scenario():
        rig = Rig()
        await rig.use(CHAT_A)
        await rig.use(CHAT_B)
        rig.clock.now = 31 * 60
        real_stop = rig.backend.stop
        entered = asyncio.Event()
        proceed = asyncio.Event()

        async def slow_stop(chat_id):
            if chat_id == CHAT_A:
                entered.set()
                await proceed.wait()
            await real_stop(chat_id)

        rig.backend.stop = slow_stop
        reaper = asyncio.create_task(rig.manager.reap_idle())
        await entered.wait()
        # B is next in the reaper's list; it is released, and so forgotten, before the reaper gets there.
        await rig.manager.release(CHAT_B)
        proceed.set()
        await reaper
        return rig

    rig = run(scenario())
    assert rig.keys('stop') == [CHAT_A]
    assert rig.keys('destroy') == [CHAT_B]
    assert rig.state()['running'] == {}


def test_a_failing_stop_in_the_reaper_keeps_the_key_tracked_and_a_later_pass_retries(caplog):
    async def scenario():
        # Eviction would try the same stop for the waiting session; this test is about the reaper.
        rig = Rig(max_running=1, evict_idle_s=10**9)
        await rig.use(CHAT_A)
        rig.clock.now = 31 * 60
        real_stop = rig.backend.stop
        failing = True

        async def stop(chat_id):
            if failing:
                rig.backend.calls.append(('stop', {'chat_id': chat_id}))
                raise SandboxError('docker is down')
            await real_stop(chat_id)

        rig.backend.stop = stop
        await rig.manager.reap_idle()
        first = rig.names('stop')
        # Still holding the only slot.
        blocked = asyncio.create_task(rig.use(CHAT_B))
        await asyncio.sleep(0.05)
        still_blocked = not blocked.done()
        failing = False
        await rig.manager.reap_idle()
        await asyncio.wait_for(blocked, 1)
        return first, still_blocked, rig

    with caplog.at_level(logging.ERROR, logger='local_llm.sandbox.manager'):
        first, still_blocked, rig = run(scenario())
    assert first == ['stop']
    assert still_blocked
    assert rig.keys('stop') == [CHAT_A, CHAT_A]
    assert 'could not stop idle sandbox' in caplog.text


def test_the_reaper_destroys_an_idle_ephemeral_sandbox_and_forgets_its_key():
    async def scenario():
        rig = Rig()
        first = await rig.use('temporary:benchmark-x')
        rig.clock.now = 31 * 60
        await rig.manager.reap_idle()
        second = await rig.use('temporary:benchmark-x')
        return rig, first, second

    rig, first, second = run(scenario())
    assert rig.keys('destroy') == [first]
    assert second != first


@pytest.mark.parametrize(
    'chat_a, chat_b, method',
    [(CHAT_A, CHAT_B, 'stop'), ('temporary:a', 'temporary:b', 'destroy')],
    ids=['persistent', 'ephemeral'],
)
def test_the_reaper_keeps_a_sandbox_used_while_it_was_stopping_an_earlier_one(chat_a, chat_b, method):
    async def scenario():
        rig = Rig()
        first = await rig.use(chat_a)
        second = await rig.use(chat_b)
        rig.clock.now = 31 * 60
        real = getattr(rig.backend, method)
        entered = asyncio.Event()
        proceed = asyncio.Event()

        async def slow(chat_id):
            if chat_id == first:
                entered.set()
                await proceed.wait()
            await real(chat_id)

        setattr(rig.backend, method, slow)
        reaper = asyncio.create_task(rig.manager.reap_idle())
        await entered.wait()
        # Used, and done with, before the reaper reaches it, so it is no longer idle.
        await rig.use(chat_b)
        proceed.set()
        await reaper
        return rig, first, second

    rig, first, second = run(scenario())
    assert rig.keys(method) == [first]
    assert rig.backend.running() == [second]
    if method == 'destroy':
        assert rig.state()['unsaved'] == {('temporary:b', 'u1'): second}


# The retention sweep.


def test_the_sweep_destroys_expired_and_orphaned_stopped_volumes_and_keeps_the_rest():
    async def scenario():
        rig = Rig(retention_days=7)
        expired, orphan, live, running, ephemeral = FIVE
        cutoff = WALL_NOW - 7 * DAY
        rig.chats.rows = {expired: cutoff - 1, live: cutoff + 1, running: cutoff - 1}
        await rig.make_volume(expired)
        await rig.make_volume(orphan)
        await rig.make_volume(live)
        await rig.make_volume(running, running=True)
        await rig.make_volume(ephemeral, ephemeral=True, running=True)
        await rig.manager.sweep_retention()
        return rig, (expired, orphan, live, running, ephemeral)

    rig, (expired, orphan, live, running, ephemeral) = run(scenario())
    assert sorted(rig.keys('destroy')) == sorted([expired, orphan])
    # Once for every candidate, then again for the doomed ones just before destroying them.
    assert len(rig.chats.updated_calls) == 2
    assert sorted(rig.chats.updated_calls[0]) == sorted([expired, orphan, live])
    assert sorted(rig.chats.updated_calls[1]) == sorted([expired, orphan])
    assert set(rig.backend.sandboxes) == {live, running, ephemeral}


def test_a_volume_updated_exactly_retention_days_ago_is_kept():
    async def scenario():
        rig = Rig(retention_days=7)
        rig.chats.rows = {CHAT_A: WALL_NOW - 7 * DAY}
        await rig.make_volume(CHAT_A)
        await rig.manager.sweep_retention()
        kept = CHAT_A in rig.backend.sandboxes
        rig.wall += 1
        await rig.manager.sweep_retention()
        return kept, CHAT_A in rig.backend.sandboxes

    assert run(scenario()) == (True, False)


def test_the_sweep_makes_no_updated_at_call_when_nothing_is_a_candidate():
    async def scenario():
        rig = Rig()
        await rig.make_volume(CHAT_A, running=True)
        await rig.make_volume(CHAT_B, ephemeral=True, running=True)
        await rig.manager.sweep_retention()
        return rig

    rig = run(scenario())
    assert rig.chats.updated_calls == []
    assert rig.names('destroy') == []


def test_the_sweep_leaves_a_volume_a_session_holds_or_waits_on():
    async def scenario():
        rig = Rig()
        rig.chats.rows = {}
        await rig.use(CHAT_A)
        # Its lock is held by a session, though the manager's map no longer shows it running.
        async with rig.manager.session(CHAT_A, USER):
            rig.backend.sandboxes[CHAT_A].running = False
            await rig.manager.sweep_retention()
            during = CHAT_A in rig.backend.sandboxes
        return during

    assert run(scenario()) is True


def test_the_sweep_skips_a_volume_a_session_takes_while_the_chat_lookup_runs():
    async def scenario():
        rig = Rig()
        rig.chats.rows = {}
        await rig.make_volume(CHAT_A)
        real = rig.chats.updated_at

        async def updated_at(ids):
            result = await real(ids)
            # A session starts the volume's sandbox while the lookup is in flight.
            task = asyncio.create_task(rig.use(CHAT_A))
            await settle()
            await task
            return result

        rig.chats.updated_at = updated_at
        await rig.manager.sweep_retention()
        return rig

    rig = run(scenario())
    assert rig.names('destroy') == []
    assert rig.backend.sandboxes[CHAT_A].running


def test_a_failing_destroy_in_the_sweep_is_logged_and_the_others_are_still_destroyed(caplog):
    async def scenario():
        rig = Rig()
        rig.chats.rows = {}
        await rig.make_volume(CHAT_A)
        await rig.make_volume(CHAT_B)
        real = rig.backend.destroy

        async def destroy(chat_id):
            if chat_id == CHAT_A:
                raise SandboxError('busy')
            await real(chat_id)

        rig.backend.destroy = destroy
        await rig.manager.sweep_retention()
        return rig

    with caplog.at_level(logging.ERROR, logger='local_llm.sandbox.manager'):
        rig = run(scenario())
    assert set(rig.backend.sandboxes) == {CHAT_A}
    assert f'could not destroy expired sandbox volume {CHAT_A}' in caplog.text


def test_a_failing_listing_makes_the_sweep_raise():
    async def scenario():
        rig = Rig()

        async def boom():
            raise SandboxError('docker is down')

        rig.backend.list_sandboxes = boom
        await rig.manager.sweep_retention()

    with pytest.raises(SandboxError, match='docker is down'):
        run(scenario())


def test_the_sweep_destroys_a_stopped_ephemeral_volume_nobody_maps_and_keeps_one_in_use(caplog):
    async def scenario():
        rig = Rig()
        orphan, failing = str(uuid.UUID(int=201)), str(uuid.UUID(int=202))
        await rig.make_volume(orphan, ephemeral=True)
        await rig.make_volume(failing, ephemeral=True)
        real = rig.backend.destroy

        async def destroy(chat_id):
            if chat_id == failing:
                raise SandboxError('busy')
            await real(chat_id)

        rig.backend.destroy = destroy
        async with rig.manager.session('temporary:live', USER) as s:
            live = s.key
            # Listed as stopped while a session holds it.
            rig.backend.sandboxes[live].running = False
            await rig.manager.sweep_retention()
        return rig, orphan, failing, live

    with caplog.at_level(logging.ERROR, logger='local_llm.sandbox.manager'):
        rig, orphan, failing, live = run(scenario())
    assert orphan not in rig.backend.sandboxes
    assert {failing, live} <= set(rig.backend.sandboxes)
    assert f'could not destroy stopped ephemeral sandbox volume {failing}' in caplog.text
    assert rig.chats.updated_calls == []


@pytest.mark.parametrize(
    'missing, present, orphans_destroyed',
    [(4, 1, False), (4, 4, True), (3, 0, True)],
    ids=['most missing', 'exactly half missing', 'only three missing'],
)
def test_the_sweep_destroys_no_orphan_when_most_chats_are_missing_and_still_destroys_expired_ones(
    caplog, missing, present, orphans_destroyed
):
    async def scenario():
        rig = Rig(retention_days=7)
        orphans = [str(uuid.UUID(int=300 + n)) for n in range(missing)]
        expired = [str(uuid.UUID(int=400 + n)) for n in range(present)]
        rig.chats.rows = {key: WALL_NOW - 30 * DAY for key in expired}
        for key in orphans + expired:
            await rig.make_volume(key)
        await rig.manager.sweep_retention()
        return rig, orphans, expired

    with caplog.at_level(logging.ERROR, logger='local_llm.sandbox.manager'):
        rig, orphans, expired = run(scenario())
    assert not set(expired) & set(rig.backend.sandboxes)
    if orphans_destroyed:
        assert not set(orphans) & set(rig.backend.sandboxes)
        assert 'destroying none of those' not in caplog.text
    else:
        assert set(orphans) <= set(rig.backend.sandboxes)
        assert f'the chats of {missing} of {missing + present} stopped sandbox volumes were not found' in caplog.text


def test_the_sweep_asks_again_before_destroying_and_keeps_a_volume_whose_chat_was_updated_meanwhile(caplog):
    async def scenario():
        rig = Rig(retention_days=7)
        rig.chats.rows = {CHAT_A: WALL_NOW - 30 * DAY, CHAT_B: WALL_NOW - 30 * DAY}
        await rig.make_volume(CHAT_A)
        await rig.make_volume(CHAT_B)
        real = rig.chats.updated_at

        async def updated_at(ids):
            result = await real(ids)
            # Between the two lookups, A's chat is used again and B's deleted.
            rig.chats.rows[CHAT_A] = WALL_NOW
            rig.chats.rows.pop(CHAT_B, None)
            return result

        rig.chats.updated_at = updated_at
        await rig.manager.sweep_retention()
        return rig

    with caplog.at_level(logging.INFO, logger='local_llm.sandbox.manager'):
        rig = run(scenario())
    assert set(rig.backend.sandboxes) == {CHAT_A}
    assert rig.chats.updated_calls == [[CHAT_A, CHAT_B], [CHAT_A, CHAT_B]]
    assert f'destroyed sandbox volume {CHAT_B} (chat deleted)' in caplog.text


# The startup sweep and shutdown.


def test_the_startup_sweep_stops_running_persistent_destroys_ephemeral_and_keeps_stopped_volumes():
    async def scenario():
        rig = Rig()
        await rig.make_volume(CHAT_A, running=True)
        await rig.make_volume(CHAT_B)
        await rig.make_volume(CHAT_C, ephemeral=True, running=True)
        await rig.make_volume(CHAT_D, ephemeral=True)
        await rig.manager.startup_sweep()
        return rig

    rig = run(scenario())
    assert rig.keys('stop') == [CHAT_A]
    assert sorted(rig.keys('destroy')) == sorted([CHAT_C, CHAT_D])
    assert set(rig.backend.sandboxes) == {CHAT_A, CHAT_B}
    assert not rig.backend.sandboxes[CHAT_A].running


def test_the_startup_sweep_leaves_a_sandbox_this_manager_already_runs():
    async def scenario():
        rig = Rig()
        await rig.use(CHAT_A)
        rig.backend.calls.clear()
        await rig.manager.startup_sweep()
        return rig

    rig = run(scenario())
    assert rig.names() == ['list_sandboxes']
    assert rig.backend.sandboxes[CHAT_A].running


def test_failures_in_the_startup_sweep_are_logged_per_key_and_do_not_stop_the_rest(caplog):
    async def scenario():
        rig = Rig()
        await rig.make_volume(CHAT_A, running=True)
        await rig.make_volume(CHAT_B, running=True)
        real = rig.backend.stop

        async def stop(chat_id):
            if chat_id == CHAT_A:
                raise SandboxError('stuck')
            await real(chat_id)

        rig.backend.stop = stop
        await rig.manager.startup_sweep()
        return rig

    with caplog.at_level(logging.ERROR, logger='local_llm.sandbox.manager'):
        rig = run(scenario())
    assert rig.backend.sandboxes[CHAT_A].running
    assert not rig.backend.sandboxes[CHAT_B].running
    assert f'could not clean up sandbox {CHAT_A}' in caplog.text


def test_shutdown_without_stop_running_makes_no_backend_call():
    async def scenario():
        rig = Rig()
        await rig.use(CHAT_A)
        rig.backend.calls.clear()
        await rig.manager.shutdown(stop_running=False)
        return rig

    rig = run(scenario())
    assert rig.backend.calls == []
    assert rig.backend.sandboxes[CHAT_A].running


def test_shutdown_with_stop_running_stops_persistent_destroys_ephemeral_and_refuses_new_sessions():
    async def scenario():
        rig = Rig()
        await rig.use(CHAT_A)
        eph = await rig.use('temporary:benchmark-1')
        await rig.manager.shutdown(stop_running=True)
        with pytest.raises(SandboxError, match='shut down'):
            await rig.use(CHAT_B)
        return rig, eph

    rig, eph = run(scenario())
    assert rig.keys('stop') == [CHAT_A]
    assert rig.keys('destroy') == [eph]
    assert set(rig.backend.sandboxes) == {CHAT_A}
    assert not rig.backend.sandboxes[CHAT_A].running
    assert rig.keys('create') == [CHAT_A, eph]


def test_shutdown_frees_a_slot_a_waiting_session_wanted_and_that_session_then_raises():
    async def scenario():
        rig = Rig(max_running=1)
        await rig.use(CHAT_A)
        waiter = asyncio.create_task(rig.use(CHAT_B))
        await asyncio.sleep(0.05)
        await rig.manager.shutdown(stop_running=True)
        with pytest.raises(SandboxError, match='shut down'):
            await asyncio.wait_for(waiter, 1)
        return rig

    assert run(scenario()).keys('create') == [CHAT_A]


def test_a_failure_during_shutdown_is_logged_per_key_and_the_rest_are_still_cleaned(caplog):
    async def scenario():
        rig = Rig()
        await rig.use(CHAT_A)
        await rig.use(CHAT_B)
        real = rig.backend.stop

        async def stop(chat_id):
            if chat_id == CHAT_A:
                raise SandboxError('stuck')
            await real(chat_id)

        rig.backend.stop = stop
        await rig.manager.shutdown(stop_running=True)
        return rig

    with caplog.at_level(logging.ERROR, logger='local_llm.sandbox.manager'):
        rig = run(scenario())
    assert not rig.backend.sandboxes[CHAT_B].running
    assert f'could not clean up sandbox {CHAT_A}' in caplog.text


def test_the_startup_sweep_leaves_a_sandbox_a_session_starts_while_it_works_through_earlier_ones():
    async def scenario():
        rig = Rig()
        await rig.make_volume(CHAT_A, running=True)
        await rig.make_volume(CHAT_B, running=True)
        real_stop = rig.backend.stop
        entered = asyncio.Event()
        proceed = asyncio.Event()

        async def slow_stop(chat_id):
            if chat_id == CHAT_A:
                entered.set()
                await proceed.wait()
            await real_stop(chat_id)

        rig.backend.stop = slow_stop
        sweep = asyncio.create_task(rig.manager.startup_sweep())
        await entered.wait()
        t = clamp_timeout(10)
        async with rig.manager.session(CHAT_B, USER) as s:
            proceed.set()
            await sweep
            result = await s.exec(wrap_command('printf %s hi', t), t)
        return rig, result

    rig, result = run(scenario())
    assert rig.keys('stop') == [CHAT_A]
    assert rig.backend.running() == [CHAT_B]
    assert result.stdout == 'hi'


def test_an_unsaved_chat_refused_after_shutdown_leaves_no_mapping():
    async def scenario():
        rig = Rig()
        await rig.manager.shutdown(stop_running=True)
        with pytest.raises(SandboxError, match='shut down'):
            await rig.use('temporary:after')
        return rig

    assert run(scenario()).state() == {'used': 0, 'running': {}, 'locks': {}, 'unsaved': {}}


# Refused chats.


@pytest.mark.parametrize(
    'chat_id',
    ['', None, 123, 'not-a-uuid', 'saved-style-id', UPPER, UPPER.lower().replace('-', '')],
    ids=['empty', 'none', 'int', 'non-uuid', 'saved-style', 'uppercase', 'unhyphenated'],
)
def test_an_invalid_chat_id_is_refused_before_the_backend_is_called(chat_id):
    async def scenario():
        rig = Rig()
        with pytest.raises(SandboxRefused):
            await rig.use(chat_id)
        return rig

    rig = run(scenario())
    assert rig.backend.calls == []
    assert rig.settings_reads == 0
    assert rig.chats.usable_calls == []


@pytest.mark.parametrize(
    'chat_id, user',
    [
        (CHAT_A, OTHER),
        (str(uuid.UUID(int=999)), USER),
    ],
    ids=['another users chat', 'no such chat'],
)
def test_an_unusable_or_missing_saved_chat_is_refused_before_the_backend_is_called(chat_id, user):
    async def scenario():
        rig = Rig()
        with pytest.raises(SandboxRefused):
            await rig.use(chat_id, user=user)
        return rig

    rig = run(scenario())
    assert rig.backend.calls == []
    assert rig.settings_reads == 0
    assert len(rig.chats.usable_calls) == 1


def test_sandbox_refused_is_a_sandbox_error():
    assert issubclass(SandboxRefused, SandboxError)


@pytest.mark.parametrize(
    'user',
    [None, SimpleNamespace(), SimpleNamespace(id=None), SimpleNamespace(id=''), SimpleNamespace(id=7)],
    ids=['none', 'no id', 'id none', 'empty id', 'int id'],
)
def test_an_unsaved_chat_without_a_usable_user_id_is_refused_before_the_backend_is_called(user):
    async def scenario():
        rig = Rig()
        with pytest.raises(SandboxRefused):
            await rig.use('channel:abc', user=user)
        return rig

    rig = run(scenario())
    assert rig.backend.calls == []
    assert rig.settings_reads == 0


@pytest.mark.parametrize(
    'user',
    [{'id': 'u1'}, None, SimpleNamespace(), SimpleNamespace(id=''), SimpleNamespace(id=1)],
    ids=['dict', 'none', 'no id', 'empty id', 'int id'],
)
def test_a_saved_chat_without_a_str_user_id_is_refused_before_the_chat_is_looked_up(user):
    async def scenario():
        rig = Rig()
        with pytest.raises(SandboxRefused):
            await rig.use(CHAT_A, user=user)
        return rig

    rig = run(scenario())
    assert rig.backend.calls == []
    assert rig.chats.usable_calls == []


def test_a_saved_chat_whose_access_is_revoked_while_it_waits_for_a_slot_is_refused_and_frees_the_slot():
    async def scenario():
        rig = Rig(max_running=1)
        await rig.use(CHAT_A)
        waiter = asyncio.create_task(rig.use(CHAT_B))
        await settle()
        rig.chats.exist.discard(CHAT_B)
        await rig.manager.release(CHAT_A)
        with pytest.raises(SandboxRefused, match='may not run code'):
            await asyncio.wait_for(waiter, 1)
        return rig

    rig = run(scenario())
    assert rig.keys('create') == [CHAT_A]
    # Each start asks once on admission and again once it has its slot.
    assert [chat for chat, _ in rig.chats.usable_calls] == [CHAT_A, CHAT_A, CHAT_B, CHAT_B]
    assert rig.state() == {'used': 0, 'running': {}, 'locks': {}, 'unsaved': {}}


def test_an_unsaved_chat_id_longer_than_the_limit_is_refused_without_echoing_it():
    async def scenario():
        rig = Rig()
        longest = 'temporary:' + 'x' * (MAX_UNSAVED_CHAT_ID_LEN - len('temporary:'))
        await rig.use(longest)
        too_long = longest + 'y'
        with pytest.raises(SandboxRefused) as refused:
            await rig.use(too_long)
        return rig, too_long, str(refused.value)

    rig, too_long, message = run(scenario())
    assert MAX_UNSAVED_CHAT_ID_LEN == 200
    assert too_long not in message
    assert len(rig.state()['unsaved']) == 1
    assert len(rig.keys('create')) == 1


# Unsaved chats.


def test_a_temporary_chat_gets_an_ephemeral_sandbox_under_a_fresh_uuid_and_never_shows_its_id_to_the_backend():
    async def scenario():
        rig = Rig()
        chat_id = 'temporary:benchmark-0f8e'
        key = await rig.use(chat_id)
        await rig.use(chat_id)
        return rig, chat_id, key

    rig, chat_id, key = run(scenario())
    assert key != chat_id
    assert str(uuid.UUID(key)) == key
    (spec_call,) = [kwargs for name, kwargs in rig.backend.calls if name == 'create']
    assert spec_call['spec'].ephemeral is True
    assert spec_call['spec'].chat_id == key
    assert chat_id not in repr(rig.backend.calls)
    assert rig.chats.usable_calls == []


def test_the_sweep_leaves_a_running_ephemeral_sandbox_alone():
    async def scenario():
        rig = Rig()
        key = await rig.use('temporary:benchmark-1')
        rig.backend.calls.clear()
        await rig.manager.sweep_retention()
        return rig, key

    rig, key = run(scenario())
    assert rig.names('destroy') == []
    assert rig.chats.updated_calls == []
    assert rig.backend.sandboxes[key].running


def test_release_destroys_an_ephemeral_sandbox_with_its_volume_and_frees_its_slot():
    async def scenario():
        rig = Rig(max_running=1)
        key = await rig.use('temporary:benchmark-1')
        await rig.manager.release('temporary:benchmark-1')
        gone = key not in rig.backend.sandboxes
        # The slot is free again.
        await asyncio.wait_for(rig.use(CHAT_A), 1)
        return rig, key, gone

    rig, key, gone = run(scenario())
    assert gone
    assert rig.keys('destroy') == [key]


def test_a_released_unsaved_chat_gets_a_new_sandbox_under_a_new_key_next_time():
    async def scenario():
        rig = Rig()
        first = await rig.use('temporary:benchmark-1')
        await rig.manager.release('temporary:benchmark-1')
        second = await rig.use('temporary:benchmark-1')
        return first, second

    first, second = run(scenario())
    assert first != second


def test_two_users_of_one_channel_chat_get_different_sandboxes():
    async def scenario():
        rig = Rig()
        mine = await rig.use('channel:general', user=USER)
        theirs = await rig.use('channel:general', user=OTHER)
        again = await rig.use('channel:general', user=USER)
        return mine, theirs, again

    mine, theirs, again = run(scenario())
    assert mine != theirs
    assert again == mine


def test_another_users_temporary_chat_id_leads_to_a_different_sandbox():
    async def scenario():
        rig = Rig()
        mine = await rig.use('temporary:abc', user=USER)
        theirs = await rig.use('temporary:abc', user=OTHER)
        return mine, theirs

    mine, theirs = run(scenario())
    assert mine != theirs


def test_release_destroys_every_users_sandbox_for_an_unsaved_chat_and_frees_the_slots():
    async def scenario():
        rig = Rig(max_running=2)
        keys = [await rig.use('channel:x', user=USER), await rig.use('channel:x', user=OTHER)]
        await rig.manager.release('channel:x')
        await asyncio.wait_for(rig.use(CHAT_A), 1)
        await asyncio.wait_for(rig.use(CHAT_B), 1)
        return rig, keys

    rig, keys = run(scenario())
    assert sorted(rig.keys('destroy')) == sorted(keys)
    assert not set(keys) & set(rig.backend.sandboxes)


def test_release_leaves_other_unsaved_chats_alone():
    async def scenario():
        rig = Rig()
        gone = await rig.use('channel:x')
        kept = await rig.use('channel:y')
        await rig.manager.release('channel:x')
        return rig, gone, kept

    rig, gone, kept = run(scenario())
    assert rig.keys('destroy') == [gone]
    assert kept in rig.backend.sandboxes


def test_release_with_one_failing_destroy_destroys_the_others_raises_and_a_second_release_cleans_up(caplog):
    async def scenario():
        rig = Rig()
        keys = [await rig.use('channel:x', user=USER), await rig.use('channel:x', user=OTHER)]
        real = rig.backend.destroy
        failing = {'on': True}

        async def destroy(chat_id):
            if failing['on'] and chat_id == keys[0]:
                raise SandboxError('stuck')
            await real(chat_id)

        rig.backend.destroy = destroy
        with pytest.raises(SandboxError, match='stuck'):
            await rig.manager.release('channel:x')
        after_first = set(rig.backend.sandboxes)
        failing['on'] = False
        await rig.manager.release('channel:x')
        return rig, keys, after_first

    with caplog.at_level(logging.ERROR, logger='local_llm.sandbox.manager'):
        rig, keys, after_first = run(scenario())
    assert after_first == {keys[0]}
    assert rig.backend.sandboxes == {}
    assert 'could not release sandbox' in caplog.text


def test_release_of_a_saved_chat_destroys_its_volume():
    async def scenario():
        rig = Rig()
        await rig.use(CHAT_A)
        rig.backend.calls.clear()
        await rig.manager.release(CHAT_A)
        return rig

    rig = run(scenario())
    assert rig.keys('destroy') == [CHAT_A]
    assert rig.backend.sandboxes == {}


@pytest.mark.parametrize('chat_id', ['', None, 'not-a-uuid', 'temporary:never-used', 'channel:never-used'])
def test_release_of_an_id_no_sandbox_could_have_is_a_no_op_with_no_backend_call(chat_id):
    async def scenario():
        rig = Rig()
        await rig.manager.release(chat_id)
        return rig

    assert run(scenario()).backend.calls == []


def test_release_skips_an_unsaved_sandbox_destroyed_while_it_waited_for_the_lock():
    async def scenario():
        rig = Rig()
        async with rig.manager.session('channel:x', USER) as s:
            key = s.key
            # Both find the key at once, then queue on its lock behind the open session.
            first = asyncio.create_task(rig.manager.release('channel:x'))
            second = asyncio.create_task(rig.manager.release('channel:x'))
            await settle()
        await asyncio.gather(first, second)
        return rig, key

    rig, key = run(scenario())
    assert rig.keys('destroy') == [key]
    assert rig.state() == {'used': 0, 'running': {}, 'locks': {}, 'unsaved': {}}


def test_a_session_waiting_on_an_unsaved_sandbox_that_is_released_starts_a_fresh_one():
    async def scenario():
        rig = Rig()
        async with rig.manager.session('temporary:t', USER) as s:
            first = s.key
            releaser = asyncio.create_task(rig.manager.release('temporary:t'))
            await settle()
            # Queued on the lock behind the release (locks are FIFO), under the key the release destroys.
            waiter = asyncio.create_task(rig.use('temporary:t'))
            await settle()
        await releaser
        second = await asyncio.wait_for(waiter, 1)
        return rig, first, second

    rig, first, second = run(scenario())
    assert second != first
    assert rig.keys('destroy') == [first]
    assert rig.keys('create') == [first, second]


def test_failed_and_cancelled_starts_of_unsaved_chats_leave_no_mappings_slots_or_volumes():
    async def scenario():
        rig = Rig(max_running=1, slot_wait_timeout_s=0.1)
        rig.backend.fail_after_create = True
        for n in range(50):
            with pytest.raises(SandboxError, match='daemon failed'):
                await rig.use(f'temporary:fail-{n}')
        after_failures = (rig.state(), dict(rig.backend.sandboxes))
        rig.backend.fail_after_create = False
        hog = await rig.use('temporary:hog')
        # Cancelled while waiting for the slot the hog holds.
        waiters = [asyncio.create_task(rig.use(f'temporary:w{n}', user=OTHER)) for n in range(100)]
        await settle()
        for waiter in waiters:
            waiter.cancel()
        await asyncio.gather(*waiters, return_exceptions=True)
        # Gave up waiting; an on_wait that raises; a bad image.
        with pytest.raises(SandboxError, match='^no free sandbox: '):
            await rig.use('temporary:late')

        async def boom():
            raise RuntimeError('the client went away')

        with pytest.raises(RuntimeError, match='went away'):
            async with rig.manager.session('temporary:noticed', USER, on_wait=boom):
                pass
        with pytest.raises(ValueError):
            await rig.use('temporary:bad', image='bogus')
        await rig.manager.sweep_retention()
        return rig, hog, after_failures

    rig, hog, (state, volumes) = run(scenario())
    assert state == {'used': 0, 'running': {}, 'locks': {}, 'unsaved': {}}
    assert volumes == {}
    assert rig.state() == {
        'used': 1,
        'running': {hog: 'data'},
        'locks': {},
        'unsaved': {('temporary:hog', 'u1'): hog},
    }
    assert set(rig.backend.sandboxes) == {hog}


def test_a_failed_start_keeps_the_mapping_while_another_session_on_the_same_key_waits():
    async def scenario():
        rig = Rig(max_running=1, slot_wait_timeout_s=0.2)
        await rig.use(CHAT_A)
        first = asyncio.create_task(rig.use('temporary:t'))
        await settle()
        second = asyncio.create_task(rig.use('temporary:t'))
        await settle()
        key = rig.state()['unsaved'][('temporary:t', 'u1')]
        with pytest.raises(SandboxError, match='^no free sandbox: '):
            await first
        kept = rig.state()['unsaved'].get(('temporary:t', 'u1'))
        await rig.manager.release(CHAT_A)
        got = await asyncio.wait_for(second, 1)
        return key, kept, got

    key, kept, got = run(scenario())
    assert kept == key
    assert got == key


# Settings.


def test_the_settings_defaults_are_the_documented_ones():
    assert SandboxSettings() == SandboxSettings('data', 4, 30, 7)


@pytest.mark.parametrize(
    'kwargs',
    [
        {'default_image': 'bogus'},
        {'default_image': None},
        {'max_running': 0},
        {'max_running': 17},
        {'max_running': True},
        {'max_running': '4'},
        {'idle_minutes': 0},
        {'retention_days': 0},
        {'retention_days': 1.5},
    ],
)
def test_invalid_settings_are_refused(kwargs):
    with pytest.raises(ValueError, match='SandboxSettings'):
        SandboxSettings(**kwargs)


@pytest.mark.parametrize(
    'kwargs',
    [{'max_running': 1}, {'max_running': 16}, {'idle_minutes': 1}, {'retention_days': 365}, {'default_image': 'web'}],
)
def test_settings_inside_their_bounds_are_accepted(kwargs):
    assert SandboxSettings(**kwargs)


def _config_returns(monkeypatch, result):
    async def get_many(*keys):
        get_many.keys = keys
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(Config, 'get_many', staticmethod(get_many))
    return get_many


def test_settings_from_config_reads_every_key_with_one_get_many(monkeypatch):
    spy = _config_returns(
        monkeypatch,
        {
            'code_interpreter.sandbox.default_image': 'web',
            'code_interpreter.sandbox.max_running': 2,
            'code_interpreter.sandbox.idle_minutes': 5,
            'code_interpreter.sandbox.retention_days': 3,
        },
    )
    assert run(settings_from_config()) == SandboxSettings('web', 2, 5, 3)
    assert set(spy.keys) == set(SETTING_KEYS)
    assert len(spy.keys) == 4


def test_settings_from_config_uses_defaults_for_missing_and_none(monkeypatch):
    _config_returns(
        monkeypatch, {'code_interpreter.sandbox.max_running': None, 'code_interpreter.sandbox.idle_minutes': 9}
    )
    assert run(settings_from_config()) == SandboxSettings(idle_minutes=9)


def test_settings_from_config_uses_the_default_and_warns_for_an_invalid_value(monkeypatch, caplog):
    _config_returns(
        monkeypatch,
        {'code_interpreter.sandbox.max_running': 99, 'code_interpreter.sandbox.default_image': 'web'},
    )
    with caplog.at_level(logging.WARNING, logger='local_llm.sandbox.manager'):
        result = run(settings_from_config())
    assert result == SandboxSettings(default_image='web')
    assert 'code_interpreter.sandbox.max_running' in caplog.text


def test_settings_from_config_uses_every_default_when_config_cannot_be_read(monkeypatch, caplog):
    _config_returns(monkeypatch, RuntimeError('database is down'))
    with caplog.at_level(logging.ERROR, logger='local_llm.sandbox.manager'):
        result = run(settings_from_config())
    assert result == SandboxSettings()
    assert 'could not read the sandbox settings' in caplog.text


def test_a_manager_without_settings_reads_them_from_config(monkeypatch):
    _config_returns(monkeypatch, {'code_interpreter.sandbox.default_image': 'web'})

    async def scenario():
        backend = FakeBackend()
        manager = SandboxManager(backend, chats=FakeChats({CHAT_A: 1}))
        async with manager.session(CHAT_A, USER):
            pass
        return backend

    assert run(scenario()).sandboxes[CHAT_A].image == 'web'


# The maintenance loop.


def test_the_maintenance_loop_reaps_then_sweeps_and_survives_a_failing_pass(caplog):
    async def scenario():
        rig = Rig()
        order: list[str] = []

        async def reap():
            order.append('reap')
            if len(order) == 1:
                raise RuntimeError('reap broke')

        async def sweep():
            order.append('sweep')
            if order.count('sweep') == 1:
                raise RuntimeError('sweep broke')

        rig.manager.reap_idle = reap
        rig.manager.sweep_retention = sweep
        loop = asyncio.create_task(rig.manager.maintenance_loop(reap_every_s=0.001, sweep_every_s=0))
        while order.count('sweep') < 2:
            await asyncio.sleep(0.001)
        loop.cancel()
        with pytest.raises(asyncio.CancelledError):
            await loop
        return order

    with caplog.at_level(logging.ERROR, logger='local_llm.sandbox.manager'):
        order = run(scenario())
    assert order[:4] == ['reap', 'sweep', 'reap', 'sweep']
    assert 'the sandbox idle reaper failed' in caplog.text
    assert 'the sandbox retention sweep failed' in caplog.text


def test_the_maintenance_loop_sweeps_at_its_own_slower_interval():
    async def scenario():
        rig = Rig()
        counts = {'reap': 0, 'sweep': 0}

        async def reap():
            counts['reap'] += 1

        async def sweep():
            counts['sweep'] += 1

        rig.manager.reap_idle = reap
        rig.manager.sweep_retention = sweep
        loop = asyncio.create_task(rig.manager.maintenance_loop(reap_every_s=0.001, sweep_every_s=3600))
        while counts['reap'] < 5:
            await asyncio.sleep(0.001)
        loop.cancel()
        with pytest.raises(asyncio.CancelledError):
            await loop
        return counts

    counts = run(scenario())
    assert counts['sweep'] == 1
    assert counts['reap'] >= 5


# DatabaseChats, on the suite's temporary SQLite database.


def _db(scenario):
    async def go():
        async with async_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        return await scenario()

    return asyncio.run(go())


async def _add_chat(chat_id: str, user_id: str, *, created, updated, folder_id: str | None = None) -> None:
    async with get_async_db_context() as db:
        db.add(
            Chat(
                id=chat_id,
                user_id=user_id,
                title='t',
                chat={},
                created_at=created,
                updated_at=updated,
                folder_id=folder_id,
            )
        )
        await db.commit()


def test_database_chats_usable_is_true_for_the_owner_only_among_users():
    async def scenario():
        chat_id = str(uuid.uuid4())
        owner = SimpleNamespace(id=f'o-{uuid.uuid4().hex}', role='user')
        stranger = SimpleNamespace(id=f'x-{uuid.uuid4().hex}', role='user')
        await _add_chat(chat_id, owner.id, created=1, updated=2)
        chats = DatabaseChats()
        return (
            await chats.usable(chat_id, owner),
            await chats.usable(chat_id, stranger),
            await chats.usable(str(uuid.uuid4()), owner),
        )

    assert _db(scenario) == (True, False, False)


def test_database_chats_updated_at_returns_only_existing_ids():
    async def scenario():
        first, second, missing = (str(uuid.uuid4()) for _ in range(3))
        await _add_chat(first, 'u', created=10, updated=20)
        await _add_chat(second, 'u', created=30, updated=40)
        return first, second, await DatabaseChats().updated_at([first, second, missing])

    first, second, found = _db(scenario)
    assert found == {first: 20, second: 40}


def test_database_chats_updated_at_of_an_empty_list_is_empty():
    assert _db(lambda: DatabaseChats().updated_at([])) == {}


def test_database_chats_updated_at_falls_back_to_created_at_then_to_now():
    async def scenario():
        only_created, neither = str(uuid.uuid4()), str(uuid.uuid4())
        await _add_chat(only_created, 'u', created=77, updated=None)
        await _add_chat(neither, 'u', created=None, updated=None)
        before = int(time.time())
        found = await DatabaseChats().updated_at([only_created, neither])
        return only_created, neither, before, found

    only_created, neither, before, found = _db(scenario)
    assert found[only_created] == 77
    assert before <= found[neither] <= int(time.time())


def test_a_manager_without_a_chat_lookup_uses_the_database():
    async def scenario():
        chat_id = str(uuid.uuid4())
        owner = SimpleNamespace(id=f'o-{uuid.uuid4().hex}', role='user')
        await _add_chat(chat_id, owner.id, created=1, updated=2)
        backend = FakeBackend()
        manager = SandboxManager(backend, settings=Rig()._read_settings)
        async with manager.session(chat_id, owner) as s:
            key = s.key
        with pytest.raises(SandboxRefused):
            async with manager.session(chat_id, SimpleNamespace(id='nobody', role='user')):
                pass
        return chat_id, key

    chat_id, key = _db(scenario)
    assert key == chat_id


@pytest.mark.parametrize('enabled', [True, False], ids=['admin chat access on', 'admin chat access off'])
def test_database_chats_lets_an_admin_use_another_users_existing_chat_only_as_the_chat_endpoint_does(
    monkeypatch, enabled
):
    monkeypatch.setattr(chats_model, 'ENABLE_ADMIN_CHAT_ACCESS', enabled)

    async def scenario():
        chat_id = str(uuid.uuid4())
        await _add_chat(chat_id, f'o-{uuid.uuid4().hex}', created=1, updated=2)
        admin = SimpleNamespace(id=f'a-{uuid.uuid4().hex}', role='admin')
        chats = DatabaseChats()
        return await chats.usable(chat_id, admin), await chats.usable(str(uuid.uuid4()), admin)

    assert _db(scenario) == (enabled, False)


def test_database_chats_refuses_an_admin_when_the_chat_lookup_fails_and_logs_it(monkeypatch, caplog):
    monkeypatch.setattr(chats_model, 'ENABLE_ADMIN_CHAT_ACCESS', True)

    async def broken(self, chat_ids):
        raise RuntimeError('database is down')

    monkeypatch.setattr(DatabaseChats, 'updated_at', broken)

    async def scenario():
        chat_id = str(uuid.uuid4())
        await _add_chat(chat_id, f'o-{uuid.uuid4().hex}', created=1, updated=2)
        admin = SimpleNamespace(id=f'a-{uuid.uuid4().hex}', role='admin')
        return chat_id, await DatabaseChats().usable(chat_id, admin)

    with caplog.at_level(logging.ERROR, logger='local_llm.sandbox.manager'):
        chat_id, usable = _db(scenario)
    assert usable is False
    assert f'could not look chat {chat_id} up for an admin' in caplog.text


@pytest.mark.parametrize('enabled', [True, False], ids=['admin chat access on', 'admin chat access off'])
@pytest.mark.parametrize('role', ['admin', 'user'])
def test_database_chats_admin_rule_agrees_with_the_chat_endpoints(monkeypatch, role, enabled):
    # DatabaseChats.usable and main.py's chat endpoints share models/chats.py's admin_reaches_other_chats.
    from local_llm import main

    monkeypatch.setattr(chats_model, 'ENABLE_ADMIN_CHAT_ACCESS', enabled)
    user = SimpleNamespace(id=f'{role}-{uuid.uuid4().hex}', role=role)

    async def scenario():
        # Another user's existing chat, so only the admin rule can let this user in.
        chat_id = str(uuid.uuid4())
        await _add_chat(chat_id, f'o-{uuid.uuid4().hex}', created=1, updated=2)
        return await DatabaseChats().usable(chat_id, user)

    assert _db(scenario) == main.admin_reaches_other_chats(user) == (role == 'admin' and enabled)


def test_database_chats_refuses_a_folder_reader_the_chat_read_rule_lets_in():
    async def scenario():
        chat_id, folder_id = str(uuid.uuid4()), str(uuid.uuid4())
        reader = SimpleNamespace(id=f'r-{uuid.uuid4().hex}', role='user')
        async with get_async_db_context() as db:
            db.add(Folder(id=folder_id, user_id=reader.id, name='shared', created_at=1, updated_at=1))
            await db.commit()
        await _add_chat(chat_id, f'o-{uuid.uuid4().hex}', created=1, updated=2, folder_id=folder_id)
        reads = await Chats.get_chat_by_id_for_user(chat_id, reader) is not None
        return reads, await DatabaseChats().usable(chat_id, reader)

    assert _db(scenario) == (True, False)


# SandboxSession's backend calls under cancellation (T12's security reviews: B1, R1, R2, R5). A session may not
# end, and so hand its lock on, while a backend call it started may still act on the sandbox.


class _HeldBackend(FakeBackend):
    """A FakeBackend whose exec, put_files, get_files and stat wait for `release` and log when they end.

    `cancelled_outcome`, when set, is what exec ends in once it is cancelled: a result, or an exception to raise.
    `ignore_cancel` makes every call go on waiting for `release` through a cancellation, and `fail_late` makes
    it raise once released.
    """

    def __init__(self, log: list[str], *, cancelled_outcome: object = None, ignore_cancel: bool = False) -> None:
        super().__init__()
        self.log = log
        self.cancelled_outcome = cancelled_outcome
        self.ignore_cancel = ignore_cancel
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.fail_late = False

    async def _held(self, what: str) -> None:
        self.started.set()
        while True:
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                if self.ignore_cancel:
                    continue
                raise
            if self.fail_late:
                raise RuntimeError('the daemon call failed after its caller had gone')
            self.log.append(f'{what} ended')
            return

    async def exec(self, chat_id, argv, timeout_s, stdin=None):
        try:
            await self._held('exec')
        except asyncio.CancelledError:
            if isinstance(self.cancelled_outcome, BaseException):
                raise self.cancelled_outcome from None
            if self.cancelled_outcome is None:
                raise
            return cast(manager_module.ExecResult, self.cancelled_outcome)
        return manager_module.ExecResult(
            returncode=0, stdout='', stderr='', timed_out=False, truncated=False, duration_ms=1
        )

    async def put_files(self, chat_id, dir, files):
        await self._held('put_files')

    async def get_files(self, chat_id, paths, max_bytes):
        await self._held('get_files')
        return {}

    async def stat(self, chat_id, path):
        await self._held('stat')
        return None


_SESSION_CALLS = {
    'exec': lambda session: session.exec(wrap_command('true', 60), 60),
    'put_files': lambda session: session.put_files('uploads', []),
    'get_files': lambda session: session.get_files(['/workspace/f'], 10),
    'stat': lambda session: session.stat('/workspace/f'),
}


async def _second_session(manager: SandboxManager, log: list[str]) -> None:
    async with manager.session(CHAT_A, USER):
        log.append('second session')


@pytest.mark.parametrize('call', ['put_files', 'get_files', 'stat'])
def test_a_cancelled_put_read_or_stat_keeps_the_lock_until_the_backend_call_has_ended(call):
    # R1: the daemon may still be untarring into /workspace when the user presses Stop.
    log: list[str] = []
    backend = _HeldBackend(log)
    manager = SandboxManager(backend, chats=FakeChats({CHAT_A: 1}))

    async def go():
        async def first_call():
            async with manager.session(CHAT_A, USER) as session:
                await _SESSION_CALLS[call](session)

        first = asyncio.ensure_future(first_call())
        await backend.started.wait()
        first.cancel()
        second = asyncio.ensure_future(_second_session(manager, log))
        for _ in range(20):
            await asyncio.sleep(0)
        log.append('released')
        backend.release.set()
        return await asyncio.gather(first, second, return_exceptions=True)

    first, second = asyncio.run(go())
    assert isinstance(first, asyncio.CancelledError)
    assert second is None
    assert log == ['released', f'{call} ended', 'second session']


@pytest.mark.parametrize(
    ('outcome', 'stopped'),
    [
        (None, False),
        (SandboxError('the exec failed'), False),
        (SandboxNotRunning('the kill could not be confirmed'), True),
        (
            manager_module.ExecResult(
                returncode=0, stdout='', stderr='', timed_out=False, truncated=False, duration_ms=1
            ),
            False,
        ),
    ],
    ids=['cancelled', 'error', 'not-running', 'result'],
)
def test_a_cancelled_session_exec_raises_cancelled_error_whatever_the_backend_ends_with(outcome, stopped):
    # B1: whatever the backend's exec ends in once cancelled, the caller gets CancelledError; a sandbox the backend
    # stopped (its kill failed) is cleaned up when the session ends, freeing its slot.
    backend = _HeldBackend([], cancelled_outcome=outcome)
    manager = SandboxManager(backend, chats=FakeChats({CHAT_A: 1}))

    async def go():
        async def call():
            async with manager.session(CHAT_A, USER) as session:
                await session.exec(wrap_command('true', 60), 60)

        task = asyncio.ensure_future(call())
        await backend.started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(go())
    assert (('stop', {'chat_id': CHAT_A}) in backend.calls) is stopped
    assert not manager._locks


class _InterruptibleKillBackend(FakeBackend):
    """A backend that honours one cancellation the naive way, `except CancelledError: await kill(); raise`.

    Its kill takes a few event-loop turns, so a second cancellation delivered to it meanwhile would cut the kill
    short: only the session's own wait keeps the lock until the kill has run.
    """

    def __init__(self, log: list[str]) -> None:
        super().__init__()
        self.log = log
        self.started = asyncio.Event()

    async def exec(self, chat_id, argv, timeout_s, stdin=None):
        self.started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            for _ in range(10):
                await asyncio.sleep(0)
            self.log.append('kill')
            raise
        raise AssertionError('the exec is only ever cancelled')


def test_the_session_keeps_the_lock_through_a_second_cancellation_while_the_backend_kills():
    # B1, pinned on the session: with a backend whose kill a second cancellation could interrupt, the second
    # session still waits until that kill has run. The old `return await backend.exec(...)` fails this.
    log: list[str] = []
    backend = _InterruptibleKillBackend(log)
    manager = SandboxManager(backend, chats=FakeChats({CHAT_A: 1}))

    async def go():
        async def first_call():
            async with manager.session(CHAT_A, USER) as session:
                await session.exec(wrap_command('slow', 60), 60)

        first = asyncio.ensure_future(first_call())
        await backend.started.wait()
        first.cancel()
        second = asyncio.ensure_future(_second_session(manager, log))
        await asyncio.sleep(0)
        first.cancel()
        return await asyncio.gather(first, second, return_exceptions=True)

    first, second = asyncio.run(go())
    assert isinstance(first, asyncio.CancelledError)
    assert second is None
    assert log == ['kill', 'second session']


@pytest.mark.parametrize('ends_with', ['result', 'error'])
def test_a_cancelled_call_that_never_ends_is_given_up_after_the_bound_and_the_sandbox_stopped_first(ends_with):
    # R2: the wait after a cancellation is bounded; past it, the sandbox is stopped, still under its lock, before the
    # next session may use it, and the abandoned call is kept until it ends.
    log: list[str] = []
    backend = _HeldBackend(log, ignore_cancel=True)
    manager = SandboxManager(backend, chats=FakeChats({CHAT_A: 1}), cancel_wait_s=0.05)

    async def go():
        async def first_call():
            async with manager.session(CHAT_A, USER) as session:
                await session.exec(wrap_command('true', 60), 60)

        first = asyncio.ensure_future(first_call())
        await backend.started.wait()
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        stopped_before = ('stop', {'chat_id': CHAT_A}) in backend.calls
        abandoned = len(manager_module._ABANDONED)
        backend.fail_late = ends_with == 'error'
        backend.release.set()
        for _ in range(5):
            await asyncio.sleep(0)
        await _second_session(manager, log)
        return stopped_before, abandoned, len(manager_module._ABANDONED)

    stopped_before, abandoned, left = asyncio.run(go())
    assert stopped_before
    assert (abandoned, left) == (1, 0)
    assert log[-1] == 'second session'


def test_a_backend_call_that_ends_cancelled_on_its_own_is_a_sandbox_error_not_an_escaping_cancellation():
    # R5: a cancellation the caller did not ask for must not escape a tool's `except Exception`.
    class _SelfCancelling(FakeBackend):
        async def stat(self, chat_id, path):
            raise asyncio.CancelledError

    manager = SandboxManager(_SelfCancelling(), chats=FakeChats({CHAT_A: 1}))

    async def go():
        async with manager.session(CHAT_A, USER) as session:
            await session.stat('/workspace/f')

    with pytest.raises(SandboxError) as caught:
        asyncio.run(go())
    assert caught.value.public == 'the sandbox call was interrupted; try again'
