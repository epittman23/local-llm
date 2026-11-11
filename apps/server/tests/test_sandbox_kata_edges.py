"""Adversarial edge cases for the Kata backend (sandbox/kata.py) and its lifespan wiring (sandbox/lifespan.py).

An independent test pass written against the contracts (docs/plans/sandbox-implementation.md T14, Q8-Q11, Q16,
Q18; sandbox/backend.py, types.py, limits.py), not against the author's implementation, through the same mocked
SDK as test_sandbox_kata_unit.py (whose fakes it reuses). No Docker, Kata, udisks or KVM is needed. Pins:

- the output stream: unknown frame kinds, split and truncated frames, a flood far beyond the cap held in bounded
  memory, and a real socket pair for stdin larger than the socket buffer and for a writer that must be woken by the
  close;
- `exec`: a background child that holds the stream, the host deadline against a command's own 124 and 137, the
  kill failing at every step (including under the deadline), cancellation (one kill however often it is
  repeated, no task left over), and every SDK exception becoming a SandboxError with no daemon URL or host path;
- `put_files`: the archive, applied by a model of Docker's untar, replaces whatever was there; refused names and
  modes never reach the SDK; the guest-view wait times out on a stale, planted or missing view;
- `get_files` and `stat`: the size limit at its boundary, every non-regular kind, a lying header, a path through a
  symlink;
- `create`: a hostile id or image is refused before the host is touched; the host tools' argv comes from the key
  alone and detaches only that key's loop device;
- the lifespan: a second worker or a second process is refused, a hung sweep does not hold the app back.
"""

import asyncio
import io
import json
import socket
import struct
import subprocess
import sys
import tarfile
import threading
import time
import tracemalloc
from base64 import b64decode
from collections.abc import Callable, Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import docker.errors
import pytest
import requests
from test_sandbox_kata_unit import (
    CID,
    DIR,
    FILES,
    OTHER,
    App,
    FakeAPI,
    FakeDocker,
    FakeResponse,
    FakeSock,
    Host,
    archive,
    frames,
    kinds,
    put_ok,
    run_exec,
)

from local_llm.sandbox import kata, lifespan
from local_llm.sandbox.exec import StreamCap, wrap_command
from local_llm.sandbox.fake import FakeBackend
from local_llm.sandbox.kata import KILL_SCRIPT, POLL_SCRIPT, VERIFY_SCRIPT, KataDockerBackend
from local_llm.sandbox.limits import CANCEL_WAIT_S, STREAM_CAP_CHARS
from local_llm.sandbox.types import SandboxError, SandboxNotRunning, SandboxSpec

LEAK = 'http+docker://localhost/v1.56/containers/abc/archive?path=/home/someone/secret-data via /var/run/docker.sock'
FORBIDDEN = ('localhost', 'docker.sock', '/home', 'secret', 'http', '/var/run', 'v1.56', 'someone')


@pytest.fixture
def docker_client() -> FakeDocker:
    return FakeDocker()


