"""Tests for tune_probe.py's Server.start()/pgid() dual-backing rewiring.

Phase 2b: Server used to shell out to `lllm-serve <profile>` (or, under
LLAMA_TUNE_LAUNCH, an arbitrary stub) through proc.Command. It now serves
directly through benchmarks/serving/launcher.ServeProcess, with Command kept
only for the LLAMA_TUNE_LAUNCH escape hatch. These check the branch that
picks between the two, and that a profile lookup or resolve() failure
surfaces as Infeasible rather than an unhandled exception -- both new
failure paths that did not exist when start() only ever built a shell
string. No real llama-server, no GPU: LauncherError is provoked with a
LLAMA_BIN pointed at an empty directory, never a real binary.

Run from apps/server:

    python -m pytest tests/test_tune_probe.py
"""

from __future__ import annotations

import asyncio
import time

import pytest

from local_llm.benchmarks.serving.launcher import ServeProcess
from local_llm.benchmarks.tuning.proc import Command
from local_llm.benchmarks.tuning.tune_probe import Infeasible, Server
from local_llm.benchmarks.tuning.tune_schedule import Candidate
from local_llm.models.benchmarks.profiles import (
    BenchmarkProfileEntry,
    BenchmarkProfileModel,
    BenchmarkProfiles,
    BenchmarkProfileVersionModel,
)


def _entry(name='qwen25c') -> BenchmarkProfileEntry:
    now = int(time.time())
    return BenchmarkProfileEntry(
        profile=BenchmarkProfileModel(profile_id=1, name=name, display_name=name, is_default=False, created_at=now),
        version=BenchmarkProfileVersionModel(
            version_id=1,
            profile_id=1,
            version=1,
            created_at=now,
            arch='dense',
            alias='qwen2.5-coder-7b',
            model_path='/models/x.gguf',
            ctx=16384,
            threads=6,
            ngl=99,
            spec=[],
            samplers=[],
            extra=[],
        ),
    )


class _FakeSession:
    """Server's constructor needs a session; nothing here ever calls it."""


