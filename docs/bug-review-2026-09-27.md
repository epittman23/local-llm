# Bug review: `claude/monorepo-frontend-refactor-gh12a2` (2026-09-27)

A review of the branch against `main` (124 commits, 982 files), written so a
later session can fix what it found without re-deriving it. Each finding has
where it is, what goes wrong, how it was confirmed, a suggested fix and the
test that would have caught it.

## Status: fixed (2026-09-27)

Every finding below has been addressed; the body is kept as the record of
what was wrong. Where a fix differs from the suggestion, it says so here.
Tests that fail on the old code and pass on the fix are marked ✔.

| # | Fix | Test |
|---|---|---|
| H1 | `routers/notes.py` filters grants only if sent; `models/notes.py` treats `None` as not sent; editor docstring corrected | ✔ `tests/test_notes_access_grants.py` |
| H2 | `ChatPage` only takes models from `session.chat` when its id matches the route | ✔ e2e `chat.spec.ts` "switching to another saved chat…" |
| H3 | `loadChat` re-checks the chat id after every await; the `tags` effect too | ✔ `useChatSession.test.tsx` |
| M1 | Serve/Tests start their streams without awaiting them in `onSuccess` | ✔ e2e `benchmarks.spec.ts` "… settles while …" (×2) |
| M2 | Log tee opened unbuffered, flushed before the recorder is stopped | ✔ `test_launcher.py` log-on-disk |
| M3 | `ServeProcess.stop()` always called: Serve drain task on self-exit, `tune_probe` after clean SIGINT | ✔ `test_serve_router.py` drain; `test_launcher.py` idempotent stop |
| M4 | `profile_version_id` threaded serve/tune → `ServeProcess` → `--profile-version-id` → `open_run` | ✔ launcher argv + serve router |
| M5 | `asyncio.Lock` around `/serve/start` | ✔ concurrent-start test |
| M6 | "on" removed from the UI; backend treats `spec: "on"` as no override | ✔ serve router |
| M7 | Argv fields keep raw text, split shell-style on submit (quotes supported) | ✔ `profileForm.test.ts` |
| M8 | `validate_definition` stores blank `reasoning_effort_default`/`override_tensors` as `None`; `resolve` treats a legacy `''` as none; form sends `null` | ✔ `test_serving_profiles.py` |
| M9 | Location wired into `{{USER_LOCATION}}`. **Differs:** personal tool/terminal servers need a browser-side executor that was never ported, so the Integrations tab now shows a "not yet available in chat" notice and it's a documented gap in `docs/CLAUDE.md` | — |
| L1 | Pending params are flushed to the chat being left, then cleared | — |
| L2 | `continueReply` handles `res.error` | — |
| L3 | Stop before the POST returns cancels the tasks once their ids arrive | — |
| L4 | Expiry timer (re)starts on any sign-in via an auth-store subscription; guard now checks status | — |
| L5 | Reconnect listeners on `socket.io` (the Manager) | — |
| L6 | Settings saves refused until settings have loaded | — |
| L7 | Profiles client always throws a readable string (422 lists flattened) | ✔ `profileForm.test.ts` |
| L8 | Backend validates profile names; panel validates, resets fields and errors per view | backend validation checked by hand |
| L9 | `-np` and `--parallel=N` caught too | ✔ `test_serving_profiles.py` |
| L10 | Spawn failure closes and removes the temp log | — |
| L11 | Telemetry start failures set `telemetry_warning` and are logged | — |
| L12 | `/serve/check` reports the running job's profile | — |
| L13 | `user-import.csv` restored to `apps/web/public/static/` | — |
| L14 | Backend seeds `/static` from `apps/web/public/static` when there is no build; stale comment fixed | — |
| L15 | CORS gains `127.0.0.1:5174`. **Differs:** the `--reload` orphan is documented in the `Makefile`, not fixed | — |
| L16 | The nine dead API functions (and their orphaned types) deleted | — |
| L17 | Stream `AbortController` stored before the fetch; stale streams leave state alone; Tests aborts on unmount | — |
| L18 | A replaced server dialog is answered as a cancel; dialogs keyed by identity | — |

Suites after the fixes: 553 Vitest (+6), 327 Playwright (+3), 242 backend
pytest (+14), `astro check` 0 errors. The serving fixes were exercised only
against stub processes, never a real llama-server.

