"""The Kata backend (local_llm/sandbox/kata.py) and its lifespan wiring (sandbox/lifespan.py), against a mocked SDK.

Always run: no Docker, Kata, udisks or KVM needed. A fake Docker client
stands in for the SDK, the host tools (`mkfs.ext4`, `debugfs`, `udisksctl`)
are replaced by a recorder, and /sys/block and /dev/disk/by-uuid by
temporary directories. The real thing is test_sandbox_kata.py
(LLLM_TEST_KATA=1). Pins:

- `create` passes exactly the fixed options (Q8, Q9, Q16), nothing from the
  caller beyond the validated image key and UUID, reuses a running
  container of the same image, replaces one of another image, makes the
  fixed-size workspace volume once (image file, mkfs, loop device, local
  volume by UUID), and refuses with the readiness reason before anything is
  created;
- `exec` streams both outputs through the caps, maps exit statuses, reads a
  137 as an OOM kill only while the container still runs, finds the end of
  a command whose background child holds the stream through the watcher
  exec, enforces the host-side deadline, runs the kill after every exec,
  fails closed when the kill cannot be confirmed, and on cancellation kills
  first and only then raises;
- `put_files` sends the replace-not-merge archive and checks the result with
  the daemon's stat; `get_files` and `stat` read the daemon's path stat
  before any body and never go through a symlink;
- `list_sandboxes`, `stop`, `destroy` and `ready` (each reason) call the
  right SDK methods, and every SDK error becomes a SandboxError with fixed
  wording;
- the image tag agrees with infra/sandbox/TAG;
- the lifespan wiring starts one manager per data directory, never with more
  than one worker, and starts the app whatever the backend's state.

Run from apps/server (any LLLM_SECRET_KEY of 32 characters or more):

    LLLM_SECRET_KEY=... python -m pytest tests/test_sandbox_kata_unit.py
"""

import asyncio
import http.client
import io
import json
import os
import socket
import struct
import subprocess
import tarfile
import threading
import time
from base64 import b64decode, b64encode
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import docker.errors
import docker.types
import pytest
import requests
import urllib3.exceptions

from local_llm.routers.sandbox import get_sandbox_status
from local_llm.sandbox import kata, lifespan
from local_llm.sandbox.exec import StreamCap, wrap_argv, wrap_command
from local_llm.sandbox.fake import FakeBackend
from local_llm.sandbox.kata import (
    GUARD_SCRIPT,
    IMAGES,
    KILL_SCRIPT,
    POLL_SCRIPT,
    VERIFY_SCRIPT,
    KataDockerBackend,
    container_options,
)
from local_llm.sandbox.limits import CANCEL_WAIT_S
from local_llm.sandbox.manager import SandboxManager
from local_llm.sandbox.types import (
    ImageKey,
    SandboxError,
    SandboxNotRunning,
    SandboxSpec,
    SandboxUnavailable,
)

CID = '0b9a5f3e-6c1d-4f7a-9e2b-3c4d5e6f7a8b'
SCOPE = '0123456789abcdef'
UPLOADS = Path('/srv/lllm/sandbox/uploads') / CID
OTHER = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
REPO = Path(__file__).resolve().parents[3]


# The fake SDK.


def frames(*parts: tuple[int, bytes]) -> bytes:
    return b''.join(struct.pack('>BxxxL', kind, len(data)) + data for kind, data in parts)


class FakeRaw:
    """A raw exec socket: hands out `data`, then blocks (when held) until released, shut down or closed."""

    def __init__(self, data: bytes = b'', *, held: bool = False) -> None:
        self.buffer = bytearray(data)
        self.cond = threading.Condition()
        self.ended = not held
        self.sent = bytearray()
        self.shutdowns: list[int] = []
        self.timeout: object = 'unset'
        self.fail_send = False

    def recv(self, n: int) -> bytes:
        with self.cond:
            while not self.buffer and not self.ended:
                self.cond.wait()
            chunk = bytes(self.buffer[:n])
            del self.buffer[:n]
            return chunk

    def release(self) -> None:
        with self.cond:
            self.ended = True
            self.cond.notify_all()

    def sendall(self, data: bytes) -> None:
        if self.fail_send:
            raise BrokenPipeError
        self.sent += data

    def shutdown(self, how: int) -> None:
        self.shutdowns.append(how)
        if how == socket.SHUT_RDWR:
            self.release()

    def settimeout(self, value: object) -> None:
        self.timeout = value


class FakeResponse:
    def __init__(self, status: int = 200, headers: dict[str, str] | None = None, body: bytes = b'') -> None:
        self.status_code = status
        self.headers = headers or {}
        self.raw = io.BytesIO(body)
        self.closed = False

    def close(self) -> None:
        self.closed = True

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(f'{self.status_code} for http+docker://localhost/secret/host/path')


class FakeSock:
    """docker-py's SocketIO wrapper: the raw socket as `_sock`, and the response it keeps alive."""

    def __init__(self, raw: FakeRaw) -> None:
        self._sock = raw
        self._response = FakeResponse()
        self.closed = False

    def close(self) -> None:
        self.closed = True


class Exec:
    """One exec the fake daemon knows: its kind, how inspect answers, and what it was created with."""

    def __init__(self, kind: str, argv: list[str], kwargs: dict[str, Any]) -> None:
        self.kind = kind
        self.argv = argv
        self.kwargs = kwargs
        self.started = False
        self.inspects = 0


class FakeAPI:
    """The low-level API: execs scripted per kind, the archive endpoints, put_archive."""

    base_url = 'http+docker://localhost'
    api_version = '1.56'

    def __init__(self, daemon: 'FakeDocker') -> None:
        self.daemon = daemon
        self.execs: dict[str, Exec] = {}
        self.order: list[str] = []
        # The main command: what its stream carries, whether a background child holds it, its exit status, and
        # how many inspects report it running first (None: until the kill).
        self.output = frames((1, b'out\n'), (2, b'err\n'))
        self.held = False
        self.exit_code: int | None = 0
        self.running_for: int | None = 0
        self.main_raw: FakeRaw | None = None
        self.release_on_kill = True
        # The watcher: its exit status once done, and how many inspects it runs for first.
        self.poller_exit = 0
        self.poller_runs = 0
        # The kill: kill_exit is the verdict exec's exit status; the kill exec can fail to be created or run forever.
        self.kill_exit = 0
        self.verdicts: list[int] = []
        # The guard check at create: its exit status and what it prints.
        self.guard_exit = 0
        self.guard_said = b''
        self.guard_running_for = 0
        self.kill_create_error: Exception | None = None
        self.kill_hangs = False
        self.kill_seen_main_running = False
        # The guest's view after a put: what the stat exec prints, in turn; None is the true view of the last put.
        self.guest_views: list[bytes | None] = [None]
        # The host directory a guest's /workspace/uploads shows (set by the backend fixture).
        self.uploads_host: Path | None = None
        # Errors to raise from a method, by name.
        self.errors: dict[str, Exception] = {}
        self.inspect_errors: dict[str, Exception] = {}
        self.archives: dict[str, tuple[int, int, int, str]] = {}
        self.put: list[tuple[str, str, bytes]] = []
        self.put_result = True
        self.archive_status: dict[str, int] = {}
        self.responses: list[FakeResponse] = []

    def _fail(self, name: str) -> None:
        error = self.errors.get(name)
        if error is not None:
            raise error

    def exec_create(self, container: str, cmd: list[str], **kwargs: Any) -> dict[str, str]:
        self._fail('exec_create')
        if KILL_SCRIPT in cmd:
            kind = 'kill'
            if self.kill_create_error is not None:
                raise self.kill_create_error
        elif VERIFY_SCRIPT in cmd:
            kind = 'verify'
        elif GUARD_SCRIPT in cmd:
            kind = 'guard'
        elif POLL_SCRIPT in cmd:
            kind = 'poll'
        elif 'lllm-stat' in cmd:
            kind = 'stat'
        else:
            kind = 'main'
        exec_id = f'{kind}-{len(self.execs)}'
        self.execs[exec_id] = Exec(kind, list(cmd), kwargs)
        self.order.append(f'create {kind}')
        return {'Id': exec_id}

    def exec_start(self, exec_id: str, detach: bool = False, socket: bool = False) -> Any:
        record = self.execs[exec_id]
        self._fail(f'exec_start {record.kind}')
        record.started = True
        self.order.append(f'start {record.kind}')
        if record.kind == 'main':
            assert socket and not detach
            self.main_raw = FakeRaw(self.output, held=self.held)
            return FakeSock(self.main_raw)
        if record.kind == 'kill':
            assert detach
            main = self.main()
            self.kill_seen_main_running = main is not None and self._main_running(main)
            if self.release_on_kill and self.main_raw is not None:
                self.main_raw.release()
            if self.running_for is None:
                self.running_for = 0
            return b''
        if record.kind == 'guard':
            return self.guard_said
        if record.kind == 'stat':
            view = self.guest_views.pop(0) if len(self.guest_views) > 1 else self.guest_views[0]
            if view is not None:
                return view
            return self._uploads_view() if record.argv[-1] == '%f/%i\\0' else self._true_view()
        assert detach
        return b''

    def _uploads_view(self) -> bytes:
        """What a guest sees of the uploads mount: the host directory as it is, owner, mode, names and inodes."""
        top = self.uploads_host
        assert top is not None
        info = top.stat()
        names = b''.join(f'{e.name}/{e.inode()}'.encode() + b'\0' for e in os.scandir(top))
        return f'{info.st_uid} {info.st_mode & 0o7777:o}\n'.encode() + names

    def _true_view(self) -> bytes:
        with tarfile.open(fileobj=io.BytesIO(self.put[-1][2])) as tar:
            names = [m.name.split('/', 1)[1] for m in tar.getmembers() if '/' in m.name]
        return b'0 555\n' + b''.join(name.encode() + b'\0' for name in reversed(names))

    def main(self) -> Exec | None:
        return next((e for e in self.execs.values() if e.kind == 'main'), None)

    def _main_running(self, record: Exec) -> bool:
        if self.running_for is None:
            return True
        return record.inspects <= self.running_for

    def exec_inspect(self, exec_id: str) -> dict[str, Any]:
        record = self.execs[exec_id]
        error = self.inspect_errors.get(record.kind)
        if error is not None:
            raise error
        record.inspects += 1
        if record.kind == 'main':
            running = self._main_running(record)
            # Held by a child: the daemon reports it running until the stream ends.
            if self.held and self.main_raw is not None and not self.main_raw.ended:
                running = True
            return {'Running': running, 'ExitCode': None if running else self.exit_code}
        if record.kind == 'poll':
            done = record.inspects > self.poller_runs
            return {'Running': not done, 'ExitCode': self.poller_exit if done else None}
        if record.kind == 'kill':
            if self.kill_hangs:
                return {'Running': True, 'ExitCode': None}
            # The kill's own status means nothing (a survivor can fake it); report success, always.
            return {'Running': False, 'ExitCode': 0}
        if record.kind == 'guard':
            if record.inspects <= self.guard_running_for:
                return {'Running': True, 'ExitCode': None}
            return {'Running': False, 'ExitCode': self.guard_exit}
        if record.kind == 'verify':
            # The verdict, as nobody: kill_exit stands for what it finds, or verdicts, in turn, when given.
            if self.verdicts:
                return {'Running': False, 'ExitCode': self.verdicts.pop(0)}
            return {'Running': False, 'ExitCode': self.kill_exit}
        return {'Running': False, 'ExitCode': 0}

    def put_archive(self, container: str, path: str, data: bytes) -> bool:
        self._fail('put_archive')
        self.put.append((container, path, data))
        return self.put_result

    def _archive(self, url: str, params: dict[str, str]) -> FakeResponse:
        assert url == f'{self.base_url}/v{self.api_version}/containers/{self.daemon.container_id}/archive'
        path = params['path']
        status = self.archive_status.get(path)
        if path not in self.archives:
            response = FakeResponse(status or 404)
        else:
            go_mode, size, uid, link = self.archives[path]
            stat = {
                'name': path.rsplit('/', 1)[1],
                'size': size,
                'mode': go_mode,
                'mtime': '2026-11-11T11:20:08.856534105-06:00',
                'linkTarget': link,
            }
            header = b64encode(json.dumps(stat).encode()).decode()
            response = FakeResponse(
                status or 200, {'X-Docker-Container-Path-Stat': header}, self._tar(path, go_mode, size, uid, link)
            )
        self.responses.append(response)
        return response

    @staticmethod
    def _tar(path: str, go_mode: int, size: int, uid: int, link: str) -> bytes:
        if go_mode & kata._GO_SOCKET:
            return b''
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as tar:
            info = tarfile.TarInfo(path.rsplit('/', 1)[1])
            info.uid = uid
            info.mode = go_mode & 0o7777
            if go_mode & kata._GO_DIR:
                info.type = tarfile.DIRTYPE
                tar.addfile(info)
            elif go_mode & kata._GO_SYMLINK:
                info.type = tarfile.SYMTYPE
                info.linkname = link
                tar.addfile(info)
            elif go_mode & kata._GO_PIPE:
                info.type = tarfile.FIFOTYPE
                tar.addfile(info)
            else:
                info.size = size
                tar.addfile(info, io.BytesIO(b'x' * size))
        return buffer.getvalue()

    def head(self, url: str, params: dict[str, str]) -> FakeResponse:
        self._fail('head')
        return self._archive(url, params)

    def get(self, url: str, params: dict[str, str], stream: bool, headers: dict[str, str]) -> FakeResponse:
        self._fail('get')
        assert stream and headers == {'Accept-Encoding': 'identity'}
        return self._archive(url, params)


class FakeContainer:
    def __init__(
        self, daemon: 'FakeDocker', name: str, status: str, labels: dict[str, str], attrs: dict[str, Any]
    ) -> None:
        self.daemon = daemon
        self.name = name
        self.id = daemon.container_id if name.endswith(CID) else f'id-{name}'
        self.status = status
        self.labels = labels
        self.attrs = attrs

    def remove(self, force: bool = False) -> None:
        assert force
        self.daemon.removed.append(self.name)
        error = self.daemon.remove_error
        if error is not None:
            raise error
        self.daemon.containers_by_name.pop(self.name, None)


class FakeVolume:
    def __init__(self, daemon: 'FakeDocker', name: str, attrs: dict[str, Any]) -> None:
        self.daemon = daemon
        self.name = name
        self.attrs = attrs

    def remove(self) -> None:
        self.daemon.volumes_by_name.pop(self.name, None)
        self.daemon.volume_removed.append(self.name)


class Collection:
    def __init__(self, get: Callable[[str], Any], **methods: Callable[..., Any]) -> None:
        self.get = get
        for name, method in methods.items():
            setattr(self, name, method)


