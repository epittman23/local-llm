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
**Active session:** local, 2026-11-10T22:00Z, T00 T01 T02
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
| T00 | Open the branch and the draft PR | local | local | none | done | | 2026-11-10: branch from `main` `64c977f1`; PR #884 opened as a draft; `gh pr view 884 --json isDraft,autoMergeRequest` gave `isDraft: true`, `autoMergeRequest: null`; `make pr-gate PR=884`: title, attribution and tripwire pass |
| T01 | Install and register Kata on the laptop | owner, kvm | owner, kvm | T00 | todo | | |
| T02 | Spike: prove the Kata assumptions | docker, kvm | docker, kvm | T01 | todo | | |
| T10 | Sandbox core: types, `SandboxBackend`, `FakeBackend`, exec limits | any | any | T00 | todo | | |
| T11 | `SandboxManager` lifecycle | any | any | T10 | todo | | |
| T12 | The four tools and path confinement | any | any | T11 | todo | | |
| T13 | Chat uploads into `/workspace/uploads` | any | any; docker, kvm | T11 | todo | | |
| T14 | `KataDockerBackend` and its integration tests | any | docker, kvm | T10, T02 | todo | | |
| T15 | Sandbox images | any | docker, host-internet | T02 | todo | | |
| T16 | Wheelhouse and `sandbox-mirror` | any | docker, host-internet, kvm | T15 | todo | | |
| T17 | Outputs: collection, storage, endpoints, HTML policy, PDF previews | any | any; docker, kvm | T12 | todo | | |
| T18 | Outputs: frontend rendering | any | any | T17 | todo | | |
| T19 | Engine value, settings, prompt, admin page | any | any | T10 | todo | | |
| T20 | Call sites: native tool, tag path, Run endpoint, sub-agents | any | any; docker, kvm | T12, T19 | todo | | |
| T21 | Package telemetry | any | any; docker, kvm | T15, T16, T20 | todo | | |
| T22 | Run button in chat code blocks | any | any | T20 | todo | | |
| T23 | Step 1 docs | any | any | T20 | todo | | |
| T29 | Step 1 gate | local | docker, kvm, owner | T10-T23 | todo | | |
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

### Session log

One line per session, newest last:
`<date> | local or cloud | <tasks touched> | <what happened> | Next: <the exact next action>`

- 2026-11-10 | local | none | Plan written from the proposal and a fresh code inventory at `9ee7fc39`, reviewed by the project's `reviewer` agent; the owner answered Q1-Q6 as recommended. | Next: T00, from a local session, once the proposal PR (#883) has merged.

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

## Expected PR gate findings

The PR will trip the gate; the local session lists every finding under
`## Gate changes` in the PR body with its justification. Known in advance:

| Finding | Task | Why it is needed and does not weaken CI |
|---|---|---|
| `Makefile` changed | T15, T16, T41 | New lifecycle targets (`sandbox-images`, `wheelhouse`), the `sandbox-mirror` service in `make backend`'s service list, Jupyter's removal. No check target changes meaning |
| New `pytest.skip(` in the Kata tests | T14 | KVM is unavailable on hosted runners (Q3); the tests run on the laptop and their results are recorded in the PR |
| Deleted test files `test_jupyter_chat_files.py`, `test_jupyter_idle_timeout.py`; fewer test definitions | T40 | The code they test is deleted; the sandbox's own tests (T10-T21) cover the replacement behaviour, including the `chat_files()` checks moved into `sandbox/uploads.py` |
| Edited golden files `tests/fixtures/chat_payload.json`, `streaming_response.json`, `subagent_delegate.json` | T40, T42 | Their Jupyter and Pyodide cases describe engines that no longer exist; the replacement cases record the sandbox engine's payloads |
| Fewer tests in `test_makefile.py`, `progress.test.ts` (if a Jupyter-only case goes) | T41 | Same reason; the service-list assertions are rewritten, not dropped |
| Fewer tests in `CodeExecution.test.tsx` and `e2e/admin-settings.spec.ts` (`:187-222`) | T42 | The Jupyter and Pyodide engine choices are removed; the sandbox cases from T19 remain |
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

The owner runs the `sudo` steps; the agent prepares the commands and
records the results.

1. Check virtualization: `grep -cE 'vmx|svm' /proc/cpuinfo` (non-zero),
   `ls -l /dev/kvm`.
