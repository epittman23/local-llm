# Built: Shell sandbox that replaced the Jupyter code interpreter

> **BUILT.** This is the design the sandbox was built from, kept as the record of why. The PRs #886, #884 and #888 merged on 2026-11-13; #889 removes Jupyter and Pyodide. What exists now is described in [docs/guides/sandbox.md](../guides/sandbox.md); where the two differ, the guide is right. The text below is written in the future tense it was proposed in, and the Jupyter inventory in it is of commit `9ee7fc3`.

| Field | Value |
| --- | --- |
| Document type | Design proposal, built |
| Written | 2026-11-09 to 2026-11-10 |
| State | Built (PRs #886, #884, #888 merged 2026-11-13; #889 removes Jupyter and Pyodide); every design question was decided by the owner (see [Decisions](#decisions)) |
| Code inventory taken at | commit `9ee7fc3` (2026-11-09) |
| Project | local-llm |

## Summary

The Jupyter code interpreter, and the Pyodide engine beside it, would be removed and replaced by a shell sandbox: one disposable microVM per chat, driven through four tools (`bash`, `view`, `write_file`, `str_replace`) that return structured results to the model.

The design mirrors how Claude's own sandbox works in claude.ai, as observed from inside it on 2026-11-09: a stateless shell over a persistent per-task filesystem, a read-only uploads mount, a read-write outputs mount, and each sandbox inside a Firecracker microVM with its own guest kernel. Each sandbox here is also a microVM: Kata Containers running Cloud Hypervisor under the existing Docker Engine, chosen by the owner over gVisor so the isolation boundary already fits a future home server running many parallel sessions. A backend interface keeps a later move to raw Firecracker, for snapshot-based fast starts, inside one module.

## Motivation

The Jupyter engine already gives up its main advantage: each code block gets a fresh kernel and a fresh directory, both deleted when the block ends. Nothing a model computes or writes survives to its next call, so it pays Jupyter's costs without its benefit. A shell sandbox fixes four concrete limits:

- **Persistence within a chat.** Files written in one call are there in the next, so a model can load data once, save intermediate results, and build on them.
- **Beyond Python.** A shell runs any interpreter or command-line tool in the image (git, sqlite3, R, Node.js, LaTeX), not only the kernel's language.
- **Deliverable outputs.** Today a file the code writes is deleted with its run directory; a sandbox surfaces files in an outputs directory to the chat.
- **Per-chat isolation.** Today every chat's code runs in one shared container as one user, so concurrent runs share a filesystem (inferred from the design; not tested). A microVM per chat removes that.

It also gives coding work the file-editing tools (`view`, `str_replace`) that agentic harnesses rely on, which supports the November 2026 goal of improving the harness.

**Why a microVM now.** The owner plans to move the stack to a home server running multiple sessions and agents in parallel. A VM boundary per sandbox is the standard for running untrusted code from many sessions on one host; choosing it now avoids migrating every sandbox, test and doc from a container boundary later, when more depends on it.

## Current state

Jupyter is reached through one module and three call sites, checked at commit `9ee7fc3`. Every item below changes or is removed by this proposal.

| Area | Location | Role today |
| --- | --- | --- |
| Executor | `apps/server/local_llm/utils/code_interpreter.py` | `JupyterCodeExecuter`: creates a kernel per block over REST and WebSocket, copies chat files in, deletes both afterwards; `chat_files()` checks file access |
| Native tool call | `tools/builtin.py`, `execute_code()` | The tool a model calls with native function calling; prepends the blocked-modules import hook |
| Tag path | `utils/middleware.py`, `_run_code_interpreter()` | Runs `<code_interpreter>` blocks for models without native tool calling |
| Run button | `routers/utils.py`, code execute endpoint | Runs a code block when the user presses Run in the UI (`code_execution.*` settings) |
| Benchmark harness | `benchmarks/evaluation/harness.py` | Refuses unless the engine is `jupyter`; records `code_interpreter_engine: 'jupyter'` in the run spec (changed in T30: it runs on the sandbox engine too, until T40 removes Jupyter) |
| Settings | `config.py`, `CodeExecution.tsx` | `code_interpreter.jupyter.*` and `code_execution.jupyter.*` per-key config rows; Admin > Code Execution page |
| Service | `infra/docker-compose.yml` | `quay.io/jupyter/scipy-notebook:2026-10-12`, own network, `cap_drop: [ALL]`, `no-new-privileges`, 4 GB, 512 PIDs, internet allowed |
| Startup | `Makefile`, `apps/desktop/src/progress.ts` | Generates `JUPYTER_TOKEN`; the desktop progress dialog parses the Jupyter stage |
| Tests | `test_jupyter_chat_files.py`, `test_jupyter_idle_timeout.py`, harness and payload tests | Pin the current behavior |
| Docs | `docs/guides/assistant-tools.md`, `decisions.md` (2026-10-24), MAP, README, AGENTS, two `.mmd` diagrams | Describe the Jupyter engine |

The import hook is not a security boundary: `importlib` or a subprocess bypasses it, and a shell makes it meaningless. Isolation today rests on the container fencing alone.

Pyodide is a latent fault today: `CODE_INTERPRETER_ENGINE` and `CODE_EXECUTION_ENGINE` default to `pyodide` in `config.py`, but the Astro frontend has no Pyodide executor, so a chat on that engine sends an event call that no browser answers.

## Design

A new `SandboxManager` in `apps/server/local_llm/sandbox/` owns one microVM per chat and is the only code that talks to Docker; all three call sites go through it.

**Backend interface.** The manager calls a `SandboxBackend` protocol with six methods: `create(chat_id, spec)`, `exec(cmd, timeout_s)`, `put_files(dir, files)`, `get_files(dir)`, `stop()` and `destroy()`. The first backend, `KataDockerBackend`, uses the Docker SDK with the Kata runtime. A later `FirecrackerBackend` can implement the same methods with its own guest agent and snapshots without touching the tools, the call sites, the harness or the tests above the interface. CI uses a `FakeBackend`, since hosted runners cannot be relied on to expose `/dev/kvm`.

**Why Kata and Cloud Hypervisor first.** Kata gives each container a microVM while keeping Docker's images, volumes and SDK, so the sandbox image is still built with a Dockerfile. Cloud Hypervisor shares files with the guest over virtio-fs, so Docker volumes work as they do today. Firecracker under Kata cannot: it has no virtio-fs and needs containerd's devmapper snapshotter, which changes how images and volumes are stored ([CloudKernels](https://cloudkernels.github.io/posts/kata-fc-k3s-k8s)).

**Lifecycle.**

1. The first tool call in a chat creates a container labelled `lllm.chat=<chat id>` from a pinned sandbox image under the Kata runtime (`--runtime kata-clh`), so it boots its own Cloud Hypervisor microVM and guest kernel, with a named volume for `/workspace`.
2. Later calls reuse it; a per-chat `asyncio.Lock` allows one command at a time, so concurrent tool calls cannot interleave.
3. After 30 minutes idle the microVM is removed; the volume is kept, so the next call starts a new one with the same files.
4. Deleting the chat, or 7 days without use, removes the volume.
5. On backend start, the manager lists containers and volumes by label and removes orphans, since containers outlive a backend restart.
6. At most 4 microVMs run at once; further requests queue.

**Tools.** Four tools, each returning JSON. All paths are confined to `/workspace`.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `bash` | `command`, `timeout_s` (default 60, max 300), optional `image` (`data` or `web`) | `returncode`, `stdout`, `stderr`, `timed_out`, `truncated` |
| `view` | `path`, optional `start_line`, `end_line` | Numbered lines, or a directory listing two levels deep |
| `write_file` | `path`, `content` | Bytes written; refuses to overwrite unless `overwrite` is true |
| `str_replace` | `path`, `old_str`, `new_str` | Success, or an error when `old_str` matches zero or several times |

The tag path writes each `<code_interpreter>` block to `/workspace/.runs/<n>.py` and runs it with `bash`, so models without native tool calling keep working. The Run button maps to the same call and runs in the chat's own sandbox, so the user works with the model's files.

**File layout.**

- `/workspace`: read-write, the chat's persistent volume and the working directory.
- `/workspace/uploads`: the chat's files, copied in with the existing `chat_files()` access checks and its 50 MB per file and 200 MB total caps, then written by `put_archive` as root-owned files (mode 0444) in a root-owned directory (mode 0555); the sandbox runs as UID 1000, so code cannot make them writable again.
- `/workspace/outputs`: files the model wants the user to have; after each call, new or changed files here are attached to the message (see [Output rendering](#output-rendering)), replacing the `display_data` PNG capture Jupyter provided.

**Execution and output limits.** Each command runs as `timeout --kill-after=5 <timeout_s> bash -lc <command>`; return code 124 marks a timeout and sets `timed_out`. Stdout and stderr are each capped at 20,000 characters, keeping the first and last halves with a truncation marker, so a runaway `print` cannot fill the context window. The Docker SDK call blocks, so it runs under `asyncio.to_thread`.

### Images

Two images share a common build stage, and the model chooses between them per chat. Their upstream bases differ, so they share files and an install script, not Docker layers.

| Image | Built from | Adds | Telemetry |
| --- | --- | --- | --- |
| `sandbox-base` | A build stage, never run directly; its files are copied into both images with `COPY --from`, and a shared script installs its tools | `bash`, `git`, `sqlite3`, DuckDB CLI, telemetry hooks, pip mirror settings | Commands and command misses |
| `sandbox-data` (default) | `quay.io/jupyter/scipy-notebook:2026-10-12` plus the common stage | R from conda-forge (`r-base` with tidyverse, data.table, broom, lme4 and survival), as the Jupyter project's own R images install it; TeX Live (see [LaTeX](#latex)), `latexmk`, `biber` and `poppler-utils` | Python imports; R namespaces loaded, recorded at exit by a finalizer in `Rprofile.site` |
| `sandbox-web` | A pinned Node.js LTS image plus the common stage | TypeScript, `tsx`, ESLint, Prettier, Playwright with headless Chromium | Commands only at first |

**Selecting an image.** The `bash` tool's optional `image` argument names the image, and its description lists each image's contents so the model can choose. The first call in a chat starts that image; omitting the argument starts the Workspace model entry's default (`data`). Naming a different image later stops the microVM and starts the other one on the same `/workspace` volume, so files carry over and only running processes are lost. The harness always pins `data`, so changes to the web image never alter the image digest that benchmark runs record.

**Web work without a network.** With no network, the model cannot open a dev server for the user to visit. Instead it builds into `/workspace/outputs` and checks rendering with Playwright: headless Chromium loads the page from the filesystem and saves screenshots there, which the chat shows inline. npm packages are curated and baked into the image, with no run-time installs, until telemetry shows a need for an npm counterpart to the wheelhouse.

### LaTeX

The owner usually wants both the `.tex` source and the compiled `.pdf`. TeX Live goes into `sandbox-data`, because documents in this workload mostly carry figures and tables produced by the Python and R work in the same chat, and a separate image would force a switch for every report. Adding it before the harness baseline (Migration step 2) means the digest change happens once, before any sandbox-era numbers exist.

| Choice | Decision | Reason |
| --- | --- | --- |
| Distribution | TeX Live installed from upstream with a small scheme plus named collections (`latexrecommended`, `latexextra`, `fontsrecommended`, `mathscience`, `bibtexextra`, `pictures`), pinned to one yearly release | The full scheme is several gigabytes; named collections cover math and statistics documents and are reviewable |
| Not Tectonic or TinyTeX | Rejected | Both fetch missing packages from the internet on demand, which the no-network sandbox forbids |
| Build command | `latexmk -pdf -interaction=nonstopmode -halt-on-error -file-line-error` in `/workspace/build/<name>/` | Reruns until cross-references settle, runs `biber` or `bibtex` when needed, and stops on the first error with a file and line number |
| Delivery | The source `.tex` (and any `.bib` and figure files) and the `.pdf` are copied to `/workspace/outputs/`; auxiliary files stay in `build/` | The user receives both outputs and none of the clutter |
| Shell escape | Off (`shell_escape = f` in `texmf.cnf`); `openout_any = p` kept | `\write18` lets a document run commands; inside a microVM the risk is small, but no common math or statistics package needs it. `minted`, which needs it, is replaced by `listings` |
| Self-check | After each build, the model reads the log for `Overfull \hbox`, undefined references and missing citations, and checks the text with `pdftotext` | The model can catch layout and reference errors without viewing the PDF |

A missing package fails with LaTeX's "File ... not found" error; telemetry records it as a miss, so recurring misses become collections or packages added to the image.

### Output rendering

Files in `/workspace/outputs` are model-written content, so the app displays them without ever giving them the app's origin (the scheme, host and port a page counts as coming from). A page with the app's origin could read its cookies, call its API as the signed-in user, and pass the desktop preload check, which accepts loopback origins.

| Output type | Shown as | Why |
| --- | --- | --- |
| PNG, JPEG | `<img>` | Raster images carry no code |
| SVG | `<img>` only, never inline in the page | An SVG can contain `<script>`; inside `<img>` it does not run |
| HTML | `<iframe sandbox="allow-scripts" srcdoc="...">`, never with `allow-same-origin` | The frame gets an opaque origin, reported as `"null"`: scripts run, but cannot reach the parent page, cookies, the API or the preload bridge |
| PDF | Page previews rendered to PNG in the sandbox with `pdftoppm`, shown as `<img>`, plus a download link | A PDF can carry JavaScript and actions that browser viewers partly honor; PNG previews show the pages without running anything |
| `.tex`, CSV, JSON, text | Rendered as text (`.tex` with syntax highlighting) or a table | No code path |
| Anything else | Download link | Not displayed |

Rules for HTML:

1. **Injected policy.** Before embedding, the backend inserts a content-security policy as the first element of `<head>`: `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'">`. Browsers enforce every policy present, so a second policy the model writes can only tighten it, never loosen it. It blocks fetches, images, fonts and form posts, but not a frame navigating itself (Q4: the desktop app denies that; the browser cannot) and not WebRTC, which no CSP directive covers: a script in an HTML output can send what the model wrote, what the user types into it and the user's IP to a server it names (Q23: accepted and documented).
2. **Sandbox flags stay minimal.** Without `allow-top-navigation`, `allow-popups`, `allow-forms` or `allow-downloads`, the page cannot redirect the app, open windows, submit forms or start downloads.
3. **Full screen stays sandboxed.** An enlarged view reuses the same sandboxed frame in a modal. It never opens a `blob:` URL in a new tab, because a `blob:` URL inherits the origin of the page that created it, which would be the app's origin.
4. **Raw downloads never render.** The endpoint that serves an output file directly returns `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, so opening its URL saves the file instead of rendering it on the app's origin.
5. **Size cap.** HTML over 5 MB is offered as a download only.
6. **Desktop.** The opaque `"null"` origin fails the preload bridge's origin check, as intended; `nodeIntegrationInSubFrames` stays off, so preload scripts never load into frames.

### Package mirror (static wheelhouse)

Python packages beyond the image come only from a reviewed set:

1. `infra/sandbox/allowlist.in` names the approved extra packages.
2. `uv pip compile allowlist.in -c image-freeze.txt --generate-hashes` resolves the full dependency tree into `requirements.lock`, pinned to exact versions with SHA-256 hashes; `image-freeze.txt` is `pip freeze` from the sandbox image, so the mirror never offers a different version of a package the image already has.
3. `make wheelhouse` runs `pip download -r requirements.lock --only-binary=:all:` on the host, the only step with internet access; wheels only, because a source distribution runs build code on installation.
4. A `sandbox-mirror` container serves the directory over HTTP on a Docker network marked `internal: true`, which has no route to the internet. Each sandbox joins that network and no other.
5. The image sets `PIP_NO_INDEX=1`, `PIP_FIND_LINKS=http://sandbox-mirror:8000/`, `PIP_ONLY_BINARY=:all:`, `PIP_USER=1` and `PYTHONUSERBASE=/workspace/.local`, so `pip install <name>` installs into the chat's volume and persists for that chat. An unapproved package fails with pip's "no matching distribution" error, which the prompt tells the model to report rather than work around.

To verify during implementation: that the scipy-notebook image's conda Python honors `PYTHONUSERBASE` and does not set `PYTHONNOUSERSITE` (fallback: a virtual environment in `/workspace/.venv` created with `--system-site-packages`), and that `uv pip compile` resolves cleanly against the image's frozen versions.

### Package telemetry

Three signals show which packages are used, how often, and what is missing:

| Signal | Captured by | Records |
| --- | --- | --- |
| Imports | `sitecustomize.py` in the image: an `atexit` hook takes the top-level modules in `sys.modules`, drops the standard library (`sys.stdlib_module_names`), and maps the rest to distributions and versions with `importlib.metadata.packages_distributions()` | One event per distribution per process |
| Installs | The mirror's access log of wheel downloads; the manager maps each request's source IP to the chat whose sandbox holds that address | Package, version, chat |
| Misses | `sys.excepthook` in the same file for an uncaught `ModuleNotFoundError`; the manager matches stderr for pip's "No matching distribution found for", bash's "command not found", and LaTeX's "File ... not found" | Missing module, package, command or LaTeX file |

After each `bash` call the manager reads and truncates `/workspace/.telemetry/events.jsonl` through the backend's `get_files`, tags each event with the chat id, image digest, lock-file hash and harness run id (when present), and inserts it into a new append-only table, `sandbox_package_events` (`ts`, `chat_id`, `kind`, `name`, `version`, `image_digest`, `lock_sha`, `harness_run_id`). An admin page under Benchmarks, or saved queries, reports per package: chats using it, imports in total, last use, and whether it comes from the image or the wheelhouse; and ranks misses by distinct chats, which becomes the review queue for `allowlist.in` and the Dockerfiles.

Limitations: telemetry is advisory, since code in the sandbox can delete or forge it; `atexit` does not run when a process is killed by a timeout or the OOM killer, so those runs undercount; and only Python imports (and R namespaces) are seen per package, while other languages appear only as commands and command misses. Harness runs carry their run id, so usage reports can exclude them.

## Security model

Model-written code is treated as untrusted, so isolation is layered and no single layer is relied on. Each layer below keeps the fencing the Jupyter service has today and adds to it.

| Layer | Setting | What it stops |
| --- | --- | --- |
| VM boundary | Kata runtime with Cloud Hypervisor (`--runtime kata-clh`) | A guest kernel exploit reaching the host; code inside makes syscalls only into its own guest kernel, and escaping requires a KVM or VMM exploit |
| VMM process | Cloud Hypervisor and `virtiofsd` on the host, each confined with seccomp by their projects | A compromised device emulator acting freely on the host |
| Privileges in the guest | `--user 1000:1000`, `--cap-drop ALL`, `--security-opt no-new-privileges` | Escalation to root inside the guest, which would widen the attack surface on virtio devices |
| Filesystem | `--read-only` root, `--tmpfs /tmp:size=256m`, writable `/workspace` volume only | Tampering with the image; writing anywhere on the host outside the volume |
| Resources | `--memory 4g`, `--cpus 2`, `--pids-limit 512`; Kata sizes the VM from these | Memory exhaustion and fork bombs affecting the host or other sandboxes |
| Network | No internet route; only the internal `sandbox-mirror` network | Reaching Postgres, Redis, the backend or llama-server; data exfiltration |
| Cross-session | One microVM and one volume per chat | One session's or agent's code reading another's files or memory |

**Docker socket.** The backend becomes a Docker client, and membership in the `docker` group is root-equivalent on the host. The backend already runs as the user in that group and starts host processes, so this adds no new privilege, but the manager must be the only module that calls Docker, and it must never pass model-provided strings as container options. Rootless Podman would remove this exposure, but Kata does not support Podman ([Kata limitations](https://github.com/kata-containers/kata-containers/blob/c64b07f98144/docs/Limitations.md)), so the microVM choice keeps Docker.

**Host requirements.** Hardware virtualization (Intel VT-x) enabled in firmware and `/dev/kvm` present; Kata's shim runs under `dockerd` as root, so the user needs no `kvm` group membership. `kata-runtime check` verifies the host. On the R730, sandboxes should run on the bare-metal host; if the app later runs inside a VM (for example under Proxmox), nested virtualization must be enabled for that VM, at a performance cost.

**Network default.** A sandbox has no internet route. Its only network is `sandbox-mirror`, an internal Docker network whose one other member is the static wheelhouse server, which itself has no internet access, so there is no outbound path for code to reach or for data to leave by. Only `make wheelhouse`, run by the owner on the host, contacts PyPI.

**Rendered outputs.** The sandbox boundary ends where its files reach the browser. HTML and SVG the model writes are displayed only in opaque-origin frames under an injected content-security policy, as [Output rendering](#output-rendering) specifies, so a page cannot act as the signed-in user or reach the desktop preload bridge.

The blocked-modules import hook is dropped for the sandbox engine, since a shell bypasses it trivially; keeping it would suggest protection that does not exist.

## What is lost and how it is mitigated

Kernel state between calls is not on this list: the current engine already discards it after every block. The real losses are smaller.

| Lost | Mitigation |
| --- | --- |
| Inline plot capture (`display_data` PNGs returned as data URIs) | The prompt tells the model to save figures to `/workspace/outputs`; the backend attaches them as images. One extra line per plot (`plt.savefig(...)`) |
| The scipy-notebook package set as measured | `sandbox-data` is built `FROM quay.io/jupyter/scipy-notebook:2026-10-12`, so Python and every package stay identical |
| `pip install` during a call | Install from the static wheelhouse mirror, which serves only reviewed, hash-pinned wheels |
| Expression results (`execute_result` of a final bare expression) | The model prints what it wants returned; the prompt says so. This is standard for script execution |
| Comparability with Jupyter-era harness runs | The run spec records the engine, so sandbox runs get a new spec SHA and never mix with Jupyter runs; re-run the harness baseline once (Migration step 2) |
| The Pyodide engine | Removed with Jupyter; it cannot run today in any case (see [Current state](#current-state)). After removal, `sandbox` is the only engine value |

## Migration plan

The task-by-task build, with the ledger that sessions resume from, is [docs/plans/sandbox-implementation.md](../plans/sandbox-implementation.md); it also records where the code at `7709a6b1` differs from what this proposal assumed.

One large pull request, opened as a draft when implementation starts, built up in the three steps below, in order, so the harness can be measured on the new engine before the old one is deleted. A draft never auto-merges, so `main` never carries a half-built sandbox: Jupyter stays the engine on `main` until the PR merges, and Jupyter and the sandbox exist side by side only on the branch, between steps 1 and 3. The PR is marked ready for review only when every step is done and every [acceptance test](#acceptance-tests) has passed; marking it ready lets it auto-merge once its checks pass.

1. **Add the sandbox engine.** New `sandbox/` package (manager, the `SandboxBackend` protocol with `KataDockerBackend` and `FakeBackend`, tools), the images under `infra/sandbox/`, the engine value `sandbox` in all three call sites, the four tools registered in `tools/builtin.py`, a sandbox prompt beside `CODE_INTERPRETER_JUPYTER_PROMPT`, settings in Admin > Code Execution, and a Kata setup guide in `docs/guides/` (install from Fedora's packages or the upstream static release, register `kata-clh` in `/etc/docker/daemon.json`, run `kata-runtime check`). New config keys go in `DEFAULT_CONFIG`, which the backend seeds at startup; only changing existing rows needs an Alembic revision (the schema is append-only). Also: the wheelhouse mirror (`allowlist.in`, `requirements.lock`, `make wheelhouse`, the `sandbox-mirror` service and network), `sitecustomize.py` telemetry, output rendering (sandboxed frames, the injected policy, attachment-only raw downloads), and the append-only `sandbox_package_events` table. Tests for every acceptance test below that can run in CI.
2. **Move the harness.** Accept `sandbox` in `harness.py` and record it in the run spec; check with the owner whether the changed spec needs a `benchmark_schema_note` row. Re-run the harness baseline on the current serving profiles and record numbers with hardware, model file, llama.cpp build and flags.
3. **Remove Jupyter and Pyodide.** Delete `JupyterCodeExecuter`, the `jupyter` Compose service, network and volume, `JUPYTER_TOKEN` generation, the desktop progress stage, the Jupyter settings UI, and the Jupyter tests; remove Pyodide everywhere it appears: the `pyodide` branches in `tools/builtin.py`, `utils/middleware.py` and `utils/subagents.py`, `CODE_INTERPRETER_PYODIDE_PROMPT`, `ENABLE_PYODIDE_FILE_PERSISTENCE` in `env.py` and `main.py`, the engine choice in `CodeExecution.tsx` and its e2e test, the `config.py` defaults (changed to `sandbox`), and the harness comments and test fixtures that mention it. Migrate existing `code_interpreter.engine` and `code_execution.engine` rows set to `jupyter` or `pyodide` to `sandbox` in a new revision.

**The CI gate.** The PR trips the gate: step 1 changes the Makefile (`make wheelhouse`) and step 3 deletes tests. Its body keeps a "## Gate changes" section that lists every finding with its justification and grows as the steps land. A push removes the `gate-change-approved` label, so the owner adds it once, after the last commit, when the PR is ready.

**Docs, in the same commits.** One new dated entry at the top of `docs/decisions.md` for the PR, kept current on the branch as the steps land (the 2026-10-24 (night) entry stays as written); `docs/guides/assistant-tools.md` rewritten for the sandbox; `features-chat-pipeline.mmd`, `features-harness.mmd`, MAP, README, AGENTS, and the roadmap updated; `docs/plans/benchmarks-through-the-app.md` amended where it names the Jupyter engine. Files under `docs/history/` and `docs/audit/` that mention Jupyter or Pyodide are records and stay as written.

## Alternatives considered

Kata Containers with Cloud Hypervisor is recommended: it is a true microVM boundary that keeps the Docker workflow, images and volumes. Raw Firecracker is a contingent second backend, built only if measured Kata performance is too poor.

| Option | Isolation | Effort on Fedora 44 | Verdict |
| --- | --- | --- | --- |
| **Kata + Cloud Hypervisor under Docker** | microVM, own guest kernel; virtio-fs file sharing | Low to medium: install Kata, one `daemon.json` entry | **Chosen** |
| Raw Firecracker (what Claude uses) | microVM, minimal device model, jailer | High: guest agent over vsock, rootfs build from the Dockerfile, block-device workspaces, TAP networking, jailer | **Contingent second backend**: snapshot restore gives the fastest warm starts at home-server scale |
| Kata + Firecracker | microVM | High: containerd devmapper snapshotter; no virtio-fs, so volumes and bind mounts break | Rejected: the costs of raw Firecracker without its control |
| Docker with gVisor (runsc) | User-space kernel, not a VM | Low | Superseded on 2026-11-09: the owner wants a VM boundary for parallel multi-session use |
| Docker, default runtime (runc), hardened | Namespaces, host kernel | Low | Rejected: one kernel bug from the host |
| Rootless Podman | Namespaces, no root daemon | Medium | Rejected: Kata does not support Podman |
| Keep Jupyter (status quo) | Shared container, host kernel | None | Rejected by the owner: no persistence, Python only |
| Hosted sandbox service | Provider's | Low | Rejected: violates the self-hosted principle |

Package sources were compared the same way. A static wheelhouse was chosen over devpi: devpi's online constrained mode needs internet egress from the mirror, filters by name and version rather than file hash, and serves source distributions unless the client refuses them; devpi in offline mode with uploaded wheels remains an option for the home server.

A microVM costs a guest kernel and VMM process per sandbox, so start-up is slower and memory overhead higher than a container; the acceptance tests measure both on the laptop rather than assuming figures. Sandbox start latency is the number to watch when deciding whether the Firecracker backend's snapshots are needed.

## Acceptance tests

All must pass on the laptop before the PR is marked ready for review; each records its date and commit, as the 2026-10-24 Jupyter checks did.

- [ ] **Network fence:** from inside a sandbox, service names other than `sandbox-mirror` fail to resolve, ports 4000, 5432, 6379, 8080 and 8090 are unreachable, and `https://pypi.org` is unreachable; from inside the mirror container, `https://pypi.org` is unreachable too.
- [ ] **VM boundary:** `uname -r` inside the sandbox reports Kata's guest kernel, not the host's, and the host shows one `cloud-hypervisor` process per running sandbox.
- [ ] **Cross-chat isolation:** a file written in chat A is absent from chat B's `/workspace`.
- [ ] **Persistence:** a file written in one call is readable in the next call of the same chat, and after the idle reaper has removed the microVM.
- [ ] **Read-only uploads:** writing to, deleting or `chmod`-ing a file in `/workspace/uploads` fails.
- [ ] **Timeout:** `sleep 999` with `timeout_s=5` returns `timed_out: true`, return code 124, and leaves no process behind.
- [ ] **Fork bomb:** stays within 512 PIDs; the backend, desktop and other sandboxes stay responsive.
- [ ] **Memory:** allocating 6 GB is OOM-killed inside the guest; the host and other sandboxes are unaffected.
- [ ] **Output flood:** printing 10 MB returns at most 20,000 characters per stream with `truncated: true`.
- [ ] **Outputs:** a matplotlib figure saved to `/workspace/outputs` renders inline in the chat.
- [ ] **Mirror installs:** `pip install` of an allowlisted package succeeds and is still importable in the chat's next call; an unlisted package fails with "no matching distribution"; a package available only as a source distribution is refused.
- [ ] **Image switching:** a chat that starts on `data`, writes a file, then calls with `image: web` finds the file in `/workspace`; `Rscript -e 'library(dplyr)'` succeeds on `data`, `tsc --version` succeeds on `web`, and a Playwright screenshot of a page in `/workspace/outputs` renders inline in the chat.
- [ ] **Output rendering:** a model-written HTML output that tries `document.cookie`, `fetch('/api/v1/chats')`, `parent.document`, `top.location = ...`, a form submission, `window.open` and the desktop preload bridge fails at each (an `RTCPeerConnection` probe is recorded too: it gets out, as Q23 accepted), while its own scripts and inline styles still run; an SVG output containing `<script>` does not execute; opening the raw download URL saves the file rather than rendering it.
- [ ] **LaTeX:** a document using `amsmath`, `biblatex` with `biber`, `tikz` and `listings` builds with `latexmk`; both the `.tex` and the `.pdf` appear in the chat, the PDF as page previews plus a download; a document calling `\write18` does not run the command; a document needing an uninstalled package fails with a file and line number and records a miss.
- [ ] **Telemetry:** importing `pandas` records one import event with its version; an uncaught `import notapkg` records a module miss; running `fakecmd` records a command miss; a mirror install records an install event attributed to the right chat; events from a harness run carry its run id.
- [ ] **Tag path:** a model without native tool calling runs a `<code_interpreter>` block successfully.
- [ ] **Parallel sessions:** four chats run CPU-bound commands at once; each completes, none sees another's files, and results match a serial run; a fifth waits in the queue.
- [ ] **Start latency and overhead:** record cold-start time to the first command's output and host memory per idle sandbox, with hardware, Kata and Cloud Hypervisor versions; these numbers decide whether the Firecracker backend is needed.
- [ ] **Restart:** after a backend restart, orphan containers and their microVM processes are found by label and removed, and the chat's files remain.
- [ ] **Harness:** a full HumanEval+ harness run completes on the sandbox engine, and its spec SHA differs from Jupyter-era runs. (Narrowed by the owner on 2026-11-13, Q30: a `smoke`-tier harness run, compared with a one-item Jupyter-engine harness run.)

## Decisions

Every question the proposal raised was decided by the owner.

| Question | Decision | Date |
| --- | --- | --- |
| Replace Jupyter or run beside it | Replace | 2026-11-09 |
| Isolation boundary | microVM per chat: Kata with Cloud Hypervisor (over gVisor) | 2026-11-09 |
| Raw Firecracker backend | Build only if measured Kata performance (start latency or per-sandbox memory) is too poor | 2026-11-09 |
| Network | No internet; only the internal network to the static wheelhouse mirror | 2026-11-09 |
| Package source | Static wheelhouse, with package telemetry (over devpi) | 2026-11-09 |
| Images | `sandbox-data` (default) and `sandbox-web`, chosen per chat by the model, switching on the same volume | 2026-11-09 |
| Languages beyond Python | R, the web suite (TypeScript, JavaScript, CSS, HTML) and LaTeX | 2026-11-09 |
| Pyodide | Removed completely, with Jupyter, in Migration step 3 | 2026-11-10 |
| Concurrency cap | 4 microVMs on the laptop for now; revisit on the R730 | 2026-11-10 |
| Workspace retention | 7 days after last use | 2026-11-10 |
| Idle reaper | 30 minutes | 2026-11-10 |
| Run button | Runs in the chat's own sandbox | 2026-11-10 |
| Per-sandbox limits | 4 GB and 512 PIDs, kept from the Jupyter service | 2026-11-10 |
| R packages | tidyverse, data.table, broom, lme4, survival | 2026-11-10 |
| Playwright in `sandbox-web` | Included; screenshots are the only way the model sees its own page | 2026-11-10 |
| TeX Live collections | The six listed under [LaTeX](#latex); `listings` replaces `minted` | 2026-11-10 |
| Development flow | One large PR, opened as a draft when implementation starts and marked ready only after every acceptance test passes | 2026-11-10 |
| Harness schema note | Add a `benchmark_schema_note` row when the harness spec gains the sandbox engine and image digest | 2026-11-10 |
| Run button | Wired up in the chat (it is not shown today), running in the chat's own sandbox | 2026-11-10 |
| Kata tests in CI | Skipped unless `LLLM_TEST_KATA=1`, never failed on `CI`; the new skip is justified under the PR's `## Gate changes` | 2026-11-10 |
| Frame navigation | The desktop app denies sub-frame navigation away from `about:srcdoc`; the browser limitation is documented | 2026-11-10 |
| Unsaved chats | Ephemeral sandboxes (temporary chats, harness items), never retained; harness items release theirs when done | 2026-11-10 |
| Sub-agents | Use the parent chat's sandbox | 2026-11-10 |
| Kata release and runtime | Upstream static release 4.3.1 with the Rust runtime (runtime-rs, the default since 4.0), not Fedora's QEMU-only 3.26.0 package or the deprecated Go runtime; fall back to the Go runtime only if the T02 spike shows Docker with Cloud Hypervisor failing on runtime-rs | 2026-11-10 |
| Process limit under Kata | `--ulimit nproc=512:512` as well as `--pids-limit 512`: runtime-rs does not enforce the PID cgroup limit, while the per-UID limit caps a fork bomb at 512 for UID 1000, which every sandbox process runs as | 2026-11-10 |
| Finding the mirror from a Kata guest | A fixed subnet and `sandbox-mirror` address in Compose, passed to each sandbox as `extra_hosts`: Docker's embedded DNS does not answer inside a Kata VM, so no container name resolves there | 2026-11-10 |
| Processes between calls | None: after every command the backend kills every UID 1000 process in the sandbox, since background children survive `timeout` and root in the guest cannot kill them | 2026-11-10 |
| Disk per sandbox | Each `/workspace` volume is a fixed-size 10 GiB filesystem (sparse, loop-backed), so a runaway write cannot fill the host's disk | 2026-11-10 |
| Unsaved chats' sandboxes | One per chat and user, so members of a shared channel chat each get their own and another user's temporary chat id reaches nothing | 2026-11-10 |
| All slots held by idle sandboxes | Evict the least-recently-used sandbox idle at least 60 s (its files stay); otherwise wait at most 2 minutes, then fail with "no free sandbox" | 2026-11-10 |
| Who may use a saved chat's sandbox | Its owner, or an admin as the chat endpoint allows; not every reader of the chat | 2026-11-10 |
| Workspaces per user | At most 20 persistent workspaces per user (admin-settable); before one is deleted for the cap or the 7-day expiry the user sees its contents and chooses remove or keep, nothing is deleted unanswered, and at the cap a new workspace is refused with an error the model relays | 2026-11-10 |
| The sandbox's first process | Runs as `nobody` (65534:65534) under tini, while every command runs as UID 1000, so the per-call kill of UID 1000's processes cannot stop the sandbox and tini reaps what it kills | 2026-11-11 |
| First mirror packages | `polars`, `duckdb`, `pingouin` and `lifelines`, as binary wheels constrained to the data image's versions | 2026-11-11 |
| How the workspace size is enforced | Each workspace is an ext4 image file attached as a loop device through udisks2, with a polkit rule (a root step at host setup) letting the backend's user do that without a login session; Docker's own volume driver cannot loop-mount | 2026-11-11 |
| Seccomp inside the guest | On: `disable_guest_seccomp = false` in the Kata Cloud Hypervisor configuration, so Docker's default profile applies inside the VM (blocks user namespaces and similar), as defense in depth behind the VM | 2026-11-11 |
| The sandbox network's host fence | `internal: true`, plus `inhibit_ipv4` (no IPv4 on the bridge), plus no IPv6: disabled in each guest by sysctl, and on the bridge (named `lllm-sandbox`) by a udev rule at host setup, since an internal network alone leaves the host reachable through the bridge's own addresses | 2026-11-11 |
| A terminal server and the sandbox in one chat | Never both: a chat request with an Open Terminal server selected while the code interpreter runs on engine `sandbox` is refused with an error asking the user to turn one off, since both offer a `write_file` acting on different machines (Q24) | 2026-11-12 |
| Outputs from paths other than `bash` | Every path that runs code in the sandbox (the tag path, the Run endpoint, a sub-agent) collects `/workspace/outputs` itself, with the same listing and caps; Run outputs are stored and shown under the block but not added to the saved message; a sub-agent's attach to its own message and count against the parent chat's cap (Q25) | 2026-11-12 |
| The Run button's permission | Under the `sandbox` engine the Run endpoint also requires the `features.code_interpreter` permission (admins always hold it), and the frontend hides Run from a user without it; Jupyter unchanged until it is removed (Q26) | 2026-11-13 |
| The Run button and the global switch | Under the `sandbox` engine the Run endpoint also requires the code interpreter to be switched on for the server (`code_interpreter.enable`), for admins too, and the frontend hides Run while it is off, as on every other path into the workspace (Q29) | 2026-11-13 |
| A command that takes the whole microVM down | Counts as a sandbox failure for the harness, not the model's; on the laptop no model-written command took the VM down (Q27) | 2026-11-13 |
| The harness baseline on the sandbox engine (T31) | A `smoke`-tier harness run on `qwen38` instead of a full HumanEval+ run, which is not needed to show the harness works; a one-item HumanEval+ harness run on the Jupyter engine records the Jupyter-era spec sha it is compared with (Q30) | 2026-11-13 |

## Sources

Opened 2026-11-09:

- [Kata Containers: Limitations](https://github.com/kata-containers/kata-containers/blob/c64b07f98144/docs/Limitations.md): Docker support since 22.06 via `--runtime io.containerd.kata.v2`; no Podman support; no host networking.
- [CloudKernels: Running containers on Firecracker microVMs using Kata](https://cloudkernels.github.io/posts/kata-fc-k3s-k8s): Firecracker under Kata lacks virtio-fs and needs the devmapper snapshotter.
- Claude's own sandbox, inspected from inside on 2026-11-09: kernel `6.18.44-fc`, PID 1 `/process_api --firecracker-init` serving commands over vsock.
