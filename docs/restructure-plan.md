# Repository restructure plan

## Context

`local-llm` holds a single-user assistant. `apps/server/` began as a hard fork of
Open WebUI v0.11.3 and is now owned code with no upstream path; `apps/web/` is
the Astro + React frontend that replaced the fork's SvelteKit app. The repo
still reads as "a fork plus glue": two READMEs and three agent guides, upstream
community files, a `backend/` level that only existed for upstream's Docker
layout, an `open_webui` package name, `WEBUI_*` variables and Open WebUI
branding. This plan makes it one coherent project: docs and agent instructions
consolidated at the root, unused files removed, licenses at the root,
`backend/` flattened, the package renamed to `local_llm`, runtime identifiers
and branding renamed, benchmark code organized, and a `make check` that
predicts CI.

On approval this file is copied to `docs/restructure-plan.md` (Phase 0) and its
**Status** section (end of file) is updated after every phase; it is the
durable record to re-read before each phase. At the end it moves to
`docs/history/`.

---

## 1. Decisions (asked and answered before writing)

| # | Question | Decision |
|---|---|---|
| Q1 | Package / distribution name | `local_llm` / `local-llm` |
| Q2 | Product display name | **Local LLM** |
| Q3 | Env-var prefix | `LLLM_` (clean break, no fallback to old names) |
| Q4 | Postgres role and database | Rename both to `local_llm` |
| Q5 | CHANGELOG mechanism | Remove it entirely (file, parser, endpoint, client function) |
| Q6 | `backfill_from_sqlite.py` | Delete (with the `benchmarks/scripts/` package) |
| Q7 | Locales | Keep only `en-US`; remove the Language picker |
| Q8 | Community hub | Remove all: share-to-hub, hub import, "Made by Community" links, the `enable_community_sharing` setting and the endpoints it gates |
| Q9 | Upstream I/O | Remove: GitHub update check, license server + `CUSTOM_NAME`, OpenRouter attribution headers, Discord/X/GitHub links. **About tab keeps its license and copyright lines.** |
| Q10 | Unused-integration phase (old Phase 9) | **Dropped.** No inventory, no removal |
| Q11 | Benchmark sub-grouping | Yes: `serving/`, `evaluation/`, `analysis/`, `tuning/` + `benchmarks/paths.py` |
| Q12 | Delivery | One PR per phase; a phase with more than one topic gets one PR per topic (see §2, item 14) |
| Q13 | Compose volume | Fresh `local-llm_postgres-data` (deviation from the prompt: no volume pin; see §2 item 2) |
| Q14 | `CONTRIBUTOR_LICENSE_AGREEMENT` | Move to root beside `LICENSE` (LICENSE's text names it) |
| Q15 | Applied migrations that import `open_webui` | Edit the **import lines only** (deviation from "never edit an applied migration"; proven schema-neutral, see Phase 4) |
| Q16 | May root README/AGENTS name the original project? | Yes, one provenance line each, pointing at `NOTICE` |

Defaults I chose without asking (say if you disagree):

- **Migration-era mapping docs** (`COMMON_MAPPING.md`, `icons/MAPPING.md`) move to `docs/history/`, since `migration-plan.md` cites them.
- **Version stays `0.11.3`.** The About tab shows it, and community plugins' `required_open_webui_version` checks compare against it.
- **`DATA_DIR` is pinned in the Makefile to `apps/server/data`.**
- **The venv moves to uv's default, `apps/server/.venv`.**
- **pyproject metadata:** `authors` becomes `epittman23` (no email); `description` becomes "Local LLM backend"; `readme` is dropped; `license` becomes `{ text = "See LICENSE and NOTICE at the repository root" }`.

---

## 2. Where the prompt and the repository disagree (the code wins)

1. **`infra/.env` does not exist on this machine.** Neither does `.claude/settings.local.json`, `logs/` or `tests/data/`. So `make backend` cannot run as-is. For the "real run" check I use a **scratch boot** instead (procedure S, §7): uvicorn against a throwaway pgvector container with a dummy secret. You still do the full `make backend` smoke test once you create `infra/.env` (§8).
2. **There is no `open-web-ui_postgres-data` volume on this machine.** `docker volume ls` shows no such volume; the database didn't come across in the 2026-10-09 move. Two consequences:
   - "Existing Postgres data stays attached" has nothing to protect locally.
   - You chose a fresh volume name, which means data arrives by `pg_dump` restore. §8 has the restore commands, and also the rename SQL for the case where you reuse an old cluster.
3. **More backend files than the prompt lists:** `backend/start.sh` and `backend/start_windows.bat` (upstream container and Windows entry points) are tracked and dead. Both are added to the deletion manifest.
4. **`CHANGELOG.md` is not displayed by the frontend.** `getChangelog()` in `apps/web/src/lib/apis/index.ts` has no callers. But deleting the file alone makes `env.py` crash at import: the `pkgutil.get_data` fallback raises. The parser has to go in the same commit as the file.
5. **`open_webui/__init__.py` cannot be deleted.** It runs on every import of the package. Its typer CLI (`serve`/`dev`) is dead, and `typer` is not even a declared dependency (it arrives transitively). So the CLI is removed and the file shrinks to a docstring.
   - The CLI is the only thing that sets `FROM_INIT_PY`. The `env.py` branch it guards copies `DATA_DIR` and then `shutil.rmtree`s it, which is a latent data-loss path once `DATA_DIR` moves. That branch is deleted.
6. **`pyproject.toml` names files this work moves:** `readme = "README.md"` and `license = { file = "LICENSE" }`. The hatch wheel config (`sources = ["backend"]`, the CHANGELOG force-include, excludes for `dev.sh`/`start.sh`) also refers to moving files. Each is fixed in the commit that moves its file, followed by `uv lock --check`.
7. **The package name is persisted in the database, in two forms:**
   - **Stored plugin code.** `utils/plugin.py`'s `replace_imports` rewrites stored Tool and Function source to `from open_webui.*` and saves it back. A restored database's plugins would break after the rename. Fix without a migration: extend that same rewrite map so `open_webui.` becomes `local_llm.`. Stored source is then fixed on its next load (Phase 5b).
   - **`open_webui:code_interpreter`**, a chat-output item type stored in chat history and matched by `apps/web/src/lib/chat/structuredOutput.ts`. **It stays as-is** (allowlisted).
8. **Persistent config is keyed by dotted config path, not by env-var name.**
   - `models/config.py`: `Config.key`, for example `webui.url`, `ui.banners`. Env vars only seed first-run defaults (`Config.seed_defaults` inserts missing keys only). Renaming env vars therefore changes nothing for an existing database.
   - **Not touched by the env rename:**
     - The historical migration `3ff2c63645b8_reshape_config_to_per_key_rows.py`. Its `BLOB_PATH_TO_KEY` maps `WEBUI_URL`/`WEBUI_BANNERS` as data keys.
     - `WEBUI_URL` as an HTTP field. It is also the admin-config API field that `routers/auths.py` and `admin/settings/General.tsx` exchange.
   - `WEBUI_SECRET_KEY` is used by **value** only (JWT, session middleware, valve/OAuth encryption), so renaming the variable while keeping the value invalidates nothing.
9. **`required_open_webui_version`** is a plugin frontmatter key that community plugins carry. It stays (allowlisted).
10. **Provenance comments `d863707:apps/openwebui/...`** (61 matches, 56 files) are git paths that `git show` resolves. Rewriting them would break them, so they stay (allowlisted).
11. **Locales: there are 64, not 65.** That is 64 locale directories plus `languages.json`; `MAP.md` and `i18n/index.ts` both say 65.
12. **There are about 25 citations of `docs/migration-plan.md` in code and config, not about 20.** That includes two that are wrapped across lines: `ServePage.tsx:43-44` (`docs/migration-` / `plan.md`) and `:46-47` (`docs/model-` / `downloads.md`), which a plain grep misses.
13. **Flattening fails silently in three places unless the `env.py` chain is rewritten:**
    - `VERSION` falls back to `0.0.0`.
    - `FRONTEND_BUILD_DIR` points at a nonexistent `<repo>/web/dist`, so `/` stops serving the app with no error.
    - `DATA_DIR` moves.

    Also: five tests use `parents[4]` and `test_version.py` uses `parents[2]`, and `benchmarks/grading/__init__.py` locates the grader interpreter at `BACKEND_DIR/.venv`. Phase 3 covers all of these and adds a test pinning the paths.
14. **Squash merges vs. "one topic per commit".** `main` is squash-merged, so each PR becomes one commit. Where the prompt's phase holds more than one topic (Phases 2, 5, 6, 7), I open one PR per topic, still stopping for your confirmation only at the end of each phase. The package-rename PR has to be its own squash so that its SHA can go into `.git-blame-ignore-revs`.
15. **Open Dependabot PRs #49-#51** edit `apps/server/pyproject.toml` and `uv.lock` and will conflict with Phases 2-4. Recommend merging or closing them before Phase 2; Dependabot rebases any reopened ones itself.
16. **Applied migrations import the package** (5 lines in `7e5b5dc7342b_init`, `a1b2c3d4e5f6`, `f1e2d3c4b5a6`). Resolved by Q15.
17. **The root `.gitignore`'s unanchored `tests/data/`** would start matching `apps/server/tests/data/` after the flatten. The directory it was for is gone, so the rule is deleted (the maintenance policy's "prune what is no longer true").
18. **Two docs carry the original name for test or hash reasons and must not be edited:**
    - `docs/serving-baseline/profile-rationale.txt` is test input.
    - `benchmarks/data/prompts/*` are system prompts identified by a sha of their exact bytes.

    Both are allowlisted. `adapter_sha` and `system_sha` hash content, not paths, so moving these files is safe.
19. **Pre-existing bug, out of scope:** `routers/users.py:875,887` serve `STATIC_DIR/user.png`, but that file is never copied into the static dir. It is reported here and not fixed in this work.
20. **Not in the target layout:** `docs/model-downloads.md`, which moves to `docs/guides/model-downloads.md`.
21. **The only accurate, undocumented fact in `apps/server/README.md`** is offline mode. `make backend` sets `HF_HUB_OFFLINE=1`, so the embedding and reranking models must already be in the HF cache. It moves to `docs/guides/dependencies.md` and gets one line in AGENTS.md.

---

## 3. Content-accounting table

New files. `AGENTS.md` (root; `CLAUDE.md` is a symlink to it) holds conventions and policy. `README.md` (root) is the run guide. `docs/decisions.md` holds the decisions log. `docs/guides/` gets:

| Guide | Topic |
|---|---|
| `llama-cpp.md` | Building and serving |
| `telemetry.md` | Recorded telemetry |
| `benchmarks.md` | The Benchmarks section |
| `testing.md` | App test suites |
| `dependencies.md` | Backend environment |
| `frontend.md` | apps/web |
| `model-downloads.md` | Weight downloads |

"→ X §Y" means the content moves to file X under heading Y. While moving, any `apps/server/backend/open_webui` path inside moved text is updated to the path that is current at that phase. Stale statements I found are fixed, not carried over: README:376 "planned for Phase 5", :955-958 `lllm-sweep-threads`, :882/:902 `lllm-serve`, and CLAUDE.md:42-45 "now that there's no backend".

### docs/CLAUDE.md (2,384 lines)