2. Install Kata Containers. First choice: Fedora's packages (`dnf info
   kata-containers`); if absent or older than the upstream 3.x line, the
   upstream static release tarball, checksum-verified, under
   `/opt/kata`. Record which, and the version.
3. Register the runtime in `/etc/docker/daemon.json` (merge with what is
   there; show the owner the diff first):
   ```json
   {"runtimes": {"kata-clh": {"runtimeType": "io.containerd.kata-clh.v2"}}}
   ```
   For the static release, the shim path must be on `dockerd`'s `PATH` or
   given as `"runtimeType": "/opt/kata/bin/containerd-shim-kata-clh-v2"`
   (check the release's own docs for the exact name; record what worked).
   Restart Docker.
4. `kata-runtime check` (or `kata-runtime kata-check`) passes.
5. Smoke: `docker run --rm --runtime kata-clh alpine uname -r` prints a
   kernel different from `uname -r` on the host.

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

Create the package `apps/server/local_llm/sandbox/`:

- `__init__.py`: exports only what other modules use.
- `types.py`:
  - `ImageKey = Literal['data', 'web']`.
  - `SandboxSpec` (frozen dataclass): `chat_id`, `image: ImageKey`,
    `volume`, `labels`. Built only by the manager (T11).
  - `ExecResult` (pydantic): `returncode: int`, `stdout: str`,
    `stderr: str`, `timed_out: bool`, `truncated: bool`, `duration_ms: int`.
  - `FileEntry`: `path` (relative to the directory), `size`, `mtime`.
- `backend.py`: `class SandboxBackend(Protocol)` with the six methods of
  the proposal, async:
  - `create(chat_id, spec) -> None` (idempotent: an existing container
    for the chat with the same image is reused)
  - `exec(chat_id, argv: list[str], timeout_s: int, stdin: bytes | None = None) -> ExecResult`
  - `put_files(chat_id, dir: str, files: list[tuple[str, bytes, int]]) -> None`
    (name, content, mode; written root-owned)
  - `get_files(chat_id, paths: list[str], max_bytes: int) -> dict[str, bytes]`
  - `stop(chat_id) -> None` (container gone, volume kept)
  - `destroy(chat_id) -> None` (container and volume gone)

  plus two the manager needs: `list_sandboxes() -> list[SandboxInfo]`
  (chat id, running, last used from labels or state, IP) and
  `ready() -> str | None` (None when usable, else the reason).
- `limits.py`: the fixed limits as constants, deliberately not settings,
  so they cannot be loosened from the admin page: memory `4g`, CPUs `2`,
  PIDs `512`, `/tmp` `256m`, user `1000:1000`, stream cap `20_000`
  characters, timeout default 60 and maximum 300 seconds, kill grace 5
  seconds, file read cap for outputs 50 MiB.
- `exec.py`: `wrap_command(command: str, timeout_s: int) -> list[str]`
  returning `['timeout', '--kill-after=5', str(timeout_s), 'bash', '-lc', command]`
  after clamping `timeout_s` to 1..300; `class StreamCap`, a bounded
  collector that keeps the first 10,000 and the last 10,000 characters of
  a stream as bytes arrive (a ring buffer for the tail), never holding
  more than that, and renders
  `<head>\n[... N characters truncated ...]\n<tail>`; and
  `result_from(returncode, ...)` that sets `timed_out` for 124 (and 137
  after the kill grace).
- `fake.py`: `FakeBackend`, an in-memory implementation for tests: a dict
  per chat for files (with owner and mode), a scripted `exec` (a callable
  the test supplies, defaulting to a tiny interpreter for `cat`, `ls`,
  `printf`, `sleep` that honours the timeout), and recorded calls so tests
  can assert what the manager asked for. It must enforce the same
  invariants the real backend does (uploads read-only to UID 1000), so
  tests of the layers above mean something.

**Tests** (`apps/server/tests/test_sandbox_core.py`): `wrap_command`
clamps and quotes nothing (it is an argv); `StreamCap` on 10 MB keeps
exactly the head and tail, sets `truncated`, and stays bounded in memory
(feed it in chunks); 124 and 137 map to `timed_out`; `FakeBackend` keeps
files across `stop()` and loses them on `destroy()`.

**Verify:** `make test-backend` (or, without Docker, `cd apps/server &&
uv run --frozen python -m pytest tests/test_sandbox_core.py -q`);
`make test-types`.

### T11: `SandboxManager` lifecycle

*Author: any. Verify: any. Depends: T10.*

`apps/server/local_llm/sandbox/manager.py`, one instance on
`app.state.sandbox` (created in `main.py`'s `lifespan`, near the other
`app.state` tasks at `main.py:417-423`, closed in `_shutdown` at
`main.py:490`). It is the only module that talks to the backend.

- **Per-chat lock:** `dict[str, asyncio.Lock]`; every operation on a chat
  holds its lock, so concurrent tool calls never interleave.
- **Concurrency cap:** an `asyncio.Semaphore(max_running)` held while a
  sandbox is *running* (acquired on create, released on stop/destroy), so
  a fifth chat waits until one stops. The wait is visible: the tool call
  emits a status event ("waiting for a free sandbox") through the event
  emitter after one second.
- **Lazy create:** the first call for a chat resolves its sandbox key:
  - a **saved chat** (a row exists, `Chats.get_chat_by_id`, owned by or
    readable by the caller): the key is the chat id, and the sandbox is
    persistent (volume kept, retention applies);
  - an **unsaved chat** (an id starting with one of
    `NON_SAVED_CHAT_ID_PREFIXES` in `utils/chat_id.py`, including the
    harness's `temporary:benchmark-<uuid>`; use that tuple, not a copy of
    the prefixes): per Q5, an
    **ephemeral** sandbox, keyed by a UUID the manager generates and maps
    from the chat id in memory; its volume is destroyed whenever its
    container stops;
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
  when stopped, and the startup sweep destroys any left over.
- **Harness items:** an API to destroy a chat's sandbox now
  (`manager.release(chat_id)`), which the harness calls when an item
  finishes (T30), so ephemeral harness sandboxes never idle in a slot. Last use is a label or a manager-side
  record updated on each call; choose one in this task and say which in
  the docstring.
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
startup sweep stops leftovers; an unknown or unreadable chat id is
refused before the backend is called; a `temporary:` id gets an
ephemeral sandbox that the sweep leaves alone while running and that
`release()` destroys with its volume.

**Verify:** the tests above; `make test-backend`; `make test-types`.

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
`FakeBackend`, the helper is emulated.

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
  user='1000:1000', cap_drop=['ALL'], security_opt=['no-new-privileges'],
  read_only=True, tmpfs={'/tmp': 'size=256m'}, mem_limit='4g', nano_cpus=2e9,
  pids_limit=512, network='local-llm_sandbox',
  volumes={'lllm-sandbox-<chat id>': {'bind': '/workspace', 'mode': 'rw'}},
  working_dir='/workspace', detach=True, auto_remove=False,
  command=['sleep', 'infinity'] (under the image's tini)
  ```
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