class FakeDocker:
    """The high-level client: containers, volumes, images, networks and info, over a dict of each."""

    container_id = 'cid-1234'

    def __init__(self) -> None:
        # The scope the backend under test lists by (its volume directory's); set by the backend fixture.
        self.scope = '0' * 16
        self.api = FakeAPI(self)
        self.runtimes = {'kata-clh': {}, 'runc': {}}
        self.images_present = set(IMAGES.values())
        self.network = True
        self.network_attrs: dict[str, Any] = {
            'Driver': 'bridge',
            'Internal': True,
            'IPAM': {'Config': [{'Subnet': '10.231.0.0/24', 'IPRange': '10.231.0.128/25', 'Gateway': '10.231.0.128'}]},
            'Options': {
                'com.docker.network.bridge.inhibit_ipv4': 'true',
                'com.docker.network.bridge.name': 'lllm-sandbox',
            },
        }
        self.containers_by_name: dict[str, FakeContainer] = {}
        self.volumes_by_name: dict[str, FakeVolume] = {}
        self.run_calls: list[dict[str, Any]] = []
        self.volume_creates: list[dict[str, Any]] = []
        self.removed: list[str] = []
        self.volume_removed: list[str] = []
        self.remove_error: Exception | None = None
        self.info_error: Exception | None = None
        self.list_error: Exception | None = None
        self.containers = Collection(self._get_container, run=self._run, list=self._list_containers)
        self.volumes = Collection(self._get_volume, create=self._create_volume, list=self._list_volumes)
        self.images = Collection(self._get_image)
        self.networks = Collection(self._get_network)

    def info(self) -> dict[str, Any]:
        if self.info_error is not None:
            raise self.info_error
        return {'Runtimes': self.runtimes}

    def add_container(
        self, key: str = CID, *, status: str = 'running', image: str = 'data', **labels: str
    ) -> FakeContainer:
        name = f'lllm-sandbox-{key}'
        container = FakeContainer(
            self,
            name,
            status,
            {'lllm.chat': key, 'lllm.scope': self.scope, 'lllm.image': image, **labels},
            {
                'State': {'StartedAt': '2026-11-11T17:30:53.215276123Z'},
                'NetworkSettings': {'Networks': {'local-llm_sandbox': {'IPAddress': '10.231.0.129'}}},
            },
        )
        self.containers_by_name[name] = container
        return container

    def add_volume(self, key: str = CID, **labels: str) -> FakeVolume:
        name = f'lllm-sandbox-{key}'
        volume = FakeVolume(
            self,
            name,
            {
                'Labels': {'lllm.chat': key, 'lllm.scope': self.scope, **labels},
                'CreatedAt': '2026-11-11T11:31:23-06:00',
            },
        )
        self.volumes_by_name[name] = volume
        return volume

    def _get_container(self, name: str) -> FakeContainer:
        if name not in self.containers_by_name:
            raise docker.errors.NotFound(f'no container {name}')
        return self.containers_by_name[name]

    def _run(self, **kwargs: Any) -> FakeContainer:
        self.run_calls.append(kwargs)
        key = kwargs['labels']['lllm.chat']
        return self.add_container(key, image=kwargs['labels']['lllm.image'])

    def _list_containers(self, all: bool, filters: dict[str, str], ignore_removed: bool) -> list[FakeContainer]:
        assert all and ignore_removed and filters == {'label': ['lllm.chat', f'lllm.scope={self.scope}']}
        if self.list_error is not None:
            raise self.list_error
        return [c for c in self.containers_by_name.values() if c.labels.get('lllm.scope') == self.scope]

    def _get_volume(self, name: str) -> FakeVolume:
        if name not in self.volumes_by_name:
            raise docker.errors.NotFound(f'no volume {name}')
        return self.volumes_by_name[name]

    def _create_volume(self, **kwargs: Any) -> None:
        self.volume_creates.append(kwargs)
        volume = FakeVolume(
            self, kwargs['name'], {'Labels': kwargs['labels'], 'CreatedAt': '2026-11-11T11:31:23-06:00'}
        )
        self.volumes_by_name[kwargs['name']] = volume

    def _list_volumes(self, filters: dict[str, str]) -> list[FakeVolume]:
        assert filters == {'label': ['lllm.chat', f'lllm.scope={self.scope}']}
        return [v for v in self.volumes_by_name.values() if v.attrs['Labels'].get('lllm.scope') == self.scope]

    def _get_image(self, ref: str) -> SimpleNamespace:
        if ref not in self.images_present:
            raise docker.errors.ImageNotFound(f'no image {ref}')
        return SimpleNamespace(id=f'sha256:{ref}')

    def _get_network(self, name: str) -> SimpleNamespace:
        assert name == 'local-llm_sandbox'
        if not self.network:
            raise docker.errors.NotFound('no network')
        return SimpleNamespace(name=name, attrs=self.network_attrs)


class Host:
    """The host side: /sys/block, /dev/disk/by-uuid and the host tools, in a temporary directory."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.sys_block = root / 'sys-block'
        self.by_uuid = root / 'by-uuid'
        self.sys_block.mkdir()
        self.by_uuid.mkdir()
        # The host's Kata configuration (guest seccomp on, Q19) and the sandbox bridge's IPv6 switch (off, Q20).
        self.kata_config = root / 'configuration-clh-runtime-rs.toml'
        self.kata_config.write_text(
            '[hypervisor.clh]\npath = "/opt/kata/bin/cloud-hypervisor"\n\n'
            '[runtime]\n# disable_guest_seccomp = true\ndisable_guest_seccomp = false\n'
        )
        self.bridge_ipv6 = root / 'disable_ipv6'
        self.bridge_ipv6.write_text('1\n')
        self.runs: list[list[str]] = []
        self.tools = {'udisksctl', 'mkfs.ext4', 'debugfs'}
        self.fail: str | None = None
        self.attach_works = True
        # What the workspace image's root holds under `uploads`, as debugfs's stat reports it.
        self.uploads_entry: str | None = 'directory'
        self.rm_fails = False
        self.link_appears = True
        self.loops = 0

    def which(self, name: str, path: str | None = None) -> str | None:
        assert path == kata.HOST_TOOL_PATH
        return f'/usr/sbin/{name}' if name in self.tools else None

    def attach(self, image: str, key: str) -> str:
        loop = f'loop{self.loops}'
        self.loops += 1
        (self.sys_block / loop / 'loop').mkdir(parents=True)
        (self.sys_block / loop / 'loop' / 'backing_file').write_text(image + '\n')
        # A device number no real mount has.
        (self.sys_block / loop / 'dev').write_text(f'259:{9000 + self.loops}\n')
        if self.link_appears:
            # udev moves the link to the newest device with that filesystem UUID.
            (self.by_uuid / key).unlink(missing_ok=True)
            (self.by_uuid / key).symlink_to(f'/dev/{loop}')
        return loop

    def run(self, argv: list[str], **kwargs: Any) -> SimpleNamespace:
        assert kwargs == {
            'check': True,
            'capture_output': True,
            'text': True,
            'timeout': kata.HOST_TOOL_TIMEOUT_S,
            'env': {'PATH': kata.HOST_TOOL_PATH, 'LC_ALL': 'C'},
        }
        self.runs.append(argv)
        tool = argv[0].rsplit('/', 1)[1]
        if self.fail == tool:
            raise subprocess.CalledProcessError(1, argv, stderr='/home/someone/secret path')
        if tool == 'udisksctl' and argv[1] == 'loop-setup' and self.attach_works:
            image = argv[-1]
            key = Path(image).stem
            self.attach(image, key)
        if tool == 'udisksctl' and argv[1] == 'loop-delete':
            loop = argv[-1].rsplit('/', 1)[1]
            (self.sys_block / loop / 'loop' / 'backing_file').write_text('\n')
        if tool == 'debugfs' and argv[1:3] == ['-R', 'stat uploads']:
            if self.uploads_entry is None:
                return SimpleNamespace(stdout='', stderr='stat: File not found by ext2_lookup while doing stat\n')
            return SimpleNamespace(stdout=f'Inode: 12   Type: {self.uploads_entry}    Mode:  0777\n', stderr='')
        if tool == 'debugfs' and argv[1:4] == ['-w', '-R', 'rm uploads'] and not self.rm_fails:
            self.uploads_entry = None
        return SimpleNamespace(stdout='', stderr='')


def acted(host: Host) -> list[list[str]]:
    """The host tools run, without the read-only check of the workspace's uploads entry."""
    return [argv for argv in host.runs if argv[1:3] != ['-R', 'stat uploads']]


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
    """Short waits, so the waiting paths run in milliseconds."""
    monkeypatch.setattr(kata, 'POLLER_AFTER_S', 0.0)
    monkeypatch.setattr(kata, 'POLL_MAX_S', 0.005)
    monkeypatch.setattr(kata, 'DRAIN_TIMEOUT_S', 0.2)
    monkeypatch.setattr(kata, 'KILL_TIMEOUT_S', 0.2)
    monkeypatch.setattr(kata, 'EXIT_STATUS_WAIT_S', 0.2)
    monkeypatch.setattr(kata, 'GUEST_VIEW_WAIT_S', 0.5)
    monkeypatch.setattr(kata, 'DEVICE_LINK_WAIT_S', 0.2)


@pytest.fixture
def backend(docker_client: FakeDocker, host: Host, tmp_path: Path, fast: None) -> KataDockerBackend:
    docker_client.scope = kata.scope_of(tmp_path / 'volumes')
    docker_client.api.uploads_host = tmp_path / 'uploads' / CID
    return KataDockerBackend(
        tmp_path / 'volumes', client_factory=lambda: docker_client, workspace_bytes=16 * 1024 * 1024
    )


def run_exec(backend: KataDockerBackend, command: str = 'echo hi', timeout_s: int = 5, stdin: bytes | None = None):
    return asyncio.run(backend.exec(CID, wrap_command(command, timeout_s), timeout_s, stdin))


# Module-level pieces.


def test_the_tag_agrees_with_infra_sandbox_tag() -> None:
    assert (REPO / 'infra/sandbox/TAG').read_text().strip() == kata.SANDBOX_IMAGE_TAG
    assert IMAGES == {
        'data': f'local-llm/sandbox-data:{kata.SANDBOX_IMAGE_TAG}',
        'web': f'local-llm/sandbox-web:{kata.SANDBOX_IMAGE_TAG}',
    }


def test_the_mirror_address_is_in_the_fixed_subnet_outside_the_dynamic_range() -> None:
    import ipaddress

    subnet = ipaddress.ip_network(kata.SANDBOX_SUBNET)
    dynamic = ipaddress.ip_network(kata.SANDBOX_IP_RANGE)
    mirror = ipaddress.ip_address(kata.SANDBOX_MIRROR_ADDRESS)
    assert subnet.is_private and dynamic.subnet_of(subnet)
    assert mirror in subnet and mirror not in dynamic and mirror != subnet.network_address + 1


@pytest.mark.parametrize(('text', 'expected'), [('10g', 10 * 1024**3), ('256m', 256 * 1024**2), ('4K', 4096)])
def test_size_bytes(text: str, expected: int) -> None:
    assert kata.size_bytes(text) == expected


@pytest.mark.parametrize('text', ['10', 'g', '0g', '-1g', '1.5g', '10t', ''])
def test_size_bytes_refuses(text: str) -> None:
    with pytest.raises(ValueError, match='positive number'):
        kata.size_bytes(text)


def test_workspace_bytes_is_the_limit() -> None:
    assert kata.WORKSPACE_BYTES == 10 * 1024**3


def test_container_options_are_fixed() -> None:
    options = container_options(CID, 'data', ephemeral=False, scope=SCOPE, uploads=UPLOADS)
    ulimits = options.pop('ulimits')
    assert [(u.name, u.soft, u.hard) for u in ulimits] == [('nproc', 512, 512)]
    assert all(isinstance(u, docker.types.Ulimit) for u in ulimits)
    assert options == {
        'image': f'local-llm/sandbox-data:{kata.SANDBOX_IMAGE_TAG}',
        'runtime': 'kata-clh',
        'name': f'lllm-sandbox-{CID}',
        'labels': {'lllm.chat': CID, 'lllm.scope': SCOPE, 'lllm.image': 'data'},
        'user': '65534:65534',
        'init': True,
        'entrypoint': ['/usr/bin/sleep', 'infinity'],
        'cap_drop': ['ALL'],
        'security_opt': ['no-new-privileges'],
        'read_only': True,
        'tmpfs': {'/tmp': 'size=256m'},
        'mem_limit': '4g',
        'nano_cpus': 2_000_000_000,
        'pids_limit': 512,
        'network': 'local-llm_sandbox',
        'extra_hosts': {'sandbox-mirror': '10.231.0.2'},
        'sysctls': {'net.ipv6.conf.all.disable_ipv6': '1', 'net.ipv6.conf.default.disable_ipv6': '1'},
        'volumes': {f'lllm-sandbox-{CID}': {'bind': '/workspace', 'mode': 'rw'}},
        'mounts': [
            {
                'Target': '/workspace/uploads',
                'Source': str(UPLOADS),
                'Type': 'bind',
                'ReadOnly': True,
            }
        ],
        'working_dir': '/workspace',
        'healthcheck': {'test': ['NONE']},
        'detach': True,
        'auto_remove': False,
    }
    assert type(options['nano_cpus']) is int
    ephemeral = container_options(CID, 'web', ephemeral=True, scope=SCOPE, uploads=UPLOADS)
    assert ephemeral['labels'] == {'lllm.chat': CID, 'lllm.scope': SCOPE, 'lllm.image': 'web', 'lllm.ephemeral': '1'}
    assert ephemeral['image'] == f'local-llm/sandbox-web:{kata.SANDBOX_IMAGE_TAG}'


@pytest.mark.parametrize('key', [CID.upper(), 'not-a-uuid', f'{CID} ', '../etc', ''])
def test_container_options_refuse_a_key_that_is_not_a_canonical_uuid(key: str) -> None:
    with pytest.raises(ValueError):
        container_options(key, 'data', ephemeral=False, scope=SCOPE, uploads=UPLOADS)
    with pytest.raises(ValueError):
        kata.volume_options(key)
    with pytest.raises(ValueError):
        kata.container_name(key)


def test_container_options_refuse_an_unknown_image() -> None:
    with pytest.raises(ValueError, match='image'):
        container_options(CID, cast(Any, 'gpu'), ephemeral=False, scope=SCOPE, uploads=UPLOADS)


@pytest.mark.parametrize('scope', ['0123456789ABCDEF', '0123', '0123456789abcdeg', 1234])
def test_container_options_refuse_a_scope_scope_of_would_not_make(scope: Any) -> None:
    with pytest.raises(ValueError, match='scope'):
        container_options(CID, 'data', ephemeral=False, scope=scope, uploads=UPLOADS)


@pytest.mark.parametrize('uploads', [Path('relative') / CID, Path('/srv/uploads') / OTHER, Path('/srv/uploads')])
def test_container_options_refuse_an_uploads_directory_not_of_the_key(uploads: Path) -> None:
    with pytest.raises(ValueError, match='uploads'):
        container_options(CID, 'data', ephemeral=False, scope=SCOPE, uploads=uploads)


def test_scope_of_is_per_volume_directory(tmp_path: Path) -> None:
    one = kata.scope_of(tmp_path / 'a')
    assert one == kata.scope_of(tmp_path / 'b' / '..' / 'a')
    assert one != kata.scope_of(tmp_path / 'b')
    assert kata._check_scope(one) == one


