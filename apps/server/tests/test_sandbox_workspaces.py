"""The workspace cap and deletion dialog (T24, owner decision Q15): the manager, the stores, the listing and the routes.

Pins, against FakeBackend and MemoryWorkspaces (and DatabaseWorkspaces on
the test database):

- a user's (max_workspaces + 1)th persistent workspace is not created: the
  session raises a SandboxError the model can relay, records one `cap`
  request however often it is retried, and holds no slot; removing a
  workspace (the one asked about, or another) lets the next call create it,
  and `keep` leaves it uncreated; ephemeral sandboxes do not count, and two
  chats of one user cannot both take the last place;
- the retention sweep marks a workspace `expired` by its record's last use
  and never destroys it; `keep` resets its last use, `remove` destroys it; a
  use answers it; a deleted chat's volume still goes, with its record;
- every answer acts only on the caller's own workspaces;
- the listing of a workspace is capped, with totals, and runs without the
  sandbox;
- the routes: the caller's pending workspaces with their contents, 404 for
  another user's, the answer's status codes.

Run from apps/server (any LLLM_SECRET_KEY of 32 characters or more):

    LLLM_SECRET_KEY=... python -m pytest tests/test_sandbox_workspaces.py
"""

from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import logging
import uuid
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_llm.internal.db import get_async_db_context
from local_llm.models.chats import Chat
from local_llm.models.users import Users
from local_llm.routers import sandbox as sandbox_router
from local_llm.sandbox import (
    SandboxError,
    SandboxManager,
    SandboxRefused,
    SandboxSettings,
    SandboxSpec,
    WorkspaceBusy,
    WorkspaceNotFound,
)
from local_llm.sandbox import manager as manager_module
from local_llm.sandbox.backend import validate_list_workspace
from local_llm.sandbox.fake import FakeBackend, FakeFile
from local_llm.sandbox.limits import LIST_MAX_ENTRIES, SANDBOX_UID
from local_llm.sandbox.manager import (
    LISTING_CACHE_SIZE,
    PRUNE_AFTER_S,
    ListingBusy,
    WorkspaceChanged,
    cap_message,
    cap_unanswered_message,
)
from local_llm.sandbox.workspaces import DatabaseWorkspaces, MemoryWorkspaces, WorkspaceRecord
from local_llm.utils.auth import create_token

DAY = 86_400
WALL_NOW = 50_000_000
ALICE = SimpleNamespace(id='alice', role='user')
BOB = SimpleNamespace(id='bob', role='user')
ADMIN = SimpleNamespace(id='root', role='admin')


def chat(n: int) -> str:
    return str(uuid.UUID(int=1000 + n))


class Chats:
    """A ChatLookup over a dict of chat id -> owner: the owner may use a chat, and so may ADMIN (Q14)."""

    def __init__(self, owners: dict[str, str]) -> None:
        self.owners = owners

    async def usable(self, chat_id, user):
        return chat_id in self.owners and (user.id == self.owners[chat_id] or user.id == ADMIN.id)

    async def updated_at(self, chat_ids):
        return {c: WALL_NOW for c in chat_ids if c in self.owners}


class Rig:
    """A manager on a FakeBackend with MemoryWorkspaces, chats 0..9 owned by alice and 10..19 by bob."""

    def __init__(self, *, max_workspaces: int = 3, retention_days: int = 7) -> None:
        self.backend = FakeBackend()
        self.owners = {chat(n): ('alice' if n < 10 else 'bob') for n in range(20)}
        self.chats = Chats(self.owners)
        self.store = MemoryWorkspaces(self.owners, default_owner=None, titles={chat(n): f'Chat {n}' for n in range(20)})
        self.wall = float(WALL_NOW)
        self.settings = SandboxSettings(max_workspaces=max_workspaces, retention_days=retention_days)
        self.manager = SandboxManager(
            self.backend,
            settings=self._settings,
            chats=self.chats,
            workspaces=self.store,
            wall_clock=lambda: self.wall,
        )

    async def _settings(self) -> SandboxSettings:
        return self.settings

    async def use(self, chat_id: str, user=ALICE) -> str:
        async with self.manager.session(chat_id, user) as s:
            return s.key

    def creates(self, key: str) -> int:
        return sum(1 for name, kwargs in self.backend.calls if name == 'create' and kwargs['chat_id'] == key)

    def pending(self) -> dict[str, tuple[str | None, str | None]]:
        return {
            r.key: (r.pending_reason, r.pending_for)
            for r in self.store.records.values()
            if r.pending_reason is not None
        }


def run(coro):
    return asyncio.run(coro)


# The cap.


def test_the_cap_blocks_the_next_workspace_and_records_one_request():
    async def scenario():
        rig = Rig(max_workspaces=3)
        for n in range(3):
            await rig.use(chat(n))
            rig.wall += 10
        errors = []
        for _ in range(3):
            with pytest.raises(SandboxError) as raised:
                await rig.use(chat(3))
            errors.append(raised.value)
        return rig, errors

    rig, errors = run(scenario())
    assert rig.creates(chat(3)) == 0
    assert chat(3) not in rig.backend.sandboxes
    assert chat(3) not in rig.store.records
    # One request, however often the model retries, on alice's least recently used workspace.
    assert rig.pending() == {chat(0): ('cap', chat(3))}
    assert all(e.public == cap_message(3) for e in errors)
    assert 'the most allowed' in errors[0].public and 'asked in the app to remove one' in errors[0].public
    # Nothing tracked, no lock kept.
    assert chat(3) not in rig.manager._tracked
    assert rig.manager._locks == {}


def test_removing_the_workspace_asked_about_lets_the_next_call_create():
    async def scenario():
        rig = Rig(max_workspaces=2)
        await rig.use(chat(0))
        await rig.use(chat(1))
        with pytest.raises(SandboxError):
            await rig.use(chat(2))
        await rig.manager.answer_pending('alice', chat(0), 'remove')
        removed = chat(0) not in rig.backend.sandboxes and chat(0) not in rig.store.records
        await rig.use(chat(2))
        return rig, removed

    rig, removed = run(scenario())
    assert removed
    assert rig.creates(chat(2)) == 1
    assert set(rig.store.records) == {chat(1), chat(2)}
    assert rig.pending() == {}