### T15: sandbox images

*Author: any. Verify: docker, host-internet. Depends: T02.*

Under `infra/sandbox/`:

- `common/`: `install-common.sh` (bash, git, sqlite3, DuckDB CLI pinned
  by version and checksum, poppler-utils, tini if the base lacks it),
  `lllm-path` (T12's confinement helper), `sitecustomize.py` (T21),
  `pip.conf`-equivalent environment (T16), `bash.bashrc` additions for
  the command-miss hook (T21).
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
  `docker run --rm local-llm/sandbox-data:<tag> pip freeze` to
  `infra/sandbox/image-freeze.txt`, committed.

**Docs:** `docs/guides/sandbox.md` "Images": what each contains, how to
rebuild, how the tag is bumped, the image sizes measured.

**Verify (docker, host-internet):** both images build from clean; inside
`data`: `python -c 'import pandas, scipy, sklearn'`, `Rscript -e
'library(dplyr); library(lme4)'`, `latexmk -v`, `pdftoppm -v`, `kpsewhich
-var-value=shell_escape` prints `f`; inside `web`: `tsc --version`,
`npx playwright --version` and a headless screenshot of a local HTML file.
Record sizes.

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
    `pids_limit`, no published port, `networks: [sandbox]` only;
  - a `sandbox` network with `internal: true` (Compose names it
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
failure; the Run endpoint refuses without a chat id and for an unreadable
chat; sub-agent settings keep the feature.

**Verify:** the tests; `make test-backend`; on the laptop, a model
without native tool calling runs a `<code_interpreter>` block (acceptance
test "Tag path").

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

### T29: step 1 gate

*Author: local. Verify: docker, kvm, owner. Depends: T10-T23.*

`make check` on the branch head; `LLLM_TEST_KATA=1` suite; with the owner,
the step 1 acceptance tests from the proposal, each recorded in the PR
body's `## Laptop checks` with date and commit: network fence, VM
boundary, cross-chat isolation, persistence, read-only uploads, timeout,
fork bomb, memory, output flood, outputs, mirror installs, image
switching, output rendering, LaTeX, telemetry, tag path, parallel
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
