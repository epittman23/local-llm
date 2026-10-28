# Bug audit coverage plan: the desktop app

Audited commit: `6c07575fa7cc93e1ad14e16d6aad41cb770141db` on `main`,
2026-10-28. Scope: `apps/desktop/`, plus the code outside it that the app's
correctness depends on, read as context and not audited. All line references
refer to that SHA. Findings: FINDINGS.md; fix plan: FIX_PLAN.md. Security
findings are not recorded in any committed file.

The full-repository audit in `docs/audit/` predates the desktop app (added
2026-10-23 in #377), so nothing in this scope has been reviewed before.

## Exclusions

| Excluded | Reason |
|---|---|
| `apps/desktop/bun.lock` | lockfile |
| `apps/desktop/node_modules/`, `dist/`, `release/` | untracked install and build output |

## Context read but not audited

- `Makefile`: the `backend` target (the `==> ` markers, the trap, the
  process the app signals) and the `desktop` target.
- `apps/server/local_llm/routers/benchmarks/__init__.py` (`shutdown()`) and
  `routers/benchmarks/serve.py` (`shutdown()`): the backend's `==> `
  shutdown markers.
- `apps/server/local_llm/main.py`: the lifespan that calls them under
  `LLLM_STOP_JOBS_ON_SHUTDOWN`.
- `apps/web/`: what the window loads; nothing there reads
  `window.lllmDesktop` at this SHA.

## Packages, in risk order

- [x] **P1 Lifecycle**: `src/main.ts`, `src/stack.ts`, `src/stack.test.ts`,
  `src/progress.ts`, `src/progress.test.ts`, `test/fixtures/*` (11 files,
  1,803 lines); focus: start/attach/adopt/own decisions, the one-SIGINT stop
  and its 90 s budget, crash adoption by pid and start time, the progress
  reducer against the real markers, and tests that cannot fail.
  - Status: fully read (all 11 files), 2026-10-28; findings A-01 to A-04 and
    A-08 to A-14.
- [x] **P2 Surface and packaging**: `src/config.ts`, `src/config.test.ts`,
  `src/policy.ts`, `src/policy.test.ts`, `src/preload.ts`,
  `src/status-preload.ts`, `static/status.html`, `static/status.js`,
  `static/status.css`, `electron-builder.yml`, `package.json`,
  `scripts/build-info.mjs`, `tsconfig.json`, `tsconfig.build.json`,
  `biome.jsonc`, `vitest.config.ts`, `.gitignore` (17 files, 950 lines),
  with `src/main.ts`'s windows, navigation, permissions, menu and IPC
  handlers read alongside; focus: settings parsing and validation, what the
  windows may open and request, the dialog's bridge and its sender checks,
  and what the package ships.
  - Status: fully read (all 17 files, and `src/main.ts` in full), 2026-10-28;
    findings A-01, A-02 and A-05 to A-07. The unpacked package was inspected
    too: the asar contents and the fuses.

## Still not read line by line

- Nothing in scope. Every package file was read in full by its reviewer, and
  `src/main.ts` was read by both.
- The context files were read only where the desktop app depends on them:
  - the Makefile `backend` and `desktop` targets;
  - the two backend `shutdown()` hooks and the lifespan;
  - uvicorn 0.54's startup, bind and signal handling.
- Electron itself was never launched, and neither was a real stack. The
  `src/main.ts` repros run it against a fake Electron.
