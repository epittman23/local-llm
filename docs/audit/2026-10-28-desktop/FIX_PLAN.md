# Fix plan for the 2026-10-28 desktop app audit

This plan is self-contained, written for a future session with no memory of
the audit. Findings are in [FINDINGS.md](FINDINGS.md), reproductions in
[repro/](repro/README.md), and non-bug observations in [NOTES.md](NOTES.md).
Security findings are deliberately absent from this repository; the owner
handles them through private security advisories.

## 1. Context

- **Audited commit:** `6c07575fa7cc93e1ad14e16d6aad41cb770141db` (`main`,
  "feat(benchmarks): LiveCodeBench, drawn from a per-run release-date window
  (#419)"). Every line reference here and in the issues refers to it.
  Re-locate lines on current `main` before editing.
- **Scope:** `apps/desktop/` in full, with the code it depends on read as
  context (the list is in [COVERAGE.md](COVERAGE.md)). The desktop app was
  added on 2026-10-23 (#377), after the full-repository audit in
  `docs/audit/`, so this was its first review.
- **Environment setup that worked** (the owner's laptop, Fedora 44):
  - a separate worktree on `main`;
  - `infra/.env` copied in;
  - the backend venv from `uv sync --frozen --no-install-project --group dev`;
  - `cd apps/desktop && bun install --frozen-lockfile`.

  The repros need only the desktop dependencies (see
  [repro/README.md](repro/README.md)). Electron was never launched, and
  neither was a real stack: the `src/main.ts` repros run it against a fake
  Electron.
- **Baseline** (2026-10-28, each Make target run on its own; the owner chose
  these three, since another checkout on the same machine was using Docker
  and the dev ports):

  | Check | Result |
  |---|---|
  | `make lint` | pass, no files changed |
  | `make test-desktop` | pass: typecheck clean; Vitest 44/44 in 4 files; `package:dir` built `release/linux-unpacked` |
  | `make test-boot` | pass: 149 GET routes swept, clean shutdown (exit 0) |
  | `make test-backend`, `test-types`, `test-web`, `test-e2e` | not run: out of scope, and they share ports and Docker with the other checkout |

## 2. Summary, execution order and per-bug detail

Recommended sequence:
1. **B0** first: security, 1 finding, tracked in the repository's private
   security advisories (drafts), not here. Its details are deliberately not
   in this public file; read them from the advisories (the repository's
   Security tab).
2. Then **B1**, then **B2**. These carry the four Medium issues and the
   design's two promises: a terminal stack is never touched, and the group
   gets one SIGINT.
3. Then **B3** and **B4**, in either order.
4. **B5** at any point, once the owner has approved the gate change.

### Summary

| Issue | Finding | Title | Severity | Area | Status | Location | Effort |
|---|---|---|---|---|---|---|---|
| [#420](https://github.com/epittman23/local-llm/issues/420) | A-01 | A [::1] or https:// loopback server URL makes the app start a backend it can never reach, and can stop a terminal stack's services | Medium | desktop | Confirmed | `config.ts:40` | S |
| [#421](https://github.com/epittman23/local-llm/issues/421) | A-02 | After a forced stop that leaves a llama-server, "Leave it" does nothing and the dialog cannot be closed | Medium | desktop | Confirmed | `status.js:46` | S |
| [#422](https://github.com/epittman23/local-llm/issues/422) | A-03 | A backend that is starting, reloading or busy is taken for "nothing running", and the second make backend the app starts stops its services | Medium | desktop | Confirmed | `main.ts:333` | M |
| [#423](https://github.com/epittman23/local-llm/issues/423) | A-04 | A Cancel during the last readiness probe still opens the app window, and closing it then sends a second SIGINT | Medium | desktop | Confirmed | `main.ts:261` | S |
| [#424](https://github.com/epittman23/local-llm/issues/424) | A-05 | Settings shows the stored server URL, not an active --server-url / LLLM_SERVER_URL override, and saving cannot replace it | Low | desktop | Confirmed | `main.ts:114` | S |
| [#425](https://github.com/epittman23/local-llm/issues/425) | A-06 | The window size is not saved when the app quits from the menu, Ctrl+Q, a signal or Restart now | Low | desktop | Confirmed | `main.ts:230` | S |
| [#426](https://github.com/epittman23/local-llm/issues/426) | A-07 | A failed settings save shows no message in the dialog | Low | desktop | Confirmed | `main.ts:519` | S |
| [#427](https://github.com/epittman23/local-llm/issues/427) | A-08 | A stop that times out on open requests shows the job and model steps as "skipped: none running" | Low | desktop | Confirmed | `main.ts:464` | S |
| [#428](https://github.com/epittman23/local-llm/issues/428) | A-09 | make backend breaks when the checkout path contains a space or a quote | Low | infra | Confirmed | `Makefile:36` | S |
| [#429](https://github.com/epittman23/local-llm/issues/429) | A-10 | The UI staleness check misses renamed and deleted files and tsconfig.json, so the app serves an out-of-date build | Low | desktop | Confirmed | `stack.ts:66` | S |
| [#430](https://github.com/epittman23/local-llm/issues/430) | A-11 | A progress test asserts that the optional force step has no detail, which cannot fail | Low | desktop | Confirmed | `progress.test.ts:80` | S |
| [#431](https://github.com/epittman23/local-llm/issues/431) | A-12 | owned.json records neither the server address nor the checkout, so a crashed stack can be adopted on the wrong port or never stopped | Low | desktop | Confirmed | `stack.ts:109` | S |
| [#432](https://github.com/epittman23/local-llm/issues/432) | A-13 | Any server answering on localhost:5174 is taken for make frontend and loaded as the app | Low | desktop | Confirmed | `main.ts:333` | S |
| [#433](https://github.com/epittman23/local-llm/issues/433) | A-14 | The make backend child has no error listener, so a login shell that cannot be spawned raises an uncaught exception in the main process | Low | desktop | Confirmed | `main.ts:393` | S |
| [#434](https://github.com/epittman23/local-llm/issues/434) | A-15 | After a forced stop, the llama-server offer and "Stop llama-server" cover every llama-server the user runs, not the one this stack served | Low | desktop | Confirmed | `stack.ts:223` | M |
| [#435](https://github.com/epittman23/local-llm/issues/435) | A-16 | A clean stop never checks make's exit status, so a failed compose down still shows "Stop the services" as done | Low | desktop | Confirmed | `stack.ts:286` | S |
| [#436](https://github.com/epittman23/local-llm/issues/436) | A-17 | The app grants the server origin the camera too, while the docs say it gets only the microphone | Low | desktop | Confirmed | `policy.ts:30` | S |
| [#437](https://github.com/epittman23/local-llm/issues/437) | A-18 | A hand-edited config.json with an unparseable server URL silently falls back to the local default, and the next close overwrites the edit | Low | desktop | Confirmed | `config.ts:66` | S |

### Execution order

- **B1 Startup decision** (4 issues): [#420](https://github.com/epittman23/local-llm/issues/420) A-01, [#422](https://github.com/epittman23/local-llm/issues/422) A-03, [#431](https://github.com/epittman23/local-llm/issues/431) A-12, [#432](https://github.com/epittman23/local-llm/issues/432) A-13. Do first. A-01 and A-03 can bring down a terminal stack's services, the one thing the design promises never to touch. All four change how `startup()` and `decideStart` choose attach, adopt or own (config.ts, stack.ts and main.ts's startup), so they belong in one change with one set of decision tests.
- **B2 Stop path and the dialog's states** (5 issues): [#423](https://github.com/epittman23/local-llm/issues/423) A-04, [#421](https://github.com/epittman23/local-llm/issues/421) A-02, [#434](https://github.com/epittman23/local-llm/issues/434) A-15, [#435](https://github.com/epittman23/local-llm/issues/435) A-16, [#427](https://github.com/epittman23/local-llm/issues/427) A-08. Second. These all live in `shutdown()`, `stopGroup` and the progress reducer. A-04 breaks the one-SIGINT rule, and A-02 and A-15 make the forced-stop offer a trap. Fixing them together means introducing an explicit stopped/finished state once, instead of three guards.
- **B3 Settings and config.json** (4 issues): [#424](https://github.com/epittman23/local-llm/issues/424) A-05, [#426](https://github.com/epittman23/local-llm/issues/426) A-07, [#437](https://github.com/epittman23/local-llm/issues/437) A-18, [#425](https://github.com/epittman23/local-llm/issues/425) A-06. Independent of B1 and B2 except for the shared main.ts. These cover what Settings shows and saves, and what config.json keeps.
- **B4 Smaller fixes** (4 issues): [#429](https://github.com/epittman23/local-llm/issues/429) A-10, [#433](https://github.com/epittman23/local-llm/issues/433) A-14, [#436](https://github.com/epittman23/local-llm/issues/436) A-17, [#430](https://github.com/epittman23/local-llm/issues/430) A-11. Independent one-file fixes in any order, after B1 to B3 to avoid conflicts in main.ts and stack.ts.
- **B5 Makefile quoting** (1 issues): [#428](https://github.com/epittman23/local-llm/issues/428) A-09. On its own because the Makefile is a gate file: the PR trips the PR gate and needs the owner's explicit approval (CLAUDE.md, "The CI tripwire").

### Per-bug detail

#### B1 Startup decision

##### A-01 [#420](https://github.com/epittman23/local-llm/issues/420): A [::1] or https:// loopback server URL makes the app start a backend it can never reach, and can stop a terminal stack's services

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/desktop/src/config.ts:40-49`; `apps/desktop/src/stack.ts:177-186`; `apps/desktop/src/main.ts:261-269`; `apps/desktop/src/main.ts:330-345`; `apps/desktop/src/main.ts:393-407`; `apps/desktop/src/main.ts:519-528`; `Makefile:130-152`
- Root cause: The "is this local" decision looks only at the hostname, not at the scheme or the address family the Makefile actually binds.
- Recommended fix: Make managed mode require `http:` and a hostname of `127.0.0.1` or `localhost`, in `isLocalOrigin` or a separate "manageable" check that `saveSettings` also applies; treat other loopback forms as connect-only or reject them in Settings. Separately, bound `waitReady` in own mode.
- Files likely to change: apps/desktop/src/config.ts, apps/desktop/src/stack.ts, apps/desktop/src/main.ts, Makefile
- Regression risks: `isLocalOrigin` also gates the repo-folder check in Settings and the startup branch, so a narrower rule changes which saved URLs are accepted; `config.test.ts` asserts `[::1]` is local and must change with it.
- Docs to update: docs/guides/desktop.md "Settings" ("At 127.0.0.1 or localhost, the app manages the local stack") and the matching hint in static/status.html must state the exact rule.
- Acceptance criteria: A unit test that `http://[::1]:4000` and `https://127.0.0.1:4000` are not treated as managed (or are refused by Settings), and that `http://localhost:4000` and `http://127.0.0.1:4000` still are.

##### A-03 [#422](https://github.com/epittman23/local-llm/issues/422): A backend that is starting, reloading or busy is taken for "nothing running", and the second make backend the app starts stops its services

- Severity / status / effort: Medium / Confirmed / M
- Locations: `apps/desktop/src/main.ts:333-345`; `apps/desktop/src/stack.ts:57-64`; `apps/desktop/src/stack.ts:306-315`; `Makefile:130-132`
- Root cause: "Did /health answer within 1.5 s" is used as "is a backend running", and nothing else (the port, the compose project, another `make backend`) is checked before starting one; the Makefile's EXIT trap then runs `docker compose down` on the shared, pinned `local-llm` project whichever recipe exits.
- Recommended fix: Treat a connection that is accepted but slow as a running backend and wait for it; before choosing `own`, check whether the port is bound or a `make backend` / the compose project is already running, and attach or refuse instead. Optionally make the Makefile trap bring down only what its own recipe started.
- Files likely to change: apps/desktop/src/main.ts, apps/desktop/src/stack.ts, Makefile
- Regression risks: The attach/own decision also drives adoption and the dev-server path; the decision tests in `stack.test.ts` cover only booleans, so the new inputs need cases of their own.
- Docs to update: docs/guides/desktop.md, the "Nothing answering on `:4000`" row of the startup table, should say what counts as nothing.
- Acceptance criteria: A test that a backend accepting connections but slow to answer yields attach (or a wait), not own; and one that a bound port with no answer never starts a second `make backend`.

##### A-12 [#431](https://github.com/epittman23/local-llm/issues/431): owned.json records neither the server address nor the checkout, so a crashed stack can be adopted on the wrong port or never stopped

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/desktop/src/stack.ts:109-160`; `apps/desktop/src/main.ts:319-366`; `apps/desktop/src/main.ts:456-462`
- Root cause: The record lacks the origin and repo the stack was started with.
- Recommended fix: Write the origin and repo into `owned.json`; adopt only on a match, and on a mismatch stop the recorded group with its recorded repo.
- Files likely to change: apps/desktop/src/stack.ts, apps/desktop/src/main.ts
- Regression risks: `parseOwned` must keep accepting records from the current format, or an upgrade forgets a running stack.
- Docs to update: docs/guides/desktop.md "Files" (`owned.json`).
- Acceptance criteria: Unit tests that a record for another origin is not adopted, and that an old-format record still parses.

##### A-13 [#432](https://github.com/epittman23/local-llm/issues/432): Any server answering on localhost:5174 is taken for make frontend and loaded as the app

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/desktop/src/main.ts:333`; `apps/desktop/src/stack.ts:57-60`
- Root cause: The dev-server check is "anything answered", not "our dev server answered".
- Recommended fix: Probe a path that identifies this app through the dev server's proxy (for example `/api/config` returning this backend's JSON) before choosing it.
- Files likely to change: apps/desktop/src/main.ts, apps/desktop/src/stack.ts
- Regression risks: The check must not add latency to the normal start; probe in parallel as now.
- Docs to update: None.
- Acceptance criteria: A unit test that a 5174 answer that does not identify the app is not used.

#### B2 Stop path and the dialog's states

##### A-04 [#423](https://github.com/epittman23/local-llm/issues/423): A Cancel during the last readiness probe still opens the app window, and closing it then sends a second SIGINT

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/desktop/src/main.ts:261-269`; `apps/desktop/src/main.ts:403-409`; `apps/desktop/src/main.ts:240-249`; `apps/desktop/src/main.ts:230-236`; `apps/desktop/src/main.ts:428-431`; `apps/desktop/src/main.ts:655-660`
- Root cause: Cancellation is checked at one point of a multi-step async startup, and the one-SIGINT rule is enforced by the phase variable, which `openApp` overwrites.
- Recommended fix: Check the abort signal after every await in `startup()` (after `waitReady` and in `openApp`'s `ready-to-show`), never set `phase = 'running'` once stopping, and guard the SIGINT per process group rather than through the phase.
- Files likely to change: apps/desktop/src/main.ts
- Regression risks: `openApp` is shared by the attach, adopt, own and remote paths; each must still open normally when not cancelled.
- Docs to update: None.
- Acceptance criteria: A main-process test (Electron faked) that a Cancel while the last probe is in flight sends exactly one SIGINT and opens no app window.

##### A-02 [#421](https://github.com/epittman23/local-llm/issues/421): After a forced stop that leaves a llama-server, "Leave it" does nothing and the dialog cannot be closed

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/desktop/static/status.js:46-50`; `apps/desktop/src/main.ts:164-173`; `apps/desktop/src/main.ts:428-430`; `apps/desktop/src/main.ts:472-477`; `apps/desktop/src/main.ts:561-564`; `apps/desktop/src/main.ts:661-663`
- Root cause: The dialog's `quit` action is wired to `shutdown()`, whose re-entry guard swallows it in exactly the state where the offer is shown; nothing moves the phase on once the offer is made.
- Recommended fix: Give "Leave it" its own action that exits (`app.exit(0)`), or have the offer path set a terminal phase that `quit` handles; let the dialog close once the progress is finished.
- Files likely to change: apps/desktop/static/status.js, apps/desktop/src/main.ts
- Regression risks: The close guard on the dialog also protects a running stop; it must stay in force until the stop has actually finished.
- Docs to update: None.
- Acceptance criteria: A unit test (or a main-process test with Electron mocked) that after the offer, the leave action exits the app without signalling llama-server, and that the dialog can be closed.

##### A-15 [#434](https://github.com/epittman23/local-llm/issues/434): After a forced stop, the llama-server offer and "Stop llama-server" cover every llama-server the user runs, not the one this stack served

- Severity / status / effort: Low / Confirmed / M
- Locations: `apps/desktop/src/stack.ts:223-235`; `apps/desktop/src/stack.ts:286-296`; `apps/desktop/src/main.ts:472-477`; `apps/desktop/src/main.ts:483-491`
- Root cause: The leftover check has no record of which llama-server the owned stack served; it matches by name.
- Recommended fix: Record the served model's pid (for example from the backend, or the profile's port answered by `/check`) while the stack runs, and offer and stop only that process.
- Files likely to change: apps/desktop/src/stack.ts, apps/desktop/src/main.ts
- Regression risks: The served `llama-server` runs in its own session by design, so the record must survive the backend's own exit.
- Docs to update: docs/guides/desktop.md "What happens when it closes" ("offers to stop any `llama-server` still running") should say which one.
- Acceptance criteria: A test that `stopLlama` and the offer ignore a llama-server pid that the owned stack did not report.

##### A-16 [#435](https://github.com/epittman23/local-llm/issues/435): A clean stop never checks make's exit status, so a failed compose down still shows "Stop the services" as done

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/desktop/src/stack.ts:286-299`; `apps/desktop/src/main.ts:470-480`; `apps/desktop/src/progress.ts:117`; `Makefile:130`
- Root cause: The stop path treats "the process group is gone" as success.
- Recommended fix: Check the make child's exit code (or run `docker compose ps` afterwards) and mark the services step failed, keeping the dialog open with the log, when the teardown did not finish.
- Files likely to change: apps/desktop/src/stack.ts, apps/desktop/src/main.ts, apps/desktop/src/progress.ts, Makefile
- Regression risks: An adopted stack has no child handle, so its exit code is unknown; that case needs the `compose ps` check.
- Docs to update: None.
- Acceptance criteria: A test that a non-zero make exit after the SIGINT shows the services step as failed.

##### A-08 [#427](https://github.com/epittman23/local-llm/issues/427): A stop that times out on open requests shows the job and model steps as "skipped: none running"

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/desktop/src/main.ts:464-468`; `apps/desktop/src/progress.ts:147-159`; `apps/desktop/src/progress.ts:100-119`
- Root cause: `settleBefore` cannot tell "a later step began normally" from "the stop was forced", and the forced path reuses it.
- Recommended fix: On a timeout, mark the remaining steps "not reached" instead of applying `skipReason`, and let the force step cover the compose down.
- Files likely to change: apps/desktop/src/main.ts, apps/desktop/src/progress.ts
- Regression risks: Low; the reducer is pure and fully tested.
- Docs to update: None.
- Acceptance criteria: A progress test that times out at `requests` and asserts the later steps are not shown as "none running".

#### B3 Settings and config.json

##### A-05 [#424](https://github.com/epittman23/local-llm/issues/424): Settings shows the stored server URL, not an active --server-url / LLLM_SERVER_URL override, and saving cannot replace it

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/desktop/src/main.ts:114-118`; `apps/desktop/src/main.ts:310-313`; `apps/desktop/src/main.ts:324`; `apps/desktop/src/main.ts:535-541`; `apps/desktop/src/main.ts:573-575`; `apps/desktop/static/status.js:135-147`
- Root cause: The override is applied in `loadConfig()` on every startup, while the settings dialog only ever reads and writes the stored value.
- Recommended fix: Return the effective URL and whether an override is active from `status:get-settings`, show it in the dialog, and either drop the override after a save or say it still applies; relaunch without the `--server-url=` argument.
- Files likely to change: apps/desktop/src/main.ts, apps/desktop/static/status.js
- Regression risks: Low: the override is a one-launch convenience; keep the stored value untouched by it.
- Docs to update: docs/guides/desktop.md "Settings" says the override applies "for one launch"; Restart now currently carries it into the next.
- Acceptance criteria: A test that `status:get-settings` reports an active override, and that the save message does not claim Retry will use the saved URL while one is active.

##### A-07 [#426](https://github.com/epittman23/local-llm/issues/426): A failed settings save shows no message in the dialog

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/desktop/src/main.ts:519-528`; `apps/desktop/static/status.js:135-147`
- Root cause: Neither side handles a write failure: main lets the exception become a rejected invoke, and the page does not catch it.
- Recommended fix: Catch the write error in `saveSettings` and return `{ error }`, which the dialog already displays.
- Files likely to change: apps/desktop/src/main.ts, apps/desktop/static/status.js
- Regression risks: None beyond the message text.
- Docs to update: None.
- Acceptance criteria: A unit test that a throwing `writeConfig` makes `saveSettings` return an error.

##### A-18 [#437](https://github.com/epittman23/local-llm/issues/437): A hand-edited config.json with an unparseable server URL silently falls back to the local default, and the next close overwrites the edit

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/desktop/src/config.ts:66-85`; `apps/desktop/src/main.ts:208-214`
- Root cause: Parsing is lenient by design, and the bounds save rewrites the whole file from the parsed result.
- Recommended fix: Keep the raw file content for fields that fail to parse (write back only what changed), and show "the saved server URL is invalid" in the startup dialog instead of falling back silently.
- Files likely to change: apps/desktop/src/config.ts, apps/desktop/src/main.ts
- Regression risks: The fallback is what keeps a corrupt file from blocking startup; keep starting, but say why.
- Docs to update: None.
- Acceptance criteria: A test that a bounds save leaves an invalid `serverUrl` untouched in the file.

##### A-06 [#425](https://github.com/epittman23/local-llm/issues/425): The window size is not saved when the app quits from the menu, Ctrl+Q, a signal or Restart now

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/desktop/src/main.ts:230-236`; `apps/desktop/src/main.ts:439-442`; `apps/desktop/src/main.ts:450-452`; `apps/desktop/src/main.ts:573-575`; `apps/desktop/src/main.ts:655-663`
- Root cause: Saving the bounds is tied to one event that the app's main exit paths bypass.
- Recommended fix: Save the bounds in `shutdown()` before destroying windows (and before `app.exit`), or save them on `resize`/`move` with a debounce.
- Files likely to change: apps/desktop/src/main.ts
- Regression risks: Low; `saveBounds` already swallows write errors.
- Docs to update: None.
- Acceptance criteria: A test (Electron mocked) that `shutdown()` writes the current bounds before destroying the window.

#### B4 Smaller fixes

##### A-10 [#429](https://github.com/epittman23/local-llm/issues/429): The UI staleness check misses renamed and deleted files and tsconfig.json, so the app serves an out-of-date build

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/desktop/src/stack.ts:66-67`; `apps/desktop/src/stack.ts:73-105`
- Root cause: The walk ignores directory entries, and the list of inputs is incomplete.
- Recommended fix: Include directory mtimes in the walk and add `tsconfig.json` (and any other build config) to `UI_SOURCES`.
- Files likely to change: apps/desktop/src/stack.ts
- Regression risks: A broader check can rebuild more often; a rebuild is what an unchanged tree would avoid, so test both.
- Docs to update: docs/guides/desktop.md ("builds `apps/web` if any source is newer than `dist/`") if the rule changes.
- Acceptance criteria: Unit tests for `isUiStale` after a rename, a deletion and a `tsconfig.json` change.

##### A-14 [#433](https://github.com/epittman23/local-llm/issues/433): The make backend child has no error listener, so a login shell that cannot be spawned raises an uncaught exception in the main process

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/desktop/src/main.ts:393-401`; `apps/desktop/src/stack.ts:208-215`
- Root cause: A missing `error` listener on one of two spawns.
- Recommended fix: Attach an `error` listener to the backend child as `runBuild` does, and report it through `fail()`.
- Files likely to change: apps/desktop/src/main.ts, apps/desktop/src/stack.ts
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: A test that a spawn error is reported once through the progress and raises nothing uncaught.

##### A-17 [#436](https://github.com/epittman23/local-llm/issues/436): The app grants the server origin the camera too, while the docs say it gets only the microphone

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/desktop/src/policy.ts:30-41`; `apps/desktop/src/main.ts:614-619`
- Root cause: Electron's single `media` permission was taken to mean the microphone.
- Recommended fix: Check `details.mediaTypes` in the request handler and allow only `audio` unless the camera is wanted (then document it).
- Files likely to change: apps/desktop/src/policy.ts, apps/desktop/src/main.ts
- Regression risks: If a frontend feature needs the camera (a video call mode), restricting it breaks that feature in the desktop app only.
- Docs to update: docs/guides/desktop.md "Security model" lists the permissions.
- Acceptance criteria: A unit test of the permission rule with `mediaTypes: ['video']`.

##### A-11 [#430](https://github.com/epittman23/local-llm/issues/430): A progress test asserts that the optional force step has no detail, which cannot fail

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/desktop/src/progress.test.ts:80-93`; `apps/desktop/src/progress.ts:156`
- Root cause: The step under test is never settled, and the optional step has no `skipReason` to suppress.
- Recommended fix: Settle an optional step that has a `skipReason` (a later step beginning after it) and assert its detail.
- Files likely to change: apps/desktop/src/progress.test.ts, apps/desktop/src/progress.ts
- Regression risks: None; test only.
- Docs to update: None.
- Acceptance criteria: The rewritten test fails when the optional branch at `progress.ts:156` is removed.

#### B5 Makefile quoting

##### A-09 [#428](https://github.com/epittman23/local-llm/issues/428): make backend breaks when the checkout path contains a space or a quote

- Severity / status / effort: Low / Confirmed / S
- Locations: `Makefile:36`; `Makefile:46`; `Makefile:130-132`; `apps/desktop/src/stack.test.ts:125-135`
- Root cause: The Makefile builds shell commands from `$(REPO_ROOT)` without quoting.
- Recommended fix: Quote `$(REPO_ROOT)` inside `COMPOSE` and the trap (escaping for the trap's quotes), or refuse such paths in the desktop Settings and document the limit.
- Files likely to change: Makefile, apps/desktop/src/stack.test.ts
- Regression risks: The Makefile is a gate file: a change to it trips the PR gate and needs the owner's approval. `COMPOSE` is used by several targets.
- Docs to update: README.md "Running it" if a path limit is documented instead.
- Acceptance criteria: A test or CI check that `make -n backend` from a path with a space produces correctly quoted commands.


## 3. Rules for the fixing session

These come from `CLAUDE.md` (`AGENTS.md`):

- **Branches and PRs:**
  - one branch and one pull request per batch;
  - conventional commit titles;
  - no attribution lines in commits or PRs (no Claude co-author, no
    "Generated with").
  - `main` takes squash-merged PRs only. A non-draft PR merges itself once
    its checks pass, so open it as a draft to hold it.
- **Checks:** run `make check` before opening the PR. At minimum, run
  `make test-desktop` and `make lint` on their own. Run the `pr-gate` skill
  before pushing, and **never bypass the PR gate** without the owner's
  explicit yes.
  - B5 changes the Makefile, a gate file. Its PR needs a `## Gate changes`
    section and the owner's approval.
  - A fix that rewrites a test (A-11) must not lower the test count.
- **Tests:**
  - every fix gets a regression test under `apps/desktop/src/*.test.ts`;
  - turn the matching repro in `repro/` into a real test where it fits.
  - `src/main.ts` has no test harness yet. `repro/P1/main-harness.ts` shows
    a working fake Electron for one: mock the resolved
    `node_modules/electron/index.js`, not the bare `electron` id.
- **Manual checks:** behaviour in `src/main.ts` or `src/stack.ts` needs the
  manual launch/close/attach/recover/cancel run in
  `docs/guides/testing.md` ("Desktop"). Record what was run in the PR.
- **Docs in the same commit:**
  - `docs/guides/desktop.md` for any changed behaviour (each finding lists
    the docs it affects);
  - `MAP.md` if a file is added;
  - a dated entry in `docs/decisions.md` if a fix changes a recorded
    decision (for example, what counts as "local" in A-01, or which
    llama-server the app may stop in A-15), plus the roadmap timeline that
    moves with it.
- **The `==> ` markers are an interface.** Change their text in the
  Makefile, the backend and `src/progress.ts` together.
- **Ask first:** stop and ask before changing a public interface, the
  attach/own policy, or the permission set.

## 4. Owner decisions and open questions

- **B0:** decide where it is fixed. A public PR discloses the issue, and a
  GitHub temporary private fork may not run the required CI.
- **A-01:** should `[::1]` and `https` loopback addresses become
  connect-only, or should the app pass `LLLM_BACKEND_HOST` (and support
  TLS) so they stay managed?
- **A-03:** when something already holds the port but doesn't answer,
  should the app wait and attach, or refuse with a message? Should the
  Makefile's EXIT trap bring down only what its own recipe started (a
  Makefile change, so a gate change)?
- **A-15:** how should the app learn which `llama-server` its stack served?
  The backend could report it, or the app could ask `/check` on the
  profile's port.
- **A-17:** is the camera wanted (a video mode in the frontend)? If so,
  document it; if not, allow only audio.
- **Work in progress elsewhere:** the pre-screen work being developed in the
  other checkout changes `routers/benchmarks/__init__.py`'s `shutdown()`. It
  also stops the pre-screen and optuna-dashboard there. That hook's `==> `
  lines drive `progress.ts`'s SHUTDOWN steps. Once that work merges,
  reconcile the steps (B2 touches the same reducer) and the
  `shutdown-with-jobs.synthetic.log` fixture against it.