## Scope

Reviewed:

- **All of `apps/web/src`**, with the most attention on chat
  (`useChatSession`, `ChatPage`, `lib/chat/*`), Markdown rendering (XSS
  surface), auth/session/socket, Notes, Channels, Knowledge uploads, admin
  Connections, and all of Benchmarks.
- **The backend code this branch wrote itself**: `benchmarks/serving/*`,
  `benchmarks/env_profile.py`, `routers/benchmarks/{serve,profiles}.py`,
  `models/benchmark_profiles.py`, migration `5a1f0c3e9b27`, and the diffs to
  `tune_probe.py`, `tune_schedule.py`, `proc.py`, `main.py`, `env.py`,
  `config.py`.
- **`Makefile`, `infra/docker-compose.yml`, `astro.config.mjs`.**
- **Every API call.** A script checked each frontend
  `${WEBUI_API_BASE_URL}/...` path and HTTP method against the backend's
  route decorators (577 routes).

Not line-reviewed: the vendored upstream Open WebUI backend. Upstream code
only appears here where the new frontend depends on how it behaves (finding
H1).

Checks run during the review:

| Check | Result |
|---|---|
| `bunx vitest run` (apps/web) | 547/547 pass |
| `astro check` | 0 errors, 0 warnings, 13 hints |
| backend pytest (`WEBUI_SECRET_KEY=x .venv/bin/python -m pytest tests`) | 228/228 pass. Without `WEBUI_SECRET_KEY` it fails at import (`env.py:775`). |
| Playwright | not run (needs a browser and dev server) |

Everything passes, yet none of the high or medium findings below is covered
by a test. The last section lists the tests worth adding.

## Summary

| # | Sev. | Area | Finding |
|---|---|---|---|
| H1 | High | Notes | Every autosave wipes the note's sharing (all access grants) |
| H2 | High | Chat | Switching between saved chats keeps the previous chat's models, so the next message goes to the wrong model |
| H3 | High | Chat | `loadChat` race can show chat A under `/c/B`, and a later save writes A's history into B |
| M1 | Med | Benchmarks UI | Serve "Start" and Tests "Run" stay on "Starting…" for the whole server lifetime or test run |
| M2 | Med | Serving | The server-log tee is buffered and closed after the recorder's final read, so load info is truncated |
| M3 | Med | Serving | `ServeProcess.stop()` is skipped after a graceful or self-exit: temp logs and file descriptors leak on every tune visit and every crash |
| M4 | Med | Serving | `benchmark_run.profile_version_id` is never written (always NULL) |
| M5 | Med | Serving | `/serve/start` single-flight check isn't atomic, so two clicks start two servers and orphan one |
| M6 | Med | Serve UI | "Speculative decoding: on" passes a literal `on` argument to llama-server |
| M7 | Med | Profiles UI | The spec/samplers/extra inputs eat commas and trailing spaces as you type |
| M8 | Med | Profiles | New profiles store `reasoning_effort_default: ''`, so the launcher passes flags the fingerprint doesn't record |
| M9 | Med | Chat | Personal tool servers, terminal servers and "Allow User Location" are saved but never used |
| L1–L18 | Low | various | See "Low severity" |

---

## High

### H1. Notes autosave wipes the note's access grants on every save

**Where**
- `apps/web/src/routes/notes/NoteEditorPage.tsx:54`: the save sends
  `{ title, data }` and leaves out `access_grants`. The docstring at lines
  36–38 assumes that "omitting `access_grants` leaves sharing untouched".
  It doesn't.
- `apps/server/backend/open_webui/routers/notes.py:557`: `update_note_by_id`
  always runs `form_data.access_grants = await filter_allowed_access_grants(...)`.
  With nothing sent, the filter returns `None`, and the assignment still
  runs.
- In Pydantic v2, assigning to a field adds it to `model_fields_set`. So
  `models/notes.py:348` (`form_data.model_dump(exclude_unset=True)`) now
  contains `access_grants: None`.
- `models/notes.py:361`: `if 'access_grants' in form_data:` calls
  `AccessGrants.set_access_grants('note', id, None)`.
  `models/access_grants.py:443-460` **deletes every grant** for the note,
  then inserts nothing.

**Confirmed**
- Ran in the backend venv:
  ```python
  f = NoteForm(title='t', data={...})   # dump keys: ['title', 'data']
  f.access_grants = None                # dump now includes 'access_grants': None
  ```