def test_removing_another_workspace_for_a_cap_request_clears_it_and_lets_the_next_call_create():
    async def scenario():
        rig = Rig(max_workspaces=2)
        await rig.use(chat(0))
        rig.wall += 10
        await rig.use(chat(1))
        with pytest.raises(SandboxError):
            await rig.use(chat(2))
        await rig.manager.answer_pending('alice', chat(0), 'remove', workspace=chat(1))
        between = rig.pending()
        await rig.use(chat(2))
        return rig, between

    rig, between = run(scenario())
    assert between == {}
    assert set(rig.store.records) == {chat(0), chat(2)}
    assert chat(1) not in rig.backend.sandboxes


def test_keep_on_a_cap_request_leaves_the_new_workspace_uncreated_and_a_later_call_asks_again():
    async def scenario():
        rig = Rig(max_workspaces=1)
        await rig.use(chat(0))
        with pytest.raises(SandboxError):
            await rig.use(chat(1))
        await rig.manager.answer_pending('alice', chat(0), 'keep')
        after_keep = rig.pending()
        last_used = rig.store.records[chat(0)].last_used_at
        with pytest.raises(SandboxError):
            await rig.use(chat(1))
        return rig, after_keep, last_used

    rig, after_keep, last_used = run(scenario())
    assert after_keep == {}
    # Keeping for the cap is not a use: its last use stays.
    assert last_used == WALL_NOW
    assert rig.creates(chat(1)) == 0
    assert rig.pending() == {chat(0): ('cap', chat(1))}


def test_room_made_some_other_way_clears_the_request_when_the_waiting_chat_creates():
    async def scenario():
        rig = Rig(max_workspaces=1)
        await rig.use(chat(0))
        with pytest.raises(SandboxError):
            await rig.use(chat(1))
        # The admin raises the limit instead.
        rig.settings = SandboxSettings(max_workspaces=2)
        await rig.use(chat(1))
        return rig

    rig = run(scenario())
    assert rig.pending() == {}
    assert set(rig.store.records) == {chat(0), chat(1)}


def test_each_waiting_chat_gets_its_own_request_on_another_workspace():
    async def scenario():
        rig = Rig(max_workspaces=2)
        await rig.use(chat(0))
        rig.wall += 10
        await rig.use(chat(1))
        errors = []
        for waiting in (chat(2), chat(3), chat(4), chat(2)):
            with pytest.raises(SandboxError) as raised:
                await rig.use(waiting)
            errors.append(raised.value.public)
        return rig, errors

    rig, errors = run(scenario())
    # The third waiting chat finds every workspace asked about already: it is refused, and nothing more recorded,
    # so it is not told that the user has been asked; the first is still told so on a retry.
    assert rig.pending() == {chat(0): ('cap', chat(2)), chat(1): ('cap', chat(3))}
    assert errors == [cap_message(2), cap_message(2), cap_unanswered_message(2), cap_message(2)]
    assert 'has not yet answered' in errors[2] and 'asked in the app to remove one' not in errors[2]


def test_at_the_cap_the_refusal_comes_at_once_with_every_slot_taken_and_evicts_nothing():
    async def scenario():
        rig = Rig(max_workspaces=1)
        rig.settings = SandboxSettings(max_workspaces=1, max_running=1)
        rig.manager._evict_idle_s = 0
        await rig.use(chat(0))
        with pytest.raises(SandboxError):
            await asyncio.wait_for(rig.use(chat(1)), 1)
        return rig

    rig = run(scenario())
    # chat 0 still runs: nothing was stopped to make room for a chat that gets no workspace.
    assert rig.backend.sandboxes[chat(0)].running
    assert [name for name, _ in rig.backend.calls if name in ('stop', 'destroy')] == []


def test_a_start_that_fails_before_creating_drops_the_record_it_added():
    async def scenario():
        rig = Rig()
        rig.settings = SandboxSettings(max_running=1)
        rig.manager._slot_wait_timeout_s = 0.05
        rig.manager._evict_idle_s = 3600
        await rig.use(chat(0))
        # No slot comes free in time.
        with pytest.raises(SandboxError, match='no free sandbox'):
            await rig.use(chat(1))
        no_slot = chat(1) in rig.store.records
        # Access is revoked while it waits for a slot.
        await rig.manager.release(chat(0))
        real = rig.chats.usable
        asked: list[str] = []

        async def revoked(chat_id, user):
            asked.append(chat_id)
            return len(asked) == 1 and await real(chat_id, user)

        rig.chats.usable = revoked
        with pytest.raises(SandboxRefused):
            await rig.use(chat(2))
        return rig, no_slot

    rig, no_slot = run(scenario())
    assert not no_slot
    assert chat(2) not in rig.store.records
    assert rig.creates(chat(1)) == rig.creates(chat(2)) == 0


def test_ephemeral_sandboxes_do_not_count():
    async def scenario():
        rig = Rig(max_workspaces=1)
        await rig.use(chat(0))
        for n in range(3):
            await rig.use(f'temporary:{n}')
        return rig

    rig = run(scenario())
    assert set(rig.store.records) == {chat(0)}
    assert rig.pending() == {}


def test_the_cap_is_per_owner_and_an_admin_s_run_counts_for_the_chat_s_owner():
    async def scenario():
        rig = Rig(max_workspaces=1)
        await rig.use(chat(10), BOB)
        await rig.use(chat(0), ADMIN)
        with pytest.raises(SandboxError):
            await rig.use(chat(1), ALICE)
        return rig

    rig = run(scenario())
    assert rig.store.records[chat(0)].user_id == 'alice'
    assert rig.store.records[chat(10)].user_id == 'bob'
    assert rig.pending() == {chat(0): ('cap', chat(1))}


def test_two_chats_of_one_user_cannot_both_take_the_last_place():
    async def scenario():
        rig = Rig(max_workspaces=2)
        await rig.use(chat(0))
        results = await asyncio.gather(rig.use(chat(1)), rig.use(chat(2)), return_exceptions=True)
        return rig, results

    rig, results = run(scenario())
    assert sorted(type(r).__name__ for r in results) == ['SandboxError', 'str']
    assert len(rig.store.records) == 2


