# The code sandbox

> **Under construction.** The sandbox described in
> [docs/proposals/sandbox-code-interpreter.md](../proposals/sandbox-code-interpreter.md)
> is being built on the `feat/sandbox-code-interpreter` branch (PR #884).
> Nothing in the app uses it yet: the code interpreter is still Jupyter.
> This guide grows with the build; today it covers only the host setup.

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

### Undo

```sh
sudo rm -rf /opt/kata
sudo rm /etc/docker/daemon.json   # or remove only the kata-clh entry
sudo systemctl restart docker
```