- The Svelte editor always sent
  `access_grants: note?.access_grants ?? []` (`d863707:.../notes/NoteEditor.svelte:214-219`),
  so this is a regression introduced by the port.
- The other resources (prompts, knowledge, tools, skills, models, channels,
  calendar) check `is not None` and are not affected. Notes is the only one
  that tests `'access_grants' in` after an unconditional assignment.

**Impact.** Share a note, then type in it: within 500 ms it is private
again. If a collaborator with write access edits the note, their autosave
removes the owner's grants, including the collaborator's own.

**Fix.** Make both changes:
1. Backend (the real fix, since any client hits it): in `routers/notes.py`
   `update_note_by_id`, only filter and assign when the client sent the
   field:
   ```python
   if 'access_grants' in form_data.model_fields_set:
       form_data.access_grants = await filter_allowed_access_grants(...)
   ```
   Or change `models/notes.py:361` to
   `if form_data.get('access_grants') is not None:`. The first keeps "send
   `[]` to clear" working. This is vendored upstream code, so record the
   change in `docs/CLAUDE.md`'s decisions log.
2. Frontend: fix the misleading docstring. Optionally send the current
   grants read from the query cache (`['notes','item',id]`) rather than a
   stale closure, so the save can't race `saveAccess`.

**Tests.** A backend test that a `POST /notes/{id}/update` without
`access_grants` leaves existing grants in place. An e2e test that shares a
note, edits the body, reloads, and checks the grants are still there.

### H2. Switching between saved chats keeps the previous chat's model selection

**Where**
- `apps/web/src/routes/chat/ChatPage.tsx:115-132`: the "a saved chat brings
  its own models" effect.
- `apps/web/src/routes/chat/useChatSession.ts:120-136`: on a route change,
  `loadChat` starts but `chat` is not reset. It is only replaced once the
  fetch finishes (line 92).

**Sequence.** Chat A is open and the user clicks chat B. `ChatPage` renders
with `id = B` while `session.chat` is still A's record. The effect runs:
`saved = A.chat.models`, `pickedFor.current = B`, then
`setSelectedModels(A's models)`. When B's record arrives, the effect runs
again and returns early, because `pickedFor.current === id`. B keeps A's
models: the selector shows them and `requestReply` sends to them.

**Confirmed.** Traced by reading the code: `ChatPage` stays mounted across
`/c/:id` changes (one element for the three chat paths, `AppRouter.tsx:57`).
Svelte's `loadChat` always reset `selectedModels` from the chat it had just
loaded. You won't notice when both chats use the same model, which is why
single-model smoke tests missed it.

**Fix.** Only accept `saved` when it belongs to the current route, e.g.
`if (session.chat?.id !== id) return;` before setting `pickedFor`. Or
`setChat(null)` in the route effect in `useChatSession`.

**Test.** An e2e test with two mocked chats on different models: open A,
open B, and check B's selector and the `model` in the outgoing completion
request.

### H3. `loadChat` race: a slow load of chat A can overwrite chat B

**Where.** `apps/web/src/routes/chat/useChatSession.ts:72-100`. After
`await getChatById` (line 75) the code checks `chatIdRef.current !== id`
(line 76). It does not check again after the second
`await getTaskIdsByChatId` (line 84), then calls `setChat`, `setParams`,
`setChatFiles` and `setHistory` (92–98).

**Sequence.** Open A, then quickly open B. If B's two requests finish before
A's `getTaskIdsByChatId`, A's continuation overwrites everything: the URL is
`/c/B` but A's messages are on screen. The next branch switch, edit, rating
or delete calls `save()` (line 347), which sends
`updateChatById(B, { history: A's history, ... })`. **That overwrites chat B
on the server.**

**Fix.** Re-check `chatIdRef.current !== id` after every `await` in
`loadChat`, or capture a per-load token or `AbortController` and bail out if
it is stale. The `'tags'` effect (line 154) should check the chat id the
same way before calling `setChat`.

**Test.** A unit test with `getTaskIdsByChatId` resolving late for A and
early for B. The hook must end up showing B.

---

## Medium

### M1. Serve "Start" and Tests "Run" stay pending for the whole stream

**Where**
- `apps/web/src/routes/benchmarks/ServePage.tsx:170-173`:
  `onSuccess: async () => { await startLogStream(); ... }`.