def test_a_chat_without_an_owner_is_refused():
    async def scenario():
        rig = Rig()
        # The chat lookup still lets it in, but its row is gone by the time the workspace is claimed.
        del rig.store.owners[chat(0)]
        with pytest.raises(SandboxRefused):
            await rig.use(chat(0))
        return rig

    rig = run(scenario())
    assert rig.creates(chat(0)) == 0
    assert rig.manager._tracked == {}


def test_a_store_that_fails_refuses_the_session_with_a_fixed_text_and_frees_the_slot(caplog):
    async def scenario():
        rig = Rig()

        async def broken(key):
            raise RuntimeError('postgres://secret@db is down')

        rig.store.get = broken
        with pytest.raises(SandboxError) as raised:
            await rig.use(chat(0))
        return rig, raised.value

    with caplog.at_level(logging.ERROR, logger='local_llm.sandbox.manager'):
        rig, error = run(scenario())
    assert error.public is not None and 'secret' not in error.public
    assert rig.creates(chat(0)) == 0
    assert rig.manager._tracked == {}
    assert 'could not check the workspace record' in caplog.text


def test_a_session_records_its_use_when_it_ends_and_a_use_answers_an_expired_request():
    async def scenario():
        rig = Rig()
        await rig.use(chat(0))
        await rig.store.set_pending(chat(0), 'expired', WALL_NOW, None)
        rig.wall += 100
        await rig.use(chat(0))
        return rig

    rig = run(scenario())
    record = rig.store.records[chat(0)]
    assert record.last_used_at == WALL_NOW + 100
    assert record.pending_reason is None


def test_a_failed_use_record_is_logged_and_the_call_still_succeeds(caplog):
    async def scenario():
        rig = Rig()
        await rig.use(chat(0))

        async def broken(key, now):
            raise RuntimeError('down')

        rig.store.touch = broken
        return await rig.use(chat(0))

    with caplog.at_level(logging.ERROR, logger='local_llm.sandbox.manager'):
        assert run(scenario()) == chat(0)
    assert 'could not record the use of workspace' in caplog.text


def test_release_drops_the_record():
    async def scenario():
        rig = Rig()
        await rig.use(chat(0))
        await rig.manager.release(chat(0))
        return rig

    assert run(scenario()).store.records == {}


# Expiry.


def test_expiry_marks_pending_and_never_destroys():
    async def scenario():
        rig = Rig(retention_days=7)
        await rig.use(chat(0))
        await rig.backend.stop(chat(0))
        rig.manager._forget(chat(0))
        for _ in range(3):
            rig.wall += 8 * DAY
            await rig.manager.sweep_retention()
        return rig

    rig = run(scenario())
    assert rig.pending() == {chat(0): ('expired', None)}
    assert rig.store.records[chat(0)].pending_since == WALL_NOW + 8 * DAY
    assert chat(0) in rig.backend.sandboxes
    assert [name for name, _ in rig.backend.calls if name == 'destroy'] == []


def test_keep_on_an_expired_workspace_resets_its_last_use():
    async def scenario():
        rig = Rig(retention_days=7)
        await rig.use(chat(0))
        await rig.backend.stop(chat(0))
        rig.manager._forget(chat(0))
        rig.wall += 8 * DAY
        await rig.manager.sweep_retention()
        await rig.manager.answer_pending('alice', chat(0), 'keep')
        kept = rig.store.records[chat(0)]
        # Not asked about again until it expires again.
        rig.wall += 6 * DAY
        await rig.manager.sweep_retention()
        early = rig.pending()
        rig.wall += 2 * DAY
        await rig.manager.sweep_retention()
        return rig, kept, early

    rig, kept, early = run(scenario())
    assert (kept.pending_reason, kept.last_used_at) == (None, WALL_NOW + 8 * DAY)
    assert early == {}
    assert rig.pending() == {chat(0): ('expired', None)}


def test_remove_on_an_expired_workspace_destroys_it_and_another_cannot_be_named():
    async def scenario():
        rig = Rig(retention_days=7)
        await rig.use(chat(0))
        await rig.use(chat(1))
        for key in (chat(0), chat(1)):
            await rig.backend.stop(key)
            rig.manager._forget(key)
        rig.store.records[chat(1)] = WorkspaceRecord(chat(1), 'alice', chat(1), WALL_NOW, WALL_NOW + 30 * DAY)
        rig.wall += 8 * DAY
        await rig.manager.sweep_retention()
        with pytest.raises(ValueError, match='expired'):
            await rig.manager.answer_pending('alice', chat(0), 'remove', workspace=chat(1))
        with pytest.raises(ValueError, match='keep names no workspace'):
            await rig.manager.answer_pending('alice', chat(0), 'keep', workspace=chat(0))
        with pytest.raises(ValueError, match='remove or keep'):
            await rig.manager.answer_pending('alice', chat(0), 'delete')
        await rig.manager.answer_pending('alice', chat(0), 'remove')
        return rig

    rig = run(scenario())
    assert chat(0) not in rig.backend.sandboxes and chat(0) not in rig.store.records
    assert chat(1) in rig.backend.sandboxes and chat(1) in rig.store.records


def test_a_deleted_chat_s_volume_still_goes_with_its_record(caplog):
    async def scenario():
        rig = Rig()
        await rig.use(chat(0))
        await rig.backend.stop(chat(0))
        rig.manager._forget(chat(0))
        del rig.owners[chat(0)]
        await rig.manager.sweep_retention()
        return rig

    with caplog.at_level(logging.INFO, logger='local_llm.sandbox.manager'):
        rig = run(scenario())
    assert chat(0) not in rig.backend.sandboxes
    assert rig.store.records == {}
    assert f'destroyed sandbox volume {chat(0)} (chat deleted)' in caplog.text


