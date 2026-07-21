# Personal AI Assistant Project

## Why

A personal AI assistant built for private, unlimited use, prioritizing:
1. **Privacy**: user data and prompts should not be exposed to third parties beyond what is
   strictly necessary during the current cloud-prototyping phase.
2. **No usage limits**: avoid being constrained by consumer chat-app rate limits.
3. **Primary use cases**: math, statistics, data analysis, and coding assistance.

## Current phase: cloud prototyping

The project currently runs against cloud-hosted open-weight models via OpenRouter
(https://openrouter.ai), using its OpenAI-compatible API, through Open WebUI
(https://github.com/open-webui/open-webui) as the chat interface. This is a
deliberate choice: since Open WebUI talks to any OpenAI-compatible endpoint,
migrating to self-hosted local inference later only requires changing the
connection's base URL/API key in Open WebUI's admin settings — no code changes
anywhere, since there is no custom code in this project anymore (see the
2026-07-21 decision below).

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

## Migration plan (for future reference)

This project is expected to eventually run on self-hosted hardware. Both models above
are chosen specifically because they are realistically self-hostable on a single
high-VRAM consumer GPU (24GB+) at Q4 quantization or better. When that migration
happens, only the connection's base URL and (if applicable) API key need to change
in Open WebUI's Admin Panel → Settings → Connections; do not build features that
assume a cloud-only environment.

## Conventions

- There is no custom backend or frontend code in this repo — Open WebUI (run
  via Docker) is the entire application. This repo now only holds
  documentation (`README.md`, `CLAUDE.md`) describing how it's configured and
  run.
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

## Decisions log

- Keep a short, dated log here of model evaluation results and any changes to the
  model/provider choices above, so future sessions have that context without needing
  to re-derive it.
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