- `apps/web/src/routes/benchmarks/TestsPage.tsx:153`:
  `onSuccess: () => startStream()`, which returns the promise.

Both stream promises only resolve when the SSE stream ends: the server stops,
or the run finishes. TanStack Query v5 awaits `onSuccess` before switching
the mutation to success (`node_modules/@tanstack/query-core/build/modern/mutation.js:181-185`,
v5.103.1). So `isPending` stays true the whole time. The button reads
"Starting…" and stays disabled, and on Serve the `['serve-check']`
invalidation after the `await` never runs until the server stops.

**Confirmed.** Svelte called `startLogStream();` / `startStream();` without
awaiting them (`Serve.svelte` handleStart, `Tests.svelte:123`).

**Fix.** `onSuccess: () => { void startLogStream(); return queryClient.invalidateQueries(...) }`,
and `onSuccess: () => { void startStream(); }`.

### M2. The server-log tee is buffered, and closed only after the recorder's last read

**Where**
- `apps/server/backend/open_webui/benchmarks/serving/launcher.py:320`:
  `open(self.server_log_path, 'wb')`, a buffered writer (4–8 KiB).
- `launcher.py:366`: each line is written with no flush.
- `stop()` (lines 404–420) closes the file only **after** it has SIGTERMed
  and awaited the recorder.
- The recorder reads the log in two places. The first is when `/metrics`
  first answers (`telemetry_recorder.py:385-389`). Once that returns anything,
  `load_seen = True` and it never re-reads. The second is in `finish()` on
  shutdown (`396`, `410-412`). At that point the tail is still in the
  backend's buffer.

**Impact.** The last few KiB of llama-server's load output never reach the
recorder. That tail includes lines like `n_slots = …, kv_unified = …` and
often `load_tensors: offloaded N/M layers to GPU`. `run_load_info` rows then
lose `n_slots`/`kv_unified`, or fall back to a split derived from `-ngl`
(`derived = 1`). This silently degrades benchmark metadata; the shell
original used `tee`, which doesn't have this problem.

**Fix.** Open the file with `buffering=0`, or call `flush()` after each
`write`. In `stop()`, flush and close the file **before** signalling the
recorder. Optionally have the recorder keep re-reading until the split line
appears.

**Test.** Feed `lines()` a fake process that prints the log, then check the
on-disk file has every line before `stop()` returns and before the recorder
would be signalled.

### M3. `ServeProcess` cleanup is skipped on graceful stop and on self-exit

**Where**
- `benchmarks/tune_probe.py:198-216` (`Server.stop`): it sends SIGINT and
  waits while the process is running. It only calls
  `await self.cmd.stop(...)` if the process is **still** running
  (`215-216`). After a clean SIGINT exit, `ServeProcess.stop()` never runs.
  The docstring says "the launcher … stops the telemetry recorder itself
  once the server exits". `ServeProcess` only does that inside
  `stop()`/`wait()`.
- `routers/benchmarks/serve.py`: when llama-server exits or crashes on its
  own, nothing calls `_job.stop()`/`_job.wait()`. `POST /stop` then returns
  404, because `not _job.running` (line 146). There is no path left that
  cleans up.

**Impact.** Each tuning visit and each crashed server leaks a
`/tmp/lllm-serve-*.log` file (large at `-lv 4`) plus an open file handle.
The recorder is never SIGTERMed; it only exits after its port-miss limit.
Combined with M2, the crash tail that explains **why** the server died is
never flushed.

**Fix.** Make `ServeProcess.stop()` idempotent and safe to call on an
exited process (it mostly is already). Call it unconditionally in
`Server.stop()` for `ServeProcess`. In `serve.py`, have `_drain_log`'s
`finally` call `await job.stop()`, or start a watcher task on
`job.wait()`.

### M4. `benchmark_run.profile_version_id` is never written

**Where.** The column is added by migration `5a1f0c3e9b27` and declared in
`models/benchmark_configs.py:100`. `models/benchmark_profiles.py:53-55` says
it records "which version a run served, so the complete definition behind
any measurement stays recoverable". Nothing sets it:
- `ServingProfile`/`ResolvedConfig` don't carry the version id.
- `launcher.telemetry_argv` doesn't pass it.
- `telemetry_recorder.open_run` (lines 249–257) leaves it out of its
  `INSERT`.