def test_the_sweep_records_a_volume_made_before_the_records_and_drops_a_record_without_a_volume():
    async def scenario():
        rig = Rig()
        # A volume from before T24, and two records whose create never finished: one old, one recent.
        await rig.backend.create(chat(0), SandboxSpec(chat(0), 'data'))
        await rig.backend.stop(chat(0))
        rig.store.records[chat(1)] = WorkspaceRecord(chat(1), 'alice', chat(1), WALL_NOW - PRUNE_AFTER_S - 1, 0)
        rig.store.records[chat(2)] = WorkspaceRecord(chat(2), 'alice', chat(2), WALL_NOW - 10, 0)
        await rig.manager.sweep_retention()
        return rig

    rig = run(scenario())
    assert set(rig.store.records) == {chat(0), chat(2)}
    adopted = rig.store.records[chat(0)]
    assert (adopted.user_id, adopted.last_used_at, adopted.pending_reason) == ('alice', WALL_NOW, None)


def test_a_failure_while_judging_expiry_is_logged_and_the_pass_goes_on(caplog):
    async def scenario():
        rig = Rig()
        for key in (chat(0), chat(1)):
            await rig.use(key)
            await rig.backend.stop(key)
            rig.manager._forget(key)
        real = rig.store.get

        async def flaky(key):
            if key == chat(0):
                raise RuntimeError('down')
            return await real(key)

        rig.store.get = flaky
        rig.wall += 8 * DAY
        await rig.manager.sweep_retention()
        return rig

    with caplog.at_level(logging.ERROR, logger='local_llm.sandbox.manager'):
        rig = run(scenario())
    assert rig.pending() == {chat(1): ('expired', None)}
    assert f'could not judge the expiry of workspace {chat(0)}' in caplog.text


# Answers act only on the caller's own workspaces.


def test_answers_refuse_another_user_s_workspace_as_if_it_did_not_exist():
    async def scenario():
        rig = Rig(max_workspaces=1)
        await rig.use(chat(0))
        await rig.use(chat(10), BOB)
        with pytest.raises(SandboxError):
            await rig.use(chat(1))
        with pytest.raises(SandboxError):
            await rig.use(chat(11), BOB)
        outcomes = []
        for args in (
            ('bob', chat(0), 'remove'),
            ('bob', chat(0), 'keep'),
            ('alice', chat(0), 'remove', chat(10)),
            ('alice', str(uuid.uuid4()), 'keep'),
            ('alice', chat(1), 'keep'),
        ):
            with pytest.raises(WorkspaceNotFound):
                await rig.manager.answer_pending(*args)
            outcomes.append(args)
        return rig

    rig = run(scenario())
    assert {chat(0), chat(10)} <= set(rig.backend.sandboxes)
    assert rig.pending() == {chat(0): ('cap', chat(1)), chat(10): ('cap', chat(11))}


def test_a_workspace_in_use_cannot_be_removed():
    async def scenario():
        rig = Rig(max_workspaces=1)
        await rig.use(chat(0))
        with pytest.raises(SandboxError):
            await rig.use(chat(1))
        async with rig.manager.session(chat(0), ALICE):
            with pytest.raises(WorkspaceBusy):
                await rig.manager.answer_pending('alice', chat(0), 'remove')
        return rig

    rig = run(scenario())
    assert chat(0) in rig.backend.sandboxes
    assert rig.pending() == {chat(0): ('cap', chat(1))}


def test_a_failed_destroy_keeps_the_record_and_the_request():
    async def scenario():
        rig = Rig(max_workspaces=1)
        await rig.use(chat(0))
        with pytest.raises(SandboxError):
            await rig.use(chat(1))

        async def broken(chat_id):
            raise SandboxError('docker is down')

        rig.backend.destroy = broken
        with pytest.raises(SandboxError, match='docker is down'):
            await rig.manager.answer_pending('alice', chat(0), 'remove')
        return rig

    rig = run(scenario())
    assert rig.pending() == {chat(0): ('cap', chat(1))}


# The listing.


def _box_with(rig: Rig, key: str, count: int) -> None:
    files = rig.backend.sandboxes[key].files
    files['/workspace/data'] = FakeFile(content=None, uid=SANDBOX_UID, mode=0o755)
    for n in range(count):
        files[f'/workspace/data/f{n:04}.csv'] = FakeFile(content=b'x' * n, uid=SANDBOX_UID, mode=0o644, mtime=n)


def test_the_listing_is_capped_with_totals_and_needs_no_running_sandbox():
    async def scenario():
        rig = Rig()
        await rig.use(chat(0))
        _box_with(rig, chat(0), LIST_MAX_ENTRIES + 50)
        await rig.backend.stop(chat(0))
        rig.manager._forget(chat(0))
        rig.backend.calls.clear()
        return rig, await rig.manager.workspace_contents(chat(0))

    rig, listing = run(scenario())
    assert listing is not None
    assert len(listing.entries) == LIST_MAX_ENTRIES
    assert listing.files == LIST_MAX_ENTRIES + 50
    assert listing.bytes == sum(range(LIST_MAX_ENTRIES + 50))
    assert listing.complete
    assert listing.entries[1].path == 'data/f0001.csv' and listing.entries[1].size == 1
    # Listed, never started.
    assert [name for name, _ in rig.backend.calls] == ['list_workspace']
    assert not rig.backend.sandboxes[chat(0)].running


def test_the_fake_listing_skips_what_uid_1000_cannot_read_and_has_none_for_no_volume():
    async def scenario():
        rig = Rig()
        await rig.use(chat(0))
        files = rig.backend.sandboxes[chat(0)].files
        files['/workspace/locked'] = FakeFile(content=None, uid=SANDBOX_UID, mode=0o000)
        files['/workspace/locked/secret.txt'] = FakeFile(content=b'abc', uid=SANDBOX_UID, mode=0o644)
        files['/workspace/link'] = FakeFile(content=None, uid=SANDBOX_UID, mode=0o777, link='/etc/passwd')
        files['/workspace/ok.txt'] = FakeFile(content=b'hello', uid=SANDBOX_UID, mode=0o644, mtime=5.0)
        return await rig.manager.workspace_contents(chat(0)), await rig.manager.workspace_contents(chat(1))

    listing, missing = run(scenario())
    assert listing is not None
    assert [(e.path, e.size, e.mtime) for e in listing.entries] == [('ok.txt', 5, 5.0)]
    assert (listing.files, listing.bytes, listing.complete) == (1, 5, False)
    assert missing is None


