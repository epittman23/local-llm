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
├── README.md                  usage/operations guide
├── MAP.md                     this file
├── requirements.txt           core Python deps (llama-console CLI helpers)
├── .gitmodules                declares the open-web-ui/openwebui submodule
├── docs/                      meta docs: conventions, roadmap, proposals
├── open-web-ui/               integration layer + vendored Open WebUI fork
└── scripts/                   llama-console CLI + shell serving orchestration
```

Local/generated (not tracked by git — see "Local/generated" section below
for detail): `.venv/`, `.vscode/`, `.claude/`, `logs/`, `tests/data/`
(orphaned, see below), and scattered `__pycache__/` directories.

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

## `open-web-ui/`

The integration layer around the vendored Open WebUI fork, plus the fork
itself.

- **`docker-compose.yml`** — Postgres + pgvector service backing the fork.
- **`.env`** — secrets (API keys, DB password, webui secret key); not
  enumerated here.
- **`openwebui/`** — the submodule (mapped below).

### `open-web-ui/openwebui/` (git submodule)

A pinned fork of [`open-webui/open-webui`](https://github.com/open-webui/open-webui)
(currently v0.11.3, tracked via `.gitmodules` at
`https://github.com/epittman23/open-webui.git`), checked out on its own
`customizations` branch (off the pinned tag) rather than detached HEAD, so
this repo's own additions to the fork have somewhere to live as real commits.
This is otherwise upstream-owned code we don't hand-edit except through the
fork's own commits — see its own `README.md`/`CHANGELOG.md` for upstream
feature docs, not restated here. A SvelteKit + FastAPI app:

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

- **`stats.py`** — percentiles, GPU throttle-bitmask decoding, config-text
  parsing, the server load-log parser. Pure functions.
- **`proc.py`** — `Command`, the async subprocess wrapper (process-group
  start/stop/interrupt) that launches `lllm-serve` and tuning candidates via
  `LLAMA_ENV_SH` (points at `scripts/shell/main.sh`).
- **`env_profile.py`** — resolves a serving profile and what's actually
  being served, by shelling out to `main.sh` (never a second copy of the
  profile table).
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
  paired throughput ranking, GPU-cooldown/drift handling).
- **`telemetry_recorder.py`** — the GPU telemetry recorder, still a
  detached subprocess (spawned by `scripts/shell/vram-log.sh`) for
  crash-independence, now writing to this app's Postgres via plain
  `psycopg` instead of a bare-`python3`/stdlib-only sqlite writer.
- **`scripts/backfill_from_sqlite.py`** — one-time migration of the old
  `logs/llama.db` (see below) into these Postgres tables. Already run; kept
  for reference/disaster-recovery, not part of any regular workflow.

## `scripts/`

What's left after the testing/dashboard/report suite moved into the fork
(see above): `llama_console.py` (Rich/plain terminal rendering plus
`profile_names`/`profile_json`, backing `lllm-profiles`/`lllm-check`/
`lllm-vram`) and `shell/`.

- **`shell/main.sh`** — source of truth for local serving config; starts
  `lllm-frontend`/`lllm-backend`; defines every `lllm-*` shell command.
- **`shell/vram-log.sh`** — GPU telemetry capture entrypoint; resolves the
  config fingerprint in shell and hands off to
  `open_webui.benchmarks.telemetry_recorder`.

Per-module purpose and rationale are documented in detail in
[`docs/CLAUDE.md`](docs/CLAUDE.md)'s "Conventions" section — this entry is a
summary, not a replacement.

## `.gitmodules`

Declares the `open-web-ui/openwebui` submodule (see above).

## Local/generated (not tracked)

Present on disk but gitignored — won't show up in `git ls-files`, but worth
knowing about when navigating the filesystem directly:

- **`.venv/`** — Python virtualenv.
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
- **`__pycache__/`** — Python bytecode cache, scattered under `scripts/` and
  the submodule.