`grep profile_version_id` outside tests and migrations finds only the
column declarations.

**Impact.** Every run since the migration is NULL. That is indistinguishable
from the pre-migration and hand-started runs NULL is meant to represent.

**Fix.** Thread `entry.version.version_id` from `serve.py` and
`tune_probe.Server.start` into `ServeProcess`, then into `telemetry_argv`
(`--profile-version-id`), then into `open_run`'s `INSERT`. Add a test
alongside `test_launcher.py`'s argv tests.

### M5. `/serve/start` single-flight check isn't atomic

**Where.** `routers/benchmarks/serve.py:104-139`. It checks
`_job.running`, then awaits `BenchmarkRuns.get_any_active_run()` and
`BenchmarkProfiles.get_by_name/get_default()`, and only then assigns
`_job`.

**Impact.** Two concurrent POSTs (a double click, two tabs) can both pass
the check. That starts two llama-server processes on the same port; one
fails to bind, or both load into VRAM. The first `_job` handle is
overwritten, which orphans its process (its own session, so it survives,
and the API can no longer stop it).

**Fix.** A module-level `asyncio.Lock` held across the whole start, or
setting a "starting" sentinel before the first `await`.

### M6. "Speculative decoding: on" passes a literal `on` to llama-server

**Where**
- `apps/web/src/routes/benchmarks/ServePage.tsx:35-39, 166` sends
  `spec: 'on'`.
- `serve.py` maps that to `LLAMA_SPEC=on`.
- `benchmarks/serving/profiles.py` `Overrides.from_env` turns it into
  `('on',)`, since only `''` and `off` are special.
- `launcher.py:138` appends it to argv: `llama-server … on`. The server
  rejects the unknown argument and doesn't start.

This existed before the port (the shell and the Svelte page had the same
option), but it is still broken.

**Fix.** Remove "on", since "Default" already means "the profile's flags".
Or map "on" to "don't send `spec`".

### M7. Profile form: argv list inputs eat commas and trailing spaces as you type

**Where.** `apps/web/src/routes/benchmarks/ProfileDefinitionForm.tsx:36-41`
and `216-237`. The inputs are controlled by
`value={toCsv(definition.spec)}` and
`onChange={set('spec', fromCsv(e.target.value))}`. Each keystroke splits,
trims, drops empty items and joins again. So a comma typed at the end, or a
trailing space, is deleted immediately, and a second item can't be typed in
the normal way. There is also a semantic gap: each item becomes exactly one
argv token, so typing `--temp 1.0` as one item produces a single token that
llama-server rejects. And an argv value that contains a comma (an `-ot`
list in `extra`) can't be represented at all.

**Fix.** Keep the raw text in local state and parse it on submit. Split on
whitespace (shlex-like), which matches how argv works.

### M8. New profiles store `reasoning_effort_default: ''`, so the served flags differ from the fingerprinted ones

**Where**
- `ProfileDefinitionForm.tsx:27` defaults to `''`, and `208-213` sends
  whatever is typed, including `''`.
- `validate_definition` (`profiles.py:135`) doesn't normalize `''` to
  `None`.
- `resolve()` then treats `''` as "a thinking model" (`is None` is false).
- The launcher (`launcher.py:140-142`) passes
  `--chat-template-kwargs {"reasoning_effort":""}`.
- `fingerprint.py` records `reasoning effort: n/a` (`or UNSET`).

**Impact.** Every profile created from the UI launches with a chat-template
kwarg that isn't in its `config_text`. That is exactly the served-versus-
recorded disagreement the fingerprint was designed to rule out, and some
templates render an empty effort badly.

**Fix.** In `validate_definition`, turn `''` into `None` for
`reasoning_effort_default` and `override_tensors`, and send `null` from the
form. Add a `test_serving_profiles.py` case.

### M9. Personal settings that are saved but never used by chat

**Where.** `apps/web/src/lib/chat/request.ts:121-156` (`completionBody`) and
`13-33` (`promptVariables`), compared with Svelte `Chat.svelte:3517-3585`.
The React request has no `tool_servers`, no `terminal_id`, no
`chat_variables`, and never passes a location into the prompt variables.

**Impact**
- Settings → Integrations (personal tool servers and terminal servers,
  `components/settings/personal/Integrations.tsx`) saves and lists servers,
  but chats never receive them.
