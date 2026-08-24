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
`scripts/llama-env.sh` helpers.

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

The 20.81 GiB model cannot fit in 6 GB, so the `qwen36` profile offloads all
layers (`-ngl 99`) but keeps the MoE expert tensors of 34 layers in system RAM
(`--n-cpu-moe 34`), with a q8_0-quantized KV cache and flash attention to fit
64K of context. Serving and benchmarking helpers live in
`scripts/llama-env.sh` (sourced from `~/.bashrc`), which groups settings into
per-model profiles (`qwen36` MoE, `qwen38` dense) rather than loose env vars;
`llama-serve` starts them and `llama-qwen` remains as an alias. Every profile
serves one server slot (`--parallel 1`, `LLAMA_PARALLEL` to override), passed
unconditionally rather than as part of any other flag group. Every serving
run also records GPU telemetry via `scripts/llama-vram-log.sh` into
`logs/<model>-<quant>.log` (gitignored), alongside the throughput of every
`llama-test` request and the server's own `/metrics` totals for the run;
`scripts/llama_log.py` assembles those files. README.md documents each function
and records the measured numbers.

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
  (`openWebUI-docker` to run the container, `scripts/llama-env.sh` for the
  local llama.cpp server and benchmarks, `scripts/llama-vram-log.sh` for GPU
  telemetry capture, `scripts/llama_log.py` for assembling the log files), plus
  `prompts/` — the fixed prompts `llama-test` sends
  when comparing serving configurations. Shell scripts here are operational glue,
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
- **Shell scripts and docs must agree**: if `scripts/llama-env.sh`,
  `scripts/llama-vram-log.sh`, or `openWebUI-docker` changes its defaults,
  flags, or function names, update the `README.md` description of it in the
  same change. `scripts/llama-env.sh` is the source of truth for the local
  serving configuration; if it drifts from `~/.bashrc`, reconcile the two
  rather than letting both exist. The configuration lines written into the
  telemetry logs mirror the flags `llama-serve` passes, so a change to those
  flags must be reflected in `_vramlog_config` too, or old and new runs get
  fingerprinted as the same configuration.
- **Do not document aspirations as facts.** Anything not yet running is stated
  as planned or under evaluation, with what would make it the default.
- **Prune what is no longer true.** When a section describes something that no
  longer exists, delete it and log the deletion; leaving dead configuration in
  place has repeatedly cost time in this project.

## Decisions log

- Keep a short, dated log here of model evaluation results and any changes to the
  model/provider choices above, so future sessions have that context without needing
  to re-derive it.
- **2026-08-23**: `--parallel 1` moved out of `qwen38`'s speculative flags into
  its own profile variable (`LLAMA_P_PARALLEL`, default 1, override
  `LLAMA_PARALLEL`) and is now always passed by `llama-serve`. Bundled with
  `--spec-type draft-mtp ...`, it disappeared whenever `LLAMA_SPEC=off` dropped
  those flags — and omitting `--parallel` is not the same as passing 1:
  llama-server defaults it to `-1` (auto), which resolves to 4 slots with
  `kv_unified = true` (build 10597, `common/arg.cpp:1400`,
  `tools/server/server.cpp:152-155`). Every non-speculative baseline therefore
  ran a different attention/KV configuration from the speculative run it was
  meant to be the baseline for, measured at 15.63 t/s prompt processing at
  `n_slots = 4` against 26.38 t/s at `n_slots = 1`. Consequence: the MTP
  measurement logged below still has no valid baseline, and any
  speculative-vs-plain comparison made before this date should be discarded,
  not adjusted. Checked rather than assumed while fixing this: `-c` is the
  *total* context, which non-unified slots divide between them
  (`src/llama-context.cpp:291-301`), so the old auto path was not "4x the KV
  cache" — it was 4 slots sharing one unified cache of the same size. Passing
  `--parallel` inside `LLAMA_SPEC` is now refused outright, since it would be
  sent twice and recorded wrong. `--parallel` also joined the telemetry
  `config-id` fingerprint, which by construction changes every existing id;
  `scripts/llama_log.py` now writes a dated note into each log file's header
  saying so, and a block with no `parallel:` line is one whose slot count was
  never recorded.
