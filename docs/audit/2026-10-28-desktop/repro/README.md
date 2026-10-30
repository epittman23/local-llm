# Reproductions for the desktop app audit

Vitest files that show the findings in [../FINDINGS.md](../FINDINGS.md)
against the audited commit `6c07575`. They import `apps/desktop/src` by
relative path and run under `apps/desktop`'s own Vitest, with the config in
this directory. They spawn and signal nothing real.

Install the desktop app's dependencies first (`cd apps/desktop && bun
install`), then run them all from the repository root:

```bash
apps/desktop/node_modules/.bin/vitest run \
  --config docs/audit/2026-10-28-desktop/repro/vitest.config.mjs \
  --reporter=verbose --silent=false
```

Add a file path after the command to run one file. No environment
variables are needed. Temporary directories go under the system temp
directory (`os.tmpdir()`).

The repros pass when the bug is present. Each prints what it observed.

| File | Finding | What it shows |
|---|---|---|
| `P2/loopback-origins.test.ts` | A-01 | `[::1]` and `https` loopback count as local, a 127.0.0.1 listener doesn't answer them, and startup decides `own` |
| `P1/p1.test.ts`, test "F3" | A-01 | the same, from the started command's side: only the port is passed to `make backend` |
| `P1/leave-it.test.ts` | A-02 | after a forced stop with a llama-server left, "Leave it" doesn't exit and the dialog can't be closed |
| `P1/p1.test.ts`, test "F2" | A-03 | a backend that accepts but answers after 1.5 s is probed as down, and startup decides `own` |
| `P1/cancel-race.test.ts` | A-04 | a Cancel during the last `/ready` probe opens the app window and ends with two SIGINTs to the group |
| `P1/p1.test.ts`, test "F5" | A-08 | a timeout on open requests shows the job and model steps as "skipped (none running)" |
| `P1/p1.test.ts`, test "F7" | A-10 | a rename or deletion under `apps/web/src`, or a new `tsconfig.json`, is not seen as newer than `dist/` |

`P1/main-harness.ts` is the fake Electron the `src/main.ts` repros load
`main.ts` against. It fakes `BrowserWindow`, `app`, `ipcMain` and the rest,
plus `probe`, `spawnInGroup` and `process.kill`. The tests mock the resolved
`apps/desktop/node_modules/electron/index.js`, not the bare `electron` id,
which Vitest would not match. If the real module ever loads, it downloads an
Electron binary.