- Interface → "Allow User Location" saves, but `{{USER_LOCATION}}` is
  always "Unknown".

None of these appear in the deliberate-gaps list in `docs/CLAUDE.md`'s
Phase 10 entry.

**Fix.** Port the `tool_servers`/`terminal_id` assembly and the
location lookup. Or hide these settings and add them to the documented
gaps.

---

## Low severity

- **L1. Chat params debounce can leak across chats.**
  `routes/chat/ChatPage.tsx:174-182`. `paramsDirty` isn't reset when `id`
  changes. If you edit Controls and switch chats within 500 ms, the edit to
  the chat you left is dropped. If the next chat's load takes longer than
  500 ms, the old chat's params are written into the new one.
- **L2. `continueReply` ignores `res.error`.**
  `useChatSession.ts:383-388`. `requestReply` handles it (238–241);
  "continue" doesn't. The message stays `done: false`, so the spinner never
  stops and the message queue is blocked.
- **L3. Stop before the POST returns doesn't stop the task.**
  `useChatSession.ts:312-324`. In a new chat, `taskIds` isn't known yet, so
  `stop()` only marks the reply done locally. The server keeps streaming,
  and `applyChatEvent` keeps appending to a message that says it is done.
- **L4. Token-expiry timer.**
  `lib/auth/session.ts:218-219`. The timer only starts in `initAuth`.
  After signing in from `/auth` (no reload), or after `clearExpiredSession`,
  `checkTokenExpiry` never runs again; only the 401 fetch guard catches
  expiry. Separately, `isAuthRedirectInProgress` is set and cleared in the
  same synchronous block (`106-118`), so it never guards anything.
- **L5. Socket reconnect listeners never fire.**
  `lib/socket/SocketProvider.tsx:73-79`. In socket.io-client v4,
  `reconnect_attempt`/`reconnect_failed` are Manager events
  (`socket.io.on(...)`), not Socket events. They only log, but anyone later
  attaching real behaviour (the promised reconnect toasts) will find they
  never fire.
- **L6. A silently failed settings load plus any save wipes all UI
  settings.** `lib/settings/userSettings.ts:99,123`. The API replaces `ui`
  wholesale, and `update` merges into `query.data ?? {}`. The ported API
  helpers return `null` on network errors, so the query yields `{}` and
  the next save overwrites everything. Fix: refuse to save until
  `query.isSuccess`, and make `getUserSettings` throw on failure.
- **L7. The ported fetch helpers swallow errors.** This is systemic,
  inherited from upstream, and repeated in the new
  `lib/apis/benchmarks/profiles.ts:14-39`. The pattern
  `.catch(err => { error = err.detail })` returns `null` instead of throwing
  on network errors and non-JSON bodies. A 422 `detail` array shows up as
  `[object Object]` in the ProfilesPanel and Serve error banners. Fix in
  the new code first: `error = err?.detail ?? err`, and format arrays.
- **L8. ProfilesPanel validation and state.**
  `routes/benchmarks/ProfilesPanel.tsx:255-332`.
  - The `required` name/display-name inputs sit outside the `<form>`, so
    nothing enforces them. An empty `name` is accepted (the backend's
    `name: str` has no constraint), which makes a profile no URL can reach.
  - A profile literally named `default` is shadowed by `GET /profiles/default`
    (`routers/benchmarks/profiles.py:114-124`).
  - `newName`/`newDisplayName` are shared between Create and Clone and
    never reset.
  - `error` is never cleared on success.
  - Fix: validate `name` on the backend (non-empty, `[a-z0-9_-]+`, not
    `default`), since it also becomes a tuning grid filename
    (`tune_schedule.py:328-330`).
- **L9. `-np` bypasses the `--parallel` guard rails.**
  `profiles.py:158, 284`. llama-server's short form isn't checked by
  `validate_definition` or by `resolve`.
- **L10. `ServeProcess.start()` leaks on spawn failure.**
  `launcher.py:316-328`. If `create_subprocess_exec` raises, `_log_file`
  and the temp file are never cleaned up.
- **L11. Telemetry start failures are silent.**
  `launcher.py:339-355`. Exceptions in `_start_telemetry` (`llama_server_build`,
  spawning the recorder) are only suppressed in `stop()`. No
  `telemetry_warning` is set, so a run simply isn't recorded.
