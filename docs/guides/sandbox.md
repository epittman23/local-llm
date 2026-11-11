# The code sandbox

> **Under construction.** The sandbox described in
> [docs/proposals/sandbox-code-interpreter.md](../proposals/sandbox-code-interpreter.md)
> is being built on the `feat/sandbox-code-interpreter` branch (PR #884).
> Nothing in the app uses it yet: the code interpreter is still Jupyter.
> This guide grows with the build; so far it covers the host setup, the
> images and the backend.

Each chat's code runs in its own microVM: a Kata Containers container whose
runtime boots a Cloud Hypervisor VM with its own guest kernel, started by
the existing Docker Engine under the runtime name `kata-clh`.

## Host setup

Done once per machine, as root. On the laptop this was done on 2026-11-10
(Fedora 44, kernel `7.2.8-200.fc44.x86_64`, Docker Engine 29.8.2 with
containerd 2.3.6, SELinux enforcing).

### Requirements

```sh
grep -cE 'vmx|svm' /proc/cpuinfo   # non-zero: hardware virtualization is on
ls -l /dev/kvm                     # present
```

Kata's shim runs under `dockerd` as root, so the user needs no `kvm` group
membership.

### Which Kata

Upstream's static release **4.3.1** with the Rust runtime (runtime-rs, the
default since 4.0), under `/opt/kata`. Not Fedora's `kata-containers`
package: Fedora 44's 3.26.0 is QEMU-only (it requires `qemu-kvm-core`,
ships one QEMU configuration and has no Cloud Hypervisor binary), and
Fedora packages no Cloud Hypervisor. Not the Go runtime
(`kata-go-static-*`), which is deprecated since 4.0. The owner's decision
is in the proposal's Decisions table ("Kata release and runtime").

### Install