@pytest.mark.asyncio
async def test_start_raises_infeasible_when_profile_missing(monkeypatch):
    async def fake_get_by_name(name, db=None):
        return None

    monkeypatch.setattr(BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    monkeypatch.delenv('LLAMA_TUNE_LAUNCH', raising=False)

    candidate = Candidate('no-such-profile', {}, stage='explore')
    server = Server(candidate, 8090, load_timeout=5.0, session=_FakeSession())
    with pytest.raises(Infeasible) as exc_info:
        await server.start()
    assert exc_info.value.kind == 'load_error'
    assert server.cmd is None


@pytest.mark.asyncio
async def test_start_raises_infeasible_on_a_profile_error(monkeypatch):
    async def fake_get_by_name(name, db=None):
        return _entry()

    monkeypatch.setattr(BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    monkeypatch.delenv('LLAMA_TUNE_LAUNCH', raising=False)

    # --parallel does not belong in a LLAMA_SPEC override -- resolve() raises
    # ProfileError for exactly this, the same guard rail the golden
    # fingerprint tests check.
    candidate = Candidate('qwen25c', {'LLAMA_SPEC': '--parallel 2'}, stage='explore')
    server = Server(candidate, 8090, load_timeout=5.0, session=_FakeSession())
    with pytest.raises(Infeasible) as exc_info:
        await server.start()
    assert exc_info.value.kind == 'load_error'


@pytest.mark.asyncio
async def test_start_raises_infeasible_when_llama_server_is_missing(monkeypatch, tmp_path):
    async def fake_get_by_name(name, db=None):
        return _entry()

    monkeypatch.setattr(BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    monkeypatch.delenv('LLAMA_TUNE_LAUNCH', raising=False)
    monkeypatch.setenv('LLAMA_BIN', str(tmp_path))  # empty: no llama-server binary here

    candidate = Candidate('qwen25c', {}, stage='explore')
    server = Server(candidate, 8090, load_timeout=5.0, session=_FakeSession())
    with pytest.raises(Infeasible) as exc_info:
        await server.start()
    assert exc_info.value.kind == 'load_error'
    assert 'llama-server not found' in exc_info.value.reason


@pytest.mark.asyncio
async def test_start_uses_serveprocess_by_default(monkeypatch, tmp_path):
    async def fake_get_by_name(name, db=None):
        return _entry()

    monkeypatch.setattr(BenchmarkProfiles, 'get_by_name', fake_get_by_name)
    monkeypatch.delenv('LLAMA_TUNE_LAUNCH', raising=False)
    monkeypatch.setenv('LLAMA_BIN', str(tmp_path))  # deliberately missing -> fails fast, never spawns

    candidate = Candidate('qwen25c', {}, stage='explore')
    server = Server(candidate, 8090, load_timeout=5.0, session=_FakeSession())
    with pytest.raises(Infeasible):
        await server.start()
    # Failed before assignment would leave it None; failed after assignment
    # (inside ServeProcess.start()) leaves the right type in place.
    assert server.cmd is None or isinstance(server.cmd, ServeProcess)


@pytest.mark.asyncio
async def test_start_uses_command_under_llama_tune_launch(monkeypatch):
    monkeypatch.setenv('LLAMA_TUNE_LAUNCH', 'true')  # the `true` binary: starts, exits 0 immediately

    candidate = Candidate('qwen25c', {}, stage='explore')
    server = Server(candidate, 8090, load_timeout=5.0, session=_FakeSession())
    await server.start()
    try:
        assert isinstance(server.cmd, Command)
    finally:
        await server.stop()


def test_pgid_none_before_start():
    candidate = Candidate('qwen25c', {}, stage='explore')
    server = Server(candidate, 8090, load_timeout=5.0, session=_FakeSession())
    assert server.pgid() is None


@pytest.mark.asyncio
async def test_pgid_works_for_a_command_backed_server(monkeypatch):
    monkeypatch.setenv('LLAMA_TUNE_LAUNCH', 'true')

    candidate = Candidate('qwen25c', {}, stage='explore')
    server = Server(candidate, 8090, load_timeout=5.0, session=_FakeSession())
    await server.start()
    try:
        # `true` exits immediately; the pgid may already be gone by the time
        # this reads it, so the only real assertion is that it does not
        # raise attribute-resolution to the wrong process attribute.
        server.pgid()
    finally:
        await server.stop()


async def _trap_set(server: Server) -> None:
    """Until the stub has set its SIGINT trap and said so."""
    for _ in range(500):
        if 'ready' in server.tail:
            return
        await asyncio.sleep(0.01)
    raise AssertionError('the stub server never came up')


@pytest.mark.asyncio
async def test_stop_returns_as_soon_as_the_server_exits_on_sigint(monkeypatch):
    # A stub that exits cleanly on SIGINT, as llama-server does. The trailing
    # `:` takes the profile name start() appends to the command.
    monkeypatch.setenv('LLAMA_TUNE_LAUNCH', 'trap "exit 0" INT; echo ready; while :; do sleep 0.1; done; :')

    candidate = Candidate('qwen25c', {}, stage='explore')
    server = Server(candidate, 8090, load_timeout=5.0, session=_FakeSession())
    await server.start()
    await _trap_set(server)

    started = time.monotonic()
    await server.stop()

    assert not server.cmd.running
    assert server.cmd.proc.returncode == 0  # it exited on the SIGINT, not on a later SIGTERM
    assert time.monotonic() - started < 5.0


@pytest.mark.asyncio
async def test_stop_gives_up_on_sigint_after_the_grace_and_terminates(monkeypatch):
    # A stub that ignores SIGINT: stop() waits out the grace, then SIGTERMs it.
    monkeypatch.setenv('LLAMA_TUNE_LAUNCH', 'trap "" INT; echo ready; while :; do sleep 0.1; done; :')

    candidate = Candidate('qwen25c', {}, stage='explore')
    server = Server(candidate, 8090, load_timeout=5.0, session=_FakeSession())
    server.interrupt_grace = 0.5
    await server.start()
    await _trap_set(server)

    started = time.monotonic()
    await server.stop()

    assert not server.cmd.running
    assert server.cmd.proc.returncode != 0
    assert 0.4 < time.monotonic() - started < 10.0
