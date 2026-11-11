"""The sandbox backend that runs each chat in its own Kata Containers microVM, through the Docker daemon.

Every Docker SDK call runs in a thread (asyncio.to_thread), and every
error from the SDK, the daemon or a host tool is raised as a SandboxError
with fixed wording: the SDK's own text carries the daemon URL and host
paths, which must not reach the model (T12's security review, S4). The
original is logged.

What a sandbox is. A container named `lllm-sandbox-<key>` under the
`kata-clh` runtime, created with the fixed options in `container_options`
and nothing a caller chose beyond the image key and the manager's UUID,
which is validated again here before it goes into a name, a label or a
volume. Its PID 1 is Docker's init (tini) running `sleep infinity` as
`nobody` (owner decision Q16), and every command runs as UID 1000, which
can signal neither, so the kill after each call (Q10) leaves PID 1 up to
reap what it killed. The image's own entrypoint is replaced, so only one
init runs.

The workspace. `/workspace` is the named volume `lllm-sandbox-<key>`, a
fixed-size ext4 filesystem (owner decision Q11): a sparse image file of
WORKSPACE_SIZE under the backend's volume directory, formatted with the
key as its filesystem UUID and UID 1000 as the owner of its root, attached
to a loop device with udisks (`udisksctl loop-setup`, which polkit allows
for the user of an active local session without root), and mounted by
Docker's local volume driver from `/dev/disk/by-uuid/<key>`. Docker's
driver cannot attach a loop device itself (it calls mount(2), which has no
`loop` option), so the backend attaches the image before every create and
detaches it when the volume is destroyed. A runaway write then fills the
workspace, not the host's disk.

Commands. `exec` streams both outputs into StreamCaps from a raw socket
(`exec_start(socket=True)`, 8-byte frame headers), so a command with
stdin and a command without one take the same path. It must not wait for
the stream to end: a background child that inherited the command's stdout
holds it open, and under Kata the daemon then reports the exec running
until that child exits too. So once the command has run POLLER_AFTER_S,
a second exec, run as `nobody` so the command cannot kill it, watches
/proc until the command's main process (the UID 1000 process whose parent
is outside the guest's PID namespace) is gone. Then the post-exec kill
ends every UID 1000 process, which closes the stream, and the output is
drained.
"""

import asyncio
import datetime as dt
import http.client
import io
import json
import logging
import os
import secrets
import shutil
import socket
import stat as stat_module
import struct
import subprocess
import tarfile
import threading
import time
import tomllib
from collections.abc import Awaitable, Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, Final

import docker
import docker.errors
import docker.types
import docker.utils
import requests
import urllib3.exceptions

from local_llm.sandbox.backend import (
    validate_create,
    validate_get_files,
    validate_put_files,
    validate_put_uploads,
    validate_sandbox_path,
)
from local_llm.sandbox.exec import StreamCap, require_wrapped, result_from
from local_llm.sandbox.limits import (
    CAP_DROP,
    HOST_DEADLINE_SLACK_S,
    KILL_GRACE_S,
    MEMORY_LIMIT,
    NANO_CPUS,
    NPROC_LIMIT,
    PIDS_LIMIT,
    READ_ONLY_ROOT,
    SANDBOX_UID,
    SANDBOX_USER,
    SECURITY_OPT,
    TMP_SIZE,
    WORKSPACE,
    WORKSPACE_SIZE,
)
from local_llm.sandbox.types import (
    ExecResult,
    FileStat,
    ImageKey,
    SandboxError,
    SandboxInfo,
    SandboxNotRunning,
    SandboxSpec,
    SandboxUnavailable,
    validate_chat_id,
    volume_name,
)

log = logging.getLogger(__name__)

#: The images' tag; infra/sandbox/TAG holds the same value, and a test checks they agree.
SANDBOX_IMAGE_TAG: Final = '2026-11-11.2'
#: The image each key runs.
IMAGES: Final[Mapping[ImageKey, str]] = MappingProxyType(
    {
        'data': f'local-llm/sandbox-data:{SANDBOX_IMAGE_TAG}',
        'web': f'local-llm/sandbox-web:{SANDBOX_IMAGE_TAG}',
    }
)
#: The Docker runtime every sandbox runs under (docs/guides/sandbox.md, "Host setup").
KATA_RUNTIME: Final = 'kata-clh'
#: The internal network every sandbox joins; Compose names its `sandbox` network so (T16).
SANDBOX_NETWORK: Final = 'local-llm_sandbox'
#: The sandbox network's fixed subnet; Compose (T16) gives the network the same.
SANDBOX_SUBNET: Final = '10.231.0.0/24'
#: The part of the subnet Docker hands out to sandboxes, so the mirror's fixed address is never taken.
SANDBOX_IP_RANGE: Final = '10.231.0.128/25'
#: The `sandbox-mirror` container's fixed address, given to every sandbox as a hosts entry, since no container
#: name resolves inside a Kata guest (owner decision Q9). Compose (T16) fixes the same address.
SANDBOX_MIRROR_ADDRESS: Final = '10.231.0.2'
#: Where a sandbox's uploads appear: a read-only bind of the backend's per-key host directory (put_uploads).
UPLOADS: Final = f'{WORKSPACE}/uploads'
#: The pip mirror's container name (T16).
MIRROR_CONTAINER: Final = 'local-llm-sandbox-mirror'
#: The container's own user, PID 1 and its keep-alive: `nobody`, which UID 1000 cannot signal (owner decision Q16).
CONTAINER_USER: Final = '65534:65534'
#: The keep-alive PID 1 (Docker's init) runs, replacing the image's entrypoint.
KEEP_ALIVE: Final = ('/usr/bin/sleep', 'infinity')

#: Seconds a create may take (an image file made and formatted, a loop device attached, a VM booted).
CREATE_TIMEOUT_S: Final = 120.0
#: Seconds a stop may take.
STOP_TIMEOUT_S: Final = 60.0
#: Seconds a destroy may take.
DESTROY_TIMEOUT_S: Final = 60.0
#: Seconds the post-exec kill may take, every daemon call in it included, before the sandbox is stopped instead
#: (fail closed).
KILL_TIMEOUT_S: Final = 10.0
#: Seconds that fail-closed stop may take. With KILL_TIMEOUT_S and DRAIN_TIMEOUT_S it bounds a cancelled exec's
#: worst case to 25 s, inside the manager's CANCEL_WAIT_S.
KILL_STOP_TIMEOUT_S: Final = 10.0
#: Seconds put_files, get_files or stat may take in all.
FILES_TIMEOUT_S: Final = 120.0
#: The most bytes of the guest's listing the guest-view check reads; a longer one never matches, so it times out.
GUEST_VIEW_MAX_BYTES: Final = 65536
#: Seconds the guest may take to see files put_files wrote (virtio-fs caches attributes for a second).
GUEST_VIEW_WAIT_S: Final = 5.0
#: Seconds the output may take to end once the kill has run, before the stream is closed under it.
DRAIN_TIMEOUT_S: Final = 5.0
#: Seconds a finished command's exit status may take to show once its stream has closed.
EXIT_STATUS_WAIT_S: Final = 5.0
#: Seconds a command runs before the watcher exec starts; most commands finish sooner and never need one.
POLLER_AFTER_S: Final = 0.25
#: Seconds between polls of a running exec, growing from the first value to the second.
POLL_MIN_S: Final = 0.01
POLL_MAX_S: Final = 0.1
#: Seconds the Docker SDK waits for one HTTP answer.
API_TIMEOUT_S: Final = 60
#: Seconds a host tool (mkfs.ext4, debugfs, udisksctl) may take.
HOST_TOOL_TIMEOUT_S: Final = 60
#: Seconds to wait for udev to link a newly attached workspace under /dev/disk/by-uuid.
DEVICE_LINK_WAIT_S: Final = 10.0
#: Where the host tools are looked up: never the caller's PATH.
HOST_TOOL_PATH: Final = '/usr/sbin:/usr/bin:/sbin:/bin'

# How every backend-run guest command starts: no inherited environment, a fixed PATH, bash without startup files.
_GUEST_SHELL: Final = ('/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', '/bin/bash', '--noprofile', '--norc', '-c')

# Ends every UID 1000 process: one round of the post-exec kill, run as UID 1000, since only UID 1000 may signal
# UID 1000 (root in the guest has no CAP_KILL). kill(-1) skips the caller itself, and the signal is sent again on
# every pass, so a process forked meanwhile goes too; it stops early once /proc lists no other UID 1000 process.
# Its exit status means nothing: a surviving UID 1000 process can kill it, or ptrace it and make it exit 0 (T14's
# security review, B1). VERIFY_SCRIPT is the verdict.
KILL_SCRIPT: Final = f"""\
for ((pass = 0; pass < 20; pass++)); do
  kill -9 -1 2>/dev/null
  left=0
  for s in /proc/[0-9]*/status; do
    [ "$s" = /proc/$$/status ] && continue
    u=
    {{ while read -r k v rest; do [ "$k" = Uid: ] && {{ u=$v; break; }}; done < "$s"; }} 2>/dev/null
    if [ "$u" = {SANDBOX_UID} ]; then left=1; break; fi
  done
  [ $left = 0 ] && exit 0
  /usr/bin/sleep 0.05
done
"""