def test_list_sandboxes_sees_only_its_own_scope(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    """Another app instance against the same daemon (make test-boot's own DATA_DIR) never lists, so never sweeps,
    this one's sandboxes, and this one never lists its."""
    docker_client.add_container(CID)
    docker_client.add_volume(CID)
    mine = docker_client.scope
    docker_client.scope = 'f' * 16
    docker_client.add_container(OTHER)
    docker_client.add_volume(OTHER)
    docker_client.scope = mine
    assert [i.chat_id for i in asyncio.run(backend.list_sandboxes())] == [CID]


def test_volume_options() -> None:
    assert kata.volume_options(CID) == {'type': 'ext4', 'device': f'/dev/disk/by-uuid/{CID}', 'o': 'nosuid,nodev'}


@pytest.mark.parametrize(
    ('go_mode', 'kind', 'mode'),
    [
        (0o644, 'file', 0o644),
        (kata._GO_DIR | 0o755, 'dir', 0o755),
        (kata._GO_SYMLINK | 0o777, 'symlink', 0o777),
        (kata._GO_PIPE | 0o644, 'other', 0o644),
        (kata._GO_SOCKET | 0o755, 'other', 0o755),
        (kata._GO_DEVICE | kata._GO_CHARDEV | 0o666, 'other', 0o666),
        (kata._GO_IRREGULAR | 0o600, 'other', 0o600),
        (kata._GO_SETUID | kata._GO_SETGID | kata._GO_STICKY | 0o755, 'file', 0o7755),
    ],
)
def test_file_stat_maps_go_modes(go_mode: int, kind: str, mode: int) -> None:
    found = kata.file_stat('/workspace/x', {'mode': go_mode, 'size': 3, 'mtime': '2026-11-11T11:20:08.5-06:00'}, 7)
    assert (found.kind, found.mode, found.uid, found.size) == (kind, mode, 7, 3)
    assert found.mtime == pytest.approx(1794417608.5)


@pytest.mark.parametrize('mtime', [None, '', 'yesterday', '0001-01-01T00:00:00Z', 5])
def test_file_stat_without_a_readable_time(mtime: object) -> None:
    assert kata.file_stat('/workspace/x', {'mode': 0o644, 'size': 0, 'mtime': mtime}, 0).mtime == 0.0


def test_put_archive_replaces_then_makes_the_directory() -> None:
    data = kata.put_archive_bytes('uploads', [('a.txt', b'alpha', 0o444), ('b', b'', 0o555)], 1_700_000_000.0)
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        members = tar.getmembers()
        bodies = {m.name: tar.extractfile(m) for m in members if m.isreg() and m.size}
        contents = {name: body.read() for name, body in bodies.items() if body is not None}
    assert [(m.name, m.type, m.mode, m.uid, m.gid, m.size, m.mtime) for m in members] == [
        ('uploads', tarfile.REGTYPE, 0o400, 0, 0, 0, 1_700_000_000),
        ('uploads', tarfile.DIRTYPE, 0o555, 0, 0, 0, 1_700_000_000),
        ('uploads/a.txt', tarfile.REGTYPE, 0o444, 0, 0, 5, 1_700_000_000),
        ('uploads/b', tarfile.REGTYPE, 0o555, 0, 0, 0, 1_700_000_000),
    ]
    assert contents == {'uploads/a.txt': b'alpha'}


def test_read_frames_feeds_each_stream_in_slices() -> None:
    big = b'y' * 200_000
    raw = FakeRaw(frames((1, b'one'), (2, big), (0, b'stdin echo'), (1, b''), (1, b'two')))
    out, err = StreamCap(), StreamCap(limit=1_000_000)
    kata.read_frames(raw, out, err)
    assert out.render() == 'onetwo'
    assert err.render() == big.decode()


def test_read_frames_stops_at_a_cut_frame_or_a_closed_socket() -> None:
    out, err = StreamCap(), StreamCap()
    kata.read_frames(FakeRaw(frames((1, b'whole')) + struct.pack('>BxxxL', 1, 10) + b'part'), out, err)
    assert out.render() == 'wholepart'
    out2 = StreamCap()
    kata.read_frames(FakeRaw(b'\x01\x00\x00'), out2, StreamCap())
    assert out2.render() == ''

    class Broken:
        def recv(self, n: int) -> bytes:
            raise ConnectionResetError

    kata.read_frames(Broken(), StreamCap(), StreamCap())


def test_write_stdin_sends_then_half_closes() -> None:
    raw = FakeRaw()
    kata.write_stdin(raw, b'data')
    assert (bytes(raw.sent), raw.shutdowns) == (b'data', [socket.SHUT_WR])
    raw = FakeRaw()
    raw.fail_send = True
    kata.write_stdin(raw, b'data')
    assert raw.shutdowns == []


def test_key_of_and_time() -> None:
    assert kata._key_of({'lllm.chat': CID, 'lllm.scope': SCOPE}, SCOPE) == CID
    assert kata._key_of({'lllm.chat': CID, 'lllm.scope': 'f' * 16}, SCOPE) is None
    assert kata._key_of({'lllm.chat': CID}, SCOPE) is None
    assert kata._key_of({'lllm.chat': 'x', 'lllm.scope': SCOPE}, SCOPE) is None
    assert kata._key_of({}, SCOPE) is None
    assert kata._time('2026-11-11T17:30:53.215276123Z') is not None


def test_default_client_uses_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}
    monkeypatch.setattr(kata.docker, 'from_env', lambda **kw: seen.update(kw) or 'client')
    assert kata._default_client() == 'client'
    assert seen == {'timeout': kata.API_TIMEOUT_S}


def test_the_client_is_made_once_and_lazily(host: Host, tmp_path: Path) -> None:
    made: list[FakeDocker] = []

    def factory() -> FakeDocker:
        made.append(FakeDocker())
        return made[-1]

    backend = KataDockerBackend(tmp_path / 'v', client_factory=factory)
    assert made == []
    asyncio.run(backend.ready())
    asyncio.run(backend.ready())
    assert len(made) == 1


# Readiness.


def test_ready_none_when_everything_is_there(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.add_container(key='mirror', status='running')
    docker_client.containers_by_name['local-llm-sandbox-mirror'] = docker_client.containers_by_name.pop(
        'lllm-sandbox-mirror'
    )
    assert asyncio.run(backend.ready()) is None
    assert backend.image_ids == {key: f'sha256:{ref}' for key, ref in IMAGES.items()}


@pytest.mark.parametrize(
    ('breakage', 'reason'),
    [
        ('daemon', 'The Docker daemon does not answer'),
        ('runtime', 'The Docker daemon has no kata-clh runtime (docs/guides/sandbox.md, "Host setup")'),
        ('data', f'The sandbox image {IMAGES["data"]} is missing; build it with make sandbox-images'),
        ('web', f'The sandbox image {IMAGES["web"]} is missing; build it with make sandbox-images'),
        ('network', 'The sandbox network local-llm_sandbox does not exist; make backend creates it'),
        ('tools', 'The host lacks udisksctl, mkfs.ext4 or debugfs, which the workspace volumes need'),
        ('mirror', 'The sandbox-mirror container is not running; make backend starts it'),
        ('mirror stopped', 'The sandbox-mirror container is not running; make backend starts it'),
    ],
)
def test_ready_reports_each_reason(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, breakage: str, reason: str
) -> None:
    mirror = docker_client.add_container(key='mirror')
    docker_client.containers_by_name = {'local-llm-sandbox-mirror': mirror}
    if breakage == 'daemon':
        docker_client.info_error = requests.ConnectionError('http+docker://localhost /var/run/docker.sock')
    elif breakage == 'runtime':
        docker_client.runtimes = {'runc': {}}
    elif breakage in IMAGES:
        docker_client.images_present.discard(IMAGES[breakage])
    elif breakage == 'network':
        docker_client.network = False
    elif breakage == 'tools':
        host.tools.discard('debugfs')
    elif breakage == 'mirror':
        docker_client.containers_by_name = {}
    else:
        mirror.status = 'exited'
    found = asyncio.run(backend.ready())
    assert found == reason
    assert '/var/run' not in found and '/home' not in found


def test_ready_with_a_client_that_cannot_be_made(host: Host, tmp_path: Path) -> None:
    def factory() -> FakeDocker:
        raise docker.errors.DockerException('Error while fetching server API version: /var/run/docker.sock')

    assert (
        asyncio.run(KataDockerBackend(tmp_path, client_factory=factory).ready()) == 'The Docker daemon does not answer'
    )


def test_the_status_route_with_the_real_manager_and_backend(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.network = False
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(sandbox=SandboxManager(backend))))
    assert asyncio.run(get_sandbox_status(request, user=None)) == {
        'ready': False,
        'reason': 'The sandbox network local-llm_sandbox does not exist; make backend creates it',
    }


# Create, stop, destroy, list.


def create(backend: KataDockerBackend, key: str = CID, image: ImageKey = 'data', ephemeral: bool = False) -> None:
    asyncio.run(backend.create(key, SandboxSpec(key, image, ephemeral=ephemeral)))


def test_create_makes_the_volume_then_runs_the_container(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, tmp_path: Path
) -> None:
    create(backend, ephemeral=True)
    image = tmp_path / 'volumes' / f'{CID}.img'
    assert image.stat().st_size == 16 * 1024 * 1024
    assert oct(image.stat().st_mode & 0o777) == oct(0o600)
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
            str(image),
            str((16 * 1024 * 1024 - 4 * 1024 * 1024) // 4096),
        ],
        ['/usr/sbin/debugfs', '-w', '-R', 'rmdir lost+found', str(image)],
        ['/usr/sbin/udisksctl', 'loop-setup', '--no-user-interaction', '--no-partition-scan', '-f', str(image)],
    ]
    assert docker_client.volume_creates == [
        {
            'name': f'lllm-sandbox-{CID}',
            'driver': 'local',
            'driver_opts': {'type': 'ext4', 'device': f'/dev/disk/by-uuid/{CID}', 'o': 'nosuid,nodev'},
            'labels': {'lllm.chat': CID, 'lllm.scope': docker_client.scope, 'lllm.ephemeral': '1'},
        }
    ]
    assert docker_client.run_calls == [
        container_options(CID, 'data', ephemeral=True, scope=docker_client.scope, uploads=tmp_path / 'uploads' / CID)
    ]
    assert (tmp_path / 'uploads' / CID).is_dir()
    assert set(backend.image_ids) == {'data'}


