# Repo Map

A fast index of this repo's layout: what lives where, and what each
directory/major file is for. Use this to orient before searching — it
answers "where would X be," not "how does X work." For the *why* behind
decisions see [`docs/decisions.md`](docs/decisions.md); for conventions and
rules see [`AGENTS.md`](AGENTS.md); for running the app see
[`README.md`](README.md).

This file is a structural index only. It does not restate rationale that
already lives in `AGENTS.md`'s "Conventions" section — it points there
instead.

## Top-level tree

```
local-llm/
├── AGENTS.md                  agent and contributor guide (CLAUDE.md links to it)
├── LICENSE, LICENSE_HISTORY   the license texts the derived code is under (see NOTICE)
├── NOTICE                     what is derived, the license boundaries, the branding basis
├── CONTRIBUTOR_LICENSE_AGREEMENT  referred to by LICENSE
├── CLAUDE.md                  symlink to AGENTS.md
├── Makefile                   make backend, make frontend, make check, make help
├── README.md                  what it is, running it, pages and URLs
├── MAP.md                     this file
├── apps/                      the applications themselves
│   ├── server/                FastAPI backend (package local_llm)
│   ├── web/                   Astro + React + shadcn/ui frontend
│   └── desktop/               Electron desktop app (Linux), loading the backend's pages
├── docs/                      decisions log, roadmap, guides, proposals, history
└── infra/                     docker-compose for Postgres + pgvector and Redis
```

`scripts/` (the shell orchestrator plus the `llama-console` CLI helpers) and
the root `requirements.txt`/`.venv` are gone as of Phase 2c of the migration
(2026-09-18) — see `docs/decisions.md`. `make backend`/
`make frontend` are the replacement entry points; serving configuration
itself lives in the backend as Python (`apps/server/local_llm/
benchmarks/serving/`), not in a shell profile table.

Local/generated (not tracked by git — see "Local/generated" section below
for detail): `.vscode/`, `.claude/`, `logs/`, the backend's runtime data
directory, and scattered `__pycache__/` directories.

## `AGENTS.md` and `CLAUDE.md`

