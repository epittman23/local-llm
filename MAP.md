# Repo Map

A fast index of this repo's layout: what lives where, and what each
directory/major file is for. Use this to orient before searching — it
answers "where would X be," not "how does X work." For the *why* behind
decisions and per-module conventions, see [`docs/CLAUDE.md`](docs/CLAUDE.md).
For usage/operations ("how do I run this"), see [`README.md`](README.md).

This file is a structural index only. It does not restate rationale that
already lives in `docs/CLAUDE.md`'s "Conventions" section — it points there
instead.

## Top-level tree

```
local-llm/
├── Makefile                   make backend, make frontend, make astro, make help
├── README.md                  usage/operations guide
├── MAP.md                     this file
├── apps/                      the applications themselves
│   ├── openwebui/             vendored Open WebUI fork (FastAPI + SvelteKit)
│   └── web/                   Astro + React + shadcn/ui frontend (Phase 3+)
├── docs/                      meta docs: conventions, roadmap, proposals
└── infra/                     docker-compose for Postgres + pgvector
```

`scripts/` (the shell orchestrator plus the `llama-console` CLI helpers) and
the root `requirements.txt`/`.venv` are gone as of Phase 2c of the migration
(2026-09-18) — see `docs/CLAUDE.md`'s decisions log. `make backend`/
`make frontend` are the replacement entry points; serving configuration
itself lives in the backend as Python (`apps/openwebui/backend/open_webui/
benchmarks/serving/`), not in a shell profile table.

Local/generated (not tracked by git — see "Local/generated" section below
for detail): `.vscode/`, `.claude/`, `logs/`, `tests/data/` (orphaned, see
below), and scattered `__pycache__/` directories.

## `README.md`

The usage/operations guide: running the assistant, model setup, local
inference with llama.cpp, and the Open WebUI fork (frontend/backend/Postgres,
the Benchmarks section covering testing/comparison/reporting/tuning). Start
here for "how do I run/use this."

## `docs/`

Meta docs — conventions, history, and proposals, not end-user usage docs.

