"""The Kata backend (local_llm/sandbox/kata.py) against the real Docker daemon and Kata runtime.

Skipped unless LLLM_TEST_KATA=1 (owner decision Q3): GitHub's hosted runners
have no /dev/kvm, so these run on the laptop and their results are recorded in
the plan's ledger. The mocked-SDK unit tests (test_sandbox_kata_unit.py)
cover the same code in CI.

Needs: Docker with the `kata-clh` runtime (docs/guides/sandbox.md, "Host
setup"), both sandbox images (`make sandbox-images`), udisks2 and an active
local login session (the workspace volumes are loop devices udisks attaches),
and nothing else named `lllm-sandbox-*`. If the `local-llm_sandbox` network
does not exist (`make backend` creates it once T16 is in), the tests create
it with the backend's subnet and remove it afterwards; a network that already
existed is left alone. The `sandbox-mirror` container is not needed: ready()
is only checked for its other reasons. Workspace image files go under
pytest's temporary directory. Every container, volume and image file a test
makes is removed at the end.

Run from apps/server (any LLLM_SECRET_KEY of 32 characters or more):

    LLLM_TEST_KATA=1 LLLM_SECRET_KEY=... uv run --frozen python -m pytest tests/test_sandbox_kata.py -v

The whole module takes a few minutes, most of it in the PID 1 test's
several hundred calls.
"""

import asyncio
import os
import re
import socket
import subprocess
import threading
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

if os.environ.get('LLLM_TEST_KATA') != '1':
    pytest.skip('set LLLM_TEST_KATA=1 on a host with Docker and Kata (kata-clh) to run these', allow_module_level=True)

import docker
import docker.errors

from local_llm.sandbox import kata, workspace
from local_llm.sandbox.exec import wrap_command
from local_llm.sandbox.kata import (
    BRIDGE_NAME,
    BRIDGE_NAME_OPTION,
    INHIBIT_IPV4,
    MIRROR_CONTAINER,
    SANDBOX_IP_RANGE,
    SANDBOX_MIRROR_ADDRESS,
    SANDBOX_NETWORK,
    SANDBOX_SUBNET,
    TAIL_GAP_BYTES,
    VERIFY_SCRIPT,
    KataDockerBackend,
    container_name,
    list_helper_name,
    network_is_fenced,
)
from local_llm.sandbox.manager import SandboxManager, SandboxSettings
from local_llm.sandbox.types import (
    ExecResult,
    ImageKey,
    SandboxNotRunning,
    SandboxSpec,
    SandboxUnavailable,
    volume_name,
)
from local_llm.sandbox.workspaces import MemoryWorkspaces

MIRROR_REASON = 'The sandbox-mirror container is not running; make backend starts it'


@pytest.fixture(scope='module')
def client() -> Iterator[docker.DockerClient]:
    c = docker.from_env()
    yield c
    c.close()


@pytest.fixture(scope='module')
def network(client: docker.DockerClient) -> Iterator[None]:
    try:
        existing = client.networks.get(SANDBOX_NETWORK)
        created = None
    except docker.errors.NotFound:
        ipam = docker.types.IPAMConfig(
            pool_configs=[docker.types.IPAMPool(subnet=SANDBOX_SUBNET, iprange=SANDBOX_IP_RANGE)]
        )
        created = client.networks.create(
            SANDBOX_NETWORK,
            driver='bridge',
            internal=True,
            ipam=ipam,
            options={INHIBIT_IPV4: 'true', BRIDGE_NAME_OPTION: BRIDGE_NAME},
            labels={'lllm.test': 'kata'},
        )
    else:
        # An existing one (Compose's) must be the fenced network, or the backend refuses it and the tests mean nothing.
        if not network_is_fenced(existing.attrs):
            pytest.fail(
                f'{SANDBOX_NETWORK} exists but is not the fenced sandbox network (bridge, internal, '
                f'{SANDBOX_SUBNET}, ip_range {SANDBOX_IP_RANGE}, {INHIBIT_IPV4}=true, bridge {BRIDGE_NAME}); '
                'fix it in Compose, or remove it'
            )
    yield
    if created is not None:
        created.remove()


class Keys:
    """The sandboxes a test module made, destroyed at its end."""

    def __init__(self) -> None:
        self.made: list[tuple[KataDockerBackend, str]] = []

    def new(self, backend: KataDockerBackend) -> str:
        key = str(uuid.uuid4())
        self.made.append((backend, key))
        return key


@pytest.fixture(scope='module')
def keys(client: docker.DockerClient) -> Iterator[Keys]:
    made = Keys()
    yield made
    failed = []
    for backend, key in made.made:
        # Every one is tried, whatever happened to the one before.
        try:
            asyncio.run(backend.destroy(key))
        except Exception as e:
            failed.append((key, e))
    assert failed == []
    left = client.containers.list(all=True, filters={'label': 'lllm.chat'})
    assert not [c for c in left if c.name in {container_name(k) for _, k in made.made}]


@pytest.fixture(scope='module')
def backend(network: None, tmp_path_factory: pytest.TempPathFactory) -> KataDockerBackend:
    return KataDockerBackend(tmp_path_factory.mktemp('volumes'))


@pytest.fixture(scope='module')
def small_backend(network: None, tmp_path_factory: pytest.TempPathFactory) -> KataDockerBackend:
    return KataDockerBackend(tmp_path_factory.mktemp('small-volumes'), workspace_bytes=64 * 1024 * 1024)


def started(backend: KataDockerBackend, keys: Keys, image: ImageKey = 'data') -> str:
    key = keys.new(backend)
    asyncio.run(backend.create(key, SandboxSpec(key, image)))
    return key


async def run(backend: KataDockerBackend, key: str, command: str, timeout_s: int = 30, stdin: bytes | None = None):
    return await backend.exec(key, wrap_command(command, timeout_s), timeout_s, stdin)


def sh(
    backend: KataDockerBackend, key: str, command: str, timeout_s: int = 30, stdin: bytes | None = None
) -> ExecResult:
    return asyncio.run(run(backend, key, command, timeout_s, stdin))


def root(client: docker.DockerClient, key: str, command: str) -> str:
    """Run `command` in the guest as root (capabilities dropped), outside the backend, for a test's own checks."""
    container = client.containers.get(container_name(key))
    code, out = container.exec_run(['/bin/sh', '-c', command], user='0:0')
    return out.decode()


def uid_1000_processes(client: docker.DockerClient, key: str) -> list[str]:
    out = root(client, key, 'ps -eo uid=,stat=,args=')
    return [line for line in out.splitlines() if line.split()[0] == '1000' and 'ps -eo' not in line]


def zombies(client: docker.DockerClient, key: str) -> list[str]:
    out = root(client, key, 'ps -eo stat=,args=')
    return [line for line in out.splitlines() if line.lstrip().startswith('Z')]


