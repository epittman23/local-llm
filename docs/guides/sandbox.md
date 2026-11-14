# The code sandbox

> **Built, and the only code interpreter.** The sandbox described in
> [docs/history/sandbox-code-interpreter.md](../history/sandbox-code-interpreter.md)
> merged in PRs #886, #884 and #888 on 2026-11-13, and PR #889 removed
> Jupyter and Pyodide, so `sandbox` is the only engine value the settings
> accept. This guide covers the host setup, the images, the mirror, the backend and
> its tests, operations, uploads, outputs, the call sites, the workspace
> cap and the package telemetry.

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
[Images](../history/sandbox-code-interpreter.md#images) section.

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
- The data image's Python has a `sitecustomize.py` and its R an
  `Rprofile.site` addition (`data/sitecustomize.py`, `data/Rprofile.site`)
  that record what each process imports, for the
  [package telemetry](#package-telemetry). The build refuses a base whose
  Python already has a `sitecustomize.py`, which this one would replace.
  The web image has no Python and no hooks.
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
one line in `infra/sandbox/TAG` (`2026-11-12.1`: the date, then a counter
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
  capped at three 10 MB files, because a sandbox chooses what it requests.
  The package telemetry reads it after every `bash` call, from where its
  last read stopped, at most 1 MiB a read (see
  [Package telemetry](#package-telemetry)). So it keeps up with that
  rotation only while each call has at most about 1 MiB of new lines to
  read: a backlog that grows faster (many installs between calls, or a
  sandbox requesting junk) falls behind by the difference each call, and
  lines rotated away before they are read are lost.
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
against a real symlink, restart sweep, the fixed-size volume, and the
keep-or-remove dialog's listing of a stopped and of a running workspace
through the helper, and four chats running at once under `max_running=4`
while a fifth waits for a slot), on a host
with Kata, both images, udisks and the loop-device permission above:

```sh
cd apps/server
LLLM_TEST_KATA=1 LLLM_SECRET_KEY=$(python3 -c 'print("x"*40)') \
  uv run --frozen python -m pytest tests/test_sandbox_kata.py -v
```

They skip without `LLLM_TEST_KATA=1` (CI has no `/dev/kvm`). Without the
`local-llm_sandbox` network they create it with the backend's subnet and
remove it afterwards, and they remove every container, volume and image
file they make. About three minutes, most of it the PID 1 test's 300 calls;
with `test_sandbox_uploads_kata.py` and `test_sandbox_outputs_kata.py`,
38 tests in 366 s on the laptop (2026-11-13). The two mirror tests need the
`sandbox-mirror` container, which `make backend` starts; without it they
fail.

## Operations

Everything below is on the host running the backend. `DATA_DIR` is
`apps/server/data` under `make backend`.

**Where things are.** A chat's sandbox is known by its key, the manager's
UUID for the chat (not the chat id); the table `sandbox_workspace` maps
each persistent key to its owner and chat (`key`, `user_id`, `chat_id`).

| What | Where |
|---|---|
| Container | `lllm-sandbox-<key>`, labels `lllm.chat=<key>`, `lllm.scope`, `lllm.image` (and `lllm.ephemeral=1` for an unsaved chat) |
| Workspace volume | Docker volume `lllm-sandbox-<key>` over the image file `DATA_DIR/sandbox/volumes/<key>.img`, attached to a loop device |
| Uploads | `DATA_DIR/sandbox/uploads/<key>`, bound read-only at `/workspace/uploads` |
| Listing helper | `lllm-sandbox-list-<key>`, label `lllm.helper=list`, alive only while the keep-or-remove dialog lists a workspace |
| Scope id | `DATA_DIR/sandbox/volumes/scope`; another app instance on the same daemon has its own |
| Images and mirror | `local-llm/sandbox-data:<TAG>`, `local-llm/sandbox-web:<TAG>`; the `local-llm-sandbox-mirror` container |

**Looking at them.**

```sh
scope=$(cat apps/server/data/sandbox/volumes/scope)
docker ps -a --filter label=lllm.scope=$scope \
  --format '{{.Names}}\t{{.Status}}\t{{.Label "lllm.image"}}'
docker volume ls --filter label=lllm.scope=$scope
ls -lsh apps/server/data/sandbox/volumes/     # allocated vs. apparent size
udisksctl status; losetup -l                  # the attached loop devices
psql "$DATABASE_URL" -c 'select key, user_id, chat_id, to_timestamp(last_used_at), pending_reason from sandbox_workspace order by last_used_at'
```

**Removing them.** Use the app wherever possible: deleting a chat
destroys its workspace at the next hourly sweep, and the keep-or-remove
dialog removes one the user chooses. Both go through `destroy`, which
removes, in order, the container, the loop device, the image file and
the volume, so a destroy cut short is finished by a later sweep. By
hand, with the backend stopped, the same order is:

```sh
docker rm -f lllm-sandbox-<key> lllm-sandbox-list-<key>
udisksctl loop-delete -b /dev/loopN          # the device losetup -l shows for <key>.img
rm apps/server/data/sandbox/volumes/<key>.img
docker volume rm lllm-sandbox-<key>
rm -rf apps/server/data/sandbox/uploads/<key>
```

Its `sandbox_workspace` row is dropped by the next sweep once the volume
is gone (after an hour, `PRUNE_AFTER_S`). Never remove a volume of
another scope: it belongs to another app instance.

**What runs on its own** (`sandbox/lifespan.py`, `manager.py`):

- **Startup sweep**, before the app serves: removes listing helpers left
  behind, stops every running sandbox and destroys every ephemeral one a
  previous process left; persistent volumes are kept.
- **Idle reaper**, every minute: stops a sandbox idle for
  `code_interpreter.sandbox.idle_minutes` (default 30) and not in use; an
  ephemeral one is destroyed with its volume. A stopped persistent
  sandbox keeps its volume and starts again on the next call.
- **Retention sweep**, hourly (the first with the first reap): destroys
  the volumes of deleted chats, with the safeguards in "Workspace cap and
  deletion"; marks a workspace unused for
  `code_interpreter.sandbox.retention_days` (default 7) `expired`, which
  the user is asked about and nothing deletes without their answer;
  records volumes without a row and drops rows without a volume.
- **Telemetry prune**, at startup and hourly: deletes
  `sandbox_package_events` rows older than 180 days.

A failed pass is logged and the loop goes on. With
`LLLM_STOP_JOBS_ON_SHUTDOWN=true`, shutdown stops every running sandbox
and destroys the ephemeral ones; otherwise running sandboxes are left for
the next startup sweep, so a `--reload` restart kills no command.

**Status.** `GET /api/v1/sandbox/status` (admin) answers
`{"ready": bool, "reason": str | null}`: the first failing check of
"Checks" above, the same text each refused call gets, shown on Admin
Settings > Code Execution. `GET /api/v1/sandbox/packages` (admin) is the
package report, "Package telemetry" below.

**Leftovers from the Jupyter engine.** The sandbox replaced the Jupyter
code interpreter, and the Compose file no longer has a `jupyter` service
or its `jupyter-work` volume. A machine that ran the stack before keeps
both until they are removed by hand; nothing removes them automatically.
A `local-llm-jupyter` container still running (left up by a `make backend`
from before, or brought back by `restart: unless-stopped` after a reboot)
is an orphan of the Compose project, and `docker compose ps` counts
orphans: the desktop app then finds services running and refuses to
start its own stack, and `make backend` treats the stack as already up.
Remove the leftovers with the stack stopped:

```sh
docker compose -f infra/docker-compose.yml down --remove-orphans   # stops the stack and the orphan
docker network rm local-llm_jupyter       # if it outlived the container
docker volume rm local-llm_jupyter-work   # Jupyter's scratch space; nothing reads it
```

A `JUPYTER_TOKEN=` line left in `infra/.env` is harmless.

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

## Outputs

`apps/server/local_llm/sandbox/outputs.py`. The `bash` tool lists
`/workspace/outputs` after the model's command, inside the call's session,
which holds the chat's lock, and attaches every file that is new or changed
in size or modification time. It compares with the listing the last `bash`
call took after its command, which the manager keeps per sandbox while it
runs (`SandboxSession.outputs_memory`, `OutputsMemory.listing`), so a file `write_file` or
`str_replace` put there in between counts as new too. When no listing is
kept (the sandbox's first call, a container started again, or a call cut
short), it lists before the command instead; `write_file` and `str_replace`
also take one before they write, when none is kept, so the next `bash` call
attaches what they wrote. The model's prompt says that its next `bash` call
attaches the files. A call keeps its listing for the next only when
everything went well, so a call stopped or failing while it attached does
not have its files attached twice; a call stopped during its command,
before anything was attached, puts the listing from before back, so the
next call attaches what that command left. The daemon stats the directory first: a
missing `outputs`, or one that is a symlink, lists nothing, and no listing
runs. The listing is a fixed script, run with an empty environment and
absolute paths:

```sh
{ /usr/bin/find -P /workspace/outputs -xdev -type f -readable -printf '%T@\t%s\t%P\0' 2>/dev/null \
  | /usr/bin/sort -z -r -n && printf 'END\0'; } | /usr/bin/head -c 16384
```

`-P` never follows a symlink, so every path listed is free of them. The
records end with NUL, since a name may hold a tab or a newline, and only
the last field is free text. The listing is cut at 16 KiB, below the
stream cap, so the cap never splices two records together. The newest
files come first, so a cut listing keeps those, and a listing without its
`END` was cut short: the result's `outputs_note` then tells the model to
move finished files out. When the listing from before the command was cut,
a file it does not hold counts as new only if it is newer than the oldest
file it does hold. `find`'s complaints (a directory it cannot enter) are
dropped, since stderr counts toward the stream cap too. A listing that
fails, before or after the command, never costs the command's result:
`outputs` is empty and `outputs_note` says why.

Each file is read back with `get_files`, stored, and linked to the
message before the next one is read, so a call cut short (a Stop, a
database error) leaves unlinked at most the one row it was linking; after a
database error the result still names what was stored, and the `files`
event carries it. The caps are 50 MiB per file, and 200 MiB and 20 files
per call (`limits.py`), charged for every file read, PDF preview pages
included (a PDF's pages, at most 10 of 8 MiB, are read before they are
charged, so they can be read and then left out).
A file whose bytes are those of the last File row stored for its path in
this chat (the SHA-256, from the rows below, and kept by the manager beside
the listing while the sandbox runs) is read but not stored or attached
again, so rewriting or `touch`ing a file adds nothing. Every file left out is named in `outputs`
with the reason: over a cap, empty, a name that is not UTF-8, no longer a
regular file, unchanged, not stored, over the chat's cap, the sandbox
stopped, or a server error came first.

A chat holds at most 1 GiB of sandbox outputs over all its calls, previews
included (`OUTPUT_CHAT_CAP_BYTES`, owner decision Q22). The total is the
size of the File rows whose `meta` the server marked as the chat's
(`source: 'sandbox_output'` and `chat_id`), from one query over `file`,
whether or not they are linked to a message. So it holds for an unsaved
chat, for a call with no message id, and across a stopped sandbox or a
restarted server. An unsaved chat's id is not one the database checks, so
its rows count only when they are the caller's too, as its sandbox is
(Q12). The same query's last row per path (by `created_at`, then the
store's nanosecond clock in `meta.stored_ns`, then the row's id) seeds the
content check above. A file that would pass the cap is named as not
attached, saying so. Each file stored is a File row owned by the user,
whose `meta` has `source: 'sandbox_output'`, `sandbox_path`, `chat_id` and
`stored_ns`, set by the server when the row is inserted, after anything
else in it; an upload's own metadata goes under `meta.data`, so no client
can set them. The rows are written through `Storage` and
`Files.insert_new_file`, not `upload_file_handler`, which files its
metadata under `meta.data`. Its name is the base name with control and
format characters replaced, cut to 200 bytes. It is linked to the message
(`Chats.insert_chat_files`) when the chat is saved and the call has a
message id. An unsaved chat's outputs, and those of a call with no message
id, stay File rows
of the user's, counted but linked to nothing, like a temporary chat's
generated images: a row linked to a chat but no message would show on no
message, yet `chat_file` decides what a shared chat's viewers may open. The tool then sends a
`files` event with the call's new files only: the chat page and the
server's socket handler each merge the event into the message's list
rather than replace it.
In a benchmark run (`request.state.benchmark_harness`) the files are
listed, but nothing is read or stored.

A PDF, at most 3 per call, gets PNG previews of its first 10 pages at 80
dpi, cropped to 1600 pixels a side (`pdftoppm -png -r 80 -l 10 -W 1600 -H
1600`). The crop keeps a normal page at 80 dpi and never rasterises a huge
one whole: a 200-inch page at 80 dpi would be 16,000 pixels a side. The
previews are made once every output has been read, because `pdftoppm` runs
as UID 1000 on a file the model wrote:
- it renders into `/workspace/.lllm/previews`, removed and made again for
  each PDF (whose pages are read before the next renders), and a `.lllm`
  that is a symlink is refused;
- a separate exec lists the pages, after the post-exec kill has ended
  anything `pdftoppm` left behind;
- the daemon confirms that each directory on the way is a real directory;
- each page must be a PNG of at most 1600 pixels a side and 8 MiB;
- the pages count toward the call's 20 files and 200 MiB, and a PDF whose
  pages stopped at those caps says so in its `previews`.

The pages are stored like the outputs, with `meta.preview_of` (the PDF's
file id) and `meta.preview_page`; their `sandbox_path` is the PDF's. They
appear in the `files` event, not in `outputs`.

How they are served:
- `GET /api/v1/files/{id}/content` and `/content/{name}` send a sandbox
  output as `attachment` with `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox`, whatever its type
  and the `attachment` query parameter. Its `Content-Type` is its own only
  for an image (PNG, JPEG, GIF, WebP, SVG), a PDF, audio or video, and
  `application/octet-stream` otherwise, so no output is served as HTML,
  script or a style sheet. SVG keeps its type because an `<img>` needs it
  and never runs its script; opened as a document it is a download, and the
  policy keeps it inert.
- `/content/html` refuses one with 403. This applies once access is
  established, so a caller without access gets the same 404 as for a
  missing file.
- The only way to show an HTML output is
  `GET /api/v1/sandbox/outputs/{id}/html`, under the same access rule as
  file content. It returns JSON, `{"html": ...}`, so the document never
  renders on the app's origin, and the frontend shows it as the `srcdoc`
  of an iframe sandboxed to `allow-scripts`. The route answers 404 for a
  file that is not an HTML sandbox output, and 413 over 5 MiB.

The document is decoded by its BOM (UTF-8, UTF-16), otherwise as UTF-8,
and gets this policy in front of it:

```text
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;
font-src data:; form-action 'none'; base-uri 'none'
```

It blocks fetches and loads (images and fonts come only from `data:` and
`blob:`), form submissions and `<base>`. It is not "no network": CSP covers
neither the frame navigating itself nor WebRTC, whose STUN and TURN lookups
a script can use to send data out (both under "What the frame can still
send out" below).

The policy goes after a leading doctype that only HTML whitespace
precedes, and at the very start otherwise. Text first (a BOM left in the
text, a non-breaking space) would open `<body>`, where a policy `<meta>` is
ignored, and a comment first could hide a fake doctype, so neither is
skipped; a real doctype after the policy is then ignored, which costs only
quirks mode. A policy the document declares itself can only narrow this
one.

### On the reply

`apps/web/src/components/chat/SandboxOutputs.tsx`, rendered by
`ResponseMessage` (`routes/chat/ChatMessages.tsx`), shows the message's
files whose `meta.source` is `sandbox_output` and whose id is a UUID (the
only id it puts into a URL), each under its `name`, which the server
cleaned of control and format characters (never the raw `sandbox_path`),
with a download link (`/content?attachment=true`). An entry of the wrong
shape (from a plugin's event or an imported chat) is skipped. It picks a
renderer by the name's extension, then by `meta.content_type`:
- PNG, JPEG and SVG: an `<img>` of `/content`, never inline SVG. An SVG
  shows only because the route keeps its `image/svg+xml` type
  (`served_type`); browsers never sniff SVG.
- HTML: `SandboxedHtmlFrame`, an iframe with `sandbox="allow-scripts"` and
  nothing else, whose `srcdoc` is the route's `html`. A frame of an opaque
  origin cannot report its own height, so it starts at 360 px and the user
  sets it: by dragging its corner, or with the Taller and Shorter buttons,
  which work from the keyboard and announce the new height. An Enlarge
  button shows the same component, with the same document, in a dialog.
  Never a `blob:` URL or a new window. It does not reuse `ArtifactPanel`'s
  frame, whose flags are wider. A file over 5 MiB, or one the route
  refuses, gets a note instead.
- PDF: the preview PNGs (`meta.preview_of`), in `meta.preview_page` order.
- `.tex`, `.py`, `.R`, `.json`, `.md`, `.txt`, `.log` and `text/plain`: the
  chat's code-block renderer, highlighted, with no Run or Preview button.
  Only the first 256 KiB is fetched. Registering LaTeX for `.tex` also
  highlights ```` ```latex ```` blocks in replies, and puts LaTeX among the
  languages an unlabelled code block is auto-detected as, so a block of
  math with no language can now highlight as LaTeX.
- CSV: a table of the first 200 rows, from at most 1 MiB, its first row as
  the header. A row is at most 50 columns and a cell 1,000 characters, so a
  file of nothing but commas stays a small table; a row the 1 MiB cut short
  is left out, and a note says what was cut.
- Anything else: the download link alone.

A fetch stops when the reply leaves the page (React Query's abort signal).

The chat page merges each `files` event into the message's list
(`lib/chat/history.ts` `mergeFiles`): an incoming entry replaces the one
with its id, or, without an id, the id-less one with its url, or else an
identical one, and is appended otherwise; an entry that is not an object is
skipped. The server's copy (`socket/main.py` `merge_message_files`) adds an
entry unless an identical one is there; every sender re-sends identical
entries, so a reload shows the same list. An unsaved chat's earlier outputs
stay when a later call sends only its new ones.

`SandboxOutputs.test.tsx` checks each renderer, the frame's exact `sandbox`
attribute and the dialog's reuse of it, the height controls, the caps and
malformed entries; `e2e/sandbox-outputs.spec.ts` shows a reply's outputs in
Chromium with mocked routes that send T17's headers (an SVG among them),
and checks that the frame's script runs but reaches neither the page nor
its cookies.

**What the frame can still send out.** The policy blocks fetches, images,
fonts and form posts, but the frame's script is not cut off from the
network:
- **WebRTC.** A script in an HTML output can reach the network over
  WebRTC. CSP has no directive for it, so the script can open an
  `RTCPeerConnection` to a STUN or TURN host it names and send data in the
  ICE traffic (a TURN username, say, or the host name itself through the
  DNS lookup). It can leak what the model wrote, what the user types into
  the output, and the user's public IP. This holds in the browser and the
  desktop app alike; neither the sandbox flags nor the desktop rule below
  touch it (found in T18's security review, 2026-11-11, on Electron
  45.1.0). The owner accepted this on 2026-11-11 (Q23): scripts in an
  output run when the reply shows, without asking.
- **Navigation (Q4).** Nor do the sandbox flags (without
  `allow-top-navigation`) or a content-security policy stop a frame
  navigating itself (`location = 'https://example.com/?data'`); CSP's
  `navigate-to` never shipped. In a browser this is accepted. The desktop
  app denies it: its `will-frame-navigate` handler
  (`apps/desktop/src/policy.ts`, `isAllowedFrameNavigation`) lets a
  sub-frame showing `about:srcdoc` or `about:blank` go only to another of
  those, unless the app's own page starts the navigation (an iframe's `src`
  loading), and refuses a navigation it cannot check. It covers every such
  frame, so the chat's artifact preview cannot navigate itself away in the
  desktop app either. It stops navigation only, not WebRTC.

`tests/test_sandbox_outputs.py` runs everywhere. It covers:
- the listing, which also runs for real with bash, and the FakeBackend's
  emulation of it against the same tree;
- the diff, the caps, the rows and their links, and the previews;
- the `bash` tool end to end on the FakeBackend, with files `write_file`
  and `str_replace` put in `outputs`, a Stop or a database error while it
  attaches, and its `files` events saved as `socket/main.py` saves them;
- the policy's placement and the routes.

`tests/test_sandbox_outputs_kata.py` is the acceptance test "Outputs",
through the manager and the real `bash` tool on Kata: a matplotlib figure
saved to `outputs` comes back in `outputs` as a File row linked to the
message, and a PDF gets its preview PNGs. It needs and skips like
`tests/test_sandbox_kata.py`:

```sh
cd apps/server
LLLM_TEST_KATA=1 LLLM_SECRET_KEY=$(python3 -c 'print("x"*40)') \
  uv run --frozen python -m pytest tests/test_sandbox_outputs_kata.py -v -s
```

## Call sites

Everything that runs code under the `sandbox` engine goes through the chat's
sandbox, one per chat (owner decision Q6 for sub-agents), and every path
collects `/workspace/outputs` itself, with the same comparison, listing and
caps as `bash` (Q25), so the next `bash` call never attaches them again.

- **Native function calling.** The model gets the four tools (`bash`,
  `view`, `write_file`, `str_replace`) in place of `execute_code`, and
  `CODE_INTERPRETER_SANDBOX_PROMPT` is appended to the system message.
  `bash`'s `timeout_s`, left out, is the admin's
  `code_interpreter.sandbox.timeout` (a cleared or invalid setting means
  60, `configured_timeout` in `tools/builtin.py`).
- **The tag path** (legacy function calling,
  `utils/middleware.py` `_execute_code_in_sandbox`). Each
  `<code_interpreter>` block is written to `/workspace/.runs/<n>.py` (`n`
  one more than the highest plain number there, which a fixed script prints
  as one number, `sandbox/runs.py`) and run with `python` from `/workspace`
  on the `data` image, with the configured timeout. Its outputs attach to the reply as a
  `bash` call's do. The model is shown only a block's stdout
  (`utils/misc.py`), so the block's stderr (after a `[stderr]` line), a
  sandbox failure, and lines naming the files attached, not attached (with
  why) or only listed all go into stdout.
  `CODE_INTERPRETER_SANDBOX_TAG_PROMPT` describes this environment.
- **The Run endpoint** (`POST /api/v1/utils/code/execute`, with
  `code_execution.engine` set to `sandbox`). It needs the block's
  `chat_id`, runs the code as the tag path does in that chat's sandbox,
  and answers 404 for a saved chat the user may not run code in (the owner,
  or an admin while `ENABLE_ADMIN_CHAT_ACCESS` is on; Q14), and 403 for a
  user without the `features.code_interpreter` permission (admins always
  hold it), since the run reaches the workspace the code interpreter uses
  (Q26), and for everyone while the code interpreter is switched off for
  the server (`code_interpreter.enable`, Q29). Its outputs are
  stored and count toward the chat's 1 GiB, come back under `files` for the
  block to show, and are linked to no message: pressing Run is the user's
  act, not part of the reply. It does not sync the chat's attachments,
  which it does not know, so `/workspace/uploads` stays as the chat's last
  call left it.
- **The Run button** (`apps/web`, T22). A Python code block in a reply
  shows Run when code execution is on with the `sandbox` engine, the code
  interpreter is switched on, and the user holds its permission
  (`lib/chat/codeRun.ts`); it
  sends the block with its chat's id. The block's stdout, stderr and result, an error (the endpoint's refusal, or
  the sandbox's own failure), a non-zero exit code, a note when the output
  was cut, and the files the run left in `/workspace/outputs` (as
  `SandboxOutputs` shows a reply's) appear under the block until it is
  closed; they are not saved with the chat, so a reload, or a chat reload
  while the run is in flight, loses them. A screen reader hears only the
  run's status.
- **Sub-agents** (`utils/subagents.py`). A sub-agent's request carries its
  parent chat (`request.state.sandbox_chat_id`, set only by the server), so
  its tools use the parent's sandbox; a sub-agent of a sub-agent keeps the
  outermost chat's, and so does the parent's continuation after a
  background sub-agent. Such a request never syncs `/workspace/uploads`
  (`shares_parent_sandbox`): the files it carries are a few of the parent's
  or a snapshot from an earlier turn, and a sync makes the uploads hold
  exactly what it is given, so it would remove what the parent attached
  since. It uses the uploads the parent's own calls synced. The chat's lock
  serializes their calls, and one slot serves them all. A sub-agent's outputs attach to its
  own message and count against the parent chat's cap. Background
  sub-agents keep the code interpreter.
- **A terminal server in the same chat is refused** (Q24). An Open
  Terminal server offers its own `write_file`, acting on its own machine,
  so a chat request with a terminal selected while the code interpreter is
  on with the `sandbox` engine is refused, asking the user to turn one of
  them off: a 400 for an API caller, the message's error in the chat. It is
  refused only when the sandbox would really be in play (the code
  interpreter's gates, and the tag path or builtin tools on the native
  path), and before any feature runs. `terminal:*` events go out for
  terminal tools only.
- **The harness.** `request.state.benchmark_harness` keeps every path's
  outputs listed in the result but stored nowhere. Each `bash` call and
  each run is recorded with `note_code_run`, as failed only when the
  sandbox itself failed (unavailable, refused, a backend error), never for
  the model's command failing, timing out or being refused as malformed,
  so one model mistake never refuses a whole harness run. `view`,
  `write_file` and `str_replace` record only the sandbox's failures, so a
  model that gives up after one is not scored as having made the mistake.
  A harness request is internal, which drops the sub-agent tools
  (`benchmarks/evaluation/harness.py`), so no sub-agent runs inside one.
  Every sandbox call of a harness request runs on the `data` image
  (`_sandbox_session` pins it, whatever `image` the call asks for, and a
  `bash` call that named `web` is told so in its `stderr`), whose digest
  the harness spec names, and each item's ephemeral sandbox is released
  (`SandboxManager.release`) as soon as the item ends
  ([benchmarks guide](benchmarks.md#through-the-app-harness-mode)).
  `_sandbox_session` notes each session's sandbox key in the harness's
  trace (`note_sandbox`), and the harness refuses an item whose calls ran
  in more than one sandbox: between calls its sandbox is unlocked, so
  another chat needing a slot while all `max_running` are taken can evict
  it after 60 s idle (or the idle reaper destroy it), and the next call
  would start on an empty `/workspace` under a new key. The check catches
  only that replacement under a new key. An eviction whose destroy fails
  or outlives `DESTROY_TIMEOUT_S` leaves the key mapped and in doubt, and
  the next call recreates it empty under the same key; that is not
  detected, and shows only as the eviction's error in the log.

`tests/test_sandbox_call_sites.py` covers all of these on the FakeBackend,
including the `.runs` listing against the real script.

## Workspace cap and deletion

Owner decision Q15 (T24): each user keeps at most
`code_interpreter.sandbox.max_workspaces` persistent workspaces (default
20, at least 1; Admin Settings > Code Execution, "Sandbox Workspaces per
User"), and no workspace is deleted for that cap or for the retention
expiry without the user's answer. Ephemeral sandboxes (unsaved chats,
the harness) do not count and are not asked about.

**The record.** The table `sandbox_workspace` (`models/sandbox.py`,
migration `8bede0d9f5c2`) holds one row per persistent volume: the
backend key, the owning user (the chat's owner, also when an admin runs
code in it, Q14), the chat id, when it was recorded and last used, and a
pending deletion: `pending_reason` (`cap` or `expired`), `pending_since`
and, for `cap`, `pending_for_chat_id`, the chat whose new workspace
waits. The manager reaches it only through `sandbox/workspaces.py`
(`DatabaseWorkspaces`; tests use `MemoryWorkspaces`). A row is added
before a volume's first create, under the key's lock and one claim lock,
so two chats of one user cannot both take the last place. Both locks are
in the memory of the one backend process (the sandbox refuses to run
under more than one uvicorn or gunicorn worker, `sandbox/lifespan.py`),
so the cap holds within that process only, which is the only kind of
deployment the sandbox supports. A row is dropped
when the volume is destroyed (`release`, a deleted chat, the user's
answer). Every session moves `last_used_at` when it ends, and that use
also clears an `expired` request.

**The cap.** When a session would create a user's
(`max_workspaces` + 1)th volume, it creates nothing, takes no slot (the
check comes before the slot wait, so nothing is evicted for it), records a
`cap` request on the user's least recently used workspace not already
asked about for another chat (once per waiting chat, however often the
model retries), and raises a `SandboxError` whose public text tells the
model that the user's workspace limit is reached and that the user has
been asked in the app to remove one. When every workspace is already
asked about for other chats, nothing new is recorded, and the text says
instead that the user must first answer the requests the app already
shows. A volume the backend already holds for the chat (made before the
records existed) is recorded at the cap instead of refused, since
refusing it would create nothing; the backend is listed for that only
at the cap. Once a workspace is removed, the
waiting chat's next call creates its workspace and clears any request
made for it. A database error while checking fails closed, with a fixed
message for the model.

**Expiry.** The hourly retention sweep no longer destroys a stopped
workspace unused for `retention_days`: it marks it `expired`, judged by
the record's `last_used_at`, not the chat row's `updated_at` (which the
chat import takes from the client). It keeps its disk until the user
answers. A volume whose chat was deleted is still destroyed without
asking, with the same safeguards as before (none when most chats looked
up are missing; a second lookup just before). A volume with no record
(made before T24) is given one, last used now; a record whose volume the
listing does not show, made over an hour ago and not in use, is dropped.

**Contents.** `SandboxBackend.list_workspace(key, max_entries)` lists a
volume's regular files (path, size, modified time) without its sandbox
running, at most `LIST_MAX_ENTRIES` (300) listed, with the count and
total size of all of them, and `complete` false when a directory could
not be read or the walk ran out of time. The Kata backend runs a
short-lived helper container `lllm-sandbox-list-<key>` with fixed
options (`list_helper_options`): the `data` image under `kata-clh`, the
volume mounted read-only at `/workspace`, `network_mode=none`, UID 1000,
every capability dropped, a read-only root, 512 MiB and 16 processes.
It runs a fixed script (`LIST_SCRIPT`) with `python -I -S` from `/`, which
walks with `lstat` (no symlink is followed) and stops after 20 seconds.
A name that is not UTF-8 has its bad bytes replaced (U+FFFD), and a path
over `LIST_PATH_MAX_BYTES` (1,024 UTF-8 bytes) is cut at a character
boundary, ends in an ellipsis and is marked `truncated`, so the output is
bounded (`LIST_OUTPUT_MAX_BYTES` allows six bytes per path byte, JSON's
worst escape) whatever names the model wrote. The backend waits at most
60 seconds, reads its stdout and checks every field (`parse_listing`):
an entry that is not what the script prints is dropped and the listing
marked incomplete, and only a malformed whole is refused. Nothing a
caller or the model chose reaches its options. It holds the key's
backend lock, attaches the image first (a reboot detaches it), and
carries no `lllm.chat` label, so the sweeps never take it for a sandbox.

The helper is created, then started, and removed in a `finally` that
covers a failed start too, since a helper left behind mounts the volume
and would keep every later destroy from removing it. `stop` and
`destroy` also remove the key's helper (this scope's only) before the
volume, and the startup sweep first removes every `lllm.helper=list`
container of this scope (`SandboxBackend.remove_helpers`), each under
its key's lock; a failure there is logged. At most two listings run at
once; a stopped workspace's listing is kept by (key, last use), up to
`LISTING_CACHE_SIZE` (128) of them, since nothing changes a stopped
volume until a session uses it, and a running one is listed afresh.

**API** (`routers/sandbox.py`; each route reads the records by the
caller's id, so another user's workspace is the same 404 as a missing
one):

- `GET /api/v1/sandbox/pending/ids`: the ids of the caller's waiting
  workspaces, one query, which the app asks on load and after each reply.
- `GET /api/v1/sandbox/pending`: each waiting workspace with its chat's
  title, reason, `since`, times and contents (or why they could not be
  listed), and for `cap` the waiting chat and the caller's other
  workspaces; plus `max_workspaces` and `retention_days`. One at a time
  per user: a second while the first runs is 429. 503 when the records,
  the settings or the chat titles cannot be read.
- `POST /api/v1/sandbox/pending/{id}` with
  `{"action": "remove"|"keep", "since": <the request's since>}` and, for
  `cap`, an optional `workspace` naming another of the caller's
  workspaces to remove instead. `keep` on `expired` moves the last use to
  now, so it is not asked about again until it expires again; `keep` on
  `cap` leaves the waiting chat without a workspace. A request whose
  `since` differs from the one shown (answered, cleared or replaced
  meanwhile) is 409; a removal reads the request again under the lock of
  the workspace to remove, just before it goes, and is 409 if it changed
  then. 400 for an answer that does not fit, 409 also while the workspace
  to remove is running code, 502 when the backend could not destroy it
  (it stays) or its record could not be dropped afterwards, 503 when the
  records cannot be read or written.

**The dialog** (`apps/web/src/routes/chat/PendingWorkspacesDialog.tsx`,
mounted in the app shell): opens when the ids list has one the user has
not dismissed, lists each workspace's chat, reason and files with Remove
and Keep (and, for `cap`, which workspace to remove), and "Decide later"
hides it until a new request arrives or the app loads again. A finished
reply in a saved chat, or a Run, asks for the ids again, so a call that
hit the cap opens it at once. It sends the `since` it showed with each
answer, refetches the ids and the list after a refused answer, drops a
removed workspace from the other items' choices, offers Retry when the
list cannot be read, labels each button with its workspace's chat, and
shows chat titles and file names isolated (`<bdi>`, or U+2068/U+2069 in
the choices), so a right-to-left override in a name cannot reorder the
text around it.

Tests: `tests/test_sandbox_workspaces.py` (the cap, expiry, answers,
routes, both stores), the listing cases in `tests/test_sandbox_kata_unit.py`
(fixed helper options, output checks, and `LIST_SCRIPT` run on a real
directory), `PendingWorkspacesDialog.test.tsx`, and
`e2e/sandbox-workspaces.spec.ts`, and on real Kata
`test_list_workspace_lists_a_stopped_volume_through_the_helper` and
`test_list_workspace_lists_a_running_sandbox_read_only_beside_it` in
`tests/test_sandbox_kata.py`. Checked on the laptop on 2026-11-13: both
listing tests pass, and a cap round trip in the browser ran end to end (a
call at the cap created nothing and opened the dialog with the waiting
workspace's files, a removal let the waiting chat's next call create its
workspace, and Keep deleted nothing).

## Package telemetry

T21 (the proposal's
[Package telemetry](../history/sandbox-code-interpreter.md#package-telemetry)):
which packages the sandboxes use, and which they miss, so the wheelhouse
allowlist (`infra/sandbox/allowlist.in`) and the images grow from use, not
guesses. It is advisory: code in a sandbox can delete or forge its own
events, `atexit` does not run in a process killed by a timeout, the OOM
killer or `os._exit`, so those undercount, and only Python and R are seen
per package; other languages appear only as misses.

**Signals.** Each becomes one row of `sandbox_package_events`:

| `kind` | Recorded by | `name` | `version` |
|---|---|---|---|
| `import` | the data image's `sitecustomize.py`, at each Python process's exit: the top-level names in `sys.modules`, the standard library dropped (`sys.stdlib_module_names`), mapped with `importlib.metadata.packages_distributions()` | the distribution, PEP 503 normalised | its installed version |
| `r_import` | the data image's `Rprofile.site`, at each R session's exit (a finalizer run on exit): `loadedNamespaces()` without base R's own | the namespace | `packageVersion()` |
| `module_miss` | `sitecustomize.py`'s `sys.excepthook`, for an uncaught `ModuleNotFoundError` whose top-level package did not import | the top-level module | |
| `install` | the mirror's access log: a `GET` answered 200 for a `.whl` | the distribution, from the wheel's file name | from the file name |
| `pip_miss` | stderr: pip's "No matching distribution found for" | the requirement's name, normalised | |
| `command_miss` | stderr: bash's "`<name>`: command not found" | the command | |
| `r_miss` | stderr: R's "there is no package called" | the package | |
| `latex_miss` | stdout or stderr (pdflatex prints its errors on stdout): LaTeX's "File \`...' not found" | the file | |

The hooks append one JSON line per event
(`{"kind","name","version","ts"}`) to `/workspace/.telemetry/events.jsonl`,
and never raise (everything is in `try/except Exception: pass`, or R's
`try(silent = TRUE)` with warnings suppressed); Python's previous
`excepthook` still prints the traceback. `packages_distributions()` reads
every installed distribution's metadata (about half a second for a few
hundred), so `sitecustomize.py` keeps its answer in
`/workspace/.telemetry/distributions.json`, keyed by the site directories'
modification times, which an install or removal changes; after the first
process, an exit costs a few milliseconds.

**Collection** (`sandbox/telemetry.py`, `PackageTelemetry`, on
`app.state.sandbox_telemetry`, made by `sandbox/lifespan.py` with the
manager). After each `bash` call and each `run_code_in_sandbox` (the tag
path and the Run endpoint), inside the session, once the command and its
outputs are done, for at most 3 seconds in all (`COLLECT_TIMEOUT_S`; a
daemon call already under way is still waited for, as every session call
is, so the sandbox's lock is never handed on mid-call):

- The events file is read through the daemon and emptied, only when the
  daemon's stat (which does not follow a symlink) shows
  `/workspace/.telemetry` a directory and the file a regular file. An empty
  or missing file costs no exec. The read is `get_files`, which never goes
  through a symlink (the Kata backend checks each directory on the way); a
  file over 256 KiB is emptied unread. The emptying is a fixed helper
  (`TRUNCATE_SCRIPT`) that runs `lllm-path` and empties the file as UID
  1000 only when it resolves to exactly `/workspace/.telemetry/events.jsonl`.
  Nothing changes the file between the stat and the emptying: the session
  holds the sandbox's lock, and the post-exec kill has ended every process
  the command started. Every line is checked as hostile: at most 2,000
  lines of at most 1,024 bytes, a JSON object with only those four fields,
  a kind the hooks write, a name of at most 128 characters from a fixed
  alphabet per kind, a version of at most 64 (dropped, not the line, when
  invalid), and a timestamp within 30 days of the collection's, else the
  collection's. Anything else is dropped.
- The output's misses are matched, each kind and name once per call, at
  most 50.
- The sandbox's address is learnt, once per container start: the manager
  records each start and stop of a sandbox (`AddressWindow`: key, start
  and stop in epoch nanoseconds, at most 4,096 kept), and the first
  telemetry call in it fills in its address from `list_sandboxes()`.

A call's rows are then deduplicated on (kind, name, version), the
earliest kept, and capped at 200 (`ROWS_PER_CALL`), misses included: a
loop that runs Python a thousand times records each package once, so
`imports` counts calls that imported a package, not processes.

The rest runs in a background task after the session (`finish`), so the
call returns without waiting for it; the app's shutdown cancels what is
left (`close`), dropping those rows. It has 30 seconds in all:

- The mirror's log is read from its cursor on, through the backend
  (`SandboxBackend.mirror_log(since_ns, max_bytes)`: the Kata backend reads
  the daemon's logs endpoint for `local-llm-sandbox-mirror`, stdout with
  timestamps, at most 1 MiB a read and 5 seconds, the request's own socket
  timeout too; what is left waits for the next call). The cursor starts
  when the backend starts, and moves past the lines only once they are
  credited, so a failure reads them again. One read runs at a time: a call
  that finds one under way skips its own rather than wait. After a failed
  read none is tried for 60 seconds, doubling with each failure up to 15
  minutes; the failure is logged when the back-off starts. Each install is
  credited to the sandbox whose address window holds the line's time and
  address, and to that sandbox's latest call: its chat, image and harness
  run, even when another chat's call read the line. A line no window
  holds (a gap between two sandboxes that had the same address, an
  address never learnt, or a time before the earliest start recorded) is
  dropped.
- Each row is credited to a user: an unsaved chat's caller (its sandbox is
  theirs, Q12), or the saved chat's owner, looked up once per chat (an
  admin running code in another user's chat counts for the owner).
- The rows are written.

Every step's failure is logged and swallowed: the tool's result is the
same with telemetry failing, slow, or off.

Two edge cases of the daemon's log. A read stops before the line that
would pass its 1 MiB, and the next read continues strictly after the last
line returned; a line the daemon stamped with exactly the same nanosecond
as that last one, left out by the cap, is then skipped. And the daemon
splits a log line longer than 16 KiB into parts; each part fails to parse
as JSON and is dropped, which loses only requests whose URI and user agent
together exceed that, never a real wheel download.

**What each row carries.** `ts` (epoch seconds), `chat_id` (the sandbox's
chat: a sub-agent's parent; an unsaved chat's own id, such as the
harness's `temporary:benchmark-<hex>`, for an ephemeral sandbox, which is
recorded like any other), `user_id` (above; None when the lookup failed),
`image_digest` (the image id the backend last saw
for the session's image, `KataDockerBackend.image_ids`, set by `ready` and
`create`; `''` when unknown), `lock_sha` (SHA-256 of
`infra/sandbox/requirements.lock` in the checkout the backend runs from,
read again when its size or modification time changes; `''` when
unreadable; it is the lock `make wheelhouse` downloads, so it identifies the
wheelhouse as long as the wheelhouse was rebuilt after the lock last
changed), and `harness_run_id`: the benchmark runner puts its suite run id
on the harness request (`request.state.harness_run_id`), and a harness
request without one is marked `harness`, so reports leave both out.

**The table.** `sandbox_package_events` (`models/sandbox.py`, migration
`5d1e9c3a7b42`): `event_id` integer primary key, `ts`, `chat_id`,
`user_id` (nullable), `kind`, `name`, `version` (nullable), `image_digest`,
`lock_sha`, `harness_run_id` (nullable), indexed on `(name, kind)` and on
`ts`. Rows are never changed; those older than 180 days
(`PACKAGE_EVENTS_RETENTION_DAYS` in `sandbox/limits.py`) are deleted at
startup and every hour after (`PackageTelemetry.maintenance_loop`, started
by `sandbox/lifespan.py`). No index serves the harness filter: the report
aggregates every non-harness row anyway.

**The report.** `GET /api/v1/sandbox/packages` (admins; 403 for anyone
else signed in, 503 when the events cannot be read), with
`include_harness=true` to count harness rows and `limit` (default 500):

- `packages`: per language (`python` for `import` and `install`, `r` for
  `r_import`) and name, `users` and `chats` (distinct), `imports`,
  `installs`, `last_used`, and `source`: `image` when
  `infra/sandbox/image-freeze.txt` (R: `image-freeze-r.txt`) lists it,
  `wheelhouse` when only `requirements.lock` does, `other` otherwise (a
  dependency vendored inside another, or a list that is out of date). Most
  users first.
- `misses`: per kind and name, `users` and `chats` (distinct), `events` and
  `last_seen`, most users first: the review queue for `allowlist.in` and the
  Dockerfiles. Ranking by users rather than chats keeps one user (or one
  model looping in many chats) from steering it alone. It is a request
  signal, not vetting: a miss says something was wanted, never that the
  package is safe, maintained or worth its size; each addition is still
  reviewed as T16's "Adding a package" describes, and a forged event can
  only add to the queue.

The same from `psql`:

```sql
-- Packages in use, harness runs left out.
SELECT CASE kind WHEN 'r_import' THEN 'r' ELSE 'python' END AS language, name,
       count(DISTINCT user_id) AS users,
       count(DISTINCT chat_id) AS chats,
       count(*) FILTER (WHERE kind IN ('import', 'r_import')) AS imports,
       count(*) FILTER (WHERE kind = 'install') AS installs,
       to_timestamp(max(ts)) AS last_used
FROM sandbox_package_events
WHERE kind IN ('import', 'r_import', 'install') AND harness_run_id IS NULL
GROUP BY 1, 2
ORDER BY users DESC, chats DESC, imports DESC;

-- Misses ranked by the users who met them.
SELECT kind, name, count(DISTINCT user_id) AS users, count(DISTINCT chat_id) AS chats,
       count(*) AS events,
       to_timestamp(max(ts)) AS last_seen
FROM sandbox_package_events
WHERE kind IN ('module_miss', 'pip_miss', 'command_miss', 'latex_miss', 'r_miss')
  AND harness_run_id IS NULL
GROUP BY kind, name
ORDER BY users DESC, chats DESC, events DESC;
```

**After changing the hooks.** They are in the data image, so a change to
`data/sitecustomize.py` or `data/Rprofile.site` needs a new tag and
`make sandbox-images` ([Rebuilding and the tag](#rebuilding-and-the-tag)).
T21 bumped the tag to `2026-11-12.1` (built on the laptop on 2026-11-13;
the image-freeze files did not change). A host without the images for the
current tag reports them missing and refuses to start sandboxes until
`make sandbox-images` builds them. On a rebuilt image, check that the hook
is the one Python loads:

```sh
docker run --rm local-llm/sandbox-data:2026-11-12.1 python -c 'import sitecustomize; print(sitecustomize.__file__)'
```

which prints a path under `/opt/conda/lib/python3.*/site-packages/`
(`/opt/conda/lib/python3.13/site-packages/sitecustomize.py` on 2026-11-13).

Tests: `tests/test_sandbox_telemetry.py` (the parsers, the miss matchers,
the collection through `FakeBackend` (address reuse, back-off, a read
under way skipped, the cursor kept on a failure, deduplication and the
cap, a sub-agent's rows on its parent chat, failures and a slow daemon
leaving the result unchanged), the truncation helper against real bash,
the Kata backend's log read against a mocked SDK, the retention, `sitecustomize.py`
run in a subprocess, `Rprofile.site` run when R is installed and checked
statically otherwise, the table, the report and its route). The
proposal's acceptance test "Telemetry" passed on the laptop on 2026-11-13
with the `2026-11-12.1` data image (an import with its version, a module
miss, a command miss, and a mirror install credited to the right chat),
except its harness part: T30 put the harness on the sandbox engine, which
makes that part reachable, but it has not been run on the laptop yet.