@pytest.mark.parametrize('bad', [0, LIST_MAX_ENTRIES + 1, True, '10', None])
def test_list_workspace_refuses_a_bad_limit(bad):
    with pytest.raises((TypeError, ValueError)):
        validate_list_workspace(bad)
    with pytest.raises((TypeError, ValueError)):
        run(FakeBackend().list_workspace(chat(0), bad))


def test_workspace_contents_refuses_a_key_that_is_not_a_uuid():
    with pytest.raises(ValueError):
        run(Rig().manager.workspace_contents('../etc'))


# DatabaseWorkspaces, on the test database.


async def _add_chat(chat_id: str, user_id: str, title: str | None) -> None:
    async with get_async_db_context() as db:
        db.add(Chat(id=chat_id, user_id=user_id, title=title, chat={}, created_at=1, updated_at=1))
        await db.commit()


def test_database_workspaces_round_trip():
    async def scenario():
        store = DatabaseWorkspaces()
        user = f'dbw-{uuid.uuid4().hex}'
        first, second, untitled, missing = (str(uuid.uuid4()) for _ in range(4))
        await _add_chat(first, user, 'First')
        await _add_chat(untitled, user, None)
        seen: dict[str, object] = {}
        seen['owner'] = (await store.owner_of(first), await store.owner_of(missing))
        seen['titles'] = await store.chat_titles([first, untitled, missing])
        seen['no titles'] = await store.chat_titles([])
        seen['added'] = await store.add(WorkspaceRecord(second, user, second, 10, 30))
        seen['again'] = await store.add(WorkspaceRecord(second, user, second, 99, 99))
        await store.add(WorkspaceRecord(first, user, first, 10, 20))
        seen['order'] = [r.key for r in await store.of_user(user)]
        await store.set_pending(first, 'cap', 40, second)
        seen['pending'] = await store.get(first)
        await store.touch(first, 50)
        seen['touched cap'] = await store.get(first)
        await store.set_pending(second, 'expired', 60, None)
        await store.touch(second, 70)
        seen['touched expired'] = await store.get(second)
        await store.set_pending(second, 'expired', 80, None)
        await store.clear_pending(second, last_used_at=90)
        seen['cleared'] = await store.get(second)
        await store.clear_pending(first)
        seen['cleared cap'] = await store.get(first)
        seen['all'] = {r.key for r in await store.all()} >= {first, second}
        await store.delete(first)
        await store.delete(second)
        await store.delete(missing)
        seen['gone'] = (await store.get(first), await store.of_user(user))
        return user, first, second, untitled, seen

    user, first, second, untitled, seen = run(scenario())
    assert seen['owner'] == (user, None)
    assert seen['titles'] == {first: 'First'}
    assert seen['no titles'] == {}
    assert (seen['added'], seen['again']) == (True, False)
    assert seen['order'] == [first, second]
    assert seen['pending'] == WorkspaceRecord(first, user, first, 10, 20, 'cap', 40, second)
    # A use answers only an expired request.
    assert seen['touched cap'] == WorkspaceRecord(first, user, first, 10, 50, 'cap', 40, second)
    assert seen['touched expired'] == WorkspaceRecord(second, user, second, 10, 70)
    assert seen['cleared'] == WorkspaceRecord(second, user, second, 10, 90)
    assert seen['cleared cap'] == WorkspaceRecord(first, user, first, 10, 50)
    assert seen['all']
    assert seen['gone'] == (None, [])


def test_memory_workspaces_ignore_unknown_keys():
    async def scenario():
        store = MemoryWorkspaces()
        await store.touch('nope', 1)
        await store.set_pending('nope', 'cap', 1, None)
        await store.clear_pending('nope')
        return store.records, await store.owner_of('anything'), await store.chat_titles(['x'])

    assert run(scenario()) == ({}, 'owner', {})


# The routes, with real tokens through the real auth dependencies.


def _user(role: str = 'user') -> SimpleNamespace:
    uid = f'sbxws-{role}-{uuid.uuid4().hex[:10]}'
    run(Users.insert_new_user(uid, f'{role} user', f'{uid}@example.com', role=role))
    token = create_token({'id': uid}, dt.timedelta(minutes=30))
    return SimpleNamespace(id=uid, role=role, headers={'Authorization': f'Bearer {token}'})


@pytest.fixture(scope='module')
def people():
    return SimpleNamespace(alice=_user(), bob=_user())


class RouteRig:
    """An app with the sandbox router on a manager whose chats 0..4 are alice's and 10..14 bob's."""

    def __init__(self, people, *, max_workspaces: int = 2) -> None:
        self.people = people
        self.backend = FakeBackend()
        owners = {chat(n): people.alice.id for n in range(5)} | {chat(n): people.bob.id for n in range(10, 15)}
        self.store = MemoryWorkspaces(owners, default_owner=None, titles={chat(n): f'Chat {n}' for n in range(20)})
        self.chats = Chats(owners)
        settings = SandboxSettings(max_workspaces=max_workspaces)

        async def read_settings():
            return settings

        self.manager = SandboxManager(self.backend, settings=read_settings, chats=self.chats, workspaces=self.store)
        app = FastAPI()
        app.state.sandbox = self.manager
        app.include_router(sandbox_router.router, prefix='/sandbox')
        self.app = app
        self.client = TestClient(app)

    def use(self, chat_id: str, user) -> None:
        async def go():
            async with self.manager.session(chat_id, SimpleNamespace(id=user.id, role='user')):
                pass

        asyncio.run(go())

    def since(self, key: str) -> int:
        """The `since` of `key`'s request, as the dialog shows it."""
        return self.store.records[key].pending_since or 0

    def at_cap(self) -> None:
        """Alice holds chats 0 and 1, chat 2 waits for room; bob holds 10 and 11, chat 12 waits."""
        for n in (0, 1):
            self.use(chat(n), self.people.alice)
        for n in (10, 11):
            self.use(chat(n), self.people.bob)
        for n, who in ((2, self.people.alice), (12, self.people.bob)):
            with pytest.raises(SandboxError):
                self.use(chat(n), who)
        self.backend.sandboxes[chat(0)].files['/workspace/notes.md'] = FakeFile(
            content=b'# notes', uid=SANDBOX_UID, mode=0o644, mtime=1.5
        )