1. Download both amd64 tarballs from the
   [4.3.1 release](https://github.com/kata-containers/kata-containers/releases/tag/4.3.1)
   and check them against the SHA-256 digests the release lists:
   ```sh
   sha256sum -c <<'EOF'
   1463a2b86845f4d3d8e87f2f764ec59856fc0fee3520967a79ade32762be2e97  kata-static-4.3.1-amd64.tar.zst
   511262aadef2a8596355733e448b65f7c871f4c6118b44ef7eb18afc19a5c0dd  kata-tools-static-4.3.1-amd64.tar.zst
   EOF
   ```
2. Unpack **only `./opt/kata`**. Both tarballs also hold a `./` entry with
   mode `0755`, so extracting the whole archive at `/` as root would change
   `/` from Fedora's `0555`:
   ```sh
   sudo tar --zstd -xf kata-static-4.3.1-amd64.tar.zst -C / ./opt/kata
   sudo tar --zstd -xf kata-tools-static-4.3.1-amd64.tar.zst -C / ./opt/kata
   ```
   The two overlap only in `/opt/kata/VERSION` and `versions.yaml`, which
   are identical. Upstream ships `cloud-hypervisor`, `virtiofsd` and
   `kata-ctl` as mode `0744`, so only root can run them; leave them so.
3. Register the runtime in `/etc/docker/daemon.json` (merge with anything
   already there), then `sudo systemctl restart docker`:
   ```json
   {
     "runtimes": {
       "kata-clh": {
         "runtimeType": "/opt/kata/runtime-rs/bin/containerd-shim-kata-v2",
         "options": {
           "ConfigPath": "/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-clh-runtime-rs.toml"
         }
       }
     }
   }
   ```
   The `ConfigPath` option is what selects Cloud Hypervisor: runtime-rs's
   default `configuration.toml` is a link to the QEMU configuration.
   Docker hands any runtime other than runc its `options` as containerd's
   `runtimeoptions.v1.Options`, which the shim reads. **Do not use a
   wrapper script that sets `KATA_CONF_FILE`** (kata-deploy's older
   approach): since 4.3, runtime-rs accepts `KATA_CONF_FILE` only when it
   resolves to one of its default configuration paths, and fails every
   container with `invalid KATA_CONF_FILE ...: only shipped Kata
   configuration files are accepted` otherwise
   (`src/runtime-rs/crates/runtimes/common/src/config.rs` at the 4.3.1
   tag).

### Check

```sh
sudo /opt/kata/bin/kata-ctl check no-network-checks   # exits 0
docker info --format '{{range $k,$v := .Runtimes}}{{$k}} {{end}}'   # lists kata-clh
docker run --rm --runtime kata-clh alpine uname -r   # the guest kernel, not the host's
sudo /opt/kata/bin/cloud-hypervisor --version
sudo /opt/kata/libexec/virtiofsd --version
```

`kata-runtime check` is the Go runtime's command; with runtime-rs the
check is `kata-ctl check`. On the laptop it printed only `INFO check CPU:
x86_64` and exited 0.

Recorded 2026-11-10 on the laptop:

| Check | Result |
|---|---|
| Kata | 4.3.1 (`/opt/kata/VERSION`), runtime-rs |
| Cloud Hypervisor | v54.0 |
| virtiofsd | 1.14.0 (Kata's own, `/opt/kata/libexec/virtiofsd`) |
| `kata-ctl check no-network-checks` | exit 0 |
| `uname -r` in `docker run --rm --runtime kata-clh alpine` | `6.18.56` (host: `7.2.8-200.fc44.x86_64`); 1.3 s wall clock for the whole `docker run` with the image cached |
| Host processes while one such container runs | one `cloud-hypervisor`, two `virtiofsd`, one `containerd-shim`; none after it is removed |
| SELinux AVC denials (`ausearch -m avc -ts today`) | none |

The Cloud Hypervisor configuration sizes each VM statically from the
container's limits (`static_sandbox_resource_mgmt = true`), shares files
over virtio-fs, and defaults to 1 vCPU and 2048 MiB when a container sets
no limits.

### What Kata changes

Proved on the laptop on 2026-11-10 (task T02 of the implementation plan)
with throwaway containers carrying the options the sandbox will use:
`--runtime kata-clh --user 1000:1000 --cap-drop ALL --security-opt
no-new-privileges --memory 4g --cpus 2 --pids-limit 512 --ulimit
nproc=512:512 --read-only --tmpfs /tmp:size=256m`, a named volume at
`/workspace`, on an `internal` network. Most options behave as under
runc; these do not:

- **`--pids-limit` is ignored.** Inside the guest the container's
  `pids.max` is `max`, and a fork bomb run as UID 1000 reached 15,849
  processes, stopped only by the guest kernel's own default limit. The
  per-UID `--ulimit nproc=512:512` is enforced, `docker exec` processes
  included (the same bomb stopped at 516 processes in the guest), so the
  sandbox passes both. The host stayed responsive either way: the VM has
  3 vCPUs and 4 GiB.
- **An internal network does not fence off the host** (Docker, not
  Kata; found 2026-11-11). The host's side of the bridge keeps its own
  IPv4 address, the gateway, and a guest reaches every host service
  listening on `0.0.0.0` through it, as a runc container would. T02's
  check above tried only the host's LAN address, `docker0` and a public
  address. With the bridge option
  `com.docker.network.bridge.inhibit_ipv4=true` the bridge has no
  address: the host is unreachable from the guest, and a peer on the
  network (the mirror) still is. The backend refuses a sandbox network
  without it ("Backend", "Checks"). IPv6 is a second way through
  (T16's security review, 2026-11-11): the bridge keeps a link-local
  `fe80::` address, and a guest reached host listeners on `::` through it.
  The backend turns IPv6 off in every guest
  (`net.ipv6.conf.all.disable_ipv6=1` and `.default.`, as container
  sysctls), so a guest has no IPv6 address at all; the host side
  (owner decision Q20, T16) keys a rule on the bridge's fixed name,
  `lllm-sandbox`.
- **Container names do not resolve.** The guest's `/etc/resolv.conf`
  names Docker's embedded DNS server, `127.0.0.11`, which answers only
  through iptables rules in the container's network namespace on the
  host, not inside the VM. Peers on the network are reachable by IP, and
  by name through `--add-host` (`/etc/hosts`, which UID 1000 cannot
  change), which is how a sandbox finds `sandbox-mirror`.
- **A VM keeps memory it has touched.** After a process was OOM-killed
  in the guest at about 3.8 GiB, `cloud-hypervisor` still held 4.2 GB of
  host memory; it is returned only when the sandbox stops.
- **The root file system is shared over virtio-fs**, read-only with
  `--read-only`, like the `/workspace` volume. Writes through the Docker
  archive API (`put_archive`) into a read-only root are refused; into
  the volume they keep the tar headers' owners and modes.
- **No seccomp in the guest by default.** Kata's shipped configuration
  sets `disable_guest_seccomp = true`: measured 2026-11-11 (data image,
  the backend's options, UID 1000), `Seccomp: 0`, no Yama
  (`/proc/sys/kernel/yama` absent), `unshare -U -r` allowed (so user
  namespaces expose nf_tables, mounts and the like to UID 1000), and
  ptrace of another UID 1000 process allowed. With guest seccomp on
  (owner decision Q19, "Guest seccomp" below): `Seccomp: 2`,
  `Seccomp_filters: 1`, `unshare -U -r` refused ("Operation not
  permitted"), ptrace of another UID 1000 process still allowed (Docker's
  default profile permits it on kernels 4.8 and later), and the tools the
  sandbox offers all work: an offline `pip install --user` that imports in
  the next call, R with dplyr, a `latexmk -pdf` build with `biber`, and a
  headless Chromium screenshot with Playwright. Chromium's own sandbox
  cannot start (it needs the user namespaces seccomp refuses), so
  Playwright's default, `chromiumSandbox: false`, is the one that works;
  the VM and seccomp are the boundary around it.

Measured the same day on the laptop (Intel Core i9-12900H, 62 GiB,
Fedora 44 kernel `7.2.8-200.fc44.x86_64`; Kata 4.3.1 runtime-rs, Cloud
Hypervisor v54.0, Docker 29.8.2), five runs each, with the options above:

| Image | `docker run -d` to the first `docker exec` output | Idle host RSS, `cloud-hypervisor` + `virtiofsd` |
|---|---|---|
| `quay.io/jupyter/scipy-notebook:2026-10-12` | 0.99-1.03 s | 381-395 MiB |
| `alpine:latest` | 0.99-1.06 s | 290-295 MiB |

### Guest seccomp

Kata's guest applies no seccomp filter unless its configuration says so.
Owner decision Q19 (2026-11-11) turns it on, so the container's seccomp
profile (Docker's default) applies inside the VM too: it refuses user
namespaces and the other calls the default profile blocks, which narrows
what UID 1000 can reach of the guest kernel. In
`/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-clh-runtime-rs.toml`,
set:

```toml
disable_guest_seccomp = false
```

(keep the original beside it, `sudo cp -p <file> <file>.orig`, first).
New sandboxes pick it up; running ones keep what they started with.
Check:

```sh
docker run --rm --runtime kata-clh --user 1000:1000 alpine sh -c \
  'grep -E "^Seccomp" /proc/self/status; unshare -U -r true && echo userns allowed || echo userns refused'
# Seccomp: 2, Seccomp_filters: 1, userns refused
```

Undo: `sudo mv <file>.orig <file>`. Done on the laptop on 2026-11-11.

### Loop devices for the workspaces

Each workspace is an ext4 image the backend attaches to a loop device with
udisks2 (see "Backend", "The workspace volume"). polkit lets a user do
that without a password only inside an active local login session, so
this rule lets the backend's user do it from any session, a headless
server's included (owner decision Q18). It grants exactly one action,
`org.freedesktop.udisks2.loop-setup`, to one user: udisks2 lets a user
delete a loop device it attached itself without asking polkit, and it
passes polkit no details of the file for a loop setup, so the rule cannot
be narrowed to the image directory. Replace `<user>` with the user the
backend runs as (`epittman` on the laptop).

`/etc/polkit-1/rules.d/50-local-llm-sandbox.rules`:

```js
// local-llm code sandbox (docs/guides/sandbox.md, "Host setup"): lets the
// backend's user attach its workspace images as loop devices without a login
// session, for the fixed-size workspaces (Q18). Nothing else is granted.
polkit.addRule(function (action, subject) {
    if (action.id == "org.freedesktop.udisks2.loop-setup" && subject.user == "<user>") {
        return polkit.Result.YES;
    }
});
```

Install it with `sudo install -m 0644 -o root -g root
50-local-llm-sandbox.rules /etc/polkit-1/rules.d/`; polkitd reloads its
rules by itself (polkitd 127 logs nothing when a rule loads cleanly; a
rule with a JavaScript error shows up in `journalctl -u polkit`). Check
that a scratch image attaches and detaches:

```sh
f=$(mktemp --suffix=.img) && truncate -s 16M "$f"
udisksctl loop-setup --no-user-interaction -f "$f"   # "Mapped file ... as /dev/loopN"
udisksctl loop-delete --no-user-interaction -b /dev/loopN && rm "$f"
```

Installed on the laptop on 2026-11-11, with `<user>` = `epittman`. What it
grants was checked by running the rule under node against stub objects:
`yes` for `loop-setup` by that user with no local or active session,
nothing for any other action or user. Its effect cannot be shown on the
laptop while a desktop session is active: polkit maps a process outside
any session (a `systemd-run --user` service, say) to the user's active
seat0 session, which `allow_active=yes` already admits, and the laptop
runs no `sshd`, whose sessions are remote. It is to be proved on the home
server, with nobody logged in.

### No IPv6 on the sandbox bridge

Docker's `internal` network and `inhibit_ipv4` leave the bridge its IPv6
link-local address, and a sandbox that reached it could talk to any host
listener bound to `::` (KDE Connect's port 1716 answered in T16's security
review). The backend starts every sandbox with IPv6 disabled in the guest;
this rule is the host's own layer, which a compromised guest kernel cannot
undo (owner decision Q20). The Compose file gives the bridge the fixed name
`lllm-sandbox` (`com.docker.network.bridge.name`), and udev turns IPv6 off on
that interface when it appears. It touches nothing else.

`/etc/udev/rules.d/90-local-llm-sandbox.rules`:

```udev
# local-llm code sandbox (docs/guides/sandbox.md, "Host setup"): no IPv6 on the
# sandbox network's bridge, so a sandbox cannot reach host listeners over IPv6
# link-local addresses even if its guest kernel were compromised.
ACTION=="add", SUBSYSTEM=="net", KERNEL=="lllm-sandbox", RUN+="/usr/sbin/sysctl -q -w net.ipv6.conf.lllm-sandbox.disable_ipv6=1"
```

Install it with `sudo install -m 0644 -o root -g root
90-local-llm-sandbox.rules /etc/udev/rules.d/` and `sudo udevadm control
--reload`. It applies when the bridge is created, so an existing network
needs recreating (`docker compose down`, with no sandbox attached, then `make
backend`). Check, with the network up:

```sh
ip -6 addr show dev lllm-sandbox                   # prints nothing
cat /proc/sys/net/ipv6/conf/lllm-sandbox/disable_ipv6   # 1
```

Without the rule the guest's own setting still holds; the backend does not
check for the rule.

### Undo

```sh
sudo rm -rf /opt/kata
sudo rm /etc/docker/daemon.json   # or remove only the kata-clh entry
sudo systemctl restart docker
sudo rm /etc/polkit-1/rules.d/50-local-llm-sandbox.rules
sudo rm /etc/udev/rules.d/90-local-llm-sandbox.rules
sudo mv /opt/kata/share/defaults/kata-containers/runtime-rs/configuration-clh-runtime-rs.toml.orig \
  /opt/kata/share/defaults/kata-containers/runtime-rs/configuration-clh-runtime-rs.toml
```

## Images

Two images, both built from `infra/sandbox/` by `make sandbox-images` and
tagged `local-llm/sandbox-<key>:<tag>`. The model chooses between them per
chat (`data` is the default); see the proposal's
[Images](../proposals/sandbox-code-interpreter.md#images) section.

| Image | Base | Contains | Size (2026-11-11) |
|---|---|---|---|
| `sandbox-data` | `quay.io/jupyter/scipy-notebook:2026-10-12` (Ubuntu 26.04, conda Python 3.13) | pandas 3.0.6, scipy 1.18.1, scikit-learn 1.9.1 and the rest of scipy-notebook (`image-freeze.txt`); R 4.5.3 from conda-forge with tidyverse, data.table, broom, lme4 and survival, pinned in `data/environment-r.yml`; TeX Live 2025 (`scheme-small` plus the `latexrecommended`, `latexextra`, `fontsrecommended`, `mathscience`, `bibtexextra` and `pictures` collections, `latexmk`, `biber`) | 8.89 GB (base 5.39 GB) |
| `sandbox-web` | `node:26.13.0-trixie-slim`, pinned by digest (the Node.js LTS line, Debian 13) | TypeScript 6.0.3, `tsx`, ESLint, Prettier and Playwright 1.65.0 with headless Chromium (`/opt/pw-browsers`), from `web/package.json` and `web/package-lock.json` (npm) | 2.28 GB |

Both also hold the common tools (`common/install-common.sh`): `bash`, `git`,
`sqlite3`, `poppler-utils`, `file`, `xxd`, `procps`, `tini` and the DuckDB CLI (v2.0.0, checked
against a pinned SHA-256), and `/usr/local/bin/lllm-path`, the path
confinement helper the file tools call.

Both run as UID 1000 with `/workspace` (the per-chat volume's mount point)
created owned by `1000:1000` in the image, so an empty named volume
inherits that ownership; the backend's ext4 workspace volumes get theirs
from `mkfs` instead. GID 1000 has a name (`sandbox` in `data`, `node`
in `web`). `/workspace/.local/bin` is last on `PATH`, after the image's own
directories, so a model-written file cannot shadow `timeout` or `bash`;
`web` also appends it from `/etc/profile.d`, because Debian's `/etc/profile`
resets `PATH` for the login shell the manager runs. Both images set
`ENTRYPOINT ["tini", "-g", "--"]` and `CMD ["sleep", "infinity"]`.

What is pinned, and what is not:

- Pinned: the base images (both by digest as well as tag), R's six top-level packages, the TeX Live release (from
  the final, frozen 2025 archive, so a rebuild installs the same packages;
  2026's is not frozen yet), DuckDB, and the npm packages with integrity
  hashes. `typescript` is 6.0.x because `typescript-eslint` 8.72 does not
  yet accept 7.
- Not pinned: apt packages (`git`, `sqlite3`, `poppler-utils`, Chromium's
  system libraries) follow the base's distribution release, since archives
  drop old versions; Playwright's Chromium is pinned only by Playwright's
  version; R's dependencies resolve at build time. What actually landed is
  recorded: `infra/sandbox/image-freeze.txt` (Python, `pip list
  --format=freeze`; conda's `pip freeze` prints `file://` paths) and
  `infra/sandbox/image-freeze-r.txt` (R packages), both committed and
  rewritten by `make sandbox-images`.

Notes on the build:

- The base ships a small Ubuntu TeX Live for notebook PDF export; the data
  image removes it, so `latexmk` and `kpsewhich` are the pinned 2025 ones.
  `data/texmf.cnf` (at the TeX tree's root) sets `shell_escape = f` and
  `openout_any = p`, and points `TEXMFVAR` and `TEXMFCONFIG` into `/tmp`
  so fonts generated on the fly work on a read-only home. `\write18` is
  reported "disabled". That stops a document built with the defaults from
  running commands; it is not a boundary against the model, which has
  `bash`. TeX Live's repository is signature-verified by `install-tl`.
- `biber` is a PAR-packed binary that unpacks itself and runs from the
  unpacked copy. The sandbox's `/tmp` is a `noexec` tmpfs, so the data
  image puts a root-owned wrapper (`data/biber`) at `/usr/local/bin/biber`,
  ahead of the TeX tree on `PATH`: it creates `/workspace/.cache/par` and
  runs the real biber with `PAR_GLOBAL_TMPDIR` pointing there (it fails
  with a message if the directory cannot be made). It does not depend on
  what the image put in `/workspace`. The first biber run leaves about
  121 MB there, which counts toward the workspace cap.
- `MPLCONFIGDIR` and `XDG_CACHE_HOME` point into `/tmp` in the data image,
  so matplotlib and fontconfig print no cache warnings on a read-only home.
- The web image links `/node_modules` to `/opt/sandbox-web/node_modules`,
  so `import` from a `.mjs` or `.ts` file anywhere under `/workspace`
  resolves the baked-in packages (`NODE_PATH` covers `require`).
- `npm audit` reports 10 moderate findings (minimatch denial of service in
  the lint tooling); accepted, since the sandbox has no network and the
  tools run on the model's own files.
- The TeX collections include no XeTeX or LuaTeX, so documents using
  `fontspec` do not build; use `latexmk -pdf`.
- Setuid and setgid bits are stripped from both images.
- The `PATH` rule above (nothing the model writes shadows `timeout` or
  `bash`) rests on the read-only root filesystem the backend runs the
  containers with: the base leaves `/opt/conda`, first on `PATH`, owned by
  UID 1000.
- `data` is about 19 minutes from clean, almost all of it TeX Live (2,700
  packages) and the R install; `web` a few minutes.

### Rebuilding and the tag

```sh
make sandbox-images
```

builds both and rewrites `infra/sandbox/image-freeze.txt` and `image-freeze-r.txt`. The tag is the
one line in `infra/sandbox/TAG` (`2026-11-11.2`: the date, then a counter
for that day). Any change to an image bumps it, because the tag is what
the manager starts and what benchmark runs record. The backend holds the
same value in a constant, so bump both together. Pre-existing containers keep their old image until they are
recreated.

## Mirror and wheelhouse

A sandbox has no route to the internet, so `pip install` cannot reach PyPI.
It reaches one thing: the `sandbox-mirror` service (nginx, in
`infra/docker-compose.yml`), which serves a directory of wheels as a file
index. The `data` image sets `PIP_NO_INDEX=1`,
`PIP_FIND_LINKS=http://sandbox-mirror:8000/`, `PIP_TRUSTED_HOST=sandbox-mirror`
(pip ignores a plain-http source otherwise), `PIP_ONLY_BINARY=:all:`,
`PIP_USER=1` and `PYTHONUSERBASE=/workspace/.local`, so an install lands in
the chat's workspace and imports in the next call. The `web` image has no pip.
Because of `PIP_USER=1`, `pip list` inside a sandbox shows only what was
installed there; the image's own packages need
`PIP_USER=0 pip list` (`make sandbox-images` does that for
`image-freeze.txt`).

What can be installed is decided on the host, in three files under
`infra/sandbox/`:

- `allowlist.in`: the approved extra packages, one per line, each with a
  comment saying why. The first four (the owner's choice, 2026-11-11) are
  `polars`, `duckdb`, `pingouin` and `lifelines`.
- `requirements.lock`: the allowlist and everything it needs, pinned with
  hashes, compiled against the image's own packages (`image-freeze.txt`) so
  nothing the image carries changes. Its first lines hold the command.
- `mirror/nginx.conf`: the mirror's configuration, committed.

`make wheelhouse` downloads exactly what the lock names, binary wheels only
and hash-checked (`pip download --only-binary=:all: --require-hashes`), into
`apps/server/data/sandbox/wheelhouse`. It runs in a throwaway `sandbox-data`
container on the default network, so the wheel tags match what a sandbox
installs, and it is the only step that reaches PyPI. A failed download leaves
the served wheels alone. `make backend` starts the mirror with the other
services and creates the directory if it is missing.

### Adding a package

1. Add it to `allowlist.in` with a comment saying why.
2. Recompile the lock from `infra/sandbox/` (the command is in the lock's
   header; it includes `--only-binary :all:`, so a dependency with no wheel
   fails here rather than in a sandbox):
   `uv pip compile allowlist.in -c image-freeze.txt --generate-hashes --only-binary :all: --python-version 3.13 --python-platform x86_64-manylinux_2_28 -o requirements.lock`.
3. `make wheelhouse`. The mirror serves the new files at once; nothing needs
   restarting.

`make wheelhouse` starts from an empty download directory, checks every file
against the lock's hashes before anything is moved in, then moves the new
files in and removes the ones the lock no longer names, so the mirror is never
empty. Sandbox-side pip does not check hashes: what sits in the wheelhouse is
what a sandbox can install. A failed download or check leaves the served
wheels alone; only the last removal is not atomic, and a failure there leaves
old wheels served. A fresh checkout serves an empty wheelhouse until `make
wheelhouse` runs; `make backend` works without it, and installs just fail.
A subnet clash (`10.231.0.0/24` already used by another Docker network or
route) makes the mirror's `up`, and so `make backend`, fail.

A package with no binary wheel cannot be listed. Anything not in the lock
fails inside a sandbox with `No matching distribution found`, and so does an
older version of a listed package.

### What the mirror can and cannot reach

- The `sandbox` network is `internal: true`: no route to the internet, the LAN
  or any other Docker network, and no name resolves (Docker's resolver
  answers SERVFAIL for outside names on it). The subnet `10.231.0.0/24`, the
  range sandboxes get addresses from (`10.231.0.128/25`) and the mirror's
  address (`10.231.0.2`) are fixed, because container names do not resolve
  inside a Kata guest; the backend passes the mirror as `extra_hosts`
  (`sandbox/kata.py` holds the same values, and
  `tests/test_sandbox_compose.py` checks they agree with Compose). The bridge
  has no IPv4 address (`com.docker.network.bridge.inhibit_ipv4`, no
  `gateway:`): an address on the host's side would let a sandbox reach host
  listeners bound to 0.0.0.0, such as the backend in LAN mode or llama-server.
- **The host is not fully closed: IPv6 link-local.** `internal` and
  `inhibit_ipv4` do not remove the bridge's IPv6 link-local address, and a
  Kata guest with IPv6 enabled reaches host listeners on `::` through it (found
  in T16's security review: KDE Connect's port 1716 answered from a sandbox).
  The first layer is in the guest: the backend starts every sandbox with
  `net.ipv6.conf.all.disable_ipv6` and `net.ipv6.conf.default.disable_ipv6`
  set to 1, which UID 1000 cannot undo. The second is on the host: the bridge
  has a fixed name (`lllm-sandbox`, `com.docker.network.bridge.name`) and a
  udev rule turns IPv6 off on it when it appears (Host setup, "No IPv6 on the
  sandbox bridge"; owner decision Q20).
- The mirror is on that network only, so it cannot reach PyPI either:
  `wget https://pypi.org` from it fails. It has no published port, a
  read-only root and read-only wheelhouse, UID 101 on port 8000 with every
  capability dropped, and it answers `GET` and `HEAD` for files only, with
  short timeouts and at most 8 connections per sandbox address. Its log is
  one JSON line per request on stdout (`docker logs local-llm-sandbox-mirror`),
  capped at three 10 MB files, because a sandbox chooses what it requests;
  the package telemetry (T21) that reads it must keep up with that rotation.
- `docker compose down` with sandboxes attached exits 0 but leaves the
  network ("Resource is still in use"); that is expected. The next `up`
  reuses it.

## Backend

`apps/server/local_llm/sandbox/kata.py`, `KataDockerBackend`: the only
code that talks to Docker for the sandbox, called only by the manager
(`sandbox/manager.py`). Every Docker SDK call runs in a thread, and every
SDK, daemon or host-tool error reaches the caller as a `SandboxError` with
fixed wording (the SDK's own text carries the daemon URL and host paths);
the original is logged. `main.py`'s lifespan starts the manager with it
(`sandbox/lifespan.py`), runs the startup sweep and the maintenance loop,
and stops it on shutdown, stopping running sandboxes only under
`LLLM_STOP_JOBS_ON_SHUTDOWN`. The app starts whatever the host can do:
`GET /api/v1/sandbox/status` (the admin page) shows why sandboxes cannot
run, and each call is refused with the same reason. The manager runs in
one server process only, since its per-chat lock is per process: it stays
off when uvicorn is given more than one worker (`--workers`,
`WEB_CONCURRENCY`, `UVICORN_WORKERS`), and holds a lock on
`DATA_DIR/sandbox/manager.lock`, so a second server sharing the data
directory leaves it off too.

### What each sandbox gets

A container `lllm-sandbox-<key>` (the key is the manager's UUID for the
chat) under `kata-clh`, with fixed options only (`container_options()` in
`kata.py`): the image for `data` or `web`; the container's user
`65534:65534` (`nobody`) with `init=True`, so PID 1 is Docker's tini
running `/usr/bin/sleep infinity`, both as `nobody` (owner decision Q16;
the backend replaces the images' own `tini` entrypoint, so one init
runs); `cap_drop=ALL`, `no-new-privileges`, a read-only root, `/tmp` a
256 MiB tmpfs, 4 GiB of memory and 2 CPUs, `pids_limit=512` (not enforced
by Kata 4.3.1) and `nproc=512` (enforced; Q8), Jupyter's inherited health
check off, the `local-llm_sandbox` network and a hosts entry
`sandbox-mirror` → `10.231.0.2` (names do not resolve in a Kata guest;
Q9), and IPv6 off in the guest (`net.ipv6.conf.all.disable_ipv6` and
`net.ipv6.conf.default.disable_ipv6` set to 1). The labels `lllm.chat`, `lllm.image` and, for an unsaved chat,
`lllm.ephemeral=1` let `list_sandboxes()` and the sweeps find them, and
`lllm.scope` keeps another app instance on the same Docker daemon out:
`make test-boot` runs the real app with a `DATA_DIR` of its own and
`LLLM_STOP_JOBS_ON_SHUTDOWN=true`, and must not sweep, reuse or stop the
sandboxes of a backend running beside it. The scope is a random id made
once in `DATA_DIR/sandbox/volumes/scope`, so it moves with the data
directory; a container or volume of another scope found by name is left
alone.

Every command runs as `1000:1000` in `/workspace`. After each one the
backend kills every UID 1000 process (Q10): an exec as UID 1000 sends
`kill -9 -1` repeatedly, then an exec as `nobody` checks that `/proc`
lists no UID 1000 process, zombies included, up to three rounds in 10 s.
A check's pass counts only if no PID was allocated in the guest while it
ran (the last-PID field of `/proc/loadavg`, unchanged across the pass,
which itself forks nothing): a process that keeps forking and letting its
parent exit is in no listing a scan reads, but every hop allocates a PID
(T14's security re-review). The kill stops as soon as `/proc` lists no
other UID 1000 process, so a call that leaves nothing behind costs about
0.2 s in all (20 `true` calls: median 1.38 s with a fixed 20 kill passes,
0.19 s with the early stop; data image, laptop, 2026-11-11).
Only the check decides: a UID 1000 process that survived can ptrace the
kill (guest seccomp allows it) and make it exit 0, but cannot trace or
signal `nobody` (T14's security review, B1; proved on Kata with the
reviewer's proof of concept). UID 1000 cannot signal `nobody`, so PID 1
survives and reaps what was killed: on the data image, 300 calls that each
left background `sleep`s kept the process count flat with no zombies. When
the kill cannot be confirmed (a fork bomb at the `nproc` limit can stop it
from starting), the backend stops the sandbox and the call fails; the
files stay and the next call starts it again. Two things about Kata shape
how a call ends:

- A background child that inherits the command's stdout holds the exec's
  stream open, and the daemon then reports the exec as running until that
  child exits. So after 0.25 s a second exec, run as `nobody` so the
  command cannot kill it, watches `/proc` for the command's main process
  (the UID 1000 process whose parent is outside the guest); once it is
  gone the kill runs, which closes the stream. `sleep 300 & echo hi`
  returns in about half a second, not as a timeout.
- `kill -0 -1` cannot tell whether processes are left: kill(2) with -1
  succeeds whenever any process is visible, even one it may not signal,
  such as PID 1's `sleep`. The check reads `/proc/*/status` instead.

Command streams are read and written in the backend's own thread pool, so
however many commands are running, the waits and the kills always find a
thread.

Uploads are not on the workspace volume: `/workspace/uploads` is a
read-only bind of `DATA_DIR/sandbox/uploads/<key>`, a directory the
backend makes at create and fills with `put_uploads` (each file written
beside it and renamed in, mode `0444`; unchanged files kept; others
removed), then waits until the guest sees exactly that set (names and
inodes). Checked inside the guest, not only Docker's flag: as UID 1000,
writing, `chmod`, removing or creating anything there fails with "Read-only
file system", and renaming or removing the directory with "Device or
resource busy"; root in the guest (no capabilities) cannot remount it.
The files show as owned by the backend's user (UID 1000 on the laptop),
which the read-only mount makes harmless. The host side is read-only too:
Kata's share of the directory (under `/run/kata-containers/shared/sandboxes/<id>/`)
is a read-only bind, so even guest root after a guest-kernel escape could
not write the directory the backend later handles. `put_uploads` removes
stale files before it writes new ones, so a failed put leaves fewer files,
never removed ones; `stop` empties the directory (every start puts the
uploads again), so a stopped sandbox keeps none on the host's disk, outside
the workspace's cap; `destroy` removes it. A workspace used before the
mount existed can hold a symlink or file named `uploads` (UID 1000 cannot
make one while the mount is there, a busy mount point): left alone, the
guest mounted the uploads where such a symlink pointed (`/tmp`, `/etc`),
and a file made the create fail, so `create` removes such an entry first,
with debugfs on the unmounted, detached image.

`put_files` writes through Docker's archive API as root, then waits until
the guest sees the new directory, root-owned `0555` with exactly the files
written: the guest reaches `/workspace` through
virtio-fs, which caches names and attributes for a second
(`virtio_fs_cache = "auto"` in Kata's configuration), so straight after a
replace a command could still see the old entry or get "Stale file
handle".

### The workspace volume

Each `/workspace` is a fixed-size ext4 filesystem (Q11), so a runaway
write fills the workspace (`No space left on device`), not the host's
disk. The backend makes a sparse 10 GiB image file,
`DATA_DIR/sandbox/volumes/<key>.img` (mode `0600`), formats it with
`mkfs.ext4 -b 4096 -m 0 -U <key> -E root_owner=1000:1000`, covering
all but the image's last 4 MiB, and removes `lost+found` with `debugfs`,
attaches it to a loop device with `udisksctl loop-setup
--no-partition-scan`, and creates a Docker local volume
`lllm-sandbox-<key>` of type `ext4` on `/dev/disk/by-uuid/<key>` (mount
options `nosuid,nodev`). The tail the filesystem leaves
unused is where blkid looks for RAID and other end-of-device signatures:
a file of md superblocks filling a workspace turns `blkid -p` on an image
without the gap into `linux_raid_member`, which would remove the
`by-uuid` link (and the workspace) at the next attach; with the gap it
stays `ext4` with the key (T14's security review, S1). Docker's local driver cannot attach a loop device
itself (`o=loop` fails: it calls mount(2), and `loop` is a mount(8)
option), and udisks does it without root. Before each create the backend
attaches the image again if it is not attached (after a reboot, say), and
`destroy` removes the container, detaches the loop device, deletes the
file and removes the volume last, so a destroy cut short leaves the volume
listed and a sweep tries again. An image file left without a volume (a
create cut short) is listed as a stopped ephemeral sandbox, so the sweeps
destroy it; a volume whose image file is gone is made afresh. A stopped
sandbox keeps its volume and file.

Every call is bounded: create 120 s, stop and destroy 60 s, the file calls
120 s, the post-exec kill 10 s with every daemon call in it, and its
fail-closed stop 10 s. A call that times out leaves its worker thread
running (Python cannot stop it), so create, stop, destroy and `put_files`
hold a per-sandbox lock in the thread: the next of them waits for it, and
a create given up on starts no VM, or removes the one it started.

This needs, on the host: `udisks2` (`udisksctl`; Fedora installs it),
`e2fsprogs` (`mkfs.ext4`, `debugfs`), and permission for the backend's
user to attach loop devices. polkit's default policy for
`org.freedesktop.udisks2.loop-setup` allows that without a password only
inside an active local login session (`allow_active=yes`), so the owner
chose (Q18) a polkit rule granting it to the backend's user, so it works
headless too; the rule is a root step in "Host setup". Detaching needs
no rule: udisks lets the user who attached a loop device delete it.
`ready()` reports a missing tool.

### Checks

`ready()` reports the first of these that fails, as the admin page shows
it: the Docker daemon answers; it has the `kata-clh` runtime; Kata's
configuration turns guest seccomp on (`disable_guest_seccomp = false`
under `[runtime]`, in the file `/etc/docker/daemon.json` names as the
`kata-clh` runtime's `ConfigPath`, or the default path when it names
none);
both images
exist; the `local-llm_sandbox` network exists and is the fenced one (a
bridge, internal, subnet `10.231.0.0/24` with dynamic range
`10.231.0.128/25`, `com.docker.network.bridge.inhibit_ipv4=true`, and
the bridge named `lllm-sandbox`, IPv6 not enabled); the host has IPv6
off on that bridge (`/proc/sys/net/ipv6/conf/lllm-sandbox/disable_ipv6`
is 1, the host-side rule of Q20); the scope id file is readable;
the volume tools exist; the `sandbox-mirror` container runs. Every new sandbox is also checked from
inside before its first command, by an exec as `nobody`: the guest must
show `Seccomp: 2` and have no IPv6 address (no line in
`/proc/net/if_inet6`, read, not sized: procfs files report size 0),
or the container is removed and the call refused, so a runtime that
ignored the configuration or the sysctls is caught too. The last
network option matters: an internal network still gives the host's side
of the bridge an address (the gateway, `.1` when Compose names one, else
the dynamic range's first), and through it a sandbox reaches every host
service listening on `0.0.0.0`; with `inhibit_ipv4` the bridge has no
address, and the sandboxes reach only each other and the mirror (checked
on Kata, 2026-11-11). A create needs all of them but the
mirror, which only `pip install` uses.

### Tests

`tests/test_sandbox_kata_unit.py` runs everywhere, against a mocked Docker
SDK, and covers `kata.py` and `lifespan.py` completely.
`tests/test_sandbox_kata.py` runs the acceptance tests that need a real
sandbox (VM boundary, network fence, cross-chat isolation, persistence and
image switching, read-only uploads, timeout and background children,
cancellation, output flood, memory, fork bomb, PID 1, path confinement
against a real symlink, restart sweep, the fixed-size volume), on a host
with Kata, both images, udisks and the loop-device permission above:

```sh
cd apps/server
LLLM_TEST_KATA=1 LLLM_SECRET_KEY=$(python3 -c 'print("x"*40)') \
  uv run --frozen python -m pytest tests/test_sandbox_kata.py -v
```

They skip without `LLLM_TEST_KATA=1` (CI has no `/dev/kvm`). Without the
`local-llm_sandbox` network they create it with the backend's subnet and
remove it afterwards, and they remove every container, volume and image
file they make. About three minutes, most of it the PID 1 test's 300 calls.

## Uploads

`apps/server/local_llm/sandbox/uploads.py`. Before every `bash` and `view`
call, inside the call's session (under the sandbox's lock, after the
previous call's processes were killed), the files attached to the
conversation (`metadata['files']`) are copied into `/workspace/uploads`,
where the model's prompt says they are.

Which files: the files on the current message path that the calling user
may read (`has_access_to_file`, or their own), checked again on every call
because the list comes from the request; only uploaded files count
(knowledge bases, web results and images are not files on disk), each file
id once. A saved chat's sandbox is usable only by its owner, and by an
admin while admin chat access is on (Q14); an admin's call copies only the
files the chat's owner may read too, so none of the admin's own files
lands in the owner's workspace, and when the owner cannot be looked up
nothing is copied. An unsaved chat's sandbox belongs to the chat and the
user together (Q12). At most 100 files, from the first 200 distinct ids
listed (so a long list costs a bounded number of lookups), 50 MiB each and
200 MiB together; every file left out gets a note in the `bash` result's
stderr, repeated on every call while it applies (`view` returns only the
file). Each file keeps its base name, with control and format characters
removed, `.` and `..` replaced by the file's id, cut to 255 bytes of
UTF-8, and made unique as `name (n).ext`, so no name can make the copy
fail.

How: `/workspace/uploads` is a read-only bind mount of
`DATA_DIR/sandbox/uploads/<key>`, outside the workspace volume, which the
backend's `put_uploads` makes hold exactly the given files (see "What each
sandbox gets" for how, and for what the guest can and cannot do there).
Nothing in the guest can change, move or remove it, so nothing needs
checking before a copy, and the model cannot leave copies behind that it
is unable to delete.

A call whose files (name, id, and the size and hash recorded at upload)
are those of the last copy on the running sandbox copies nothing and
fetches nothing from storage; any change hands the whole current set to
`put_uploads`. The record is kept per sandbox by the manager and dropped
when the sandbox stops or is destroyed, so every container start copies
once (an empty set too). `stop` empties the directory, since every start
copies again, and `destroy` removes it. A file that could not be read is
not recorded, so the next call tries it again.

A copy that fails never refuses the call, so a command still runs: the
result's stderr says the attached files could not be copied and that
`/workspace/uploads` may be missing files or hold an older set (`view`
adds that to its error, if it fails). The one exception is a sandbox that
stops during the copy, which fails the call as any stopped sandbox does.

The Jupyter engine uses the same selection (`chat_files`, re-exported by
`utils/code_interpreter.py` until that engine is removed).

`tests/test_sandbox_uploads.py` runs everywhere, against the FakeBackend.
`tests/test_sandbox_uploads_kata.py` is acceptance test "Read-only
uploads" through the manager and the real `bash` tool: the directory is
mounted `ro`; as UID 1000, writing, appending, truncating, deleting,
renaming, `chmod` on a file or the directory, creating a file or symlink
beside them, and moving or removing the directory itself all fail; an
added attachment appears and a removed one goes; and a copy of the full
200 MiB ends well inside the 30 s a Stop waits for it. It needs and skips
like `tests/test_sandbox_kata.py`, whose fixtures it uses:

```sh
cd apps/server
LLLM_TEST_KATA=1 LLLM_SECRET_KEY=$(python3 -c 'print("x"*40)') \
  uv run --frozen python -m pytest tests/test_sandbox_uploads_kata.py -v -s
```