def host_address() -> str:
    """This host's address on its default route (no packet is sent)."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(('192.0.2.1', 9))
        return probe.getsockname()[0]
    finally:
        probe.close()


# Readiness.


def test_ready_reports_only_the_mirror_or_nothing(backend: KataDockerBackend, client: docker.DockerClient) -> None:
    reason = asyncio.run(backend.ready())
    try:
        mirror = client.containers.get(MIRROR_CONTAINER).status == 'running'
    except docker.errors.NotFound:
        mirror = False
    assert reason == (None if mirror else MIRROR_REASON)
    assert set(backend.image_ids) == {'data', 'web'}


# Boundary.


def test_vm_boundary(backend: KataDockerBackend, keys: Keys) -> None:
    before = int(subprocess.run(['pgrep', '-c', '-x', 'cloud-hyperviso'], capture_output=True, text=True).stdout or 0)
    key = started(backend, keys)
    after = int(subprocess.run(['pgrep', '-c', '-x', 'cloud-hyperviso'], capture_output=True, text=True).stdout or 0)
    result = sh(backend, key, 'uname -r')
    assert result.returncode == 0
    assert result.stdout.strip() != os.uname().release
    assert after == before + 1
    asyncio.run(backend.stop(key))


def test_container_runs_with_the_fixed_options(
    backend: KataDockerBackend, keys: Keys, client: docker.DockerClient
) -> None:
    key = started(backend, keys)
    result = sh(
        backend,
        key,
        'id -u; id -g; stat -c %U /proc/1; grep -E "^(CapEff|CapBnd|NoNewPrivs):" /proc/self/status; ulimit -u; '
        'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max; '
        'touch /etc/x 2>&1; touch /usr/x 2>&1; findmnt -no FSTYPE,OPTIONS /tmp; '
        'grep sandbox-mirror /etc/hosts; echo size=$(df -B1 --output=size /workspace | tail -1); pwd; '
        'cat /proc/1/cmdline | tr "\\0" " "',
    )
    lines = result.stdout.splitlines()
    assert lines[0:3] == ['1000', '1000', 'nobody']
    assert 'CapEff:\t0000000000000000' in result.stdout
    assert 'CapBnd:\t0000000000000000' in result.stdout
    assert 'NoNewPrivs:\t1' in result.stdout
    assert '\n512\n' in result.stdout
    assert str(4 * 1024**3) in result.stdout
    assert '200000 100000' in result.stdout
    assert result.stdout.count('Read-only file system') == 2
    assert re.search(r'tmpfs .*size=262144k', result.stdout)
    assert re.search(rf'^{re.escape(SANDBOX_MIRROR_ADDRESS)}\s+sandbox-mirror$', result.stdout, re.M)
    sized = re.search(r'^size=\s*(\d+)$', result.stdout, re.M)
    assert sized is not None
    assert 9 * 1024**3 < int(sized.group(1)) <= 10 * 1024**3
    assert '/workspace' in lines
    assert '/sbin/docker-init -- /usr/bin/sleep infinity' in result.stdout
    # Exactly one init, the healthcheck off.
    attrs = client.containers.get(container_name(key)).attrs
    assert attrs['Config']['Healthcheck']['Test'] == ['NONE']
    assert attrs['HostConfig']['Runtime'] == 'kata-clh'
    asyncio.run(backend.stop(key))


def test_network_fence(backend: KataDockerBackend, keys: Keys) -> None:
    # A listener on every host address, which the guest must not reach.
    listener = socket.create_server(('0.0.0.0', 0))
    port = listener.getsockname()[1]
    stop = threading.Event()

    def accept() -> None:
        listener.settimeout(0.2)
        while not stop.is_set():
            try:
                conn, _ = listener.accept()
                conn.close()
            except TimeoutError:
                continue

    thread = threading.Thread(target=accept, daemon=True)
    thread.start()
    # The bridge's own address, if it had one: .1 when Compose names a gateway, else the dynamic range's first.
    prefix = SANDBOX_SUBNET.rsplit('.', 1)[0]
    targets = [host_address(), '172.17.0.1', f'{prefix}.1', f'{prefix}.128', '1.1.1.1', '127.0.0.1']
    probes = [f'{host}:{p}' for host in targets for p in (port, 4000, 5432, 6379, 8080, 8090, 443)]
    script = (
        'import socket, sys\n'
        'for t in sys.argv[1:]:\n'
        '    h, p = t.rsplit(":", 1)\n'
        '    s = socket.socket(); s.settimeout(2)\n'
        '    try:\n'
        '        s.connect((h, int(p))); print("OPEN", t)\n'
        '    except OSError as e:\n'
        '        print("closed", t, e)\n'
        '    finally:\n'
        '        s.close()\n'
        'for n in ("pypi.org", "postgres", "redis", "jupyter", "host.docker.internal"):\n'
        '    try:\n'
        '        print("RESOLVED", n, socket.gethostbyname(n))\n'
        '    except OSError:\n'
        '        print("unresolved", n)\n'
        'print("mirror", socket.gethostbyname("sandbox-mirror"))\n'
        'import urllib.request\n'
        'print("mirror http", urllib.request.urlopen("http://sandbox-mirror:8000/", timeout=5).status)\n'
    )
    try:
        key = started(backend, keys)
        result = sh(backend, key, f'python3 -c {shq(script)} ' + ' '.join(probes), timeout_s=120)
    finally:
        stop.set()
        thread.join()
        listener.close()
    assert result.returncode == 0, result.stderr
    assert 'OPEN' not in result.stdout, result.stdout
    assert 'RESOLVED' not in result.stdout, result.stdout
    assert f'mirror {SANDBOX_MIRROR_ADDRESS}' in result.stdout
    # The mirror, a peer on the network, is the one thing it reaches.
    assert 'mirror http 200' in result.stdout, result.stdout
    asyncio.run(backend.stop(key))


def shq(text: str) -> str:
    return "'" + text.replace("'", "'\\''") + "'"


def test_cross_chat_isolation(backend: KataDockerBackend, keys: Keys) -> None:
    a = started(backend, keys)
    b = started(backend, keys)
    assert sh(backend, a, 'echo secret > /workspace/a.txt').returncode == 0
    seen = sh(backend, b, 'ls -A /workspace; cat /workspace/a.txt')
    assert 'a.txt' not in seen.stdout
    assert seen.returncode != 0
    asyncio.run(backend.stop(a))
    asyncio.run(backend.stop(b))


def test_persistence_across_stop_and_image_switch(backend: KataDockerBackend, keys: Keys) -> None:
    key = started(backend, keys)
    assert sh(backend, key, 'echo kept > /workspace/kept.txt').returncode == 0
    asyncio.run(backend.stop(key))
    infos = {i.chat_id: i for i in asyncio.run(backend.list_sandboxes())}
    assert infos[key].running is False and infos[key].image is None
    asyncio.run(backend.create(key, SandboxSpec(key, 'data')))
    assert sh(backend, key, 'cat /workspace/kept.txt').stdout == 'kept\n'
    r = sh(backend, key, 'Rscript -e "library(dplyr)" 2>&1; echo rc=$?', timeout_s=120)
    assert 'rc=0' in r.stdout
    asyncio.run(backend.create(key, SandboxSpec(key, 'web')))
    infos = {i.chat_id: i for i in asyncio.run(backend.list_sandboxes())}
    assert infos[key].running is True and infos[key].image == 'web'
    switched = sh(backend, key, 'cat /workspace/kept.txt; tsc --version')
    assert switched.stdout.startswith('kept\nVersion ')
    asyncio.run(backend.stop(key))


# Files.


def test_put_files_replaces_whatever_had_the_name(
    backend: KataDockerBackend, keys: Keys, client: docker.DockerClient
) -> None:
    key = started(backend, keys)
    files = [('a.txt', b'alpha', 0o444), ('b.csv', b'1,2\n', 0o444)]
    # UID 1000 cannot change the root-owned directory, but owns /workspace, so it can move it aside (T02 item 9).
    aside = 'mv /workspace/shared "$(mktemp -u /workspace/aside.XXXXXX)" && '
    setups = {
        'fresh': 'true',
        'replaced with planted files': (
            aside + 'mkdir /workspace/shared && touch /workspace/shared/planted && chmod 777 /workspace/shared'
        ),
        'a symlink to /etc': aside + 'ln -s /etc /workspace/shared',
        'a regular file': aside + 'echo x > /workspace/shared',
        'a directory of its own with planted files': aside
        + 'mkdir -p /workspace/shared/sub && touch /workspace/shared/sub/p',
    }
    etc_before = root(client, key, 'ls -A /etc | md5sum')
    for name, setup in setups.items():
        if name != 'fresh':
            assert sh(backend, key, setup).returncode == 0, name
        asyncio.run(backend.put_files(key, 'shared', files))
        listing = sh(backend, key, 'cd /workspace/shared && find . -mindepth 1 -printf "%u %m %p\\n" | sort')
        assert listing.stdout == 'root 444 ./a.txt\nroot 444 ./b.csv\n', name
        top = asyncio.run(backend.stat(key, '/workspace/shared'))
        assert top is not None and (top.kind, top.uid, top.mode) == ('dir', 0, 0o555), name
        attempt = sh(
            backend,
            key,
            'echo x >> /workspace/shared/a.txt; rm -f /workspace/shared/a.txt; chmod 666 /workspace/shared/a.txt; '
            'touch /workspace/shared/new; cat /workspace/shared/a.txt',
        )
        assert attempt.stdout == 'alpha'
        assert attempt.stderr.count('Permission denied') + attempt.stderr.count('Operation not permitted') >= 4
    assert root(client, key, 'ls -A /etc | md5sum') == etc_before
    # T13's ordinary re-sync: a root-owned 0555 directory replaced by another with one more file, which the very
    # next command must see (virtio-fs caches names and attributes for a second).
    for round in range(5):
        more = [*files, (f'new{round}.txt', b'fresh', 0o444)]
        asyncio.run(backend.put_files(key, 'shared', more))
        seen = sh(backend, key, f'cat /workspace/shared/new{round}.txt && ls /workspace/shared')
        assert (seen.returncode, seen.stdout) == (0, f'fresha.txt\nb.csv\nnew{round}.txt\n'), seen
    asyncio.run(backend.stop(key))


def test_get_files_and_stat(backend: KataDockerBackend, keys: Keys) -> None:
    key = started(backend, keys)
    setup = (
        'cd /workspace && mkdir -p d && printf hello > d/f.txt && head -c 5000 /dev/zero > big && '
        'ln -s /etc e && ln -s d/f.txt link && mkfifo fifo && '
        'python3 -c "import socket; socket.socket(socket.AF_UNIX).bind(\'/workspace/sock\')" && '
        'chmod 4755 d/f.txt; true'
    )
    assert sh(backend, key, setup).returncode == 0
    got = asyncio.run(
        backend.get_files(
            key,
            [
                '/workspace/d/f.txt',
                '/workspace/big',
                '/workspace/d',
                '/workspace/e',
                '/workspace/e/passwd',
                '/workspace/link',
                '/workspace/fifo',
                '/workspace/sock',
                '/workspace/missing',
            ],
            1000,
        )
    )
    assert got == {'/workspace/d/f.txt': b'hello'}
    assert asyncio.run(backend.get_files(key, ['/workspace/big'], 5000)) == {'/workspace/big': b'\0' * 5000}

    def stat(path: str) -> tuple[str, int, int] | None:
        found = asyncio.run(backend.stat(key, path))
        return None if found is None else (found.kind, found.uid, found.mode)

    assert stat('/workspace') == ('dir', 1000, 0o755)
    assert stat('/workspace/d/f.txt') == ('file', 1000, 0o4755)
    assert stat('/workspace/e') == ('symlink', 1000, 0o777)
    assert stat('/workspace/e/passwd') is None
    fifo = stat('/workspace/fifo')
    assert fifo is not None and fifo[0] == 'other' and fifo[1] == 1000
    sock = stat('/workspace/sock')
    assert sock is not None and sock[0] == 'other'
    assert stat('/workspace/missing') is None
    asyncio.run(backend.stop(key))


# Commands.


def test_stdin_and_exit_status(backend: KataDockerBackend, keys: Keys) -> None:
    key = started(backend, keys)
    piped = sh(backend, key, 'wc -c; echo err >&2; exit 3', stdin=b'x' * 900_000)
    assert (piped.returncode, piped.stdout.strip(), piped.stderr) == (3, '900000', 'err\n')
    assert piped.timed_out is False
    asyncio.run(backend.stop(key))


def test_timeout_leaves_no_process(backend: KataDockerBackend, keys: Keys, client: docker.DockerClient) -> None:
    key = started(backend, keys)
    t = time.monotonic()
    result = sh(backend, key, 'sleep 999 & sleep 999 >/dev/null 2>&1 & sleep 999', timeout_s=5)
    assert (result.returncode, result.timed_out) == (124, True)
    assert time.monotonic() - t < 12
    assert uid_1000_processes(client, key) == []
    # The next call starts clean: nothing but its own command runs as UID 1000.
    nxt = sh(backend, key, 'ps -u 1000 -o comm=')
    assert sorted(nxt.stdout.split()) == ['bash', 'ps', 'timeout'] or sorted(nxt.stdout.split()) == ['ps', 'timeout']
    asyncio.run(backend.stop(key))


def test_background_child_does_not_hold_the_call(
    backend: KataDockerBackend, keys: Keys, client: docker.DockerClient
) -> None:
    key = started(backend, keys)
    t = time.monotonic()
    result = sh(backend, key, 'sleep 300 & echo started', timeout_s=60)
    took = time.monotonic() - t
    assert (result.returncode, result.stdout, result.timed_out) == (0, 'started\n', False)
    assert took < 5
    assert result.duration_ms < 2000
    assert uid_1000_processes(client, key) == []
    # A command that kills its own `timeout` to escape it (Q10) leaves nothing either.
    escaped = sh(backend, key, '( sleep 2; touch /workspace/late ) & kill -9 $PPID', timeout_s=30)
    assert escaped.timed_out is False
    time.sleep(3)
    assert sh(backend, key, 'test -e /workspace/late; echo $?').stdout == '1\n'
    asyncio.run(backend.stop(key))


def test_cancelled_exec_kills_first(backend: KataDockerBackend, keys: Keys, client: docker.DockerClient) -> None:
    key = started(backend, keys)

    async def cancel_after(delay: float) -> float:
        task = asyncio.ensure_future(run(backend, key, 'sleep 300 & sleep 300', timeout_s=300))
        await asyncio.sleep(delay)
        t = time.monotonic()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return time.monotonic() - t

    took = asyncio.run(cancel_after(1.0))
    assert took < 5
    assert uid_1000_processes(client, key) == []
    assert sh(backend, key, 'echo ok').stdout == 'ok\n'
    asyncio.run(backend.stop(key))


def test_output_flood_is_capped(backend: KataDockerBackend, keys: Keys) -> None:
    key = started(backend, keys)
    result = sh(backend, key, "head -c 10000000 /dev/zero | tr '\\0' x; head -c 10000000 /dev/zero | tr '\\0' y >&2")
    assert result.truncated is True
    for stream, char in ((result.stdout, 'x'), (result.stderr, 'y')):
        assert stream.count(char) == 20_000
        assert '[... 9980000 characters truncated ...]' in stream
    asyncio.run(backend.stop(key))


def test_memory_oom_inside_the_guest(backend: KataDockerBackend, keys: Keys) -> None:
    key = started(backend, keys)
    hog = 'python3 -c "x = []\nwhile True: x.append(bytearray(256 * 1024 * 1024))"'
    result = sh(backend, key, hog, timeout_s=60)
    assert result.returncode == 137, (result.returncode, result.stderr[-500:])
    assert result.timed_out is False
    assert sh(backend, key, 'echo alive').stdout == 'alive\n'
    asyncio.run(backend.stop(key))


def test_fork_bomb_is_contained(backend: KataDockerBackend, keys: Keys, client: docker.DockerClient) -> None:
    key = started(backend, keys)
    peak = 0

    async def bomb() -> object:
        nonlocal peak
        # The main shell spins without forking, so the bomb runs for a few seconds before the call ends.
        command = 'b() { b | b & }; b; SECONDS=0; while (( SECONDS < 6 )); do :; done'
        task = asyncio.ensure_future(run(backend, key, command, timeout_s=20))
        while not task.done():
            await asyncio.sleep(0.5)
            try:
                counted = await asyncio.to_thread(root, client, key, 'ps -u 1000 -o pid= | wc -l')
                peak = max(peak, int(counted.strip() or 0))
            except (docker.errors.APIError, ValueError):
                pass
        try:
            return task.result()
        except SandboxNotRunning as e:
            return e

    outcome = asyncio.run(bomb())
    print(f'fork bomb: peak {peak} UID 1000 processes, call ended with {type(outcome).__name__}')
    assert 0 < peak <= 512 + 2
    # At the nproc limit the kill cannot start, so the backend fails closed: it stopped the sandbox.
    if isinstance(outcome, SandboxNotRunning):
        assert not [i for i in asyncio.run(backend.list_sandboxes()) if i.chat_id == key and i.running]
        asyncio.run(backend.create(key, SandboxSpec(key, 'data')))
    assert uid_1000_processes(client, key) == []
    assert sh(backend, key, 'echo fine').stdout == 'fine\n'
    asyncio.run(backend.stop(key))


def test_pid_1_survives_and_reaps(backend: KataDockerBackend, keys: Keys, client: docker.DockerClient) -> None:
    """Q16 on the real data image: hundreds of calls that each leave background children keep the count flat."""
    key = started(backend, keys)
    baseline = root(client, key, 'ps -e -o pid= | wc -l').strip()

    async def many() -> None:
        for i in range(300):
            command = 'sleep 300 & sleep 300 & echo held' if i % 2 else 'sleep 300 >/dev/null 2>&1 & echo free'
            result = await run(backend, key, command, timeout_s=30)
            assert result.returncode == 0 and result.timed_out is False

    asyncio.run(many())
    assert uid_1000_processes(client, key) == []
    assert zombies(client, key) == []
    assert root(client, key, 'ps -e -o pid= | wc -l').strip() == baseline
    assert client.containers.get(container_name(key)).status == 'running'
    asyncio.run(backend.stop(key))


def test_path_confinement_against_a_real_symlink(backend: KataDockerBackend, keys: Keys) -> None:
    key = keys.new(backend)

    class Chats:
        async def usable(self, chat_id: str, user: Any) -> bool:
            return chat_id == key

        async def updated_at(self, chat_ids: list[str]) -> dict[str, int]:
            return {c: int(time.time()) for c in chat_ids}

    async def settings() -> SandboxSettings:
        return SandboxSettings()

    manager = SandboxManager(backend, settings=settings, workspaces=MemoryWorkspaces(), chats=Chats())
    user = SimpleNamespace(id='kata-test-user', role='user')

    async def check() -> None:
        async with manager.session(key, user) as session:
            await session.exec(wrap_command('ln -s /etc /workspace/e && echo hi > /workspace/ok.txt', 10), 10)
            with pytest.raises(workspace.WorkspaceError):
                await workspace.view(session, 'e/passwd')
            with pytest.raises(workspace.WorkspaceError):
                await workspace.view(session, '../etc/passwd')
            page = await workspace.view(session, 'ok.txt')
            assert isinstance(page, dict) and 'hi' in page['content']
        await manager.shutdown(stop_running=True)

    asyncio.run(check())


def test_restart_sweep(backend: KataDockerBackend, keys: Keys) -> None:
    saved = started(backend, keys)
    ephemeral = keys.new(backend)
    asyncio.run(backend.create(ephemeral, SandboxSpec(ephemeral, 'data', ephemeral=True)))

    async def settings() -> SandboxSettings:
        return SandboxSettings()

    class Chats:
        async def usable(self, chat_id: str, user: Any) -> bool:
            return False

        async def updated_at(self, chat_ids: list[str]) -> dict[str, int]:
            return {c: int(time.time()) for c in chat_ids}

    # A new process's manager: everything it lists belongs to the previous one.
    asyncio.run(
        SandboxManager(backend, settings=settings, workspaces=MemoryWorkspaces(), chats=Chats()).startup_sweep()
    )
    infos = {i.chat_id: i for i in asyncio.run(backend.list_sandboxes())}
    assert saved in infos and infos[saved].running is False
    assert ephemeral not in infos


def test_fixed_size_volume(small_backend: KataDockerBackend, keys: Keys, client: docker.DockerClient) -> None:
    key = started(small_backend, keys)
    image = small_backend._image_path(key)
    fill = sh(small_backend, key, 'head -c 200000000 /dev/zero > /workspace/fill; echo rc=$?', timeout_s=60)
    assert 'No space left on device' in fill.stderr
    assert image.stat().st_size == 64 * 1024 * 1024
    assert image.stat().st_blocks * 512 <= 64 * 1024 * 1024
    asyncio.run(small_backend.stop(key))
    asyncio.run(small_backend.create(key, SandboxSpec(key, 'data')))
    assert sh(small_backend, key, 'test -s /workspace/fill && echo kept').stdout == 'kept\n'
    asyncio.run(small_backend.destroy(key))
    with pytest.raises(docker.errors.NotFound):
        client.volumes.get(volume_name(key))
    assert not image.exists()
    assert small_backend._loop_of(image) is None


# Security review fixes and guest seccomp (owner decision Q19), 2026-11-11.

# T14's security review's proof of concept (B1): a UID 1000 survivor that attaches to every new UID 1000 process
# and turns its kill(-1, SIGKILL) into exit_group(0), so the kill exec reports success with the survivor alive.
SURVIVOR = r"""
import ctypes, os
libc = ctypes.CDLL(None, use_errno=True)
libc.ptrace.argtypes = [ctypes.c_long, ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p]
libc.ptrace.restype = ctypes.c_long
SEIZE, INTERRUPT, SYSCALL, GETREGS, SETREGS, DETACH = 0x4206, 0x4207, 24, 12, 13, 17
class Regs(ctypes.Structure):
    _fields_ = [(n, ctypes.c_ulonglong) for n in
                ('r15 r14 r13 r12 rbp rbx r11 r10 r9 r8 rax rcx rdx rsi rdi orig_rax rip cs eflags rsp ss '
                 'fs_base gs_base ds es fs gs').split()]