def test_get_pending_lists_the_caller_s_requests_with_contents_and_choices(people):
    rig = RouteRig(people)
    rig.at_cap()
    ids = rig.client.get('/sandbox/pending/ids', headers=people.alice.headers)
    assert ids.status_code == 200, ids.text
    assert ids.json() == {'ids': [chat(0)]}
    r = rig.client.get('/sandbox/pending', headers=people.alice.headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body['max_workspaces'], body['retention_days']) == (2, 7)
    [item] = body['pending']
    assert item['id'] == chat(0)
    assert (item['chat_title'], item['reason']) == ('Chat 0', 'cap')
    assert (item['waiting_chat_id'], item['waiting_chat_title']) == (chat(2), 'Chat 2')
    assert item['contents'] == {
        'files': [{'path': 'notes.md', 'size': 7, 'mtime': 1.5, 'truncated': False}],
        'file_count': 1,
        'total_bytes': 7,
        'complete': True,
    }
    assert item['contents_error'] is None
    # Only alice's own other workspaces to choose from.
    assert [w['id'] for w in item['workspaces']] == [chat(1)]
    assert item['workspaces'][0]['chat_title'] == 'Chat 1'


def test_get_pending_reports_a_listing_that_failed_without_its_details(people):
    rig = RouteRig(people)
    rig.at_cap()

    async def broken(chat_id, max_entries):
        raise SandboxError('/var/lib/docker/secret path')

    rig.backend.list_workspace = broken
    [item] = rig.client.get('/sandbox/pending', headers=people.alice.headers).json()['pending']
    assert item['contents'] is None
    assert item['contents_error'] == 'The contents could not be listed.'


def test_get_pending_says_when_the_volume_is_gone(people):
    rig = RouteRig(people)
    rig.at_cap()
    del rig.backend.sandboxes[chat(0)]
    [item] = rig.client.get('/sandbox/pending', headers=people.alice.headers).json()['pending']
    assert item['contents'] is None and 'no files' in item['contents_error']


def test_nothing_pending_is_an_empty_list(people):
    rig = RouteRig(people)
    rig.use(chat(0), people.alice)
    assert rig.client.get('/sandbox/pending', headers=people.alice.headers).json()['pending'] == []
    assert rig.client.get('/sandbox/pending/ids', headers=people.alice.headers).json() == {'ids': []}


def test_the_routes_refuse_another_user_s_workspace_with_the_same_404(people):
    rig = RouteRig(people)
    rig.at_cap()
    missing = rig.client.post(
        f'/sandbox/pending/{uuid.uuid4()}', json={'action': 'keep', 'since': 0}, headers=people.bob.headers
    )
    for answer in ({'action': 'remove', 'since': rig.since(chat(0))}, {'action': 'keep', 'since': rig.since(chat(0))}):
        r = rig.client.post(f'/sandbox/pending/{chat(0)}', json=answer, headers=people.bob.headers)
        assert (r.status_code, r.json()) == (404, missing.json())
    # Bob's request may not name alice's workspace either.
    r = rig.client.post(
        f'/sandbox/pending/{chat(10)}',
        json={'action': 'remove', 'workspace': chat(1), 'since': rig.since(chat(10))},
        headers=people.bob.headers,
    )
    assert (r.status_code, r.json()) == (404, missing.json())
    assert missing.status_code == 404
    assert {chat(0), chat(1), chat(10), chat(11)} <= set(rig.backend.sandboxes)


def test_post_remove_then_the_waiting_chat_creates(people):
    rig = RouteRig(people)
    rig.at_cap()
    r = rig.client.post(
        f'/sandbox/pending/{chat(0)}',
        json={'action': 'remove', 'workspace': chat(1), 'since': rig.since(chat(0))},
        headers=people.alice.headers,
    )
    assert (r.status_code, r.json()) == (200, {'ok': True})
    assert chat(1) not in rig.backend.sandboxes
    assert rig.client.get('/sandbox/pending/ids', headers=people.alice.headers).json() == {'ids': []}
    rig.use(chat(2), people.alice)
    assert chat(2) in rig.backend.sandboxes


def test_post_keep_clears_the_request(people):
    rig = RouteRig(people)
    rig.at_cap()
    r = rig.client.post(
        f'/sandbox/pending/{chat(0)}',
        json={'action': 'keep', 'since': rig.since(chat(0))},
        headers=people.alice.headers,
    )
    assert r.status_code == 200, r.text
    assert rig.client.get('/sandbox/pending/ids', headers=people.alice.headers).json() == {'ids': []}
    assert chat(0) in rig.backend.sandboxes


@pytest.mark.parametrize(
    'body, code',
    [
        ({'action': 'delete'}, 422),
        ({'action': 'keep', 'extra': 1}, 422),
        ({'action': 'keep', 'workspace': 'x'}, 400),
        ({'action': 'keep', 'since': None}, 422),
        ({'action': 'keep', 'since': 'later'}, 422),
    ],
)
def test_post_refuses_a_malformed_answer(people, body, code):
    rig = RouteRig(people)
    rig.at_cap()
    body = {'since': rig.since(chat(0)), **body}
    r = rig.client.post(f'/sandbox/pending/{chat(0)}', json=body, headers=people.alice.headers)
    assert r.status_code == code, r.text


def test_post_while_the_workspace_is_in_use_is_409_and_a_failed_destroy_502(people):
    rig = RouteRig(people)
    rig.at_cap()
    # The manager's own refusal is pinned above (test_a_workspace_in_use_cannot_be_removed); here, a session held in
    # the route's event loop would share the database pool across two loops, so the refusal is raised directly.
    real = rig.manager.answer_pending

    async def busy(*args, **kwargs):
        raise WorkspaceBusy(chat(0))

    rig.manager.answer_pending = busy
    r = rig.client.post(
        f'/sandbox/pending/{chat(0)}',
        json={'action': 'remove', 'since': rig.since(chat(0))},
        headers=people.alice.headers,
    )
    assert r.status_code == 409 and 'running code' in r.json()['detail']
    rig.manager.answer_pending = real

    async def broken(chat_id):
        raise SandboxError('/var/lib/docker')

    rig.backend.destroy = broken
    r = rig.client.post(
        f'/sandbox/pending/{chat(0)}',
        json={'action': 'remove', 'since': rig.since(chat(0))},
        headers=people.alice.headers,
    )
    assert r.status_code == 502 and 'docker' not in r.text