- **`CLAUDE.md`** — the contributor guide: project conventions, the
  maintenance policy (this file's own upkeep rule lives there), and a dated
  decisions log explaining *why* things are the way they are. Read this
  before making structural or config changes.
- **`ROADMAP.md`** + **`roadmap-timeline.mmd`** — project history and
  timeline. The `.mmd` file is the canonical mermaid source; `ROADMAP.md`
  embeds a copy of it (GitHub can't transclude external files), so the two
  are kept byte-identical in their diagram content.
- **`model-downloads.md`** — quick-reference `hf download` commands for the
  GGUF model weights in use.
- **`proposed-inference-server.md`** — a hardware proposal (Dell R730 +
  Tesla V100) for a future dedicated inference server. Status: proposed, not
  built.
- **`migration-plan.md`** — the resumable plan for the in-flight monorepo /
  shell-removal / Astro-frontend migration: status board, locked decisions,
  per-phase checklists, and the current session's notes. Read it first when
  resuming that work, and update it before ending a session. Temporary:
  delete it (and this entry) when the migration's final phase lands.
- **`serving-baseline/`** — test input, not prose: `config-id` fingerprints,
  profile seed data and the verbatim profile rationale, captured from
  `scripts/shell/main.sh` on 2026-09-14 before the shell layer is ported to
  Python and the profiles move into Postgres. Its own `README.md` explains
  what each file pins and why. Keep it after the port: it is also the record
  of what the shell layer meant.

## `infra/`

Infrastructure this repo runs but does not write.

- **`docker-compose.yml`** — Postgres + pgvector service backing the fork.
  Its Compose project name is **pinned** to `open-web-ui` rather than
  inherited from this directory's name; the volume name derives from the
  project name, so without the pin the 2026-09-14 move of this file out of
  `open-web-ui/` would have orphaned `open-web-ui_postgres-data` and started
  the backend against an empty database. Do not change it.
- **`.env`** — secrets (API keys, DB password, webui secret key); not
  enumerated here, and not tracked. Compose resolves it relative to the
  compose file, so it lives beside it.

## `apps/`

The applications themselves. Before 2026-09-14 this repo held no application
code at all; the fork lived in a submodule and that rule was a real
constraint. It is not any more — see `docs/CLAUDE.md`'s Conventions.

- **`openwebui/`** — the vendored Open WebUI fork (mapped below).
- **`web/`** — the Astro + React + shadcn/ui frontend that will eventually
  replace `openwebui/`'s SvelteKit app (mapped below). Added in Phase 3 of
  `docs/migration-plan.md` (2026-09-18); dual-serves alongside the fork
  during the migration, mounted read-only at `/next` in the fork's own
  `main.py` rather than replacing anything yet.

### `apps/openwebui/` (vendored fork)

A pinned fork of [`open-webui/open-webui`](https://github.com/open-webui/open-webui)
(v0.11.3), vendored into this repo as ordinary tracked files on 2026-09-14 —
previously a git submodule. The import squashed the fork's history to a
single commit; the full history remains at
`https://github.com/epittman23/open-webui.git` (branch `customizations`, at
`67d4039`), which is kept as a read-only archive. This is now owned code, a
permanent hard fork with no upstream sync path — see `docs/CLAUDE.md`'s
decisions log. For upstream feature docs see its own
`README.md`/`CHANGELOG.md`, not restated here. A SvelteKit + FastAPI app:

- **`backend/open_webui/`** — the FastAPI app: `main.py` (entrypoint),
  `routers/` (API endpoints, including `routers/benchmarks/`), `models/` (DB
  models, including `models/benchmark_*.py`), `internal/` + `migrations/`
  (Alembic DB migrations), `retrieval/` (RAG), `socket/` (websocket/
  real-time), `tools/`, `tasks.py`, `utils/`, `config.py`, and
  **`benchmarks/`** (see below — fork-owned, not upstream).
- **`src/`** — the SvelteKit frontend: `routes/` (pages, including
  `routes/(app)/benchmarks/`), `lib/` (`components/benchmarks/`,
  `apis/benchmarks/`, plus upstream components/stores/utils),
  `app.html`/`app.css`.
- **`static/`**, **`docs/`**, **`scripts/`**, **`test/`** — assets, upstream
  docs, dev scripts, upstream test suite.
- Root-level: `Dockerfile`, several `docker-compose.*.yaml` variants
  (gpu/amdgpu/otel/playwright/a1111-test/etc.), `pyproject.toml`/`uv.lock`
  (backend deps), `package.json`/`bun.lock` (frontend deps), `Makefile`,
  `CHANGELOG.md`, `TROUBLESHOOTING.md`.

#### `backend/open_webui/benchmarks/` (fork-owned, not upstream)

The testing/comparison/reporting/tuning suite that used to be this outer
repo's standalone `lllm-test`/`lllm-compare`/`lllm-report`/`lllm-tune` CLI
and `lllm-web` dashboard, migrated in whole into the fork so it is native
functionality (own routers, own SvelteKit pages, own Postgres tables) rather
than a second app glued on by a userscript. See docs/CLAUDE.md's decisions
log for the migration and why each piece landed where it did.

- **`serving/`** — the serving layer ported from shell in Phase 2a/2b of the
  migration (2026-09-14 to 2026-09-17): `profiles.py` (`ServingProfile`,
  `Overrides`, `resolve()`), `fingerprint.py` (the `config_id` sha1, ported
  bit-for-bit from `_vramlog_config`), `launcher.py` (`ServeProcess`: argv
  assembly, spawns `llama-server` and the telemetry recorder), `weights.py`
  (`FetchProcess`, the `lllm-fetch` port), `build_info.py`/`model_name.py`
  (small `vram-log.sh` parsers). Profiles themselves are rows in Postgres
  (`models/benchmark_profiles.py`), versioned and CRUD'd through
  `routers/benchmarks/profiles.py`, not a shell case statement.
- **`stats.py`** — percentiles, GPU throttle-bitmask decoding, config-text
  parsing, the server load-log parser. Pure functions.
- **`proc.py`** — `Command`, the async subprocess wrapper (process-group
  start/stop/interrupt). Only caller left is `tune_probe.py`'s
  `LLAMA_TUNE_LAUNCH` fault-injection escape hatch; serving and tuning
  candidates both go through `serving/launcher.py`'s `ServeProcess` now, not
  through this plus a shelled-out `lllm-serve`.
- **`env_profile.py`** — resolves a serving profile and what's actually
  being served by reading `BenchmarkProfiles` and calling
  `serving/profiles.py`'s `resolve()` in-process (no subprocess, no shell).
- **`adapters.py`, `suites.py`, `datasets.py`, `grading/`** — benchmark
  adapter/suite loading, dataset fetch/manifest handling, and the per-
  benchmark grading harnesses (HumanEval/MBPP/DS-1000), plus their TOML/text
  config under `data/adapters/`, `data/suites/`, `data/tuning/`,
  `data/prompts/` (moved here from this repo's old `tests/adapters/`,
  `tests/suites/`, `tests/tuning/`, `prompts/system/`).
- **`runner.py`** — the run/grade/record loop (`prepare_suite`/`run_items`),
  callback-driven so a router can stream live progress.
- **`compare.py`**, **`report.py`** + **`report_figures.py`** — config
  comparison and the design-audited statistical report (Wilson intervals,
  Cochran's Q, exact McNemar, power/MDE), reading the DB read-only.
- **`tune.py`** + **`tune_schedule.py`** + **`tune_probe.py`** — the
  round-elimination configuration-search engine (staged explore/refine,
  paired throughput ranking, GPU-cooldown/drift handling), driving
  `ServeProcess` directly for each candidate.
- **`telemetry_recorder.py`** — the GPU telemetry recorder, still a
  detached subprocess for crash-independence, spawned directly by
  `ServeProcess.start()` (`python -m open_webui.benchmarks.telemetry_recorder`,
  inheriting the backend's own `DATABASE_URL`) rather than by a shell script,
  writing to this app's Postgres via plain `psycopg`.
- **`scripts/backfill_from_sqlite.py`** — one-time migration of the old
  `logs/llama.db` (see below) into these Postgres tables. Already run; kept
  for reference/disaster-recovery, not part of any regular workflow.

### `apps/web/` (Astro + React + shadcn/ui)

The frontend `apps/openwebui/`'s SvelteKit app is being migrated to,
surface by surface (see `docs/migration-plan.md`'s Phases 3-11). Its own
`README.md` covers usage in detail; this is a structural summary.

- **`astro.config.mjs`** — `output: 'static'`, `@astrojs/react`,
  `@tailwindcss/vite`; the dev-server proxy mirrors `apps/openwebui/
  vite.config.ts`'s exactly (`/api`, `/ollama`, `/openai`, `/oauth`, `/ws`
  → `:4000`); `base` is `/next` for a production build only (where `main.py`
  mounts it), unprefixed in dev.
- **`components.json`** — shadcn/ui's own config: `radix-nova` preset,
  Lucide icons, CSS variables. See `docs/CLAUDE.md`'s 2026-09-18 decisions
  entry for why this preset and not the migration plan's original
  "new-york" (the CLI's own style system changed).
- **`src/layouts/Base.astro`** — `<html>`/`<head>` shell: the anti-FOUC
  dark-mode script (mirrors `apps/openwebui/src/app.html`'s own) and the
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
  `MemberSelector`, `AccessButton`). The app's toast system
  (`ui/sonner.tsx`, mounted in `App.tsx`) reads the theme from the `<html>`
  class rather than `next-themes`.
- **`src/components/ui/`** — shadcn/ui components (`bunx shadcn add <name>`).
  `src/components/COMMON_MAPPING.md` records where each of the SvelteKit
  app's `common/` components lands.
- **`src/routes/`** — react-router. `AppRouter.tsx` has three kinds of
  route: gated ones under `AppShell` (home/notes/calendar placeholders,
  `benchmarks/`, and `workspace/`); the public ones (`public/`: `/auth`,
  `/error`, `/watch`, `/s/:id`), which are top-level siblings because they
  must render without a session; and `LegacyFallback`, which bounces every
  path not listed in `routePaths.ts` to the SvelteKit app. `benchmarks/`
  holds all seven Benchmarks pages plus their admin/feature-flag gate.
  `workspace/` is Phase 7's surface: `WorkspaceLayout` (per-section
  permission gate, the five tabs with live counts, the split Create button)
  and `workspaceAccess.ts` (the pure permission rules, unit-tested); the
  five sections mount beneath it as they are ported. `workspace/prompts/`
  is the first: list, create dialog, and the edit page with version history;
  `workspace/skills/` follows (list, editor, create/edit pages).
- **`src/lib/apis/`** — the SvelteKit app's `src/lib/apis/**` ported
  verbatim (six files `@ts-nocheck`ed for inherited looseness), plus
  `benchmarks/profiles.ts`, new code for the profile CRUD endpoints that
  never had a frontend.
- **`src/lib/auth/`**, **`stores/`** (Zustand: auth, config, UI),
  **`socket/`**, **`i18n/`** (the fork's 65 locale files, verbatim),
  **`query/`**, **`utils/`** (only the functions from the SvelteKit app's
  `utils/index.ts` that ported pages actually use), **`icons/MAPPING.md`**,
  and **`access/`** (`accessGrants.ts`: the pure grant-rewriting rules behind
  `AccessControl`).
- **`e2e/`** — Playwright; `global-teardown.ts` force-stops the dev server
  after a run (see its own comment for why that isn't left to Playwright's
  ordinary teardown alone). Specs import `test` from `e2e/test.ts`, not from
  `@playwright/test`: it auto-applies `no-socket-proxy.ts`, which keeps the
  app's Socket.IO connection out of the dev server's `/ws` proxy (with no
  backend running, that proxied websocket crashes the Bun-hosted dev server
  after ~30s). `workspace-helpers.ts` is the shared session/config mock for
  the workspace specs.

## `Makefile`

Root-level process lifecycle only: `make backend` (Postgres +
`apps/openwebui/backend`'s `uvicorn --reload` on `:4000`, Postgres torn down
on exit including Ctrl-C), `make frontend` (`apps/openwebui`'s `vite dev`
on `:5173`, proxying to `:4000`), and `make astro` (`apps/web`'s `astro dev`
on `:5174`, proxying to `:4000` — added Phase 3, 2026-09-18; works around
that Astro version's `dev` command always daemonizing, see the target's own
comment). Replaces `scripts/` (deleted in Phase 2c of
the migration, 2026-09-18 — see `docs/CLAUDE.md`'s decisions log), which held
a shell orchestrator, `lllm-*` commands, and a Rich/plain terminal CLI
(`llama_console.py`, backing `lllm-profiles`/`lllm-check`/`lllm-vram`) with
no replacement of its own; those diagnostics now live in the fork's own
Benchmarks section (Serve/Live pages), same as serving itself since
Phase 2a/2b. Per-module purpose and rationale are documented in detail in
[`docs/CLAUDE.md`](docs/CLAUDE.md)'s "Conventions" section — this entry is a
summary, not a replacement.

## Local/generated (not tracked)

Present on disk but gitignored — won't show up in `git ls-files`, but worth
knowing about when navigating the filesystem directly:

- **`.vscode/`** — editor config (currently empty).
- **`.claude/`** — Claude Code local state (`settings.local.json`,
  scheduled task locks).
- **`logs/`** — `llama.db.retired-<date>` (the old sqlite store, kept as a
  backup after its contents were backfilled into the fork's Postgres —
  safe to delete once that backfill is trusted) and server logs.
- **`tests/data/`** — orphaned: the old CLI's fetched-dataset cache
  (HumanEval/MBPP/DS-1000 `items.jsonl`/`MANIFEST.json`/`CALIBRATION.json`).
  Nothing reads this any more; the fork's Benchmarks feature fetches its own
  copy under its own `DATA_DIR` on first use. Safe to delete.
- **`apps/openwebui/node_modules/`** — the frontend dependency tree (~1.3 GB),
  installed by `make frontend` on first run. `bun.lock` beside it **is**
  tracked (upstream ignored it; this repo does not — see that file's own
  `.gitignore` comment).
- **`apps/openwebui/backend/.venv/`** — the fork backend's own virtualenv,
  bootstrapped by `make backend` on first run. The only Python virtualenv in
  this repo since Phase 2c deleted the root `.venv/` along with `scripts/`.
- **`apps/web/node_modules/`**, **`apps/web/dist/`**, **`apps/web/.astro/`** —
  the new frontend's dependency tree, production build output (mounted at
  `/next` when present — see `apps/openwebui/backend/open_webui/main.py`),
  and Astro's generated type cache. `bun.lock` beside them **is** tracked.
- **`apps/web/test-results/`**, **`apps/web/playwright-report/`** — Playwright
  output from `bun run test:e2e`.
- **`__pycache__/`** — Python bytecode cache, scattered under the vendored
  fork.