| Section (lines) | Destination |
|---|---|
| `# Personal AI Assistant Project` (1) | → AGENTS.md title "local-llm: agent and contributor guide", plus the provenance line |
| Why (3-9) | → AGENTS.md §Why (verbatim) |
| Current phase (11-30) | → AGENTS.md §Current phase, condensed to current facts (OpenRouter is the default; local llama-server on :8090 is under evaluation and not the default until throughput is acceptable); shell-layer history dropped (it is in the 2026-09-18 log entry) |
| Models in use (32-61) | → AGENTS.md §Models in use. The maintenance policy points here. Fix the stale `REASONING_MODEL_ALT` sentence and add the missing `qwen38` entry from README:279-325 |
| Local inference (63-137) | → AGENTS.md §Local inference, about 20 lines: hardware, the four profiles in one line each, where profiles live, which pages serve, test and compare. Details that duplicate README:227-1160, where README is more complete, → guides/llama-cpp.md and guides/telemetry.md. The "~7-8 t/s" claim gains the "historical, WSL2, build 10472" caveat it lacks here |
| Migration plan (for future reference) (139-146) | → AGENTS.md §Moving to self-hosted hardware (renamed so it doesn't collide with history/migration-plan.md); the concrete steps stay in README §Migrating to local hardware |
| Conventions (148-222) | → AGENTS.md §Conventions, rewritten for the new layout: the monorepo rule, the "Makefile stays thin" rule, serving config's single source of truth, the testing approach (detail → guides/testing.md), model and system-prompt config living in the app, and the benchmark-prompt copy rule. Submodule and `scripts/` history dropped (2026-09-14 / 2026-09-18 log entries) |
| Commands (224-248) | → AGENTS.md §Commands (make targets including `make test`/`lint`/`check` after Phase 8; `infra/.env` keys; tool requirements) |
| Maintenance policy (250-311) | → AGENTS.md §Maintenance policy, every rule re-pointed (see Phase 1) |
| Commit policy (313-315) | → AGENTS.md §Commit policy, same rule; the typo "incudes" is fixed |
| Decisions log (317-2384) | → docs/decisions.md, **byte-for-byte** (heading, preamble bullet and every entry). Phase 10 adds one new entry at the top of the list |

### README.md (1,628 lines)

| Section (lines) | Destination |
|---|---|
| Title and intro (1-18) | → README.md §overview, rewritten: what it is, one provenance line → NOTICE, links to AGENTS.md and the guides |
| Running it (19-99) | → README.md §Running it (kept; contract). Changes: requirements; `infra/.env` with the `LLLM_` names; `make backend`/`frontend`/`check`. The 2026-09-27 and 2026-09-14 upgrade notes are dropped (both in the decisions log); the WSL2 note is replaced by an "Upgrading an existing checkout (restructure)" note: DATA_DIR move, venv, `.env` renames. The SQLite-volume paragraph is dropped (`open-web-ui_open-webui` volume, history) |
| Pages and URLs (100-204) with Public / Signed-in / Anything else / Backend URLs | → README.md §Pages and URLs (kept; contract), updated for removed routes or behaviour (hub import is gone, so the `/create` notes change) and for the Postgres user/db `local_llm` |
| Model setup (205-226) | → README.md §Model setup (kept: the model entries and the exact prompt text are referenced by AGENTS.md conventions) |
| Local inference intro (227-234) | → guides/llama-cpp.md intro |
| Building llama.cpp (235-259) | → guides/llama-cpp.md §Building llama.cpp |
| Serving (260-387) | → guides/llama-cpp.md §Serving (profile table, per-profile rationale, the `--parallel 1` pitfall, old-command→page table) |
| Preflight sweeps (388-433) | → guides/llama-cpp.md §Preflight sweeps |
| Benchmarks overview filed under it (434-483) | → guides/benchmarks.md §The pages |
| Recorded telemetry and throughput (485-525) | → guides/telemetry.md §How it is recorded |
| The tables (526-564) | → guides/telemetry.md §The tables |
| What identifies a configuration (565-633) | → guides/telemetry.md §What identifies a configuration |
| Reading it back (634-691) | → guides/telemetry.md §Reading it back |
| Reading the numbers (692-788) | → guides/telemetry.md §Reading the numbers |
| Crash durability, and the active run (789-835) | → guides/telemetry.md §Crash durability |
| Hardware and model (836-851) | → guides/llama-cpp.md §Hardware and model |
| Verifying the server (852-865) | → guides/llama-cpp.md §Verifying the server |
| Measurement: qwen38 + MTP (866-934) | → guides/llama-cpp.md §Measurements (marked historical, WSL2) |
| Benchmark: thread-count sweep (935-959) | → guides/llama-cpp.md §Measurements (historical, build 10472) |
| Testing intro (960-994) | → guides/benchmarks.md §Correctness, not just speed |
| Commands (995-1016) | → guides/benchmarks.md §Page actions |
| System prompts (1017-1116) | → guides/benchmarks.md §System prompts |
| The benchmarks / Tiers / Grading / Calibrating (1117-1246) | → guides/benchmarks.md, same headings (the Grading code-execution warning keeps its own heading so README's Pages table can link to it). The split "Measured on…" intro at 1209 is re-joined to its table |
| Where results are stored (1247-1319) | → guides/benchmarks.md §Where results are stored |
| Comparing (1320-1370), Reporting (1371-1491) | → guides/benchmarks.md, same headings |
| Dependencies (1492-1550) | → guides/dependencies.md (+ HF_HUB_OFFLINE, DATA_DIR pin). The `requirements-extra.txt` / root `.venv` / Textual history paragraphs are dropped (2026-09-08 and 2026-09-18 log entries) |
| The Benchmarks section (1551-1603) | → guides/benchmarks.md §Architecture (same app and process; port table; recorder is a subprocess and why). The Caddy, userscript, stdlib-only-rule and `lllm-web` retirement paragraphs are dropped (2026-09-07 and 2026-09-08 entries) |
| Migrating to local hardware later (1604-1613) | → README.md §Migrating to local hardware (kept) |
| License (1614-1628) | → README.md §License, 4 lines pointing at LICENSE / LICENSE_HISTORY / NOTICE; the clause 4(i) text lives in NOTICE |
| Internal cross-refs (:26, 48, 97, 200, 232, 267, 323, 377, 441, 482, 807, 1056, 1368, 1506, 1542, 1554, 1572, 1600) | Rewritten as relative links to the new guide headings |

### apps/web/README.md (135 lines)

| Section | Destination |
|---|---|
| Intro (1-7), incl. the `d863707` provenance explanation | → guides/frontend.md intro (provenance explanation kept: it says how to read the comments) |
| Running it (9-24) | → README §Running it (one line) + guides/frontend.md §Dev server; the daemonizing caveat → AGENTS.md §Frontend |
| Building it (26-32) | → guides/frontend.md §Building |
| Testing (34-71) | → guides/testing.md: web (Vitest, Playwright, astro check, Biome, workers=2) and backend (pytest, `TEST_DATABASE_URL`, throwaway pgvector). The one-line summary of each → AGENTS.md §Commands |
| Known rough edges (73-90) | → guides/frontend.md §Known rough edges ("English only" updated: other locales removed) |
| Structure (92-135) | → MAP.md `apps/web/` (already covers every line; adds the two it lacks: `styles/global.css`, `lib/emoji`). The tree itself is dropped as a duplicate of MAP |

### apps/web/AGENTS.md (22 lines) and its `CLAUDE.md` symlink

| Section | Destination |
|---|---|
| Development (`astro dev --background`, stop/status/logs) | → AGENTS.md §Frontend (apps/web), merged with the daemonizing and Node-not-Bun caveats |
| Documentation (Astro doc links) | → AGENTS.md §Frontend, the same six links |

### apps/server/README.md (267 lines, discarded)

| Section | Destination |
|---|---|
| "In this repo" note (1-5) | Dropped; MAP.md covers the layout |
| Title, badges, demo.png, Key Features, ecosystem, sponsors (7-110) | Dropped: upstream marketing. Features that exist here are already listed in README §Pages and URLs; several claims are false here (calls, PDF export, 9 vector DBs, i18n) |
| Install via pip, Docker, other methods, troubleshooting, Docker updates, dev branch (112-228) | Dropped: wrong for this repo (no image, no pip install, no upstream sync) |
| **Offline Mode (230-236)** | → guides/dependencies.md §Offline model cache + one AGENTS.md line. **The only accurate, undocumented item** |
| What's Next, Support, Security, Star history, credits (238-267) | Dropped (upstream); attribution lives in NOTICE |
| License (242-244) | Superseded by NOTICE |

### Other docs

| File | Destination |
|---|---|
| `docs/model-downloads.md` | → `docs/guides/model-downloads.md` (links fixed; "planned for Phase 5" corrected) |
| `docs/proposed-inference-server.md` | → `docs/proposals/` (unchanged except one table cell, "Frontend: Open WebUI" → "Local LLM (apps/web)", in Phase 6c) |
| `docs/migration-plan.md`, `bug-review-2026-09-27.md`, `code-review.md` | → `docs/history/` (verbatim) |
| `apps/web/src/components/COMMON_MAPPING.md`, `apps/web/src/lib/icons/MAPPING.md` | → `docs/history/common-components-mapping.md`, `docs/history/icons-mapping.md` (verbatim) |
| `docs/ROADMAP.md`, `roadmap-timeline.mmd` | Stay; references re-pointed (`CLAUDE.md` → decisions.md / AGENTS.md; `docs/code-review.md` → `docs/history/code-review.md` in **both** files, kept byte-identical) |
| `docs/serving-baseline/README.md` | Stays (the only README besides root; it documents test fixtures) |

---

## 4. Deletion manifest

References come from `git grep -n` over tracked files. "Docs only" means only `MAP.md` or README lines mention the file, and those lines are rewritten in the same PR. Verdicts follow your answers.

### 4a. Original-project files

| Path | Why a candidate | References | Verdict |
|---|---|---|---|
| `apps/server/CODE_OF_CONDUCT.md` | upstream community file | none | **delete** |
| `apps/server/CONTRIBUTOR_LICENSE_AGREEMENT` | upstream CLA | named in `LICENSE:40` (verbatim legal text) | **keep, move to root** (Q14) |
| `apps/server/TROUBLESHOOTING.md` | Docker/Ollama troubleshooting | `MAP.md:126` | **delete** |
| `apps/server/docs/SECURITY.md` (and the now-empty `docs/`) | upstream security policy | `MAP.md:123` | **delete** |
| `apps/server/banner.png` | upstream marketing image | none | **delete** |
| `apps/server/demo.png` | upstream marketing image | `apps/server/README.md:23` only (also deleted) | **delete** |
| `apps/server/README.md` | upstream README | `pyproject.toml:159` `readme =` (field dropped); `MAP.md:113`; `README.md` | **delete** (Phase 1; contents accounted for in §3) |
| `apps/web/AGENTS.md`, `apps/web/CLAUDE.md` (symlink) | merged into root AGENTS.md | none | **delete** (Phase 1) |
| `apps/web/README.md` | merged | `README.md:88`, `docs/CLAUDE.md:203`, `MAP.md:186` | **delete** (Phase 1) |

### 4b. Tooling remnants

| Path | Why | References | Verdict |
|---|---|---|---|
| `apps/server/.env.example` | describes Ollama and SvelteKit; `env.py` never reads it | `apps/server/.gitignore:5` (`!.env.example`) | **delete**; replaced by new `infra/.env.example` (Phase 6b, with the final `LLLM_` names; Phase 2 adds it with the current names) |
| `apps/server/backend/dev.sh` | superseded by `make backend` | `pyproject.toml:217` (wheel exclude) | **delete** |
| `apps/server/backend/start.sh` | upstream container entrypoint (not in the prompt's list) | `pyproject.toml:218`; `env.py:776` error message | **delete**; message reworded to "set LLLM_SECRET_KEY in infra/.env" |
| `apps/server/backend/start_windows.bat` | Windows entrypoint (not in the prompt's list) | `pyproject.toml:219`; `env.py:777` | **delete** |
| `apps/server/backend/.dockerignore` | no Dockerfile exists | none | **delete** |
| `apps/server/.gitattributes` | LF rules for ts/js/svelte; Linux-only repo, no Python rule | itself only | **delete** (no rule is still needed; Biome and ruff enforce LF) |
| `apps/server/.gitignore` | upstream Python/Node template | n/a | **merge then delete**. Rules carried to the root: the boot-copied static files (`/apps/server/<pkg>/static/*` with `!…/static/*/`). Everything else is either already in the root file (`.env`, `.venv`, caches, `node_modules/`) or Svelte/Yarn/Next-era and dropped. The `CLAUDE.md` comment goes too |
| `apps/server/backend/.gitignore` | data and secret ignores | n/a | **merge then delete**. Carried over as `/apps/server/data/` (the new pinned DATA_DIR), `*.db`, **and `/apps/server/backend/data/`**. The last one stays until you confirm the §8 B move: without it, the untracked `chroma.sqlite3`, `cache/` and `uploads/` there would be exposed to the next `git add`; Phase 10 removes it. Dropped: `.webui_secret_key` (its only writer, the CLI, is removed), `_old`, `_test`, `Pipfile`, `uploads` |
| `apps/server/backend/data/readme.txt` | placeholder | `docs/CLAUDE.md:1136` (log, immutable), `migration-plan.md:980` (history) | **delete**. No `.gitignore` negation depends on it (`!/data` is a no-op because nothing ignores `/data` itself). `DATA_DIR` is created by code, but only after `run_migrations()`, which only matters for the SQLite default this repo never uses. Phase 2 still adds `DATA_DIR.mkdir(parents=True, exist_ok=True)` in `env.py`, so the order no longer matters |
| `apps/server/backend/open_webui/data/readme.txt` | placeholder for the pip-install DATA_DIR | same two docs | **delete** (its only path, `FROM_INIT_PY`, is removed) |
| `__init__.py` typer CLI (`serve`, `dev`, `--version`), `[project.scripts]`, the `FROM_INIT_PY` branches in `env.py` (incl. the copy-then-`rmtree` of DATA_DIR) | dead: the project is never installed (`--no-install-project`); the commands have no callers | `README.md:129`, `env.py:777`, `pdf_generator.py:107` comment | **delete**; `__init__.py` becomes a one-line docstring |
| `pyproject.toml` `[tool.codespell]` | no codespell hook exists | none | **delete** |
| `pyproject.toml` comment "docker-compose.playwright.yaml" | names a file that doesn't exist | — | **reword** |
| Root `.gitignore` `tests/data/` rule | the orphaned dir is gone; the unanchored pattern would match `apps/server/tests/data/` after the flatten | — | **delete rule**. `logs/` is kept and anchored as `/logs/` |

### 4c. Functional files (removed with their code)

| Path | Code path | Verdict |
|---|---|---|
| `apps/server/CHANGELOG.md` (1.2 MB) | `env.py` imports (`pkgutil`, `markdown` — `bs4` stays, retrieval uses it), `parse_section` and parsing (164-221); `main.py:82` import and `GET /api/changelog` (2584-2586); `pyproject.toml` force-include; `getChangelog()` in `apps/web/src/lib/apis/index.ts:1458-1482` (no callers); the `showChangelog` row in `interfaceSettingDefs.ts` stays (it preserves an admin-defaults key, per its own comment). The `Markdown` dependency stays (`pymdown-extensions` needs it). | **delete** (Q5) |
| `benchmarks/scripts/backfill_from_sqlite.py` + `scripts/__init__.py` | nothing imports it | **delete** (Q6) |
| `apps/web/src/lib/i18n/locales/<63 non-en-US dirs>` (about 11 MB) | Remove the Language row from `settings/personal/General.tsx:66-88` and `getLanguages`; prune `languages.json` to en-US; in `i18n/index.ts` drop the `fr` fallback and set `supportedLngs: ['en-US']` | **delete** (Q7) |

### 4d. Other unused files found

| Path | Evidence | Verdict |
|---|---|---|
| `apps/web/public/favicon.svg` | Astro template leftover; no reference anywhere | **delete** |
| `apps/web/public/static/apple-touch-icon.png`, `favicon-96x96.png`, `static/logo.png` | no code references; copied to backend static at boot; `logo.png` is used only by `/manifest.json`, which nothing links to | **keep**: harmless, served at stable URLs that browsers and the manifest may request |
| `static/assets/pdf-style.css` + five `*-Variable.ttf` fonts | read by `pdf_generator.py` but `self.css` is never used; `POST /api/v1/utils/pdf` has no frontend caller | **keep**, out of scope. Belongs to the dropped integrations cleanup; noted for later |
| `exportChatStats` (`lib/apis/chats/index.ts:1594`) + `/api/v1/chats/stats/export*` | no UI caller; gated by community sharing | **delete** with the community-sharing removal (Phase 6a) |
| `migrations/README`, `script.py.mako` | Alembic scaffolding | **keep** (`script.py.mako` is the revision template) |
| `alembic.ini` | loaded on every boot (`config.py:58`) | **keep** |

### 4e. Untracked local leftovers (never deleted by me)

`logs/`, `tests/data/` and `.claude/settings.local.json` **do not exist on this machine**, so there is nothing to clean up. If they reappear (for example, from another checkout): `rm -rf logs/llama.db.retired-* tests/data/`.

Present and created by this work's moves:
- `apps/server/backend/data/`: a stale `webui.db` (SQLite) and `vector_db/chroma.sqlite3` from an earlier run, plus `cache/` and an empty `uploads/`
- `apps/server/backend/.venv/`
- `__pycache__/`

§8 has the commands to deal with them.

---

## 5. Phases

**Every PR follows the same rules:**
- **Branch.** Cut it from an up-to-date `main` as `restructure/<phase>-<slug>`.
- **Moves and deletes.** Use `git mv` and `git rm` only.
- **Commits.** Conventional-commit style, exactly the message given, and no co-author or "Generated with" lines in commits or the PR body (AGENTS.md's rule overrides the harness default).
- **Before opening.** Run the phase's verification, then open the PR with `gh pr create` and the results in its body.
- **Merging.** Once `CI passed` is green and you confirm, it is squash-merged; I merge with `gh pr merge --squash` only after your go-ahead.
- **Docs.** `MAP.md`, README §Running it / §Pages and URLs, `AGENTS.md`, and the guides change in the **same PR** as the change they describe.
- **Plan file.** Update the plan's Status section in each PR. **The one exception is the Phase 4 rename PR**, which must contain only the rename, so its results are recorded in the 5a PR.
- **Pacing.** I stop after each phase.
- **Runtime data.** From Phase 2 on, every pytest run and scratch boot sets `DATA_DIR` to a temp directory, so verification never creates `apps/server/data/` (that would make the §8 B move nest).

"**V-std**" below means this verification set:
- `pre-commit run --all-files`
- in `apps/server`: `uv lock --check` and pytest (with `DATA_DIR="$(mktemp -d)"`)
- in `apps/web`: `bunx astro check`, `bun run test:unit`, `bun run build`, `bunx playwright test --workers=2`
- the fingerprint test
- scratch boot S (§7)

### Phase 0: Plan and baselines
- **Branch:** `restructure/0-plan`.
- **Files:** `docs/restructure-plan.md` (this plan, with a Status section).
- **Commands:** capture the baselines below into the scratchpad. They are not committed; their results are summarized in Status.
  - V-std on today's `main`. Fingerprint test: `cd apps/server/backend && WEBUI_SECRET_KEY=x .venv/bin/python -m pytest tests/test_serving_fingerprint.py -q`.
  - Schema baseline: `pg_dump --schema-only` from scratch boot S, saved as `baseline-schema.sql`.
  - Metadata baseline M (§7), saved as `baseline-metadata.txt`.
  - Name-audit baseline count.
- **Risk:** scratch boot needs the embedding model in the HF cache, because of `HF_HUB_OFFLINE=1`. If it isn't cached, S runs without that variable and I note it in Status.
- **Commit:** `docs: add the repository restructure plan`

### Phase 1: Documentation consolidation
- **Files:**
  - `git mv docs/CLAUDE.md docs/decisions.md`, then delete its lines 1-316 and add a 3-line file header (`# Decisions log` + one sentence). Lines 317-end stay byte-identical, so `git log --follow` and blame keep the log's history.
  - New `AGENTS.md`, about 300 lines, with these sections:
    - Why
    - Current phase
    - Models in use
    - Local inference (summary)
    - Moving to self-hosted hardware
    - Repository layout (→ MAP.md)
    - Conventions
    - Commands
    - Backend (apps/server)
    - Frontend (apps/web): the Astro guidance from `apps/web/AGENTS.md`
    - Maintenance policy
    - Commit policy
    - Deeper docs
  - `ln -s AGENTS.md CLAUDE.md`; `git add CLAUDE.md`.
  - Rewritten `README.md`: overview, Running it, Pages and URLs, Model setup, Migrating to local hardware, Documentation index, License.
  - New `docs/guides/{llama-cpp,telemetry,benchmarks,testing,dependencies,frontend}.md`.
  - `git mv`:
    - `docs/model-downloads.md` → `docs/guides/`
    - `docs/proposed-inference-server.md` → `docs/proposals/`
    - `docs/{migration-plan,bug-review-2026-09-27,code-review}.md` → `docs/history/`
    - the two mapping docs → `docs/history/`
  - `git rm`: `apps/web/README.md`, `apps/web/AGENTS.md`, `apps/web/CLAUDE.md`, `apps/server/README.md`. Drop `readme =` from `pyproject.toml` in the same commit.
  - Citation updates:
    - About 25 code and config files citing `docs/migration-plan.md`
    - About 20 citing `bug-review`/`code-review`
    - The wrapped refs in `ServePage.tsx:43-47`
    - Comments in `Makefile`, `.pre-commit-config.yaml`, `infra/docker-compose.yml`, `.gitignore`, `benchmarks/**`, `humaneval.toml` (comments only; `adapter_sha` hashes parsed fields) and `models/benchmark_configs.py`
    - `docs/ROADMAP.md` and `roadmap-timeline.mmd` (`docs/code-review.md` → `docs/history/code-review.md` in both)
    - `MAP.md` (docs/ section rewritten; apps/web structure merged)
  - Untouched: `benchmarks/data/prompts/code.txt`, whose sha would change.
- **Maintenance-policy rewrite:**
  - "Models in use"/"Local inference" now name AGENTS.md's sections **and** `docs/guides/llama-cpp.md` instead of "the corresponding README section".
  - New decisions go "at the top of `docs/decisions.md`".
  - Benchmark numbers are recorded in `docs/guides/llama-cpp.md` / `benchmarks.md` with their context.
  - "Code and docs must agree" points at the guides.
  - The schema rule uses the package's migrations path (updated again in Phases 3 and 4).
  - The ROADMAP coupling is with `docs/decisions.md`.
  - MAP.md is unchanged.
  - README §Running it / §Pages and URLs is unchanged (the `docs/START.md` aside is dropped).
- **Risks:**
  - Silently dropping content. Mitigation: the §3 table is checked off line by line in Status, plus a "no orphan heading" script that greps every old README heading's text in the new files.
  - The log being altered. Mitigation: `diff <(git show main:docs/CLAUDE.md | sed -n '317,$p') <(sed -n '4,$p' docs/decisions.md)` must be empty.
  - Broken links. Mitigation: a small script resolves every relative Markdown link in tracked `*.md` outside history and decisions.
  - The ROADMAP diagram drifting. Mitigation: a script extracts the fenced mermaid block from `ROADMAP.md` and diffs it against the `.mmd`.
- **Verification:**
  - V-std (code comments only; scratch boot not needed).
  - `wc -l AGENTS.md` in 200-350.
  - `git grep -n -E "docs/CLAUDE\.md|docs/migration-plan\.md|docs/(bug-review|code-review)|apps/web/README|COMMON_MAPPING|icons/MAPPING|docs/model-downloads|docs/proposed-inference"` returns only `docs/decisions.md` and `docs/history/`.
- **After merge:** I update my memory notes that point at `docs/CLAUDE.md`.
- **Commit:** `docs: consolidate documentation and agent instructions at the root`

### Phase 2: Deletions and license consolidation (four PRs, in this order)

**2a.** Delete the files in §4a, §4b and §4d marked **delete** (except the root README/AGENTS items already done in Phase 1), `benchmarks/scripts/`, and the empty `apps/server/docs/`.
- `.gitignore` merge per §4b.
- `env.py`: add the `DATA_DIR.mkdir(...)`.
- New `infra/.env.example` with the current names (`OPENROUTER_API_KEY`, `POSTGRES_PASSWORD`, `WEBUI_SECRET_KEY`) and placeholders only.
- `pyproject.toml`: excludes, codespell, comment.
- `MAP.md`, `AGENTS.md`, guides.
- **Commit:** `chore: remove unused upstream project files`

**2b.** CHANGELOG removal per §4c, plus `MAP.md`.
- **Commit:** `refactor(server)!: remove the upstream changelog and its endpoint`

**2c.** Remove the typer CLI and `[project.scripts]`, and the `FROM_INIT_PY` branches in `env.py`, which takes `importlib.metadata.version('open-webui')` with it.
- `__init__.py` shrinks to a docstring.
- Reword `env.py:776-780`'s secret-key error.
- `pdf_generator.py` comment.
- **Commit:** `refactor(server): remove the unused pip-install CLI and its code paths`

**2d.** Locales per §4c.
- **Commit:** `refactor(web): keep only the en-US locale`

**2e.** Licenses:
- `git mv apps/server/{LICENSE,LICENSE_HISTORY,CONTRIBUTOR_LICENSE_AGREEMENT} .` (text untouched).
- New root `NOTICE` (draft below).
- `git rm apps/server/LICENSE_NOTICE apps/web/LICENSE_NOTICE`.
- `pyproject.toml`: `license = { text = "See LICENSE and NOTICE at the repository root" }`, plus the other metadata from §1 (`description = "Local LLM backend"`, `authors = [{ name = "epittman23" }]`), so that the Phase 4 rename PR changes only the distribution `name`.
- Update every path reference: README §License, `MAP.md`, `AGENTS.md`, `About.tsx` comments, `apps/web/src/lib/constants.ts` comment. The About tab's license and copyright **lines are unchanged**.
- **Commit:** `chore: move the license files to the root and merge the notices into NOTICE`

**Draft `NOTICE`.** The multi-license block and the copyright notice are reproduced verbatim; only the framing sentences are new.

```
NOTICE

local-llm contains code derived from Open WebUI
(https://github.com/open-webui/open-webui), forked at v0.11.3 and vendored
into this repository on 2026-09-14.

Derived works
- apps/server/: the backend, a fork of Open WebUI's backend.
- apps/web/: portions derived from Open WebUI's SvelteKit frontend as
  vendored in this repository (last present at commit d863707, under
  apps/openwebui/): the API client modules under src/lib/apis/, the locale
  file under src/lib/i18n/locales/, and logic ported file by file elsewhere
  (comments reading `d863707:apps/openwebui/...` name the source file).
Everything else in this repository is original to local-llm.

Licenses
Those portions remain under the licenses below. The commit identifiers in
the reproduced notice refer to the upstream Open WebUI repository's history.

  [Open WebUI Multi-License Notice: items 1-3 and the closing sentence,
   verbatim from apps/server/LICENSE_NOTICE]

Full texts: LICENSE, LICENSE_HISTORY (and CONTRIBUTOR_LICENSE_AGREEMENT,
which LICENSE refers to).

Copyright
    Copyright (c) 2023- Open WebUI Inc. [Created by Timothy Jaeryang Baek]
    All rights reserved.
The Settings > About tab shows the same license and copyright lines.

Branding
This deployment changes the Open WebUI branding under clause 4(i) of the
Open WebUI License, which permits it for deployments with no more than fifty
end users in any rolling thirty-day period. It is a personal, single-user
deployment; exceeding that limit would require restoring the branding or
one of clause 4's other permissions.
```

- **Risks:**
  - `env.py` import-time crash after removing the CHANGELOG. Mitigation: 2b removes the parser in the same commit, and S boots.
  - DATA_DIR not existing on a fresh clone. Mitigation: the explicit mkdir.
  - Language picker e2e coverage: none exists, so add a unit-level check that General renders without it.
- **Verification:** V-std on each PR; S after 2b and 2c. `curl /api/changelog` returns 404, `/api/version` returns `0.11.3`, and `/` serves the app.

### Phase 3: Flatten `apps/server/backend/`
- **Files:**
  - `git mv apps/server/backend/open_webui apps/server/open_webui`
  - `git mv apps/server/backend/tests apps/server/tests`. After this, `backend/` holds only untracked `data/`, `.venv/` and `__pycache__/`.
  - `env.py` path chain rewritten as:
    ```python
    PACKAGE_DIR = Path(__file__).resolve().parent   # was OPEN_WEBUI_DIR
    SERVER_DIR = PACKAGE_DIR.parent                 # apps/server/ (was BASE_DIR); BACKEND_DIR removed
    ```
    `DATA_DIR` defaults to `SERVER_DIR / 'data'`; `FRONTEND_BUILD_DIR` defaults to `SERVER_DIR.parent / 'web' / 'dist'`. The version is read from `SERVER_DIR / 'pyproject.toml'`; dotenv from `SERVER_DIR / '.env'`.
  - Callers updated: `config.py:22,60,62`, and `benchmarks/grading/__init__.py:34,117`, where the grader interpreter becomes `SERVER_DIR / '.venv' / 'bin' / 'python'`.
  - `Makefile`:
    - `SERVER_DIR := $(REPO_ROOT)/apps/server`
    - `uv sync --frozen --no-install-project --project "$(SERVER_DIR)"`; `UV_PROJECT_ENVIRONMENT` dropped, nothing else uses it
    - `py=$(SERVER_DIR)/.venv/bin/python`, `PYTHONPATH`, and `cd "$(SERVER_DIR)"`
    - New pin:
      ```make
      # DATA_DIR is pinned rather than left to env.py's default (the package's
      # parent dir): that default moved once already, when apps/server/backend/
      # was flattened, and a moved default silently starts the backend on an
      # empty uploads/cache/benchmark-datasets dir. Same reasoning as the pinned
      # Compose project name in infra/docker-compose.yml.
      DATA_DIR ?= $(REPO_ROOT)/apps/server/data
      ```
      and `DATA_DIR="$(DATA_DIR)"` is passed to uvicorn.
  - `pyproject.toml`: `[tool.hatch.build.targets.wheel] packages = ["open_webui"]`, with sources, excludes and force-include gone; ruff per-file-ignores re-pathed.
  - CI backend job: `working-directory: apps/server` and `uv run --frozen python -m pytest tests -q`.
  - `.pre-commit-config.yaml`: `files:` becomes `^apps/server/(open_webui/benchmarks|tests)/` and `^apps/server/(open_webui|tests)/`, plus the comments.
  - `.gitignore`: `/apps/server/data/` and the static rule re-pathed.
  - Tests: `parents[4]`→`parents[3]` in five files, `test_version.py` `parents[2]`→`parents[1]`, and comments.
  - The defaults become pure functions in `env.py`, `default_data_dir()` and `default_frontend_build_dir()`, so they can be tested without the import-time `mkdir` creating `apps/server/data/`.
  - New `tests/test_paths.py`, run with `DATA_DIR` set to a temp directory. It asserts:
    - `default_frontend_build_dir() == <repo>/apps/web/dist`
    - `default_data_dir() == <repo>/apps/server/data`
    - `VERSION != '0.0.0'`
    - `apps/server/data` was not created by the test run
  - Code comments that name `backend/`: `fingerprint.py:18`, `benchmark_tune.py:31`, `profiles.ts:1`, `ProfileDefinitionForm.tsx:79`.
  - `pdf_generator.py`'s already-wrong fallback path becomes `STATIC_DIR / 'fonts'`; `datalab_marker.py:210`'s hard-coded `/app/backend/data/uploads` becomes `UPLOAD_DIR`.
  - Docs: README §Running it (venv path; upgrade note), guides/testing.md and guides/dependencies.md, `AGENTS.md`, `MAP.md`.
  - `.github/dependabot.yml`: unchanged (`/apps/server`), verified only.
- **Commands:**
  - `git mv` as above.
  - `cd apps/server && uv sync --frozen --no-install-project --group dev`, which builds the new `apps/server/.venv`. `make backend` can't build it here, because `infra/.env` doesn't exist.
  - `pre-commit run --all-files` (expect ruff I001 to re-sort test imports now that the package is first-party everywhere).
- **Risks:**
  - The three silent path failures (§2 item 13). Mitigation: `test_paths.py`, plus S checks that `curl -s localhost:4100/ | grep -q '<title>'` and `/api/version` returns `0.11.3`.
  - The telemetry recorder's `-m open_webui...` resolving only via the working directory. Mitigation: the Makefile `cd`s into `SERVER_DIR`, and a test asserts the launcher spawns with `cwd` unset (inherits) or sets it explicitly.
  - Runtime data moving. Mitigation: the Makefile pin and the user-run move in §8.
  - Dependabot conflicts. Mitigation: §2 item 15.
- **Verification:** V-std; S with `DATA_DIR` pointing at a temp directory; `test_paths.py` for the defaults; `git diff -M --name-status main | grep -c '^R'` covers every moved file.
- **Commit:** `refactor(server): flatten apps/server/backend into apps/server`

### Phase 4: Rename the package to `local_llm`
- **Files:**
  - `git mv apps/server/open_webui apps/server/local_llm`
  - A scripted word-boundary replacement `\bopen_webui\b` → `local_llm`, with this scope:
    - all of `apps/server/local_llm/**` and `apps/server/tests/**`
    - `apps/server/pyproject.toml`: also `name = "open-webui"` → `"local-llm"` (description and authors already changed in 2e)
    - `migrations/script.py.mako`, `alembic.ini` (no hits expected)
    - `Makefile`, `.github/**`, `.pre-commit-config.yaml`, `.gitignore`
    - current-state docs: `README.md`, `AGENTS.md`, `MAP.md`, `docs/guides/**`, `docs/proposals/**`
    - `apps/web/**` comments that cite backend paths
  - Exclusions:
    - lines containing `open_webui:` (the protocol string)
    - in `migrations/versions/*`, every line that is not an `import`/`from` line (Q15)
    - `docs/decisions.md`, `docs/history/**`, `docs/serving-baseline/**`, `benchmarks/data/prompts/**`
    - lines containing `d863707:`
    - the `'open_webui'` vector-store prefix defaults (Milvus, Valkey). They are runtime identifiers, not module references, and change in 6c with the other store defaults.
  - Then `cd apps/server && uv lock`. The diff must touch only the root package's own entry.
  - String references checked by hand after the sed:
    - `Makefile`: the uvicorn target `local_llm.main:app` and the `-c 'from local_llm.benchmarks.serving.launcher import build_database_url'`
    - `launcher.py:231` argv, and `test_launcher.py:287` plus its five `monkeypatch.setattr('local_llm...')` targets
    - `test_path_injection.py:47` `import_module`
    - `test_serving_profiles.py:36,200`
    - `test_imports.py:17,99`
    - `utils/plugin.py:192-195` rewrite targets
  - Then `pre-commit run --all-files` until clean, folding ruff-format's reflow (the name is one character shorter) and the I001 re-sort into the same commit. That is still mechanical, rename-only output.
- **Risks:**
  - An import-only pass missing string targets. Mitigation: the explicit list above, plus `git grep -n -w open_webui` afterwards, which must return only allowlisted protocol lines.
  - Editing applied migrations. Mitigation: `git diff -U0 main -- 'apps/server/local_llm/migrations/versions/' | grep '^[-+][^-+]' | grep -v -E '^[-+](from|import) '` must be empty, **and** the scratch-boot `pg_dump --schema-only` (which runs every migration) is identical to the Phase 0 baseline.
  - Stored plugin source breaking. Mitigation: Phase 5b, merged right after.
- **Verification:** V-std, the schema diff, the migration-diff check, and the metadata dump M identical to baseline.
- **Commit (the PR's only content):** `refactor(server)!: rename the open_webui package to local_llm`

### Phase 5: Blame-ignore entry and stored-plugin compatibility (two PRs)
**5a.** Add the Phase 4 **squash SHA** to `.git-blame-ignore-revs`. The comment follows the file's style but is worded without the old name, for example `# refactor(server): rename the Python package to local_llm (#NN).` This PR also records Phase 4's verification results in Status.
- **Commit:** `chore: ignore the package rename in git blame`

**5b.** `utils/plugin.py` `replace_imports` also maps `from open_webui.` → `from local_llm.` and `import open_webui.` → `import local_llm.`, so stored Tool and Function source is rewritten and saved on its next load. No migration is needed. Add `tests/test_plugin_imports.py`.
- **Commit:** `fix(server): rewrite stored plugin imports of the old package name`
- **Verification:** V-std (5b), plus `git blame` on a renamed file with `blame.ignoreRevsFile` set, which shows pre-rename authorship (5a).

### Phase 6: Runtime identifiers and branding (four PRs)

**Order: 6d first, then 6a, 6b, 6c.** 6d depends on nothing else. Merging it first means the `local-llm` project and volume exist before you create `infra/.env` or restore any data, so nothing written to the database can land in an `open-web-ui_postgres-data` volume that 6d would then leave behind. Until 6d merges, treat anything in the database as disposable (§8 D).

**6a. Remove the community hub and upstream services (Q8, Q9).**
- **Frontend:**
  - Share actions, hub import (`COMMUNITY_ORIGINS` and the `postMessage` listeners on the four `/create` pages), the footer links, and `CommunityDiscover.tsx` (deleted).
  - The share payload helpers in `modelImport.ts`, `promptTypes.ts`, `toolTypes.ts` and `functionTypes.ts`.
  - Admin > General: the community switch, the license/"Upgrade" panel, Help/Discord/X/GitHub links, and the version-update UI.
  - About: the update link and check, and the Discord/X/GitHub links. The copyright and license lines stay.
  - `exportChatStats`, and the `enable_community_sharing` feature type.
- **Backend:**
  - `ENABLE_COMMUNITY_SHARING`: its config default, its `features` exposure and the `/api/v1/chats/stats/export*` endpoints.
  - `GET /api/version/updates` and `ENABLE_VERSION_UPDATE_CHECK`.
  - The license-server code: `utils/auth.py` license fetch, `LICENSE_KEY`, `LICENSE_BLOB_PATH`, `main.py` license wiring, and `license` in `/api/config`.
  - The `CUSTOM_NAME` fetch (`config.py:191-221`).
  - The OpenRouter `HTTP-Referer`/`X-Title` headers (`routers/openai.py:163-171`).
- **The Admin > Users "over 50 users" notice:** the one in-app reminder of the 50-user condition your branding change relies on. It is kept but reworded to cite clause 4(i) and `NOTICE`, with no upsell link. First I check whether its condition reads the `license` data being removed from `/api/config`. If it does, the condition is rewritten to the plain user count, not just the text.
- **Tests:** e2e `workspace-prompts` 214-247, `workspace-tools` 221/237-246, `admin-functions` 219-260 and `personal-settings` are updated or removed. Stale DB config rows such as the `ui.enable_community_sharing` key stay inert, so no migration is needed.
- **Pages and URLs:** README §Pages and URLs drops the hub-import behaviour.
- **Commit:** `refactor!: remove the openwebui.com community hub and upstream services`

**6b. Env vars `WEBUI_*` → `LLLM_*` (Q3).**
- **Mapping** (the Python constants are renamed with their variables, by word boundary, across `apps/server` excluding `migrations/versions/`):

  | Old | New |
  |---|---|
  | `WEBUI_SECRET_KEY` | `LLLM_SECRET_KEY` |
  | `WEBUI_JWT_SECRET_KEY` (deprecated fallback) | removed |
  | `WEBUI_AUTH` | `LLLM_AUTH` |
  | `WEBUI_SESSION_COOKIE_SAME_SITE` / `_SECURE` | `LLLM_SESSION_COOKIE_SAME_SITE` / `_SECURE` |
  | `WEBUI_AUTH_COOKIE_SAME_SITE` / `_SECURE` | `LLLM_AUTH_COOKIE_SAME_SITE` / `_SECURE` |
  | `WEBUI_ADMIN_EMAIL` / `_PASSWORD` / `_NAME` | `LLLM_ADMIN_EMAIL` / `_PASSWORD` / `_NAME` |
  | `WEBUI_AUTH_TRUSTED_{EMAIL,NAME,GROUPS,ROLE}_HEADER` | `LLLM_AUTH_TRUSTED_{EMAIL,NAME,GROUPS,ROLE}_HEADER` |
  | `WEBUI_AUTH_SIGNOUT_REDIRECT_URL` | `LLLM_AUTH_SIGNOUT_REDIRECT_URL` |
  | `WEBUI_NAME` | `LLLM_NAME` |
  | `WEBUI_BUILD_HASH` | `LLLM_BUILD_HASH` |
  | `WEBUI_URL`, `WEBUI_BANNERS` | `LLLM_URL`, `LLLM_BANNERS` (**env key only**) |
  | `WEBUI_BACKEND_URL` (astro.config.mjs, Makefile) | `LLLM_BACKEND_URL` |

  `WEBUI_URL` and `WEBUI_BANNERS` keep their Python names because they are also the admin-config API field and config-row names. `OPEN_WEBUI_DIR` was already renamed to `PACKAGE_DIR` in Phase 3.
- **Not renamed:** the frontend JS constants (`WEBUI_BASE_URL` and friends; they are not env vars), the `WEBUI_URL` API field, and migrations.
- **Makefile:** `make backend` fails with a clear message naming any of `OPENROUTER_API_KEY`, `POSTGRES_PASSWORD`, `LLLM_SECRET_KEY` that is missing from `infra/.env`. CI's env becomes `LLLM_SECRET_KEY`. `infra/.env.example` is updated, as are README §Running it, AGENTS.md and the guides.
- **Your edits to `infra/.env`** are in §8.
- **Commit:** `refactor!: rename WEBUI_* environment variables to LLLM_*`

**6c. Rebrand as "Local LLM" (Q2).**
- **Name logic:** the `LLLM_NAME` default becomes `'Local LLM'`, and the code that appended `' (Open WebUI)'` is removed. `APP_NAME` becomes `'Local LLM'`, as do the FastAPI `title` and the startup banner (with the upstream URL dropped). The `SERVER_CONNECTION_ERROR` strings become `'Local LLM: Server Connection Error'`.
- **Favicon:** `WEBUI_FAVICON_URL` becomes `{LLLM_URL}/static/favicon.png` when `LLLM_URL` is set; otherwise the webhook payload omits it.
- **License comments:** the roughly 35 `LICENSE covers this … branding surface` comment blocks are removed. NOTICE records the clause 4(i) basis once.
- **Strings:** the user-visible strings in `apps/web/src` from the sweep (Admin settings descriptions, workspace pages, `pluginVersion.ts` toast, `ManifestModal`, `functionBoilerplate.ts` author), backend messages and docstrings, and the 25 en-US locale keys and values (no `t()` callers, so this is safe).
- **Kept as-is, per §6:**
  - Links to upstream documentation for inherited features. They are left in place: a URL can't be rebranded, and the docs still describe these features.
  - Names of products that really are upstream's, such as the `ghcr.io/open-webui/open-terminal` placeholder and "maintained by the Open WebUI team" in `AddToolServerModal`.
  - Upstream issue and PR links that explain why code is the way it is.
- **Identifiers:**
  - `X-OpenWebUI-*` headers become `X-LLLM-*`, including the File-Id pair in `ExtractionFields.tsx` and the backend.
  - JWT `iss` becomes `local-llm`; `REDIS_KEY_PREFIX` and `OTEL_SERVICE_NAME` become `local-llm` (no Redis or OTEL in use, so no data).
  - The session cookie `owui-session` becomes `lllm-session`, which signs out existing sessions once.
  - User-Agent strings change.
  - All vector-store name defaults change together: Qdrant and Pinecone `open-webui`, Milvus and Valkey `open_webui`, and Elasticsearch `open_webui_collections`. These stores are unused, so there is no data under the old names.
  - The k8s Ollama URL default becomes `http://localhost:11434`.
  - The local names `open_webui_params` and `remove_open_webui_params` become `local_llm_params` and `remove_local_llm_params`.
- **Docs:** `docs/proposals/` gets its one cell changed. In ROADMAP and the `.mmd`, only the forward-looking "behind Open WebUI" line changes, in both files byte-identically; historical milestones stay.
- **Commit:** `refactor: rebrand the app as Local LLM`

**6d. Compose and Postgres (Q4, Q13).**
- **Compose:** `name: local-llm`, with the comment rewritten. The pin rationale stays: a pinned name means moving the file cannot orphan the volume, now `local-llm_postgres-data`, with no explicit volume `name:`, per Q13. `POSTGRES_USER`/`POSTGRES_DB` become `local_llm`.
- **Code and CI:** `launcher.build_database_url` defaults, `test_launcher.py:262-263,355`, the CI service env and the `pg_isready -U`, README §Backend URLs, the guides/testing.md throwaway command, and AGENTS.md.
- **Commit:** `refactor(infra)!: rename the Compose project, volume and Postgres role to local-llm`

**Phase 6 risks:**
- Sign-out on the cookie rename, and the backend refusing to start until `infra/.env` uses `LLLM_SECRET_KEY`. Mitigation: both are documented in the README upgrade note and §8, and the Makefile check names the missing key.
- Removed features leaving dead UI. Mitigation: astro check, e2e, and the manual smoke test in §8.

**Phase 6 verification:** V-std per PR; S with `LLLM_*` (6b onward), checking that `/api/config` returns `"name": "Local LLM"` (6c) and that `/api/version/updates` and `/api/changelog` return 404 (6a). The name-audit count drops as expected.

### Phase 7: Benchmark organization (two PRs)

**7a.** Create `models/benchmarks/{__init__,configs,profiles,telemetry,tests,tune}.py` via `git mv` from `models/benchmark_*.py`, and update the importers. These are listed in the sweep: about 25 lines across `benchmarks/*`, `routers/benchmarks/*` and the tests. `__tablename__` and `Base` are untouched.
- **Proof:** metadata dump M and the S `pg_dump --schema-only` are identical to baseline.
- **Commit:** `refactor(server): group the benchmark models under models/benchmarks`

**7b.** Regroup `benchmarks/`:
- `serving/` gains `env_profile.py` and `telemetry_recorder.py`.
- `evaluation/` gets `adapters`, `suites`, `datasets`, `runner` and `grading/`.
- `analysis/` gets `compare`, `report`, `report_figures` and `stats`.
- `tuning/` gets `tune`, `tune_schedule`, `tune_probe` and `proc`.
- `data/` stays.

The new `benchmarks/paths.py` holds the data-directory constant:
```python
BENCHMARK_DATA_DIR = Path(__file__).resolve().parent / 'data'
```
It replaces the four `Path(__file__).resolve().parent / 'data'` lookups (`ADAPTERS_DIR`, `PROMPTS_DIR`, `SUITES_DIR`, `GRID_DIR`). The launcher argv becomes `local_llm.benchmarks.serving.telemetry_recorder`, and `test_launcher.py`'s assertion changes with it.
- **Before moving `grading/`:** grep it and the runner for `-m <pkg>...` argv, `__file__`-relative harness paths, and the module paths given to subprocesses. The sweep only established the grader's interpreter path, not how the harness is invoked. Any such string is updated with the move and covered by a test.
- **Risks:**
  - The `report` ↔ `report_figures` import cycle. Mitigation: keep its lazy import.
  - A `data/` path moving. Mitigation: `paths.py` is relative to `benchmarks/`, which does not move, and a test asserts each `*_DIR` exists.
  - `adapter_sha` and `system_sha` hash content only, so they are unaffected.
- **Commit:** `refactor(benchmarks): group modules into serving, evaluation, analysis and tuning`
- **Verification:** V-std plus the fingerprint test; the manual Benchmarks smoke test in §8.

### Phase 8: Makefile check targets
`Makefile`:
- **`lint`**: `SKIP=no-commit-to-branch uvx pre-commit@4.6.2 run --all-files --show-diff-on-failure`. The version matches CI's `PRE_COMMIT_VERSION`, with a comment to keep the two in sync.
- **`test-backend`**: runs `uv lock --check` and `uv sync --frozen --no-install-project --group dev`. It then starts a throwaway `pgvector/pgvector:pg16` on `127.0.0.1:55432`, with a trap that stops it, and runs pytest with a dummy `LLLM_SECRET_KEY` and `TEST_DATABASE_URL`, as CI does. `test_the_app_imports` therefore runs instead of skipping.
- **`test-web`**: `bun install --frozen-lockfile`, `bunx astro check`, `bun run test:unit`, `bun run build`.
- **`test-e2e`**: `bunx playwright test --workers=2`, CI's count.
- **`test`**: all three.
- **`check`**: `lint` then `test`.
- **`help`**: updated.

Also: AGENTS.md §Commands, README §Running it (one line), and guides/testing.md.
- **Risk:** port 55432 being in use. Mitigation: `LLLM_TEST_PG_PORT ?= 55432`.
- **Verification:** `make check` passes on the branch and its result matches the PR's CI.
- **Commit:** `build: add make test, make lint and make check mirroring CI`
- **Option:** this phase could run before Phase 3 to give the flatten and the rename a one-command check. I kept your order because nothing depends on it.

### Phase 9: Unused-integration removal
**Dropped (Q10).**

### Phase 10: Final documentation sync and name audit
- **Name audit:** `git grep -nI -i -E "open.?webui"` is classified against §6. Any match outside the allowlist is fixed. If there are any, they go in their own commit first: `chore: remove remaining references to the original project name`.
- **New entry at the top of `docs/decisions.md`**, dated the day of the work. It records:
  - the restructure
  - the deviations: Q13's fresh volume, Q15's migration import edits, Phase 9 dropped, CHANGELOG/community/upstream removal
  - the `LLLM_` variable rename
  - the DATA_DIR pin
- **Roadmap:** a matching milestone in `docs/roadmap-timeline.mmd` and in ROADMAP's embedded copy, checked byte-identical by the extraction script.
- **Plan file:** `git mv docs/restructure-plan.md docs/history/` with its final Status.
- **Ignore rule:** the temporary `/apps/server/backend/data/` rule is removed from `.gitignore`, once you confirm the §8 B move is done.
- **Last pass:** `MAP.md`, `AGENTS.md`, README.
- **Commit:** `docs: record the repository restructure in the decisions log and roadmap`
- **Verification:** V-std, the audit report, and the mermaid identity check.

---

## 6. Proposed name-audit allowlist

`git grep -nI -i -E "open.?webui"` may match only the following after Phase 10. Any other match is reported and fixed.

1. `LICENSE`, `LICENSE_HISTORY`, `NOTICE`, `CONTRIBUTOR_LICENSE_AGREEMENT`.
2. `docs/decisions.md` and `docs/history/**`.
3. In `docs/ROADMAP.md` and `docs/roadmap-timeline.mmd`, historical milestone lines only. Forward-looking lines are rewritten.
4. `docs/serving-baseline/**`, which is test input captured verbatim.
5. `apps/server/local_llm/benchmarks/data/prompts/**`, if it has any matches; its content is pinned by `system_sha`.
6. The one provenance line in each of `README.md` and `AGENTS.md`.
7. The Settings > About attribution block (`About.tsx` copyright and license lines) and the e2e assertion on it (`personal-settings.spec.ts`).
8. The clause 4(i) notice in Admin > Users (`UserList.tsx`).
9. The `d863707:apps/openwebui/...` provenance comments, which are git paths.
10. `open_webui:code_interpreter`, a persisted chat-history type: `utils/middleware.py`, `utils/misc.py`, `apps/web/src/lib/chat/structuredOutput.ts` and their tests.
11. `required_open_webui_version`, a plugin frontmatter key: `pluginVersion.ts`, `plugins.test.ts`, `e2e/workspace-tools.spec.ts`. The same applies to `{{OPEN_WEBUI_VERSION}}` if the en-US locale has it.
12. `utils/plugin.py`'s old-name import rewrite from Phase 5b, and its test.
13. Non-import lines of applied migrations under `migrations/versions/`, which are never edited.
14. Upstream issue, PR and discussion URLs that explain why code is the way it is: the `av` pin in `pyproject.toml`, `#15720` in `.github/dependabot.yml`, `retrieval/loaders/main.py:566`, and any like them.
15. The read-only history archive URL `github.com/epittman23/open-webui` (branch `customizations`), cited once in `MAP.md`/`AGENTS.md`.
16. Links to upstream documentation for inherited features in admin-settings descriptions (`Authentication.tsx`, `Connections.tsx:393`, `Integrations.tsx`, `Audio.tsx`, and similar). Phase 10 lists each one so you can veto any.
17. Names of products that really are upstream's: the `ghcr.io/open-webui/open-terminal` placeholder and the "maintained by the Open WebUI team" line in `AddToolServerModal.tsx`.

The new `.git-blame-ignore-revs` comment from 5a is worded without the old name, so it needs no entry.

Postgres identifiers and the Compose volume are renamed (Q4, Q13), so neither needs an entry.

---

## 7. Verification procedures

**S: scratch boot.** This stands in for `make backend` until `infra/.env` exists. Port 55433 avoids `make test`'s 55432. `<pkg>` and `<dir>` follow the current phase's layout, and `<SECRET_VAR>` is `WEBUI_SECRET_KEY` before 6b and `LLLM_SECRET_KEY` from then on.
```bash
docker run --rm -d --name lllm-scratch -p 127.0.0.1:55433:5432 \
  -e POSTGRES_USER=scratch -e POSTGRES_PASSWORD=throwaway -e POSTGRES_DB=scratch pgvector/pgvector:pg16
# wait for pg_isready, then from <dir> (apps/server/backend before Phase 3, apps/server after):
DATA_DIR="$(mktemp -d)" <SECRET_VAR>=scratch-only-0123456789abcdef0123 \
  DATABASE_URL=postgresql://scratch:throwaway@127.0.0.1:55433/scratch VECTOR_DB=pgvector HF_HUB_OFFLINE=1 \
  .venv/bin/python -m uvicorn <pkg>.main:app --host 127.0.0.1 --port 4100 &
curl -fsS 127.0.0.1:4100/health; curl -fsS 127.0.0.1:4100/api/version
curl -fsS 127.0.0.1:4100/api/config | jq .name; curl -fsS 127.0.0.1:4100/ | grep -o '<title>[^<]*'
docker exec lllm-scratch pg_dump --schema-only -U scratch scratch > schema-<phase>.sql   # diff vs baseline
# stop uvicorn; docker stop lllm-scratch
```

**M: metadata dump.** The output must be identical to the baseline after Phases 3, 4 and 7.
```python
import importlib, pkgutil
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateTable
import <pkg>.models as m
for mod in pkgutil.walk_packages(m.__path__, m.__name__ + '.'): importlib.import_module(mod.name)
from <pkg>.internal.db import Base
print(*sorted(Base.metadata.tables), sep='\n')
for n in sorted(t for t in Base.metadata.tables if t.startswith('benchmark_')):
    print(CreateTable(Base.metadata.tables[n]).compile(dialect=postgresql.dialect()))
```

**Fingerprint test.** Before Phase 3, run `cd apps/server/backend && <SECRET_VAR>=x .venv/bin/python -m pytest tests/test_serving_fingerprint.py -q`. From Phase 3 on, run it from `apps/server`. It runs before the work starts and after every backend phase (2-8).

**Docs checks:**
- The mermaid identity check: `diff <(awk '/^```mermaid/{f=1;next} /^```/{f=0} f' docs/ROADMAP.md) docs/roadmap-timeline.mmd`.
- The decisions-log byte check from Phase 1.
- A relative-link resolver over every tracked `*.md` outside `docs/history/` and `docs/decisions.md`.

---

## 8. Things only you run (I never read or modify `infra/.env`, and never touch untracked data)

**A. `infra/.env`.** It doesn't exist on this machine yet.
- **Before 6b merges**, create it from `infra/.env.example` with `OPENROUTER_API_KEY`, `POSTGRES_PASSWORD` and `WEBUI_SECRET_KEY` (e.g. `openssl rand -base64 24` for the last two). You can also wait until 6b merges and create it directly with `LLLM_SECRET_KEY`.
- **After 6b merges**, rename the key:
  ```bash
  sed -i 's/^WEBUI_SECRET_KEY=/LLLM_SECRET_KEY=/' infra/.env
  ```
  If you also set any optional `WEBUI_*` keys, rename each per the 6b table.

**B. Data directory.** Do this after Phase 3 merges and before the next `make backend`. Then tell me it's done, so Phase 10 can drop the temporary ignore rule.
```bash
cd ~/local-llm
tar -C apps/server/backend -czf ~/local-llm-data-backup-$(date +%F).tar.gz data
if [ -e apps/server/data ]; then
  echo "apps/server/data already exists: stop and tell me before moving anything"
else
  mv apps/server/backend/data apps/server/data
fi
# Optional: webui.db and vector_db/ are leftovers of an earlier SQLite/Chroma run; Postgres+pgvector is what runs.
# rm apps/server/data/webui.db && rm -r apps/server/data/vector_db
```

**C. Virtualenv.** After Phase 3, the first `make backend` builds `apps/server/.venv`; the uv cache keeps that quick. Then:
```bash
rm -rf apps/server/backend/.venv
git status --ignored --short apps/server/backend   # expect only __pycache__ leftovers
rm -rf apps/server/backend
```

**D. Postgres.** After 6d (the first Phase 6 PR to merge) the cluster is initialized as role and database `local_llm`, in a fresh volume. **Restore nothing before 6d merges.** Anything written before then goes to an `open-web-ui_postgres-data` volume that 6d leaves behind, so treat it as disposable.
- **Path 1 (recommended): restore a dump.**
  - On the machine that has the old database: `pg_dump -Fc -U openwebui openwebui > local-llm.dump`.
  - Here, start only Postgres with `docker compose -f infra/docker-compose.yml up -d postgres`, then:
    ```bash
    docker exec -i local-llm-postgres pg_restore --no-owner --role=local_llm -U local_llm -d local_llm < local-llm.dump
    ```
    Do this **before** the first `make backend`, so migrations don't create an empty schema first.
  - Uploaded-file rows store absolute paths from the old machine. If you bring uploads across, tell me and I'll plan the path rewrite.
- **Path 2: rename in place,** in a cluster you keep (e.g. on the old machine before dumping, or an old volume). Check the password type first, because Postgres clears MD5 passwords on rename. You can't rename the role you're connected as, nor the database you're connected to, so this goes through a temporary superuser:
  ```sql
  -- as openwebui, connected to db postgres:
  SELECT rolname, CASE WHEN rolpassword LIKE 'SCRAM-SHA-256$%' THEN 'scram'
                       WHEN rolpassword LIKE 'md5%' THEN 'md5' ELSE 'other' END AS kind
    FROM pg_authid WHERE rolname = 'openwebui';
  CREATE ROLE tmp_rename SUPERUSER LOGIN;
  -- reconnect as tmp_rename (container-local socket uses trust auth) to db postgres:
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'openwebui';
  ALTER DATABASE openwebui RENAME TO local_llm;
  ALTER ROLE openwebui RENAME TO local_llm;
  ALTER ROLE local_llm PASSWORD '<POSTGRES_PASSWORD>';   -- only if kind was 'md5'
  -- reconnect as local_llm to db local_llm:
  DROP ROLE tmp_rename;
  ```
  Attaching an old volume under the new Compose name would be a volume data migration, which I won't plan without asking you.

**E. Manual smoke test** (after all of Phase 6, and again after Phase 7). Run `make backend` (and `cd apps/web && bun run build` first), then:
- **Sign-in and chat:** sign in (the first account becomes admin), then send a chat on each model.
- **Benchmarks:** open each Benchmarks page (Serve, Live, Tests, Compare, Answers, Report, Tune). A Tests "run one item" needs a running llama-server, so do that one only if llama.cpp is built.
- **Settings > About:** shows "Local LLM", 0.11.3, and the copyright and license lines, and no update or community links.
- **Admin > General:** has no community or license panel.
- **Workspace:** Models, Prompts and Tools have create pages with no hub import or Share.
- **Knowledge:** a knowledge upload embeds (pgvector, cached model).
- **Volume:** `docker volume ls` shows `local-llm_postgres-data`.

---

## 9. Status (kept current in `docs/restructure-plan.md`)

| Phase | PR | State | Verification | Deviations |
|---|---|---|---|---|
| 0 Plan + baselines | #54 | done | see "Phase 0 baselines" below | none |
| 1 Docs | #55 | done | see "Phase 1" below | see "Phase 1" below |
| 2a-2e Deletions + licenses | #56, #57, #58, #59, 2e: (this PR) | done | see "Phase 2" below | see "Phase 2" below |
| 3 Flatten | #61 | done | see "Phase 3" below | see "Phase 3" below |
| 4 Rename | #62 | done | see "Phase 4" below | see "Phase 4" below |
| 5a/5b Blame + plugin compat | #63, #64 | done | see "Phase 5" below | none |
| 6a-6d Identifiers + branding | 6d #65, 6a #66, 6b: (this PR) | in progress | see "Phase 6" below | see "Phase 6" below |
| 7a/7b Benchmarks | — | | | |
| 8 make check | — | | | |
| 10 Final sync + audit | — | | | |

### Phase 0 baselines (2026-10-10, `main` at 1341930)

- `uv lock --check`: OK (335 packages).
- Backend pytest: 300 passed, 1 skipped (`test_the_app_imports`, no `TEST_DATABASE_URL`). With a scratch `TEST_DATABASE_URL`, `test_imports.py`: 2 passed.
- Fingerprint test: 79 passed.
- Scratch boot S (`HF_HUB_OFFLINE=1`):
  - `/health` returns `{"status":true}`
  - `/api/version` returns `0.11.3`
  - `/api/config` name is `Open WebUI`
  - `/` title is `local-llm`
  - `/api/changelog` returns 200
- Schema baseline: `pg_dump --schema-only`, 2,943 lines. Metadata baseline M: 441 lines, 17 `benchmark_*` tables. Both are kept in the session scratchpad, not committed.
- Web:
  - `astro check`: 0 errors, 0 warnings, 13 hints
  - Vitest: 588 tests in 78 files passed
  - `bun run build`: OK
  - Playwright (`--workers=2`): 348 passed (10.0 min)
- `pre-commit run --all-files`: all passed.
- Name audit: 6,388 matches in 427 files.
- **Finding:** the embedding model `sentence-transformers/all-MiniLM-L6-v2` is **not in the HF cache** on this machine. With `HF_HUB_OFFLINE=1` (as `make backend` sets it), the backend boots, but loading the embedding function fails. Knowledge uploads won't embed until the model is fetched once, for example by running the backend once without `HF_HUB_OFFLINE`. This predates the restructure; it goes in the §8 E smoke test.

### Phase 1: documentation consolidation

- **Done.**
  - New root `AGENTS.md` (271 lines), with `CLAUDE.md` as a symlink to it.
  - `README.md` rewritten from 1,628 to 248 lines.
  - Six new guides plus `model-downloads.md` under `docs/guides/`.
  - `docs/decisions.md`, with history docs and proposals moved.
  - `apps/web/README.md`, `apps/web/AGENTS.md`, `apps/web/CLAUDE.md` and `apps/server/README.md` removed; pyproject `readme` dropped.
  - 68 files' citations re-pointed.
  - MAP.md, ROADMAP.md and `.mmd` updated.
- **Verification:**
  - The decisions log is byte-identical to `main:docs/CLAUDE.md` lines 317-end (`sed -n '5,$p' docs/decisions.md`).
  - The mermaid copy is identical.
  - 0 broken relative links or anchors in tracked Markdown.
  - No stale citation of a moved doc outside `docs/decisions.md` and `docs/history/`.
  - pre-commit passed; `uv lock --check` OK; pytest 300 passed, 1 skipped.
  - Web: astro check 0 errors, Vitest 588 passed, build OK, Playwright 348 passed.
- **Deviations from §3:**
  - `docs/decisions.md` has a 4-line header, so the log starts at line 5, not 4.
  - The guides keep README's original section headings (e.g. "Recorded telemetry and throughput", not "How it is recorded") to keep the move easy to diff.
  - README keeps the 2026-10-09 WSL2 note until Phase 3 adds the restructure upgrade note.
  - The NOTICE links in README and AGENTS.md point at `apps/server/LICENSE_NOTICE` until Phase 2e creates `NOTICE`.
  - `docs/guides/benchmarks.md` "The pages" still mentions the orphaned `tests/data/` cache; that goes with the gitignore rule in Phase 2a.

### Phase 2: deletions and license consolidation

- **Baselines re-created.** The session scratchpad was wiped by a session restart after Phase 1, which took the Phase 0 schema and metadata baselines with it.
  - Rebuilt from the pre-restructure commit (1341930) in a temporary worktree: same sizes as Phase 0 (2,943 schema lines, 441 metadata lines).
  - Now kept outside the scratchpad in `~/.cache/local-llm-restructure/`, along with `scratch_boot.sh` and `metadata_dump.py`.
  - pg_dump's random `\restrict` token lines are filtered out before diffing.
- **2a (remove unused upstream files).**
  - Deleted every file the §4a/§4b/§4d manifest marked **delete**, plus `benchmarks/scripts/` (Q6) and `apps/web/public/favicon.svg`.
  - Merged the server `.gitignore` files into the root one: `/apps/server/backend/data/`, `/apps/server/data/`, `*.db`, the boot-copied static files, and `.webui_secret_key` (until 2c removes the CLI). Dropped the `tests/data/` rule and anchored `/logs/`.
  - `env.py` creates `DATA_DIR` itself, and its missing-secret message now points at `infra/.env` instead of the deleted start scripts.
  - New `infra/.env.example`.
  - pyproject: codespell config and the stale wheel excludes removed.
  - **Verification:**
    - pre-commit passed; `uv lock --check` OK; pytest 300 passed, 1 skipped; fingerprint 79 passed.
    - Scratch boot OK; schema and metadata identical to baseline.
    - `git status` shows no newly unignored files; web build OK. Playwright left to CI: no route or component changed.
- **2b (remove the upstream changelog).**
  - Deleted `apps/server/CHANGELOG.md` (1.2 MB) with its parser in `env.py` (and the `pkgutil`, `markdown` and `bs4` imports only it used), `GET /api/changelog` in `main.py`, the pyproject force-include, and the uncalled `getChangelog()` in `apps/web/src/lib/apis/index.ts`. The `showChangelog` settings row stays: it preserves an admin-defaults key.
  - **Verification:**
    - pre-commit passed; lock OK; pytest 300 passed, 1 skipped.
    - Boot OK; schema identical; astro check 0 errors; Vitest 588 passed.
    - `/api/changelog` now returns the SPA's `text/html` 200, not JSON.
  - **Finding (pre-existing, not changed):** the backend's SPA mount answers **every** unknown path with `index.html` and 200, unknown `/api/*` paths included (`/api/does-not-exist` does the same). The boot script now reports content type so a removed endpoint is distinguishable.
- **2c (remove the pip-install CLI).**
  - `open_webui/__init__.py` (the typer `serve`/`dev`/`--version` CLI, which imported the undeclared `typer` on every package import) is now a one-line docstring.
  - Removed `[project.scripts]`, the `FROM_INIT_PY` flag and its three `env.py` branches (the version via `importlib.metadata`, the copy-then-`rmtree` of `DATA_DIR`, and the `frontend/` build dir).
  - Removed `pdf_generator.py`'s two pip-install font fallbacks (`FONTS_DIR` is always the package's `static/fonts`), plus the `.webui_secret_key` ignore rule and wheel exclude.
  - **Verification:** pre-commit passed; lock OK; pytest 300 passed, 1 skipped; boot OK (version 0.11.3); schema identical.
- **2d (keep only the en-US locale).**
  - Deleted 63 locale directories (about 11 MB) and `languages.json`.
  - Settings > General loses its Language picker, which changed `<html lang>` and nothing else.
  - `lib/i18n/index.ts` now sets `supportedLngs: ['en-US']`, drops the `fr` fallback map, and removes the now-unused `getLanguages`/`changeLanguage` helpers.
  - **Verification:**
    - pre-commit passed.
    - astro check 0 errors, 0 warnings; Vitest 588 passed; build OK (one translation chunk instead of 64).
    - Playwright `--workers=2`: 348 passed.
- **2e (licenses at the root).**
  - `git mv` of `LICENSE`, `LICENSE_HISTORY` and `CONTRIBUTOR_LICENSE_AGREEMENT` from `apps/server/` to the root (R100: text unchanged).
  - New root `NOTICE` merges both `LICENSE_NOTICE` files (both deleted). It keeps the upstream multi-license notice verbatim (indented as a quotation, with a note that its commit ids are upstream's), the derived-works list, the copyright notice, and the clause 4(i) branding statement.
  - pyproject `license` becomes text pointing at the root files; `description` and `authors` change per §1, so the Phase 4 PR changes only `name`.
  - README "License", AGENTS.md, MAP.md re-pointed. Settings > About is unchanged (it shows the lines, not file paths).
  - **Verification:** pre-commit passed (gitleaks, detect-private-key); `uv lock --check` OK; pytest 300 passed, 1 skipped; 0 broken links.
- **Tooling:** the link checker was also lost with the scratchpad and now lives in `~/.cache/local-llm-restructure/check_links.py`.

### Phase 3: flatten `apps/server/backend/`

- **Done.**
  - `git mv` of `backend/open_webui` to `apps/server/open_webui` and of `backend/tests` to `apps/server/tests`. That is 352 renames, all detected as renames.
  - `env.py`: `PACKAGE_DIR`/`SERVER_DIR` replace `OPEN_WEBUI_DIR`/`BACKEND_DIR`/`BASE_DIR`. The defaults are the pure functions `default_data_dir()` (`apps/server/data`) and `default_frontend_build_dir()` (`apps/web/dist`). Callers in `config.py` and `grading/__init__.py` updated; the grader's venv is now `SERVER_DIR/.venv`.
  - Makefile: `SERVER_DIR`, uv's default `apps/server/.venv` (no `UV_PROJECT_ENVIRONMENT`), `DATA_DIR ?= apps/server/data` pinned with its rationale, and `cd apps/server`.
  - pyproject: wheel `packages = ["open_webui"]`; ruff per-file-ignores re-pathed. CI pytest runs from `apps/server`. pre-commit `files:` re-pathed.
  - `.gitignore`: `/apps/server/data/` and the static rule re-pathed. `/apps/server/backend/` stays ignored until the §8 B/C local moves are done.
  - Tests: `parents[4]` → `[3]` (five files), `test_version` `parents[2]` → `[1]`. New `tests/test_paths.py` pins the three silent-failure paths.
  - **Deviation:** `ServeProcess` now spawns the telemetry recorder with an explicit `cwd=IMPORT_ROOT`, the package's import root derived from the module's dotted name, instead of inheriting uvicorn's working directory. New test `test_telemetry_recorder_module_resolves_from_import_root`.
  - `datalab_marker.py`: the hard-coded `/app/backend/data/uploads` became `DATA_DIR/uploads`.
  - Docs updated: README "Running it" (venv, plus a restructure upgrade note with the data-move commands), AGENTS.md, MAP.md, guides.
- **Verification:**
  - Built the new `apps/server/.venv` (`uv sync --frozen --no-install-project --group dev`).
  - pre-commit passed. The ruff I001 re-sort of 14 test files (first-party section break) was expected and is folded in.
  - `uv lock --check` OK.
  - pytest 305 passed, 1 skipped; with `TEST_DATABASE_URL`, `test_imports.py` 2 passed. Fingerprint 79 passed.
  - Scratch boot from `apps/server`: version 0.11.3, `/` serves `<title>local-llm`. Schema and metadata identical to baseline.
  - No `apps/server/data/` was created by any run.
  - Web: astro check 0 errors, Vitest 588 passed, build OK.
- **Merging #61 hit CodeQL:** GitHub keys alert dismissals by file path, so all 48 alerts already dismissed at `apps/server/backend/...` reappeared as new at `apps/server/...`, and the ruleset blocked the merge. Each one had an exact dismissed twin on `main` (same rule and line): 34 false positive, 13 won't fix, and 1 false positive with a fixed duplicate. With the owner's approval, every one was dismissed again with its twin's reason and a "Carried over from #N" comment, and #61 then merged normally. The procedure is scripted in `~/.cache/local-llm-restructure/carry_dismissals.py`, a dry run by default that refuses to apply if any alert lacks a twin.

### Phase 4: package rename (#62, squash `69c243c3`)

- **Done.**
  - `git mv apps/server/open_webui apps/server/local_llm`; every file detected as a rename.
  - A scripted word-boundary replacement of `open_webui` with `local_llm` (1,460 lines in 247 files) across `apps/`, the Makefile, `.github/`, pre-commit, `.gitignore`, README, AGENTS.md, MAP.md, `docs/guides/` and `docs/proposals/`. It excluded `open_webui:` protocol strings, `d863707:` comments, the four vector-store name defaults (left for 6c), non-import lines in `migrations/versions/`, and `benchmarks/data/prompts/`.
  - All 62 non-import replacements were reviewed by hand, including the Makefile uvicorn target, the recorder's `-m` argv, `monkeypatch.setattr`, `import_module`, `importorskip`, and the `plugin.py` rewrite targets.
  - pyproject `name = "local-llm"`. The `uv.lock` root entry was renamed and moved, with its content otherwise identical; the rest of the lock is unchanged.
- **Verification:**
  - The rename-aware diff of `migrations/versions/` is exactly 5 import lines in 3 files (Q15).
  - pre-commit had nothing to change; `uv lock --check` OK.
  - pytest 305 passed, 1 skipped; `test_imports.py` with a scratch DB 2 passed.
  - Scratch boot (`local_llm.main:app`): 0.11.3, `/` serves the app.
  - Schema and metadata identical to baseline.
  - astro check 0 errors; Vitest 588 passed.
- **CodeQL again:** the same 48 dismissed alerts resurfaced at `apps/server/local_llm/`; all 48 had twins, were carried over, and #62 merged normally.
- **Deviation:** the rename PR could not carry its own Status update (it must contain only the rename), so these results are recorded here in 5a, as planned.

### Phase 5: blame-ignore entry and stored-plugin compatibility

- **5a.** Added `69c243c34ff32fabbf0f5cd8249bb9ddac1d8485` (the #62 squash) to `.git-blame-ignore-revs`, with a comment in the file's style that does not name the old package.
- **5b.** `utils/plugin.py`'s `replace_imports` now also rewrites `from open_webui…` / `import open_webui…` to `local_llm`. It is word-bounded and applies only after `from`/`import`, so `'open_webui:code_interpreter'`, `required_open_webui_version` and `open_webui_extras` are untouched.
  - It runs where the existing rewrite already ran: on every Tool/Function load (whose result is saved back) and on create, update and import. Stored and pasted community plugins written against the old name therefore keep working, with no migration.
  - New `tests/test_plugin_imports.py` (3 tests). Verification: pytest 308 passed, 1 skipped; pre-commit passed.

### Phase 6: runtime identifiers and branding (order: 6d, 6a, 6b, 6c)

- **6d (Compose project, volume, Postgres role and database).**
  - Compose `name: local-llm`, so the volume is `local-llm_postgres-data`; Q13 chose a fresh volume, with no `name:` pin to the old one. `POSTGRES_USER` and `POSTGRES_DB` are both `local_llm`. The file's comment keeps the pin rationale and records the old names.
  - `launcher.build_database_url` defaults, the `test_launcher.py` URLs, the CI Postgres service, the throwaway-DB command in `docs/guides/testing.md`, README "Backend URLs" and MAP.md all updated.
  - README "Running it" gains a "Restoring a database" note: `pg_dump` on the old setup, then `pg_restore --no-owner --role=local_llm` before the first `make backend`.
  - **Verification:**
    - `docker compose config` resolves the volume to `local-llm_postgres-data`.
    - A real `up` under a throwaway project name creates role and database `local_llm` (superuser, `SCRAM-SHA-256` password, so a later rename would not clear it) and `CREATE EXTENSION vector` works (0.8.7). Torn down with `down -v`; no volume left behind.
    - pytest 308 passed, 1 skipped; pre-commit passed; 0 broken links.
  - **Audit allowlist addition:** the old names `openwebui` / `open-web-ui_postgres-data` remain only where they describe the old setup: the restore instructions in README, the history comment in `infra/docker-compose.yml`, and MAP.md's one-line history.
- **6a (remove the community hub and upstream services).**
  - **Frontend:**
    - Removed the Share action and "Made by Open WebUI Community" footer on Models, Prompts and Tools, and the Share action and `CommunityDiscover` (file deleted) on Functions.
    - Removed the cross-window hub import (`COMMUNITY_ORIGINS` plus `postMessage` listeners) from the four create pages. The clone/link-import `sessionStorage` path stays.
    - Removed the `*SharePayload` helpers and their tests.
    - Settings > About: no update check, no Discord/X/GitHub links, no license-purchase line. The copyright and license lines are kept unchanged, plus one sentence pointing at NOTICE.
    - Admin > General: the AboutBlock is reduced to the version; the Help/community links, license/"Upgrade" panel and Community Sharing switch are gone.
    - Admin > Users: the seat-limit badge and "License Error" banner are gone. The over-50-users notice now cites clause 4(i) and NOTICE, with no sponsorship or enterprise links; it shows whenever there are more than 50 users.
    - AuthPage: the license-metadata login footer is gone.
    - API clients removed: `getVersionUpdates`, `exportChatStats`, `exportSingleChatStats`, `downloadChatStats`.
  - **Backend:**
    - `ENABLE_COMMUNITY_SHARING` (config default, `features` flag, AdminConfig field and key map) removed, along with both `/api/v1/chats/stats/export*` endpoints and their helpers.
    - `GET /api/version/updates` and `ENABLE_VERSION_UPDATE_CHECK` removed.
    - The license server is gone: `LICENSE_KEY`, `LICENSE_BLOB(_PATH)`, `LICENSE_PUBLIC_KEY`, `get_license_data`, `override_static`, `app.state.LICENSE_METADATA`/`USER_COUNT`, and `license_metadata`/`active_entries`/`user_count`/`metadata` in `/api/config`.
    - The `CUSTOM_NAME` fetch from api.openwebui.com and the OpenRouter `HTTP-Referer`/`X-Title` headers are removed.
    - `main.py` and `utils/webhook.py` now import `WEBUI_NAME`/`WEBUI_FAVICON_URL` from `env` instead of through `config.py`, so a future unused-import autofix in `config.py` cannot break startup (the #39 failure mode). Only imports this change made unused were removed, checked by diffing ruff F401 against `main`.
  - Stale DB config rows such as `ui.enable_community_sharing` stay inert; no migration.
  - e2e: removed the four tests of removed features (hub pre-fill for prompts/tools, the seat-limit licence, the update check), and reworded the functions "posted message" test.
  - **Verification:**
    - pre-commit passed; pytest 308 passed, 1 skipped.
    - Scratch boot OK: `/api/version/updates` is no longer an endpoint (SPA HTML). Schema identical.
    - astro check 0 errors; Vitest 584 passed (588 minus the 4 share-payload tests); build OK.
    - Playwright locally: 340 passed, 4 failed. The 4 (admin-evaluations' first tests and admin-settings' "redirects into the modal" and "Models" list) are 5-second cold-start timeouts that fail **identically on `main`** in a clean worktree, with the machine at a load average of about 7. They pass when run alone. CI is the gate.
- **6b (environment variables `WEBUI_*` → `LLLM_*`).**
  - Word-boundary rename across `apps/server` (excluding `migrations/versions/`) of the env-backed names and their Python constants:
    - `SECRET_KEY`, `AUTH`, `NAME`, `BUILD_HASH`
    - `ADMIN_{EMAIL,PASSWORD,NAME}`
    - `AUTH_TRUSTED_{EMAIL,NAME,GROUPS,ROLE}_HEADER`
    - `{SESSION,AUTH}_COOKIE_{SAME_SITE,SECURE}`
    - `AUTH_SIGNOUT_REDIRECT_URL`
  - This includes `app.state.LLLM_NAME` and the `getattr(..., 'LLLM_NAME', ...)` lookups.
  - `WEBUI_URL` and `WEBUI_BANNERS` change only their env keys (`LLLM_URL`, `LLLM_BANNERS`), because the Python names are also the admin-config API field and config-row names.
  - The deprecated `WEBUI_JWT_SECRET_KEY` fallback is removed. `WEBUI_BACKEND_URL` became `LLLM_BACKEND_URL` (`astro.config.mjs`, Makefile). `WEBUI_FAVICON_URL` (a constant, not an env var) is left for 6c.
  - `make backend` now names any of `OPENROUTER_API_KEY`, `POSTGRES_PASSWORD`, `LLLM_SECRET_KEY` missing from `infra/.env` (with a hint about the rename) instead of failing later at import.
  - CI env, `infra/.env.example`, README "Running it", AGENTS.md and the guides updated.
  - **Verification:**
    - pre-commit passed; pytest 308 passed, 1 skipped (with `LLLM_SECRET_KEY`).
    - Importing `env` with only `WEBUI_SECRET_KEY` set is refused with the new message.
    - The Makefile's missing-key check rejects an old-style `.env` and accepts a new one, tested in isolation (`infra/.env` itself is never read).
    - Scratch boot OK; schema identical.
  - **You need to:** rename the key in `infra/.env` (§8 A): `sed -i 's/^WEBUI_SECRET_KEY=/LLLM_SECRET_KEY=/' infra/.env`.

