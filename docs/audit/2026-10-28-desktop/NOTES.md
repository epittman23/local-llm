# Notes from the desktop app audit

These are observations from the 2026-10-28 audit of `apps/desktop` at
`6c07575` that were not filed as issues. The filed ones are in
[FINDINGS.md](FINDINGS.md).

## Invariants checked and holding

- **Adoption after a crash:**
  - `parseProcStat` reads `starttime` from field 22, which matches a real
    `/proc/self/stat`.
  - It survives `exec`, so recording the login shell's pid before it execs
    `make` is correct.
  - A reused pid is caught by the start time.
- **The process group:** `spawnInGroup` uses `detached: true` (`setsid()`),
  so a terminal Ctrl-C never reaches the stack. Every long-lived child the
  backend starts uses `start_new_session=True`, so nothing it keeps running
  stays in make's group.
- **The `==> ` markers:**
  - `progress.ts`'s marker prefixes still match the Makefile's text after
    #410 ("Postgres and Redis, Jupyter and SearXNG"); `progress.test.ts`
    covers it.
  - The backend's markers match in both the loguru stdout format and the
    JSON log format, because the reducer looks for `==> ` anywhere in the
    line.
- **The dialog's bridge:**
  - The IPC channel names and payloads agree across `main.ts`,
    `status-preload.ts` and `static/status.js`:
    - channels: `status:ready`, `status:update`, `status:view`,
      `status:action`, `status:get-settings`, `status:save-settings`,
      `status:browse-repo`;
    - actions: cancel, quit, retry, open-log, stop-llama, restart,
      close-settings.
  - The handlers check both the sender's id and the frame's file path.
- **Shell quoting:** `shellQuote` round-trips a path with spaces, quotes,
  `$()`, backticks, `;&|*?~` and non-ASCII through `bash -c` unchanged. The
  failure in A-09 is the Makefile's, not the app's.
- **Packaging:** the unpacked package's asar holds only:
  - `dist/{build-info.json, config, main, policy, preload, progress, stack, status-preload}.js`;
  - `static/status.{html,css,js}`;
  - `package.json`.

  `resources/icon.png` sits beside it. No node_modules, tests or fixtures
  ship. The fuses read as desktop.md says: RunAsNode, NodeOptions and the
  inspector are off; OnlyLoadAppFromAsar and the asar integrity check are
  on.
- **The build's checkout:** `build-info.mjs` resolves the repository root
  correctly, worktrees included.
- **Retry:** a double-clicked Retry doesn't start two stacks, because the
  second `startup()` adopts the first one's fresh `owned.json`. Whether two
  app windows then open was not checked.

## Test gaps

- **`src/main.ts` has no tests at all.** A main-process test with Electron
  faked, as in [repro/P1/main-harness.ts](repro/P1/main-harness.ts), would
  have caught #421, #423, #424, #425, #426 and #433.
- **The startup decision is tested only with booleans.** Tests of what
  feeds `decideStart` would have caught #420 and #422: the probe's
  semantics, the address forms, and the dev server's identity (#432).
- **The forced-stop test times out at the last step,** so it can't show
  #427. #430 is a test that can't fail.
- **The manual end-to-end checks never exercised a forced stop with a
  served model.** The forced-stop offer is where #421 and #434 live.

## Design questions

- **Retry has no phase guard.** A Retry pressed during a start runs a second
  `startup()` concurrently. It is harmless today (see above), but it isn't
  enforced.
- **Settings accepts a relative repository folder.** It is saved as typed,
  with no `path.resolve`, and later resolved against the working
  directory. `~` is rejected.
- **`dist/` is never cleaned before a package build,** so a module removed
  from `src/` would still ship until `dist/` is deleted.
- **Saved window bounds are not clamped** to the display they open on. Only
  hand edits produce zero, negative or huge sizes. A window saved on a
  disconnected larger monitor could open bigger than the work area, but
  window managers usually clamp it (not checked).
- **`GLOBAL_LOG_LEVEL` above INFO hides the backend's `==> ` lines,** and the
  shutdown steps then read "skipped".
- **`shellQuote` under fish:** its comment says it is also valid in fish,
  which wasn't checked (fish isn't installed). A `\\` inside a path would
  come back as one backslash there.

## Dead code and stale text

- `window.lllmDesktop` is exposed, but nothing in `apps/web` reads it yet.
  This is known and intentional, the seam for future native features.
- `config.test.ts` asserts that `[::1]` is local; see #420.

## Environment limits met

- **Not run:** Electron itself and a real stack. The other checkout on the
  same machine was using Docker and the dev ports.
- **Baseline:** `make test-backend`, `test-types`, `test-web` and `test-e2e`
  were not run (see FIX_PLAN.md).
- **A stray Electron download:** one reviewer's first repro run mocked the
  bare `electron` id, which didn't match. Electron's real loader ran and
  downloaded its binary into `apps/desktop/node_modules/electron/dist/`
  (gitignored; `make desktop` fetches the same). The repros now mock the
  resolved path.

## Coverage notes

Every file under `apps/desktop/` was read in full, and `src/main.ts` was
read by both reviewers. See [COVERAGE.md](COVERAGE.md).