# The kill's verdict, run as `nobody`, which UID 1000 can neither trace nor signal: exits 0 once a pass over /proc
# finds no UID 1000 process (zombies included, so PID 1 has reaped them) AND no PID was allocated in the guest
# while it ran, 1 if no pass does within about two seconds. The kernel writes the `Uid:` lines it reads. The PID
# check (the last-allocated PID in /proc/loadavg, unchanged across the pass) is what makes a pass count against a
# process that keeps changing its PID (fork, parent exits): such a process can be in no listing the scan reads,
# but every hop allocates a PID (T14's security re-review, B1 again). So the pass itself forks nothing: bash
# builtins only between the two reads. `kill -0 -1` cannot tell instead: kill(2) with -1 succeeds whenever any
# process is visible, even one it may not signal, such as PID 1's keep-alive.
VERIFY_SCRIPT: Final = f"""\
for ((pass = 0; pass < 40; pass++)); do
  read -r _ _ _ _ before < /proc/loadavg
  left=0
  for s in /proc/[0-9]*/status; do
    u=
    {{ while read -r k v rest; do [ "$k" = Uid: ] && {{ u=$v; break; }}; done < "$s"; }} 2>/dev/null
    if [ "$u" = {SANDBOX_UID} ]; then left=1; break; fi
  done
  read -r _ _ _ _ after < /proc/loadavg
  [ $left = 0 ] && [ "$before" = "$after" ] && exit 0
  /usr/bin/sleep 0.05
done
exit 1
"""

# Run once in every new sandbox as `nobody`, before its first command: the guest must apply seccomp (Q19) and have no
# IPv6 address (T16's security review), whatever the host's configuration says. Exits 1 with what is wrong. The IPv6
# check reads a line: procfs files report size 0, so `test -s` cannot tell (T14's final re-review, G1); a missing
# file (IPv6 compiled out) fails the redirection, which is the no-IPv6 outcome.
GUARD_SCRIPT: Final = """\
s=
while read -r k v rest; do [ "$k" = Seccomp: ] && s=$v; done < /proc/self/status
[ "$s" = 2 ] || { echo 'no seccomp filter in the guest'; exit 1; }
! read -r _ < /proc/net/if_inet6 || { echo 'the guest has an IPv6 address'; exit 1; }
exit 0
"""

#: Kill rounds (a kill as UID 1000, then a verdict as nobody) the post-exec kill tries within KILL_TIMEOUT_S.
KILL_ROUNDS: Final = 3

# Waits until the command's main process is gone: the UID 1000 process whose parent is outside the guest's PID
# namespace (PPid 0), which only an exec's own process has; once it exits, its children have PID 1 as parent.
# A zombie counts as gone. It runs as `nobody`, so nothing UID 1000 starts can kill it. It may outlive the call by
# one 50 ms pass after the kill (bounded by its own `timeout` in any case), and takes no UID 1000 process with it.
POLL_SCRIPT: Final = f"""\
while :; do
  alive=0
  for s in /proc/[0-9]*/status; do
    u= pp= st=
    {{ while read -r k v rest; do
      case $k in State:) st=$v ;; PPid:) pp=$v ;; Uid:) u=$v; break ;; esac
    done < "$s"; }} 2>/dev/null
    if [ "$u" = {SANDBOX_UID} ] && [ "$pp" = 0 ] && [ "$st" != Z ]; then alive=1; break; fi
  done
  [ $alive = 0 ] && exit 0
  /usr/bin/sleep 0.05
done
"""

# Fixed texts: what an error says never comes from the SDK.
_NOT_RUNNING: Final = 'the sandbox is not running'
_KILL_FAILED: Final = (
    'the processes the command started could not be confirmed ended, so the sandbox was stopped; '
    'its files are kept, and the next call starts it again'
)
_DIED: Final = 'the sandbox stopped during the command'
_NO_DAEMON: Final = 'The Docker daemon does not answer'

# Go's os.FileMode bits, as the daemon's path stat reports them.
_GO_DIR: Final = 1 << 31
_GO_SYMLINK: Final = 1 << 27
_GO_DEVICE: Final = 1 << 26
_GO_PIPE: Final = 1 << 25
_GO_SOCKET: Final = 1 << 24
_GO_SETUID: Final = 1 << 23
_GO_SETGID: Final = 1 << 22
_GO_CHARDEV: Final = 1 << 21
_GO_STICKY: Final = 1 << 20
_GO_IRREGULAR: Final = 1 << 19
_GO_OTHER: Final = _GO_DEVICE | _GO_PIPE | _GO_SOCKET | _GO_CHARDEV | _GO_IRREGULAR

# The errors an SDK call, a daemon answer or a host tool can raise; each becomes a SandboxError with fixed text.
# urllib3's and http.client's own errors reach the backend when it reads a response body itself (the archive reads).
_BACKEND_ERRORS: Final = (
    docker.errors.DockerException,
    requests.exceptions.RequestException,
    urllib3.exceptions.HTTPError,
    http.client.HTTPException,
    OSError,
    subprocess.SubprocessError,
    tarfile.TarError,
    KeyError,
    TypeError,
    ValueError,
)

#: Where the kernel lists loop devices and their backing files, and where udev links filesystems by UUID.
SYS_BLOCK: Final = Path('/sys/block')
BY_UUID: Final = Path('/dev/disk/by-uuid')

_UNITS: Final = {'k': 1024, 'm': 1024**2, 'g': 1024**3}


def size_bytes(size: str) -> int:
    """`size` (a number and a `k`, `m` or `g` suffix, as Docker writes sizes) in bytes.

    Raises:
        ValueError: `size` is not a positive number with one of those suffixes.
    """
    number, unit = size[:-1], size[-1:].lower()
    if unit not in _UNITS or not number.isdigit() or int(number) <= 0:
        raise ValueError(f'size {size!r} is not a positive number with a k, m or g suffix')
    return int(number) * _UNITS[unit]


#: The workspace image's size in bytes.
WORKSPACE_BYTES: Final = size_bytes(WORKSPACE_SIZE)
#: Bytes at the end of each workspace image the filesystem never covers, so nothing the model writes lands where
#: blkid looks for RAID and other end-of-device signatures (md 0.90/1.0, DDF, IMSM, nilfs2's backup), which would
#: change how the host identifies the device (T14's security review, S1).
TAIL_GAP_BYTES: Final = 4 * 1024 * 1024
#: The ext4 block size of each workspace.
WORKSPACE_BLOCK_BYTES: Final = 4096
#: The smallest workspace image the backend makes.
MIN_WORKSPACE_BYTES: Final = 16 * 1024 * 1024
#: Threads reading or writing command streams: two per sandbox at the most running (16), and two to spare.
STREAM_THREADS: Final = 34


def container_name(key: str) -> str:
    """The name of the key's container, `lllm-sandbox-<key>`; the key is validated first."""
    return f'lllm-sandbox-{validate_chat_id(key)}'


#: The file in the volume directory that holds the backend's scope id.
SCOPE_FILE: Final = 'scope'


def scope_of(volume_dir: Path) -> str:
    """The `lllm.scope` label of every sandbox a backend with this volume directory makes: a random id kept there.

    A backend manages only its own scope: its workspace image files live in
    its volume directory, under the app's DATA_DIR, so another app instance
    against the same Docker daemon (`make test-boot`, which runs the real app
    with a DATA_DIR of its own) neither lists, sweeps, reuses nor stops them.
    The id is made once (16 random hex digits in `<volume_dir>/scope`, mode
    0600) and read afterwards, so moving the checkout, and DATA_DIR with it,
    keeps it. Blocking: call it in a worker thread.

    Raises:
        OSError: The directory or the file cannot be made or read.
        ValueError: The file holds something else than an id this made.
    """
    directory = Path(volume_dir)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = directory / SCOPE_FILE
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return _check_scope(path.read_text().strip())
    with os.fdopen(fd, 'w') as handle:
        handle.write(secrets.token_hex(8) + '\n')
    return _check_scope(path.read_text().strip())


def _check_scope(scope: str) -> str:
    if type(scope) is not str or len(scope) != 16 or any(c not in '0123456789abcdef' for c in scope):
        raise ValueError(f'scope {scope!r} is not 16 lowercase hex digits')
    return scope


def container_options(key: str, image: ImageKey, *, ephemeral: bool, scope: str, uploads: Path) -> dict[str, Any]:
    """The keyword arguments for `containers.run`: fixed, apart from the validated key, image key, flag and scope,
    and the host directory of the key's uploads, which the backend derives from the key alone.

    Raises:
        ValueError: `key` is not a canonical UUID, `image` is not an ImageKey,
            `scope` is not what scope_of makes, or `uploads` is not an
            absolute path whose last component is the key.
    """
    key = validate_chat_id(key)
    if not uploads.is_absolute() or uploads.name != key:
        raise ValueError(f'uploads directory {uploads} is not an absolute path ending in the key')
    if image not in IMAGES:
        raise ValueError(f'image {image!r} is not one of {tuple(IMAGES)}')
    labels = {'lllm.chat': key, 'lllm.scope': _check_scope(scope), 'lllm.image': image}
    if ephemeral:
        labels['lllm.ephemeral'] = '1'
    return {
        'image': IMAGES[image],
        'runtime': KATA_RUNTIME,
        'name': container_name(key),
        'labels': labels,
        'user': CONTAINER_USER,
        'init': True,
        'entrypoint': list(KEEP_ALIVE),
        'cap_drop': list(CAP_DROP),
        'security_opt': list(SECURITY_OPT),
        'read_only': READ_ONLY_ROOT,
        'tmpfs': {'/tmp': f'size={TMP_SIZE}'},
        'mem_limit': MEMORY_LIMIT,
        'nano_cpus': NANO_CPUS,
        'pids_limit': PIDS_LIMIT,
        'ulimits': [docker.types.Ulimit(name='nproc', soft=NPROC_LIMIT, hard=NPROC_LIMIT)],
        'network': SANDBOX_NETWORK,
        'extra_hosts': {'sandbox-mirror': SANDBOX_MIRROR_ADDRESS},
        # No IPv6 in the guest: the bridge's link-local address would otherwise reach host services listening on
        # `::` (T16's security review, B1), which inhibit_ipv4 does not cover.
        'sysctls': dict(IPV6_OFF),
        'volumes': {volume_name(key): {'bind': WORKSPACE, 'mode': 'rw'}},
        # Read-only in the guest itself (checked on Kata: write, chmod, unlink, create fail with EROFS; rename and
        # rmdir with EBUSY; root without capabilities cannot remount it).
        'mounts': [docker.types.Mount(target=UPLOADS, source=str(uploads), type='bind', read_only=True)],
        'working_dir': WORKSPACE,
        # The data image inherits Jupyter's health check, which would run an exec in the guest every few seconds.
        'healthcheck': {'test': ['NONE']},
        'detach': True,
        'auto_remove': False,
    }