WALL = 0x40000000
seen = set(os.listdir('/proc'))
while True:
    for p in os.listdir('/proc'):
        if not p.isdigit() or p in seen:
            continue
        pid = int(p)
        if libc.ptrace(SEIZE, pid, None, None) != 0:
            if not os.path.exists('/proc/' + p):
                seen.add(p)
            continue
        seen.add(p)
        libc.ptrace(INTERRUPT, pid, None, None)
        try:
            os.waitpid(pid, WALL)
            regs = Regs()
            while True:
                if libc.ptrace(SYSCALL, pid, None, None) != 0:
                    break
                _, status = os.waitpid(pid, WALL)
                if os.WIFEXITED(status) or os.WIFSIGNALED(status):
                    break
                libc.ptrace(GETREGS, pid, None, ctypes.byref(regs))
                if regs.orig_rax == 62 and regs.rdi & 0xffffffff == 0xffffffff and regs.rax == 2**64 - 38:
                    regs.orig_rax, regs.rdi = 231, 0
                    libc.ptrace(SETREGS, pid, None, ctypes.byref(regs))
                    libc.ptrace(DETACH, pid, None, None)
                    break
        except ChildProcessError:
            pass
"""


def test_a_survivor_that_traces_the_kill_cannot_fake_its_end(
    backend: KataDockerBackend, keys: Keys, client: docker.DockerClient
) -> None:
    """Security B1: the verdict runs as nobody, so the call fails closed (sandbox stopped) or nothing is left."""
    key = started(backend, keys)
    command = f'setsid python3 -c {shq(SURVIVOR)} </dev/null >/dev/null 2>&1 & echo started'
    try:
        result = sh(backend, key, command, timeout_s=30)
    except SandboxNotRunning:
        outcome = 'stopped'
        assert not [i for i in asyncio.run(backend.list_sandboxes()) if i.chat_id == key and i.running]
    else:
        outcome = 'killed'
        assert result.stdout == 'started\n'
        assert uid_1000_processes(client, key) == []
        asyncio.run(backend.stop(key))
    print(f'survivor: the call ended with the sandbox {outcome}')


def test_guest_seccomp_is_on(backend: KataDockerBackend, keys: Keys) -> None:
    """Q19: Kata's guest seccomp applies Docker's default profile: user namespaces refused; ptrace is still allowed
    by that profile, which is why the kill's verdict runs as another user."""
    key = started(backend, keys)
    probe = (
        'grep -E "^Seccomp:" /proc/self/status; unshare -U -r true 2>/dev/null && echo userns=allowed || echo '
        'userns=refused; sleep 30 & v=$!; python3 -c "import ctypes,os,sys; l=ctypes.CDLL(None,use_errno=True); '
        "r=l.ptrace(16,int(sys.argv[1]),None,None); print('ptrace=allowed' if r==0 else 'ptrace=refused'); "
        'r==0 and (os.waitpid(int(sys.argv[1]),0), l.ptrace(17,int(sys.argv[1]),None,None))" $v; kill $v'
    )
    result = sh(backend, key, probe)
    assert 'Seccomp:\t2' in result.stdout
    assert 'userns=refused' in result.stdout
    print('under guest seccomp:', ' '.join(line for line in result.stdout.split() if '=' in line))
    asyncio.run(backend.stop(key))


