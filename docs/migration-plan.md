# Monorepo merge + shell removal + Astro/shadcn frontend rewrite

> **Resumable plan.** This file is the durable state of a multi-session
> project. Every work session must (a) read the Status board before doing
> anything, and (b) update the Status board, the phase checklist and the
> session notes before ending. See [Resume protocol](#resume-protocol).
>
> It lives in the repo, not in a tool's scratch directory, on purpose: the
> first copy was written to a session-local plans directory and did not
> survive the move from a cloud dev container to the real machine. A ledger
> that can be lost is not a ledger.

---

## Status board

| Phase | Title | Status | Last touched |
|---|---|---|---|
| 0 | Groundwork and safety net | ✅ done | 2026-09-14 |
| 1 | Monorepo merge (submodule → vendored tree) | ✅ done, verified on-machine | 2026-09-14 |
| 2 | Shell removal → Python + Makefile | ✅ done, verified on real hardware | 2026-09-18 |
| 3 | Astro + React + shadcn scaffold, dual-serve | ✅ done | 2026-09-18 |
| 4 | Shared foundation: API, auth, stores, i18n, app shell | ☐ not started | — |
| 5 | Benchmarks surface (proves the pattern) | ☐ not started | — |
| 6 | Public/static surfaces: auth, error, share, watch | ☐ not started | — |
| 7 | Workspace surface | ☐ not started | — |
| 8 | Admin surface | ☐ not started | — |
| 9 | Secondary surfaces: notes, calendar, automations, playground, channels | ☐ not started | — |
| 10 | Chat surface (largest) | ☐ not started | — |
| 11 | Cutover and Svelte removal | ☐ not started | — |

Status values: `☐ not started` · `▶ in progress` · `✅ done` · `⏸ blocked`

### Current session notes

_Overwrite this block at the end of every session._

**2026-09-14 (second session, on the real machine).**

Commits so far on `claude/monorepo-frontend-refactor-gh12a2`, on top of
baseline `e6164039f2dfc36efd714038539fd28c4230295b`:

| Commit | Phase | What |
|---|---|---|
| `7270a64` | 0 | `docs/serving-baseline/` — 24 fingerprint cases, 4 invariants, profile seed data, verbatim rationale |
| `4587d06` | 1a | Vendored the fork verbatim; all 5110 paths and blob hashes identical to `67d4039` |
| `d0b6ea2` | 1b | Moved to `apps/openwebui/` + `infra/`, pinned the Compose project name, 8 path refs, 5 docs |
| `34bc5bc` | 2 | `benchmarks/serving/profiles.py` + `fingerprint.py`, 79 tests green |

**Phase 1 verified on the real machine:** `infra/.env` moved, `open-web-ui/`
gone, and the original `open-web-ui_postgres-data` volume is the one in use,
holding 37 `benchmark_config` rows, 100 runs, 467 requests; Alembic at
`b3f8a1d94e70`.

**The fingerprint port is now checked against real history, not just the
shell:** all 37 stored `config_id`s reproduce from their stored
`config_text` with the ported hash algorithm, 0 mismatches, and every row
has exactly six lines. Two golden-baseline ids (`71bc58dd` qwen25c,
`1e9720b2` qwen3c) appear in that history.

**Found and fixed this session — the backend could not start.** `git pull`
does not move gitignored files, so the old backend venv and `node_modules`
stayed behind in `open-web-ui/openwebui/` and were deleted with that
directory. `lllm-backend` then rebuilt the venv with bare `python3`, which in
an interactive shell on this machine is linuxbrew's **3.14.7**. The fork
requires `>= 3.11, < 3.13`, so all 128 pins failed; `_lllm_openwebui_python`
never checked pip's exit status, so it kept a venv containing only `pip` and
would have reused it forever. Fixed in `main.sh`: interpreter chosen by
version (`python3.12` → `python3.11` → `python3` if in range, or
`LLAMA_OPENWEBUI_PYTHON`), a `.lllm-bootstrap-complete` stamp written only
after a successful install, a failed install removed rather than kept, and
both callers (`lllm-backend`, `vram-log.sh`) failing loudly. Frontend was
fine: `node_modules` reinstalled cleanly, `bun.lock` unchanged.

**Also this session — Phase 2a DB work, written and parked, NOT merged.**
`models/benchmark_profiles.py` (identity + append-only version tables, CRUD
table class); Alembic revision `5a1f0c3e9b27` (creates both tables with a
partial unique index for the default and a dense-has-no-moe CHECK, seeds the
four profiles as version 1, adds nullable `benchmark_run.profile_version_id`,
writes a `benchmark_schema_note`); `profile_version_id` on the `BenchmarkRun`
model; `validate_definition` + `ServingProfile.from_definition` moved into
`serving/profiles.py` so they test without a DB; `tests/test_serving_profiles.py`.
**117 tests pass** under the rebuilt venv, including the migration's frozen
`SEED` reproducing all 24 golden fingerprints and matching `profiles.json`
field by field. **Gating step 1 is now done** (see the next block); the
migration has still not been run against any database.

**It lives on branch `wip/phase-2a-serving-profiles` (pushed), deliberately
not on this branch.** Open WebUI runs `alembic upgrade head` on every backend
start (`backend/open_webui/config.py:80-81`; `ENABLE_DB_MIGRATIONS` defaults
on), reading the migrations directory *on disk* — so leaving an untested
migration in the working tree would have let the next `lllm-backend` apply
it to live data. The `BenchmarkRun` model edit must travel with the
migration: it references a column only the migration creates.

**2026-09-15 (third session, back in a cloud container).** Gating step 1
done, on `wip/phase-2a-serving-profiles` at `5a11c0e` (pushed; still **not**
merged here). The lint pass found a real bug, not just style:

- `benchmark_profiles.py` calls `validate_definition()` in `create()` and
  `add_version()` without importing it — `NameError` the first time a
  profile is created or edited through the CRUD layer. Invisible to the 117
  tests because they are deliberately database-free, so every DB-touching
  method on `BenchmarkProfileTable` has no coverage. It also imported
  `ARCH_DENSE`/`ARCH_MOE`, which it never used.
- `serving/profiles.py` annotated with `Mapping` and `Any` without importing
  either. Latent rather than live: `from __future__ import annotations`
  makes annotations strings that are never evaluated, so it works until
  something calls `get_type_hints()` on them.
- Added an import-guard test so this class of bug fails in the suite rather
  than only under ruff. It skips without the backend venv (importing the
  model pulls in the whole app's import chain) and runs on the real machine.
- **Not applied: the 79 `UP045` findings** (`Optional[X]` → `X | None`). The
  `models/` package carries **858** of them and all four sibling
  `benchmark_*.py` files use `Optional` exclusively, so changing only the new
  file would make it the one model that reads differently from its
  neighbours. That is a project-wide convention question, not this change's.

Result: ruff check + format clean on the new files (ignoring that
pre-existing debt), **117 passed, 1 skipped**.

**Static review of the migration**, standing in for the run that needs your
machine: `_seed` guards on table emptiness and `_add_schema_note` on the note
text, so a re-run is a no-op; `set_default` clears then sets inside one
transaction, which the partial unique index requires; `archive` refuses the
current default and `set_default` refuses an archived profile, so the pair
cannot strand the default on a hidden row. Nothing found that changes the
step-2 plan below.

**2026-09-17 (fourth session, on the real machine).** Gating step 2 done,
then merged. Sequence:

1. Re-ran the suite under the real backend venv with `WEBUI_SECRET_KEY` set
   (the import-guard test needs it, and this is also what caught that it was
   missing): **118 passed.**
2. Migration test on a restored copy, never the live volume: brought up the
   real `postgres` compose service (the `open-web-ui_postgres-data` volume),
   `pg_dump`'d it (100 runs, 37 configs, at `b3f8a1d94e70`), then `docker
   compose down` — the live container never ran the new migration. Restored
   the dump into a throwaway `lllm-migration-test` container
   (`pgvector/pgvector:pg16`, port `127.0.0.1:55432`, disposable volume). Ran
   `alembic upgrade head` from a **git worktree** checked out at
   `wip/phase-2a-serving-profiles` (kept out of this branch's working tree on
   purpose, matching the reason this was parked) against that container.
   Result: revision `5a1f0c3e9b27`, 4 profiles, 4 versions, exactly one
   default (`qwen38`), all 100 existing runs with NULL `profile_version_id`,
   the schema note present, seeded `arch`/`alias`/`ngl`/`moe` matching the
   golden profile data exactly. `downgrade b3f8a1d94e70` then `upgrade head`
   again both ran clean, and the re-seed stayed at 4/4 with one schema note
   (no duplication). Cleaned up: throwaway container removed, worktree
   removed, real `postgres` compose service brought back down (it was not
   running before this session either, so nothing changed there); the live
   volume was never written to by anything but its own `pg_dump` read.
3. Merged `wip/phase-2a-serving-profiles` into this branch — clean, no
   conflicts (`git merge`, fast commits since the last common ancestor were
   docs-only on this side). Re-ran the full suite against the merged tree:
   **118 passed.** Pushed.
4. Wrote `launcher.py`, `build_info.py` and `model_name.py` (see the ticked
   checklist items above for what each does and what changed from the plan
   as written — the telemetry-spawn DATABASE_URL design in particular).
   `tests/test_launcher.py` added: 49 tests, all against pure functions or
   `ServeProcess`'s precondition checks, none touching a real llama-server
   or the GPU. Found this session: `ruff` is not in the backend venv (not a
   declared dependency — `pytest`/`pytest-asyncio` aren't either, a
   pre-existing gap this session didn't introduce but did lean on for the
   first time with `pytest-asyncio`, which `test_launcher.py`'s two
   `ServeProcess` tests need) but a global install exists at
   `/home/epittman/dev/envs/py/base/bin/ruff`; used that to check and
   `--fix`/format the three new files (3 auto-fixed `UP041` findings, now
   clean) and to confirm `profiles.py`/`fingerprint.py` are still clean and
   `benchmark_profiles.py`'s 24 `Optional` findings are exactly the ones the
   2026-09-15 session already decided to leave (see that entry above — still
   true, not re-decided). Full suite after: **167 passed.**

5. Wrote `weights.py` (`lllm-fetch` port): `fetch_argv` builds the `hf
   download` argv from a profile's `hf_repo`/`hf_pattern`, targeting the
   resolved model path's own directory (so it follows `LLAMA_MODELS`, never
   `/mnt/c`); `FetchProcess` wraps it in the same start()/lines()/wait()
   shape as `Command`/`ServeProcess` for a future streaming download
   endpoint. 10 new tests, all against the seeded profiles or precondition
   checks, no network access. Full suite: **177 passed.**
6. Wrote `routers/benchmarks/profiles.py` (the profile CRUD router) and
   updated the `BenchmarkConfig` docstring. **Phase 2a is now fully
   checked off** — everything under "2a — Serving layer in the backend"
   above is done. 20 new HTTP-layer tests against a minimal FastAPI app
   with `BenchmarkProfiles` monkeypatched (no real DB). Full suite:
   **197 passed.** All Phase 2a files ruff-clean (using the global
   `/home/epittman/dev/envs/py/base/bin/ruff`, since this venv has neither
   `ruff` nor `pytest`/`pytest-asyncio` as declared dependencies — a
   pre-existing gap, noted twice now, not yet fixed).

6. **Phase 2b, start to finish, same session.** `env_profile.py` rewired
   first (10 tests), then a real gap found while wiring `ServeProcess` into
   its first live caller: it couldn't be drained live and refused to serve
   at all without `DATABASE_URL`. Fixed in `launcher.py` (3 more tests, see
   the ticked Phase 2a `launcher.py` item above) before continuing.
   `tune_schedule.py`'s `config_id_of()` rewired to resolve+fingerprint
   in-process instead of shelling to `lllm-config-id`. `tune_probe.py`'s
   `Server` rewired to serve through `ServeProcess` directly, keeping
   `Command` only for the `LLAMA_TUNE_LAUNCH` fault-injection escape hatch
   (7 tests). `routers/benchmarks/serve.py`'s `/start` rewired last (9
   tests) — the final live call site. Grep sweep for
   `LLAMA_ENV_SH|lllm-|main\.sh` across `apps/` is clean: every remaining
   match is a docstring citing shell line numbers for provenance, nothing
   functional. **Phase 2b is fully checked off.** Full suite: **226
   passed.** All new/touched files ruff-clean via the global ruff at
   `/home/epittman/dev/envs/py/base/bin/ruff`.

**2026-09-18 (fifth session).** Phase 2c done except its GPU-touching exit
criteria. The owner gave explicit in-session permission to edit
`~/.bashrc`, which unblocked the one piece of this phase a repo genuinely
cannot do on its own.

Sequence: wrote the root `Makefile` (`backend`/`frontend`/`help`); ported
`_lllm_openwebui_python`'s venv-bootstrap logic (interpreter-by-version,
stamp file, failed-install cleanup) into the `backend` recipe as a Make
target instead of a shell function; built `DATABASE_URL` in that recipe by
calling `serving/launcher.py`'s existing `build_database_url()` rather than
writing a second percent-encoding site — that function's own docstring
already named this exact caller as the reason it exists. Verified `make
backend` end to end, twice: Postgres up against the real, already-pinned
`open-web-ui_postgres-data` volume; the existing backend venv reused without
a rebuild; uvicorn serving, `/health` 200, `/api/v1/benchmarks/profiles/`
401 (not 500 — confirms DB/auth both work under the Makefile-built URL);
SIGTERM (Ctrl-C's signal) firing the `EXIT` trap, which stopped uvicorn,
then stopped and removed the Postgres container, volume intact afterward.
`make frontend` verified separately: `vite` serving on `:5173`, reachable.

Then deleted `scripts/` entirely (`shell/main.sh`, `shell/vram-log.sh`,
`llama_console.py`), the root `requirements.txt`, and the root `.venv`; and
removed the `~/.bashrc:176` line sourcing the now-gone `main.sh`.

Docs rewritten in the same session: `README.md` (the "Local inference"
section's shell-command references replaced throughout with their current
equivalent — the Serve/Live pages, or explicit past-tense history where the
command genuinely has no replacement yet; a new "Preflight sweeps"
subsection preserves the raw `llama-bench` invocations for the two deleted
sweep commands, per the migration plan's own assumption that they should
survive as documentation even though the commands don't); `MAP.md`; a dated
`docs/CLAUDE.md` decisions entry (also fixed several *pre-existing* prose
sections in that file describing shell commands in the present tense —
those predated this session but were now actively wrong); the ROADMAP pair;
and `docs/model-downloads.md`, which was missing two of the four profiles'
download commands and is now the documented interim replacement for
`lllm-fetch` until Phase 5 adds a UI for it.

**Not done this session, deliberately:** the exit criteria's GPU-touching
half — starting a real `llama-server` from the Serve page, launching a real
Tune candidate, confirming telemetry rows land. Same posture this project
has taken every other time real hardware was on the line (see
`docs/CLAUDE.md`'s 2026-09-06 entry): the owner's permission covered the
`~/.bashrc` edit specifically, not a GPU run, and the two are different
enough in blast radius to ask separately rather than assume one implies the
other.

**2026-09-18 (later, same session).** Owner signed off in-session; the
GPU-touching half ran. Real `qwen25c` load through `ServeProcess` directly
(Serve page's own code path, not the HTTP layer — no admin credentials
this session, and reading the `user` table to mint one was refused by the
auto-mode PII classifier), served correctly, recorded under `config_id
71bc58dd` — the golden value for this profile, now reproduced by an actual
load rather than only by the ported-fingerprint tests — closed clean, GPU
released. One real Tune candidate through `tune_probe.Server` (`qwen25c`,
`LLAMA_THREADS=4`), served correctly under its own predicted `config_id`
(`f04d84af`). A loose end surfaced and then chased all the way down: the
first Tune run's `benchmark_run` row never closed. Two more real runs
isolated the cause as this verification's own cleanup, not the code —
`docker compose down` ran a few seconds after `stop()` returned, inside the
telemetry recorder's own ~3-5s self-close window, killing Postgres
mid-write. Left alone, a Tune candidate's run closes clean every time; no
code change needed.

**Phase 2 is now ✅ done.**

**2026-09-18 (Phase 3, same day, new session).** `apps/web/` scaffolded:
Astro, `@astrojs/react`, Tailwind v4, shadcn/ui (`radix-nova` preset, not
the plan's original "new-york" — that named-style system doesn't exist any
more in the installed CLI; the owner chose to accept the CLI's own current
default over hand-porting Open WebUI's colors onto its newer token model,
see the decisions log). Dark-mode class + `--app-text-scale` ported from
`apps/openwebui/src/app.html`/`app.css`. Dev server proxy mirrors
`apps/openwebui/vite.config.ts` exactly. `make astro` added, working around
a real daemon-vs-foreground quirk in this Astro version's `dev` command
(see the Makefile's own comment). `/next` mounted in `main.py` before the
SPA catch-all, verified against a real build and a real backend boot
(200s all around, SPA fallback included). Vitest + Playwright both wired
with one smoke test each; Playwright hit the same daemon quirk as `make
astro` and needed the same fix plus a belt-and-braces `globalTeardown`.
**Phase 3 is now ✅ done.** Next action: Phase 4 (shared foundation — API
layer, auth, Zustand/TanStack Query, i18n, routing shell, layout/sidebar,
Socket.IO provider).

---

## Context

`epittman23/local-llm` was a thin outer repo (15 tracked files, 30
commits) whose application lived in a pinned git submodule at
`open-web-ui/openwebui` — a fork of Open WebUI v0.11.3 (SvelteKit SPA +
FastAPI backend). The outer repo held operational glue: an 859-line bash
orchestrator, a 242-line telemetry wrapper, a 398-line Rich console
script, a Postgres compose file, and documentation.

Three problems motivate this work:

1. **The submodule split was friction.** Chosen on 2026-09-07 purely for
   `.git` size (the fork's ~420 MB of unrelated history). The cost was
   `--recursive` clones, changes spanning two commit graphs, and a
   "application code lives in the fork, never here" rule drawing a
   boundary through one system. A squash vendor import takes the tree
   without the history. **Resolved in Phase 1.**
2. **The shell layer is a second language in the stack.** `main.sh` holds
   the profile table and llama-server argv assembly, and the Python
   backend shells *back into it* to read them. Migration away from it was
   already underway (`lllm-test`, `lllm-web`, `lllm-report`, `lllm-db`,
   `lllm-tune` retired into the fork on 2026-09-08). **Phase 2.**
3. **The frontend is inherited, not owned.** Upstream's SvelteKit app is
   613 components, ~123k LOC of component code, 65 routes; only ~4.1k LOC
   (Benchmarks) is this project's. The goal is a frontend on Astro +
   React + shadcn/ui. **Phases 3–11.**

**Scope honesty.** Objective 3 is a multi-month rewrite; `chat/` alone is
~46k LOC / 141 components. It is structured as a *strangler-fig*
migration: the SvelteKit app keeps working and keeps being served
throughout, the Astro app grows surface by surface beside it, and a single
cutover retires Svelte. Every phase is independently shippable, which is
what makes pausing safe.

---

## Decisions locked

Answered by the repo owner on 2026-09-14. Do not relitigate without a new
question.

| # | Decision | Choice |
|---|---|---|
| 1 | Frontend scope | **Full migration** of the Open WebUI SvelteKit frontend to Astro, not just Benchmarks. |
| 2 | shadcn flavor | **React islands + canonical shadcn/ui** via `@astrojs/react`. Not shadcn-svelte. |
| 3 | Submodule history | **Squash vendor import.** Full history stays at `epittman23/open-webui` (kept as a read-only archive). |
| 4 | Upstream sync | **Permanent hard fork.** No future upstream merges; vendored tree may be restructured freely. |
| 5 | Shell serving logic | **Into the backend as Python.** `env_profile.py` imports instead of shelling out. |
| 6 | Surviving entry points | **A root `Makefile`**: `make frontend`, `make backend`. |
| 7 | Shell diagnostics | **Surfaced in the Astro UI** on the Serve page; `scripts/llama_console.py` deleted. |
| 8 | Sequencing | **Shell removal right after the monorepo merge**, before any Astro work. |
| 9 | Profile storage | **Postgres**, seeded by an Alembic data migration. |
| 10 | Profile mutability | **Versioned, append-only.** Edits insert a version row; runs reference the version; archive, never delete. |
| 11 | Profile editing | **Full CRUD from the Serve page** (list, create, clone, edit, archive, set default). |
| 12 | Offline path | **Dropped, accepted.** Serving now needs Postgres up; document it in `README.md`. |

### Assumptions requiring confirmation

Stated rather than silently decided; correct at any time.

- **`lllm-fetch`** follows decision 7 into the UI as a "Download weights"
  action on the Serve page, backed by a backend endpoint.
- **`lllm-sweep-threads` / `lllm-sweep-ngl`** are **deleted**. `main.sh`
  already documents them as superseded by Tune and warns against folding
  them into it (llama-bench retains GPU allocations across reloads on
  WSL2). Their raw `llama-bench` invocations get preserved in `README.md`.
- **A profile's `name` is immutable** after creation, with a mutable
  `display_name`. Tuning search spaces are files named after it
  (`benchmarks/data/tuning/qwen38.toml`, each with `profile = "qwen38"`);
  a rename would orphan them. Tuning grids stay as files.

### Derived architecture decisions

- **Astro's role: build framework + static shell + one persistent React
  root.** Open WebUI holds a Socket.IO connection and a persistent
  sidebar; an MPA would tear both down per navigation. Static surfaces
  (`/auth`, `/error`, `/s/[id]`, `/watch`) become real `.astro` pages; the
  app is one `client:only="react"` root running `react-router`.
- **`output: 'static'`**, emitting `dist/index.html` plus static pages,
  dropping into the backend's existing `SPAStaticFiles` mount
  (`backend/open_webui/main.py:3035-3046`, 404 → `index.html` except
  `.js`). Cutover is pointing `FRONTEND_BUILD_DIR` (`env.py:250`) at
  `apps/web/dist/`.
- **The API layer ports nearly verbatim.** `src/lib/apis/**` (30 modules)
  is plain `fetch` + Bearer token against same-origin `/api/v1`
  (`src/lib/constants.ts:10-11`), no Svelte dependency.
- **i18n ports by swapping the binding only.** 65 locale dirs under
  `src/lib/i18n/locales/`; `react-i18next` reads the same JSON.
- **State: Zustand + TanStack Query.** Svelte `writable` stores
  (`src/lib/stores/index.ts`, 389 lines) → Zustand slices; server state →
  TanStack Query.
- **Icons: `lucide-react`**, replacing the 182 SVG-wrapper components.
- **No npm/bun workspace root.** `scripts/prepare-pyodide.js` copies out
  of the fork's own `node_modules/pyodide`; hoisting would break it.
- **A profile version and a `config_id` are orthogonal.** `config_id`
  fingerprints only what is *served*; a profile also carries the HF repo,
  pattern, model path and rationale. Editing those makes a new version
  with the **same** `config_id`, correctly.
- **`benchmark_config` stays untouched.** Its `upsert` is ON CONFLICT DO
  NOTHING by design. Only its docstring changes (it says the fingerprint
  is "computed outside this app").
- **`LLAMA_*` overrides became typed parameters** (`Overrides` in
  `serving/profiles.py`).
- **Benchmarks streams are SSE** (`routers/benchmarks/serve.py:182`,
  `tests.py:138`, `tune.py:181`), consumed by
  `parseBenchmarksEventStream<T>()` (`apis/benchmarks/index.ts:27-63`),
  which ports as-is. Socket.IO is chat/channels only.

---

## Target layout

End state after Phase 11:

```
local-llm/
├── Makefile                   make frontend, make backend, make help
├── README.md
├── MAP.md
├── docs/                      CLAUDE.md, ROADMAP.md, this plan, serving-baseline/
├── infra/
│   └── docker-compose.yml     Postgres + pgvector (project name pinned)
└── apps/
    ├── server/                FastAPI backend, incl. the ported serving layer
    └── web/                   Astro + React + shadcn/ui frontend
```

Gone by the end: `scripts/` (both shell files, `llama_console.py`), the
root `requirements.txt` and `.venv` (they exist only for `rich`).

Current state (Phases 1–10): `apps/openwebui/` holds the whole fork,
backend and SvelteKit frontend together, until Phase 11 deletes the Svelte
side and the rename to `apps/server/` becomes mechanical.

---

## Standing conventions (every commit, every phase)

From `docs/CLAUDE.md`:

1. **Conventional commits, one topic per commit.**
2. **No AI attribution** in commits or PRs — no `Co-Authored-By:`, no
   "Generated with Claude Code". The repo rule overrides tool defaults.
3. **Docs update in the same commit** as the change: `MAP.md` on any
   structural change; `README.md` whenever an entry point's defaults,
   flags or names change; a new dated `docs/CLAUDE.md` decisions entry at
   the top (never edit older entries); `docs/ROADMAP.md` and
   `docs/roadmap-timeline.mmd` together, diagram content byte-identical.
4. **Alembic migrations are append-only.** Never edit an applied revision.
   Add a `benchmark_schema_note` row if what `config_id` covers changes.
5. **Do not document aspirations as facts.**
6. **Branch:** `claude/monorepo-frontend-refactor-gh12a2`.
7. **Update this file** at the end of every session.

---

## Phase 0 — Groundwork and safety net ✅

- [x] Rollback point. Tag pushes are blocked from the cloud container
      (proxy 403 on `refs/tags/*`), so the baseline commit
      `e6164039f2dfc36efd714038539fd28c4230295b` is instead pinned on
      origin by `refactor/monorepo` and `feat/open-web-ui-fork`, which this
      work never touches.
- [x] Pin recorded: `67d4039c30953c2aadf8a814b5dbc50825dca47c` on branch
      `customizations` of `epittman23/open-webui` = upstream `v0.11.3` + 9
      fork commits (listed in `4587d06`'s message).
- [x] Golden fingerprints → `docs/serving-baseline/fingerprints.json`: 24
      cases plus 4 invariants (expected collisions), all holding.
- [x] Profile seed data → `docs/serving-baseline/profiles.json` (with
      `hf_repo`/`hf_pattern` recovered from `_lllm_profile`, `model_path`
      templated as `{LLAMA_MODELS}/...`) and verbatim rationale →
      `profile-rationale.txt`.
- [x] Browser baseline and volume name — confirmed on the real machine.

## Phase 1 — Monorepo merge ✅

- [x] **1a** (`4587d06`) vendor verbatim; `git add -f` needed for
      `backend/data/readme.txt` and `backend/open_webui/data/readme.txt`
      (ignored by the fork's `backend/.gitignore`, force-tracked
      upstream). Nested `.gitignore` files kept.
- [x] **1b** (`d0b6ea2`) Compose `name: open-web-ui` pinned *before* the
      move (verified via `docker compose config` from both directories);
      `apps/openwebui/`, `infra/`; 8 shell path refs; `bun.lock` and
      `CLAUDE.md` un-ignored in the fork; dead root `.gitignore` comments
      corrected; all five docs.
- [x] On-machine verification: volume and data intact (see notes).
- [x] Follow-up fix: backend venv bootstrap (see notes). **Lesson for
      later moves:** gitignored artifacts (`.venv`, `node_modules`) do not
      follow a `git pull` across a rename.

## Phase 2 — Shell removal → Python + Makefile ✅

**Highest-risk phase** because of the fingerprint: every `benchmark_*`
row is keyed by an 8-char `config_id`, and a one-character drift silently
refiles configurations and breaks comparability with history.

### 2a — Serving layer in the backend
`apps/openwebui/backend/open_webui/benchmarks/serving/`

- [x] **`profiles.py`** (`34bc5bc`) — `ServingProfile`, `Overrides`
      (three-valued `spec`: unset / off / replace), `ResolvedConfig`,
      `resolve()` with both guard rails (`--parallel` in a spec override
      raises; MoE flag on dense is dropped with a warning).
      `reasoning_effort_default` models the capability as a field instead
      of substring-matching the baked `--chat-template-kwargs` JSON.
- [x] **`fingerprint.py`** (`34bc5bc`) — six lines + truncated sha1, every
      value newline-terminated. `backend/tests/test_serving_fingerprint.py`:
      79 tests. Also validated against all 37 real `benchmark_config` rows.
- [x] **`models/benchmark_profiles.py`** (`e32202a`, lint-fixed `5a11c0e`,
      merged into this branch) — following `models/benchmark_configs.py`
      conventions (declarative `Base`, Pydantic `*Model` with
      `from_attributes`, `BigInteger` epoch seconds, async `*Table`
      singleton, `benchmark_` prefix):
      - `benchmark_profile`: `profile_id`, `name` (unique, immutable),
        `display_name`, `is_default`, `created_at`, `archived_at`.
      - `benchmark_profile_version` (append-only): `version_id`,
        `profile_id` FK, `version`, `created_at`, `created_by`, `note`,
        and every `ServingProfile` field (`spec`/`samplers`/`extra` as
        JSON), plus `notes` (rationale). Unique `(profile_id, version)`.
- [x] **Alembic revision** `5a1f0c3e9b27` off `b3f8a1d94e70` — creates both
      tables with the `if '<name>' not in tables:` guard, seeds the four
      profiles at version 1 (frozen literal copy of
      `docs/serving-baseline/profiles.json`, `{LLAMA_MODELS}` kept as a
      template and resolved at launch, not baked in), `notes` from
      `profile-rationale.txt`, `qwen38` as default. Adds nullable
      `profile_version_id` FK on `benchmark_run`; existing rows stay NULL.
- [x] Seed-to-fingerprint test: `tests/test_serving_profiles.py::
      test_seed_reproduces_golden_fingerprints` runs the frozen `SEED`
      through `config_id()` and checks it against all 24 golden cases,
      database-free.
- [x] **`launcher.py`** — `lllm-serve`'s argv: `-lv 4`, `--metrics`,
      `--parallel` always, `-fa` vs legacy `--flash-attn 1`, the dense
      partial-offload warning. `ServeProcess` spawns llama-server with its
      stdout/stderr into a server-log tempfile, deleted only after the
      telemetry recorder has had a chance to read it (stop() order:
      server, then recorder, then unlink). **Not exercised against real
      hardware this session** (same posture as the 2026-09-06 decisions-log
      entry for this project's other unattended-GPU-run code) — the pure
      pieces (`build_argv`, `dense_partial_offload_warning`,
      `resolve_model_path`, `telemetry_argv`) are covered by
      `tests/test_launcher.py` against the golden cases, and `ServeProcess`'s
      two precondition checks (missing binary, missing model file) are
      tested directly; the actual spawn-and-tee path is not.
- [x] **`build_info.py`** — `_vramlog_build` (both `--version` spellings),
      tested against both.
- [x] **`model_name.py`** — `_vramlog_split_model`, tested against all four
      seeded profiles' basenames.
- [x] **Telemetry spawn** — `ServeProcess.start()` spawns
      `python -m open_webui.benchmarks.telemetry_recorder` directly (via
      `sys.executable`, not a located venv — the launcher already runs
      inside the backend's own interpreter) as its own process group,
      separate from llama-server's. **Design change from the plan as
      written**: it does *not* re-derive `DATABASE_URL` from
      `POSTGRES_PASSWORD` with `urllib.parse.quote` — it requires
      `DATABASE_URL` to already be correct in the backend process's own
      environment and inherits it, because the backend already builds that
      URL once (whatever ports `lllm-backend`'s percent-encoding fix,
      Phase 2c) and a second encoding site is exactly the kind of drift the
      2026-08-23 decisions-log entries about this same bug warn against.
      `launcher.build_database_url()` (percent-encoding via
      `urllib.parse.quote`, tested) still exists for that Phase 2c caller,
      which has no inherited `DATABASE_URL` yet.
- [x] **`weights.py`** — `lllm-fetch`; targets `LLAMA_MODELS` (via
      `resolve_model_path`'s own resolution), not `/mnt/c` (9p penalty).
      `FetchProcess` follows the same start()/lines()/wait() shape as
      `Command` and `ServeProcess`, so a future "Download weights" endpoint
      (Phase 5) can stream its output the same way. 10 tests against the
      seeded profiles' real `hf_repo`/`hf_pattern` and the precondition
      checks; no network access, nothing actually downloaded.
- [x] **`routers/benchmarks/profiles.py`** — CRUD over the existing
      `BenchmarkProfileTable` (list, get, get-default, list-versions,
      create, clone, add-version/edit, set-display-name, set-default,
      archive, unarchive), all `Depends(get_admin_user)`. Edits go through
      `add_version` (a new row, never an update). `name` changes are
      rejected by construction: `DefinitionForm` has no `name` field, and
      every form is `extra='forbid'`, so a client that includes one gets a
      422, not a silently dropped field. Mounted at `/profiles` in
      `routers/benchmarks/__init__.py`. 20 HTTP-layer tests
      (`test_profiles_router.py`) against a minimal app with
      `BenchmarkProfiles` monkeypatched — status-code mapping (404/409/400)
      and the immutable-name contract, not the model layer itself (already
      covered elsewhere).
- [x] `BenchmarkConfig` docstring (`models/benchmark_configs.py:23-31`) — no
      longer says the fingerprint is "computed outside this app"; it names
      `benchmarks/serving/fingerprint.py` and the 2026-09-14 move.

### 2b — Rewire the backend to import instead of shell out ✅
- [x] `env_profile.py` — `profile_names()`/`profile()` now read
      `BenchmarkProfiles` and resolve through `profiles.resolve()`; `_env_sh()`
      and both subprocess calls are gone. Failure posture kept: a missing
      profile, a database error, or overrides that don't resolve all still
      degrade to `{}` / `[]`, never a 500. `_to_profile_json()` preserves the
      exact `lllm-profile-json` shape (and, deliberately, its stringified
      numeric fields) since `tune_schedule.py`'s `profile_key()`/
      `Grid.violated()` still read this dict by those keys.
- [x] `proc.py` — dropped the `LLAMA_ENV_SH` sourcing requirement; `Command`
      itself is unchanged and kept for `LLAMA_TUNE_LAUNCH` (tune_probe.py's
      fault-injection escape hatch) and any other one-off shell command.
- [x] `routers/benchmarks/serve.py`'s `/start`, `tune_probe.py`'s `Server`,
      and `tune_schedule.py`'s `config_id_of()` all call the launcher
      (`ServeProcess`/`resolve()`/`config_id()`) directly now. Along the way,
      fixed two real defects in `ServeProcess` itself (Phase 2a's tests never
      caught them because they only ever spawned nothing): it sent
      llama-server's stdout straight into the server-log file with no way
      for a caller to read it live, which would have broken Tune's OOM/
      progress parsing and the Serve page's log stream; and it awaited a
      second subprocess (`llama-server --version`) and refused to serve at
      all on a missing `DATABASE_URL`, before returning control to the
      caller — both fixed (`lines()` is now the one drain point, tee'd into
      the log file as it's consumed; telemetry startup is a background task,
      and a missing `DATABASE_URL` sets `telemetry_warning` instead of
      raising). See the `fix:` commit between the two `refactor:` ones.
- [x] `grep -rn "LLAMA_ENV_SH\|lllm-\|main\.sh" apps/` — clean. Every match
      left is a docstring/comment citing shell line numbers for provenance;
      no functional shell-out remains anywhere under `apps/`.

### 2c — Makefile and deletion
- [x] `make backend` reproducing `lllm-backend`: load `infra/.env`;
      `docker compose up -d postgres`; venv bootstrap **porting the
      2026-09-14 fix** (interpreter chosen by version in `>=3.11,<3.13`,
      stamp file, failed install removed); percent-encoded
      `DATABASE_URL`; uvicorn on :4000 `--reload`; Postgres torn down on
      exit **including Ctrl-C**. Make has no EXIT trap: the recipe is
      one shell invocation `trap '... down' EXIT; ...`, and does **not**
      `exec` uvicorn. `DATABASE_URL` is built by calling `serving/
      launcher.py`'s existing `build_database_url()` rather than a second
      percent-encoding site — that function's own docstring already named
      this Makefile as its intended caller.
- [x] `make frontend` — `bun install` if needed, then
      `WEBUI_BACKEND_URL=http://localhost:4000 bun run dev`. Kept the
      `npm ci && npm run dev` fallback in `README.md`. Passes
      `CYPRESS_INSTALL_BINARY=0` to `bun install`.
- [x] Deleted `scripts/` entirely, root `requirements.txt`, root `.venv`.
- [x] **The owner's `~/.bashrc:176` sourced `scripts/shell/main.sh`.**
      Removed, with the owner's explicit permission (given in-session,
      2026-09-18) — the repo cannot edit dotfiles on its own, so this
      needed that permission rather than being done by default.
- [x] `benchmark_schema_note` row only if the fingerprint changes at all:
      not needed — this phase touched no fingerprint-relevant code (the
      Makefile is process lifecycle only), confirmed by `git diff` against
      `apps/openwebui/backend/open_webui/benchmarks/serving/fingerprint.py`
      showing no changes.
- [x] Docs: `README.md` rewritten for `make` (every `lllm-*`/`scripts/
      shell/*` reference replaced with its current equivalent or left
      explicitly past-tense as history); `MAP.md`; dated
      2026-09-18 decisions entry stating `serving/profiles.py` is now the
      source of truth for serving configuration (the profile tables are,
      via Postgres — not `main.sh`, which no longer exists); ROADMAP pair;
      `docs/model-downloads.md` filled in for the two profiles it was
      previously missing, as the interim replacement for `lllm-fetch`.

**Exit criteria:** `scripts/` gone ✅; `make backend`/`make frontend` work
with Postgres torn down on Ctrl-C ✅ (verified this session against the
real, already-pinned Postgres volume — see the 2026-09-18 decisions-log
entry for the exact checks); profiles seeded and resolving ✅ (`/api/v1/
benchmarks/profiles/` returned 401, not 500, under the Makefile-built
`DATABASE_URL`, confirming the DB connection and auth dependency both
work); Serve starts/stops a server ✅ (real `qwen25c` load, `/v1/models`
answered, `config_id 71bc58dd` — the golden value — recorded and closed
clean, GPU released; see the 2026-09-18 (second) decisions-log entry); Tune
launches candidates ✅ (`tune_probe.Server` launched one real candidate,
served correctly under its own predicted `config_id`); telemetry rows
written ✅ for both. `config_id` from seeded rows equalling every golden
value was already verified in Phase 2a and nothing in 2c touches the
fingerprint, so it was not re-run — but the Serve run above reproduced one
golden id from a real load, which is closer to this criterion's intent than
the existing golden-value tests alone.

**A loose end chased down, not a bug.** The first Tune verification run's
`benchmark_run` row was left with `ended_at IS NULL`; a forced repro
confirmed the cause was this verification's own cleanup, not
`tune_probe.Server.stop()` or the recorder: `docker compose down` ran a
few seconds after `stop()` returned, inside the telemetry recorder's own
~3-5s self-close window (it detects a dead port after `MISS_LIMIT=3`
failed probes), killing Postgres mid-write and crashing the recorder with
`psycopg.errors.AdminShutdown` before it reached `close_run()`. Left alone
— confirmed with a clean re-run, Postgres untouched — a Tune candidate's
run closes clean in about 4s every time. See the 2026-09-18 (second)
decisions-log entry for the full repro.

Phase 2 is now ✅ done.

## Phase 3 — Astro + React + shadcn scaffold, dual-serve ✅
- [x] `apps/web/`: Astro, `output: 'static'`, `@astrojs/react`, TS strict
      (`astro/tsconfigs/strict` + `@/*` path alias for shadcn's imports).
- [x] Tailwind v4 via `@tailwindcss/vite`. **Deviated from "port `@theme`
      tokens from `apps/openwebui/src/tailwind.css` onto shadcn token
      names"**: the shadcn CLI installed here (v4.21.0) has moved past
      named styles to bundled presets (colors + icons + fonts together),
      so there was no "new-york style, then swap in our own colors" path
      left to take. Given the choice between hand-porting Open WebUI's
      gray scale onto this CLI's newer token model or accepting its own
      current default, the repo owner chose the latter (Nova). See the
      2026-09-18 decisions-log entry.
- [x] `shadcn init`. **Deviated from "new-york, CSS variables,
      tw-animate-css"** for the same reason: `style: "radix-nova"` (CSS
      variables still on, `tw-animate-css` still installed and imported —
      those two survived; only the named style did not).
- [x] Dark mode (`class` on `<html>`) and the `--app-text-scale` variable —
      `src/layouts/Base.astro`, an inline anti-FOUC script mirroring
      `apps/openwebui/src/app.html`'s own (same `localStorage.theme` key)
      and a `:root { --app-text-scale: 1 }` declaration. The theme-picker
      UI itself is Phase 4, not this.
- [x] Dev server :5174 proxying `/api`, `/ollama`, `/openai`, `/oauth`,
      `/ws` → :4000 (mirror `apps/openwebui/vite.config.ts`, `ws: true`) —
      `astro.config.mjs`'s `vite.server.proxy`, `WEBUI_BACKEND_URL` to
      override, same variable name the SvelteKit dev server already reads.
- [x] `make astro`. **A real wrinkle found and handled**: this Astro
      version's `astro dev` always daemonizes — even without `--background`,
      the CLI wrapper exits almost immediately once the real server is up,
      leaving nothing in the foreground for Ctrl-C to reach. The recipe
      starts it explicitly backgrounded, then blocks on `astro dev logs
      --follow` (a real foreground process) with a trap running `astro dev
      stop` on exit. See the Makefile's own comment on the `astro` target.
- [x] `/next` preview mount in `main.py`, before the SPA catch-all — a new
      `NEXT_BUILD_DIR` in `env.py` (defaults to `apps/web/dist`), mounted
      via the existing `SPAStaticFiles` (same 404→index.html fallback the
      SvelteKit mount uses, so client-side deep links work). Verified
      against a real build and a real backend boot: `/next/` 200, a
      `/next/_astro/*` asset 200, a deep link 200 via the SPA fallback,
      and the SvelteKit app's own (pre-existing, unrelated) 404 unchanged.
      Needed `base: '/next'` in `astro.config.mjs` for the build only
      (dev stays unprefixed) — set via `process.argv.includes('build')`,
      not `defineConfig`'s own `({ command }) => (...)` form, which
      reproducibly broke `@import 'tailwindcss'` resolution in this
      astro/vite combination (`ENOENT ... open '.../tailwindcss'`) for
      reasons not chased further than confirming the plain object form
      doesn't hit whatever code path that was.
- [x] Vitest + Playwright; one smoke test — one of each, actually: a Vitest
      + React Testing Library render test (`src/components/App.test.tsx`)
      and a Playwright test (`e2e/smoke.spec.ts`) against the real dev
      server. Playwright's `webServer` hit the same daemon issue `make
      astro` did (`Error: Process from config.webServer exited early`),
      fixed the same way, plus a `globalTeardown` that force-stops the
      daemon afterward regardless — a clean run was observed leaving it
      alive even after Playwright's own teardown reported success, so the
      signal-based path alone isn't trusted.
- [x] Docs — this entry, `apps/web/README.md`, `MAP.md`, `README.md`, the
      ROADMAP pair, and a dated `docs/CLAUDE.md` entry for the two
      deviations above.

## Phase 4 — Shared foundation
- [ ] API layer copied from `src/lib/apis/**`; keep
      `parseBenchmarksEventStream` unchanged.
- [ ] Auth: `localStorage.token` bootstrap, 401 handling in a fetch
      wrapper, `expires_at` timer, sign-out clears token **and** cookie
      (prevents an OAuth redirect loop), route gate.
- [ ] Routing shell `src/pages/[...path].astro` + `react-router`, with a
      `LegacyRedirect` fallback to the SvelteKit app.
- [ ] Zustand slices; TanStack Query for server lists.
- [ ] i18n (65 locales unchanged, `react-i18next`).
- [ ] `lucide-react` icon mapping recorded in a file.
- [ ] Layout + sidebar (58 components) on shadcn `Sheet`, `DropdownMenu`,
      `Tooltip`, `ScrollArea`.
- [ ] Socket.IO provider, stable across navigation.
- [ ] `common/` → shadcn mapping recorded (keep custom: CodeMirror,
      TipTap, PDF/docx/pptx previews, emoji picker, pan/zoom, Valves).

## Phase 5 — Benchmarks surface
- [ ] Gate: admin **and** `features.enable_benchmarks !== false`.
- [ ] Serve (+ health, GPU telemetry, profile list, download weights).
- [ ] **Profiles panel** — CRUD + version history rendering `notes`;
      `name` visibly read-only.
- [ ] Live (polls — `refetchInterval`; Kill → `AlertDialog`).
- [ ] Tests (SSE). Compare (`Table` + TanStack Table). Report.
- [ ] Answers — build a minimal transcript renderer; do **not** port
      `chat/Messages.svelte` for it.
- [ ] Tune (SSE status is a full-object re-send every ~2s; diff, don't
      append).
- [ ] Playwright per page.

## Phase 6 — Public/static surfaces
- [ ] `/auth` (incl. OAuth callback token handling), `/error`, `/s/[id]`
      (read-only React island), `/watch`.

## Phase 7 — Workspace (48 components, ~13.3k LOC)
- [ ] Models, prompts, knowledge (RAG upload), tools (CodeMirror), skills,
      functions create.

## Phase 8 — Admin (63 components, ~23.3k LOC)
- [ ] Layout + URL-driven `[tab]`, settings, users/groups, evaluations,
      functions, analytics (`chart.js`).

## Phase 9 — Secondary surfaces
- [ ] Notes (TipTap), calendar, automations, playground, channels (first
      Socket.IO consumer), folders, home.

## Phase 10 — Chat (141 components, ~46k LOC)
- [ ] Markdown pipeline → input (TipTap) → streaming → attachments →
      controls → artifacts/Pyodide/tool calls → chat management →
      Playwright end-to-end.

## Phase 11 — Cutover and Svelte removal
- [ ] `FRONTEND_BUILD_DIR` → `apps/web/dist/`; remove `/next`.
- [ ] Delete the SvelteKit frontend from `apps/openwebui/` (verify
      `/static` usage at `main.py:2992` first).
- [ ] Repoint or remove frontend build hooks in `pyproject.toml` /
      `Dockerfile`.
- [ ] Rename `apps/openwebui/` → `apps/server/`; fold `make astro` into
      `make frontend`.
- [ ] Licensing: the ≤50-user exemption (clause 4(i)) permits the rebranded
      UI; `LICENSE`, `LICENSE_NOTICE`, `LICENSE_HISTORY` and copyright
      notices stay (clauses 1–3).
- [ ] Final docs pass.

---

## Verification

- **Per session:** backend + frontend start; log in; compare a migrated
  surface in the new app against the old.
- **Automated:** `backend/.venv/bin/python -m pytest backend/tests` (from
  `apps/openwebui/`); later `bun run test` and `bunx playwright test` in
  `apps/web/`.
- **Data safety:** `docker volume ls` must keep showing
  `open-web-ui_postgres-data`. A *new* empty volume means stop.
- **Fingerprint:** golden tests green; periodically re-run the 37-row
  check against the live `benchmark_config` table (read-only query).
- **Migrations:** only ever tested against a throwaway container.

---

## Key facts

- **Scale.** Fork: 5,110 files. `src/` components ~123k LOC: `chat/`
  45,989 (141) · `admin/` 23,272 (63) · `workspace/` 13,330 (48) ·
  `common/` 12,120 (62) · `layout/` 10,601 (58) · `channel/` 4,658 (17) ·
  `icons/` 3,834 (182) · `benchmarks/` 2,988 (7).
- **Fork-owned code** is only Benchmarks: `backend/open_webui/benchmarks/`,
  `routers/benchmarks/`, `models/benchmark_*.py`, migration
  `b3f8a1d94e70`, `src/lib/apis/benchmarks/`, `src/lib/components/benchmarks/`,
  `src/routes/(app)/benchmarks/`, plus small edits to `main.py`,
  `routers/auths.py`, `Sidebar.svelte`, `UserMenu.svelte`.
- **Shell → backend coupling (Phase 2 removes).** Via `LLAMA_ENV_SH`:
  `env_profile.py` (`profile-names`, `profile-json`), `proc.py`,
  `tune_schedule.py`, `serve.py:116` and `tune_probe.py:109` (both build
  `lllm-serve <profile>` strings). `vram-log.sh` sources `main.sh`;
  `lllm-config-id` sources `vram-log.sh` in a subshell (recursion guard in
  `main.sh`'s dispatch block).
- **Fingerprint:** `sha1(alias + "\n" + six lines each + "\n")[:8]`;
  excludes build string, `--metrics`, `-lv`. Parsed back by
  `stats.py:parse_config_text`.
- **Schema conventions:** see `models/benchmark_configs.py`; migrations
  guard with `if '<name>' not in tables:`; no SQL views (Python group-bys
  instead); `benchmark_schema_note(note_id, noted_on, note unique)`.
- **Python:** fork requires `>= 3.11, < 3.13`; upstream Dockerfile uses
  3.11. On the owner's machine interactive `python3` is linuxbrew 3.14;
  `/usr/bin/python3.12` works.
- **Auth:** `localStorage.token` + Bearer; no SSR, no server session.
- **Existing UI stack:** Svelte 5.53, Tailwind v4, `bits-ui` in only 8
  files — no primitive layer to build on.

---

## Resume protocol

Start of session:
1. Read the Status board and Current session notes above.
2. `git log --oneline -10` — the board can lag the repo.
3. `git status` for uncommitted work.
4. Work the first phase not `✅ done`, in checklist order.

End of session:
1. Tick completed items; update Status and Last touched.
2. Overwrite Current session notes: done, half-done, the single next
   action.
3. Commit this file with the work (conventional commit, no AI
   attribution) and push.

A phase is not `✅ done` until its exit criteria are verified, not merely
implemented.
