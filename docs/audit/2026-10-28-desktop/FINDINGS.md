# Bug audit findings: the desktop app

Audited commit: `6c07575fa7cc93e1ad14e16d6aad41cb770141db` on `main`,
2026-10-28. Scope: `apps/desktop/` (see [COVERAGE.md](COVERAGE.md)). Every
location links to that commit.

How the findings were verified:
- Two reviewers read every line of the package files.
- Each finding was then re-checked in the main session, by re-running its
  repro or by reading the code on both sides.
- "Confirmed" means one of:
  - a repro ran and showed the wrong behaviour;
  - both sides of a contract were quoted;
  - the code path was read end to end and the trigger can occur.

Each entry says which of these applies, and what was not run. In
particular, Electron itself was not launched, and neither was a real stack.
The repros are in [repro/](repro/README.md). Nothing has been fixed. The fix
plan is [FIX_PLAN.md](FIX_PLAN.md).


## Findings

| ID | Issue | Severity | Area | Status | Package | Title |
|---|---|---|---|---|---|---|
| A-01 | pending | Medium | desktop | Confirmed | P1, P2 | A [::1] or https:// loopback server URL makes the app start a backend it can never reach, and can stop a terminal stack's services |
| A-02 | pending | Medium | desktop | Confirmed | P1, P2 | After a forced stop that leaves a llama-server, "Leave it" does nothing and the dialog cannot be closed |
| A-03 | pending | Medium | desktop | Confirmed | P1 | A backend that is starting, reloading or busy is taken for "nothing running", and the second make backend the app starts stops its services |
| A-04 | pending | Medium | desktop | Confirmed | P1 | A Cancel during the last readiness probe still opens the app window, and closing it then sends a second SIGINT |
| A-05 | pending | Low | desktop | Confirmed | P2 | Settings shows the stored server URL, not an active --server-url / LLLM_SERVER_URL override, and saving cannot replace it |
| A-06 | pending | Low | desktop | Confirmed | P2 | The window size is not saved when the app quits from the menu, Ctrl+Q, a signal or Restart now |
| A-07 | pending | Low | desktop | Confirmed | P2 | A failed settings save shows no message in the dialog |
| A-08 | pending | Low | desktop | Confirmed | P1 | A stop that times out on open requests shows the job and model steps as "skipped: none running" |
| A-09 | pending | Low | infra | Confirmed | P1 | make backend breaks when the checkout path contains a space or a quote |
| A-10 | pending | Low | desktop | Confirmed | P1 | The UI staleness check misses renamed and deleted files and tsconfig.json, so the app serves an out-of-date build |
| A-11 | pending | Low | desktop | Confirmed | P1 | A progress test asserts that the optional force step has no detail, which cannot fail |
| A-12 | pending | Low | desktop | Confirmed | P1 | owned.json records neither the server address nor the checkout, so a crashed stack can be adopted on the wrong port or never stopped |
| A-13 | pending | Low | desktop | Confirmed | P1 | Any server answering on localhost:5174 is taken for make frontend and loaded as the app |
| A-14 | pending | Low | desktop | Confirmed | P1 | The make backend child has no error listener, so a login shell that cannot be spawned raises an uncaught exception in the main process |
| A-15 | pending | Low | desktop | Confirmed | P1, P2 | After a forced stop, the llama-server offer and "Stop llama-server" cover every llama-server the user runs, not the one this stack served |
| A-16 | pending | Low | desktop | Confirmed | P1 | A clean stop never checks make's exit status, so a failed compose down still shows "Stop the services" as done |
| A-17 | pending | Low | desktop | Confirmed | P2 | The app grants the server origin the camera too, while the docs say it gets only the microphone |
| A-18 | pending | Low | desktop | Confirmed | P2 | A hand-edited config.json with an unparseable server URL silently falls back to the local default, and the next close overwrites the edit |

### A-01: A [::1] or https:// loopback server URL makes the app start a backend it can never reach, and can stop a terminal stack's services

Issue: pending. Severity: Medium. Area: desktop. Status: Confirmed.

