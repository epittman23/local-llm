# local-llm: agent and contributor guide

This is the always-loaded guide for anyone, human or agent, changing this
repository. `CLAUDE.md` is a symlink to it. It covers why the project
exists, the rules it runs by, and where the deeper documentation lives.
How to run the app is in [README.md](README.md). The backend began as a fork
of Open WebUI v0.11.3; see [NOTICE](NOTICE) for what is
derived and under which license.

## Why

A personal AI assistant built for private, unlimited use, prioritizing:

1. **Privacy**: user data and prompts should not be exposed to third parties
   beyond what is strictly necessary during the current cloud-prototyping
   phase.
2. **No usage limits**: avoid being constrained by consumer chat-app rate
   limits.
3. **Primary use cases**: math, statistics, data analysis, and coding
   assistance.

## Current phase

The assistant runs against cloud-hosted open-weight models through
OpenRouter (https://openrouter.ai), using its OpenAI-compatible API. Local
inference is under evaluation in parallel: a llama.cpp `llama-server`,
started from the app's own Benchmarks > Serve page, serves the same
OpenAI-compatible API on port 8090. It is **not** the default backing for
chat; OpenRouter stays the day-to-day path until local throughput is
acceptable. Moving chat to local inference is a change to the connection's
base URL and API key in Admin Settings > Connections, nothing more.

## Models in use

Each model is a separate entry under Workspace > Models in the app, so
switching between them is a model-picker choice, not a code path. The exact
entries and their system prompt are in
[README.md](README.md#model-setup).

- **Coding**: `qwen/qwen-2.5-coder-32b-instruct` (OpenRouter). Code
  generation, review, and debugging.
- **Math, statistics, and reasoning**: `qwen/qwen3.6-27b` (OpenRouter).
- **Alternative reasoning model to evaluate**: currently unset. Resuming
  that evaluation would mean adding a third model entry with a distinct
  candidate model.

Local models, all evaluation only, one serving profile each:

| Profile | File | Shape | Size | Notes |
|---|---|---|---|---|
| `qwen38` | `Qwen3.8-27B-UD-Q3_K_XL.gguf` | dense | 12.24 GiB | partially offloaded (`-ngl 20`), MTP speculative decoding; the only weights on disk as of 2026-10-09 |
| `qwen36` | `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` | MoE, ~3 B active | 20.81 GiB | `-ngl 99 --n-cpu-moe 34`; sparse MoE keeps per-token compute small with most weights in system RAM |
| `qwen25c` | `Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf` | dense, 7.6 B | 4.36 GiB | the only model fully GPU-resident on the 6 GB card; coding only, not a thinking model; unmeasured |
| `qwen3c` | `Qwen3-Coder-30B-A3B-Instruct-Q4_1.gguf` | MoE | 17.87 GiB | copies `qwen36`'s shape as an unverified starting point; coding only; unmeasured |

## Local inference

Hardware: NVIDIA GeForce RTX 3060 Laptop, 6 GB VRAM, compute capability 8.6,
on native Fedora 44 since 2026-10-09. Every recorded measurement was taken
under WSL2 on the same laptop, so all of them are historical until
re-measured. Neither the CUDA toolkit nor the llama.cpp build exists on the
Fedora machine yet (2026-10-09).

- **Profiles** are versioned rows in Postgres (`benchmark_profile`,
  `benchmark_profile_version`), resolved by
  `apps/server/local_llm/benchmarks/serving/profiles.py`. Every
  profile serves one slot (`--parallel 1`), passed unconditionally.
- **Serving** starts from Benchmarks > Serve (`/benchmarks/serve`).
  `serving/launcher.py`'s `ServeProcess` spawns `llama-server` and the GPU
  telemetry recorder, which writes every sample, `/metrics` scrape and
  request timing into the app's own Postgres.
- **Measuring**: the Tests page runs scored items from HumanEval, MBPP and
  DS-1000 against whatever is being served; Compare ranks configurations by
  pass rate and passes per minute; Report writes the statistical comparison,
  auditing the design first. Coding and data analysis are covered; math and
  statistics are not yet.
- **Last measured** (historical, WSL2, llama.cpp build 10472): `qwen36` at
  about 7-8 tokens/s generation and 72-78 tokens/s prompt processing, bound
  by system-RAM bandwidth for the CPU-resident experts. That is roughly an
  order of magnitude slower than OpenRouter, which is why local is not the
  default. The models are thinking models, so reasoning tokens dominate the
  budget on short prompts and wall-clock latency is worse than tokens/s
  suggests.

Details: [docs/guides/llama-cpp.md](docs/guides/llama-cpp.md) (building,
profiles, serving, measurements), [docs/guides/telemetry.md](docs/guides/telemetry.md)
(what is recorded and how to read it), and
[docs/guides/benchmarks.md](docs/guides/benchmarks.md) (testing, comparing,
reporting).

## Moving to self-hosted hardware

The project is expected to run on self-hosted hardware eventually (see
[docs/proposals/](docs/proposals/proposed-inference-server.md)). The cloud
models above were chosen because they are realistically self-hostable on a
single high-VRAM consumer GPU (24 GB+) at Q4 or better. When that happens,
only the connection's base URL and API key change; **do not build features
that assume a cloud-only environment.**

## Repository layout

[MAP.md](MAP.md) is the structural index: what lives where. In short:
`apps/server/` is the FastAPI backend (its package is
`apps/server/local_llm/`), `apps/web/` is the Astro + React +
shadcn/ui frontend, `infra/` holds the Postgres + pgvector Compose file, and
`docs/` holds the decisions log, roadmap, guides, proposals and history.

## Conventions

- **This repo holds the application.** All of it is owned code. The backend
  is a permanent hard fork with no upstream sync path, so it is restructured
  and edited freely, and inherited code gets the same scrutiny as new code.
- **The Makefile stays thin.** It owns process lifecycle (Postgres, the
  backend venv, the two servers) and nothing else; behaviour belongs in the
  apps.
- **Serving configuration has one source of truth**: `serving/profiles.py`,
  backed by Postgres. Model and system-prompt configuration for the
  assistant lives in the app (Admin Settings > Connections; Workspace >
  Models), never in a repo file.
- **The one deliberate copy** is
  `apps/server/local_llm/benchmarks/data/prompts/assistant.txt`,
  which duplicates the deployed system prompt so a local configuration can be
  measured under it. It configures nothing. When the prompt changes in the
  app, copy it there in the same change, or the benchmark measures a prompt
  nobody uses. Files under `benchmarks/data/prompts/` are identified by a
  sha of their exact bytes: never reformat them incidentally.
- **Two kinds of testing.** Changes to the app are verified by the
  frontend's Vitest and Playwright suites, the backend's pytest, and using
  it in the browser; Playwright mocks the backend, so a change across the
  frontend/backend seam also needs a real run. Local serving configurations
  are verified from the Benchmarks pages. See
  [docs/guides/testing.md](docs/guides/testing.md).
- **Comments that read `d863707:apps/openwebui/...`** name the SvelteKit
  file a frontend piece was ported from (`git show d863707:<path>`). They
  are git paths; leave them as they are.

## Commands

- `make backend`: Postgres plus the backend (`uvicorn --reload` on
  `127.0.0.1:4000`), which also serves the last build of `apps/web` at `/`.
  It owns Postgres's lifecycle: up before uvicorn, down on exit, Ctrl-C
  included. `make backend LLLM_BACKEND_HOST=0.0.0.0` exposes it to the LAN.
- `make frontend`: the hot-reloading dev server on `:5174`, proxying the API
  to `:4000`. Only needed while editing the UI.
- `cd apps/web && bun run build`: rebuild the UI that `make backend` serves.
- `infra/.env` (gitignored) holds `OPENROUTER_API_KEY`, `POSTGRES_PASSWORD`
  and `WEBUI_SECRET_KEY`.
- Tests: `bun run test:unit`, `bun run test:e2e` (use `--workers=2`) and
  `bunx astro check` in `apps/web`; pytest in `apps/server` (see
  [docs/guides/testing.md](docs/guides/testing.md)).
- Lint and format: `pre-commit run --all-files`
  (`.pre-commit-config.yaml` is the only definition; CI runs the same file).
- Requirements: native Linux (Fedora 44 since 2026-10-09), Docker Engine with
  the Compose plugin and the user in the `docker` group, `make`, Bun,
  Node ≥ 22.12, and **uv**, which builds the backend venv from
  `apps/server/pyproject.toml` + `uv.lock` and supplies Python 3.12
  (the system `python3` is 3.14). Local serving also needs llama.cpp built
  with CUDA at `~/llama.cpp/build/bin` (`LLAMA_BIN`).

## Backend (`apps/server`)

- Dependencies live only in `apps/server/pyproject.toml` + `uv.lock`; change
  them with `uv add` / `uv lock` from `apps/server/`. CI fails if the lock
  doesn't match. torch is the CPU build; optional backends this install
  doesn't use are in the `all` extra. See
  [docs/guides/dependencies.md](docs/guides/dependencies.md).
- `make backend` sets `HF_HUB_OFFLINE=1`: embedding and reranking models
  must already be in the Hugging Face cache, or knowledge uploads won't
  embed (see the guide above).
- `make backend` pins `DATA_DIR` to `apps/server/data` (uploads, caches,
  benchmark datasets and reports), so the location never moves with the
  code; a hand-started backend defaults to the same place.
- The database schema is append-only (see the maintenance policy).

## Frontend (`apps/web`)

- **`astro dev` always daemonizes** in this Astro version, even without
  `--background`. Start it with `astro dev --background` and manage it with
  `astro dev stop`, `astro dev status` and `astro dev logs`. `make frontend`
  and Playwright's `webServer` already handle this; a bare `bun run dev`
  leaves a server running after Ctrl-C.
- **Run `astro dev` on Node, not Bun** (no `bunx --bun`): Vite's websocket
  proxy calls `socket.destroySoon()`, which Bun lacks.
- Add shadcn/ui components with `bunx --bun shadcn add <name>`.
- More: [docs/guides/frontend.md](docs/guides/frontend.md). Astro's own
  documentation is at https://docs.astro.build; consult the relevant guide
  before working on:
  - [pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
  - [Astro components](https://docs.astro.build/en/basics/astro-components/)
  - [React or other framework components](https://docs.astro.build/en/guides/framework-components/)
  - [content](https://docs.astro.build/en/guides/content-collections/)
  - [styles or Tailwind](https://docs.astro.build/en/guides/styling/)
  - [multiple languages](https://docs.astro.build/en/guides/internationalization/)

## Maintenance policy

Documentation is the durable record of this project, so keeping it current
is part of every change, not a follow-up task. Whoever makes a change (human
or agent) updates the docs in the same commit:

- **Any change to models, providers, endpoints, or serving flags** is
  reflected in "Models in use" and/or "Local inference" above, and in
  [docs/guides/llama-cpp.md](docs/guides/llama-cpp.md), before the work is
  considered done.
- **Any change that alters a decision** (a model swapped, a provider
  dropped, a tool replaced, an evaluation concluded) gets a new dated entry
  at the top of the list in [docs/decisions.md](docs/decisions.md), stating
  what changed and why. Never edit older entries; they are history, so add a
  new entry instead. Use absolute dates, never "recently" or "last week".
- **Benchmark numbers carry their context**: whenever a measurement is
  recorded in `docs/guides/` (llama-cpp.md or benchmarks.md), record beside
  it the hardware, the model file, the llama.cpp build, and the flags used.
  A number without its configuration is not reusable. Numbers that predate a
  hardware or model change are stale; re-measure or mark them historical.
- **Code and docs must agree**: if `serving/profiles.py`,
  `serving/launcher.py`, the root `Makefile`, or `infra/docker-compose.yml`
  changes its defaults, flags, or function names, update the description of
  it in README.md or the guides in the same change. The configuration lines
  recorded with every serving run mirror the flags the launcher passes, so a
  change to those flags must be reflected in `serving/fingerprint.py` too,
  or old and new runs get fingerprinted as the same configuration.
- **The database schema is append-only.** Migrations are ordinary Alembic
  revisions under `apps/server/local_llm/migrations/versions/`; add
  one, never edit one that has been applied. When a change alters what the
  `config_id` fingerprint covers (which changes every existing id and makes
  rows either side of it incomparable), add a `benchmark_schema_note` row
  saying so, in the same change, so the database explains its own
  discontinuities.
- **Do not document aspirations as facts.** Anything not yet running is
  stated as planned or under evaluation, with what would make it the
  default.
- **Prune what is no longer true.** When a section describes something that
  no longer exists, delete it and log the deletion; dead configuration left
  in place has repeatedly cost time in this project.
- **`docs/ROADMAP.md` and `docs/roadmap-timeline.mmd` move with the
  decisions log.** Whenever a change adds a dated entry to
  `docs/decisions.md`, also add the corresponding milestone to
  `roadmap-timeline.mmd` and, if it changes what's next, revise the
  timeframes in ROADMAP.md's "Planned future additions" table. The `.mmd`
  file is canonical; ROADMAP.md embeds a copy in a fenced `mermaid` block
  only because GitHub cannot transclude a file, so the two are updated
  together and stay byte-identical in their diagram content.
- **`MAP.md` mirrors the repo layout.** Whenever a change adds, removes,
  moves, or repurposes a top-level directory or a major file, update its
  entry in `MAP.md` in the same change. MAP.md is a structural index only;
  rationale and conventions stay here.
- **README.md's "Running it" and "Pages and URLs" mirror how the app runs
  today.** Whenever a change alters how the backend or frontend is started
  (the Makefile targets, ports, required `infra/.env` keys, tool versions),
  or adds, removes, renames or changes the query parameters of a URL the
  frontend serves (`apps/web/src/routes/AppRouter.tsx` / `routePaths.ts`),
  update those sections in the same change.

## Commit policy

All commits use conventional commit style and stay focused on one topic.
Work on a branch and open a pull request: `main` accepts squash-merged PRs
only, after the required `CI passed` check. Do not add yourself as a
co-author in commits or pull requests; this includes adding
"🤖 Generated with Claude Code" or
"Co-Authored-By: Claude <model> <noreply@anthropic.com>".

## Deeper docs

| Doc | What it holds |
|---|---|
| [README.md](README.md) | running the app, every page and URL, model setup |
| [MAP.md](MAP.md) | where everything lives |
| [docs/decisions.md](docs/decisions.md) | dated log of why things are the way they are |
| [docs/ROADMAP.md](docs/ROADMAP.md) | history and planned direction |
| [docs/guides/](docs/guides/) | llama.cpp, telemetry, benchmarks, testing, dependencies, frontend, model downloads |
| [docs/proposals/](docs/proposals/) | not yet built (the dedicated inference server) |
| [docs/history/](docs/history/) | completed records: the migration plan, reviews, migration-era mappings |
| [docs/serving-baseline/](docs/serving-baseline/README.md) | test input pinning the serving fingerprint |