#: Docker's daemon configuration, whose kata-clh runtime names the Kata configuration it uses (`ConfigPath`).
DAEMON_JSON: Final = Path('/etc/docker/daemon.json')
#: The Kata configuration the kata-clh runtime reads when daemon.json cannot say (docs/guides/sandbox.md, "Host
#: setup"); guest seccomp must be on.
KATA_CONFIG: Final = Path('/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-clh-runtime-rs.toml')
#: The sysctls that turn IPv6 off inside the guest.
IPV6_OFF: Final[Mapping[str, str]] = MappingProxyType(
    {'net.ipv6.conf.all.disable_ipv6': '1', 'net.ipv6.conf.default.disable_ipv6': '1'}
)
#: The bridge's host-side name, which Compose fixes (T16) and the host's own IPv6 rule keys on (Q20).
BRIDGE_NAME: Final = 'lllm-sandbox'
#: The host's IPv6 switch for the sandbox bridge, which the host rule (Q20) sets to 1.
BRIDGE_IPV6: Final = Path(f'/proc/sys/net/ipv6/conf/{BRIDGE_NAME}/disable_ipv6')
#: The bridge option that names it.
BRIDGE_NAME_OPTION: Final = 'com.docker.network.bridge.name'
#: The bridge option that leaves the host without an address on the sandbox network. An internal network still
#: gives the host's side of the bridge an address, through which the guests reach every host service listening
#: on 0.0.0.0; with this option the bridge has none, and the guests reach only each other and the mirror.
INHIBIT_IPV4: Final = 'com.docker.network.bridge.inhibit_ipv4'


def network_is_fenced(attrs: Mapping[str, Any]) -> bool:
    """Whether a network (its `docker network inspect` attributes) is the sandbox network as it must be.

    A bridge named BRIDGE_NAME on the host (which the host's IPv6 rule keys
    on, Q20), internal (no route out), with the fixed subnet and dynamic
    range and no IPv4 address on the host's side (INHIBIT_IPV4). Checked before every
    create, not only by name, so a network made by hand, by an older Compose
    file or with a typo can never carry a sandbox (T14's security review, S3).
    """
    config = (attrs.get('IPAM') or {}).get('Config') or []
    return (
        attrs.get('Driver') == 'bridge'
        and attrs.get('Internal') is True
        and [(c.get('Subnet'), c.get('IPRange')) for c in config] == [(SANDBOX_SUBNET, SANDBOX_IP_RANGE)]
        and (attrs.get('Options') or {}).get(INHIBIT_IPV4) == 'true'
        and (attrs.get('Options') or {}).get(BRIDGE_NAME_OPTION) == BRIDGE_NAME
        and attrs.get('EnableIPv6') is not True
    )


def volume_options(key: str) -> dict[str, str]:
    """The local volume driver's options for the key's workspace: its ext4 filesystem, found by UUID."""
    return {'type': 'ext4', 'device': f'/dev/disk/by-uuid/{validate_chat_id(key)}', 'o': 'nosuid,nodev'}


def _labels(key: str, *, ephemeral: bool, scope: str) -> dict[str, str]:
    labels = {'lllm.chat': key, 'lllm.scope': _check_scope(scope)}
    if ephemeral:
        labels['lllm.ephemeral'] = '1'
    return labels


def _time(text: object) -> dt.datetime | None:
    """A daemon timestamp (RFC 3339, nanoseconds allowed) as an aware datetime; None when absent or unreadable."""
    if not isinstance(text, str) or not text or text.startswith('0001-'):
        return None
    try:
        return dt.datetime.fromisoformat(text)
    except ValueError:
        return None


def file_stat(path: str, header: Mapping[str, Any], uid: int) -> FileStat:
    """A FileStat from the daemon's path stat (Go's FileMode bits) and the owner read from the archive."""
    go_mode = int(header['mode'])
    if go_mode & _GO_SYMLINK:
        kind = 'symlink'
    elif go_mode & _GO_DIR:
        kind = 'dir'
    elif go_mode & _GO_OTHER:
        kind = 'other'
    else:
        kind = 'file'
    mode = go_mode & 0o777
    mode |= 0o4000 if go_mode & _GO_SETUID else 0
    mode |= 0o2000 if go_mode & _GO_SETGID else 0
    mode |= 0o1000 if go_mode & _GO_STICKY else 0
    when = _time(header.get('mtime'))
    return FileStat(
        path=path,
        kind=kind,
        uid=uid,
        mode=mode,
        size=int(header['size']),
        mtime=when.timestamp() if when is not None else 0.0,
    )


def put_archive_bytes(dir: str, files: list[tuple[str, bytes, int]], mtime: float) -> bytes:
    """The tar `put_files` sends: `dir` as an empty regular file, then as a root-owned 0555 directory, then the files.

    Docker's untar merges a directory entry into an existing directory,
    keeping what is in it, but removes an existing path of any kind before
    it writes a non-directory entry. So the first entry removes whatever
    `dir` was (a symlink, a file, a directory with files planted in it)
    without following it, and the second makes it a new, empty directory.
    """
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w', format=tarfile.PAX_FORMAT) as tar:

        def entry(name: str, kind: bytes, mode: int, size: int = 0) -> tarfile.TarInfo:
            info = tarfile.TarInfo(name)
            info.type = kind
            info.mode = mode
            info.uid = info.gid = 0
            info.uname = info.gname = 'root'
            info.size = size
            info.mtime = mtime
            return info

        tar.addfile(entry(dir, tarfile.REGTYPE, 0o400))
        tar.addfile(entry(dir, tarfile.DIRTYPE, 0o555))
        for name, content, mode in files:
            tar.addfile(entry(f'{dir}/{name}', tarfile.REGTYPE, mode, len(content)), io.BytesIO(content))
    return buffer.getvalue()


def read_frames(raw: Any, stdout: StreamCap, stderr: StreamCap) -> None:
    """Feed a raw exec stream's frames to the two caps until the stream ends or is closed under it.

    Each frame is an 8-byte header (stream number, three zero bytes, a
    big-endian length) and that many bytes; stream 1 is stdout, 2 stderr.
    A frame's body is fed as it arrives, at most 64 KiB at a time.
    """
    try:
        while True:
            header = _recv_exactly(raw, 8)
            if header is None:
                return
            kind, length = struct.unpack('>BxxxL', header)
            target = stdout if kind == 1 else stderr if kind == 2 else None
            while length:
                chunk = raw.recv(min(length, 65536))
                if not chunk:
                    return
                length -= len(chunk)
                if target is not None:
                    target.feed(chunk)
    except OSError:
        # Closed under it (the drain gave up), or reset by the daemon.
        return