def test_the_routes_without_a_manager(people):
    app = FastAPI()
    app.state.sandbox = None
    app.include_router(sandbox_router.router, prefix='/sandbox')
    client = TestClient(app)
    assert client.get('/sandbox/pending', headers=people.alice.headers).json()['pending'] == []
    assert client.get('/sandbox/pending/ids', headers=people.alice.headers).json() == {'ids': []}
    r = client.post(f'/sandbox/pending/{chat(0)}', json={'action': 'keep', 'since': 0}, headers=people.alice.headers)
    assert r.status_code == 503


def test_a_store_error_is_503(people):
    rig = RouteRig(people)

    async def broken(user_id):
        raise RuntimeError('down')

    rig.store.of_user = broken
    assert rig.client.get('/sandbox/pending', headers=people.alice.headers).status_code == 503
    assert rig.client.get('/sandbox/pending/ids', headers=people.alice.headers).status_code == 503


def test_no_token_is_refused():
    app = FastAPI()
    app.state.sandbox = None
    app.include_router(sandbox_router.router, prefix='/sandbox')
    client = TestClient(app)
    assert client.get('/sandbox/pending').status_code in (401, 403)
    assert client.post(f'/sandbox/pending/{chat(0)}', json={'action': 'keep'}).status_code in (401, 403)


def test_a_record_that_cannot_be_dropped_is_logged_and_the_release_still_destroys(caplog):
    async def scenario():
        rig = Rig()
        await rig.use(chat(0))

        async def broken(key):
            raise RuntimeError('down')

        rig.store.delete = broken
        await rig.manager.release(chat(0))
        return rig

    with caplog.at_level(logging.ERROR, logger='local_llm.sandbox.manager'):
        rig = run(scenario())
    assert chat(0) not in rig.backend.sandboxes
    # Kept, for the sweep to drop once it is old enough.
    assert chat(0) in rig.store.records
    assert f'could not drop the record of workspace {chat(0)}' in caplog.text


def test_the_expiry_judgement_skips_a_workspace_a_session_takes_while_the_chats_are_looked_up():
    async def scenario():
        rig = Rig(retention_days=7)
        await rig.use(chat(0))
        await rig.backend.stop(chat(0))
        rig.manager._forget(chat(0))
        rig.wall += 8 * DAY
        real = rig.chats.updated_at

        async def updated_at(ids):
            result = await real(ids)
            # A session starts on it while the lookup is in flight, and is still on it when the judging starts.
            started.set()
            await release.wait()
            return result

        started, release = asyncio.Event(), asyncio.Event()
        rig.chats.updated_at = updated_at
        sweep = asyncio.create_task(rig.manager.sweep_retention())
        await started.wait()
        async with rig.manager.session(chat(0), ALICE):
            release.set()
            await sweep
        return rig

    rig = run(scenario())
    assert rig.pending() == {}


def test_memory_workspaces_add_refuses_a_key_it_has():
    async def scenario():
        store = MemoryWorkspaces()
        first = await store.add(WorkspaceRecord('k', 'u', 'k', 1, 1))
        second = await store.add(WorkspaceRecord('k', 'v', 'k', 2, 2))
        return first, second, store.records['k'].user_id

    assert run(scenario()) == (True, False, 'u')


# Review fixes.


def test_a_volume_made_before_the_records_is_recorded_at_the_cap_not_refused():
    async def scenario():
        rig = Rig(max_workspaces=1)
        await rig.use(chat(0))
        # Below the limit the claim never lists the backend.
        listed_under = [name for name, _ in rig.backend.calls if name == 'list_sandboxes']
        await rig.backend.create(chat(1), SandboxSpec(chat(1), 'data'))
        await rig.backend.stop(chat(1))
        await rig.use(chat(1))
        return rig, listed_under

    rig, listed_under = run(scenario())
    assert listed_under == []
    assert set(rig.store.records) == {chat(0), chat(1)}
    assert rig.pending() == {}


def test_a_stopped_workspace_s_listing_is_kept_until_its_next_use_and_bounded(monkeypatch):
    async def scenario():
        rig = Rig()
        await rig.use(chat(0))
        await rig.backend.stop(chat(0))
        rig.manager._forget(chat(0))
        first = await rig.manager.workspace_contents(chat(0), 100)
        again = await rig.manager.workspace_contents(chat(0), 100)
        after_use = await rig.manager.workspace_contents(chat(0), 101)
        no_stamp = await rig.manager.workspace_contents(chat(0))
        # A running one is listed afresh every time.
        await rig.use(chat(0))
        await rig.manager.workspace_contents(chat(0), 101)
        await rig.manager.workspace_contents(chat(0), 101)
        monkeypatch.setattr(manager_module, 'LISTING_CACHE_SIZE', 2)
        await rig.backend.stop(chat(0))
        rig.manager._forget(chat(0))
        for stamp in (200, 201, 202):
            await rig.manager.workspace_contents(chat(0), stamp)
        return rig, first, again, after_use, no_stamp

    rig, first, again, after_use, no_stamp = run(scenario())
    assert first is again
    assert first == after_use == no_stamp
    lists = [name for name, _ in rig.backend.calls if name == 'list_workspace']
    # 100, 101 (after use), no stamp, two while running, then 200, 201, 202.
    assert len(lists) == 8
    assert len(rig.manager._listings) == 2
    assert LISTING_CACHE_SIZE >= 64


def test_one_pending_listing_per_user_at_a_time():
    async def scenario():
        rig = Rig()
        async with rig.manager.pending_listing('alice'):
            with pytest.raises(ListingBusy):
                async with rig.manager.pending_listing('alice'):
                    pass
            async with rig.manager.pending_listing('bob'):
                pass
        async with rig.manager.pending_listing('alice'):
            pass
        return rig

    assert run(scenario()).manager._listing_users == set()


