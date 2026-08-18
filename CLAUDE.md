# Personal AI Assistant Project

## Why

A personal AI assistant built for private, unlimited use, prioritizing:
1. **Privacy**: user data and prompts should not be exposed to third parties beyond what is
   strictly necessary during the current cloud-prototyping phase.
2. **No usage limits**: avoid being constrained by consumer chat-app rate limits.
3. **Primary use cases**: math, statistics, data analysis, and coding assistance.

## Current phase: cloud prototyping, with local inference under evaluation

The project currently runs against cloud-hosted open-weight models via OpenRouter
(https://openrouter.ai), using its OpenAI-compatible API, through Open WebUI
(https://github.com/open-webui/open-webui) as the chat interface. This is a
deliberate choice: since Open WebUI talks to any OpenAI-compatible endpoint,
migrating to self-hosted local inference later only requires changing the
connection's base URL/API key in Open WebUI's admin settings — no code changes
anywhere, since there is no custom code in this project anymore (see the
2026-07-21 decision below).

As of 2026-08-17 that migration is being tested in parallel: a local
llama.cpp `llama-server` runs Qwen3.6-35B-A3B on the laptop's RTX 3060 (6 GB)
and serves the same OpenAI-compatible API on port 8090. It is not yet the
default backing for Open WebUI; OpenRouter remains the day-to-day path until
local throughput is acceptable. See "Local inference" below and the
`llama-local.sh` helpers.

## Models in use

Two specialized models are used, registered as separate Open WebUI model
entries (Workspace → Models) so switching between them is a model-picker
choice, not a code path:

- **Coding**: `qwen/qwen-2.5-coder-32b-instruct`
  Used for code generation, review, and debugging tasks.
- **Math, statistics, and reasoning**: `qwen/qwen3.6-27b`
  Used for step-by-step mathematical reasoning and statistical analysis.
- **Alternative reasoning model to evaluate**: currently unset. The previous
  A/B slot (`REASONING_MODEL_ALT`) was a backend config concept that no longer
  exists now that there's no backend; if resuming this evaluation, it would
  mean adding a third Open WebUI model entry with a distinct candidate model.
- **Local (evaluation only)**: `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf`, served by
  llama.cpp under the alias `qwen3.6-35b-a3b`. MoE, 34.66 B total / ~3 B
  active parameters, 20.81 GiB on disk. Chosen because a sparse MoE keeps
  per-token compute small enough to stay usable when most weights live in
  system RAM rather than the 6 GB of VRAM available.

## Local inference

Hardware: NVIDIA GeForce RTX 3060 Laptop, 6 GB VRAM, compute capability 8.6.

The 20.81 GiB model cannot fit in 6 GB, so `llama-qwen` offloads all layers
(`-ngl 99`) but keeps the MoE expert tensors of 34 layers in system RAM
(`--n-cpu-moe 34`), with a q8_0-quantized KV cache and flash attention to fit
64K of context. Serving and benchmarking helpers live in `llama-local.sh`
(sourced from `~/.bashrc`); README.md documents each function and records the
measured numbers.

Current measured performance: ~7 to 8 tokens/s generation and ~72 to 78
tokens/s prompt processing. Generation is bound by system-RAM bandwidth for
the CPU-resident experts, so thread count barely moves it (see the sweep table
in `README.md`); 6 threads is the default because nothing above it pays for
itself. This is roughly an order of magnitude slower than OpenRouter, which is
why local is not yet the default.

Note that the model is a thinking model: responses carry chain of thought in a
separate `reasoning_content` field, and reasoning tokens dominate the token
budget on short prompts, so wall-clock latency is much worse than the raw
tokens/s suggests.

## Migration plan (for future reference)

This project is expected to eventually run on self-hosted hardware. Both models above
are chosen specifically because they are realistically self-hostable on a single
high-VRAM consumer GPU (24GB+) at Q4 quantization or better. When that migration
happens, only the connection's base URL and (if applicable) API key need to change
in Open WebUI's Admin Panel → Settings → Connections; do not build features that
assume a cloud-only environment.

## Conventions

- There is no custom backend or frontend code in this repo — Open WebUI (run
  via Docker) is the entire application. This repo holds documentation
  (`README.md`, `CLAUDE.md`) plus small operational shell scripts
  (`openWebUI-docker` to run the container, `llama-local.sh` for the local
  llama.cpp server and benchmarks). Shell scripts here are operational glue,
  not application code; keep them thin and keep model/prompt configuration in
  Open WebUI.
- Testing approach: verify changes by using Open WebUI directly in the
  browser at `http://localhost:3000` (manual verification — there's no code
  to run automated tests against).
- Model/system-prompt configuration lives inside Open WebUI itself (Admin
  Panel → Settings → Connections; Workspace → Models), not in any file in
  this repo. See `README.md` for the current model entries and system prompt
  text.

## Commands

- Start/ensure the container is running:
  ```bash
  docker run -d \
    -p 3000:8080 \
    -e OPENAI_API_BASE_URL=https://openrouter.ai/api/v1 \
    -e OPENAI_API_KEY=<your OpenRouter API key> \
    -v open-webui:/app/backend/data \
    --name open-webui \
    --restart unless-stopped \
    ghcr.io/open-webui/open-webui:main
  ```
  (only needed once — `--restart unless-stopped` keeps it running across
  reboots; use `docker start open-webui` if the container already exists but
  is stopped).
- Requires Docker Desktop with WSL integration enabled for this distro.

## Maintenance policy

Documentation is the only durable artifact in this repo, so keeping it current
is part of every change, not a follow-up task. Whoever makes a change (human
or agent) updates the docs in the same commit:

- **Any change to models, providers, endpoints, or serving flags** must be
  reflected in "Models in use" and/or "Local inference" above, and in the
  corresponding `README.md` section, before the work is considered done.
- **Any change that alters a decision** (a model swapped, a provider dropped,
  a tool replaced, an evaluation concluded) gets a new dated entry at the top
  of the "Decisions log" below, stating what changed and why. Do not edit
  older entries to reflect new reality; they are a history, so add a new entry
  instead. Use absolute dates, never "recently" or "last week".
- **Benchmark numbers carry their context**: whenever a measurement is
  recorded in `README.md`, record alongside it the hardware, the model file,
  the llama.cpp build, and the flags used. A number without its configuration
  is not reusable. Numbers that predate a hardware or model change are stale;
  re-measure or mark them as historical.
- **Shell scripts and docs must agree**: if `llama-local.sh` or
  `openWebUI-docker` changes its defaults, flags, or function names, update
  the `README.md` description of it in the same change. `llama-local.sh` is
  the source of truth for the local serving configuration; if it drifts from
  `~/.bashrc`, reconcile the two rather than letting both exist.
- **Do not document aspirations as facts.** Anything not yet running is stated
  as planned or under evaluation, with what would make it the default.
- **Prune what is no longer true.** When a section describes something that no
  longer exists, delete it and log the deletion; leaving dead configuration in
  place has repeatedly cost time in this project.

## Decisions log

- Keep a short, dated log here of model evaluation results and any changes to the
  model/provider choices above, so future sessions have that context without needing
  to re-derive it.
- **2026-08-17**: Stood up local inference on the laptop's RTX 3060 (6 GB) as
  a parallel track to OpenRouter, using llama.cpp `llama-server` with
  `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` (34.66 B total / ~3 B active, 20.81 GiB)
  served under the alias `qwen3.6-35b-a3b` on port 8090. Config:
  `-ngl 99 --n-cpu-moe 34 -c 65536 --flash-attn 1 --cache-type-k/v q8_0
  -t 6 -b 512 --ubatch-size 512 --jinja`; the model is ~3.5x larger than
  total VRAM, so all layers are offloaded but the expert tensors of 34 layers
  stay in system RAM. A sparse MoE was chosen over a dense 32 B specifically
  because only ~3 B parameters activate per token, which is what makes
  RAM-resident experts tolerable. Verified end to end with a
  `POST /v1/chat/completions` call, which returns chain of thought in a
  separate `reasoning_content` field. A `llama-bench` thread sweep
  (4,6,8,10,12,14 threads, build `60eeeb608` / 10472) showed generation flat
  at 7.08 to 7.94 t/s and prompt processing at 71.8 to 78.3 t/s, with error
  bars wider than the differences: generation is RAM-bandwidth bound, not
  core-bound, so 6 threads remains the default. At ~5.2 t/s end to end on a
  real request (reasoning tokens dominate), local is roughly an order of
  magnitude slower than OpenRouter, so OpenRouter stays the default backing
  for Open WebUI and local remains under evaluation. The shell functions and
  aliases for this (`llama-qwen`, `llama-sweep-threads`, `llama-check`,
  `llama-vram`) were moved out of `~/.bashrc` into `llama-local.sh` in this
  repo, which is now sourced from `~/.bashrc`. Note the earlier "24GB+ GPU at
  Q4" self-host budget in "Migration plan" was written for dense models; the
  MoE route makes a 6 GB GPU workable, at a large speed cost.
- **2026-07-21**: Replaced the custom React frontend and FastAPI backend (both
  added 2026-07-20, below) with [Open WebUI](https://github.com/open-webui/open-webui),
  run via Docker, connected directly to OpenRouter — the user judged a
  generic, actively-maintained chat UI easier to manage long-term than
  maintaining custom frontend/backend code. `backend/` and `frontend/` were
  deleted entirely, including the CLI (`main.py`), the FastAPI server and its
  bespoke `/api/chat/stream`/`/api/sessions*` routes, the shared
  CLI/web session storage (`backend/sessions/`), and the `usage.jsonl`
  latency/token logging + `analyze_logs.py` A/B tooling — none of these have
  a replacement now that Open WebUI talks to OpenRouter directly, and Open
  WebUI owns its own chat history instead. The coding/reasoning/reasoning_alt
  task selector is replaced by registering one Open WebUI model entry per
  task (see "Models in use" above); the system prompt formerly injected
  server-side from `backend/INSTRUCTIONS.txt` is now set per-model in Open
  WebUI's model config (see `README.md`). No local-migration story is lost:
  swapping the OpenAI-compatible base URL is now done in Open WebUI's
  connection settings instead of a backend `.env` file.
- **2026-07-20**: Added a web frontend replicating Claude.ai's UI/UX
  (assistant-ui + Bun + React, in `frontend/`) backed by a new FastAPI server
  (`backend/server.py` + `backend/src/api/`). This required moving the entire
  Python project from the repo root into `backend/`, so `main.py`,
  `requirements.txt`, `sessions/`, `logs/`, etc. are now under `backend/` — see
  the updated root `README.md`. Added `ask_stream()` (a streaming sibling to
  `ask()`, in `src/assistant.py`) and `list_sessions()` (`src/memory.py`) to
  support the frontend; `ask()`'s signature/behavior is unchanged, so the CLI is
  unaffected. No provider-specific SDKs were introduced on either side.
- **2026-07-19**: `deepseek/deepseek-r1-distill-qwen-32b` (reasoning) and
  `qwen/qwq-32b` (reasoning_alt) both returned 404 "No endpoints found" from
  OpenRouter and are confirmed removed from its catalog (checked via
  `GET /api/v1/models`), not just renamed. The only remaining DeepSeek R1 variants
  are `deepseek-r1-distill-llama-70b` (70B, exceeds the 24GB-GPU-at-Q4 self-host
  budget) and full `deepseek-r1`/`deepseek-r1-0528` (671B MoE, not self-hostable at
  all). Switched both `REASONING_MODEL` and `REASONING_MODEL_ALT` to
  `qwen/qwen3-32b` (dense 32.8B, native thinking mode via `include_reasoning`, fits
  the self-host constraint). This collapses the A/B slot to a single model for now;
  the alt slot needs a genuinely different candidate before evaluation can resume.
