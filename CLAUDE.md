# Personal AI Assistant Project

## Why

A personal AI assistant built for private, unlimited use, prioritizing:
1. **Privacy**: user data and prompts should not be exposed to third parties beyond what is
   strictly necessary during the current cloud-prototyping phase.
2. **No usage limits**: avoid being constrained by consumer chat-app rate limits.
3. **Primary use cases**: math, statistics, data analysis, and coding assistance.

## Current phase: cloud prototyping

The project currently runs against cloud-hosted open-weight models via OpenRouter
(https://openrouter.ai), using its OpenAI-compatible API. This is a deliberate choice:
it lets the assistant's code, prompts, and tool-calling logic remain unchanged when the
project migrates to self-hosted, local inference later. **Do not introduce
provider-specific APIs or SDKs that would need to be rewritten during that migration.**
Stick to the OpenAI-compatible `chat/completions` interface throughout.

## Models in use

Two specialized models are used, selected on a per-task basis:

- **Coding**: `qwen/qwen-2.5-coder-32b-instruct`
  Used for code generation, review, and debugging tasks.
- **Math, statistics, and reasoning**: `qwen/qwen3-32b`
  Used for step-by-step mathematical reasoning and statistical analysis. Supports a
  native thinking mode (`include_reasoning` param); surface the reasoning trace where
  useful for verifying its work.
- **Alternative reasoning model to evaluate**: `qwen/qwen3-32b`
  Currently the same model as the primary slot (see 2026-07-19 decision below) — both
  prior candidates for this role were removed from OpenRouter. Replace with a distinct
  candidate once one is identified, to resume the A/B evaluation.

Model names should be read from a config value or environment variable, never
hardcoded inline, so switching models (during evaluation, or at local-migration time)
requires no code changes.

## Migration plan (for future reference)

This project is expected to eventually run on self-hosted hardware. Both models above
are chosen specifically because they are realistically self-hostable on a single
high-VRAM consumer GPU (24GB+) at Q4 quantization or better. When that migration
happens, only the API base URL and (if applicable) API key handling should need to
change; do not build features that assume a cloud-only environment.

## Conventions

- Language/framework: Python backend (FastAPI + `openai` client), TypeScript/React
  frontend (Bun, Vite, [assistant-ui](https://www.assistant-ui.com)).
- Testing approach: _fill in once decided_ — no automated test suite exists yet.
  Backend/API changes are currently verified with `curl` against the running
  server; frontend changes with `bun run build` (type-checking) plus manual/
  browser verification.
- Directory structure: two self-contained sibling projects, `backend/` and
  `frontend/`, each with its own dependency manifest (`backend/requirements.txt`,
  `frontend/package.json`). `backend/src/` holds assistant logic shared by both
  the CLI (`backend/main.py`) and the web API (`backend/server.py` +
  `backend/src/api/`); `frontend/src/` holds the React app. See the repo root
  `README.md` for the full tree.
- The user is always the one who runs `backend/main.py` and interfaces with the
  assistant directly via the CLI. Claude Code should never invoke it itself
  (including for testing or verification) unless the user explicitly instructs
  it to do so for that specific instance. The FastAPI server (`backend/server.py`)
  and frontend dev server are not covered by this restriction — those may be
  started/exercised directly (e.g. via `curl`, a browser, or Playwright) when
  verifying web-facing changes, since they aren't the user's direct CLI
  interface.
- The CLI and web UI share the same session storage (`backend/src/memory.py`'s
  `Conversation`, persisted under `backend/sessions/`) — a session started in
  one can be continued in the other.

## Commands

- Backend: `cd backend && pip install -r requirements.txt`, then
  `python main.py "..."` (CLI) or `uvicorn server:app --reload --port 8000` (API
  server for the web frontend).
- Frontend: `cd frontend && bun install && bun run dev` (requires the API server
  running for `/api/*` requests, proxied to `localhost:8000` in dev). `bun run
  build` type-checks and produces a production bundle.
- Usage analysis: `cd backend && python scripts/analyze_logs.py`.

## Decisions log

- Keep a short, dated log here of model evaluation results and any changes to the
  model/provider choices above, so future sessions have that context without needing
  to re-derive it.
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