WHEEL = r"""
import base64, hashlib, os, zipfile
name = 't14probe-1.0'
files = {
    't14probe/__init__.py': b'X = 42\n',
    f'{name}.dist-info/METADATA': b'Metadata-Version: 2.1\nName: t14probe\nVersion: 1.0\n',
    f'{name}.dist-info/WHEEL': b'Wheel-Version: 1.0\nGenerator: t14\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
}
digest = lambda d: base64.urlsafe_b64encode(hashlib.sha256(d).digest()).rstrip(b'=').decode()
record = ''.join(f'{p},sha256={digest(d)},{len(d)}\n' for p, d in files.items()) + f'{name}.dist-info/RECORD,,\n'
os.makedirs('/workspace/wh', exist_ok=True)
with zipfile.ZipFile('/workspace/wh/t14probe-1.0-py3-none-any.whl', 'w') as z:
    for p, d in files.items():
        z.writestr(p, d)
    z.writestr(f'{name}.dist-info/RECORD', record)
"""

TEX = r"""\documentclass{article}
\usepackage[backend=biber]{biblatex}
\addbibresource{refs.bib}
\begin{document}
Cited \cite{k}.
\printbibliography
\end{document}
"""


def test_what_the_data_image_offers_works_under_seccomp(backend: KataDockerBackend, keys: Keys) -> None:
    """Q19: an offline pip install --user that imports in the next call, R, and a latexmk + biber build."""
    key = started(backend, keys)
    userbase = 'PYTHONUSERBASE=/workspace/.local'
    built = sh(
        backend,
        key,
        f'python3 -c {shq(WHEEL)} && {userbase} pip install --user --no-index '
        '--find-links /workspace/wh t14probe 2>&1 | tail -1',
        timeout_s=120,
    )
    assert 'Successfully installed t14probe-1.0' in built.stdout, built
    assert sh(backend, key, f'{userbase} python3 -c "import t14probe; print(t14probe.X)"').stdout == '42\n'
    r = sh(backend, key, 'Rscript -e "suppressMessages(library(dplyr)); cat(nrow(mtcars))"', timeout_s=120)
    assert r.stdout == '32', r
    files = f'mkdir -p /workspace/tex && cd /workspace/tex && printf %s {shq(TEX)} > main.tex && '
    files += "printf '%s' '@book{k,author={A},title={T},year={2020},publisher={P}}' > refs.bib"
    assert sh(backend, key, files).returncode == 0
    tex = sh(
        backend,
        key,
        'cd /workspace/tex && latexmk -pdf -interaction=nonstopmode main.tex >/dev/null 2>&1; '
        'echo rc=$?; test -s main.pdf && test -s main.bbl && echo built',
        timeout_s=280,
    )
    assert 'rc=0' in tex.stdout and 'built' in tex.stdout, tex
    asyncio.run(backend.stop(key))