- **Location**: [`apps/desktop/src/config.ts:40-49`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/config.ts#L40-L49); [`apps/desktop/src/stack.ts:177-186`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/stack.ts#L177-L186); [`apps/desktop/src/main.ts:261-269`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L261-L269); [`apps/desktop/src/main.ts:330-345`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L330-L345); [`apps/desktop/src/main.ts:393-407`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L393-L407); [`apps/desktop/src/main.ts:519-528`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L519-L528); [`Makefile:130-152`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/Makefile#L130-L152)
- **Description**: `isLocalOrigin` treats any URL whose hostname is `127.0.0.1`, `localhost` or `[::1]` as a stack the app manages, whatever its scheme. `make backend` only ever serves plain HTTP on `127.0.0.1` (`LLLM_BACKEND_HOST` defaults to it, and the app passes only the port). For `http://[::1]:4000` or `https://127.0.0.1:4000`, the `/health` probe never answers, so `decideStart` picks `own` even when a terminal backend is up on `127.0.0.1:4000`. It should treat only addresses `make backend` can serve (`http:` on `127.0.0.1` or `localhost`) as manageable, and connect only, or refuse in Settings, for the rest.
- **Root cause**: The "is this local" decision looks only at the hostname, not at the scheme or the address family the Makefile actually binds.
- **Trigger / reproduction**: Set the server URL to `http://[::1]:4000` (Settings accepts it) and start the app. A scratch Vitest repro stands a Node server on 127.0.0.1 in for uvicorn and runs the real `probe` and `decideStart`: `http://127.0.0.1:P` and `http://localhost:P` give health 200 and mode `attach`; `http://[::1]:P` and `https://127.0.0.1:P` give local true, health null and mode `own`. The command it would run is `exec make -C '/r' backend 'LLLM_UVICORN_FLAGS=--timeout-graceful-shutdown 10' LLLM_BACKEND_PORT=P`, with no host and no TLS. Repro: `docs/audit/2026-10-28-desktop/repro/P2/loopback-origins.test.ts`.
- **Impact**: With nothing running, the started backend comes up on 127.0.0.1 and `waitReady` polls the configured address forever, with no timeout: the dialog spins on the backend step until the user cancels. With a terminal backend already running, the app starts a second `make backend`; its uvicorn cannot bind the taken port, the recipe exits, and its EXIT trap runs `docker compose down` on the shared `local-llm` project, stopping the Postgres, Redis, Jupyter and SearXNG the terminal backend uses. The guide promises a terminal stack is never touched. (The bind failure is inferred from the code; the probe and decision were run.)
- **Suggested fix** (approach only): Make managed mode require `http:` and a hostname of `127.0.0.1` or `localhost`, in `isLocalOrigin` or a separate "manageable" check that `saveSettings` also applies; treat other loopback forms as connect-only or reject them in Settings. Separately, bound `waitReady` in own mode.
- **Docs affected under the maintenance policy**: docs/guides/desktop.md "Settings" ("At 127.0.0.1 or localhost, the app manages the local stack") and the matching hint in static/status.html must state the exact rule.
- **Related issues and PRs**: A-03 (pending)
- **Confidence**: Confirmed: reproduced (see trigger) and re-run by the auditing session.

Found by the bug audit of the desktop app at `6c07575`; see docs/audit/2026-10-28-desktop/FINDINGS.md on the audit branch. (finding A-01, package P1, P2)

### A-02: After a forced stop that leaves a llama-server, "Leave it" does nothing and the dialog cannot be closed

Issue: pending. Severity: Medium. Area: desktop. Status: Confirmed.

- **Location**: [`apps/desktop/static/status.js:46-50`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/static/status.js#L46-L50); [`apps/desktop/src/main.ts:164-173`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L164-L173); [`apps/desktop/src/main.ts:428-430`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L428-L430); [`apps/desktop/src/main.ts:472-477`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L472-L477); [`apps/desktop/src/main.ts:561-564`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L561-L564); [`apps/desktop/src/main.ts:661-663`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L661-L663)
- **Description**: When the 90 s stop budget runs out and a `llama-server` is still running, `shutdown()` dispatches the offer and returns with `phase` still `'stopping'`. The dialog then offers "Leave it" (action `quit`) and "Stop llama-server". `quit` calls `shutdown()`, whose first line returns when `phase === 'stopping'`, so "Leave it" does nothing. The dialog's close is prevented while stopping, and SIGINT/SIGTERM/SIGHUP also go through `shutdown()` and no-op. It should exit the app and leave the model running.
- **Root cause**: The dialog's `quit` action is wired to `shutdown()`, whose re-entry guard swallows it in exactly the state where the offer is shown; nothing moves the phase on once the offer is made.
- **Trigger / reproduction**: Close the app while it owns a stack whose process group outlives `STOP_BUDGET_MS` (90 s) while a model is served, so `stopGroup` returns `forced: true` with `llama` non-empty. Read on both sides: status.js renders `button('Leave it', 'quit')`; main.ts maps `quit` to `shutdown()`, which returns at its first line. A scratch Vitest repro with Electron faked drives the own path to running, closes the window, has `stopGroup` return `{forced: true, llama: [777]}`, then sends `quit`: `after forced stop, exits = []`, `after Leave it, exits = []`, `closing the dialog allowed = false ; exits = []`. Repro: `docs/audit/2026-10-28-desktop/repro/P1/leave-it.test.ts`.
- **Impact**: The dialog hangs. The only ways out are "Stop llama-server", which kills the model the user chose to keep, or killing the app process.
- **Suggested fix** (approach only): Give "Leave it" its own action that exits (`app.exit(0)`), or have the offer path set a terminal phase that `quit` handles; let the dialog close once the progress is finished.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger) and re-run by the auditing session.

Found by the bug audit of the desktop app at `6c07575`; see docs/audit/2026-10-28-desktop/FINDINGS.md on the audit branch. (finding A-02, package P1, P2)

### A-03: A backend that is starting, reloading or busy is taken for "nothing running", and the second make backend the app starts stops its services

Issue: pending. Severity: Medium. Area: desktop. Status: Confirmed.

- **Location**: [`apps/desktop/src/main.ts:333-345`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L333-L345); [`apps/desktop/src/stack.ts:57-64`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/stack.ts#L57-L64); [`apps/desktop/src/stack.ts:306-315`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/stack.ts#L306-L315); [`Makefile:130-132`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/Makefile#L130-L132)
- **Description**: `startup()` decides between attach and own from one `probe(<origin>/health)` with a 1.5 s timeout. A refused connection and a connection that is accepted but not answered in time both return null, so `decideStart` picks `own`. That happens while a terminal `make backend` is still in `compose up`, `uv sync` or its lifespan startup (uvicorn runs the lifespan before it binds), during a `--reload` restart (the supervisor holds the socket, so the probe connects and waits), or while the event loop is stalled for more than 1.5 s. The app then starts its own `make backend` in the same checkout. It should recognise a backend that exists but is not ready yet, and never start a second stack beside one.
- **Root cause**: "Did /health answer within 1.5 s" is used as "is a backend running", and nothing else (the port, the compose project, another `make backend`) is checked before starting one; the Makefile's EXIT trap then runs `docker compose down` on the shared, pinned `local-llm` project whichever recipe exits.
- **Trigger / reproduction**: Start `make backend` in a terminal and launch the app before uvicorn is listening, or while it reloads after a code edit. A scratch Vitest repro runs the real `probe` against a Node listener that accepts but answers after 2 s: `F2 probe -> null after 1503 ms; plan -> {"mode":"own","loadUrl":"http://127.0.0.1:38779","buildUi":false}`. The rest follows from the code: uvicorn 0.54 `server.py:114-117` runs `lifespan.startup()` before `create_server`, and `server.py:181-192` answers a bind failure with `lifespan.shutdown()` and `sys.exit(3)`; Makefile:130 sets the EXIT trap before `compose up`. Repro: `docs/audit/2026-10-28-desktop/repro/P1/p1.test.ts` (test "F2").
- **Impact**: The app's second `make backend` runs `compose up -d` (a no-op on the running services), its uvicorn loses the bind and exits, and its trap runs `docker compose down`: the Postgres, Redis, Jupyter and SearXNG the terminal backend is using are stopped and removed. The app then reports "make backend stopped (exit code 2)". If the app's uvicorn wins the bind instead, the terminal's loses and takes the app's services down. Volumes survive (`down` without `-v`), so no data is lost, but the guide recommends exactly this workflow ("Use a terminal `make backend` while working on the backend; the app then attaches to it").
- **Suggested fix** (approach only): Treat a connection that is accepted but slow as a running backend and wait for it; before choosing `own`, check whether the port is bound or a `make backend` / the compose project is already running, and attach or refuse instead. Optionally make the Makefile trap bring down only what its own recipe started.
- **Docs affected under the maintenance policy**: docs/guides/desktop.md, the "Nothing answering on `:4000`" row of the startup table, should say what counts as nothing.
- **Related issues and PRs**: A-01 (pending)
- **Confidence**: Confirmed: reproduced (see trigger) and re-run by the auditing session.

Found by the bug audit of the desktop app at `6c07575`; see docs/audit/2026-10-28-desktop/FINDINGS.md on the audit branch. (finding A-03, package P1)

### A-04: A Cancel during the last readiness probe still opens the app window, and closing it then sends a second SIGINT

Issue: pending. Severity: Medium. Area: desktop. Status: Confirmed.

- **Location**: [`apps/desktop/src/main.ts:261-269`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L261-L269); [`apps/desktop/src/main.ts:403-409`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L403-L409); [`apps/desktop/src/main.ts:240-249`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L240-L249); [`apps/desktop/src/main.ts:230-236`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L230-L236); [`apps/desktop/src/main.ts:428-431`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L428-L431); [`apps/desktop/src/main.ts:655-660`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L655-L660)
- **Description**: `waitReady` checks the abort signal only before each probe, and `startup()` calls `openApp()` after it returns without checking again. If Cancel (or closing the dialog) runs `shutdown()` while the last `/ready` probe is in flight and that probe returns 200, `openApp` creates the app window during the stop. Its `ready-to-show` sets `phase = 'running'` and destroys the shutdown dialog. Closing that window or quitting then passes the `phase === 'stopping'` guard, and `shutdown()` runs `stopGroup` a second time, which sends a second SIGINT to the group. It should never open the window, or leave the stopping phase, once a stop has begun.
- **Root cause**: Cancellation is checked at one point of a multi-step async startup, and the one-SIGINT rule is enforced by the phase variable, which `openApp` overwrites.
- **Trigger / reproduction**: Press Cancel in the startup dialog in the half second in which the backend first answers `/ready`. A scratch Vitest repro with Electron, `probe`, `spawnInGroup` and `process.kill` faked holds the probe, cancels, then lets it return 200: `after Cancel: ["SIGINT:-990201"]`, `app window created after the cancel: true http://127.0.0.1:4000`, `status dialog still open: false`, `signals sent: ["SIGINT:-990201","SIGINT:-990201"]`. With `make frontend` running the late window certainly loads (the dev server keeps serving); against the built UI, uvicorn closes its listener on SIGINT and whether Electron still fires `ready-to-show` for the failed load was not checked. Repro: `docs/audit/2026-10-28-desktop/repro/P1/cancel-race.test.ts`.
- **Impact**: The second SIGINT makes uvicorn force-exit and skip the teardown that stops benchmark jobs and the served model, which is the failure the desktop design exists to prevent; meanwhile the shutdown dialog disappears while the stop is still running.
- **Suggested fix** (approach only): Check the abort signal after every await in `startup()` (after `waitReady` and in `openApp`'s `ready-to-show`), never set `phase = 'running'` once stopping, and guard the SIGINT per process group rather than through the phase.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: A-02 (pending)
- **Confidence**: Confirmed: reproduced (see trigger) and re-run by the auditing session.

Found by the bug audit of the desktop app at `6c07575`; see docs/audit/2026-10-28-desktop/FINDINGS.md on the audit branch. (finding A-04, package P1)

### A-05: Settings shows the stored server URL, not an active --server-url / LLLM_SERVER_URL override, and saving cannot replace it

Issue: pending. Severity: Low. Area: desktop. Status: Confirmed.

- **Location**: [`apps/desktop/src/main.ts:114-118`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L114-L118); [`apps/desktop/src/main.ts:310-313`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L310-L313); [`apps/desktop/src/main.ts:324`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L324); [`apps/desktop/src/main.ts:535-541`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L535-L541); [`apps/desktop/src/main.ts:573-575`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L573-L575); [`apps/desktop/static/status.js:135-147`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/static/status.js#L135-L147)
- **Description**: Launched with `LLLM_SERVER_URL` (or `--server-url=`) set to an address that doesn't answer, the app fails with "Nothing answered at <url>. Check the address in Settings, or retry." Settings shows the stored URL, not the one in use. Saving a correct URL says "Saved. Retry to start with it.", but Retry runs `startup()`, which re-applies the override over the stored value. "Restart now" calls `app.relaunch()` with no arguments, which reuses the same argv and inherits the environment, so the override survives the restart too. It should show the address in use, say when an override is active, and not promise that a save takes effect while it is shadowed.
- **Root cause**: The override is applied in `loadConfig()` on every startup, while the settings dialog only ever reads and writes the stored value.
- **Trigger / reproduction**: `LLLM_SERVER_URL=https://nothing.invalid make desktop`, then open Settings, save `http://127.0.0.1:4000`, and press Retry: it still connects to the override. Read on both sides (main.ts `loadConfig`/`status:get-settings`, status.js's submit handler).
- **Impact**: A user who launched the app with an override cannot fix the address from Settings, and the dialog's messages tell them they did.
- **Suggested fix** (approach only): Return the effective URL and whether an override is active from `status:get-settings`, show it in the dialog, and either drop the override after a save or say it still applies; relaunch without the `--server-url=` argument.
- **Docs affected under the maintenance policy**: docs/guides/desktop.md "Settings" says the override applies "for one launch"; Restart now currently carries it into the next.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited commit by the auditing session.

Found by the bug audit of the desktop app at `6c07575`; see docs/audit/2026-10-28-desktop/FINDINGS.md on the audit branch. (finding A-05, package P2)

### A-06: The window size is not saved when the app quits from the menu, Ctrl+Q, a signal or Restart now

Issue: pending. Severity: Low. Area: desktop. Status: Confirmed.

- **Location**: [`apps/desktop/src/main.ts:230-236`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L230-L236); [`apps/desktop/src/main.ts:439-442`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L439-L442); [`apps/desktop/src/main.ts:450-452`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L450-L452); [`apps/desktop/src/main.ts:573-575`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L573-L575); [`apps/desktop/src/main.ts:655-663`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L655-L663)
- **Description**: The bounds are saved only in the app window's `close` event. `shutdown()` destroys windows (`win.destroy()` emits no `close`) and otherwise calls `app.exit(0)` (which closes windows without emitting `close`). So File > Quit or Ctrl+Q while the app owns the stack, a SIGTERM/SIGHUP at logout, a SIGINT from `make desktop`, and Restart now never save the size; only the window's own close button does. It should save the bounds on every way out.
- **Root cause**: Saving the bounds is tied to one event that the app's main exit paths bypass.
- **Trigger / reproduction**: With the app owning the stack, resize the window and quit with Ctrl+Q: `before-quit` calls `shutdown()`, which destroys the window, and config.json keeps the old bounds. Confirmed by reading the code against Electron 45's typings for `BrowserWindow.destroy()` and `app.exit()`.
- **Impact**: The window reopens at its previous or default size.
- **Suggested fix** (approach only): Save the bounds in `shutdown()` before destroying windows (and before `app.exit`), or save them on `resize`/`move` with a debounce.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited commit by the auditing session.

Found by the bug audit of the desktop app at `6c07575`; see docs/audit/2026-10-28-desktop/FINDINGS.md on the audit branch. (finding A-06, package P2)

### A-07: A failed settings save shows no message in the dialog

Issue: pending. Severity: Low. Area: desktop. Status: Confirmed.

- **Location**: [`apps/desktop/src/main.ts:519-528`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L519-L528); [`apps/desktop/static/status.js:135-147`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/static/status.js#L135-L147)
- **Description**: `saveSettings` calls `writeConfig`, which throws if `~/.config/Local LLM` is unwritable or full. The invoke then rejects, and the dialog's submit handler awaits it with no try/catch, so the message line stays empty and the user cannot tell whether the save worked. It should show an error.
- **Root cause**: Neither side handles a write failure: main lets the exception become a rejected invoke, and the page does not catch it.
- **Trigger / reproduction**: Make `~/.config/Local LLM/config.json`'s directory read-only, open Settings and save. Read on both sides.
- **Impact**: A silent failure; the next launch uses the old settings.
- **Suggested fix** (approach only): Catch the write error in `saveSettings` and return `{ error }`, which the dialog already displays.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited commit by the auditing session.

Found by the bug audit of the desktop app at `6c07575`; see docs/audit/2026-10-28-desktop/FINDINGS.md on the audit branch. (finding A-07, package P2)

### A-08: A stop that times out on open requests shows the job and model steps as "skipped: none running"

Issue: pending. Severity: Low. Area: desktop. Status: Confirmed.

- **Location**: [`apps/desktop/src/main.ts:464-468`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L464-L468); [`apps/desktop/src/progress.ts:147-159`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/progress.ts#L147-L159); [`apps/desktop/src/progress.ts:100-119`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/progress.ts#L100-L119)
- **Description**: When the 90 s budget runs out while "Finish open requests" is running, `onTimeout` marks that step failed and begins `force`. `begin` settles every earlier pending step as skipped with its `skipReason`, so "Stop benchmark jobs" and "Stop the served model" read "skipped (none running)" though they were never reached and a llama-server may be running, and "Stop the services" reads skipped though the app then ran `docker compose down` itself. The dialog should say those steps were not reached.
- **Root cause**: `settleBefore` cannot tell "a later step began normally" from "the stop was forced", and the forced path reuses it.
- **Trigger / reproduction**: A scratch repro feeds the reducer `window`, `requests`, then a timeout and `force`: `window=done, requests=failed (did not finish in time), jobs=skipped (none running), model=skipped (none running), services=skipped, force=done (killing the process group) offerStopLlama true`. The existing forced-stop test (`progress.test.ts:110-120`) times out at `services`, the last step, so it never shows this. Repro: `docs/audit/2026-10-28-desktop/repro/P1/p1.test.ts` (test "F5").
- **Impact**: A forced stop reads as "nothing to do" right next to an offer to stop a running llama-server.
- **Suggested fix** (approach only): On a timeout, mark the remaining steps "not reached" instead of applying `skipReason`, and let the force step cover the compose down.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger) and re-run by the auditing session.

Found by the bug audit of the desktop app at `6c07575`; see docs/audit/2026-10-28-desktop/FINDINGS.md on the audit branch. (finding A-08, package P1)

### A-09: make backend breaks when the checkout path contains a space or a quote

Issue: pending. Severity: Low. Area: infra. Status: Confirmed.

- **Location**: [`Makefile:36`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/Makefile#L36); [`Makefile:46`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/Makefile#L46); [`Makefile:130-132`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/Makefile#L130-L132); [`apps/desktop/src/stack.test.ts:125-135`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/stack.test.ts#L125-L135)
- **Description**: `COMPOSE := docker compose -f $(REPO_ROOT)/infra/docker-compose.yml` expands the repository path unquoted, and the `backend` recipe's trap wraps it in single quotes, so a path with a space is split into several arguments and a path with a `'` ends the trap string. The desktop app quotes the path correctly for its login shell (`shellQuote`) and its tests assert a spaced path, but `make` then breaks it. `make backend` from a terminal fails the same way.
- **Root cause**: The Makefile builds shell commands from `$(REPO_ROOT)` without quoting.
- **Trigger / reproduction**: With only the Makefile copied into a directory named `repo with space`, `make -n -C "<that dir>" backend` prints `docker compose -f /tmp/.../repo with space/infra/docker-compose.yml up -d ...`, which the shell splits at the spaces.
- **Impact**: The stack does not start from such a checkout, from the app or a terminal; the failure is visible, not silent.
- **Suggested fix** (approach only): Quote `$(REPO_ROOT)` inside `COMPOSE` and the trap (escaping for the trap's quotes), or refuse such paths in the desktop Settings and document the limit.
- **Docs affected under the maintenance policy**: README.md "Running it" if a path limit is documented instead.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited commit by the auditing session.

Found by the bug audit of the desktop app at `6c07575`; see docs/audit/2026-10-28-desktop/FINDINGS.md on the audit branch. (finding A-09, package P1)

### A-10: The UI staleness check misses renamed and deleted files and tsconfig.json, so the app serves an out-of-date build

Issue: pending. Severity: Low. Area: desktop. Status: Confirmed.

- **Location**: [`apps/desktop/src/stack.ts:66-67`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/stack.ts#L66-L67); [`apps/desktop/src/stack.ts:73-105`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/stack.ts#L73-L105)
- **Description**: Before starting the stack, the app rebuilds `apps/web` only if a file under `UI_SOURCES` is newer than `dist/index.html`. `newestMtime` stats files and the top-level paths only: a rename keeps the file's mtime and a deletion leaves nothing to stat (only the parent directory's mtime changes, and subdirectories are skipped). `tsconfig.json`, which holds the path aliases, is not in `UI_SOURCES` at all. It should count directory mtimes and every build input.
- **Root cause**: The walk ignores directory entries, and the list of inputs is incomplete.
- **Trigger / reproduction**: A scratch repro builds a fake `apps/web` with a `dist/` and then renames and deletes files under `src/pages`, and separately writes a new `tsconfig.json`: `stale after rename+delete under src/pages: false` and `stale after a new tsconfig.json: false`. Repro: `docs/audit/2026-10-28-desktop/repro/P1/p1.test.ts` (test "F7").
- **Impact**: After pulling a change that only moves or deletes frontend files, or changes `tsconfig.json`, the app starts with the stale `dist/`, for example still routing to a deleted page.
- **Suggested fix** (approach only): Include directory mtimes in the walk and add `tsconfig.json` (and any other build config) to `UI_SOURCES`.
- **Docs affected under the maintenance policy**: docs/guides/desktop.md ("builds `apps/web` if any source is newer than `dist/`") if the rule changes.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger) and re-run by the auditing session.

Found by the bug audit of the desktop app at `6c07575`; see docs/audit/2026-10-28-desktop/FINDINGS.md on the audit branch. (finding A-10, package P1)

### A-11: A progress test asserts that the optional force step has no detail, which cannot fail

Issue: pending. Severity: Low. Area: desktop. Status: Confirmed.

- **Location**: [`apps/desktop/src/progress.test.ts:80-93`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/progress.test.ts#L80-L93); [`apps/desktop/src/progress.ts:156`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/progress.ts#L156)
- **Description**: "skips the job steps when nothing was running" asserts `force.detail` is undefined to cover "the optional force step stays silent", but `force` is still `pending` at that point (asserted two lines earlier) and has no `skipReason`, so `detail` is undefined whatever `settleBefore` does. The `s.optional ? undefined : s.skipReason` branch it means to cover is untested; removing it still passes.
- **Root cause**: The step under test is never settled, and the optional step has no `skipReason` to suppress.
- **Trigger / reproduction**: Read both sides: `progress.ts:156` and `progress.test.ts:88-92`.
- **Impact**: A regression in how optional steps are settled would pass CI.
- **Suggested fix** (approach only): Settle an optional step that has a `skipReason` (a later step beginning after it) and assert its detail.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited commit by the auditing session.

Found by the bug audit of the desktop app at `6c07575`; see docs/audit/2026-10-28-desktop/FINDINGS.md on the audit branch. (finding A-11, package P1)

### A-12: owned.json records neither the server address nor the checkout, so a crashed stack can be adopted on the wrong port or never stopped

Issue: pending. Severity: Low. Area: desktop. Status: Confirmed.

- **Location**: [`apps/desktop/src/stack.ts:109-160`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/stack.ts#L109-L160); [`apps/desktop/src/main.ts:319-366`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L319-L366); [`apps/desktop/src/main.ts:456-462`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L456-L462)
- **Description**: After a crash, the next launch adopts the stack in `owned.json` by pid and start time only. It then waits on the current configuration's origin and, if forced, runs `compose down` in the current configuration's repository folder. A launch whose server URL is remote never reads `owned.json`, so the stack is never stopped. It should adopt only a stack started for the same origin and checkout, and stop an orphan otherwise.
- **Root cause**: The record lacks the origin and repo the stack was started with.
- **Trigger / reproduction**: A launch with `--server-url=http://127.0.0.1:4100` crashes; the next plain launch adopts that group and waits on `:4000/ready` forever (the group is alive, so the adopt check never fails). A launch configured for a remote server leaves the orphan running. Confirmed by reading the code; not run.
- **Impact**: A stuck startup (Cancel works), or a local stack left running until the next local launch.
- **Suggested fix** (approach only): Write the origin and repo into `owned.json`; adopt only on a match, and on a mismatch stop the recorded group with its recorded repo.
- **Docs affected under the maintenance policy**: docs/guides/desktop.md "Files" (`owned.json`).
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited commit by the auditing session.

Found by the bug audit of the desktop app at `6c07575`; see docs/audit/2026-10-28-desktop/FINDINGS.md on the audit branch. (finding A-12, package P1)

### A-13: Any server answering on localhost:5174 is taken for make frontend and loaded as the app

Issue: pending. Severity: Low. Area: desktop. Status: Confirmed.

- **Location**: [`apps/desktop/src/main.ts:333`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L333); [`apps/desktop/src/stack.ts:57-60`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/stack.ts#L57-L60)
- **Description**: `decideStart` uses `http://localhost:5174` in place of the built UI whenever anything answers there with any HTTP status. Another project's Vite dev server lands on 5174 when 5173 is taken (Vite's `strictPort` defaults to false, so it moves to the next free port), so the app window loads that project, and skips the UI build. It should check that the server is this repo's dev server, for example by a request that only the proxied backend answers.
- **Root cause**: The dev-server check is "anything answered", not "our dev server answered".
- **Trigger / reproduction**: Run two other Vite projects (the second takes 5174), then launch the app with nothing on :4000: it loads the second project. Confirmed by reading `decideStart` and `probe` (any status counts); not run.
- **Impact**: The app shows an unrelated site, and the UI build is skipped.
- **Suggested fix** (approach only): Probe a path that identifies this app through the dev server's proxy (for example `/api/config` returning this backend's JSON) before choosing it.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited commit by the auditing session.

Found by the bug audit of the desktop app at `6c07575`; see docs/audit/2026-10-28-desktop/FINDINGS.md on the audit branch. (finding A-13, package P1)

### A-14: The make backend child has no error listener, so a login shell that cannot be spawned raises an uncaught exception in the main process

Issue: pending. Severity: Low. Area: desktop. Status: Confirmed.

- **Location**: [`apps/desktop/src/main.ts:393-401`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L393-L401); [`apps/desktop/src/stack.ts:208-215`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/stack.ts#L208-L215)
- **Description**: `runBuild` listens for the child's `error` event, but the `make backend` child does not. If `$SHELL` names a missing program, `spawn` returns a child with no pid: `fail()` shows "Could not start make backend.", and then Node emits `error` with no listener, which becomes an uncaught exception in Electron's main process.
- **Root cause**: A missing `error` listener on one of two spawns.
- **Trigger / reproduction**: A one-off Node script that spawns `/nonexistent/shell` with no `error` listener printed `pid = undefined` and `uncaughtException: ENOENT`. Electron's own reaction (its main-process error dialog) was not observed.
- **Impact**: An error dialog on top of the app's own failure message, in an already failing start.
- **Suggested fix** (approach only): Attach an `error` listener to the backend child as `runBuild` does, and report it through `fail()`.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited commit by the auditing session.

Found by the bug audit of the desktop app at `6c07575`; see docs/audit/2026-10-28-desktop/FINDINGS.md on the audit branch. (finding A-14, package P1)

### A-15: After a forced stop, the llama-server offer and "Stop llama-server" cover every llama-server the user runs, not the one this stack served

Issue: pending. Severity: Low. Area: desktop. Status: Confirmed.

- **Location**: [`apps/desktop/src/stack.ts:223-235`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/stack.ts#L223-L235); [`apps/desktop/src/stack.ts:286-296`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/stack.ts#L286-L296); [`apps/desktop/src/main.ts:472-477`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L472-L477); [`apps/desktop/src/main.ts:483-491`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L483-L491)
- **Description**: `llamaServerPids()` is `pgrep -x llama-server`: every process of that name the user owns. After a forced stop, the app offers to stop "a llama-server" if any such process exists, and "Stop llama-server" sends SIGTERM to all of them. A model served from a terminal backend, another checkout, or by hand is offered and killed as if this stack had left it. If none of them belongs to this stack, the offer appears anyway. It should identify the server its own backend started, and offer only that one.
- **Root cause**: The leftover check has no record of which llama-server the owned stack served; it matches by name.
- **Trigger / reproduction**: Serve a model from a second checkout (or run `llama-server` by hand), then close the app while it owns a stack that has to be forced: the offer appears, and "Stop llama-server" stops the unrelated server. Read on both sides: `stack.ts:223-235` and `main.ts:483-491`.
- **Impact**: "Stop llama-server" can kill a model the app never started. With the "Leave it" bug, it is also the only way to dismiss the dialog besides killing the app. The 2026-10-23 decision says the app stops only what it started.
- **Suggested fix** (approach only): Record the served model's pid (for example from the backend, or the profile's port answered by `/check`) while the stack runs, and offer and stop only that process.
- **Docs affected under the maintenance policy**: docs/guides/desktop.md "What happens when it closes" ("offers to stop any `llama-server` still running") should say which one.
- **Related issues and PRs**: A-02 (pending)
- **Confidence**: Confirmed: traced in the code at the audited commit by the auditing session.

Found by the bug audit of the desktop app at `6c07575`; see docs/audit/2026-10-28-desktop/FINDINGS.md on the audit branch. (finding A-15, package P1, P2)

### A-16: A clean stop never checks make's exit status, so a failed compose down still shows "Stop the services" as done

Issue: pending. Severity: Low. Area: desktop. Status: Confirmed.

- **Location**: [`apps/desktop/src/stack.ts:286-299`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/stack.ts#L286-L299); [`apps/desktop/src/main.ts:470-480`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L470-L480); [`apps/desktop/src/progress.ts:117`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/progress.ts#L117); [`Makefile:130`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/Makefile#L130)
- **Description**: On a stop within the budget, `stopGroup` returns `{ forced: false }` once the group is gone, and `shutdown()` marks the progress complete and exits. The `services` step has a start marker and no end marker, so it is shown as done whether or not the trap's `docker compose down` worked. The make process's exit code (which the app holds as `owned.exitCode` when it spawned it) is never looked at. A failed teardown should be shown as failed, with the log.
- **Root cause**: The stop path treats "the process group is gone" as success.
- **Trigger / reproduction**: Close the app while it owns the stack, with Docker refusing `compose down` (for example the daemon stopped meanwhile): the dialog ticks "Stop the services" and quits. Read from the code.
- **Impact**: Containers can be left running after a stop the dialog reported as clean.
- **Suggested fix** (approach only): Check the make child's exit code (or run `docker compose ps` afterwards) and mark the services step failed, keeping the dialog open with the log, when the teardown did not finish.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited commit by the auditing session.

Found by the bug audit of the desktop app at `6c07575`; see docs/audit/2026-10-28-desktop/FINDINGS.md on the audit branch. (finding A-16, package P1)

### A-17: The app grants the server origin the camera too, while the docs say it gets only the microphone

Issue: pending. Severity: Low. Area: desktop. Status: Confirmed.

- **Location**: [`apps/desktop/src/policy.ts:30-41`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/policy.ts#L30-L41); [`apps/desktop/src/main.ts:614-619`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L614-L619)
- **Description**: `ALLOWED_PERMISSIONS` includes Electron's `media` permission, which covers both audio and video capture; the request handler never looks at `details.mediaTypes`. policy.ts's comment and docs/guides/desktop.md both say the server origin gets the microphone (voice input). The code and the docs should agree: either grant only audio, or document the camera.
- **Root cause**: Electron's single `media` permission was taken to mean the microphone.
- **Trigger / reproduction**: A page on the server origin calls `getUserMedia({ video: true })`: the request handler grants `media` without a prompt. Read against the Electron 45 typings for `PermissionRequest.mediaTypes`.
- **Impact**: The documented permission set is narrower than the real one.
- **Suggested fix** (approach only): Check `details.mediaTypes` in the request handler and allow only `audio` unless the camera is wanted (then document it).
- **Docs affected under the maintenance policy**: docs/guides/desktop.md "Security model" lists the permissions.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited commit by the auditing session.

Found by the bug audit of the desktop app at `6c07575`; see docs/audit/2026-10-28-desktop/FINDINGS.md on the audit branch. (finding A-17, package P2)

### A-18: A hand-edited config.json with an unparseable server URL silently falls back to the local default, and the next close overwrites the edit

Issue: pending. Severity: Low. Area: desktop. Status: Confirmed.

- **Location**: [`apps/desktop/src/config.ts:66-85`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/config.ts#L66-L85); [`apps/desktop/src/main.ts:208-214`](https://github.com/epittman23/local-llm/blob/6c07575fa7cc93e1ad14e16d6aad41cb770141db/apps/desktop/src/main.ts#L208-L214)
- **Description**: `parseConfig` replaces a `serverUrl` that does not parse as an http(s) URL (for example `llm.example.ts.net`, with no scheme) with the default `http://127.0.0.1:4000`, without telling anyone, so the app starts the local stack instead of connecting where the user meant. On the next window close, `saveBounds` writes `{ ...storedConfig(), bounds }`, which saves that default over the hand edit. Unknown fields are dropped the same way. It should report an invalid setting and leave the file as the user wrote it.
- **Root cause**: Parsing is lenient by design, and the bounds save rewrites the whole file from the parsed result.
- **Trigger / reproduction**: Write `{"serverUrl": "llm.example.ts.net"}` to config.json and start the app: it starts the local stack. Read on both sides: `normalizeServerUrl` returns null for a URL without a scheme (`config.ts:25-34`), `parseConfig` then keeps the default (`config.ts:76-78`), and `saveBounds` writes the parsed result back (`main.ts:208-214`).
- **Impact**: A mistyped address quietly becomes "start the local stack", and the user's edit is lost.
- **Suggested fix** (approach only): Keep the raw file content for fields that fail to parse (write back only what changed), and show "the saved server URL is invalid" in the startup dialog instead of falling back silently.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited commit by the auditing session.

Found by the bug audit of the desktop app at `6c07575`; see docs/audit/2026-10-28-desktop/FINDINGS.md on the audit branch. (finding A-18, package P2)

