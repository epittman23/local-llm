# The code sandbox

> **Under construction.** The sandbox described in
> [docs/proposals/sandbox-code-interpreter.md](../proposals/sandbox-code-interpreter.md)
> is being built on the `feat/sandbox-code-interpreter` branch (PR #884).
> Nothing in the app uses it yet: the code interpreter is still Jupyter.
> This guide grows with the build; so far it covers the host setup and the
> images.

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

Measured the same day on the laptop (Intel Core i9-12900H, 62 GiB,
Fedora 44 kernel `7.2.8-200.fc44.x86_64`; Kata 4.3.1 runtime-rs, Cloud
Hypervisor v54.0, Docker 29.8.2), five runs each, with the options above:

| Image | `docker run -d` to the first `docker exec` output | Idle host RSS, `cloud-hypervisor` + `virtiofsd` |
|---|---|---|
| `quay.io/jupyter/scipy-notebook:2026-10-12` | 0.99-1.03 s | 381-395 MiB |
| `alpine:latest` | 0.99-1.06 s | 290-295 MiB |

### Undo

```sh
sudo rm -rf /opt/kata
sudo rm /etc/docker/daemon.json   # or remove only the kata-clh entry
sudo systemctl restart docker
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
one line in `infra/sandbox/TAG` (`2026-11-11.1`: the date, then a counter
for that day). Any change to an image bumps it, because the tag is what
the manager starts and what benchmark runs record. The backend holds the
same value in a constant, so bump both together. Pre-existing containers keep their old image until they are
recreated.