- **2026-08-23**: Serving logs now record throughput, not just GPU telemetry.
  Each configuration block gained `### previous runs - requests` (per-run
  totals and averages over the `llama-test` requests made during that run:
  prompt tokens, prompt parse time, output tokens, output time, end-to-end
  time) and `### previous runs - server totals` (deltas of the server's
  `/metrics` counters), plus a `#### requests` table carrying llama.cpp's raw
  `timings` fields per request. `llama-serve` now always passes `--metrics`;
  that flag is deliberately excluded from the config fingerprint, like the
  build string, because it does not change inference and including it would
  re-fingerprint every existing block. The two throughput tables are kept
  separate rather than combined because they measure different populations:
  `llama-test` requests are exact, per-request, and use a version-controlled
  prompt at temperature 0, but miss Open WebUI traffic; `/metrics` sees every
  client but exposes only cumulative counters, and as of build 10597 has no
  request counter at all (checked in `tools/server/server-task.cpp`), so that
  table has no request count. End-to-end time is the wall clock `llama-test`
  measures, not `prompt_ms + predicted_ms`, because on a streamed response the
  two differ and the wall clock is what was actually waited. Log assembly moved
  from awk in `scripts/llama-vram-log.sh` to `scripts/llama_log.py`: four
  tables, retention, and eleven statistics were past what the awk merge could
  carry legibly. The shell functions remain the only interface — the Python is
  never called directly. Known limitation, unchanged and now documented in
  `README.md`: the config lines describe the profile as resolved when the
  recorder started, not the argv of the process actually serving, so a
  hand-started server can be filed under a configuration it never ran with.
- **2026-08-23** (later): First measurement of `qwen38` with MTP speculative
  decoding, via `llama-test humaneval0` on build `95b8e33e1` (10597): 2.89 t/s
  generation over 958 completion tokens, 51.4 t/s prompt processing, 690 tokens
  drafted with 613 accepted (88.8% acceptance, covering 72% of the output),
  5519 of 6144 MiB VRAM in use. The MTP head loads and drafts as intended
  (`common_speculative_init_result: creating MTP draft context`). This is not a
  clean A/B: the non-speculative number available for comparison (2.50 t/s) came
  from a server that also ran `-ngl 22` without `-ot`, so the flags differ in
  three ways at once. A `LLAMA_SPEC=off` run under otherwise identical flags is
  still owed before claiming a speedup. Numbers recorded in README.md with their
  full flag set.