SHOT = r"""
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('file:///workspace/page.html');
await page.screenshot({ path: '/workspace/outputs/shot.png' });
await browser.close();
console.log('shot');
"""


def test_a_playwright_screenshot_works_under_seccomp(backend: KataDockerBackend, keys: Keys) -> None:
    """Q19: headless Chromium with Playwright's defaults (chromiumSandbox false: its own sandbox needs the user
    namespaces seccomp refuses; the VM and seccomp are the boundary)."""
    key = started(backend, keys, 'web')
    setup = "mkdir -p /workspace/outputs && echo '<h1>hi</h1>' > /workspace/page.html"
    setup += f' && printf %s {shq(SHOT)} > /workspace/shot.mjs'
    assert sh(backend, key, setup).returncode == 0
    shot = sh(backend, key, 'cd /workspace && node shot.mjs && file -b outputs/shot.png', timeout_s=120)
    assert shot.returncode == 0 and shot.stdout.startswith('shot\nPNG image data'), shot
    asyncio.run(backend.stop(key))


MD_SUPERBLOCKS = r"""
import struct, sys, uuid
dev_bytes, out, n_blocks = int(sys.argv[1]), sys.argv[2], int(sys.argv[3])
off = (((dev_bytes // 512) - 16) & ~7) * 512
sb = bytearray(258)
struct.pack_into('<IIII', sb, 0, 0xa92b4efc, 1, 0, 0)
sb[16:32] = uuid.uuid4().bytes
struct.pack_into('<I', sb, 72, 1)
struct.pack_into('<I', sb, 92, 2)
struct.pack_into('<Q', sb, 144, off // 512)
struct.pack_into('<I', sb, 220, 1)
def csum(b):
    b = bytearray(b); struct.pack_into('<I', b, 216, 0)
    s = sum(struct.unpack_from('<I', b, i)[0] for i in range(0, len(b) - len(b) % 4, 4))
    if len(b) % 4 == 2: s += struct.unpack_from('<H', b, len(b) - 2)[0]
    return ((s & 0xffffffff) + (s >> 32)) & 0xffffffff
struct.pack_into('<I', sb, 216, csum(sb))
with open(out, 'wb') as f:
    for _ in range(n_blocks):
        f.write(bytes(sb) + bytes(4096 - len(sb)))
"""