def _recv_exactly(raw: Any, n: int) -> bytes | None:
    data = b''
    while len(data) < n:
        chunk = raw.recv(n - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def write_stdin(raw: Any, data: bytes) -> None:
    """Send `data` as the command's stdin and close the writing side, so it reads EOF after it."""
    try:
        raw.sendall(data)
        raw.shutdown(socket.SHUT_WR)
    except OSError:
        # The command exited without reading it all, or the stream was closed under the write.
        return


class _Failed(Exception):
    """An error `fn` raised in a worker thread (its __cause__), converted there so it is never taken for the wait's."""


@dataclass
class _Run:
    """One exec in progress, with what its ending must close."""

    exec_id: str
    container_id: str
    sock: Any
    raw: Any
    started: float
    reader: asyncio.Future[None] | None = None
    writer: asyncio.Future[None] | None = None


def _default_client() -> docker.DockerClient:
    return docker.from_env(timeout=API_TIMEOUT_S)


class KataDockerBackend:
    """A SandboxBackend running each sandbox as a Kata Containers microVM through the Docker daemon.

    Attributes:
        image_ids: Each image key's image id (its digest), as last seen by
            `ready` or `create`, for telemetry and the harness.
    """

    def __init__(
        self,
        volume_dir: Path,
        *,
        client_factory: Callable[[], docker.DockerClient] = _default_client,
        workspace_bytes: int = WORKSPACE_BYTES,
        uploads_dir: Path | None = None,
        kata_config: Path | None = None,
        bridge_ipv6: Path | None = None,
    ) -> None:
        """Make a backend; nothing contacts the daemon until the first call.

        Args:
            volume_dir: Where the workspace image files live (`<key>.img`),
                created on first use; under the app's DATA_DIR.
            client_factory: Makes the Docker client, in a worker thread.
            workspace_bytes: The size of each new workspace filesystem.
            kata_config: The Kata configuration file checked for guest seccomp; when None, the one daemon.json
                names for kata-clh, else KATA_CONFIG.
            bridge_ipv6: The host's IPv6 switch for the sandbox bridge, checked to be 1 (BRIDGE_IPV6).
            uploads_dir: Where each sandbox's uploads live on the host
                (`<key>/`), mounted read-only at /workspace/uploads; beside
                `volume_dir` (`../uploads`) unless given.
        """
        self._volume_dir = Path(volume_dir).resolve()
        self._uploads_dir = (
            Path(uploads_dir) if uploads_dir is not None else self._volume_dir.parent / 'uploads'
        ).resolve()
        self._scope_value: str | None = None
        self._kata_config = kata_config
        self._bridge_ipv6 = BRIDGE_IPV6 if bridge_ipv6 is None else bridge_ipv6
        self._client_factory = client_factory
        self._client: docker.DockerClient | None = None
        # Guards the lazily made client, scope and per-key locks, from worker threads.
        self._setup_lock = threading.Lock()
        # One lock per key, held in the worker thread by create, stop, destroy and put_files, so a call that timed
        # out and runs on can never interleave with the next call for the same sandbox (its stop waits for it).
        self._key_locks: dict[str, threading.RLock] = {}
        if type(workspace_bytes) is not int or workspace_bytes < MIN_WORKSPACE_BYTES:
            raise ValueError(f'workspace_bytes must be an int of at least {MIN_WORKSPACE_BYTES}')
        self._workspace_bytes = workspace_bytes
        # Stream readers and writers hold a thread for as long as a command runs; they get a pool of their own, so
        # they can never take the threads the waits, the kill and every other to_thread call need (S2).
        self._streams = ThreadPoolExecutor(max_workers=STREAM_THREADS, thread_name_prefix='lllm-sandbox-stream')
        self.image_ids: dict[str, str] = {}

    def close(self) -> None:
        """Release the stream threads' pool, without waiting; the app's shutdown calls it after the manager's."""
        self._streams.shutdown(wait=False, cancel_futures=True)

    # Plumbing.

    def _docker(self) -> docker.DockerClient:
        with self._setup_lock:
            if self._client is None:
                self._client = self._client_factory()
            return self._client

    @property
    def _scope(self) -> str:
        """This backend's scope id (scope_of), read or made on first use; blocking, so only in worker threads."""
        with self._setup_lock:
            if self._scope_value is None:
                self._scope_value = scope_of(self._volume_dir)
            return self._scope_value

    def _key_lock(self, key: str) -> threading.RLock:
        with self._setup_lock:
            return self._key_locks.setdefault(key, threading.RLock())

    def _ours(self, labels: Mapping[str, str] | None) -> bool:
        return (labels or {}).get('lllm.scope') == self._scope

    async def _call[T](self, what: str, fn: Callable[..., T], *args: Any, limit_s: float | None = None) -> T:
        """Run the blocking `fn(*args)` in a thread; an SDK or host error becomes SandboxError('could not <what>').

        A SandboxError `fn` raises passes through unchanged; any other error
        it raises is converted in the thread, so a TimeoutError of its own is
        never taken for the wait's. With `limit_s`, waiting stops after that
        many seconds with a SandboxError; the thread itself cannot be stopped
        and runs on (the per-key lock keeps it from racing the next call).
        """

        def guarded() -> T:
            try:
                return fn(*args)
            except _BACKEND_ERRORS as e:
                raise _Failed from e

        call: Awaitable[T] = asyncio.to_thread(guarded)
        try:
            if limit_s is None:
                return await call
            return await asyncio.wait_for(call, limit_s)
        except _Failed as failed:
            log.warning('the sandbox backend could not %s', what, exc_info=failed.__cause__)
            raise SandboxError(f'the sandbox backend could not {what}') from None
        except TimeoutError:
            log.warning('the sandbox backend did not %s within %g s', what, limit_s)
            raise SandboxError(f'the sandbox backend did not {what} within {limit_s:g} seconds') from None

    def _container(self, key: str) -> Any:
        """The key's container, or None; one another scope made is left alone, as if it were not there."""
        try:
            container = self._docker().containers.get(container_name(key))
        except docker.errors.NotFound:
            return None
        if not self._ours(container.labels):
            log.warning('sandbox container %s belongs to another app instance; leaving it alone', key)
            return None
        return container

    def _running(self, key: str) -> Any:
        """The key's running container.

        Raises:
            SandboxNotRunning: It does not exist or is not running.
        """
        container = self._container(key)
        if container is None or container.status != 'running':
            raise SandboxNotRunning(_NOT_RUNNING)
        return container

    def _image_path(self, key: str) -> Path:
        return self._volume_dir / f'{validate_chat_id(key)}.img'

    def _uploads_path(self, key: str) -> Path:
        return self._uploads_dir / validate_chat_id(key)

    def _staging_path(self, key: str) -> Path:
        # Beside the mounted directory, on the same filesystem, so a rename from it into the directory is atomic.
        return self._uploads_dir / f'.{validate_chat_id(key)}.staging'

    def _ensure_uploads(self, key: str) -> Path:
        """The key's uploads directory, made if missing (mode 0755, the backend's user); never a symlink."""
        path = self._uploads_path(key)
        self._uploads_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        if path.is_symlink() or (path.exists() and not path.is_dir()):
            path.unlink()
        path.mkdir(mode=0o755, exist_ok=True)
        # Explicit, whatever the umask (R3): the guest-view check compares this mode.
        path.chmod(0o755)
        return path

    # Readiness.

    def _unusable(self, images: tuple[ImageKey, ...], mirror: bool) -> str | None:
        """The first reason sandboxes cannot run, in a fixed order, or None; each reason free of host paths."""
        client = self._docker()
        info = client.info()
        if KATA_RUNTIME not in (info.get('Runtimes') or {}):
            return f'The Docker daemon has no {KATA_RUNTIME} runtime (docs/guides/sandbox.md, "Host setup")'
        if not _guest_seccomp_on(self._kata_config or _kata_config_path()):
            return 'Kata runs guests without seccomp (docs/guides/sandbox.md, "Guest seccomp")'
        for key in images:
            try:
                image_id = client.images.get(IMAGES[key]).id
            except docker.errors.ImageNotFound:
                return f'The sandbox image {IMAGES[key]} is missing; build it with make sandbox-images'
            if image_id:
                self.image_ids[key] = image_id
        try:
            network = client.networks.get(SANDBOX_NETWORK)
        except docker.errors.NotFound:
            return f'The sandbox network {SANDBOX_NETWORK} does not exist; make backend creates it'
        if not network_is_fenced(network.attrs):
            return (
                f'The sandbox network {SANDBOX_NETWORK} is not the internal network make backend creates; remove it '
                '(docker network rm) and start the backend again'
            )
        # The bridge exists once the network does.
        # A kernel without IPv6 (no /proc/sys/net/ipv6) is the safest case (G3).
        if self._bridge_ipv6.parents[2].is_dir() and _read(self._bridge_ipv6) != '1':
            return f'IPv6 is not off on the sandbox bridge {BRIDGE_NAME} (docs/guides/sandbox.md, "Host setup")'
        try:
            _ = self._scope
        except (OSError, ValueError):
            return 'The sandbox scope id file is unreadable or not one this backend made'
        if any(shutil.which(tool, path=HOST_TOOL_PATH) is None for tool in ('udisksctl', 'mkfs.ext4', 'debugfs')):
            return 'The host lacks udisksctl, mkfs.ext4 or debugfs, which the workspace volumes need'
        if mirror:
            found = self._container_named(MIRROR_CONTAINER)
            if found is None or found.status != 'running':
                return 'The sandbox-mirror container is not running; make backend starts it'
        return None

    def _container_named(self, name: str) -> Any:
        try:
            return self._docker().containers.get(name)
        except docker.errors.NotFound:
            return None

    async def ready(self) -> str | None:
        """None when sandboxes can run, else why not: the daemon, the runtime, the images, the network, the volume
        tools and the mirror, checked in that order."""
        try:
            return await self._call('query the Docker daemon', self._unusable, tuple(IMAGES), True)
        except SandboxError:
            return _NO_DAEMON

    # Lifecycle.

    async def create(self, chat_id: str, spec: SandboxSpec) -> None:
        """Start the chat's sandbox (SandboxBackend.create), or keep the one already running with this image.

        Before anything is created it checks what a sandbox needs (all of
        `ready` but the mirror, which only `pip install` needs) and raises
        SandboxUnavailable with the reason, which is fit for the model.
        """
        validate_create(chat_id, spec)
        # A spec is checked when it is built; checked again here, before any daemon call, in case it was bypassed.
        if spec.image not in IMAGES:
            raise ValueError(f'image {spec.image!r} is not one of {tuple(IMAGES)}')
        abandoned = threading.Event()
        try:
            await self._call(
                'start the sandbox',
                self._create,
                spec.chat_id,
                spec.image,
                spec.ephemeral,
                abandoned,
                limit_s=CREATE_TIMEOUT_S,
            )
        except SandboxError:
            # If the thread runs on, it starts no VM; the manager's cleanup stop waits for it on the key's lock.
            abandoned.set()
            raise

    def _create(self, key: str, image: ImageKey, ephemeral: bool, abandoned: threading.Event) -> None:
        with self._key_lock(key):
            try:
                reason = self._unusable((image,), False)
            except _BACKEND_ERRORS:
                reason = _NO_DAEMON
            if reason is not None:
                raise SandboxUnavailable(reason, public=reason)
            container = self._container(key)
            if container is not None:
                if container.status == 'running' and container.labels.get('lllm.image') == image:
                    return
                container.remove(force=True)
            self._ensure_volume(key, ephemeral)
            uploads = self._ensure_uploads(key)
            if abandoned.is_set():
                return
            started = self._docker().containers.run(
                **container_options(key, image, ephemeral=ephemeral, scope=self._scope, uploads=uploads)
            )
            if abandoned.is_set():
                # Given up on while it started: nothing may run that the manager does not know of.
                started.remove(force=True)
                return
            try:
                problem = self._guard(started.id)
            except BaseException:
                # An unchecked guest never stays up (G5).
                started.remove(force=True)
                raise
            if problem is not None:
                started.remove(force=True)
                raise SandboxUnavailable(problem, public=problem)

    def _ensure_volume(self, key: str, ephemeral: bool) -> None:
        """Make sure the key's workspace volume exists and its image file is attached to a loop device."""
        client = self._docker()
        path = self._image_path(key)
        try:
            volume = client.volumes.get(volume_name(key))
        except docker.errors.NotFound:
            volume = None
        if volume is not None and not self._ours(volume.attrs.get('Labels')):
            raise SandboxError('a workspace volume of another app instance has this name')
        if volume is not None and not path.exists():
            # Its image is gone (a cleanup, or a destroy cut short), and with it the files: start afresh.
            log.warning('the workspace image of sandbox %s is missing; making a new workspace', key)
            volume.remove()
            volume = None
        exists = volume is not None
        if not exists:
            # Whatever file is left from a create that failed before its volume was made holds nothing to keep.
            self._detach(path)
            self._make_image(path, key)
        else:
            self._clear_mount_point(path)
        self._attach(path, key)
        if not exists:
            client.volumes.create(
                name=volume_name(key),
                driver='local',
                driver_opts=volume_options(key),
                labels=_labels(key, ephemeral=ephemeral, scope=self._scope),
            )

    def _guard(self, container_id: str) -> str | None:
        """Check, as nobody, that the new guest applies seccomp and has no IPv6 address; None when it does, else why.

        The host's configuration says so too (ready()), but this asks the
        guest itself, so a runtime that ignored the configuration, or the
        sysctls, is caught before any command runs.
        """
        api = self._docker().api
        argv = ['/usr/bin/timeout', '10', *_GUEST_SHELL, GUARD_SCRIPT]
        exec_id = api.exec_create(container_id, argv, stdout=True, stderr=False, user=CONTAINER_USER)['Id']
        said = api.exec_start(exec_id)
        # The exit status can show a moment after the output ends (G2), as in _exit_status.
        deadline = time.monotonic() + EXIT_STATUS_WAIT_S
        info = api.exec_inspect(exec_id)
        while (info.get('Running') or info.get('ExitCode') is None) and time.monotonic() < deadline:
            time.sleep(0.02)
            info = api.exec_inspect(exec_id)
        if not info.get('Running') and info.get('ExitCode') == 0:
            return None
        known = ('no seccomp filter in the guest', 'the guest has an IPv6 address')
        found = said.decode(errors='replace').strip() if isinstance(said, bytes) else ''
        reason = found if found in known else 'the guest could not be checked'
        log.error('a new sandbox failed its guard check: %s; removed it', reason)
        return f'The sandbox cannot run: {reason}'

    def _clear_mount_point(self, path: Path) -> None:
        """Remove an `uploads` entry from the workspace's root that is not a directory, before the uploads mount.

        While a sandbox runs, UID 1000 cannot touch the mount point (EBUSY),
        but a workspace used without the mount (before it existed) can hold a
        symlink or file named `uploads`. Checked on Kata: the guest then
        mounts the uploads where a symlink points (`/tmp`, `/etc`), and a
        file makes the create fail. So it is removed with debugfs on the
        image file, which only the backend's user can write. The image must
        be unmounted (no container uses it) and is detached first, so the
        loop device's cache holds nothing of the old entry. A directory is
        kept: the mount covers it.

        Raises:
            SandboxError: The image is still mounted, or the entry is still
                there afterwards.
        """
        if _entry_type(self._host_debugfs(path, 'stat uploads')) in (None, 'directory'):
            return
        for loop, _ in self._loops(path):
            if _is_mounted(loop):
                raise SandboxError('the workspace is still mounted, so its uploads mount point cannot be fixed')
        self._detach(path)
        self._host([self._tool('debugfs'), '-w', '-R', 'rm uploads', str(path)])
        if _entry_type(self._host_debugfs(path, 'stat uploads')) is not None:
            raise SandboxError('the workspace still has an uploads entry that is not a directory')

    def _host_debugfs(self, path: Path, request: str) -> str:
        """debugfs's read-only answer to `request` on the image (its stdout and stderr: a missing entry is told on
        stderr, with a zero exit status)."""
        done = subprocess.run(
            [self._tool('debugfs'), '-R', request, str(path)],
            check=True,
            capture_output=True,
            text=True,
            timeout=HOST_TOOL_TIMEOUT_S,
            env={'PATH': HOST_TOOL_PATH, 'LC_ALL': 'C'},
        )
        return done.stdout + done.stderr

    def _tool(self, name: str) -> str:
        found = shutil.which(name, path=HOST_TOOL_PATH)
        if found is None:
            raise SandboxUnavailable(f'the host has no {name}')
        return found

    def _host(self, argv: list[str]) -> str:
        """Run a host tool with a fixed argv and environment; its stdout. Raises on failure (subprocess errors)."""
        done = subprocess.run(
            argv,
            check=True,
            capture_output=True,
            text=True,
            timeout=HOST_TOOL_TIMEOUT_S,
            env={'PATH': HOST_TOOL_PATH, 'LC_ALL': 'C'},
        )
        return done.stdout

    def _make_image(self, path: Path, key: str) -> None:
        """A new sparse ext4 image of the workspace size, its root owned by UID 1000, with no lost+found."""
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        path.unlink(missing_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.fchmod(fd, 0o600)
            os.ftruncate(fd, self._workspace_bytes)
        finally:
            os.close(fd)
        owner = f'{SANDBOX_UID}:{SANDBOX_UID}'
        blocks = (self._workspace_bytes - TAIL_GAP_BYTES) // WORKSPACE_BLOCK_BYTES
        self._host(
            [
                self._tool('mkfs.ext4'),
                '-q',
                '-F',
                '-b',
                str(WORKSPACE_BLOCK_BYTES),
                '-m',
                '0',
                '-U',
                key,
                '-E',
                f'root_owner={owner}',
                str(path),
                str(blocks),
            ]
        )
        # A root-owned 0700 lost+found would sit in every workspace, unreadable to the model.
        self._host([self._tool('debugfs'), '-w', '-R', 'rmdir lost+found', str(path)])

    def _loops(self, path: Path) -> list[tuple[str, bool]]:
        """Every loop device (`loopN`) attached to the image file, each with whether the file was deleted since.

        Read from sysfs, no root needed; the kernel reports an attached file
        that was unlinked as `<path> (deleted)`.
        """
        found = []
        for backing in SYS_BLOCK.glob('loop*/loop/backing_file'):
            try:
                text = backing.read_text().strip()
            except OSError:
                continue
            if text in (str(path), f'{path} (deleted)'):
                found.append((backing.parent.parent.name, text != str(path)))
        return found

    def _loop_of(self, path: Path) -> str | None:
        """The loop device the image file, as it is now, is attached to, or None."""
        return next((loop for loop, deleted in self._loops(path) if not deleted), None)

    def _attach(self, path: Path, key: str) -> None:
        """Attach the image file to a loop device unless it already is, and wait for its by-UUID link.

        A loop device still attached to a deleted image of this key carries
        the same filesystem UUID, so it is detached first.
        """
        for loop, deleted in self._loops(path):
            if deleted:
                self._delete_loop(loop)
        loop = self._loop_of(path)
        if loop is None:
            self._host(
                [self._tool('udisksctl'), 'loop-setup', '--no-user-interaction', '--no-partition-scan', '-f', str(path)]
            )
            loop = self._loop_of(path)
            if loop is None:
                raise SandboxError('the workspace image was not attached to a loop device')
        link = BY_UUID / key
        deadline = time.monotonic() + DEVICE_LINK_WAIT_S
        while os.path.realpath(link) != f'/dev/{loop}':
            if time.monotonic() >= deadline:
                raise SandboxError('the workspace device did not appear')
            time.sleep(0.05)

    def _detach(self, path: Path) -> None:
        """Detach every loop device attached to the image file, a deleted one included."""
        for loop, _ in self._loops(path):
            self._delete_loop(loop)

    def _delete_loop(self, loop: str) -> None:
        self._host([self._tool('udisksctl'), 'loop-delete', '--no-user-interaction', '-b', f'/dev/{loop}'])

    async def stop(self, chat_id: str) -> None:
        """Remove the chat's container, keeping its volume; a no-op when there is none."""
        key = validate_chat_id(chat_id)
        await self._call('stop the sandbox', self._stop, key, limit_s=STOP_TIMEOUT_S)

    def _stop(self, key: str) -> None:
        with self._key_lock(key):
            container = self._container(key)
            if container is not None:
                try:
                    container.remove(force=True)
                except docker.errors.NotFound:
                    pass
            # Uploads are put again at every start, so a stopped sandbox keeps none on the host's disk, outside the
            # workspace's cap (T13's security re-review, N-b).
            uploads = self._uploads_path(key)
            if uploads.is_dir() and not uploads.is_symlink():
                _remove_except(uploads, {})

    async def destroy(self, chat_id: str) -> None:
        """Remove the chat's container and volume, detach its image file and delete it; a no-op when none exist."""
        key = validate_chat_id(chat_id)
        await self._call('destroy the sandbox', self._destroy, key, limit_s=DESTROY_TIMEOUT_S)

    def _destroy(self, key: str) -> None:
        # The volume goes last: if a step before it fails, the volume is still listed, so a sweep destroys it again.
        with self._key_lock(key):
            self._stop(key)
            path = self._image_path(key)
            self._detach(path)
            path.unlink(missing_ok=True)
            for directory in (self._uploads_path(key), self._staging_path(key)):
                if directory.is_symlink():
                    directory.unlink()
                elif directory.exists():
                    shutil.rmtree(directory)
            try:
                volume = self._docker().volumes.get(volume_name(key))
            except docker.errors.NotFound:
                volume = None
            if volume is not None and self._ours(volume.attrs.get('Labels')):
                volume.remove()
        # Gone for good (N3): a later call for the key makes a new lock; a waiter keeps its own reference.
        with self._setup_lock:
            self._key_locks.pop(key, None)

    async def list_sandboxes(self) -> list[SandboxInfo]:
        """Every chat with a sandbox container or volume (SandboxBackend.list_sandboxes)."""
        return await self._call('list the sandboxes', self._list)

    def _list(self) -> list[SandboxInfo]:
        client = self._docker()
        scope = self._scope
        found: dict[str, dict[str, Any]] = {}
        for volume in client.volumes.list(filters={'label': ['lllm.chat', f'lllm.scope={scope}']}):
            labels = volume.attrs.get('Labels') or {}
            key = _key_of(labels, scope)
            if key is not None:
                found[key] = {
                    'running': False,
                    'image': None,
                    'ephemeral': labels.get('lllm.ephemeral') == '1',
                    'last_used': _time(volume.attrs.get('CreatedAt')),
                    'ip': None,
                }
        # A container removed between the listing and its inspection is skipped, not an error for the whole list.
        for container in client.containers.list(
            all=True, filters={'label': ['lllm.chat', f'lllm.scope={scope}']}, ignore_removed=True
        ):
            labels = container.labels or {}
            key = _key_of(labels, scope)
            if key is None:
                continue
            entry = found.setdefault(
                key,
                {'running': False, 'image': None, 'ephemeral': False, 'last_used': None, 'ip': None},
            )
            entry['ephemeral'] = entry['ephemeral'] or labels.get('lllm.ephemeral') == '1'
            if container.status == 'running':
                image = labels.get('lllm.image')
                networks = (container.attrs.get('NetworkSettings') or {}).get('Networks') or {}
                entry.update(
                    running=True,
                    image=image if image in IMAGES else None,
                    last_used=_time((container.attrs.get('State') or {}).get('StartedAt')),
                    ip=(networks.get(SANDBOX_NETWORK) or {}).get('IPAddress') or None,
                )
        # An image file or uploads directory with no volume is left from a create or destroy cut short: no files
        # of the workspace are in it. Listed as a stopped ephemeral sandbox, so the sweeps destroy it.
        leftovers = [(image.stem, image) for image in self._volume_dir.glob('*.img')]
        if self._uploads_dir.is_dir():
            leftovers += [(entry.name, entry) for entry in self._uploads_dir.iterdir()]
        for name, leftover in sorted(leftovers):
            # `.<key>.staging` is put_uploads's scratch directory, left by a call cut short (N5).
            key = _key_of({'lllm.chat': name.removeprefix('.').removesuffix('.staging'), 'lllm.scope': scope}, scope)
            if key is None or key in found:
                continue
            try:
                when = leftover.lstat().st_mtime
            except FileNotFoundError:
                # Destroyed while this listed it (R2).
                continue
            found[key] = {
                'running': False,
                'image': None,
                'ephemeral': True,
                'last_used': dt.datetime.fromtimestamp(when, dt.UTC),
                'ip': None,
            }
        return [SandboxInfo(chat_id=key, **entry) for key, entry in found.items()]

    # Commands.

    async def exec(self, chat_id: str, argv: list[str], timeout_s: int, stdin: bytes | None = None) -> ExecResult:
        """Run one wrapped command as UID 1000 (SandboxBackend.exec), then end every UID 1000 process.

        If the caller is cancelled, the kill runs at once, and this neither
        returns nor raises until it has; then CancelledError is raised, or
        the SandboxError the kill raised. The work runs in a task of its own
        that is never cancelled: a cancellation only sets `stop`, which the
        task checks while it waits for the command, so nothing after the
        exec has started (the kill, the drain) can be cut short.
        """
        key = validate_chat_id(chat_id)
        require_wrapped(argv, timeout_s)
        if stdin is not None and not isinstance(stdin, bytes):
            raise TypeError(f'stdin must be bytes or None, not {type(stdin).__name__}')
        stop = asyncio.Event()
        run = asyncio.ensure_future(self._exec(key, list(argv), timeout_s, stdin, stop))
        while not run.done():
            try:
                # Unlike awaiting the task, asyncio.wait leaves it running when this coroutine is cancelled.
                await asyncio.wait([run])
            except asyncio.CancelledError:
                stop.set()
        result = run.result()
        if stop.is_set() or result is None:
            # _exec returns None only once `stop` is set.
            raise asyncio.CancelledError
        return result

    async def _exec(
        self, key: str, argv: list[str], timeout_s: int, stdin: bytes | None, stop: asyncio.Event
    ) -> ExecResult | None:
        """The exec itself; None when `stop` was set, once the kill has run."""
        stdout, stderr = StreamCap(), StreamCap()
        try:
            run = await self._call('run the command', self._start_exec, key, argv, stdin is not None)
        except SandboxNotRunning:
            raise
        except SandboxError:
            # It may have started before the call failed; nothing it started may outlive the call (Q10).
            await self._kill(key)
            raise
        loop = asyncio.get_running_loop()
        run.reader = asyncio.ensure_future(loop.run_in_executor(self._streams, read_frames, run.raw, stdout, stderr))
        if stdin is not None:
            run.writer = asyncio.ensure_future(loop.run_in_executor(self._streams, write_stdin, run.raw, stdin))
        try:
            returncode, elapsed_s, deadline_hit = await self._wait(run, timeout_s, stop)
        except SandboxError:
            await self._finish(key, run)
            raise
        if returncode == 137:
            # The guest's OOM killer gives 137 too; a VM that died does as well, and then the container is gone.
            try:
                await self._call('check the sandbox', self._running, key, limit_s=KILL_TIMEOUT_S)
            except SandboxNotRunning:
                # Not running, or gone: whatever is left of it is stopped, fail closed (N6).
                try:
                    await self._call('stop the sandbox', self._stop, key, limit_s=KILL_STOP_TIMEOUT_S)
                except SandboxError:
                    log.exception('could not stop sandbox %s, found not running after an exit status 137', key)
                await self._close(run)
                raise SandboxNotRunning(_DIED) from None
            except SandboxError:
                # The daemon did not say; the kill below fails closed if the sandbox is gone.
                pass
        await self._finish(key, run)
        if stop.is_set():
            return None
        if deadline_hit:
            returncode = 124
        elif returncode is None:
            returncode = await self._exit_status(run)
        return result_from(
            returncode,
            stdout=stdout,
            stderr=stderr,
            elapsed_s=elapsed_s,
            timeout_s=timeout_s,
            deadline_hit=deadline_hit,
        )

    def _start_exec(self, key: str, argv: list[str], with_stdin: bool) -> _Run:
        container = self._running(key)
        api = self._docker().api
        exec_id = api.exec_create(
            container.id,
            argv,
            stdout=True,
            stderr=True,
            stdin=with_stdin,
            tty=False,
            user=SANDBOX_USER,
            workdir=WORKSPACE,
        )['Id']
        started = time.monotonic()
        sock = api.exec_start(exec_id, socket=True)
        raw: Any = getattr(sock, '_sock', sock)
        # The client's HTTP timeout would end a read on a command that is quiet for longer.
        raw.settimeout(None)
        return _Run(exec_id=exec_id, container_id=container.id, sock=sock, raw=raw, started=started)

    def _inspect(self, exec_id: str) -> dict[str, Any]:
        return self._docker().api.exec_inspect(exec_id)

    async def _wait(self, run: _Run, timeout_s: int, stop: asyncio.Event) -> tuple[int | None, float, bool]:
        """Wait for the command's main process to end, for the host-side deadline, or for `stop`.

        Returns:
            Its exit status (None when only the watcher saw it end, since the
            daemon reports it once the stream closes, or when `stop` ended
            the wait), the seconds it ran, and whether the deadline ended
            the wait.
        """
        deadline = run.started + timeout_s + HOST_DEADLINE_SLACK_S
        poller: str | None = None
        poller_failed = False
        delay = POLL_MIN_S
        while True:
            info = await self._call('check on the command', self._inspect, run.exec_id, limit_s=KILL_TIMEOUT_S)
            now = time.monotonic()
            if not info.get('Running') and info.get('ExitCode') is not None:
                return int(info['ExitCode']), now - run.started, False
            if poller is not None:
                watched = await self._call('check on the command', self._inspect, poller, limit_s=KILL_TIMEOUT_S)
                if not watched.get('Running'):
                    if watched.get('ExitCode') == 0:
                        return None, now - run.started, False
                    log.warning(
                        'the sandbox watcher exec ended with %r; waiting on the daemon', watched.get('ExitCode')
                    )
                    poller = None
                    poller_failed = True
            elif not poller_failed and info.get('Running') and now - run.started >= POLLER_AFTER_S:
                poller = await self._call(
                    'watch the command',
                    self._start_detached,
                    run.container_id,
                    self._poller_argv(timeout_s),
                    CONTAINER_USER,
                    limit_s=KILL_TIMEOUT_S,
                )
            if now >= deadline:
                return None, now - run.started, True
            if stop.is_set():
                return None, now - run.started, False
            try:
                await asyncio.wait_for(stop.wait(), delay)
            except TimeoutError:
                pass
            delay = min(delay * 2, POLL_MAX_S)

    @staticmethod
    def _poller_argv(timeout_s: int) -> list[str]:
        # Bounded by its own timeout, so it never outlives the call by long, whatever happens to this process.
        bound = timeout_s + HOST_DEADLINE_SLACK_S + KILL_GRACE_S
        return ['/usr/bin/timeout', str(bound), *_GUEST_SHELL, POLL_SCRIPT]

    def _start_detached(self, container_id: str, argv: list[str], user: str) -> str:
        api = self._docker().api
        exec_id = api.exec_create(container_id, argv, stdout=False, stderr=False, user=user, workdir=WORKSPACE)['Id']
        api.exec_start(exec_id, detach=True)
        return exec_id

    async def _finish(self, key: str, run: _Run) -> None:
        """The post-exec kill (Q10), then the stream drained and closed; the stream is closed whatever happens."""
        try:
            await self._kill(key, run.container_id)
        finally:
            await self._close(run)

    async def _kill(self, key: str, container_id: str | None = None) -> None:
        """End every UID 1000 process and confirm none is left; else stop the sandbox and raise SandboxNotRunning.

        Up to KILL_ROUNDS rounds of a kill as UID 1000 (KILL_SCRIPT, whose
        exit status is ignored) and a verdict as `nobody` (VERIFY_SCRIPT),
        which alone decides: a UID 1000 process that survived can trace the
        kill, but not the verdict.

        Raises:
            SandboxNotRunning: No verdict confirmed it within KILL_TIMEOUT_S (a
                kill or verdict could not start, as under a fork bomb at the
                nproc limit, failed or timed out), or the sandbox is gone; it
                has been stopped.
        """
        # One deadline for the whole kill, every daemon call included, so a hung daemon cannot stretch it.
        deadline = time.monotonic() + KILL_TIMEOUT_S
        confirmed = False
        try:
            target = container_id
            if target is None:
                target = (await self._call('check the sandbox', self._running, key, limit_s=self._left(deadline))).id
            for _ in range(KILL_ROUNDS):
                if await self._run_detached(target, [*_GUEST_SHELL, KILL_SCRIPT], SANDBOX_USER, deadline) is None:
                    # Still running at the deadline: traced and held, or the guest is stuck.
                    break
                verdict = await self._run_detached(target, [*_GUEST_SHELL, VERIFY_SCRIPT], CONTAINER_USER, deadline)
                if verdict == 0:
                    confirmed = True
                    break
        except SandboxError:
            confirmed = False
        if confirmed:
            return
        log.warning('could not confirm that sandbox %s has no UID %d process left; stopping it', key, SANDBOX_UID)
        try:
            await self._call('stop the sandbox', self._stop, key, limit_s=KILL_STOP_TIMEOUT_S)
        except SandboxError:
            log.exception('could not stop sandbox %s after its kill failed', key)
        raise SandboxNotRunning(_KILL_FAILED, public=_KILL_FAILED)

    @staticmethod
    def _left(deadline: float) -> float:
        return max(0.01, deadline - time.monotonic())

    async def _run_detached(self, container_id: str, argv: list[str], user: str, deadline: float) -> int | None:
        """Run a backend command detached and wait for it; its exit status, or None when `deadline` came first.

        Raises:
            SandboxError: It could not be started or checked on.
        """
        exec_id = await self._call(
            'end the command', self._start_detached, container_id, argv, user, limit_s=self._left(deadline)
        )
        while True:
            info = await self._call('end the command', self._inspect, exec_id, limit_s=self._left(deadline))
            if not info.get('Running') and info.get('ExitCode') is not None:
                return int(info['ExitCode'])
            if time.monotonic() >= deadline:
                return None
            await asyncio.sleep(0.02)

    async def _close(self, run: _Run) -> None:
        """Let the reader reach the stream's end (DRAIN_TIMEOUT_S at most), then close the stream and its response."""
        if run.reader is not None:
            done, _ = await asyncio.wait([run.reader], timeout=DRAIN_TIMEOUT_S)
            if not done:
                log.warning('a sandbox command stream did not end after the kill; closing it')
        try:
            run.raw.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        for task in (run.reader, run.writer):
            if task is not None:
                await asyncio.wait([task])
        for closeable in (run.sock, getattr(run.sock, '_response', None)):
            if closeable is not None:
                try:
                    closeable.close()
                except _BACKEND_ERRORS:
                    pass

    async def _exit_status(self, run: _Run) -> int:
        """The exit status the daemon reports once the stream has closed.

        Raises:
            SandboxError: It reported none within EXIT_STATUS_WAIT_S.
        """
        deadline = time.monotonic() + EXIT_STATUS_WAIT_S
        while True:
            info = await self._call('read the exit status', self._inspect, run.exec_id)
            if not info.get('Running') and info.get('ExitCode') is not None:
                return int(info['ExitCode'])
            if time.monotonic() >= deadline:
                raise SandboxError('the sandbox backend could not read the exit status of the command')
            await asyncio.sleep(0.02)

    # Files.

    async def put_files(self, chat_id: str, dir: str, files: list[tuple[str, bytes, int]]) -> None:
        """Make `/workspace/<dir>` root-owned 0555 holding exactly `files` (SandboxBackend.put_files).

        Afterwards the directory and every file are checked with the
        daemon's own stat, never with an exec, whose output the model
        controls.

        Raises:
            SandboxError: The daemon refused the archive, or what it wrote is
                not what was asked for.
        """
        key = validate_chat_id(chat_id)
        validate_put_files(dir, files)
        await self._call('copy files into the sandbox', self._put, key, dir, list(files), limit_s=FILES_TIMEOUT_S)

    def _put(self, key: str, dir: str, files: list[tuple[str, bytes, int]]) -> None:
        with self._key_lock(key):
            self._put_locked(key, dir, files)

    def _put_locked(self, key: str, dir: str, files: list[tuple[str, bytes, int]]) -> None:
        container = self._running(key)
        data = put_archive_bytes(dir, files, time.time())
        if not self._docker().api.put_archive(container.id, WORKSPACE, data):
            raise SandboxError('the daemon did not take the files')
        top = f'{WORKSPACE}/{dir}'
        found = self._stat(container.id, top)
        if found is None or (found.kind, found.uid, found.mode) != ('dir', 0, 0o555):
            raise SandboxError(f'{top} is not a root-owned 0555 directory after the copy')
        for name, content, mode in files:
            found = self._stat(container.id, f'{top}/{name}')
            if found is None or (found.kind, found.uid, found.mode, found.size) != ('file', 0, mode, len(content)):
                raise SandboxError('a copied file is not root-owned with the mode and size asked for')
        self._await_guest_view(container.id, top, '0 555', [name for name, _, _ in files], '%f\\0')

    def _await_guest_view(self, container_id: str, top: str, header: str, entries: list[str], fmt: str) -> None:
        """Wait until the guest, too, sees `top` with owner and mode `header` (`<uid> <octal mode>`) and exactly
        `entries`, one per name, as find's `-printf fmt` prints them (`fmt` ends with NUL).

        The guest reaches /workspace through virtio-fs, which caches names
        and attributes for a second (Kata's `virtio_fs_cache = "auto"`), so
        right after a change the guest may still see the replaced entry, miss
        a new file, or get "Stale file handle". The owner and mode alone are
        not enough: a re-sync replaces one root-owned 0555 directory with
        another, so the entries are compared too. What it sees here is no
        evidence of what was written (the daemon's or the host's stat is);
        this only waits until a command run next sees the same.
        """
        api = self._docker().api
        script = (
            '/usr/bin/stat -c "%u %a" -- "$1" && /usr/bin/find "$1" -mindepth 1 -maxdepth 1 -printf "$2" '
            f'| /usr/bin/head -c {GUEST_VIEW_MAX_BYTES}'
        )
        # Under its own timeout: a non-streamed exec_start reads until the exec's output ends, with no timeout.
        argv = ['/usr/bin/timeout', f'{GUEST_VIEW_WAIT_S:g}', *_GUEST_SHELL, script, 'lllm-stat', top, fmt]
        expected = (header.encode(), sorted(entry.encode() for entry in entries))
        deadline = time.monotonic() + GUEST_VIEW_WAIT_S
        while True:
            exec_id = api.exec_create(container_id, argv, stdout=True, stderr=False, user=SANDBOX_USER)['Id']
            seen = api.exec_start(exec_id)
            if isinstance(seen, bytes) and b'\n' in seen:
                first, rest = seen.split(b'\n', 1)
                if (first, sorted(entry for entry in rest.split(b'\0') if entry)) == expected:
                    return
            if time.monotonic() >= deadline:
                raise SandboxError('the sandbox did not see the copied files in time')
            time.sleep(0.2)

    async def put_uploads(self, chat_id: str, files: list[tuple[str, bytes]]) -> None:
        """Make /workspace/uploads (a read-only mount of the key's host directory) hold exactly `files`, 0444
        (SandboxBackend.put_uploads), and wait until the guest sees exactly them."""
        key = validate_chat_id(chat_id)
        validate_put_uploads(files)
        await self._call(
            'copy the uploads into the sandbox', self._put_uploads, key, list(files), limit_s=FILES_TIMEOUT_S
        )

    def _put_uploads(self, key: str, files: list[tuple[str, bytes]]) -> None:
        with self._key_lock(key):
            container = self._running(key)
            top = self._uploads_path(key)
            if top.is_symlink() or not top.is_dir():
                # Made by create, and mounted: never made here, since a new directory would not be the mounted one.
                raise SandboxError('the sandbox has no uploads directory')
            staging = self._staging_path(key)
            if staging.exists():
                shutil.rmtree(staging)
            staging.mkdir(mode=0o700)
            staging.chmod(0o700)
            wanted = dict(files)
            # Stale entries go first, so a put that fails part way leaves fewer files, never ones the user removed.
            _remove_except(top, wanted)
            try:
                for name, content in files:
                    target = top / name
                    if _holds(target, content):
                        continue
                    if target.is_dir() and not target.is_symlink():
                        # Not ours to keep (the guest cannot make one): a rename cannot replace a directory.
                        shutil.rmtree(target)
                    # Written beside the directory, then renamed into it: the guest sees the old file or the new one.
                    temporary = staging / name
                    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444)
                    with os.fdopen(fd, 'wb') as handle:
                        # The mode set explicitly, whatever the process's umask (R3).
                        os.fchmod(handle.fileno(), 0o444)
                        handle.write(content)
                    os.replace(temporary, target)
            finally:
                shutil.rmtree(staging, ignore_errors=True)
            info = top.stat()
            header = f'{info.st_uid} {info.st_mode & 0o7777:o}'
            # Name and inode (virtio-fs passes the host's through), so a replaced file of the same name counts.
            entries = [f'{name}/{(top / name).stat().st_ino}' for name in wanted]
            self._await_guest_view(container.id, UPLOADS, header, entries, '%f/%i\\0')

    async def get_files(self, chat_id: str, paths: list[str], max_bytes: int) -> dict[str, bytes]:
        """Regular files of at most `max_bytes`, keyed by path (SandboxBackend.get_files).

        Each path's stat from the daemon is checked before its body is read:
        anything but a regular file, a path through a symlink, or a file over
        `max_bytes` is omitted without being streamed.
        """
        key = validate_chat_id(chat_id)
        validate_get_files(paths, max_bytes)
        return await self._call(
            'read files from the sandbox', self._get, key, list(paths), max_bytes, limit_s=FILES_TIMEOUT_S
        )

    def _get(self, key: str, paths: list[str], max_bytes: int) -> dict[str, bytes]:
        container = self._running(key)
        found: dict[str, bytes] = {}
        for path in paths:
            data = self._read(container.id, path, max_bytes)
            if data is not None:
                found[path] = data
        return found

    async def stat(self, chat_id: str, path: str) -> FileStat | None:
        """The daemon's view of one path (SandboxBackend.stat): a symlink as a symlink, a FIFO, socket or device as
        `other`; None when it does not exist or a directory on its way is a symlink."""
        key = validate_chat_id(chat_id)
        validate_sandbox_path(path, allow_workspace=True)
        return await self._call(
            'read a file status in the sandbox', self._stat_running, key, path, limit_s=FILES_TIMEOUT_S
        )

    def _stat_running(self, key: str, path: str) -> FileStat | None:
        return self._stat(self._running(key).id, path)

    def _archive(self, container_id: str, path: str, *, head: bool = False) -> requests.Response | None:
        """The daemon's archive of `path` (only its headers with `head`, else its body unread); None on 404."""
        api = self._docker().api
        url = f'{api.base_url}/v{api.api_version}/containers/{container_id}/archive'
        params = {'path': path}
        if head:
            response = api.head(url, params=params)
        else:
            # Unless asked not to, the daemon gzips the tar, and the body is read as a plain tar stream.
            response = api.get(url, params=params, stream=True, headers={'Accept-Encoding': 'identity'})
        if response.status_code == 404:
            response.close()
            return None
        try:
            response.raise_for_status()
        except requests.HTTPError:
            response.close()
            raise
        return response

    def _path_stat(self, response: requests.Response) -> dict[str, Any]:
        header = docker.utils.decode_json_header(response.headers['X-Docker-Container-Path-Stat'])
        if not isinstance(header, dict):
            raise ValueError('the path stat is not an object')
        return header

    def _through_dirs(self, container_id: str, path: str) -> bool:
        """Whether each directory between /workspace and `path` is one, not a symlink the daemon would follow."""
        parent = path.rsplit('/', 1)[0]
        while parent != WORKSPACE and parent.startswith(WORKSPACE + '/'):
            response = self._archive(container_id, parent, head=True)
            if response is None:
                return False
            try:
                mode = int(self._path_stat(response)['mode'])
            finally:
                response.close()
            if not mode & _GO_DIR or mode & _GO_SYMLINK:
                return False
            parent = parent.rsplit('/', 1)[0]
        return True

    def _stat(self, container_id: str, path: str) -> FileStat | None:
        # A directory's archive is the whole tree; only its first header is read before the response is closed,
        # which ends the daemon's tar.
        if not self._through_dirs(container_id, path):
            return None
        response = self._archive(container_id, path)
        if response is None:
            return None
        try:
            header = self._path_stat(response)
            # The owner is only in the archive's first header; a socket cannot be archived, so its owner is unknown,
            # and -1 matches no user.
            uid = -1
            if not int(header['mode']) & _GO_SOCKET:
                with tarfile.open(fileobj=response.raw, mode='r|') as tar:
                    member = tar.next()
                    if member is not None:
                        uid = member.uid
            return file_stat(path, header, uid)
        finally:
            response.close()

    def _read(self, container_id: str, path: str, max_bytes: int) -> bytes | None:
        if not self._through_dirs(container_id, path):
            return None
        response = self._archive(container_id, path)
        if response is None:
            return None
        try:
            header = self._path_stat(response)
            mode = int(header['mode'])
            if mode & (_GO_DIR | _GO_SYMLINK | _GO_OTHER) or int(header['size']) > max_bytes:
                return None
            with tarfile.open(fileobj=response.raw, mode='r|') as tar:
                member = tar.next()
                if member is None or not member.isreg() or member.size > max_bytes:
                    return None
                body = tar.extractfile(member)
                if body is None:
                    return None
                data = body.read(member.size)
            return data if len(data) == member.size else None
        finally:
            response.close()


def _read(path: Path) -> str | None:
    """A small host file's text, stripped; None when it cannot be read."""
    try:
        return path.read_text().strip()
    except OSError:
        return None


def _kata_config_path() -> Path:
    """The Kata configuration the kata-clh runtime uses: daemon.json's `ConfigPath` for it when that file can be read
    and names one, else KATA_CONFIG, so the check follows the configuration Docker really passes."""
    try:
        runtimes = json.loads(DAEMON_JSON.read_text()).get('runtimes') or {}
        named = ((runtimes.get(KATA_RUNTIME) or {}).get('options') or {}).get('ConfigPath')
    except (OSError, ValueError, AttributeError):
        return KATA_CONFIG
    return Path(named) if isinstance(named, str) and named.startswith('/') else KATA_CONFIG


def _guest_seccomp_on(config: Path) -> bool:
    """Whether the Kata configuration turns guest seccomp on: `disable_guest_seccomp = false` (Q19), in `[runtime]`
    where Kata reads it, and set nowhere else to anything but false; an unreadable or unparsable file is not on."""
    try:
        parsed = tomllib.loads(config.read_text())
    except (OSError, tomllib.TOMLDecodeError):
        return False
    found = []

    def walk(table: Mapping[str, Any]) -> None:
        for name, value in table.items():
            if name == 'disable_guest_seccomp':
                found.append(value)
            elif isinstance(value, Mapping):
                walk(value)

    walk(parsed)
    runtime = parsed.get('runtime')
    return (
        isinstance(runtime, Mapping)
        and runtime.get('disable_guest_seccomp') is False
        and all(value is False for value in found)
    )


def _entry_type(debugfs_stat: str) -> str | None:
    """The `Type:` of debugfs's `stat` output (`directory`, `symlink`, `regular`, ...), None when not found."""
    for line in debugfs_stat.splitlines():
        if 'Type:' in line:
            return line.split('Type:', 1)[1].split()[0]
    return None


def _is_mounted(loop: str) -> bool:
    """Whether the loop device is mounted anywhere this process can see (its major:minor in mountinfo)."""
    number = (SYS_BLOCK / loop / 'dev').read_text().strip()
    with open('/proc/self/mountinfo') as mounts:
        return any(line.split()[2] == number for line in mounts)


def _remove_except(top: Path, keep: Mapping[str, bytes]) -> None:
    """Remove every entry of `top` not named in `keep`, never following a symlink."""
    for entry in os.scandir(top):
        if entry.name not in keep:
            if entry.is_dir(follow_symlinks=False):
                shutil.rmtree(entry.path)
            else:
                os.unlink(entry.path)


def _holds(path: Path, content: bytes) -> bool:
    """Whether `path` is already a regular file, mode 0444, holding exactly `content`."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    if not stat_module.S_ISREG(info.st_mode) or info.st_mode & 0o7777 != 0o444 or info.st_size != len(content):
        return False
    return path.read_bytes() == content


def _key_of(labels: Mapping[str, str], scope: str) -> str | None:
    """The `lllm.chat` label when it is a canonical UUID and `lllm.scope` is `scope`; else not this backend's.

    The scope is checked here too, not only by the daemon's label filter.
    """
    if labels.get('lllm.scope') != scope:
        return None
    try:
        return validate_chat_id(labels.get('lllm.chat', ''))
    except ValueError:
        return None