The one agent and contributor guide for the whole repo: why the project
exists, models in use, conventions, commands, backend and frontend
specifics, the maintenance policy (this file's own upkeep rule lives there)
and the commit policy. `CLAUDE.md` is a symlink to it, so every agent reads
the same file. Read it before making structural or config changes.

## `LICENSE`, `LICENSE_HISTORY`, `NOTICE`, `CONTRIBUTOR_LICENSE_AGREEMENT`

The license files, moved verbatim from `apps/server/` on 2026-10-10.
`LICENSE` (the license the derived code is under) and `LICENSE_HISTORY` (the
earlier BSD and MIT terms) are the legal texts; `CONTRIBUTOR_LICENSE_AGREEMENT` is kept because
`LICENSE` refers to it. `NOTICE` merges the two former `LICENSE_NOTICE` files:
which parts of `apps/server/` and `apps/web/` are derived, the upstream
multi-license commit boundaries, the required copyright notice, and the clause
4(i) basis for the changed branding. These are the one place the original
project's name is required to stay.

## `README.md`

The run guide: what the app is, "Running it" and "Pages and URLs" (which the
maintenance policy keeps current), model setup, and an index of the guides.
Start here for "how do I run/use this."

## `docs/`

- **`decisions.md`** — the dated decisions log explaining *why* things are
  the way they are. Entries are history and never edited; new ones go at the
  top.
- **`ROADMAP.md`** + **`roadmap-timeline.mmd`** — project history and
  timeline. The `.mmd` file is the canonical mermaid source; `ROADMAP.md`
  embeds a copy of it (GitHub can't transclude external files), so the two
  are kept byte-identical in their diagram content.
- **`guides/`** — long-form operational docs, one per topic:
  `llama-cpp.md` (building llama.cpp, serving profiles, measurements),
  `telemetry.md` (the recorded GPU/throughput tables and how to read them),
  `benchmarks.md` (the Benchmarks section: tests, grading, compare, report),
  `testing.md` (the app's own test suites), `dependencies.md` (the backend
  venv and offline model cache), `frontend.md` (`apps/web` dev server,
  build, rough edges), `model-downloads.md` (`hf download` commands for the
  GGUF weights).
- **`plans/`** — implementation plans awaiting or under execution:
  `benchmark-upgrade.md` (EvalPlus datasets, LiveCodeBench, the llama-bench
  pre-screen, and error bars in Compare and Report).
- **`proposals/`** — not yet built: `proposed-inference-server.md`, a
  hardware proposal (Dell R730 + Tesla V100) for a dedicated inference
  server.
- **`history/`** — completed records, kept because code comments cite them
  and not updated any more: `migration-plan.md` (the monorepo /
  shell-removal / Astro-frontend migration, complete 2026-09-27),
  `bug-review-2026-09-27.md` and `code-review.md` (reviews with a "Status"
  section mapping each finding to its fix), and the migration-era mapping
  docs `common-components-mapping.md` (where each SvelteKit `common/`
  component landed) and `icons-mapping.md`; and `restructure-plan.md`, the
  2026-10 restructure into one project (plan, decisions, and each phase's
  PRs and verification).
- **`audit/`** — the 2026-10-19 full-repository bug audit of `7a4088b`:
  `COVERAGE.md` (review units and what was covered), `FINDINGS.md` (each
  non-security finding with its issue number), `FIX_PLAN.md` (batches and
  acceptance criteria for the fixing sessions), `NOTES.md` (non-bug
  observations and invariants checked) and `repro/` (minimal reproductions).
- **`serving-baseline/`** — test input, not prose: `config-id` fingerprints,
  profile seed data and the verbatim profile rationale, captured from
  `scripts/shell/main.sh` on 2026-09-14 before the shell layer was ported to
  Python, plus `fingerprints-v2.json` for the nine-line fingerprint of
  2026-10-19. Its own `README.md` explains what each file pins and why. It is
  also the record of what the shell layer meant.

## `infra/`

Infrastructure this repo runs but does not write.

- **`docker-compose.yml`** — Postgres + pgvector and Redis (session
  revocation, required since 2026-10-19) backing the backend.
  Its Compose project name is **pinned** to `local-llm` rather than
  inherited from this directory's name; the volume name derives from the
  project name, so the pin keeps the data in `local-llm_postgres-data`
  however the directory moves. Role and database are both `local_llm`. (It
  was pinned as `open-web-ui` from 2026-09-14 until the 2026-10-10 rename;
  see the file's own comment.)
- **`.env.example`** — the keys `infra/.env` needs, with empty values.
- **`.env`** — secrets (API keys, DB password, webui secret key); not
  enumerated here, and not tracked. Compose resolves it relative to the
  compose file, so it lives beside it.

## `apps/`

The applications themselves, all of it this project's own code (see
`AGENTS.md`'s Conventions).

- **`server/`** — the FastAPI backend (mapped below).
- **`web/`** — the Astro + React + shadcn/ui frontend (mapped below), which
  replaced the original SvelteKit app over Phases 3-11 of
  `docs/history/migration-plan.md`; its build (`dist/`) is what the backend's
  `main.py` serves at `/`.
- **`desktop/`**: the Electron desktop app (mapped below), added
  2026-10-23. It shows the backend's own pages, and it starts and stops the
  local stack through `make backend`.

### `apps/server/` (the backend)

The FastAPI backend. It began as a fork of Open WebUI v0.11.3, vendored into
this repo on 2026-09-14 and owned outright since (no upstream sync path; see
`NOTICE` for what is derived and `docs/decisions.md` for the history). The
fork's pre-import history is kept read-only at
`https://github.com/epittman23/open-webui.git` (branch `customizations`, at
`67d4039`). Its SvelteKit frontend (last present at `d863707`) was replaced by
`apps/web/`:

- **`local_llm/`** — the FastAPI app (the Python package): `main.py` (entrypoint),
  `routers/` (API endpoints, including `routers/benchmarks/`), `models/` (DB
  models, including `models/benchmarks/`), `internal/` + `migrations/`
  (Alembic DB migrations), `retrieval/` (RAG), `socket/` (websocket/
  real-time), `tools/`, `tasks.py`, `utils/`, `config.py`, and
  **`benchmarks/`** (see below).
- **`tests/`** — the backend's pytest suite, run from `apps/server/`
  (`tests/test_paths.py` pins the package's default paths).
- Root-level: `pyproject.toml`/`uv.lock` (backend deps; `pyproject.toml`
  also holds the version). There is no `backend/` level any more: it was
  flattened into `apps/server/` on 2026-10-10. The license files are at the
  repository root. The original project's Docker images, compose variants,
  CI workflows, start scripts and community files are gone; this repo runs
  through the root `Makefile` and `infra/`.

#### `local_llm/benchmarks/`

The testing/comparison/reporting/tuning suite that used to be this outer
repo's standalone `lllm-test`/`lllm-compare`/`lllm-report`/`lllm-tune` CLI
and `lllm-web` dashboard, migrated in whole into the backend so it is native
functionality (own routers, own pages, own Postgres tables) rather
than a second app glued on by a userscript. See `docs/decisions.md` for the migration and why each piece landed where it did.

- **`serving/`** — the serving layer ported from shell in Phase 2a/2b of the
  migration (2026-09-14 to 2026-09-17): `profiles.py` (`ServingProfile`,
  `Overrides`, `resolve()`), `fingerprint.py` (the `config_id` sha1, ported
  bit-for-bit from `_vramlog_config`), `launcher.py` (`ServeProcess`: argv
  assembly, spawns `llama-server` and the telemetry recorder), `weights.py`
  (`FetchProcess`, the `lllm-fetch` port), `build_info.py`/`model_name.py`
  (small `vram-log.sh` parsers). Also `env_profile.py` (resolves a serving
  profile and what's actually being served, in-process) and
  `telemetry_recorder.py` (the GPU telemetry recorder: a detached subprocess
  for crash-independence, spawned by `ServeProcess.start()` as
  `python -m local_llm.benchmarks.serving.telemetry_recorder`, inheriting the
  backend's `DATABASE_URL` and writing to Postgres via plain `psycopg`).
  Profiles themselves are rows in Postgres (`models/benchmarks/profiles.py`),
  versioned and CRUD'd through `routers/benchmarks/profiles.py`.
- **`evaluation/`** — `adapters.py`, `suites.py`, `datasets.py` (adapter and
  suite loading, dataset fetch and manifests), `runner.py` (the run/grade/
  record loop, `prepare_suite`/`run_items`, callback-driven so a router can
  stream live progress), and `grading/` (the HumanEval/MBPP/DS-1000 harnesses).
- **`analysis/`** — `compare.py`, `report.py` + `report_figures.py` (config
  comparison by block and the design-audited statistical report: Wilson
  intervals, Cochran's Q, exact McNemar, power/MDE; reads the DB read-only),
  `estimators.py` (the error bars both use: per-problem averaging,
  cluster-robust errors, paired comparisons, Holm, letter groups, the
  passes-per-minute delta method; pure functions) and
  `stats.py` (percentiles, GPU throttle-bitmask decoding, config-text and
  load-log parsing; pure functions shared with serving and tuning).
- **`tuning/`** — `tune.py` + `tune_schedule.py` + `tune_probe.py` (the
  round-elimination configuration search: staged explore/refine, paired
  throughput ranking, GPU-cooldown/drift handling, driving `ServeProcess`
  directly for each candidate) and `proc.py` (`Command`, the async subprocess
  wrapper; its only caller is `tune_probe.py`'s `LLAMA_TUNE_LAUNCH`
  fault-injection escape hatch).
- **`data/`** + **`paths.py`** — the version-controlled TOML/text config
  (`data/adapters/`, `data/suites/`, `data/tuning/`, `data/prompts/`, moved
  here from this repo's old `tests/adapters/`, `tests/suites/`,
  `tests/tuning/`, `prompts/system/`), and the one module that locates it.

### `apps/web/` (Astro + React + shadcn/ui)

The frontend, which replaced the original SvelteKit app surface by
surface (see `docs/history/migration-plan.md`'s Phases 3-11).
`docs/guides/frontend.md` covers usage; this is a structural summary.

- **`astro.config.mjs`** — `output: 'static'`, `@astrojs/react`,
  `@tailwindcss/vite`; the dev-server proxy mirrors the Svelte app's
  `vite.config.ts` (`d863707:apps/openwebui/vite.config.ts`) exactly (`/api`, `/ollama`, `/openai`, `/oauth`, `/ws`
  → `:4000`); `base` is `/`, where `main.py` mounts the build.
- **`components.json`** — shadcn/ui's own config: `radix-nova` preset,
  Lucide icons, CSS variables. See `docs/decisions.md`'s 2026-09-18
  entry for why this preset and not the migration plan's original
  "new-york" (the CLI's own style system changed).
- **`src/layouts/Base.astro`** — `<html>`/`<head>` shell: the anti-FOUC
  dark-mode script (mirrors the Svelte app's `src/app.html`) and the
  `--app-text-scale` CSS variable's declaration.
- **`src/pages/[...path].astro`** + **`src/middleware.ts`** — the single
  static entry. The catch-all alone doesn't give `astro dev` a deep-link
  fallback (`output: 'static'` enumerates dev routes from `getStaticPaths`);
  the middleware rewrites a 404 back to the root, matching what `main.py`'s
  `SPAStaticFiles` mount already does in production.
- **`src/components/App.tsx`** — the one persistent `client:only="react"`
  root: i18n, TanStack Query, auth, and Socket.IO providers around
  `routes/AppRouter.tsx`.
- **`src/components/layout/`** — `AppShell` (collapsible sidebar, mobile
  Sheet, and the auth gate for everything beneath it) and `Sidebar`.
- **`src/components/common/`** — app-level components shared across
  surfaces (not shadcn primitives): `SplitCreateButton`, `Spinner`, `Tip`
  (tooltip wrapper), `ConfirmDialog`, `FilterSelects` (the workspace
  View/Tag selectors), `ListChrome` (search bar, sortable header, empty
  state shared by every workspace list), `PagePagination`, `Tags`, and the access-control
  family (`AccessControl`, `AccessControlModal`, `AddAccessModal`,
  `MemberSelector`, `AccessButton`), `CodeEditor` (CodeMirror, lazy-loaded
  by its one caller), `Valves`/`ValvesModal`, `ManifestModal`,
  `ImportUrlModal`, `SafeMarkdown` (marked + DOMPurify), `AttachWebpageDialog`,
  and `AdvancedParams` (table-driven request parameters,
  `advancedParamDefs.ts`).
- **`src/components/settings/`** — the Settings modal: `SettingsModal`
  (tab list, search, URL param via `lib/settings/useSettingsUrl.ts`),
  `settingsTabs.ts` (every tab id), `adminTabComponents.ts` (lazy tab
  bodies), `controls.tsx` (the compact form vocabulary every tab uses), and
  the pieces the personal tabs (`settings/personal/`) reuse: `AddConnectionModal`,
  `AddToolServerModal`, `AddTerminalServerModal` and `InterfaceSettings`
  (table-driven, `interfaceSettingDefs.ts`), each with its rules in a
  `*Model.ts`/`*Defs.ts` and a unit test. The app's toast system
  (`ui/sonner.tsx`, mounted in `App.tsx`) reads the theme from the `<html>`
  class rather than `next-themes`.
- **`src/components/ui/`** — shadcn/ui components (`bunx shadcn add <name>`).
- **`src/routes/`** — react-router. `AppRouter.tsx` has three kinds of
  route: gated ones under `AppShell` (the chat, `benchmarks/`,
  `workspace/`, `admin/` and the Phase 9 surfaces); the public ones
  (`public/`: `/auth`, `/error`, `/watch`, `/s/:id`), which are top-level
  siblings because they must render without a session; and
  `NotFound`, the catch-all 404, which never navigates on its own. `benchmarks/`
  holds all seven Benchmarks pages plus their admin/feature-flag gate.
  `workspace/` is Phase 7's surface: `WorkspaceLayout` (per-section
  permission gate, the five tabs with live counts, the split Create button)
  and `workspaceAccess.ts` (the pure permission rules, unit-tested); the
  five sections mount beneath it as they are ported. `workspace/prompts/`
  is the first: list, create dialog, and the edit page with version history;
  `workspace/skills/` and `workspace/tools/` follow (tools: list with
  client-side filtering, a CodeMirror editor, valves, import/export) and
  `workspace/knowledge/` (an infinite-scroll list; the detail page with a
  folder tree, uploads, incremental folder sync and a file-text sheet --
  `knowledgeFiles.ts` holds its pure path/diff logic, `useKnowledgeUploads.ts`
  the upload flows), and `workspace/models/` (list with bulk actions and
  pinning; `ModelEditor` with its data flow in `modelEditorLogic.ts`, the
  pickers in `EditorPickers`/`KnowledgePicker`, and import
  sanitizers in `modelImport.ts`). `admin/` is Phase 8's surface:
  `AdminLayout` (admin-only gate, tab bar) and `adminAccess.ts`; `users/`
  (users and groups, permissions table in `permissionRows.ts`),
  `evaluations/` (leaderboard with the chart.js activity chart, feedback),
  `functions/` (list and editor). `/admin/settings[/<tab>]` and
  `/admin/analytics` are only redirects (`SettingsRedirects.tsx`): admin
  Settings is a *modal* (`?settings=admin:<tab>`), and the sixteen tab
  bodies live in `admin/settings/` (plus `admin/analytics/` and
  `admin/settings/models/`), each with its rules in a `*.ts` beside it and a
  unit test. Phase 9's surfaces sit beside them, each gated by
  `common/FeatureGate` on the rules in `lib/access/features.ts`: `notes/`
  (list, TipTap editor with autosave; the editor is
  `components/common/RichTextEditor`), `calendar/`, `automations/`,
  `playground/` and `channels/`, the first Socket.IO consumer: the page,
  `MessageList`/`ChannelMessageView`, `MessageComposer` (mentions,
  attachments), `ThreadPanel`, `ChannelDialogs` (pinned, members, webhooks,
  create/edit), `SidebarChannels`, `useMessageFeed` (one feed for a channel
  or a thread: paging, live events, optimistic actions), `useChannels` (the
  `['channels']` list and the app-wide unread listener mounted in
  `AppShell`), and the pure rules in `channelModel.ts`. `home/` is small:
  `/home` was an unlinked stub in the Svelte app. `chat/` is Phase 10's
  surface: one layout route for `/`, `/c/<id>` and `/folders/<id>`
  (`ChatPage`), `useChatSession` (load, send, stream over the socket, stop,
  regenerate, save), `ChatMessages`/`MessageActions`, `ChatInput` with
  `InputMenus` and `useAttachments`, `ModelSelector`, `ChatControls`,
  `ArtifactPanel` (a sandboxed preview), `ChatMenu`, and `sidebar/` (the
  chat list, folders, search). Its pure rules are in `src/lib/chat/`
  (history tree, request body, sources, attachments, import) and its
  Markdown in `src/lib/markdown/` + `src/components/chat/markdown/`.
- **`src/lib/apis/`** — the SvelteKit app's `src/lib/apis/**` ported
  verbatim (six files `@ts-nocheck`ed for inherited looseness), plus
  `benchmarks/profiles.ts`, new code for the profile CRUD endpoints that
  never had a frontend.
- **`src/lib/auth/`**, **`stores/`** (Zustand: auth, config, UI),
  **`socket/`**, **`i18n/`** (i18next setup and the one shipped locale, `en-US`),
  **`query/`**, **`utils/`** (only the functions from the SvelteKit app's
  `utils/index.ts` that ported pages actually use),
  **`access/`** (`accessGrants.ts`: the pure grant-rewriting rules behind
  `AccessControl`), and **`settings/`** (`userSettings.ts`: the user's saved
  UI settings through TanStack Query, for model pinning; `useConfigDraft`
  and `useAdminSaved`, the load-edit-save pattern of the admin tabs;
  `useSettingsUrl`, the `?settings=` param).
- **`src/lib/emoji/`** — emoji data and shortcode lookup behind
  `components/common/EmojiPicker`.
- **`src/styles/global.css`** — the Tailwind v4 entry and the shadcn Nova
  preset's design tokens.
- **`e2e/`** — Playwright; `global-teardown.ts` force-stops the dev server
  after a run (see its own comment for why that isn't left to Playwright's
  ordinary teardown alone). Specs import `test` from `e2e/test.ts`, not from
  `@playwright/test`: it auto-applies `no-socket-proxy.ts`, which keeps the
  app's Socket.IO connection out of the dev server's `/ws` proxy (with no
  backend running, that proxied websocket crashes the Bun-hosted dev server
  after ~30s). `workspace-helpers.ts` is the shared session/config mock for
  the workspace and admin specs; `fake-socket.ts` is a minimal Socket.IO
  server (over `page.routeWebSocket`) for specs that need live events.

### `apps/desktop/` (Electron)

The desktop app. `docs/guides/desktop.md` covers usage; this is a
structural summary.

- **`src/main.ts`**: the lifecycle. It holds the startup paths (attach,
  adopt, own, remote), the app and dialog windows, shutdown, the menu, what
  windows may open, and the dialog's IPC handlers, which check their sender.
- **`src/stack.ts`**:
  - the start decision and the UI-staleness check;
  - crash adoption (`owned.json` against `/proc/<pid>/stat`);
  - the `make backend` / build / `compose down` commands, run in a login
    shell;
  - `stopGroup()`, one SIGINT and a bounded wait;
  - `probe()` and `LogTail`.
- **`src/progress.ts`**: the progress dialog's step reducer, driven by the
  Makefile's and the backend's `==> ` markers.
- **`src/config.ts`** (settings in `~/.config/Local LLM/config.json`) and
  **`src/policy.ts`** (navigation and permission rules). Both are pure.
- **`src/preload.ts`**: the app window's bridge (`window.lllmDesktop`), the
  seam for future native features. **`src/status-preload.ts`** is the
  dialog's bridge.
- **`static/`**: `status.html`/`.css`/`.js`, the progress and settings
  dialog.
- **`test/fixtures/`**: `make backend` logs the progress tests replay.
- **`electron-builder.yml`**: the `.rpm` and its fuses.
  **`scripts/build-info.mjs`** records the checkout a build came from.
  `tsconfig.json` type-checks everything and `tsconfig.build.json` emits
  the app.

## `Makefile`

Root-level process lifecycle and CI-mirroring checks: `make lint`/`make
test`/`make check` (the same commands as `.github/workflows/ci.yml`'s jobs,
`make test-desktop` among them; see `docs/guides/testing.md`), `make desktop`
(the desktop app from the checkout), `make backend` (Postgres +
`apps/server`'s `uvicorn --reload` on `:4000`, with `DATA_DIR` pinned to
`apps/server/data`, Postgres torn down
on exit including Ctrl-C; it also serves `apps/web/dist` at `/`), and
`make frontend`, alias `make astro` (`apps/web`'s `astro dev` on `:5174`,
proxying to `:4000` — added Phase 3 as `make astro`, renamed in Phase 11e
when the Svelte `make frontend` went; works around
that Astro version's `dev` command always daemonizing, see the target's own
comment). Replaces `scripts/` (deleted in Phase 2c of
the migration, 2026-09-18 — see `docs/decisions.md`), which held
a shell orchestrator, `lllm-*` commands, and a Rich/plain terminal CLI
(`llama_console.py`, backing `lllm-profiles`/`lllm-check`/`lllm-vram`) with
no replacement of its own; those diagnostics now live in the app's own
Benchmarks section (Serve/Live pages), same as serving itself since
Phase 2a/2b. Per-module purpose and rationale are documented in detail in
[`AGENTS.md`](AGENTS.md)'s "Conventions" section — this entry is a
summary, not a replacement.

## Local/generated (not tracked)

Present on disk but gitignored — won't show up in `git ls-files`, but worth
knowing about when navigating the filesystem directly:

- **`.vscode/`** — editor config (currently empty).
- **`.claude/`** — Claude Code local state (`settings.local.json`,
  scheduled task locks).
- **`logs/`** — local logs. On a checkout that has one,
  `llama.db.retired-<date>` is the old SQLite store from before 2026-09-08;
  its Postgres backfill was lost with the old database on 2026-10-09, so that
  file is the only copy of that history. Absent on the current machine.
- **`apps/server/data/`** — the backend's `DATA_DIR` (pinned by the
  Makefile): uploads, caches, the Benchmarks section's fetched datasets,
  answer exports and reports. Created at boot if missing. A checkout from
  before 2026-10-10 has it at `apps/server/backend/data/` until moved.
- **`apps/server/.venv/`** — the backend's own virtualenv (uv's default
  location),
  bootstrapped by `make backend` on first run. The only Python virtualenv in
  this repo since Phase 2c deleted the root `.venv/` along with `scripts/`.
- **`apps/web/node_modules/`**, **`apps/web/dist/`**, **`apps/web/.astro/`** —
  the new frontend's dependency tree, production build output (served at
  `/` when present — `FRONTEND_BUILD_DIR` in `apps/server/local_llm/env.py`),
  and Astro's generated type cache. `bun.lock` beside them **is** tracked.
- **`apps/web/test-results/`**, **`apps/web/playwright-report/`** — Playwright
  output from `bun run test:e2e`.
- **`apps/desktop/node_modules/`**, **`apps/desktop/dist/`** (tsc output),
  **`apps/desktop/release/`** (electron-builder's packages). The app's own
  state lives outside the repo, in `~/.config/Local LLM/`.
- **`__pycache__/`** — Python bytecode cache, scattered under `apps/server/`.
