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
- **Math, statistics, and reasoning**: `deepseek/deepseek-r1-distill-qwen-32b`
  Used for step-by-step mathematical reasoning and statistical analysis. Enable/
  surface the model's reasoning trace where useful for verifying its work.
- **Alternative reasoning model to evaluate**: `qwen/qwq-32b`
  Being A/B tested against the DeepSeek distill on real math/statistics tasks. The model
  selection for this role is not yet final; note observations in this file's
  "Decisions log" section below as they accumulate.

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

- Language/framework: _fill in once decided_
- Testing approach: _fill in once decided_
- Directory structure: _fill in once established_

## Commands

- _fill in build/run/test commands once the project scaffold exists_

## Decisions log

- Keep a short, dated log here of model evaluation results and any changes to the
  model/provider choices above, so future sessions have that context without needing
  to re-derive it.