def test_workspace_data_cannot_change_how_the_host_identifies_the_device(tmp_path: Path) -> None:
    """Security S1: a file filling the workspace with md superblocks leaves blkid seeing ext4 with the key, since the
    filesystem stops TAIL_GAP_BYTES short of the end (no attach, no root: mkfs, debugfs and blkid on the file)."""
    size = 64 * 1024 * 1024
    backend = KataDockerBackend(tmp_path / 'v', workspace_bytes=size)
    key = str(uuid.uuid4())
    image = backend._image_path(key)
    backend._make_image(image, key)
    payload = tmp_path / 'md.bin'
    blocks = (size - TAIL_GAP_BYTES) // 4096 - 2048
    subprocess.run(['python3', '-c', MD_SUPERBLOCKS, str(size), str(payload), str(blocks)], check=True)
    subprocess.run(['debugfs', '-w', '-R', f'write {payload} fill', str(image)], check=True, capture_output=True)
    used = subprocess.run(['debugfs', '-R', 'stat fill', str(image)], capture_output=True, text=True).stdout
    assert 'Size: ' in used
    probe = subprocess.run(['blkid', '-p', '-o', 'export', str(image)], capture_output=True, text=True)
    assert 'TYPE=ext4' in probe.stdout and f'UUID={key}' in probe.stdout, probe.stdout


def test_uploads_are_a_read_only_mount_put_uploads_fills(
    backend: KataDockerBackend, keys: Keys, client: docker.DockerClient
) -> None:
    """The uploads mount (T13's security review): read-only in the guest itself, not only by Docker's flag; filled by
    put_uploads (add, replace, remove), seen at once by the next command; kept across a stop; gone with destroy."""
    key = started(backend, keys)
    uploads = backend._uploads_path(key)
    asyncio.run(backend.put_uploads(key, [('a.txt', b'alpha\n'), ('b.csv', b'1,2\n')]))
    mount = sh(
        backend,
        key,
        'findmnt -no FSTYPE,OPTIONS /workspace/uploads; ls /workspace/uploads; cat /workspace/uploads/a.txt',
    )
    assert mount.stdout.split('\n')[0].split()[0] == 'virtiofs' and 'ro' in mount.stdout.split('\n')[0].split()[
        1
    ].split(',')
    assert mount.stdout.endswith('a.txt\nb.csv\nalpha\n')
    attempts = {
        'append': 'echo x >> /workspace/uploads/a.txt',
        'chmod': 'chmod 666 /workspace/uploads/a.txt',
        'unlink': 'rm -f /workspace/uploads/a.txt',
        'create': 'touch /workspace/uploads/new',
        'mkdir': 'mkdir /workspace/uploads/d',
        'symlink': 'ln -s /etc /workspace/uploads/e',
        'rename the directory': 'mv /workspace/uploads /workspace/moved',
        'remove the directory': 'rmdir /workspace/uploads',
        'rename a file': 'mv /workspace/uploads/a.txt /workspace/uploads/z',
    }
    for what, command in attempts.items():
        result = sh(backend, key, command)
        assert result.returncode != 0, what
        assert any(
            e in result.stderr for e in ('Read-only file system', 'Device or resource busy', 'Permission denied')
        ), (
            what,
            result.stderr,
        )
    as_root = root(
        client, key, 'echo x >> /workspace/uploads/a.txt; mount -o remount,rw /workspace/uploads; echo rc=$?'
    )
    assert 'rc=0' not in as_root
    # Replace one, remove one, add one: the very next command sees exactly the new set.
    asyncio.run(backend.put_uploads(key, [('a.txt', b'beta\n'), ('c.txt', b'see\n')]))
    seen = sh(backend, key, 'ls /workspace/uploads; cat /workspace/uploads/a.txt /workspace/uploads/c.txt')
    assert seen.stdout == 'a.txt\nc.txt\nbeta\nsee\n', seen
    # A stop empties the host directory (every start puts the uploads again), so none sit outside the volume's cap.
    asyncio.run(backend.stop(key))
    assert uploads.is_dir() and list(uploads.iterdir()) == []
    asyncio.run(backend.create(key, SandboxSpec(key, 'data')))
    assert sh(backend, key, 'ls -A /workspace/uploads | wc -l').stdout == '0\n'
    asyncio.run(backend.put_uploads(key, [('a.txt', b'gamma\n')]))
    assert sh(backend, key, 'cat /workspace/uploads/a.txt').stdout == 'gamma\n'
    asyncio.run(backend.destroy(key))
    assert not uploads.exists()