def test_an_answer_to_a_request_that_changed_is_refused():
    async def scenario():
        rig = Rig(max_workspaces=1)
        await rig.use(chat(0))
        with pytest.raises(SandboxError):
            await rig.use(chat(1))
        shown = rig.store.records[chat(0)].pending_since
        for action in ('keep', 'remove'):
            with pytest.raises(WorkspaceChanged):
                await rig.manager.answer_pending('alice', chat(0), action, since=shown - 1)
        return rig

    rig = run(scenario())
    assert chat(0) in rig.backend.sandboxes
    assert rig.pending() == {chat(0): ('cap', chat(1))}


@pytest.mark.parametrize('change', ['cleared', 'replaced', 'target gone'])
def test_a_request_is_read_again_under_the_lock_just_before_the_removal(change):
    async def scenario():
        rig = Rig(max_workspaces=2)
        await rig.use(chat(0))
        rig.wall += 10
        await rig.use(chat(1))
        with pytest.raises(SandboxError):
            await rig.use(chat(2))
        shown = rig.store.records[chat(0)].pending_since
        real = rig.manager._hold

        @contextlib.asynccontextmanager
        async def hold(key):
            # What another answer or a session did while this one waited for the lock.
            if change == 'cleared':
                await rig.store.clear_pending(chat(0))
            elif change == 'replaced':
                await rig.store.set_pending(chat(0), 'cap', shown, chat(3))
            else:
                await rig.store.delete(chat(1))
            async with real(key):
                yield

        rig.manager._hold = hold
        expected = WorkspaceNotFound if change == 'target gone' else WorkspaceChanged
        with pytest.raises(expected):
            await rig.manager.answer_pending('alice', chat(0), 'remove', workspace=chat(1), since=shown)
        return rig

    rig = run(scenario())
    assert {chat(0), chat(1)} <= set(rig.backend.sandboxes)


def test_removing_another_workspace_whose_sandbox_runs_code_is_refused():
    async def scenario():
        rig = Rig(max_workspaces=2)
        await rig.use(chat(0))
        rig.wall += 10
        await rig.use(chat(1))
        with pytest.raises(SandboxError):
            await rig.use(chat(2))
        async with rig.manager.session(chat(1), ALICE):
            with pytest.raises(WorkspaceBusy):
                await rig.manager.answer_pending('alice', chat(0), 'remove', workspace=chat(1))
        return rig

    rig = run(scenario())
    assert chat(1) in rig.backend.sandboxes
    assert rig.pending() == {chat(0): ('cap', chat(2))}


def test_a_record_that_cannot_be_dropped_after_the_removal_is_a_sandbox_error():
    async def scenario():
        rig = Rig(max_workspaces=1)
        await rig.use(chat(0))
        with pytest.raises(SandboxError):
            await rig.use(chat(1))

        async def broken(key):
            raise RuntimeError('down')

        rig.store.delete = broken
        with pytest.raises(SandboxError, match='could not be dropped'):
            await rig.manager.answer_pending('alice', chat(0), 'remove')
        return rig

    assert chat(0) not in run(scenario()).backend.sandboxes


def test_the_fake_listing_cuts_a_long_path_as_the_script_does():
    async def scenario():
        rig = Rig()
        await rig.use(chat(0))
        files = rig.backend.sandboxes[chat(0)].files
        name = 'é' * 600
        files[f'/workspace/{name}'] = FakeFile(content=b'x', uid=SANDBOX_UID, mode=0o644)
        return await rig.manager.workspace_contents(chat(0))

    listing = run(scenario())
    assert listing is not None
    [entry] = listing.entries
    assert entry.truncated and entry.path.endswith('\u2026') and len(entry.path.encode()) <= 1024


def test_get_pending_serves_a_stopped_workspace_s_listing_from_the_cache_and_one_at_a_time(people):
    rig = RouteRig(people)
    rig.at_cap()
    for key in (chat(0), chat(1)):
        asyncio.run(rig.backend.stop(key))
        rig.manager._forget(key)
    for _ in range(2):
        assert rig.client.get('/sandbox/pending', headers=people.alice.headers).status_code == 200
    assert [kw['chat_id'] for name, kw in rig.backend.calls if name == 'list_workspace'] == [chat(0)]
    rig.manager._listing_users.add(people.alice.id)
    r = rig.client.get('/sandbox/pending', headers=people.alice.headers)
    assert r.status_code == 429
    # Another user is not held up.
    assert rig.client.get('/sandbox/pending', headers=people.bob.headers).status_code == 200


def test_post_with_a_stale_since_is_409(people):
    rig = RouteRig(people)
    rig.at_cap()
    r = rig.client.post(
        f'/sandbox/pending/{chat(0)}',
        json={'action': 'remove', 'since': rig.since(chat(0)) - 1},
        headers=people.alice.headers,
    )
    assert r.status_code == 409 and 'changed since it was shown' in r.json()['detail']
    assert chat(0) in rig.backend.sandboxes


@pytest.mark.parametrize('broken', ['current_settings', 'chat_titles'])
def test_get_pending_maps_a_settings_or_titles_failure_to_503(people, broken):
    rig = RouteRig(people)
    rig.at_cap()

    async def fail(*args):
        raise RuntimeError('postgres://secret')

    setattr(rig.manager, broken, fail)
    r = rig.client.get('/sandbox/pending', headers=people.alice.headers)
    assert r.status_code == 503 and 'secret' not in r.text
    # The per-user hold is released after a failure.
    assert rig.manager._listing_users == set()


def test_post_maps_a_records_failure_to_503_and_a_failed_record_drop_to_502(people):
    rig = RouteRig(people)
    rig.at_cap()
    since = rig.since(chat(0))
    real = rig.store.of_user

    async def down(user_id):
        raise RuntimeError('postgres://secret')

    rig.store.of_user = down
    r = rig.client.post(
        f'/sandbox/pending/{chat(0)}', json={'action': 'keep', 'since': since}, headers=people.alice.headers
    )
    assert r.status_code == 503 and 'secret' not in r.text
    rig.store.of_user = real

    async def broken(key):
        raise RuntimeError('postgres://secret')

    rig.store.delete = broken
    r = rig.client.post(
        f'/sandbox/pending/{chat(0)}', json={'action': 'remove', 'since': since}, headers=people.alice.headers
    )
    assert r.status_code == 502 and 'secret' not in r.text