- **2026-08-23**: The `qwen38` profile now serves with speculative decoding off
  the model's own MTP head: `--spec-type draft-mtp --spec-draft-n-max 2
  --parallel 1`. No draft model is involved — the GGUF carries
  `qwen35.nextn_predict_layers = 1` and `blk.64.nextn.*` tensors, verified by
  reading the file's metadata, and that block is already pinned to the GPU by
  the `-ot` above. Draft depth is 2 rather than the default 3 because a
  rejected draft is wasted compute on a model whose layers mostly run on the
  CPU; `--parallel 1` because concurrent server slots would contend with
  drafting for the same GPU, and this is a single-user setup. `qwen36` is
  deliberately left without these flags: its weights are not on this machine,
  so whether it has an MTP head is unverified, and passing `draft-mtp` to a
  model without one would fail at load. Both the flags and their absence are in
  the telemetry `config-id` fingerprint, so a speculative run and a plain run
  are logged as separate configurations. Not yet measured against an
  unspeculated baseline: `LLAMA_SPEC=off llama-serve qwen38` is the A/B, and
  `llama-test`'s `draft_n`/`draft_n_accepted` is the acceptance rate to judge
  it by.
- **2026-08-23**: Added `llama-test` to `scripts/llama-env.sh`: it posts a
  saved prompt from `prompts/<name>.txt` to the running server and prints the
  answer plus llama.cpp's `timings` block. The point is comparability while
  tuning `qwen38`'s `-ngl`/`-ot`: the prompt is a file in version control
  rather than retyped, `temperature` is pinned to 0, and the model alias and
  `reasoning_effort` come from the profile, so two runs differ only by the
  serving flags under test. First prompt is `humaneval0` (the HumanEval
  `has_close_elements` task), chosen because coding assistance is a primary use
  case and the answer is easy to eyeball as right or wrong. This is a
  spot-check, not an eval harness: nothing is scored or recorded, and adding
  scoring would mean application code, which this repo deliberately does not
  hold. `llama-test` streams the response (the answer on stdout,
  the model's thinking on stderr, so redirecting stdout captures the completion
  alone); `LLAMA_TEST_STREAM=0` restores a single blocking request. Streaming is
  the default because on this hardware a short prompt spends minutes in
  reasoning tokens before any answer text appears, and a silent terminal for
  that long is indistinguishable from a hung server. The model name is read from the
  running server (`GET /v1/models`) rather than taken from the profile: the
  profile describes an intended configuration, the server is already serving
  something, and the first version of this labelled a run with the default
  profile's alias while a different model answered. A mismatch warns and tests
  what is running.
- **2026-08-23**: The dense `qwen38` profile now pins two tensor groups to the
  GPU with `-ot "output\.weight=CUDA0,blk\.64\..*=CUDA0"` regardless of
  `-ngl`: the output projection and the final block (the model reports
  `block_count = 65`, so blocks run `blk.0` to `blk.64`), both read on every
  token. `-ngl` alone fills layers from the bottom up, so on a 6 GB card the
  last block and the output head are exactly what gets left on the CPU. This is
  a placeholder in the same sense `-ngl 20` is: it has not been measured yet
  against an unpinned run, and `llama-sweep-ngl` now passes the same `-ot` so
  the layer-count sweep reflects the real serving configuration. `-ot` was
  added to the telemetry `config-id` fingerprint (as an `override-tensors`
  line), so runs with and without it are logged as separate configurations and
  are directly comparable. Override per run with `LLAMA_OT`.
- **2026-08-23**: GPU telemetry is now recorded automatically for every local
  serving run. `llama-serve` (in `scripts/llama-env.sh`, which replaced the
  deleted `llama-local.sh` and now carries per-model profiles instead of loose
  env vars) starts `scripts/llama-vram-log.sh` in the background and stops it
  when `llama-server` exits; the recorder also stops on its own once the port
  stops answering, so an interrupted shell cannot leave it sampling. Samples
  (temperature, utilization, memory used/total, power, SM clock, at
  `LLAMA_VRAM_INTERVAL`, default 5 s) are appended to
  `logs/<model-name>-<quant>.log` as markdown tables, grouped into blocks by a
  `config-id` fingerprint over the serving flags and sampler values, so runs
  under different settings are never averaged together. The llama.cpp build is
  recorded per run rather than fingerprinted, so a rebuild does not fragment a
  configuration's history. Retention: only the most recent run of a
  configuration keeps its full sample table; when a newer run finishes, the
  previous one collapses to a single avg/max summary row. This was chosen over
  keeping every sample because a multi-hour session at 5 s intervals is
  thousands of rows, and the reason to keep old runs is comparison, not
  replay. `logs/` is gitignored: the captures are machine-specific and
  regenerated on every run, so README.md and this file stay the durable
  record. Motivation is tuning the dense `qwen38` profile, whose `-ngl 26` is
  still an untested placeholder and needs VRAM-headroom evidence that outlives
  the session. Disable with `LLAMA_VRAM_LOG=0`.
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