def test_the_fence_holds_over_ipv6(backend: KataDockerBackend, keys: Keys) -> None:
    """T16's security review, B1: a listener on `::` was reachable through the bridge's link-local address. The guest
    has no IPv6 at all (the IPv6-off sysctls), so it reaches neither that nor one on 0.0.0.0, and the mirror's
    hosts entry still works."""
    listeners = [socket.create_server(('::', 0), family=socket.AF_INET6, dualstack_ipv6=True)]
    port = listeners[0].getsockname()[1]
    stop = threading.Event()

    def accept(listener: socket.socket) -> None:
        listener.settimeout(0.2)
        while not stop.is_set():
            try:
                conn, _ = listener.accept()
                conn.close()
            except TimeoutError:
                continue

    threads = [threading.Thread(target=accept, args=(listener,), daemon=True) for listener in listeners]
    for thread in threads:
        thread.start()
    shown = subprocess.run(['ip', '-6', '-o', 'addr', 'show', 'dev', BRIDGE_NAME], capture_output=True, text=True)
    # The host side (Q20, T16): no IPv6 address at all on the sandbox bridge.
    assert shown.returncode == 0 and shown.stdout.strip() == '', shown.stdout
    link_local = [line.split()[3].split('/')[0] for line in shown.stdout.splitlines() if ' fe80::' in line]
    prefix = SANDBOX_SUBNET.rsplit('.', 1)[0]
    ipv4 = [f'{prefix}.1', f'{prefix}.128', host_address()]
    script = (
        'import os, socket, sys\n'
        'p = "/proc/net/if_inet6"\n'
        'print("if_inet6", repr(open(p).read()) if os.path.exists(p) else "none")\n'
        'print("ipv6 sysctl", open("/proc/sys/net/ipv6/conf/all/disable_ipv6").read().strip())\n'
        'for host in sys.argv[2:]:\n'
        '    try:\n'
        '        if ":" in host:\n'
        '            s = socket.socket(socket.AF_INET6); s.settimeout(2)\n'
        '            s.connect((host + "%eth0", int(sys.argv[1]), 0, 0))\n'
        '        else:\n'
        '            s = socket.socket(); s.settimeout(2); s.connect((host, int(sys.argv[1])))\n'
        '        print("OPEN", host)\n'
        '    except OSError as e:\n'
        '        print("closed", host, e)\n'
    )
    try:
        key = started(backend, keys)
        targets = [*link_local, 'fe80::1', '::1', *ipv4]
        result = sh(backend, key, f'python3 -c {shq(script)} {port} ' + ' '.join(targets), timeout_s=60)
    finally:
        stop.set()
        for thread in threads:
            thread.join()
        for listener in listeners:
            listener.close()
    assert result.returncode == 0, result.stderr
    assert "if_inet6 ''" in result.stdout or 'if_inet6 none' in result.stdout, result.stdout
    assert 'ipv6 sysctl 1' in result.stdout
    assert 'OPEN' not in result.stdout, result.stdout
    print(f'ipv6 fence: bridge link-local {link_local or "none"}; guest: {result.stdout.splitlines()[0]}')
    asyncio.run(backend.stop(key))


def test_the_mirror_installs_an_allowlisted_package(backend: KataDockerBackend, keys: Keys) -> None:
    """T16's "Mirror installs" through the real fence: polars from sandbox-mirror, importable in the next call; an
    unlisted package finds no distribution. Needs the mirror running and `make wheelhouse` done."""
    key = started(backend, keys)
    # The flags the images' pip environment sets from T16's tag on (plain HTTP, so the mirror must be trusted).
    pip = (
        'PYTHONUSERBASE=/workspace/.local pip install --user --no-index --find-links http://sandbox-mirror:8000/ '
        '--trusted-host sandbox-mirror'
    )
    got = sh(backend, key, f'{pip} polars 2>&1 | tail -1', timeout_s=180)
    assert 'Successfully installed' in got.stdout and 'polars' in got.stdout, got
    used = sh(
        backend,
        key,
        'PYTHONUSERBASE=/workspace/.local python3 -c "import polars; print(polars.DataFrame({\'a\': [1, 2]}).shape)"',
    )
    assert used.stdout == '(2, 1)\n', used
    missing = sh(backend, key, f'{pip} requests-toolbelt-not-allowlisted 2>&1 | tail -2', timeout_s=60)
    assert 'No matching distribution' in missing.stdout, missing
    asyncio.run(backend.stop(key))


@pytest.mark.parametrize('planted', ['symlink to /tmp', 'symlink to /etc', 'file'])
def test_a_planted_uploads_entry_never_moves_the_mount(backend: KataDockerBackend, keys: Keys, planted: str) -> None:
    """T13's security re-review, N-c: a workspace used before the uploads mount can hold a symlink or file named
    `uploads` (planted here with debugfs on the stopped image). Unfixed, the guest mounted the uploads where the
    symlink pointed, or the create failed; the create now removes it, and the mount is at /workspace/uploads."""
    key = started(backend, keys)
    asyncio.run(backend.stop(key))
    image = backend._image_path(key)
    target = '/tmp' if 'tmp' in planted else '/etc'
    plant = [f'symlink uploads {target}'] if 'symlink' in planted else ['write /etc/hostname uploads']
    for request in ['rmdir uploads', *plant]:
        subprocess.run(['debugfs', '-w', '-R', request, str(image)], check=True, capture_output=True)
    asyncio.run(backend.create(key, SandboxSpec(key, 'data')))
    asyncio.run(backend.put_uploads(key, [('a.txt', b'alpha\n')]))
    seen = sh(
        backend,
        key,
        f'findmnt -no TARGET,OPTIONS /workspace/uploads; test -e {target}/a.txt && echo misplaced; '
        'cat /workspace/uploads/a.txt',
    )
    first = seen.stdout.splitlines()[0].split()
    assert first[0] == '/workspace/uploads' and 'ro' in first[1].split(','), seen
    assert 'misplaced' not in seen.stdout and seen.stdout.endswith('alpha\n'), seen
    asyncio.run(backend.stop(key))