@pytest.fixture
def host(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Host:
    fake = Host(tmp_path)
    monkeypatch.setattr(kata, 'SYS_BLOCK', fake.sys_block)
    monkeypatch.setattr(kata, 'BY_UUID', fake.by_uuid)
    monkeypatch.setattr(kata, 'KATA_CONFIG', fake.kata_config)
    # No daemon.json: the check falls back to KATA_CONFIG (hermetic on any host).
    monkeypatch.setattr(kata, 'DAEMON_JSON', fake.root / 'no-daemon.json')
    monkeypatch.setattr(kata, 'BRIDGE_IPV6', fake.bridge_ipv6)
    monkeypatch.setattr(kata.shutil, 'which', fake.which)
    monkeypatch.setattr(kata.subprocess, 'run', fake.run)
    return fake


@pytest.fixture
def fast(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in {
        'POLLER_AFTER_S': 0.0,
        'POLL_MAX_S': 0.005,
        'DRAIN_TIMEOUT_S': 0.2,
        'KILL_TIMEOUT_S': 0.2,
        'EXIT_STATUS_WAIT_S': 0.2,
        'GUEST_VIEW_WAIT_S': 0.5,
        'DEVICE_LINK_WAIT_S': 0.2,
    }.items():
        monkeypatch.setattr(kata, name, value)


@pytest.fixture
def backend(docker_client: FakeDocker, host: Host, tmp_path: Path, fast: None) -> KataDockerBackend:
    docker_client.scope = kata.scope_of(tmp_path / 'volumes')
    return KataDockerBackend(
        tmp_path / 'volumes', client_factory=lambda: cast(Any, docker_client), workspace_bytes=16 * 1024 * 1024
    )


def leaks(error: BaseException) -> list[str]:
    text = ' '.join([str(error), repr(error), *map(str, error.args), str(getattr(error, 'public', None))])
    return [word for word in FORBIDDEN if word in text]


def make_errors() -> list[Exception]:
    return [
        docker.errors.APIError(LEAK),
        docker.errors.NotFound(LEAK),
        docker.errors.ImageNotFound(LEAK),
        docker.errors.DockerException(LEAK),
        requests.ConnectionError(LEAK),
        requests.ReadTimeout(LEAK),
        OSError(111, LEAK),
    ]


ERRORS = make_errors()
ERROR_IDS = [type(e).__name__ for e in ERRORS]


# The output stream.


class Chunky:
    """A raw socket that hands out at most `step` bytes per recv, as a slow network does."""

    def __init__(self, data: bytes, step: int, then: Exception | None = None) -> None:
        self.data = bytearray(data)
        self.step = step
        self.then = then

    def settimeout(self, value: object) -> None:
        pass

    def shutdown(self, how: int) -> None:
        pass

    def recv(self, n: int) -> bytes:
        if not self.data and self.then is not None:
            raise self.then
        chunk = bytes(self.data[: min(n, self.step)])
        del self.data[: len(chunk)]
        return chunk


def read(raw: Any) -> tuple[StreamCap, StreamCap]:
    out, err = StreamCap(), StreamCap()
    kata.read_frames(raw, out, err)
    return out, err


@pytest.mark.parametrize('kind', [0, 3, 7, 255])
def test_a_frame_of_an_unknown_stream_is_skipped_and_the_next_one_still_read(kind: int) -> None:
    out, err = read(Chunky(frames((kind, b'junk'), (1, b'out'), (kind, b'more'), (2, b'err')), 1000))
    assert (out.render(), err.render()) == ('out', 'err')


def test_frames_arriving_one_byte_at_a_time_come_out_whole_and_in_order() -> None:
    data = frames((1, b'one '), (2, b'ERR '), (1, b'two '), (2, b'ERR2'), (1, b'three'))
    out, err = read(Chunky(data, 1))
    assert (out.render(), err.render()) == ('one two three', 'ERR ERR2')


def test_a_character_split_across_two_frames_of_one_stream_is_kept_whole() -> None:
    euro = '€'.encode()
    out, _ = read(Chunky(frames((1, b'a' + euro[:1]), (2, b'x'), (1, euro[1:] + b'b')), 3))
    assert out.render() == 'a€b'


def test_zero_length_frames_change_nothing() -> None:
    out, err = read(Chunky(frames((1, b''), (2, b''), (1, b'x'), (1, b'')), 4))
    assert (out.render(), err.render()) == ('x', '')


@pytest.mark.parametrize('cut', [1, 4, 7])
def test_a_header_cut_short_by_the_end_of_the_stream_ends_the_read_quietly(cut: int) -> None:
    out, err = read(Chunky(frames((1, b'ok')) + frames((2, b'lost'))[:cut], 100))
    assert (out.render(), err.render()) == ('ok', '')


def test_a_body_cut_short_keeps_what_arrived() -> None:
    out, _ = read(Chunky(frames((1, b'0123456789'))[: 8 + 4], 100))
    assert out.render() == '0123'


def test_a_header_promising_four_gib_does_not_allocate_it() -> None:
    header = struct.pack('>BxxxL', 1, 0xFFFFFFFF)
    tracemalloc.start()
    try:
        out, _ = read(Chunky(header + b'tiny', 100))
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert out.render() == 'tiny'
    assert peak < 1024 * 1024


@pytest.mark.parametrize('error', [ConnectionResetError(), BrokenPipeError(), OSError(9, 'bad file descriptor')])
def test_a_reset_or_closed_stream_mid_frame_ends_the_read_without_raising(error: OSError) -> None:
    out, _ = read(Chunky(frames((1, b'partial'))[: 8 + 3], 100, then=error))
    assert out.render() == 'par'


class Flood:
    """A raw socket producing `total` body bytes in one frame, 64 KiB at a time, without ever holding them."""

    def __init__(self, total: int, kind: int = 1) -> None:
        self.pending = struct.pack('>BxxxL', kind, total)
        self.left = total
        self.piece = b'z' * 65536

    def recv(self, n: int) -> bytes:
        if self.pending:
            chunk, self.pending = self.pending[:n], self.pending[n:]
            return chunk
        chunk = self.piece[: min(n, self.left)]
        self.left -= len(chunk)
        return chunk


def test_a_flood_far_beyond_the_cap_is_held_in_bounded_memory() -> None:
    flood = 24 * 1024 * 1024
    tracemalloc.start()
    try:
        out, _ = read(Flood(flood))
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert out.truncated
    assert len(out.render()) < STREAM_CAP_CHARS + 100
    assert peak < 4 * 1024 * 1024


def test_exec_of_a_flood_keeps_the_head_and_tail_of_each_stream_and_says_it_truncated(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container()
    filler = b'a' * (3 * 1024 * 1024)
    docker_client.api.output = frames((1, b'HEAD' + filler + b'TAIL'), (2, b'EHEAD' + filler + b'ETAIL'))
    result = run_exec(backend)
    assert result.truncated and result.returncode == 0
    for text, head, tail in ((result.stdout, 'HEAD', 'TAIL'), (result.stderr, 'EHEAD', 'ETAIL')):
        assert text.startswith(head) and text.endswith(tail)
        assert len(text) < STREAM_CAP_CHARS + 100
        assert 'characters truncated' in text


def test_exec_whose_reader_dies_on_a_reset_still_returns_what_it_had(
    backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch: pytest.MonkeyPatch
) -> None:
    docker_client.add_container()
    api = docker_client.api
    original = api.exec_start

    def start(exec_id: str, detach: bool = False, socket: bool = False) -> Any:
        if api.execs[exec_id].kind != 'main':
            return original(exec_id, detach=detach, socket=socket)
        api.execs[exec_id].started = True
        api.order.append('start main')
        return FakeSock(cast(Any, Chunky(frames((1, b'before')), 100, then=ConnectionResetError())))

    monkeypatch.setattr(api, 'exec_start', start)
    result = run_exec(backend)
    assert (result.stdout, result.returncode) == ('before', 0)


# Real sockets: stdin larger than the buffer, and a writer the close must wake.


class RealSock:
    """docker-py's SocketIO wrapper around a real socket."""

    def __init__(self, sock: socket.socket) -> None:
        self._sock = sock
        self._response = FakeResponse()

    def close(self) -> None:
        pass


@pytest.fixture
def socketpair() -> Iterator[tuple[socket.socket, socket.socket]]:
    a, b = socket.socketpair()
    for end in (a, b):
        end.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
        end.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
    yield a, b
    a.close()
    b.close()


def use_socket(monkeypatch: pytest.MonkeyPatch, api: FakeAPI, sock: socket.socket) -> None:
    original = api.exec_start

    def start(exec_id: str, detach: bool = False, socket: bool = False) -> Any:
        if api.execs[exec_id].kind != 'main':
            return original(exec_id, detach=detach, socket=socket)
        api.execs[exec_id].started = True
        api.order.append('start main')
        return RealSock(sock)

    monkeypatch.setattr(api, 'exec_start', start)


def test_stdin_larger_than_the_socket_buffer_reaches_the_command_whole_while_output_is_read(
    backend: KataDockerBackend,
    docker_client: FakeDocker,
    socketpair: tuple[socket.socket, socket.socket],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    docker_client.add_container()
    api = docker_client.api
    mine, theirs = socketpair
    use_socket(monkeypatch, api, mine)
    done = threading.Event()
    received: list[int] = []

    def command() -> None:
        total = 0
        while chunk := theirs.recv(65536):
            total += len(chunk)
            if total % (1024 * 1024) < len(chunk):
                # Output while stdin is still arriving: both directions must flow at once.
                theirs.sendall(frames((2, b'progress\n')))
        received.append(total)
        theirs.sendall(frames((1, str(total).encode())))
        done.set()

    original = api.exec_inspect

    def inspect(exec_id: str) -> dict[str, Any]:
        if api.execs[exec_id].kind == 'main':
            return {'Running': not done.is_set(), 'ExitCode': None if not done.is_set() else 0}
        return original(exec_id)

    monkeypatch.setattr(api, 'exec_inspect', inspect)
    worker = threading.Thread(target=command)
    worker.start()
    try:
        size = 5 * 1024 * 1024
        result = run_exec(backend, 'cat', stdin=b's' * size)
    finally:
        worker.join(10)
    assert received == [size]
    assert (result.stdout, result.returncode) == (str(size), 0)
    assert result.stderr.startswith('progress')


def test_a_writer_blocked_on_a_command_that_never_reads_stdin_is_woken_by_the_close(
    backend: KataDockerBackend,
    docker_client: FakeDocker,
    socketpair: tuple[socket.socket, socket.socket],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    docker_client.add_container()
    use_socket(monkeypatch, docker_client.api, socketpair[0])
    started = time.monotonic()
    # The command "exits" at once (the fake's default) without reading a byte of 8 MiB of stdin.
    result = run_exec(backend, 'true', stdin=b's' * (8 * 1024 * 1024))
    assert result.returncode == 0
    assert time.monotonic() - started < 5
    assert [t for t in threading.enumerate() if t.name.startswith('asyncio_')] == []


# exec.


def test_a_command_that_has_exited_while_a_child_still_holds_its_stream_returns_after_the_kill(
    backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch: pytest.MonkeyPatch
) -> None:
    docker_client.add_container()
    api = docker_client.api
    api.held = True
    api.output = frames((1, b'partial\n'))
    original = api.exec_inspect

    def inspect(exec_id: str) -> dict[str, Any]:
        if api.execs[exec_id].kind == 'main':
            return {'Running': False, 'ExitCode': 5}
        return original(exec_id)

    monkeypatch.setattr(api, 'exec_inspect', inspect)
    result = run_exec(backend)
    assert (result.returncode, result.stdout, result.timed_out) == (5, 'partial\n', False)
    # The verdict, as nobody, comes last.
    assert kinds(api)[-2:] == ['kill', 'verify']
    assert api.main_raw is not None and api.main_raw.ended


@pytest.mark.parametrize('code', [124, 137])
def test_a_command_ending_in_124_or_137_at_once_is_its_own_status_not_a_timeout(
    backend: KataDockerBackend, docker_client: FakeDocker, code: int
) -> None:
    docker_client.add_container()
    docker_client.api.exit_code = code
    result = run_exec(backend, 'exit 124', timeout_s=60)
    assert (result.returncode, result.timed_out) == (code, False)


def hold_forever(api: FakeAPI) -> None:
    api.held = True
    api.running_for = None
    api.poller_runs = 10**9


def test_the_host_deadline_reports_124_and_timed_out_whatever_status_the_daemon_would_give(
    backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch: pytest.MonkeyPatch
) -> None:
    docker_client.add_container()
    api = docker_client.api
    hold_forever(api)
    api.exit_code = 137
    monkeypatch.setattr(kata, 'HOST_DEADLINE_SLACK_S', 0)
    result = run_exec(backend, 'sleep 99', timeout_s=1)
    assert (result.returncode, result.timed_out) == (124, True)
    # The verdict, as nobody, comes last.
    assert kinds(api)[-2:] == ['kill', 'verify']


def test_the_host_deadline_with_a_kill_that_cannot_be_confirmed_raises_instead_of_returning(
    backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch: pytest.MonkeyPatch
) -> None:
    docker_client.add_container()
    api = docker_client.api
    hold_forever(api)
    api.kill_exit = 1
    monkeypatch.setattr(kata, 'HOST_DEADLINE_SLACK_S', 0)
    with pytest.raises(SandboxNotRunning, match='could not be confirmed ended'):
        run_exec(backend, 'sleep 99', timeout_s=1)
    assert docker_client.removed == [f'lllm-sandbox-{CID}']


def test_137_when_the_container_has_vanished_from_the_daemon_is_a_dead_vm(
    backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch: pytest.MonkeyPatch
) -> None:
    docker_client.add_container()
    api = docker_client.api
    api.exit_code = 137
    original = api.exec_inspect

    def inspect(exec_id: str) -> dict[str, Any]:
        found = original(exec_id)
        docker_client.containers_by_name.clear()
        return found

    monkeypatch.setattr(api, 'exec_inspect', inspect)
    with pytest.raises(SandboxNotRunning, match='stopped during the command'):
        run_exec(backend)
    assert 'kill' not in kinds(api)
    assert api.main_raw is not None and api.main_raw.shutdowns


@pytest.mark.parametrize('step', ['create', 'start', 'nonzero', 'hang', 'inspect'])
def test_every_step_of_the_kill_failing_stops_the_sandbox_and_raises_whatever_the_command_did(
    backend: KataDockerBackend, docker_client: FakeDocker, step: str
) -> None:
    docker_client.add_container()
    api = docker_client.api
    api.exit_code = 0
    if step == 'create':
        api.kill_create_error = docker.errors.APIError(LEAK)
    elif step == 'start':
        api.errors['exec_start kill'] = requests.ConnectionError(LEAK)
    elif step == 'nonzero':
        api.kill_exit = 1
    elif step == 'hang':
        api.kill_hangs = True
    else:
        api.inspect_errors['kill'] = docker.errors.APIError(LEAK)
    with pytest.raises(SandboxNotRunning) as raised:
        run_exec(backend, 'echo done')
    assert leaks(raised.value) == []
    assert docker_client.removed == [f'lllm-sandbox-{CID}']
    assert api.main_raw is not None and api.main_raw.shutdowns


def test_a_stop_that_also_fails_after_a_failed_kill_still_raises_the_kill_error_without_leaking(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container()
    docker_client.api.kill_exit = 1
    docker_client.remove_error = docker.errors.APIError(LEAK)
    with pytest.raises(SandboxNotRunning) as raised:
        run_exec(backend)
    assert leaks(raised.value) == []


def test_a_failure_while_waiting_for_the_command_still_kills_and_closes_the_stream(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container()
    api = docker_client.api
    api.held = True
    api.inspect_errors['main'] = requests.ReadTimeout(LEAK)
    with pytest.raises(SandboxError) as raised:
        run_exec(backend)
    assert leaks(raised.value) == []
    # The verdict, as nobody, comes last.
    assert kinds(api)[-2:] == ['kill', 'verify']
    assert api.main_raw is not None and api.main_raw.ended


def test_repeated_cancellation_runs_one_kill_and_leaves_no_task_behind(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container()
    api = docker_client.api
    hold_forever(api)

    async def scenario() -> set[asyncio.Task[Any]]:
        task = asyncio.ensure_future(backend.exec(CID, wrap_command('sleep 300', 60), 60))
        while 'poll' not in kinds(api):
            await asyncio.sleep(0.01)
        for _ in range(5):
            task.cancel()
            await asyncio.sleep(0)
        with pytest.raises(asyncio.CancelledError):
            await task
        return {t for t in asyncio.all_tasks() if t is not asyncio.current_task()}

    assert asyncio.run(scenario()) == set()
    assert kinds(api).count('kill') == 1 and kinds(api).count('verify') == 1
    # The verdict, as nobody, comes last.
    assert kinds(api)[-2:] == ['kill', 'verify']


def test_a_cancelled_exec_does_not_raise_until_the_kill_has_finished(
    backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch: pytest.MonkeyPatch
) -> None:
    docker_client.add_container()
    api = docker_client.api
    hold_forever(api)
    log: list[str] = []
    original = api.exec_inspect

    def inspect(exec_id: str) -> dict[str, Any]:
        found = original(exec_id)
        if api.execs[exec_id].kind == 'kill' and api.execs[exec_id].inspects == 1:
            # The kill is slow: it needs another look before it is done.
            time.sleep(0.15)
            log.append('kill inspected')
        return found

    monkeypatch.setattr(api, 'exec_inspect', inspect)

    async def scenario() -> None:
        task = asyncio.ensure_future(backend.exec(CID, wrap_command('sleep 300', 60), 60))
        while 'poll' not in kinds(api):
            await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        log.append('raised')

    asyncio.run(scenario())
    assert log == ['kill inspected', 'raised']


def test_the_kill_and_the_drain_fit_in_the_time_a_session_waits_for_a_cancelled_call() -> None:
    import importlib

    pristine = importlib.reload(kata)
    assert pristine.KILL_TIMEOUT_S + pristine.DRAIN_TIMEOUT_S < CANCEL_WAIT_S


@pytest.mark.parametrize('script', [KILL_SCRIPT, VERIFY_SCRIPT, POLL_SCRIPT], ids=['kill', 'verify', 'poll'])
def test_the_guest_scripts_are_valid_bash(script: str) -> None:
    done = subprocess.run(['/bin/bash', '-n', '-c', script], capture_output=True, text=True, check=False)
    assert (done.returncode, done.stderr) == (0, '')


def test_the_kill_script_signals_the_whole_guest_and_only_exits_clean_when_no_uid_1000_process_remains() -> None:
    # The kill signals; its status is not trusted (T14 security B1). The verdict, run as nobody, decides.
    assert 'kill -9 -1' in KILL_SCRIPT and 'exit 0' in KILL_SCRIPT
    assert 'exit 0' in VERIFY_SCRIPT and VERIFY_SCRIPT.rstrip().endswith('exit 1')
    assert 'Uid:' in VERIFY_SCRIPT and '= 1000' in VERIFY_SCRIPT and 'kill' not in VERIFY_SCRIPT


def exec_failures() -> list[tuple[str, Exception]]:
    return [(where, e) for where in ('exec_create', 'exec_start main', 'inspect', 'get') for e in make_errors()]


@pytest.mark.parametrize(
    ('where', 'error'),
    exec_failures(),
    ids=[f'{w}-{type(e).__name__}' for w, e in exec_failures()],
)
def test_an_sdk_error_anywhere_in_exec_is_a_sandbox_error_with_no_daemon_url_or_host_path(
    backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch: pytest.MonkeyPatch, where: str, error: Exception
) -> None:
    docker_client.add_container()
    api = docker_client.api
    if where == 'inspect':
        api.inspect_errors['main'] = error
    elif where == 'get':
        monkeypatch.setattr(docker_client.containers, 'get', lambda name: (_ for _ in ()).throw(error))
    else:
        api.errors[where] = error
    with pytest.raises(SandboxError) as raised:
        run_exec(backend)
    assert leaks(raised.value) == []
    assert raised.value.__cause__ is None


# put_files.


def untar(tree: dict[str, Any], data: bytes) -> None:
    """Docker's untar as described in put_archive_bytes: a directory entry merges into an existing directory (an
    existing path of another kind is replaced); any other entry removes what is at its path first, without
    following it, then writes itself. `tree` maps paths to ('dir'|'file'|'link', owner, mode, content/target)."""
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        for member in tar.getmembers():
            path = f'/workspace/{member.name}'
            if member.isdir():
                if path not in tree or tree[path][0] != 'dir':
                    drop(tree, path)
                    tree[path] = ('dir', member.uid, member.mode, None)
                else:
                    tree[path] = ('dir', member.uid, member.mode, None)
            else:
                drop(tree, path)
                body = tar.extractfile(member)
                tree[path] = ('file', member.uid, member.mode, body.read() if body else b'')


def drop(tree: dict[str, Any], path: str) -> None:
    for existing in [p for p in tree if p == path or p.startswith(path + '/')]:
        del tree[existing]


@pytest.mark.parametrize('before', ['symlink', 'file', 'dir with planted file', 'user-owned dir', 'dir with a symlink'])
def test_the_archive_replaces_whatever_was_at_the_name_rather_than_merging(before: str) -> None:
    victim = '/workspace/victim'
    tree: dict[str, Any] = {victim: ('file', 1000, 0o644, b'untouched')}
    if before == 'symlink':
        tree['/workspace/uploads'] = ('link', 1000, 0o777, victim)
    elif before == 'file':
        tree['/workspace/uploads'] = ('file', 1000, 0o644, b'x')
    else:
        tree['/workspace/uploads'] = ('dir', 1000, 0o755, None)
        tree['/workspace/uploads/planted.sh'] = ('file', 1000, 0o755, b'#!/bin/sh')
        if before == 'dir with a symlink':
            tree['/workspace/uploads/a.txt'] = ('link', 1000, 0o777, victim)
    untar(tree, kata.put_archive_bytes('uploads', [('a.txt', b'alpha', 0o444), ('b.csv', b'1,2', 0o555)], 1.0))
    assert tree == {
        victim: ('file', 1000, 0o644, b'untouched'),
        '/workspace/uploads': ('dir', 0, 0o555, None),
        '/workspace/uploads/a.txt': ('file', 0, 0o444, b'alpha'),
        '/workspace/uploads/b.csv': ('file', 0, 0o555, b'1,2'),
    }


def test_a_name_of_255_bytes_and_one_with_a_newline_survive_the_archive() -> None:
    long_name, odd = 'n' * 251 + '.csv', 'a\nb c;d'
    data = kata.put_archive_bytes('d', [(long_name, b'1', 0o444), (odd, b'2', 0o444)], 1.0)
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        assert [m.name for m in tar.getmembers()][2:] == [f'd/{long_name}', f'd/{odd}']


def test_put_files_of_no_files_makes_the_empty_directory(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.add_container()
    put_ok(docker_client.api, [])
    asyncio.run(backend.put_files(CID, 'uploads', []))
    assert len(docker_client.api.put) == 1


@pytest.mark.parametrize(
    ('dir_name', 'files', 'error'),
    [
        ('..', [], ValueError),
        ('.', [], ValueError),
        ('', [], ValueError),
        ('a/b', [], ValueError),
        ('a\0', [], ValueError),
        ('d' * 256, [], ValueError),
        (b'uploads', [], TypeError),
        ('d', [('..', b'', 0o444)], ValueError),
        ('d', [('a/b', b'', 0o444)], ValueError),
        ('d', [('', b'', 0o444)], ValueError),
        ('d', [('/etc/passwd', b'', 0o444)], ValueError),
        ('d', [('a', b'', 0o444), ('a', b'', 0o444)], ValueError),
        ('d', [('a', b'', 0o644)], ValueError),
        ('d', [('a', b'', 0o200)], ValueError),
        ('d', [('a', b'', 0o020)], ValueError),
        ('d', [('a', b'', 0o002)], ValueError),
        ('d', [('a', b'', 0o4555)], ValueError),
        ('d', [('a', b'', 0o2555)], ValueError),
        ('d', [('a', b'', 0o1555)], ValueError),
        ('d', [('a', b'', -1)], ValueError),
        ('d', [('a', b'', True)], TypeError),
        ('d', [('a', b'', 292.0)], TypeError),
        ('d', [('a', 'text', 0o444)], TypeError),
        ('d', [(b'a', b'', 0o444)], TypeError),
        ('d', (('a', b'', 0o444),), TypeError),
    ],
)
def test_put_files_refuses_a_bad_directory_name_or_mode_before_any_sdk_call(
    docker_client: FakeDocker, host: Host, tmp_path: Path, fast: None, dir_name: Any, files: Any, error: type
) -> None:
    calls: list[int] = []
    backend = KataDockerBackend(
        tmp_path / 'volumes', client_factory=lambda: calls.append(1) or cast(Any, docker_client)
    )
    with pytest.raises(error):
        asyncio.run(backend.put_files(CID, dir_name, files))
    assert calls == [] and docker_client.api.put == [] and docker_client.api.execs == {}


def test_put_files_into_a_sandbox_that_is_not_running_sends_nothing(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container(status='exited')
    with pytest.raises(SandboxNotRunning):
        asyncio.run(backend.put_files(CID, 'uploads', FILES))
    assert docker_client.api.put == []


def test_put_files_the_daemon_declines_is_an_error_and_nothing_is_read_back(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container()
    docker_client.api.put_result = False
    with pytest.raises(SandboxError, match='did not take'):
        asyncio.run(backend.put_files(CID, 'uploads', FILES))
    assert docker_client.api.responses == []


@pytest.mark.parametrize(
    'view',
    [
        b'1000 755\n',
        b'0 555\na.txt\0b.csv\0planted\0',
        b'0 555\na.txt\0',
        b'0 5555\na.txt\0b.csv\0',
        b'',
        b'0 555',
        'text',
    ],
    ids=['old owner', 'planted extra file', 'missing file', 'wrong mode', 'empty', 'no newline', 'not bytes'],
)
def test_put_files_whose_guest_view_never_matches_times_out_with_fixed_text_after_polling(
    backend: KataDockerBackend, docker_client: FakeDocker, view: Any
) -> None:
    docker_client.add_container()
    api = docker_client.api
    put_ok(api, FILES)
    api.guest_views = [view]
    started = time.monotonic()
    with pytest.raises(SandboxError, match='did not see the copied files in time') as raised:
        asyncio.run(backend.put_files(CID, 'uploads', FILES))
    assert 0.4 < time.monotonic() - started < 3
    assert kinds(api).count('stat') >= 2
    assert leaks(raised.value) == []


def test_put_files_whose_guest_view_matches_in_any_order_succeeds(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container()
    put_ok(docker_client.api, FILES)
    docker_client.api.guest_views = [b'0 555\nb.csv\0a.txt\0']
    asyncio.run(backend.put_files(CID, 'uploads', FILES))


def test_put_files_whose_guest_exec_fails_is_a_scrubbed_sandbox_error(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container()
    api = docker_client.api
    put_ok(api, FILES)
    api.errors['exec_start stat'] = docker.errors.APIError(LEAK)
    with pytest.raises(SandboxError) as raised:
        asyncio.run(backend.put_files(CID, 'uploads', FILES))
    assert leaks(raised.value) == []


def test_put_files_stat_of_the_directory_through_a_symlink_swap_is_refused(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container()
    api = docker_client.api
    archive(api, '/workspace/uploads', kata._GO_SYMLINK | 0o777, 4, uid=1000, link='/etc')
    with pytest.raises(SandboxError, match='is not a root-owned 0555 directory'):
        asyncio.run(backend.put_files(CID, 'uploads', []))


# get_files and stat.


def archive_of(api: FakeAPI, path: str, go_mode: int, size: int, body: bytes | None = None, kind: bytes | None = None):
    """Register `path` whose daemon header says (go_mode, size) but whose tar body is as given."""
    archive(api, path, go_mode, size)
    original = api._archive

    def fake(url: str, params: dict[str, str]) -> FakeResponse:
        response = original(url, params)
        if params['path'] != path or response.status_code != 200:
            return response
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as tar:
            info = tarfile.TarInfo(path.rsplit('/', 1)[1])
            info.type = kind or tarfile.REGTYPE
            if info.type in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                info.linkname = '/etc/passwd'
            else:
                info.size = len(body or b'')
            tar.addfile(info, io.BytesIO(body or b'') if info.size else None)
        response.raw = io.BytesIO(buffer.getvalue())
        return response

    cast(Any, api)._archive = fake


def test_get_files_returns_a_file_of_exactly_max_bytes_and_omits_one_byte_more(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container()
    api = docker_client.api
    archive(api, '/workspace/exact', 0o644, 10)
    archive(api, '/workspace/over', 0o644, 11)
    got = asyncio.run(backend.get_files(CID, ['/workspace/exact', '/workspace/over'], 10))
    assert got == {'/workspace/exact': b'x' * 10}
    over = [r for r in api.responses if json.loads(_header(r))['size'] == 11]
    assert over and all(r.raw.tell() == 0 and r.closed for r in over)


def _header(response: FakeResponse) -> bytes:
    return b64decode(response.headers['X-Docker-Container-Path-Stat'])


def test_get_files_with_a_zero_limit_returns_only_an_empty_file(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container()
    archive(docker_client.api, '/workspace/empty', 0o644, 0)
    archive(docker_client.api, '/workspace/one', 0o644, 1)
    assert asyncio.run(backend.get_files(CID, ['/workspace/empty', '/workspace/one'], 0)) == {'/workspace/empty': b''}


def test_get_files_of_no_paths_is_empty_and_asks_the_daemon_nothing(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container()
    assert asyncio.run(backend.get_files(CID, [], 10)) == {}
    assert docker_client.api.responses == []


@pytest.mark.parametrize(
    'go_mode',
    [DIR | 0o755, kata._GO_SYMLINK | 0o777, kata._GO_PIPE | 0o644, kata._GO_SOCKET | 0o755, kata._GO_DEVICE | 0o666],
    ids=['dir', 'symlink', 'fifo', 'socket', 'device'],
)
def test_get_files_omits_every_non_regular_path_without_reading_its_body(
    backend: KataDockerBackend, docker_client: FakeDocker, go_mode: int
) -> None:
    docker_client.add_container()
    archive(docker_client.api, '/workspace/odd', go_mode, 3)
    assert asyncio.run(backend.get_files(CID, ['/workspace/odd'], 100)) == {}
    assert all(r.raw.tell() == 0 and r.closed for r in docker_client.api.responses)


@pytest.mark.parametrize('kind', [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE, tarfile.FIFOTYPE])
def test_get_files_omits_a_path_whose_header_says_regular_but_whose_tar_entry_is_not(
    backend: KataDockerBackend, docker_client: FakeDocker, kind: bytes
) -> None:
    docker_client.add_container()
    archive_of(docker_client.api, '/workspace/f', 0o644, 3, kind=kind)
    assert asyncio.run(backend.get_files(CID, ['/workspace/f'], 100)) == {}


def test_get_files_never_returns_part_of_a_body_that_the_stream_cut_short(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container()
    api = docker_client.api
    archive(api, '/workspace/f', 0o644, 20)
    original = api._archive

    def cut(url: str, params: dict[str, str]) -> FakeResponse:
        response = original(url, params)
        response.raw = io.BytesIO(response.raw.getvalue()[: 512 + 5])
        return response

    cast(Any, api)._archive = cut
    try:
        got = asyncio.run(backend.get_files(CID, ['/workspace/f'], 100))
    except SandboxError as e:
        assert leaks(e) == []
    else:
        assert got == {}


def test_get_files_omits_a_path_whose_directory_is_a_symlink_deeper_than_the_first_level(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container()
    api = docker_client.api
    archive(api, '/workspace/a', DIR | 0o755)
    archive(api, '/workspace/a/b', kata._GO_SYMLINK | 0o777, 4, link='/etc')
    archive(api, '/workspace/a/b/c', 0o644, 3)
    assert asyncio.run(backend.get_files(CID, ['/workspace/a/b/c'], 100)) == {}
    assert asyncio.run(backend.stat(CID, '/workspace/a/b/c')) is None


def test_get_files_omits_a_path_whose_parent_is_missing_or_is_a_regular_file(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container()
    api = docker_client.api
    archive(api, '/workspace/file', 0o644, 3)
    archive(api, '/workspace/file/inside', 0o644, 3)
    paths = ['/workspace/file/inside', '/workspace/nodir/x']
    assert asyncio.run(backend.get_files(CID, paths, 100)) == {}


@pytest.mark.parametrize(
    ('go_mode', 'kind'),
    [
        (kata._GO_PIPE | 0o644, 'other'),
        (kata._GO_SOCKET | 0o755, 'other'),
        (kata._GO_DEVICE | kata._GO_CHARDEV | 0o666, 'other'),
        (kata._GO_DEVICE | 0o660, 'other'),
        (kata._GO_SYMLINK | 0o777, 'symlink'),
        (DIR | 0o755, 'dir'),
        (0o644, 'file'),
    ],
    ids=['fifo', 'socket', 'chardev', 'blockdev', 'symlink', 'dir', 'file'],
)
def test_stat_reports_each_kind_the_way_the_contract_says(
    backend: KataDockerBackend, docker_client: FakeDocker, go_mode: int, kind: str
) -> None:
    docker_client.add_container()
    archive(docker_client.api, '/workspace/x', go_mode, 3, uid=1000, link='/etc')
    found = asyncio.run(backend.stat(CID, '/workspace/x'))
    assert found is not None and found.kind == kind
    assert found.uid == (-1 if go_mode & kata._GO_SOCKET else 1000)


def test_stat_of_the_workspace_itself_and_of_a_missing_path(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container()
    archive(docker_client.api, '/workspace', DIR | 0o755, uid=1000)
    root = asyncio.run(backend.stat(CID, '/workspace'))
    assert root is not None and (root.kind, root.uid) == ('dir', 1000)
    assert asyncio.run(backend.stat(CID, '/workspace/missing')) is None


@pytest.mark.parametrize(
    'path',
    [
        '/etc/passwd',
        '/workspace/../etc/passwd',
        'workspace/x',
        '/workspace/x/',
        '/workspace//x',
        '/workspace/./x',
        '/workspaces',
        '/workspace/\0',
    ],
)
def test_stat_refuses_a_path_outside_the_workspace_before_any_sdk_call(
    docker_client: FakeDocker, host: Host, tmp_path: Path, fast: None, path: str
) -> None:
    calls: list[int] = []
    backend = KataDockerBackend(
        tmp_path / 'volumes', client_factory=lambda: calls.append(1) or cast(Any, docker_client)
    )
    with pytest.raises(ValueError):
        asyncio.run(backend.stat(CID, path))
    assert calls == [] and docker_client.api.responses == []


def test_the_daemons_http_error_on_an_archive_read_is_scrubbed(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container()
    archive(docker_client.api, '/workspace/f', 0o644, 3)
    docker_client.api.archive_status['/workspace/f'] = 500
    for call in (lambda: backend.stat(CID, '/workspace/f'), lambda: backend.get_files(CID, ['/workspace/f'], 9)):
        with pytest.raises(SandboxError) as raised:
            asyncio.run(call())
        assert leaks(raised.value) == []
    assert all(r.closed for r in docker_client.api.responses)


def file_failures() -> list[tuple[str, Exception]]:
    return [(op, e) for op in ('stat', 'get_files', 'put_files') for e in make_errors()]


@pytest.mark.parametrize(
    ('op', 'error'), file_failures(), ids=[f'{op}-{type(e).__name__}' for op, e in file_failures()]
)
def test_an_sdk_error_in_a_file_call_is_a_sandbox_error_with_no_daemon_url_or_host_path(
    backend: KataDockerBackend, docker_client: FakeDocker, op: str, error: Exception
) -> None:
    docker_client.add_container()
    api = docker_client.api
    put_ok(api, FILES)
    archive(api, '/workspace/d', DIR | 0o755)
    archive(api, '/workspace/d/f', 0o644, 3)
    api.errors['put_archive' if op == 'put_files' else 'head' if op == 'stat' else 'get'] = error
    calls = {
        'stat': lambda: backend.stat(CID, '/workspace/d/f'),
        'get_files': lambda: backend.get_files(CID, ['/workspace/d/f'], 9),
        'put_files': lambda: backend.put_files(CID, 'uploads', FILES),
    }
    with pytest.raises(SandboxError) as raised:
        asyncio.run(calls[op]())
    assert leaks(raised.value) == []
    assert raised.value.__cause__ is None


# Lifecycle and listing: every SDK error type, scrubbed.


def lifecycle_failures() -> list[tuple[str, Exception]]:
    return [(op, e) for op in ('stop', 'destroy', 'list', 'create', 'ready') for e in make_errors()]


@pytest.mark.parametrize(
    ('op', 'error'),
    lifecycle_failures(),
    ids=[f'{op}-{type(e).__name__}' for op, e in lifecycle_failures()],
)
def test_an_sdk_error_in_a_lifecycle_call_is_a_sandbox_error_with_no_daemon_url_or_host_path(
    backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch: pytest.MonkeyPatch, op: str, error: Exception
) -> None:
    docker_client.add_container()
    docker_client.add_volume()

    def boom(*args: Any, **kwargs: Any) -> Any:
        raise error

    if op in ('stop', 'destroy'):
        docker_client.remove_error = error
    elif op == 'list':
        docker_client.list_error = error
    elif op == 'create':
        docker_client.containers_by_name.clear()
        monkeypatch.setattr(docker_client.containers, 'run', boom)
    else:
        monkeypatch.setattr(docker_client.images, 'get', boom)
    calls = {
        'stop': lambda: backend.stop(CID),
        'destroy': lambda: backend.destroy(CID),
        'list': lambda: backend.list_sandboxes(),
        'create': lambda: backend.create(CID, SandboxSpec(CID, 'data')),
        'ready': lambda: backend.ready(),
    }
    if op == 'ready':
        reason = asyncio.run(backend.ready())
        assert isinstance(reason, str) and all(word not in reason for word in FORBIDDEN)
        return
    try:
        asyncio.run(calls[op]())
    except SandboxError as e:
        assert leaks(e) == []
        assert e.__cause__ is None
    else:
        # A container or volume that is already gone is what stop and destroy are asked to reach.
        assert isinstance(error, docker.errors.NotFound) and op in ('stop', 'destroy')


# create.

BAD_IDS = [
    CID.upper(),
    CID.replace('-', ''),
    f'{{{CID}}}',
    f'urn:uuid:{CID}',
    f'{CID}\n',
    f' {CID}',
    f'{CID}/../etc',
    '../../etc/passwd',
    'a' * 4096,
    '',
    f'{CID[:-1]}١',
    f'{CID}; rm -rf /',
]


class Sneaky(str):
    """A str equal to the key that formats as something else."""

    def __format__(self, spec: str) -> str:
        return '../../evil'

    def __str__(self) -> str:
        return '../../evil'


def counting_backend(
    docker_client: FakeDocker, tmp_path: Path, calls: list[int], workspace: int = 16 * 1024 * 1024
) -> KataDockerBackend:
    return KataDockerBackend(
        tmp_path / 'volumes',
        client_factory=lambda: calls.append(1) or cast(Any, docker_client),
        workspace_bytes=workspace,
    )


@pytest.mark.parametrize('chat_id', [*BAD_IDS, 7, None, b'x'], ids=lambda c: repr(c)[:30])
def test_a_hostile_chat_id_is_refused_by_every_call_before_the_sdk_or_the_host_is_touched(
    docker_client: FakeDocker, host: Host, tmp_path: Path, fast: None, chat_id: Any
) -> None:
    calls: list[int] = []
    backend = counting_backend(docker_client, tmp_path, calls)
    spec = SandboxSpec(CID, 'data')
    argv = wrap_command('true', 5)
    operations: list[Callable[[], Any]] = [
        lambda: backend.create(chat_id, spec),
        lambda: backend.stop(chat_id),
        lambda: backend.destroy(chat_id),
        lambda: backend.exec(chat_id, argv, 5),
        lambda: backend.put_files(chat_id, 'd', []),
        lambda: backend.get_files(chat_id, ['/workspace/f'], 1),
        lambda: backend.stat(chat_id, '/workspace/f'),
    ]
    for operation in operations:
        with pytest.raises((ValueError, TypeError)):
            asyncio.run(operation())
    assert calls == []
    assert host.runs == [] and docker_client.run_calls == [] and docker_client.api.execs == {}
    assert not (tmp_path / 'volumes').exists()


def test_a_str_subclass_that_formats_differently_from_its_value_never_reaches_a_name(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    sneaky = Sneaky(CID)
    docker_client.add_container()
    asyncio.run(backend.stop(sneaky))
    assert docker_client.removed == [f'lllm-sandbox-{CID}']
    assert 'evil' not in repr(backend._image_path(sneaky)) + kata.container_name(sneaky)


@pytest.mark.parametrize('image', ['gpu', 'DATA', 'data ', 'data\n', '--privileged', '', 'web;x', '../data', None, 3])
def test_a_spec_that_somehow_carries_a_hostile_image_never_creates_anything(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, tmp_path: Path, image: Any
) -> None:
    spec = SandboxSpec(CID, 'data')
    object.__setattr__(spec, 'image', image)
    # Refused as an argument error before any daemon call (the spec's own check, made again).
    with pytest.raises(ValueError, match='image'):
        asyncio.run(backend.create(CID, spec))
    assert docker_client.run_calls == [] and docker_client.volume_creates == []
    # The volume directory holds only the scope id the fixture read; no image was made.
    assert host.runs == [] and not list((tmp_path / 'volumes').glob('*.img'))


def test_a_spec_for_another_chat_is_refused_before_the_sdk(
    docker_client: FakeDocker, host: Host, tmp_path: Path, fast: None
) -> None:
    calls: list[int] = []
    backend = counting_backend(docker_client, tmp_path, calls)
    with pytest.raises(ValueError):
        asyncio.run(backend.create(OTHER, SandboxSpec(CID, 'data')))
    with pytest.raises(TypeError):
        asyncio.run(backend.create(CID, cast(Any, {'chat_id': CID, 'image': 'data'})))
    assert calls == [] and host.runs == []


def test_a_planted_symlink_at_the_image_path_is_replaced_not_followed(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, tmp_path: Path
) -> None:
    volumes = tmp_path / 'volumes'
    volumes.mkdir(exist_ok=True)
    victim = tmp_path / 'victim'
    victim.write_text('precious')
    (volumes / f'{CID}.img').symlink_to(victim)
    asyncio.run(backend.create(CID, SandboxSpec(CID, 'data')))
    image = volumes / f'{CID}.img'
    assert victim.read_text() == 'precious'
    assert image.is_file() and not image.is_symlink() and image.stat().st_size == 16 * 1024 * 1024


# The host tools.


def run_argvs(host: Host) -> list[list[str]]:
    return host.runs


@pytest.mark.parametrize('directory', ['volumes', 'my volumes; rm -rf x', "it's $(touch pwned)", 'tab\there'])
def test_the_host_tools_get_a_fixed_argv_in_which_only_the_key_and_the_image_path_vary(
    docker_client: FakeDocker, host: Host, tmp_path: Path, fast: None, directory: str
) -> None:
    volume_dir = tmp_path / directory
    docker_client.scope = kata.scope_of(volume_dir)
    backend = KataDockerBackend(
        volume_dir, client_factory=lambda: cast(Any, docker_client), workspace_bytes=16 * 1024 * 1024
    )
    asyncio.run(backend.create(CID, SandboxSpec(CID, 'data')))
    image = str(volume_dir.resolve() / f'{CID}.img')
    assert host.runs == [
        [
            '/usr/sbin/mkfs.ext4',
            '-q',
            '-F',
            '-b',
            '4096',
            '-m',
            '0',
            '-U',
            CID,
            '-E',
            'root_owner=1000:1000',
            image,
            '3072',
        ],
        ['/usr/sbin/debugfs', '-w', '-R', 'rmdir lost+found', image],
        ['/usr/sbin/udisksctl', 'loop-setup', '--no-user-interaction', '--no-partition-scan', '-f', image],
    ]
    assert not (tmp_path / 'pwned').exists()


def test_destroy_detaches_only_the_loop_device_backing_that_chats_image(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, tmp_path: Path
) -> None:
    mine = str(tmp_path / 'volumes' / f'{CID}.img')
    theirs = str(tmp_path / 'volumes' / f'{OTHER}.img')
    host.attach(theirs, OTHER)
    host.attach(mine, CID)
    docker_client.add_container()
    docker_client.add_volume()
    asyncio.run(backend.destroy(CID))
    assert host.runs == [['/usr/sbin/udisksctl', 'loop-delete', '--no-user-interaction', '-b', '/dev/loop1']]
    assert (host.sys_block / 'loop0' / 'loop' / 'backing_file').read_text().strip() == theirs


def test_an_image_attached_under_a_look_alike_backing_path_is_not_taken_for_it(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, tmp_path: Path
) -> None:
    host.attach(str(tmp_path / 'volumes' / f'{CID}.img.bak'), 'ffffffff-ffff-4fff-8fff-ffffffffffff')
    host.attach(str(tmp_path / 'volumes' / '..' / 'volumes' / f'{CID}.img'), 'ffffffff-ffff-4fff-8fff-fffffffffffe')
    asyncio.run(backend.destroy(CID))
    assert host.runs == []


def test_the_image_path_of_a_key_cannot_leave_the_volume_directory(backend: KataDockerBackend) -> None:
    for bad in ('../x', '/etc/passwd', f'{CID}/../..'):
        with pytest.raises(ValueError):
            backend._image_path(bad)
    assert backend._image_path(CID).parent == backend._volume_dir


def test_the_attach_waits_for_the_by_uuid_link_to_name_that_loop_device_and_gives_up_without_a_path_in_the_error(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, tmp_path: Path
) -> None:
    host.link_appears = False
    with pytest.raises(SandboxError) as raised:
        asyncio.run(backend.create(CID, SandboxSpec(CID, 'data')))
    assert leaks(raised.value) == [] and str(tmp_path) not in str(raised.value)
    assert docker_client.run_calls == [] and docker_client.volume_creates == []


# list_sandboxes.


def test_list_sandboxes_ignores_anything_not_labelled_as_a_chat_uuid(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container(CID)
    stray = docker_client.add_container(OTHER)
    stray.labels['lllm.chat'] = 'not-a-uuid'
    upper = docker_client.add_container('2c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f')
    upper.labels['lllm.chat'] = upper.labels['lllm.chat'].upper()
    bare = docker_client.add_container('3c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f')
    bare.labels = {'lllm.scope': docker_client.scope}
    volume = docker_client.add_volume('4c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f')
    volume.attrs['Labels']['lllm.chat'] = '../../x'
    assert [i.chat_id for i in asyncio.run(backend.list_sandboxes())] == [CID]


def test_list_sandboxes_reports_an_unknown_image_label_as_none_and_ephemeral_from_either_label(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container(CID, image='gpu')
    docker_client.add_volume(CID, **{'lllm.ephemeral': '1'})
    docker_client.add_container(OTHER, image='web', **{'lllm.ephemeral': '1'})
    found = {i.chat_id: i for i in asyncio.run(backend.list_sandboxes())}
    assert found[CID].image is None and found[CID].running and found[CID].ephemeral
    assert found[OTHER].image == 'web' and found[OTHER].ephemeral


# The lifespan.


class Holder:
    """A real second process holding the lock file."""

    def __init__(self, path: Path) -> None:
        code = (
            'import fcntl, sys\nf = open(sys.argv[1], "a")\nfcntl.flock(f, fcntl.LOCK_EX)\n'
            'print("locked", flush=True)\nsys.stdin.read()\n'
        )
        self.process = subprocess.Popen(
            [sys.executable, '-I', '-c', code, str(path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True
        )
        assert self.process.stdout is not None and self.process.stdout.readline().strip() == 'locked'

    def release(self) -> None:
        assert self.process.stdin is not None
        self.process.stdin.close()
        self.process.wait(10)
        assert self.process.stdout is not None
        self.process.stdout.close()


class NeverReady(FakeBackend):
    def __init__(self) -> None:
        super().__init__()
        self.ready_calls = 0

    async def ready(self) -> str | None:
        self.ready_calls += 1
        return await super().ready()


@pytest.mark.parametrize(
    'ask', [['--workers', '2'], ['--workers=8'], ['--port', '1', '--workers', '3', '--reload']], ids=str
)
def test_the_lifespan_refuses_when_uvicorn_was_asked_for_workers_and_takes_no_lock(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, ask: list[str]
) -> None:
    saved = list(sys.argv)
    sys.argv[:] = ['uvicorn', 'local_llm.main:app', *ask]
    app, fake = App(), NeverReady()
    try:
        asyncio.run(lifespan.start(app, fake, tmp_path / 'sandbox'))
    finally:
        sys.argv[:] = saved
    assert (app.state.sandbox, app.state.sandbox_lock, app.state.sandbox_maintenance) == (None, None, None)
    assert fake.ready_calls == 0
    assert not (tmp_path / 'sandbox').exists()
    assert 'single server process' in caplog.text


@pytest.mark.parametrize('name', ['WEB_CONCURRENCY', 'UVICORN_WORKERS'])
def test_the_lifespan_refuses_when_the_environment_asks_for_workers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    monkeypatch.setattr(sys, 'argv', ['uvicorn'])
    real = lifespan.server_workers
    monkeypatch.setattr(lifespan, 'server_workers', lambda: real(['uvicorn'], {name: '4'}))
    app = App()
    asyncio.run(lifespan.start(app, NeverReady(), tmp_path / 'sandbox'))
    assert app.state.sandbox is None and not (tmp_path / 'sandbox').exists()


def test_a_second_process_holding_the_lock_makes_the_lifespan_refuse_until_it_lets_go(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(lifespan, 'server_workers', lambda: 1)
    directory = tmp_path / 'sandbox'
    directory.mkdir()
    holder = Holder(directory / lifespan.LOCK_FILE)
    app, fake = App(), NeverReady()
    try:
        asyncio.run(lifespan.start(app, fake, directory))
    finally:
        holder.release()
    assert app.state.sandbox is None and app.state.sandbox_lock is None and fake.ready_calls == 0
    assert 'another server process' in caplog.text

    async def later() -> None:
        await lifespan.start(app, FakeBackend(), directory)
        assert app.state.sandbox is not None
        assert not app.state.sandbox_lock.closed
        await lifespan.stop(app, stop_running=False)
        assert app.state.sandbox_lock is None

    asyncio.run(later())


def test_the_lock_directory_is_private_and_stop_closes_the_lock_even_when_called_twice(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(lifespan, 'server_workers', lambda: 1)
    app = App()

    async def scenario() -> Any:
        await lifespan.start(app, FakeBackend(), tmp_path / 'sandbox')
        handle = app.state.sandbox_lock
        await lifespan.stop(app, stop_running=False)
        await lifespan.stop(app, stop_running=False)
        return handle

    handle = asyncio.run(scenario())
    assert handle.closed
    assert (tmp_path / 'sandbox').stat().st_mode & 0o777 == 0o700


def test_stop_on_an_app_that_never_started_the_sandbox_is_harmless() -> None:
    asyncio.run(lifespan.stop(SimpleNamespace(state=SimpleNamespace()), stop_running=True))


def test_a_startup_sweep_that_hangs_does_not_hold_the_app_back_and_stop_ends_the_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(lifespan, 'server_workers', lambda: 1)
    monkeypatch.setattr(lifespan, 'STARTUP_SWEEP_TIMEOUT_S', 0.05)
    monkeypatch.setattr(lifespan, 'SWEEP_RETRY_S', 3600)
    fake = FakeBackend()

    async def hang() -> list[Any]:
        await asyncio.sleep(3600)
        return []

    monkeypatch.setattr(fake, 'list_sandboxes', hang)
    app = App()

    async def scenario() -> float:
        started = time.monotonic()
        await lifespan.start(app, fake, tmp_path / 'sandbox')
        took = time.monotonic() - started
        assert app.state.sandbox is not None and not app.state.sandbox_maintenance.done()
        await lifespan.stop(app, stop_running=False)
        assert app.state.sandbox_maintenance is None
        return took

    assert asyncio.run(scenario()) < 5


def test_the_lifespan_start_does_not_make_the_sweep_run_before_the_lock_is_held(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(lifespan, 'server_workers', lambda: 1)
    directory = tmp_path / 'sandbox'
    directory.mkdir()
    holder = Holder(directory / lifespan.LOCK_FILE)
    fake = FakeBackend()
    asyncio.run(fake.create(CID, SandboxSpec(CID, 'data')))
    try:
        asyncio.run(lifespan.start(App(), fake, directory))
    finally:
        holder.release()
    assert fake.sandboxes[CID].running is True
