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
├── requirements.txt           core Python deps (CLI helpers)
├── requirements-extra.txt     optional Python deps (report, web dashboard)
├── .gitmodules                declares the open-web-ui/openwebui submodule
├── docs/                      meta docs: conventions, roadmap, proposals
├── open-web-ui/               integration layer + vendored Open WebUI fork
├── prompts/                   system-prompt files used for benchmarking
├── scripts/                   custom lllm-* CLI/dashboard suite
└── tests/                     benchmark adapters, suites, tuning profiles
```

Local/generated (not tracked by git — see "Local/generated" section below
for detail): `.venv/`, `.vscode/`, `.claude/`, `logs/`, and scattered
`__pycache__/` directories.

## `README.md`

The usage/operations guide: running the assistant, model setup, local
inference with llama.cpp, testing/benchmarking (commands, system prompts,
tiers, grading, result storage, `lllm-test compare`, `lllm-report`), and the
web dashboard topology (`lllm-web` alongside the Open WebUI fork). Start here
for "how do I run/use this."

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
- **`dashboard-link.user.js`** — userscript.
- **`plugins/`** — custom Open WebUI Functions/Pipelines (`template.py`,
  `config-testing-and-comparison.py`).
- **`.env`** — secrets (API keys, DB password, webui secret key); not
  enumerated here.
- **`openwebui/`** — the submodule (mapped below).

### `open-web-ui/openwebui/` (git submodule)

A pinned fork of [`open-webui/open-webui`](https://github.com/open-webui/open-webui)
(currently v0.11.3, tracked via `.gitmodules` at
`https://github.com/epittman23/open-webui.git`), checked out detached HEAD
and advanced manually (`git checkout <tag>`), never `git submodule update
--remote`. This is upstream-owned code we don't hand-edit except through the
fork's own commits — see its own `README.md`/`CHANGELOG.md` for feature
docs, not restated here. A SvelteKit + FastAPI app:

- **`backend/open_webui/`** — the FastAPI app: `main.py` (entrypoint),
  `routers/` (API endpoints), `models/` (DB models), `internal/` +
  `migrations/` (Alembic DB migrations), `retrieval/` (RAG), `socket/`
  (websocket/real-time), `tools/`, `tasks.py`, `utils/`, `config.py`.
- **`src/`** — the SvelteKit frontend: `routes/` (pages), `lib/`
  (components/stores/utils), `app.html`/`app.css`.
- **`static/`**, **`docs/`**, **`scripts/`**, **`test/`** — assets, upstream
  docs, dev scripts, upstream test suite.
- Root-level: `Dockerfile`, several `docker-compose.*.yaml` variants
  (gpu/amdgpu/otel/playwright/a1111-test/etc.), `pyproject.toml`/`uv.lock`
  (backend deps), `package.json`/`bun.lock` (frontend deps), `Makefile`,
  `CHANGELOG.md`, `TROUBLESHOOTING.md`.

## `prompts/system/`

Named system-prompt files (`assistant.txt`, `assistant-local.txt`,
`assistant-direct.txt`, `style-only.txt`, `minimal.txt`) used by `lllm-test
--system <name>` for measurement runs, plus a `README.md` explaining each.
These are measurement copies, not what's served to end users in
production — Open WebUI owns that.

## `scripts/`

The custom `lllm-*` CLI/dashboard suite: a flat Python package
(`llama_db.py`, `llama_record.py`, `llama_test.py`, `llama_tune*.py`,
`llama_report.py`, `llama_web*.py`, and others) implementing recording,
testing, tuning, reporting, and a web dashboard, plus:

- **`shell/main.sh`** — source of truth for local serving config; starts
  `lllm-frontend`/`lllm-backend`.
- **`shell/vram-log.sh`** — GPU telemetry capture entrypoint.
- **`llama_web_static/`** — the `lllm-web` dashboard's static frontend
  (`app.js`, `index.html`, `style.css`).

Per-module purpose and rationale are documented in detail in
[`docs/CLAUDE.md`](docs/CLAUDE.md)'s "Conventions" section — this entry is a
summary, not a replacement.

## `tests/`

Benchmark configuration, not application tests.

- **`adapters/*.toml`** — benchmark adapter configs (HumanEval, MBPP,
  DS-1000).
- **`suites/*.toml`** — suite tiering (smoke/standard/full).
- **`tuning/`** — `lllm-tune` search-space profiles, with its own `README.md`
  explaining the grid/constraint syntax.
- **`data/`** — gitignored downloaded benchmark datasets, pinned by
  revision/hash.

## `requirements.txt` / `requirements-extra.txt`

`requirements.txt` covers core deps for the `lllm-*` CLI helpers (table
rendering, DS-1000 grading libs); everything degrades to plain output
without it. `requirements-extra.txt` covers `lllm-report` (scipy,
scikit-learn, matplotlib — mostly optional, with fallbacks) and `lllm-web`
(fastapi, uvicorn — hard requirements, no fallback). See the comments in
each file for exactly what needs what.

## `.gitmodules`

Declares the `open-web-ui/openwebui` submodule (see above).

## Local/generated (not tracked)

Present on disk but gitignored — won't show up in `git ls-files`, but worth
knowing about when navigating the filesystem directly:

- **`.venv/`** — Python virtualenv.
- **`.vscode/`** — editor config (currently empty).
- **`.claude/`** — Claude Code local state (`settings.local.json`,
  scheduled task locks).
- **`logs/`** — runtime output: `llama.db` (sqlite), server logs, and dated
  `report/<date>/` benchmark report artifacts (figures + markdown).
- **`__pycache__/`** — Python bytecode cache, scattered under `scripts/` and
  the submodule.