# T14's security re-review's proof of concept (B1 again): a UID 1000 process that keeps changing its PID (fork, the
# parent exits) so a /proc snapshot never lists it, and hijacks each UID 1000 kill as the first one did.
HOPPING_SURVIVOR = r"""
# Runs as UID 1000. Changes PID continuously (fork, parent exits), so a nobody-run /proc snapshot scan misses it,
# and between hops hijacks any new UID 1000 process that calls kill(-1, SIGKILL), turning it into exit_group(0).
import ctypes, os
libc = ctypes.CDLL(None, use_errno=True)
libc.ptrace.argtypes = [ctypes.c_long, ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p]
libc.ptrace.restype = ctypes.c_long
SEIZE, INTERRUPT, SYSCALL, GETREGS, SETREGS, DETACH = 0x4206, 0x4207, 24, 12, 13, 17
WALL = 0x40000000
class Regs(ctypes.Structure):
    _fields_ = [(n, ctypes.c_ulonglong) for n in
                ('r15 r14 r13 r12 rbp rbx r11 r10 r9 r8 rax rcx rdx rsi rdi orig_rax rip cs eflags rsp ss '
                 'fs_base gs_base ds es fs gs').split()]

def uid_of(p):
    try:
        for line in open(f'/proc/{p}/status'):
            if line.startswith('Uid:'):
                return int(line.split()[1])
    except OSError:
        return None

def hijack(pid):
    regs = Regs()
    libc.ptrace(INTERRUPT, pid, None, None)
    try:
        os.waitpid(pid, WALL)
        while libc.ptrace(SYSCALL, pid, None, None) == 0:
            _, status = os.waitpid(pid, WALL)
            if os.WIFEXITED(status) or os.WIFSIGNALED(status):
                return
            libc.ptrace(GETREGS, pid, None, ctypes.byref(regs))
            if regs.orig_rax == 62 and regs.rdi & 0xffffffff == 0xffffffff and regs.rax == 2**64 - 38:
                regs.orig_rax, regs.rdi = 231, 0
                libc.ptrace(SETREGS, pid, None, ctypes.byref(regs))
                libc.ptrace(DETACH, pid, None, None)
                return
    except ChildProcessError:
        pass

os.setsid()
seen = set(os.listdir('/proc'))
while True:
    if os.fork():
        os._exit(0)
    seen.add(str(os.getpid()))
    for p in os.listdir('/proc'):
        if not p.isdigit() or p in seen:
            continue
        u = uid_of(p)
        if u is None or u == 65534:
            seen.add(p)
            continue
        if u != 1000:
            continue  # the agent's child before it switches to UID 1000: look again next hop
        if libc.ptrace(SEIZE, int(p), None, None) == 0:
            seen.add(p)
            hijack(int(p))
"""


def test_a_pid_hopping_survivor_is_ended_or_fails_the_call_closed(
    backend: KataDockerBackend, keys: Keys, client: docker.DockerClient
) -> None:
    """Security re-review B1, the full attack through a call: the call fails closed (sandbox stopped), or the kill
    ended the survivor and nothing of UID 1000 is left. (On the laptop the kill wins: 5 of 5 probes.)"""
    key = started(backend, keys)
    command = f'python3 -c {shq(HOPPING_SURVIVOR)} </dev/null >/dev/null 2>&1 & echo started'
    try:
        sh(backend, key, command, timeout_s=30)
    except SandboxNotRunning:
        with pytest.raises(docker.errors.NotFound):
            client.containers.get(container_name(key))
        outcome = 'stopped'
    else:
        assert uid_1000_processes(client, key) == []
        outcome = 'ended'
        asyncio.run(backend.stop(key))
    print(f'hopping survivor: {outcome}')


HOPPER = """
import os
while True:
    if os.fork():
        os._exit(0)
"""


def test_the_verdict_sees_a_process_that_keeps_changing_its_pid(
    backend: KataDockerBackend, keys: Keys, client: docker.DockerClient
) -> None:
    """Security re-review B1: with a UID 1000 process hopping PIDs (fork, parent exits), a /proc snapshot never
    lists it; the verdict, as nobody, still exits 1, since no pass is quiet. Without the hopper it exits 0."""
    key = started(backend, keys)
    container = client.containers.get(container_name(key))
    argv = ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', '/bin/bash', '--noprofile', '--norc', '-c', VERIFY_SCRIPT]
    assert container.exec_run(argv, user='65534:65534').exit_code == 0
    container.exec_run(['python3', '-c', HOPPER], user='1000:1000', detach=True)
    time.sleep(1)
    verdicts = [container.exec_run(argv, user='65534:65534').exit_code for _ in range(3)]
    assert verdicts == [1, 1, 1]
    asyncio.run(backend.stop(key))


def test_the_guard_refuses_a_guest_with_ipv6(
    backend: KataDockerBackend, keys: Keys, client: docker.DockerClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """G1, on the real thing: a guest started without the IPv6-off sysctls has IPv6 addresses (at least ::1), the
    guard (as nobody, reading /proc/net/if_inet6) fails, and create refuses with its reason, the container removed."""
    monkeypatch.setattr(kata, 'IPV6_OFF', {})
    key = keys.new(backend)
    with pytest.raises(SandboxUnavailable, match='^The sandbox cannot run: the guest has an IPv6 address$'):
        asyncio.run(backend.create(key, SandboxSpec(key, 'data')))
    with pytest.raises(docker.errors.NotFound):
        client.containers.get(container_name(key))


# Listing a workspace without its sandbox (T24).

WORKSPACE_FILES = (
    'mkdir -p a/b && printf hello > a/b/x.txt && head -c 3000 /dev/zero > big.bin'
    ' && ln -s /etc/passwd link && mkfifo pipe && mkdir -m 000 shut'
)


def _listed(listing: Any) -> dict[str, int]:
    return {e.path: e.size for e in listing.entries}


def test_list_workspace_lists_a_stopped_volume_through_the_helper(
    backend: KataDockerBackend, keys: Keys, client: docker.DockerClient
) -> None:
    """The keep-or-remove dialog's listing on the real thing: regular files only (no symlink, no FIFO followed or
    listed), sizes from the volume, an unreadable directory marking it incomplete, and no helper left behind."""
    key = started(backend, keys)
    result = sh(backend, key, WORKSPACE_FILES)
    assert result.returncode == 0, result.stderr
    asyncio.run(backend.stop(key))
    listing = asyncio.run(backend.list_workspace(key, 300))
    assert listing is not None
    files = _listed(listing)
    assert files['a/b/x.txt'] == 5 and files['big.bin'] == 3000
    assert not {'link', 'pipe'} & files.keys()
    assert listing.files >= 2 and listing.bytes >= 3005
    assert listing.complete is False
    assert client.containers.list(all=True, filters={'name': list_helper_name(key)}) == []
    # The stopped sandbox starts again on its volume afterwards: the helper held nothing.
    asyncio.run(backend.create(key, SandboxSpec(key, 'data')))
    assert sh(backend, key, 'cat a/b/x.txt').stdout == 'hello'
    asyncio.run(backend.stop(key))


def test_list_workspace_lists_a_running_sandbox_read_only_beside_it(
    backend: KataDockerBackend, keys: Keys, client: docker.DockerClient
) -> None:
    """The reviewer's open question: listing while the sandbox runs, its volume mounted read-write in the VM and
    read-only in the helper's. The listing sees what the running sandbox wrote, and the sandbox keeps writing."""
    key = started(backend, keys)
    assert sh(backend, key, 'printf abc > seen.txt').returncode == 0
    listing = asyncio.run(backend.list_workspace(key, 300))
    assert listing is not None
    assert _listed(listing).get('seen.txt') == 3
    # Nothing here is unreadable, so the stopped-volume test's `complete is False` comes from its `shut` directory.
    assert listing.complete is True
    assert client.containers.list(all=True, filters={'name': list_helper_name(key)}) == []
    after = sh(backend, key, 'printf more >> seen.txt && cat seen.txt')
    assert (after.returncode, after.stdout) == (0, 'abcmore')
    asyncio.run(backend.stop(key))