def test_create_passes_nothing_from_the_spec_but_the_key_image_and_flag(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    spec = SandboxSpec(CID, 'web', labels={'evil': '--privileged'}, ephemeral=False)
    asyncio.run(backend.create(CID, spec))
    (call,) = docker_client.run_calls
    assert 'evil' not in call['labels'] and '--privileged' not in repr(call)
    assert call['labels'] == {'lllm.chat': CID, 'lllm.scope': docker_client.scope, 'lllm.image': 'web'}


def test_create_reuses_a_running_container_of_the_same_image(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host
) -> None:
    docker_client.add_container()
    create(backend)
    assert docker_client.run_calls == [] and docker_client.removed == [] and host.runs == []


def test_create_replaces_a_container_of_another_image_or_stopped_on_the_same_volume(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, tmp_path: Path
) -> None:
    docker_client.add_volume()
    image = tmp_path / 'volumes' / f'{CID}.img'
    image.parent.mkdir(exist_ok=True)
    image.write_bytes(b'')
    host.attach(str(image), CID)
    docker_client.add_container(image='web')
    create(backend)
    assert docker_client.removed == [f'lllm-sandbox-{CID}']
    assert [c['labels']['lllm.image'] for c in docker_client.run_calls] == ['data']
    # The volume and its attached image are reused: no mkfs, no second loop device.
    assert acted(host) == [] and docker_client.volume_creates == []
    docker_client.containers_by_name[f'lllm-sandbox-{CID}'].status = 'exited'
    create(backend)
    assert len(docker_client.run_calls) == 2


def test_create_attaches_an_existing_volume_after_a_reboot(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, tmp_path: Path
) -> None:
    docker_client.add_volume()
    image = tmp_path / 'volumes' / f'{CID}.img'
    image.parent.mkdir(exist_ok=True)
    image.write_bytes(b'kept')
    create(backend)
    assert host.runs == [
        ['/usr/sbin/debugfs', '-R', 'stat uploads', str(image)],
        ['/usr/sbin/udisksctl', 'loop-setup', '--no-user-interaction', '--no-partition-scan', '-f', str(image)],
    ]
    assert image.read_bytes() == b'kept'


def test_create_remakes_a_leftover_image_without_a_volume(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, tmp_path: Path
) -> None:
    image = tmp_path / 'volumes' / f'{CID}.img'
    image.parent.mkdir(exist_ok=True)
    image.write_bytes(b'old')
    loop = host.attach(str(image), 'stale')
    create(backend)
    assert host.runs[0] == ['/usr/sbin/udisksctl', 'loop-delete', '--no-user-interaction', '-b', f'/dev/{loop}']
    assert image.stat().st_size == 16 * 1024 * 1024


@pytest.mark.parametrize(
    'breakage',
    ['runtime', 'image', 'network', 'tools', 'daemon'],
)
def test_create_refuses_with_the_reason_before_creating_anything(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, breakage: str
) -> None:
    if breakage == 'runtime':
        docker_client.runtimes = {}
    elif breakage == 'image':
        docker_client.images_present.discard(IMAGES['web'])
    elif breakage == 'network':
        docker_client.network = False
    elif breakage == 'tools':
        host.tools.clear()
    else:
        docker_client.info_error = docker.errors.APIError('500 /var/lib/docker')
    with pytest.raises(SandboxUnavailable) as raised:
        create(backend, image='web')
    assert raised.value.public == str(raised.value)
    assert docker_client.run_calls == [] and docker_client.volume_creates == [] and host.runs == []


def test_create_does_not_need_the_mirror(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    create(backend)
    assert len(docker_client.run_calls) == 1


def test_create_validates_first(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    with pytest.raises(ValueError):
        asyncio.run(backend.create(OTHER, SandboxSpec(CID, 'data')))
    with pytest.raises(TypeError):
        asyncio.run(backend.create(CID, cast(Any, 'data')))
    assert docker_client.run_calls == []


@pytest.mark.parametrize('failing', ['mkfs.ext4', 'debugfs', 'udisksctl'])
def test_create_wraps_a_host_tool_failure(backend: KataDockerBackend, host: Host, failing: str) -> None:
    host.fail = failing
    with pytest.raises(SandboxError) as raised:
        create(backend)
    assert str(raised.value) == 'the sandbox backend could not start the sandbox'
    assert raised.value.public is None


def test_create_when_a_tool_vanishes_after_the_check(backend: KataDockerBackend, host: Host, monkeypatch) -> None:
    checks = iter([True, True, True, False])
    monkeypatch.setattr(kata.shutil, 'which', lambda name, path: f'/usr/sbin/{name}' if next(checks, False) else None)
    with pytest.raises(SandboxUnavailable, match='the host has no mkfs.ext4'):
        create(backend)


def test_create_when_the_loop_device_does_not_show(backend: KataDockerBackend, host: Host) -> None:
    host.attach_works = False
    with pytest.raises(SandboxError, match='not attached to a loop device'):
        create(backend)


def test_create_when_the_device_link_never_appears(backend: KataDockerBackend, host: Host) -> None:
    host.link_appears = False
    with pytest.raises(SandboxError, match='device did not appear'):
        create(backend)


def test_loop_of_skips_unreadable_entries(backend: KataDockerBackend, host: Host, tmp_path: Path) -> None:
    (host.sys_block / 'loop9' / 'loop' / 'backing_file').mkdir(parents=True)
    assert backend._loop_of(tmp_path / 'x.img') is None


def test_create_times_out(backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch) -> None:
    monkeypatch.setattr(kata, 'CREATE_TIMEOUT_S', 0.05)
    monkeypatch.setattr(docker_client.containers, 'run', lambda **kw: time.sleep(0.3))
    with pytest.raises(SandboxError, match='did not start the sandbox within 0.05 seconds'):
        create(backend)


def test_stop_removes_the_container_and_keeps_the_volume(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.add_container()
    docker_client.add_volume()
    asyncio.run(backend.stop(CID))
    assert docker_client.removed == [f'lllm-sandbox-{CID}']
    assert f'lllm-sandbox-{CID}' in docker_client.volumes_by_name
    asyncio.run(backend.stop(CID))
    assert docker_client.removed == [f'lllm-sandbox-{CID}']


def test_stop_tolerates_a_container_gone_meanwhile(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.add_container()
    docker_client.remove_error = docker.errors.NotFound('gone')
    asyncio.run(backend.stop(CID))


def test_stop_wraps_errors(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.add_container()
    docker_client.remove_error = docker.errors.APIError('500 Server Error: /var/lib/docker/containers')
    with pytest.raises(SandboxError) as raised:
        asyncio.run(backend.stop(CID))
    assert str(raised.value) == 'the sandbox backend could not stop the sandbox'
    with pytest.raises(ValueError):
        asyncio.run(backend.stop('nope'))


def test_destroy_removes_container_volume_loop_and_image(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, tmp_path: Path
) -> None:
    create(backend)
    image = tmp_path / 'volumes' / f'{CID}.img'
    loop = backend._loop_of(image)
    assert loop is not None
    asyncio.run(backend.destroy(CID))
    assert docker_client.removed == [f'lllm-sandbox-{CID}']
    assert docker_client.volume_removed == [f'lllm-sandbox-{CID}']
    assert host.runs[-1] == ['/usr/sbin/udisksctl', 'loop-delete', '--no-user-interaction', '-b', f'/dev/{loop}']
    assert not image.exists() and backend._loop_of(image) is None
    # Nothing left: a no-op.
    asyncio.run(backend.destroy(CID))


def test_list_sandboxes_joins_volumes_and_containers(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.add_volume(CID)
    docker_client.add_container(CID)
    docker_client.add_volume(OTHER, **{'lllm.ephemeral': '1'})
    third = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a'
    docker_client.add_container(third, status='exited', **{'lllm.ephemeral': '1'})
    fourth = '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b'
    odd = docker_client.add_container(fourth, image='gpu')
    odd.attrs = {}
    docker_client.add_container('not-a-uuid')
    docker_client.add_volume('../escape')
    infos = {i.chat_id: i for i in asyncio.run(backend.list_sandboxes())}
    assert set(infos) == {CID, OTHER, third, fourth}
    assert (infos[CID].running, infos[CID].image, infos[CID].ephemeral, infos[CID].ip) == (
        True,
        'data',
        False,
        '10.231.0.129',
    )
    assert infos[CID].last_used is not None and infos[CID].last_used.tzinfo is not None
    assert (infos[OTHER].running, infos[OTHER].image, infos[OTHER].ephemeral) == (False, None, True)
    assert infos[OTHER].last_used is not None
    assert (infos[third].running, infos[third].image, infos[third].ephemeral, infos[third].last_used) == (
        False,
        None,
        True,
        None,
    )
    assert (infos[fourth].running, infos[fourth].image, infos[fourth].ip, infos[fourth].last_used) == (
        True,
        None,
        None,
        None,
    )


def test_list_sandboxes_wraps_errors(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.list_error = requests.ConnectionError('unix:///var/run/docker.sock')
    with pytest.raises(SandboxError) as raised:
        asyncio.run(backend.list_sandboxes())
    assert str(raised.value) == 'the sandbox backend could not list the sandboxes'


# Exec.


def kinds(api: FakeAPI) -> list[str]:
    return [e.kind for e in api.execs.values()]


def test_exec_streams_both_outputs_and_kills_after(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.add_container()
    api = docker_client.api
    api.exit_code = 3
    result = run_exec(backend, 'echo out; echo err >&2; exit 3')
    assert (result.returncode, result.stdout, result.stderr, result.timed_out, result.truncated) == (
        3,
        'out\n',
        'err\n',
        False,
        False,
    )
    assert kinds(api) == ['main', 'kill', 'verify']
    main, kill, verify = api.execs.values()
    assert main.argv == wrap_command('echo out; echo err >&2; exit 3', 5)
    assert main.kwargs == {
        'stdout': True,
        'stderr': True,
        'stdin': False,
        'tty': False,
        'user': '1000:1000',
        'workdir': '/workspace',
    }
    assert kill.argv == [*kata._GUEST_SHELL, KILL_SCRIPT]
    assert kill.kwargs['user'] == '1000:1000'
    # The verdict runs as nobody, which a surviving UID 1000 process can neither trace nor signal (security B1).
    assert verify.argv == [*kata._GUEST_SHELL, VERIFY_SCRIPT]
    assert verify.kwargs['user'] == '65534:65534'
    assert api.main_raw is not None and api.main_raw.timeout is None
    assert api.main_raw.shutdowns == [socket.SHUT_RDWR]


def test_exec_with_stdin(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.add_container()
    run_exec(backend, 'cat > f', stdin=b'x' * 1000)
    api = docker_client.api
    assert api.main_raw is not None and bytes(api.main_raw.sent) == b'x' * 1000
    assert api.main_raw.shutdowns[0] == socket.SHUT_WR
    assert next(iter(api.execs.values())).kwargs['stdin'] is True


def test_exec_refuses_bad_arguments(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    with pytest.raises(ValueError):
        asyncio.run(backend.exec('nope', wrap_command('x', 5), 5))
    with pytest.raises(ValueError):
        asyncio.run(backend.exec(CID, ['/bin/bash', '-c', 'x'], 5))
    with pytest.raises(ValueError):
        asyncio.run(backend.exec(CID, wrap_command('x', 5), 6))
    with pytest.raises(TypeError, match='stdin'):
        asyncio.run(backend.exec(CID, wrap_command('x', 5), 5, cast(Any, 'text')))
    assert docker_client.api.execs == {}


def test_exec_in_a_sandbox_that_is_not_running(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    with pytest.raises(SandboxNotRunning, match='^the sandbox is not running$'):
        run_exec(backend)
    docker_client.add_container(status='exited')
    with pytest.raises(SandboxNotRunning):
        run_exec(backend)
    assert docker_client.api.execs == {}


def test_exec_that_cannot_start_still_runs_the_kill(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.add_container()
    api = docker_client.api
    api.errors['exec_start main'] = docker.errors.APIError('500: OCI runtime exec failed: /run/kata')
    with pytest.raises(SandboxError) as raised:
        run_exec(backend)
    assert str(raised.value) == 'the sandbox backend could not run the command'
    assert kinds(api) == ['main', 'kill', 'verify']


def test_exec_whose_background_child_holds_the_stream(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    """The daemon reports the exec running while a child holds its stdout; the watcher sees the main process end."""
    docker_client.add_container()
    api = docker_client.api
    api.held = True
    api.running_for = None
    api.exit_code = 0
    api.poller_runs = 2
    result = run_exec(backend, 'sleep 300 & echo started', timeout_s=60)
    assert (result.returncode, result.stdout, result.timed_out) == (0, 'out\n', False)
    assert kinds(api) == ['main', 'poll', 'kill', 'verify']
    poll = api.execs['poll-1']
    assert poll.kwargs['user'] == '65534:65534'
    assert poll.argv == [
        '/usr/bin/timeout',
        str(60 + kata.HOST_DEADLINE_SLACK_S + kata.KILL_GRACE_S),
        *kata._GUEST_SHELL,
        POLL_SCRIPT,
    ]
    # The kill ran while the daemon still thought the command running: it is what closes the stream.
    assert api.kill_seen_main_running is True


def test_exec_falls_back_when_the_watcher_fails(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.add_container()
    api = docker_client.api
    api.running_for = 6
    api.poller_exit = 137
    result = run_exec(backend)
    assert result.returncode == 0
    assert kinds(api) == ['main', 'poll', 'kill', 'verify']


def test_exec_hits_the_host_deadline(
    backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(kata, 'HOST_DEADLINE_SLACK_S', -0.95)
    docker_client.add_container()
    api = docker_client.api
    api.held = True
    api.running_for = None
    api.poller_runs = 10**9
    result = run_exec(backend, 'sleep 999', timeout_s=1)
    assert (result.returncode, result.timed_out) == (124, True)
    assert kinds(api) == ['main', 'poll', 'kill', 'verify']


def test_exec_reads_137_as_oom_while_the_container_runs(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.add_container()
    docker_client.api.exit_code = 137
    result = run_exec(backend)
    assert (result.returncode, result.timed_out) == (137, False)


def test_exec_reads_137_as_a_dead_vm_once_the_container_is_gone(
    backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch: pytest.MonkeyPatch
) -> None:
    container = docker_client.add_container()
    api = docker_client.api
    api.exit_code = 137
    original = api.exec_inspect

    def inspect(exec_id: str) -> dict[str, Any]:
        found = original(exec_id)
        container.status = 'exited'
        return found

    monkeypatch.setattr(api, 'exec_inspect', inspect)
    with pytest.raises(SandboxNotRunning, match='^the sandbox stopped during the command$'):
        run_exec(backend)
    assert 'kill' not in kinds(api)


def test_exec_137_with_the_daemon_silent_leaves_it_to_the_kill(
    backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch: pytest.MonkeyPatch
) -> None:
    docker_client.add_container()
    docker_client.api.exit_code = 137
    real = backend._running
    calls = {'n': 0}

    def running(key: str) -> Any:
        calls['n'] += 1
        if calls['n'] == 2:
            raise docker.errors.APIError('500 /var/lib/docker')
        return real(key)

    monkeypatch.setattr(backend, '_running', running)
    assert run_exec(backend).returncode == 137
    assert 'kill' in kinds(docker_client.api)


@pytest.mark.parametrize('failure', ['exit', 'create', 'hang', 'inspect'])
def test_exec_fails_closed_when_the_kill_is_not_confirmed(
    backend: KataDockerBackend, docker_client: FakeDocker, failure: str
) -> None:
    docker_client.add_container()
    api = docker_client.api
    if failure == 'exit':
        api.kill_exit = 1
    elif failure == 'create':
        api.kill_create_error = docker.errors.APIError('500: exec failed: resource temporarily unavailable')
    elif failure == 'hang':
        api.kill_hangs = True
    else:
        api.inspect_errors['kill'] = requests.ConnectionError('/var/run/docker.sock')
    with pytest.raises(SandboxNotRunning) as raised:
        run_exec(backend)
    assert raised.value.public == str(raised.value)
    assert 'could not be confirmed ended, so the sandbox was stopped' in str(raised.value)
    assert docker_client.removed == [f'lllm-sandbox-{CID}']
    assert api.main_raw is not None and api.main_raw.ended


def test_a_failed_kill_whose_stop_fails_still_raises(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.add_container()
    docker_client.api.kill_exit = 1
    docker_client.remove_error = docker.errors.APIError('500')
    with pytest.raises(SandboxNotRunning):
        run_exec(backend)


def test_exec_when_watching_fails(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.add_container()
    api = docker_client.api
    api.inspect_errors['main'] = docker.errors.APIError('500 /var/lib/docker')
    with pytest.raises(SandboxError) as raised:
        run_exec(backend)
    assert str(raised.value) == 'the sandbox backend could not check on the command'
    assert kinds(api) == ['main', 'kill', 'verify']


def test_exec_without_an_exit_status(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.add_container()
    api = docker_client.api
    api.held = True
    api.running_for = None
    api.exit_code = None
    with pytest.raises(SandboxError, match='could not read the exit status'):
        run_exec(backend)


def test_exec_whose_stream_outlives_the_kill_is_closed(
    backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch: pytest.MonkeyPatch
) -> None:
    docker_client.add_container()
    api = docker_client.api
    api.held = True
    api.running_for = 1
    api.release_on_kill = False

    def inspect_main_done(exec_id: str, original=api.exec_inspect) -> dict[str, Any]:
        record = api.execs[exec_id]
        if record.kind == 'main':
            record.inspects += 1
            return {'Running': record.inspects <= 1, 'ExitCode': None if record.inspects <= 1 else 5}
        return original(exec_id)

    monkeypatch.setattr(api, 'exec_inspect', inspect_main_done)
    result = run_exec(backend)
    assert result.returncode == 5
    assert api.main_raw is not None and socket.SHUT_RDWR in api.main_raw.shutdowns


def test_exec_closes_even_when_closing_fails(
    backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch
) -> None:
    docker_client.add_container()

    def broken_close(self: FakeSock) -> None:
        raise OSError('closed twice')

    monkeypatch.setattr(FakeSock, 'close', broken_close)
    monkeypatch.setattr(FakeRaw, 'shutdown', lambda self, how: (_ for _ in ()).throw(OSError('not connected')))
    assert run_exec(backend).returncode == 0


def test_cancelled_exec_kills_before_it_raises(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.add_container()
    api = docker_client.api
    api.held = True
    api.running_for = None
    api.poller_runs = 10**9

    async def scenario() -> None:
        task = asyncio.ensure_future(backend.exec(CID, wrap_command('sleep 300 & sleep 300', 60), 60))
        while 'poll' not in kinds(api):
            await asyncio.sleep(0.01)
        task.cancel()
        await asyncio.sleep(0)
        # A second cancellation does not cut the kill short.
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert kinds(api) == ['main', 'poll', 'kill', 'verify']
    assert api.main_raw is not None and api.main_raw.ended


def test_cancelled_exec_whose_kill_fails_raises_that(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.add_container()
    api = docker_client.api
    api.held = True
    api.running_for = None
    api.kill_exit = 1

    async def scenario() -> None:
        task = asyncio.ensure_future(backend.exec(CID, wrap_command('sleep 300', 60), 60))
        while not api.execs:
            await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(SandboxNotRunning):
            await task

    asyncio.run(scenario())


def test_exec_cancelled_before_it_started_runs_the_kill_and_raises(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container()
    api = docker_client.api

    async def scenario() -> None:
        task = asyncio.ensure_future(backend.exec(CID, wrap_command('true', 5), 5))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert kinds(api) == ['main', 'kill', 'verify']


def test_exec_as_called_by_a_session_cancelled_by_the_user(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    """SandboxSession.exec cancels the backend's exec once and waits; the kill has run when it raises."""
    docker_client.add_container()
    api = docker_client.api
    api.held = True
    api.running_for = None
    api.poller_runs = 10**9

    class Chats:
        async def usable(self, chat_id: str, user: Any) -> bool:
            return True

        async def updated_at(self, chat_ids: list[str]) -> dict[str, int]:
            return {}

    async def settings() -> Any:
        from local_llm.sandbox.manager import SandboxSettings

        return SandboxSettings()

    manager = SandboxManager(backend, settings=settings, chats=Chats())

    async def scenario() -> None:
        async with manager.session(CID, SimpleNamespace(id='u')) as session:
            task = asyncio.ensure_future(session.exec(wrap_argv(['/bin/sleep', '300'], 30), 30))
            while 'poll' not in kinds(api):
                await asyncio.sleep(0.01)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert 'kill' in kinds(api)

    asyncio.run(scenario())


# Files.


def archive(api: FakeAPI, path: str, go_mode: int, size: int = 0, uid: int = 1000, link: str = '') -> None:
    api.archives[path] = (go_mode, size, uid, link)


DIR = kata._GO_DIR


def test_stat_reads_the_daemon_stat_and_the_owner(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.add_container()
    api = docker_client.api
    archive(api, '/workspace', DIR | 0o755)
    archive(api, '/workspace/d', DIR | 0o755)
    archive(api, '/workspace/d/f', 0o644, 5, uid=0)
    archive(api, '/workspace/e', kata._GO_SYMLINK | 0o777, 4, link='/etc')
    archive(api, '/workspace/fifo', kata._GO_PIPE | 0o644)
    archive(api, '/workspace/sock', kata._GO_SOCKET | 0o755)

    def stat(path: str) -> tuple[str, int, int, int] | None:
        found = asyncio.run(backend.stat(CID, path))
        return None if found is None else (found.kind, found.uid, found.mode, found.size)

    assert stat('/workspace') == ('dir', 1000, 0o755, 0)
    assert stat('/workspace/d/f') == ('file', 0, 0o644, 5)
    assert stat('/workspace/e') == ('symlink', 1000, 0o777, 4)
    assert stat('/workspace/fifo') == ('other', 1000, 0o644, 0)
    # A socket cannot be archived, so its owner is unknown.
    assert stat('/workspace/sock') == ('other', -1, 0o755, 0)
    assert stat('/workspace/missing') is None
    # Through a symlinked directory: not followed.
    assert stat('/workspace/e/passwd') is None
    assert stat('/workspace/nodir/x') is None
    assert all(r.closed for r in api.responses)


def test_stat_of_an_empty_archive(backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch) -> None:
    docker_client.add_container()
    archive(docker_client.api, '/workspace/f', 0o644)
    monkeypatch.setattr(FakeAPI, '_tar', staticmethod(lambda *a: b'\0' * 1024))
    found = asyncio.run(backend.stat(CID, '/workspace/f'))
    assert found is not None and found.uid == -1


def test_stat_validates_and_wraps(
    backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch: pytest.MonkeyPatch
) -> None:
    with pytest.raises(ValueError):
        asyncio.run(backend.stat(CID, '/etc/passwd'))
    with pytest.raises(SandboxNotRunning):
        asyncio.run(backend.stat(CID, '/workspace'))
    docker_client.add_container()
    api = docker_client.api
    archive(api, '/workspace', DIR | 0o755)
    api.archive_status['/workspace'] = 500
    with pytest.raises(SandboxError) as raised:
        asyncio.run(backend.stat(CID, '/workspace'))
    assert str(raised.value) == 'the sandbox backend could not read a file status in the sandbox'
    assert api.responses[-1].closed
    api.archive_status.clear()
    api.archives['/workspace/x'] = (0o644, 0, 0, '')
    original = api._archive

    def no_header(url: str, params: dict[str, str]) -> FakeResponse:
        response = original(url, params)
        response.headers = {'X-Docker-Container-Path-Stat': b64encode(b'[1]').decode()}
        return response

    monkeypatch.setattr(api, '_archive', no_header)
    with pytest.raises(SandboxError):
        asyncio.run(backend.stat(CID, '/workspace/x'))


def test_get_files_reads_regular_files_only(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.add_container()
    api = docker_client.api
    archive(api, '/workspace/d', DIR | 0o755)
    archive(api, '/workspace/d/f', 0o644, 5)
    archive(api, '/workspace/big', 0o644, 11)
    archive(api, '/workspace/e', kata._GO_SYMLINK | 0o777, 4, link='/etc')
    archive(api, '/workspace/fifo', kata._GO_PIPE | 0o644)
    got = asyncio.run(
        backend.get_files(
            CID,
            [
                '/workspace/d/f',
                '/workspace/big',
                '/workspace/d',
                '/workspace/e',
                '/workspace/e/passwd',
                '/workspace/fifo',
                '/workspace/missing',
            ],
            10,
        )
    )
    assert got == {'/workspace/d/f': b'xxxxx'}
    assert all(r.closed for r in api.responses)
    # Omitted by the daemon's stat: those bodies were never read.
    oversized = [
        r
        for r in api.responses
        if r.headers and json.loads(b64decode(r.headers['X-Docker-Container-Path-Stat']))['size'] > 10
    ]
    assert oversized and all(r.raw.tell() == 0 for r in oversized)


def test_get_files_rechecks_the_archive_itself(
    backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch
) -> None:
    docker_client.add_container()
    api = docker_client.api
    archive(api, '/workspace/f', 0o644, 3)

    def tar_of(member: tarfile.TarInfo, body: bytes = b'') -> Callable[..., bytes]:
        def build(*args: Any) -> bytes:
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode='w') as tar:
                tar.addfile(member, io.BytesIO(body) if body else None)
            return buffer.getvalue()

        return build

    link = tarfile.TarInfo('f')
    link.type = tarfile.SYMTYPE
    monkeypatch.setattr(FakeAPI, '_tar', staticmethod(tar_of(link)))
    assert asyncio.run(backend.get_files(CID, ['/workspace/f'], 10)) == {}
    huge = tarfile.TarInfo('f')
    huge.size = 50
    monkeypatch.setattr(FakeAPI, '_tar', staticmethod(tar_of(huge, b'y' * 50)))
    assert asyncio.run(backend.get_files(CID, ['/workspace/f'], 10)) == {}
    monkeypatch.setattr(FakeAPI, '_tar', staticmethod(lambda *a: b'\0' * 1024))
    assert asyncio.run(backend.get_files(CID, ['/workspace/f'], 10)) == {}
    short = tarfile.TarInfo('f')
    short.size = 3
    whole = tar_of(short, b'abc')()
    monkeypatch.setattr(FakeAPI, '_tar', staticmethod(lambda *a: whole[:512] + b'a'))
    with pytest.raises(SandboxError):
        asyncio.run(backend.get_files(CID, ['/workspace/f'], 10))


def test_get_files_when_extractfile_has_nothing(
    backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch
) -> None:
    docker_client.add_container()
    archive(docker_client.api, '/workspace/f', 0o644, 3)
    monkeypatch.setattr(tarfile.TarFile, 'extractfile', lambda self, member: None)
    assert asyncio.run(backend.get_files(CID, ['/workspace/f'], 10)) == {}


def test_get_files_validates_first(backend: KataDockerBackend) -> None:
    with pytest.raises(ValueError):
        asyncio.run(backend.get_files(CID, ['/workspace/../etc/passwd'], 10))
    with pytest.raises(SandboxNotRunning):
        asyncio.run(backend.get_files(CID, ['/workspace/f'], 10))


def put_ok(api: FakeAPI, files: list[tuple[str, bytes, int]]) -> None:
    archive(api, '/workspace/uploads', DIR | 0o555, uid=0)
    for name, content, mode in files:
        archive(api, f'/workspace/uploads/{name}', mode, len(content), uid=0)


FILES = [('a.txt', b'alpha', 0o444), ('b.csv', b'1,2', 0o444)]


def test_put_files_sends_the_archive_and_checks_it(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.add_container()
    api = docker_client.api
    put_ok(api, FILES)
    # Stale at first: the old owner, then the right owner but a file missing, then the truth.
    api.guest_views = [b'1000 755\n', b'0 555\na.txt\0', None]
    asyncio.run(backend.put_files(CID, 'uploads', FILES))
    ((container, path, data),) = api.put
    assert (container, path) == (docker_client.container_id, '/workspace')
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        assert [(m.name, m.type) for m in tar.getmembers()] == [
            ('uploads', tarfile.REGTYPE),
            ('uploads', tarfile.DIRTYPE),
            ('uploads/a.txt', tarfile.REGTYPE),
            ('uploads/b.csv', tarfile.REGTYPE),
        ]
    stats = [e for e in api.execs.values() if e.kind == 'stat']
    assert len(stats) == 3
    assert stats[0].argv == [
        '/usr/bin/timeout',
        '0.5',
        *kata._GUEST_SHELL,
        '/usr/bin/stat -c "%u %a" -- "$1" && /usr/bin/find "$1" -mindepth 1 -maxdepth 1 -printf "$2" '
        f'| /usr/bin/head -c {kata.GUEST_VIEW_MAX_BYTES}',
        'lllm-stat',
        '/workspace/uploads',
        '%f\\0',
    ]
    assert stats[0].kwargs['user'] == '1000:1000'


@pytest.mark.parametrize(
    'wrong',
    [
        'dir missing',
        'dir owner',
        'dir mode',
        'dir kind',
        'file missing',
        'file owner',
        'file mode',
        'file size',
        'refused',
    ],
)
def test_put_files_raises_when_the_result_is_not_what_was_asked(
    backend: KataDockerBackend, docker_client: FakeDocker, wrong: str
) -> None:
    docker_client.add_container()
    api = docker_client.api
    put_ok(api, FILES)
    top = '/workspace/uploads'
    if wrong == 'dir missing':
        del api.archives[top]
    elif wrong == 'dir owner':
        archive(api, top, DIR | 0o555, uid=1000)
    elif wrong == 'dir mode':
        archive(api, top, DIR | 0o777, uid=0)
    elif wrong == 'dir kind':
        archive(api, top, kata._GO_SYMLINK | 0o777, uid=0)
    elif wrong == 'file missing':
        del api.archives[f'{top}/b.csv']
    elif wrong == 'file owner':
        archive(api, f'{top}/a.txt', 0o444, 5, uid=1000)
    elif wrong == 'file mode':
        archive(api, f'{top}/a.txt', 0o644, 5, uid=0)
    elif wrong == 'file size':
        archive(api, f'{top}/a.txt', 0o444, 4, uid=0)
    else:
        api.put_result = False
    with pytest.raises(SandboxError):
        asyncio.run(backend.put_files(CID, 'uploads', FILES))


def test_put_files_when_the_guest_never_sees_it(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    docker_client.add_container()
    api = docker_client.api
    put_ok(api, FILES)
    api.guest_views = [b'1000 755\n']
    with pytest.raises(SandboxError, match='did not see the copied files in time'):
        asyncio.run(backend.put_files(CID, 'uploads', FILES))


def test_put_files_validates_first(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    with pytest.raises(ValueError):
        asyncio.run(backend.put_files(CID, '../x', FILES))
    with pytest.raises(ValueError):
        asyncio.run(backend.put_files(CID, 'uploads', [('a', b'', 0o644)]))
    with pytest.raises(SandboxNotRunning):
        asyncio.run(backend.put_files(CID, 'uploads', FILES))
    docker_client.add_container()
    docker_client.api.errors['put_archive'] = docker.errors.APIError(
        '500: container rootfs is marked read-only /var/lib'
    )
    with pytest.raises(SandboxError) as raised:
        asyncio.run(backend.put_files(CID, 'uploads', FILES))
    assert str(raised.value) == 'the sandbox backend could not copy files into the sandbox'


# Against FakeBackend's contract: the same calls, the same observable results.


def test_exec_kill_is_recorded_by_both_backends_after_every_exec(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    docker_client.add_container()
    for _ in range(3):
        run_exec(backend)
    assert kinds(docker_client.api) == ['main', 'kill', 'verify'] * 3
    fake = FakeBackend()
    asyncio.run(fake.create(CID, SandboxSpec(CID, 'data')))
    for _ in range(3):
        asyncio.run(fake.exec(CID, wrap_command('printf x', 5), 5))
    assert [name for name, _ in fake.calls if name in ('exec', 'kill_uid_1000')] == ['exec', 'kill_uid_1000'] * 3


# The lifespan wiring.


class App:
    def __init__(self) -> None:
        self.state = SimpleNamespace()


@pytest.mark.parametrize(
    ('argv', 'environ', 'expected'),
    [
        (['uvicorn', 'app'], {}, 1),
        (['uvicorn', 'app', '--workers', '4'], {}, 4),
        (['uvicorn', 'app', '--workers=2'], {'WEB_CONCURRENCY': '1'}, 2),
        (['uvicorn', 'app', '--workers'], {'WEB_CONCURRENCY': '3'}, 3),
        (['uvicorn'], {'UVICORN_WORKERS': '5'}, 5),
        (['uvicorn'], {'WEB_CONCURRENCY': 'many'}, 1),
        (['uvicorn', '--workers', '0'], {}, 1),
        (['uvicorn'], {'WEB_CONCURRENCY': ''}, 1),
    ],
)
def test_server_workers(argv: list[str], environ: dict[str, str], expected: int) -> None:
    assert lifespan.server_workers(argv, environ) == expected


def no_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lifespan, 'server_workers', lambda: 1)


def test_lifespan_starts_one_manager_and_stops_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    no_wait(monkeypatch)
    fake = FakeBackend()
    asyncio.run(fake.create(CID, SandboxSpec(CID, 'data')))
    app = App()

    async def scenario() -> None:
        await lifespan.start(app, fake, tmp_path / 'sandbox')
        assert isinstance(app.state.sandbox, SandboxManager)
        assert (tmp_path / 'sandbox' / 'manager.lock').exists()
        # The startup sweep ran: the previous process's sandbox is stopped.
        assert fake.sandboxes[CID].running is False
        # A second server sharing the data directory does not start one.
        other = App()
        await lifespan.start(other, FakeBackend(), tmp_path / 'sandbox')
        assert other.state.sandbox is None
        await lifespan.stop(other, stop_running=True)
        await lifespan.stop(app, stop_running=False)
        assert app.state.sandbox is None and app.state.sandbox_maintenance is None

    asyncio.run(scenario())
    # The lock went with the manager: the next process starts one.
    later = App()

    async def again() -> None:
        await lifespan.start(later, FakeBackend(), tmp_path / 'sandbox')
        assert later.state.sandbox is not None
        await lifespan.stop(later, stop_running=True)

    asyncio.run(again())


def test_lifespan_refuses_more_than_one_worker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog) -> None:
    monkeypatch.setattr(lifespan, 'server_workers', lambda: 2)
    app = App()
    asyncio.run(lifespan.start(app, FakeBackend(), tmp_path))
    assert app.state.sandbox is None
    assert 'single server process' in caplog.text
    assert not (tmp_path / 'manager.lock').exists()


def test_lifespan_starts_the_app_when_the_backend_cannot_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog
) -> None:
    no_wait(monkeypatch)
    monkeypatch.setattr(lifespan, 'SWEEP_RETRY_S', 0.01)
    fake = FakeBackend()
    fake.ready_reason = 'The Docker daemon has no kata-clh runtime'
    failures = {'left': 2}
    real_list = fake.list_sandboxes

    swept = asyncio.Event()

    async def flaky_list() -> list:
        if failures['left']:
            failures['left'] -= 1
            raise SandboxError('the sandbox backend could not list the sandboxes')
        found = await real_list()
        swept.set()
        return found

    monkeypatch.setattr(fake, 'list_sandboxes', flaky_list)
    app = App()

    async def scenario() -> None:
        await lifespan.start(app, fake, tmp_path)
        assert app.state.sandbox is not None
        # Retried in the background until it succeeds.
        await swept.wait()
        # Then into the maintenance loop.
        await asyncio.sleep(0.01)
        assert await app.state.sandbox.ready() == 'The Docker daemon has no kata-clh runtime'
        await lifespan.stop(app, stop_running=False)

    asyncio.run(scenario())
    assert 'cannot run sandboxes: The Docker daemon has no kata-clh runtime' in caplog.text
    assert 'startup sweep failed' in caplog.text


def test_lifespan_stop_running_and_a_failing_shutdown(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog) -> None:
    no_wait(monkeypatch)
    fake = FakeBackend()
    app = App()

    async def scenario() -> None:
        await lifespan.start(app, fake, tmp_path)

        async def broken() -> list:
            raise SandboxError('could not list')

        monkeypatch.setattr(fake, 'list_sandboxes', broken)
        await lifespan.stop(app, stop_running=True)

    asyncio.run(scenario())
    assert 'could not stop the running sandboxes' in caplog.text
    asyncio.run(lifespan.stop(App(), stop_running=True))


# Fixes from T14's code review and test-engineer report (2026-11-11).


@pytest.mark.parametrize(
    'error',
    [
        TimeoutError('timed out'),
        urllib3.exceptions.ProtocolError('Connection broken: /var/run/docker.sock'),
        urllib3.exceptions.ReadTimeoutError(cast(Any, None), '/containers/x/archive', 'localhost: Read timed out'),
        http.client.IncompleteRead(b'partial'),
    ],
)
def test_every_error_a_worker_raises_becomes_a_fixed_sandbox_error(
    backend: KataDockerBackend, docker_client: FakeDocker, error: Exception
) -> None:
    """B1: urllib3's and http.client's errors are wrapped, and a TimeoutError of fn's own is not the wait's."""
    docker_client.add_container()
    archive(docker_client.api, '/workspace/f', 0o644, 3)
    original = docker_client.api._archive

    class Broken(io.BytesIO):
        def read(self, *args: Any) -> bytes:
            raise error

    def broken_body(url: str, params: dict[str, str]) -> FakeResponse:
        response = original(url, params)
        response.raw = Broken()
        return response

    docker_client.api._archive = broken_body  # replaced on this instance only
    for call, what in (
        (lambda: backend.get_files(CID, ['/workspace/f'], 9), 'read files from the sandbox'),
        (lambda: backend.stat(CID, '/workspace/f'), 'read a file status in the sandbox'),
    ):
        with pytest.raises(SandboxError) as raised:
            asyncio.run(call())
        assert str(raised.value) == f'the sandbox backend could not {what}'
        assert raised.value.__cause__ is None and 'localhost' not in str(raised.value)

    def list_fails(**kwargs: Any) -> list:
        raise error

    docker_client.volumes.list = list_fails
    with pytest.raises(SandboxError, match='^the sandbox backend could not list the sandboxes$'):
        asyncio.run(backend.list_sandboxes())


def test_a_create_given_up_on_starts_no_vm(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, monkeypatch: pytest.MonkeyPatch
) -> None:
    """B2: the thread of a timed-out create starts nothing, and a stop after it waits for it on the key's lock."""
    monkeypatch.setattr(kata, 'CREATE_TIMEOUT_S', 0.05)
    release = threading.Event()
    slow_run = host.run

    def slow(argv: list[str], **kwargs: Any) -> SimpleNamespace:
        if 'loop-setup' in argv:
            release.wait(5)
        return slow_run(argv, **kwargs)

    monkeypatch.setattr(kata.subprocess, 'run', slow)

    # One event loop throughout: asyncio.run would wait for the abandoned thread before it returned.
    async def stop_later() -> None:
        with pytest.raises(SandboxError, match='within 0.05 seconds'):
            await backend.create(CID, SandboxSpec(CID, 'data'))
        stopping = asyncio.ensure_future(backend.stop(CID))
        await asyncio.sleep(0.1)
        # The stop waits on the key's lock while the abandoned create still runs.
        assert not stopping.done()
        release.set()
        await stopping

    asyncio.run(stop_later())
    assert docker_client.run_calls == []


def test_a_create_given_up_on_while_starting_removes_its_container(
    backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(kata, 'CREATE_TIMEOUT_S', 0.05)
    release = threading.Event()
    real_run = docker_client.containers.run

    def slow_run(**kwargs: Any) -> FakeContainer:
        release.wait(5)
        return real_run(**kwargs)

    docker_client.containers.run = slow_run
    with pytest.raises(SandboxError, match='within'):
        create(backend)
    release.set()
    # The same lock: once a stop gets it, the create has finished, and removed what it started.
    asyncio.run(backend.stop(CID))
    assert len(docker_client.run_calls) == 1
    assert f'lllm-sandbox-{CID}' in docker_client.removed
    assert f'lllm-sandbox-{CID}' not in docker_client.containers_by_name


def test_the_kill_is_bounded_against_a_hung_daemon(
    backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch: pytest.MonkeyPatch
) -> None:
    """S2: one deadline for the whole kill, every daemon call in it included, then the fail-closed stop."""
    docker_client.add_container()
    hang = threading.Event()
    real_create = docker_client.api.exec_create

    def exec_create(container: str, cmd: list[str], **kwargs: Any) -> dict[str, str]:
        if KILL_SCRIPT in cmd:
            hang.wait(5)
        return real_create(container, cmd, **kwargs)

    docker_client.api.exec_create = exec_create

    async def timed() -> float:
        started = time.monotonic()
        try:
            with pytest.raises(SandboxNotRunning):
                await backend.exec(CID, wrap_command('true', 5), 5)
            return time.monotonic() - started
        finally:
            # Measured before asyncio.run waits for the hung thread at its end.
            hang.set()

    assert asyncio.run(timed()) < 2
    assert docker_client.removed == [f'lllm-sandbox-{CID}']


def test_a_cancelled_exec_fits_within_the_managers_wait() -> None:
    """Test-engineer item 6: kill, then the fail-closed stop, then the drain, inside CANCEL_WAIT_S."""
    assert kata.KILL_TIMEOUT_S + kata.KILL_STOP_TIMEOUT_S + kata.DRAIN_TIMEOUT_S < CANCEL_WAIT_S


def test_put_files_is_bounded(
    backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch: pytest.MonkeyPatch
) -> None:
    """S3: the whole call is bounded, and the guest-view exec runs under its own timeout."""
    monkeypatch.setattr(kata, 'FILES_TIMEOUT_S', 0.05)
    docker_client.add_container()
    release = threading.Event()

    def stuck(container: str, path: str, data: bytes) -> bool:
        release.wait(5)
        return True

    docker_client.api.put_archive = stuck
    try:
        with pytest.raises(SandboxError, match='did not copy files into the sandbox within 0.05 seconds'):
            asyncio.run(backend.put_files(CID, 'uploads', FILES))
    finally:
        release.set()


def test_list_skips_a_container_removed_while_listing(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    """S1: the SDK is asked to skip a container gone between the list and its inspection (the fake asserts it)."""
    docker_client.add_container()
    assert [i.chat_id for i in asyncio.run(backend.list_sandboxes())] == [CID]


def test_destroy_removes_the_volume_last(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, tmp_path: Path
) -> None:
    """S4: a destroy cut short keeps the volume listed, so a sweep destroys it again; the retry completes."""
    create(backend)
    host.fail = 'udisksctl'
    with pytest.raises(SandboxError):
        asyncio.run(backend.destroy(CID))
    assert f'lllm-sandbox-{CID}' in docker_client.volumes_by_name
    assert CID in [i.chat_id for i in asyncio.run(backend.list_sandboxes())]
    host.fail = None
    asyncio.run(backend.destroy(CID))
    assert docker_client.volumes_by_name == {}
    assert not (tmp_path / 'volumes' / f'{CID}.img').exists()


def test_an_image_without_a_volume_is_listed_for_the_sweeps(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, tmp_path: Path
) -> None:
    """S4: an image left by a create cut short is listed as a stopped ephemeral sandbox, which the sweeps destroy."""
    image = tmp_path / 'volumes' / f'{OTHER}.img'
    image.parent.mkdir(exist_ok=True)
    image.write_bytes(b'')
    (tmp_path / 'volumes' / 'not-a-key.img').write_bytes(b'')
    (info,) = asyncio.run(backend.list_sandboxes())
    assert (info.chat_id, info.running, info.ephemeral, info.image) == (OTHER, False, True, None)
    assert info.last_used is not None
    asyncio.run(backend.destroy(OTHER))
    assert not image.exists()


def test_a_loop_whose_image_was_deleted_is_found_and_detached(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, tmp_path: Path
) -> None:
    """S5: the kernel reports an unlinked backing file as `<path> (deleted)`; it is detached before a new attach."""
    image = tmp_path / 'volumes' / f'{CID}.img'
    image.parent.mkdir(exist_ok=True)
    stale = host.attach(f'{image} (deleted)', 'stale')
    assert backend._loop_of(image) is None
    create(backend)
    assert ['/usr/sbin/udisksctl', 'loop-delete', '--no-user-interaction', '-b', f'/dev/{stale}'] in host.runs
    assert backend._loop_of(image) is not None


def test_a_stale_loop_of_a_kept_volume_is_detached_before_attaching(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, tmp_path: Path
) -> None:
    """S5: after a reboot or a cleanup, a loop of a deleted copy of the image carries the same UUID; it goes first."""
    docker_client.add_volume()
    image = tmp_path / 'volumes' / f'{CID}.img'
    image.write_bytes(b'kept')
    stale = host.attach(f'{image} (deleted)', 'stale')
    create(backend)
    assert acted(host)[0] == ['/usr/sbin/udisksctl', 'loop-delete', '--no-user-interaction', '-b', f'/dev/{stale}']
    assert acted(host)[1][:2] == ['/usr/sbin/udisksctl', 'loop-setup']
    assert image.read_bytes() == b'kept'


def test_a_volume_whose_image_is_gone_is_made_again(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, tmp_path: Path
) -> None:
    """S5: the files went with the image, so the volume is replaced rather than every create failing."""
    docker_client.add_volume()
    create(backend)
    assert docker_client.volume_removed == [f'lllm-sandbox-{CID}']
    assert [c['name'] for c in docker_client.volume_creates] == [f'lllm-sandbox-{CID}']
    assert (tmp_path / 'volumes' / f'{CID}.img').stat().st_size == 16 * 1024 * 1024


def test_the_scope_is_a_stable_id_kept_in_the_volume_directory(tmp_path: Path) -> None:
    """S7: made once, read afterwards, kept when the directory moves; anything else in the file is refused."""
    first = kata.scope_of(tmp_path / 'a')
    assert kata.scope_of(tmp_path / 'a') == first
    assert oct((tmp_path / 'a' / 'scope').stat().st_mode & 0o777) == oct(0o600)
    assert kata.scope_of(tmp_path / 'b') != first
    (tmp_path / 'a').rename(tmp_path / 'moved')
    assert kata.scope_of(tmp_path / 'moved') == first
    (tmp_path / 'moved' / 'scope').write_text('../../etc\n')
    with pytest.raises(ValueError, match='scope'):
        kata.scope_of(tmp_path / 'moved')


def test_another_instances_sandbox_of_the_same_name_is_left_alone(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, tmp_path: Path
) -> None:
    """S7: found by name but of another scope, a container is neither reused, stopped nor exec'd into, and a volume
    is neither mounted nor destroyed."""
    mine = docker_client.scope
    docker_client.scope = 'f' * 16
    docker_client.add_container()
    docker_client.add_volume()
    docker_client.scope = mine
    with pytest.raises(SandboxNotRunning):
        run_exec(backend)
    asyncio.run(backend.stop(CID))
    asyncio.run(backend.destroy(CID))
    assert docker_client.removed == [] and docker_client.volume_removed == []
    image = tmp_path / 'volumes' / f'{CID}.img'
    image.write_bytes(b'')
    with pytest.raises(SandboxError) as raised:
        create(backend)
    assert str(raised.value) == 'a workspace volume of another app instance has this name'
    assert docker_client.run_calls == []


def test_list_rechecks_the_scope_itself(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    """Test-engineer item 3: a daemon that ignored the label filter still lists only this backend's sandboxes."""
    docker_client.add_container(CID)
    mine = docker_client.scope
    docker_client.scope = 'f' * 16
    foreign = docker_client.add_container(OTHER)
    docker_client.scope = mine
    unlabelled = docker_client.add_container('2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a')
    unlabelled.labels.pop('lllm.scope')
    docker_client.containers.list = lambda all, filters, ignore_removed: [
        foreign,
        unlabelled,
        *[c for c in docker_client.containers_by_name.values() if c.name.endswith(CID)],
    ]
    assert [i.chat_id for i in asyncio.run(backend.list_sandboxes())] == [CID]


@pytest.mark.parametrize(
    ('argv', 'expected'),
    [
        (['uvicorn', '--workers', '1', '--workers', '4'], 4),
        (['uvicorn', '--workers=4', '--workers', '1'], 1),
        (['gunicorn', '-w', '4', 'app'], 4),
        (['gunicorn', '-w3', 'app'], 3),
        (['gunicorn', '--workers', '2', '-w', '5'], 5),
        (['uvicorn', '-w'], 1),
    ],
)
def test_server_workers_takes_the_last_flag_and_gunicorns(argv: list[str], expected: int) -> None:
    """Test-engineer item 4."""
    assert lifespan.server_workers(argv, {}) == expected


def test_server_workers_reads_the_process_at_call_time(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lifespan.sys, 'argv', ['uvicorn', '--workers', '3'])
    assert lifespan.server_workers() == 3
    monkeypatch.setattr(lifespan.sys, 'argv', ['uvicorn'])
    monkeypatch.setenv('WEB_CONCURRENCY', '2')
    assert lifespan.server_workers() == 2


def test_a_bad_image_is_refused_before_any_daemon_call(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    """Test-engineer item 5."""
    calls: list[str] = []
    docker_client.info = lambda: calls.append('info') or {'Runtimes': docker_client.runtimes}
    spec = SandboxSpec(CID, 'data')
    object.__setattr__(spec, 'image', 'gpu')
    with pytest.raises(ValueError, match='image'):
        asyncio.run(backend.create(CID, spec))
    assert calls == []


def test_the_app_starts_when_the_sandbox_directory_is_unusable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Test-engineer item 2: no lock directory, then a lock that cannot be taken, then a manager that fails."""
    no_wait(monkeypatch)
    blocker = tmp_path / 'file'
    blocker.write_text('')
    app = App()
    asyncio.run(lifespan.start(app, FakeBackend(), blocker / 'sandbox'))
    assert app.state.sandbox is None
    assert 'could not take its lock' in caplog.text

    def flock(*args: Any) -> None:
        raise OSError('no locks here')

    monkeypatch.setattr(lifespan.fcntl, 'flock', flock)
    asyncio.run(lifespan.start(app, FakeBackend(), tmp_path / 'sandbox'))
    assert app.state.sandbox is None
    monkeypatch.undo()
    no_wait(monkeypatch)

    def broken(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError('a bug')

    monkeypatch.setattr(lifespan, 'SandboxManager', broken)
    asyncio.run(lifespan.start(app, FakeBackend(), tmp_path / 'other'))
    assert app.state.sandbox is None
    assert 'could not start' in caplog.text
    # The lock was given back: the next start takes it.
    monkeypatch.undo()
    no_wait(monkeypatch)
    again = App()

    async def scenario() -> None:
        await lifespan.start(again, FakeBackend(), tmp_path / 'other')
        assert again.state.sandbox is not None
        await lifespan.stop(again, stop_running=False)

    asyncio.run(scenario())


def test_a_slow_startup_sweep_is_finished_not_cancelled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """S6: past the timeout the app starts, and the sweep goes on to its end before the maintenance loop starts."""
    no_wait(monkeypatch)
    monkeypatch.setattr(lifespan, 'STARTUP_SWEEP_TIMEOUT_S', 0.01)
    fake = FakeBackend()
    finished = asyncio.Event()
    real_list = fake.list_sandboxes

    async def slow_list() -> list:
        await asyncio.sleep(0.1)
        found = await real_list()
        finished.set()
        return found

    monkeypatch.setattr(fake, 'list_sandboxes', slow_list)
    app = App()

    async def scenario() -> None:
        await lifespan.start(app, fake, tmp_path)
        assert app.state.sandbox is not None and not finished.is_set()
        await finished.wait()
        await lifespan.stop(app, stop_running=False)

    asyncio.run(scenario())
    assert 'taking longer than' in caplog.text


def test_stop_never_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    """S8: a maintenance task that died, and a shutdown that fails unexpectedly, are logged; teardown goes on."""

    async def died() -> None:
        raise RuntimeError('a bug in the loop')

    class Manager:
        async def shutdown(self, *, stop_running: bool) -> None:
            raise RuntimeError('a bug in shutdown')

    async def scenario() -> None:
        app = App()
        app.state.sandbox_maintenance = asyncio.ensure_future(died())
        await asyncio.sleep(0)
        app.state.sandbox = Manager()
        await lifespan.stop(app, stop_running=True)
        assert app.state.sandbox is None

    asyncio.run(scenario())
    assert 'maintenance task had failed' in caplog.text
    assert 'could not stop the running sandboxes' in caplog.text


def test_a_sweep_that_raises_anything_is_retried(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """S8: an unexpected error from the sweep is logged and retried, never the end of the maintenance task."""
    no_wait(monkeypatch)
    monkeypatch.setattr(lifespan, 'SWEEP_RETRY_S', 0.01)
    fake = FakeBackend()
    swept = asyncio.Event()
    calls = {'n': 0}
    real_list = fake.list_sandboxes

    async def flaky() -> list:
        calls['n'] += 1
        if calls['n'] == 1:
            raise RuntimeError('unexpected')
        found = await real_list()
        swept.set()
        return found

    monkeypatch.setattr(fake, 'list_sandboxes', flaky)
    app = App()

    async def scenario() -> None:
        await lifespan.start(app, fake, tmp_path)
        await swept.wait()
        await asyncio.sleep(0.01)
        assert not app.state.sandbox_maintenance.done()
        await lifespan.stop(app, stop_running=False)

    asyncio.run(scenario())
    assert 'startup sweep failed' in caplog.text


# Fixes from T14's security review (2026-11-11).


def test_the_verdict_alone_decides_and_a_later_round_can_confirm(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    """Security B1: the kill (UID 1000) always reports success here, as a traced one would; the verdict (nobody)
    finds a process left once, and the next round's kill and verdict confirm."""
    docker_client.add_container()
    docker_client.api.verdicts = [1, 0]
    assert run_exec(backend).returncode == 0
    assert kinds(docker_client.api) == ['main', 'kill', 'verify', 'kill', 'verify']
    assert docker_client.removed == []


def test_a_verdict_that_never_confirms_fails_closed_after_the_rounds(
    backend: KataDockerBackend, docker_client: FakeDocker
) -> None:
    """Security B1: a survivor the kill cannot end (a traced kill that reports 0) stops the sandbox."""
    docker_client.add_container()
    docker_client.api.kill_exit = 1
    with pytest.raises(SandboxNotRunning):
        run_exec(backend)
    assert kinds(docker_client.api) == ['main'] + ['kill', 'verify'] * kata.KILL_ROUNDS
    assert docker_client.removed == [f'lllm-sandbox-{CID}']


@pytest.mark.parametrize(
    ('change', 'value'),
    [
        ('Driver', 'macvlan'),
        ('Internal', False),
        ('IPAM', {'Config': [{'Subnet': '10.0.0.0/24', 'IPRange': '10.231.0.128/25'}]}),
        ('IPAM', {'Config': [{'Subnet': '10.231.0.0/24'}]}),
        ('IPAM', {'Config': []}),
        ('IPAM', None),
        ('Options', {}),
        (
            'Options',
            {'com.docker.network.bridge.inhibit_ipv4': 'false', 'com.docker.network.bridge.name': 'lllm-sandbox'},
        ),
        ('Options', {'com.docker.network.bridge.inhibit_ipv4': 'true'}),
        ('Options', {'com.docker.network.bridge.inhibit_ipv4': 'true', 'com.docker.network.bridge.name': 'br-other'}),
        ('Options', None),
    ],
)
def test_a_network_that_is_not_fenced_is_refused(
    backend: KataDockerBackend, docker_client: FakeDocker, change: str, value: Any
) -> None:
    """Security S3: by its attributes, not its name; ready() says why and create refuses before creating."""
    docker_client.network_attrs[change] = value
    reason = asyncio.run(backend.ready())
    assert reason is not None and reason.startswith('The sandbox network local-llm_sandbox is not the internal network')
    with pytest.raises(SandboxUnavailable):
        create(backend)
    assert docker_client.run_calls == [] and docker_client.volume_creates == []


def test_network_is_fenced_accepts_exactly_the_compose_shape() -> None:
    attrs = FakeDocker().network_attrs
    assert kata.network_is_fenced(attrs)


def test_the_filesystem_leaves_a_tail_the_model_cannot_write(
    backend: KataDockerBackend, host: Host, tmp_path: Path
) -> None:
    """Security S1: the filesystem stops TAIL_GAP_BYTES short of the image's end, and the loop gets no partition
    scan."""
    create(backend)
    mkfs = next(argv for argv in host.runs if argv[0].endswith('mkfs.ext4'))
    assert mkfs[mkfs.index('-b') + 1] == '4096'
    assert int(mkfs[-1]) * 4096 == 16 * 1024 * 1024 - kata.TAIL_GAP_BYTES
    setup = next(argv for argv in host.runs if 'loop-setup' in argv)
    assert '--no-partition-scan' in setup


@pytest.mark.parametrize('size', [0, 1024 * 1024, kata.MIN_WORKSPACE_BYTES - 1, cast(Any, 16.0e6), cast(Any, True)])
def test_a_workspace_too_small_for_the_tail_is_refused(tmp_path: Path, size: Any) -> None:
    with pytest.raises(ValueError, match='workspace_bytes'):
        KataDockerBackend(tmp_path, workspace_bytes=size)


def test_stream_threads_have_their_own_pool(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    """Security S2: the readers run in the backend's own pool, which close() releases."""
    docker_client.add_container()
    names: list[str] = []
    real = kata.read_frames

    def recording(raw: Any, out: StreamCap, err: StreamCap) -> None:
        names.append(threading.current_thread().name)
        real(raw, out, err)

    kata.read_frames = recording
    try:
        run_exec(backend)
    finally:
        kata.read_frames = real
    assert names and names[0].startswith('lllm-sandbox-stream')
    backend.close()
    with pytest.raises(RuntimeError):
        backend._streams.submit(print)


def test_lifespan_stop_closes_the_backends_pool(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog) -> None:
    no_wait(monkeypatch)
    closed: list[str] = []
    fake = FakeBackend()
    fake.close = lambda: closed.append('closed')  # FakeBackend has no pool; a stand-in records the call

    async def scenario() -> None:
        app = App()
        await lifespan.start(app, fake, tmp_path)
        await lifespan.stop(app, stop_running=False)
        assert app.state.sandbox_backend is None

    asyncio.run(scenario())
    assert closed == ['closed']

    def broken() -> None:
        raise RuntimeError('pool')

    fake.close = broken

    async def again() -> None:
        app = App()
        await lifespan.start(app, fake, tmp_path / 'two')
        await lifespan.stop(app, stop_running=False)

    asyncio.run(again())
    assert 'could not release its threads' in caplog.text


def test_137_from_a_container_left_not_running_stops_it(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    """Security N6: a container found not running after a 137 (paused, restarting) is stopped before the error."""
    container = docker_client.add_container()
    api = docker_client.api
    api.exit_code = 137
    original = api.exec_inspect

    def inspect(exec_id: str) -> dict[str, Any]:
        found = original(exec_id)
        container.status = 'paused'
        return found

    api.exec_inspect = inspect
    with pytest.raises(SandboxNotRunning, match='stopped during the command'):
        run_exec(backend)
    assert docker_client.removed == [f'lllm-sandbox-{CID}']


def test_137_whose_stop_fails_still_raises(backend: KataDockerBackend, docker_client: FakeDocker, caplog) -> None:
    container = docker_client.add_container()
    api = docker_client.api
    api.exit_code = 137
    original = api.exec_inspect

    def inspect(exec_id: str) -> dict[str, Any]:
        found = original(exec_id)
        container.status = 'paused'
        return found

    api.exec_inspect = inspect
    docker_client.remove_error = docker.errors.APIError('500')
    with pytest.raises(SandboxNotRunning):
        run_exec(backend)
    assert 'found not running after an exit status 137' in caplog.text


def test_the_guest_view_output_is_capped(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    """Security N7: the listing is read through head -c, so a huge stale directory cannot fill the host's memory."""
    docker_client.add_container()
    put_ok(docker_client.api, FILES)
    asyncio.run(backend.put_files(CID, 'uploads', FILES))
    stat = next(e for e in docker_client.api.execs.values() if e.kind == 'stat')
    assert f'| /usr/bin/head -c {kata.GUEST_VIEW_MAX_BYTES}' in stat.argv[-4]


# put_uploads: the read-only uploads mount (2026-11-11, replacing put_files for /workspace/uploads).


def uploads_of(tmp_path: Path) -> dict[str, tuple[bytes, int]]:
    top = tmp_path / 'uploads' / CID
    return {p.name: (p.read_bytes(), p.stat().st_mode & 0o7777) for p in top.iterdir()}


def test_put_uploads_makes_the_directory_hold_exactly_the_files(
    backend: KataDockerBackend, docker_client: FakeDocker, tmp_path: Path
) -> None:
    create(backend)
    # A staging directory left by a call cut short is cleared first.
    (tmp_path / 'uploads' / f'.{CID}.staging').mkdir()
    (tmp_path / 'uploads' / f'.{CID}.staging' / 'a.txt').write_bytes(b'old')
    asyncio.run(backend.put_uploads(CID, [('a.txt', b'alpha'), ('b.csv', b'1,2')]))
    assert uploads_of(tmp_path) == {'a.txt': (b'alpha', 0o444), 'b.csv': (b'1,2', 0o444)}
    kept = (tmp_path / 'uploads' / CID / 'a.txt').stat().st_ino
    # Same content kept as it is; changed content replaced (a new inode); missing names removed; new ones added.
    asyncio.run(backend.put_uploads(CID, [('a.txt', b'alpha'), ('b.csv', b'3,4'), ('c', b'')]))
    assert uploads_of(tmp_path) == {'a.txt': (b'alpha', 0o444), 'b.csv': (b'3,4', 0o444), 'c': (b'', 0o444)}
    assert (tmp_path / 'uploads' / CID / 'a.txt').stat().st_ino == kept
    (tmp_path / 'uploads' / CID / 'stray').mkdir()
    (tmp_path / 'uploads' / CID / 'link').symlink_to('/etc')
    asyncio.run(backend.put_uploads(CID, []))
    assert uploads_of(tmp_path) == {}
    assert not (tmp_path / 'uploads' / f'.{CID}.staging').exists()
    views = [e for e in docker_client.api.execs.values() if e.kind == 'stat']
    assert [v.argv[-2:] for v in views] == [['/workspace/uploads', '%f/%i\\0']] * 3
    assert all(v.kwargs['user'] == '1000:1000' for v in views)


def test_put_uploads_replaces_a_file_of_another_mode_or_kind(backend: KataDockerBackend, tmp_path: Path) -> None:
    create(backend)
    top = tmp_path / 'uploads' / CID
    (top / 'a').write_bytes(b'same')
    (top / 'a').chmod(0o644)
    (top / 'b').mkdir()
    asyncio.run(backend.put_uploads(CID, [('a', b'same'), ('b', b'file')]))
    assert uploads_of(tmp_path) == {'a': (b'same', 0o444), 'b': (b'file', 0o444)}


def test_put_uploads_waits_for_the_guest(backend: KataDockerBackend, docker_client: FakeDocker, tmp_path: Path) -> None:
    create(backend)
    docker_client.api.guest_views = [b'1000 755\n', b'1000 755\na/1\0', None]
    asyncio.run(backend.put_uploads(CID, [('a', b'x')]))
    assert len([e for e in docker_client.api.execs.values() if e.kind == 'stat']) == 3
    docker_client.api.guest_views = [b'1000 755\n']
    with pytest.raises(SandboxError, match='did not see the copied files in time'):
        asyncio.run(backend.put_uploads(CID, [('a', b'y')]))


def test_put_uploads_refuses_bad_arguments_and_a_missing_directory(
    backend: KataDockerBackend, docker_client: FakeDocker, tmp_path: Path
) -> None:
    for files in ([('../a', b'')], [('a', b''), ('a', b'')], [('a/b', b'')], [('', b'')]):
        with pytest.raises(ValueError):
            asyncio.run(backend.put_uploads(CID, files))
    with pytest.raises(TypeError):
        asyncio.run(backend.put_uploads(CID, cast(Any, [('a', 'text')])))
    with pytest.raises(TypeError):
        asyncio.run(backend.put_uploads(CID, cast(Any, ('a', b''))))
    with pytest.raises(SandboxNotRunning):
        asyncio.run(backend.put_uploads(CID, []))
    docker_client.add_container()
    with pytest.raises(SandboxError, match='no uploads directory'):
        asyncio.run(backend.put_uploads(CID, []))
    (tmp_path / 'uploads').mkdir()
    (tmp_path / 'uploads' / CID).symlink_to(tmp_path)
    with pytest.raises(SandboxError, match='no uploads directory'):
        asyncio.run(backend.put_uploads(CID, []))


def test_put_uploads_wraps_a_host_error(
    backend: KataDockerBackend, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    create(backend)

    def full(*args: Any) -> None:
        raise OSError(28, 'No space left on device: /home/someone/secret')

    monkeypatch.setattr(kata.os, 'replace', full)
    with pytest.raises(SandboxError) as raised:
        asyncio.run(backend.put_uploads(CID, [('a', b'x')]))
    assert str(raised.value) == 'the sandbox backend could not copy the uploads into the sandbox'
    assert not (tmp_path / 'uploads' / f'.{CID}.staging').exists()


def test_create_replaces_a_planted_uploads_path_and_destroy_removes_it(
    backend: KataDockerBackend, docker_client: FakeDocker, tmp_path: Path
) -> None:
    (tmp_path / 'uploads').mkdir()
    (tmp_path / 'uploads' / CID).symlink_to(tmp_path)
    create(backend)
    top = tmp_path / 'uploads' / CID
    assert top.is_dir() and not top.is_symlink()
    asyncio.run(backend.put_uploads(CID, [('a', b'x')]))
    (tmp_path / 'uploads' / f'.{CID}.staging').mkdir()
    asyncio.run(backend.destroy(CID))
    assert not top.exists() and not (tmp_path / 'uploads' / f'.{CID}.staging').exists()
    (tmp_path / 'uploads' / CID).write_text('a file')
    assert backend._ensure_uploads(CID).is_dir()
    (tmp_path / 'uploads' / CID).rmdir()
    (tmp_path / 'uploads' / CID).symlink_to(tmp_path)
    asyncio.run(backend.destroy(CID))
    assert not (tmp_path / 'uploads' / CID).is_symlink() and tmp_path.exists()


def test_an_uploads_directory_without_a_volume_is_listed_for_the_sweeps(
    backend: KataDockerBackend, tmp_path: Path
) -> None:
    (tmp_path / 'uploads' / OTHER).mkdir(parents=True)
    (tmp_path / 'uploads' / f'.{OTHER}.staging').mkdir()
    (info,) = asyncio.run(backend.list_sandboxes())
    assert (info.chat_id, info.ephemeral, info.running) == (OTHER, True, False)


def test_put_uploads_removes_stale_files_before_writing(
    backend: KataDockerBackend, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """T13's security re-review, N-a: a put that fails part way leaves fewer files, never ones the user removed."""
    create(backend)
    asyncio.run(backend.put_uploads(CID, [('old.txt', b'revoked')]))

    def full(*args: Any) -> None:
        raise OSError(28, 'No space left on device')

    monkeypatch.setattr(kata.os, 'replace', full)
    with pytest.raises(SandboxError):
        asyncio.run(backend.put_uploads(CID, [('new.txt', b'x')]))
    assert uploads_of(tmp_path) == {}


def test_stop_empties_the_uploads_directory(
    backend: KataDockerBackend, docker_client: FakeDocker, tmp_path: Path
) -> None:
    """T13's security re-review, N-b: every start puts the uploads again, so a stopped sandbox keeps none."""
    create(backend)
    asyncio.run(backend.put_uploads(CID, [('a', b'x'), ('b', b'y')]))
    (tmp_path / 'uploads' / CID / 'd').mkdir()
    asyncio.run(backend.stop(CID))
    assert (tmp_path / 'uploads' / CID).is_dir() and uploads_of(tmp_path) == {}
    # A symlink in its place is not followed.
    (tmp_path / 'uploads' / CID).rmdir()
    (tmp_path / 'uploads' / CID).symlink_to(tmp_path / 'volumes')
    asyncio.run(backend.stop(CID))
    assert (tmp_path / 'volumes' / 'scope').exists()


@pytest.mark.parametrize('planted', ['symlink', 'regular', 'fifo'])
def test_create_removes_an_uploads_entry_that_is_not_a_directory(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, tmp_path: Path, planted: str
) -> None:
    """T13's security re-review, N-c: a workspace used before the uploads mount can hold a symlink or file named
    `uploads`; on Kata the mount then lands where the symlink points, or the create fails. It is removed first, with
    the image detached, so the loop device's cache holds none of it."""
    docker_client.add_volume()
    image = tmp_path / 'volumes' / f'{CID}.img'
    image.write_bytes(b'kept')
    loop = host.attach(str(image), CID)
    host.uploads_entry = planted
    create(backend)
    assert acted(host)[:2] == [
        ['/usr/sbin/udisksctl', 'loop-delete', '--no-user-interaction', '-b', f'/dev/{loop}'],
        ['/usr/sbin/debugfs', '-w', '-R', 'rm uploads', str(image)],
    ]
    assert acted(host)[2][:2] == ['/usr/sbin/udisksctl', 'loop-setup']
    assert host.uploads_entry is None and len(docker_client.run_calls) == 1


def test_create_refuses_when_the_entry_cannot_be_removed(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, tmp_path: Path
) -> None:
    docker_client.add_volume()
    (tmp_path / 'volumes' / f'{CID}.img').write_bytes(b'')
    host.uploads_entry = 'symlink'
    host.rm_fails = True
    with pytest.raises(SandboxError, match='still has an uploads entry'):
        create(backend)
    assert docker_client.run_calls == []


def test_create_refuses_to_edit_a_workspace_still_mounted(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    docker_client.add_volume()
    image = tmp_path / 'volumes' / f'{CID}.img'
    image.write_bytes(b'')
    loop = host.attach(str(image), CID)
    host.uploads_entry = 'symlink'
    # Its device number, as the mount table would show it.
    number = (host.sys_block / loop / 'dev').read_text().strip()
    mountinfo = tmp_path / 'mountinfo'
    mountinfo.write_text(f'36 25 {number} / /var/lib/docker/volumes/x/_data rw - ext4 /dev/{loop} rw\n')
    real_open = open
    monkeypatch.setattr(
        kata,
        'open',
        lambda path, *a, **k: real_open(mountinfo if path == '/proc/self/mountinfo' else path, *a, **k),
        raising=False,
    )
    with pytest.raises(SandboxError, match='still mounted'):
        create(backend)
    assert ['/usr/sbin/debugfs', '-w', '-R', 'rm uploads', str(image)] not in host.runs


def test_entry_type_reads_debugfs() -> None:
    assert kata._entry_type('Inode: 12   Type: symlink    Mode:  0777') == 'symlink'
    assert kata._entry_type('stat: File not found by ext2_lookup') is None


# Code and security re-review fixes (2026-11-11).


def test_the_verdict_counts_a_pass_only_if_no_pid_was_allocated_during_it() -> None:
    """Security re-review B1: a PID-hopping process can be in no listing the scan reads, but every hop allocates a
    PID; between the two /proc/loadavg reads the pass runs bash builtins only, so it allocates none itself."""
    body = VERIFY_SCRIPT.split('read -r _ _ _ _ before < /proc/loadavg', 1)[1].split(
        'read -r _ _ _ _ after < /proc/loadavg', 1
    )[0]
    assert '[ $left = 0 ] && [ "$before" = "$after" ] && exit 0' in VERIFY_SCRIPT
    for forking in ('$(', '`', '|', '/usr/', '/bin/', ' & '):
        assert forking not in body, forking
    # The sleep, which forks, is between passes.
    assert VERIFY_SCRIPT.index('/usr/bin/sleep') > VERIFY_SCRIPT.index('after < /proc/loadavg')


def test_the_scripts_are_valid_bash() -> None:
    for script in (KILL_SCRIPT, VERIFY_SCRIPT, GUARD_SCRIPT):
        done = subprocess.run(['/bin/bash', '-n', '-c', script], capture_output=True, text=True, check=False)
        assert (done.returncode, done.stderr) == (0, '')


def test_the_verdict_on_this_host_tells_a_quiet_set_from_a_moving_one(tmp_path: Path) -> None:
    """The real script, run here against a fake /proc and /proc/loadavg (bash and sed only): exits 0 when no UID
    1000 status is listed and the last PID stays, 1 when the last PID keeps moving (a hopping process)."""
    proc = tmp_path / 'proc'
    (proc / '1').mkdir(parents=True)
    (proc / '1' / 'status').write_text('Name:\tinit\nUid:\t65534\t65534\t65534\t65534\n')
    (proc / 'loadavg').write_text('0.00 0.00 0.00 1/50 300\n')
    script = VERIFY_SCRIPT.replace('/proc/', f'{proc}/').replace('/usr/bin/sleep 0.05', ':')
    quiet = subprocess.run(['/bin/bash', '-c', script], check=False)
    assert quiet.returncode == 0
    # Every read of loadavg sees a new last PID: never a quiet pass.
    moving = script.replace(f'< {proc}/loadavg', '< <(echo 0 0 0 1/50 $RANDOM$RANDOM)')
    assert subprocess.run(['/bin/bash', '-c', moving], check=False).returncode == 1
    (proc / '7').mkdir()
    (proc / '7' / 'status').write_text('Name:\tsleep\nUid:\t1000\t1000\t1000\t1000\n')
    assert subprocess.run(['/bin/bash', '-c', script], check=False).returncode == 1


def test_create_checks_the_guest_itself(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    """Security re-review S1: a nobody exec in every new guest checks seccomp and IPv6 before any command."""
    create(backend)
    (guard,) = [e for e in docker_client.api.execs.values() if e.kind == 'guard']
    assert guard.argv == ['/usr/bin/timeout', '10', *kata._GUEST_SHELL, GUARD_SCRIPT]
    assert guard.kwargs['user'] == '65534:65534'


@pytest.mark.parametrize(
    ('said', 'reason'),
    [
        (b'no seccomp filter in the guest\n', 'The sandbox cannot run: no seccomp filter in the guest'),
        (b'the guest has an IPv6 address\n', 'The sandbox cannot run: the guest has an IPv6 address'),
        (b'/home/someone: oops', 'The sandbox cannot run: the guest could not be checked'),
        (None, 'The sandbox cannot run: the guest could not be checked'),
    ],
)
def test_a_guest_that_fails_its_guard_is_removed(
    backend: KataDockerBackend, docker_client: FakeDocker, said: bytes | None, reason: str
) -> None:
    docker_client.api.guard_exit = 1
    docker_client.api.guard_said = cast(Any, said)
    with pytest.raises(SandboxUnavailable) as raised:
        create(backend)
    assert (str(raised.value), raised.value.public) == (reason, reason)
    assert docker_client.removed == [f'lllm-sandbox-{CID}']


@pytest.mark.parametrize(
    ('config', 'ok'),
    [
        ('[runtime]\ndisable_guest_seccomp = false\n', True),
        ('[runtime]\ndisable_guest_seccomp\t=\tfalse # on (Q19)\n', True),
        ('[runtime]\ndisable_guest_seccomp = true\n', False),
        ('[runtime]\n# disable_guest_seccomp = false\ndisable_guest_seccomp = true\n', False),
        ('[runtime]\ndisable_guest_seccomp = false\n[agent.kata]\ndisable_guest_seccomp = true\n', False),
        ('[agent.kata]\ndisable_guest_seccomp = false\n', False),
        ('disable_guest_seccomp = false\n', False),
        ('[runtime]\ndisable_guest_seccomp = "false"\n', False),
        ('[runtime\nnot toml', False),
        ('', False),
        (None, False),
    ],
)
def test_ready_requires_guest_seccomp_in_the_kata_configuration(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, config: str | None, ok: bool
) -> None:
    mirror = docker_client.add_container(key='mirror')
    docker_client.containers_by_name = {'local-llm-sandbox-mirror': mirror}
    if config is None:
        host.kata_config.unlink()
    else:
        host.kata_config.write_text(config)
    expected = None if ok else 'Kata runs guests without seccomp (docs/guides/sandbox.md, "Guest seccomp")'
    assert asyncio.run(backend.ready()) == expected


@pytest.mark.parametrize('value', ['0', '', None])
def test_ready_requires_ipv6_off_on_the_bridge(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, value: str | None
) -> None:
    """R-N2: the host's layer (Q20), after the network check, since the bridge exists only with the network."""
    if value is None:
        host.bridge_ipv6.unlink()
    else:
        host.bridge_ipv6.write_text(value)
    assert asyncio.run(backend.ready()) == (
        'IPv6 is not off on the sandbox bridge lllm-sandbox (docs/guides/sandbox.md, "Host setup")'
    )
    with pytest.raises(SandboxUnavailable):
        create(backend)


def test_ready_names_a_corrupt_scope_file(backend: KataDockerBackend, tmp_path: Path) -> None:
    """Code re-review N2."""
    (tmp_path / 'volumes' / 'scope').write_text('not a scope\n')
    fresh = KataDockerBackend(tmp_path / 'volumes', client_factory=lambda: backend._docker())
    assert asyncio.run(fresh.ready()) == 'The sandbox scope id file is unreadable or not one this backend made'


def test_a_network_with_ipv6_is_not_fenced() -> None:
    attrs = dict(FakeDocker().network_attrs)
    attrs['EnableIPv6'] = True
    assert not kata.network_is_fenced(attrs)
    attrs['EnableIPv6'] = False
    assert kata.network_is_fenced(attrs)


def test_a_leftover_destroyed_while_listing_is_skipped(
    backend: KataDockerBackend, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Code re-review R2: a leftover that vanishes between the scan and its lstat does not fail the whole list."""
    (tmp_path / 'volumes' / f'{OTHER}.img').write_bytes(b'')
    real = Path.lstat

    def gone(self: Path, *args: Any, **kwargs: Any) -> os.stat_result:
        if self.name == f'{OTHER}.img':
            raise FileNotFoundError(self)
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Path, 'lstat', gone)
    assert asyncio.run(backend.list_sandboxes()) == []


def test_a_staging_directory_left_alone_is_listed_for_the_sweeps(backend: KataDockerBackend, tmp_path: Path) -> None:
    """Code re-review N5."""
    (tmp_path / 'uploads' / f'.{OTHER}.staging').mkdir(parents=True)
    (info,) = asyncio.run(backend.list_sandboxes())
    assert (info.chat_id, info.ephemeral) == (OTHER, True)
    asyncio.run(backend.destroy(OTHER))
    assert not (tmp_path / 'uploads' / f'.{OTHER}.staging').exists()


def test_modes_do_not_depend_on_the_umask(backend: KataDockerBackend, tmp_path: Path) -> None:
    """Code re-review R3."""
    old = os.umask(0o077)
    try:
        create(backend)
        asyncio.run(backend.put_uploads(CID, [('a', b'x')]))
    finally:
        os.umask(old)
    top = tmp_path / 'uploads' / CID
    assert oct(top.stat().st_mode & 0o777) == oct(0o755)
    assert oct((top / 'a').stat().st_mode & 0o777) == oct(0o444)
    assert oct((tmp_path / 'volumes' / f'{CID}.img').stat().st_mode & 0o777) == oct(0o600)


def test_destroy_drops_the_keys_lock(backend: KataDockerBackend) -> None:
    """Code re-review N3."""
    create(backend)
    assert CID in backend._key_locks
    asyncio.run(backend.destroy(CID))
    assert CID not in backend._key_locks


@pytest.mark.parametrize(
    ('argv', 'expected'),
    [
        (['uvicorn', '-w4'], 1),
        (['uvicorn', '-w', '4'], 1),
        (['/usr/bin/gunicorn', '-w4'], 4),
        (['gunicorn', '-w', '3'], 3),
    ],
)
def test_only_gunicorns_dash_w_counts(argv: list[str], expected: int) -> None:
    """Code re-review N4."""
    assert lifespan.server_workers(argv, {}) == expected


# Final code re-review fixes (G1-G5), 2026-11-11.

# The guard from its IPv6 check to its end, so the script's own exit status is what is tested.
_GUARD_IPV6 = GUARD_SCRIPT[GUARD_SCRIPT.index('! read -r _') :]


def run_guard_ipv6(path: Path | str) -> int:
    return subprocess.run(
        ['/bin/bash', '-c', _GUARD_IPV6.replace('/proc/net/if_inet6', str(path))], check=False
    ).returncode


def test_the_guards_ipv6_check_reads_the_real_procfs_file() -> None:
    """G1: procfs files report size 0, so a size test (`-s`) always passed. The check reads a line instead. Run on
    this host's own /proc/net/if_inet6 (no skip): it exits 1 when the host has an IPv6 address, else 0."""
    real = Path('/proc/net/if_inet6')
    has_addresses = real.exists() and real.read_text() != ''
    assert run_guard_ipv6(real) == (1 if has_addresses else 0)
    if real.exists():
        # The bug class: a procfs file's size says nothing about its content.
        assert real.stat().st_size == 0


def test_the_guards_ipv6_check_on_a_file_that_reads_like_procfs() -> None:
    """G1: a file that has content but reports size 0, as every procfs file does (here /proc/self/status, which
    always has lines): the check sees the content. A size test (`-s`) would have passed it."""
    procfs_like = Path('/proc/self/status')
    assert procfs_like.stat().st_size == 0 and procfs_like.read_text() != ''
    assert run_guard_ipv6(procfs_like) == 1
    old_form = '[ ! -s /proc/self/status ] || exit 1; exit 0'
    assert subprocess.run(['/bin/bash', '-c', old_form], check=False).returncode == 0


def test_the_guards_ipv6_check_on_regular_files(tmp_path: Path) -> None:
    one = tmp_path / 'one'
    one.write_text('fe800000000000000000000000000001 02 40 20 80     eth0\n')
    empty = tmp_path / 'empty'
    empty.write_text('')
    assert (run_guard_ipv6(one), run_guard_ipv6(empty), run_guard_ipv6(tmp_path / 'missing')) == (1, 0, 0)


def test_the_guard_waits_for_its_exit_status(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    """G2: the exit status can show a moment after the output ends; a guard still running is waited for."""
    docker_client.api.guard_running_for = 2
    create(backend)
    assert len(docker_client.run_calls) == 1 and docker_client.removed == []


def test_a_guard_that_never_reports_fails_closed(
    backend: KataDockerBackend, docker_client: FakeDocker, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(kata, 'EXIT_STATUS_WAIT_S', 0.05)
    docker_client.api.guard_running_for = 10**9
    with pytest.raises(SandboxUnavailable, match='could not be checked'):
        create(backend)
    assert docker_client.removed == [f'lllm-sandbox-{CID}']


def test_a_guard_that_raises_removes_the_new_guest(backend: KataDockerBackend, docker_client: FakeDocker) -> None:
    """G5: an unchecked guest never stays up."""
    real = docker_client.api.exec_create

    def exec_create(container: str, cmd: list[str], **kwargs: Any) -> dict[str, str]:
        if GUARD_SCRIPT in cmd:
            raise docker.errors.APIError('500 /var/lib/docker')
        return real(container, cmd, **kwargs)

    docker_client.api.exec_create = exec_create
    with pytest.raises(SandboxError, match='^the sandbox backend could not start the sandbox$'):
        create(backend)
    assert docker_client.removed == [f'lllm-sandbox-{CID}']


def test_a_host_without_ipv6_is_fenced(docker_client: FakeDocker, host: Host, tmp_path: Path, fast: None) -> None:
    """G3: with IPv6 compiled out there is no /proc/sys/net/ipv6, which is the safest case, not a refusal."""
    mirror = docker_client.add_container(key='mirror')
    docker_client.containers_by_name = {'local-llm-sandbox-mirror': mirror}
    gone = tmp_path / 'no-ipv6' / 'conf' / 'lllm-sandbox' / 'disable_ipv6'
    docker_client.scope = kata.scope_of(tmp_path / 'volumes')
    backend = KataDockerBackend(
        tmp_path / 'volumes', client_factory=lambda: docker_client, workspace_bytes=16 * 1024 * 1024, bridge_ipv6=gone
    )
    assert asyncio.run(backend.ready()) is None


def test_the_whole_guard_on_fake_proc_files(tmp_path: Path) -> None:
    """The guard script end to end, its two /proc reads pointed at regular files: passes with seccomp on and no IPv6
    address, and says why otherwise."""
    status, inet6 = tmp_path / 'status', tmp_path / 'if_inet6'

    def run(seccomp: str, addresses: str) -> tuple[int, str]:
        status.write_text(f'Name:\tbash\nSeccomp:\t{seccomp}\nSeccomp_filters:\t1\n')
        inet6.write_text(addresses)
        script = GUARD_SCRIPT.replace('/proc/self/status', str(status)).replace('/proc/net/if_inet6', str(inet6))
        done = subprocess.run(['/bin/bash', '-c', script], capture_output=True, text=True, check=False)
        return done.returncode, done.stdout.strip()

    assert run('2', '') == (0, '')
    assert run('0', '') == (1, 'no seccomp filter in the guest')
    assert run('2', 'fe800000000000000000000000000001 02 40 20 80 eth0\n') == (1, 'the guest has an IPv6 address')


@pytest.mark.parametrize(
    ('daemon', 'expected'),
    [
        ({'runtimes': {'kata-clh': {'options': {'ConfigPath': '/etc/kata/clh.toml'}}}}, '/etc/kata/clh.toml'),
        ({'runtimes': {'kata-clh': {'options': {}}}}, None),
        ({'runtimes': {'kata-clh': {'options': {'ConfigPath': 'relative.toml'}}}}, None),
        ({'runtimes': {'runc': {}}}, None),
        ({}, None),
        ([], None),
        ('not json', None),
    ],
)
def test_the_kata_configuration_is_the_one_daemon_json_names(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, daemon: Any, expected: str | None
) -> None:
    """The checked configuration follows daemon.json's ConfigPath for kata-clh; anything else falls back."""
    path = tmp_path / 'daemon.json'
    path.write_text(daemon if isinstance(daemon, str) else json.dumps(daemon))
    monkeypatch.setattr(kata, 'DAEMON_JSON', path)
    assert kata._kata_config_path() == (Path(expected) if expected else kata.KATA_CONFIG)
    monkeypatch.setattr(kata, 'DAEMON_JSON', tmp_path / 'missing.json')
    assert kata._kata_config_path() == kata.KATA_CONFIG


def test_ready_reads_the_configuration_daemon_json_names(
    backend: KataDockerBackend, docker_client: FakeDocker, host: Host, monkeypatch: pytest.MonkeyPatch
) -> None:
    mirror = docker_client.add_container(key='mirror')
    docker_client.containers_by_name = {'local-llm-sandbox-mirror': mirror}
    other = host.root / 'other.toml'
    other.write_text('[runtime]\ndisable_guest_seccomp = true\n')
    daemon = host.root / 'daemon.json'
    daemon.write_text(json.dumps({'runtimes': {'kata-clh': {'options': {'ConfigPath': str(other)}}}}))
    monkeypatch.setattr(kata, 'DAEMON_JSON', daemon)
    assert asyncio.run(backend.ready()) == 'Kata runs guests without seccomp (docs/guides/sandbox.md, "Guest seccomp")'