- **L12. `/serve/check` shows the wrong profile.** `serve.py:152-163`
  reports the **default** profile's name, not the running job's.
- **L13. Broken link to the user CSV template.**
  `routes/admin/users/AddUserModal.tsx:198` links
  `/static/user-import.csv`. That file was deleted with the Svelte app
  (`apps/openwebui/static/static/user-import.csv`) and isn't in
  `apps/web/public/static`, so the link 404s. Restore it to
  `apps/web/public/static/`.
- **L14. Static assets missing in dev mode without a build.** At boot the
  backend copies the top-level `STATIC_DIR` files from
  `apps/web/dist/static` (`config.py:97-142`). A fresh clone running
  `make backend` + `make frontend` without `bun run build` has no
  `/static/favicon.png`. That breaks the model-avatar fallback and
  `routers/channels.py:1834,1862`'s `FileResponse`. The comment in
  `astro.config.mjs` about the `/static` proxy ("there is no such folder in
  this app's public/") is also out of date.
- **L15. Dev-only process issues.**
  - `make backend` runs uvicorn with `--reload`. A reload kills the worker
    holding `_job`, while llama-server survives in its own session. The
    result is an orphaned server and a UI that reads "Stopped".
  - The CORS list (`Makefile:88`) has no `http://127.0.0.1:5174`, so
    browsing the dev server by IP fails socket.io's origin check.
- **L16. Unused API functions that point at routes the backend doesn't
  have.** Cleanup candidates; each would 404 if wired up:
  - `files.uploadDir` (`/files/upload/dir`)
  - `images.get/updateImageGenerationConfig` (`/images/image/config`)
  - `retrieval.get/updateQuerySettings` (`/query/settings`)
  - `retrieval.get/updateRerankingConfig` (`/reranking`)
  - `users.updateUserRole` (`/users/update/role`)
  - the ollama `/urls` helper
- **L17. SSE streams can outlive the page.** `ServePage.tsx:107-134` and
  `TestsPage.tsx:93-133`. The abort controller is stored only after
  `await streamX()`, so unmounting during that await leaks the SSE
  connection and later calls `setState` on an unmounted component.
- **L18. ServerDialogs keeps state across dialogs.**
  `routes/chat/ServerDialogs.tsx`. A second `confirmation`/`input` event
  replaces the first without replying to it, so the server waits until its
  own timeout. Nothing keys the dialog component by identity either, so
  input state carries over. Upstream behaves the same way; lower priority.

## Checked and fine

These looked risky and turned out to be fine, so a later session doesn't
need to re-check them:

- **Markdown/XSS.** Model output goes through a token renderer, not HTML
  strings. React 19 blocks `javascript:` hrefs. Iframes are sandboxed
  (`sandbox=""`, or scripts without same-origin). Mermaid uses
  `securityLevel: 'strict'`. KaTeX runs with `trust: false`. Every other
  HTML sink passes through DOMPurify.
- **API paths and methods.** Every used path and HTTP method matches a
  backend route. The only mismatches are the unused functions in L16.
- **Other resources' access grants.** The H1 mechanism does not affect
  prompts, knowledge, tools, skills, models, channels or calendar (they use
  `is not None`).
- **`applyChatEvent` and `normalizeHistory`.** They match Chat.svelte's
  semantics, including the `done !== false` rule.
- **Knowledge "upload directory".** It uploads the whole manifest, not the
  diff, which is also what Svelte did.
- **The chat input** blocks sending while files are still uploading.
- **Async sessions** use `expire_on_commit=False`, so the ORM objects read
  after commit in `benchmark_profiles.py` are safe.
- **The authored backend unit tests** all pass.

## Tests to add along with the fixes

1. Backend: a note update without `access_grants` keeps existing grants
   (H1).
2. e2e: open two saved chats with different models, one after the other;
   check the selector and the outgoing request `model` (H2).
3. Unit: `useChatSession` with `getTaskIdsByChatId` resolving late for chat A
   and early for chat B (H3).
4. e2e: Serve Start and Tests Run return to their idle label while the
   stream is still open (M1).
5. Backend: `ServeProcess` log file contents are complete before the
   recorder is signalled, and `stop()` runs after a graceful exit (M2, M3).
6. Backend: `open_run` records `profile_version_id` (M4); `'' → None`
   normalization (M8).
