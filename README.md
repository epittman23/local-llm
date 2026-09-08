# Personal AI Assistant

A personal AI assistant running on cloud-hosted open-weight models via
OpenRouter, using a pinned fork of [Open WebUI](https://github.com/open-webui/open-webui)
(`open-web-ui/openwebui`, a git submodule) as the chat interface. See
`CLAUDE.md` for the full project rationale.

The fork is pinned at `v0.11.3` and never merges upstream — every update is a
deliberate `git checkout <tag>` inside the submodule, not a tracking branch.
It runs as two host processes, `lllm-frontend` and `lllm-backend`, the same
way the local-inference tooling below (`lllm-serve`) already does, rather
than in Docker: real integration between Open WebUI and this repo's own
GPU/process-management tooling needs a host process on both sides
(see the decisions log for why forking was rejected once, in 2026-09-06, and
what changed since). Its chat and RAG data live in Postgres+pgvector
(`open-web-ui/docker-compose.yml`), not SQLite.

## Running it

Requires Docker Desktop with WSL integration enabled for this distro
(Docker Desktop → Settings → Resources → WSL Integration), plus Bun and a
Python 3 interpreter on the host for the fork's frontend and backend.

Clone this repo with `git submodule update --init --recursive` — the fork
lives inside `open-web-ui/openwebui/` as a submodule, so a plain clone leaves
that directory empty. Put your secrets in `open-web-ui/.env` (gitignored):

```bash
# open-web-ui/.env
OPENROUTER_API_KEY=<your OpenRouter API key, from https://openrouter.ai/keys>
POSTGRES_PASSWORD=<openssl rand -base64 24>
WEBUI_SECRET_KEY=<openssl rand -base64 24>
```

then, in one terminal:

```bash
lllm-backend
```

which brings up Postgres (`open-web-ui/docker-compose.yml`) and the fork's
backend (`uvicorn`, port `4000`) together, and tears Postgres back down when
the backend stops. In a second terminal:

```bash
lllm-frontend
```

which starts the fork's frontend dev server (`vite`, port `5173`) and proxies
its API/WebSocket calls to the backend on `4000`.

Chat is at `http://localhost:5173/`. The first account you create becomes the
admin. This is a fresh database — the SQLite-backed data from before the fork
(the `open-web-ui_open-webui` Docker volume) is left in place, untouched, but
no longer used. Admin accounts also see a **Benchmarks** entry in the
sidebar, at `/benchmarks` — serving, testing, comparison, reporting and
tuning for the local-inference setup below, built into this same frontend
and backend rather than served from a separate dashboard or port. See
"Local inference" below, and "Testing" → "The Benchmarks section" further
down.

## Model setup

Under **Workspace → Models**, this project defines one Open WebUI model entry
per task, each wrapping a specific OpenRouter model id:

- **Coding** → `qwen/qwen-2.5-coder-32b-instruct`
- **Reasoning** → `qwen/qwen3.6-27b`

Both models are configured (per-model, in the System Prompt field) with the
following instructions:

```
Please use a formal, professional tone. When applicable, try to explain solutions and their steps.
Be informative and delve into topics to enhance learning and further understanding.
Please prioritize accuracy and correctness for all responses.
If there are any assumptions you make for any response please clearly state them and do not hesitate to ask clarifying questions before providing a full response.
Never use em-dashes, instead use standard punctuation such as colons and semicolons.
```

Model choices and reasoning for changing them are logged in the "Decisions
log" section of `CLAUDE.md`.

## Local inference (llama.cpp)

Local self-hosting is now being tested alongside the OpenRouter setup, using
[llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server`, which
exposes the same OpenAI-compatible API Open WebUI already speaks. Pointing
Open WebUI at it is a connection-settings change only (see "Migrating to local
hardware later" below).

Helper functions live in `scripts/shell/main.sh`. Source it from `~/.bashrc`:

```bash
[ -f "$HOME/dev/repos/local-llm/scripts/shell/main.sh" ] \
  && . "$HOME/dev/repos/local-llm/scripts/shell/main.sh"
```

It can also be invoked directly without sourcing:
`./scripts/shell/main.sh serve qwen38`.

Serving settings are grouped into profiles rather than scattered across env
vars. `lllm-profiles` lists them and shows whether the weights are on disk:

| profile | arch  | model                                    | size on disk | ctx   | threads | ngl | slots | n-cpu-moe | override-tensors                         |
| ------- | ----- | ---------------------------------------- | -----------: | ----- | ------: | --: | ----: | --------: | ---------------------------------------- |
| qwen36  | MoE   | `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf`        |    20.81 GiB | 65536 |       6 |  99 |     1 |        34 | n/a                                      |
| qwen38  | dense | `Qwen3.8-27B-UD-Q3_K_XL.gguf`            |    12.24 GiB | 16384 |      12 |  20 |     1 |       n/a | `output\.weight`, `blk\.64\..*` -> CUDA0 |
| qwen25c | dense | `Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf`  |     4.36 GiB | 16384 |       6 |  99 |     1 |       n/a | n/a                                      |
| qwen3c  | MoE   | `Qwen3-Coder-30B-A3B-Instruct-Q4_1.gguf` |    17.87 GiB | 65536 |       6 |  99 |     1 |        34 | n/a                                      |

`qwen25c` is the only profile here whose weights fit in 6 GB outright, so
`-ngl 99` puts all 28 blocks and the output head on the GPU and nothing is read
from system RAM. That is the whole reason it exists: `qwen36` and `qwen38` are
3-5x this card and are bound by how fast their CPU-resident weights can be read,
which is what holds them to single-digit tokens/s. Nothing about its throughput
is measured yet, so no figure for it is quoted here; running the `smoke` tier
against a served instance from the Benchmarks section's Tests page is what
would produce one. It needs no `-ot` (nothing
is left on the CPU to pin), sets no speculative flags (Qwen2.5 predates the
`nextn` tensors `qwen38` drafts from), and sets no reasoning effort: it is not a
thinking model, so responses carry no `reasoning_content` and the token budget
is all answer. Its samplers are Qwen2.5-Coder's own
(`--temp 0.7 --top-p 0.8 --top-k 20 --repeat-penalty 1.1`), which govern Open
WebUI traffic; the Benchmarks section's Tests page pins temperature to 0 in
its request body either way.
Its context is 16384 rather than the model's full 32768 because the KV cache
here costs ~29.7 KiB/token at `q8_0` (28 layers, 4 KV heads of 128): ~476 MiB at
16K against ~952 MiB at 32K, on top of 4.36 GiB of weights and the compute
buffer. The full window fits inside 6 GiB only with less margin than
`LLAMA_VRAM_HEADROOM_MIB` warns at, so it is opt-in via `LLAMA_CTX`, to be
confirmed with `lllm-vram` rather than assumed.

`qwen3c` (`unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF`, `Q4_1`, 17.87 GiB,
alias `qwen3-coder-30b-a3b`) is a fourth profile, weights present on disk but
**nothing about it is measured yet**: no throughput figure and no run from
the Benchmarks section's Tests page. It follows the same `qwen36` shape — sparse MoE, `-ngl 99`
with `--n-cpu-moe 34` since the model is ~4.1x this card's 6 GB VRAM, `q8_0`
KV cache, 65536 context, 6 threads — copied as a starting point rather than
independently tuned; `LLAMA_MOE` and `LLAMA_CTX` overrides plus
`lllm-sweep-ngl qwen3c` are how that would actually get confirmed. It sets
no `-ot` and no speculative flags: unlike `qwen38`, nothing here has checked
this GGUF for an MTP head.

`qwen38`'s `-ngl 20` is a placeholder pending an `lllm-sweep-ngl` run;
`--n-cpu-moe` is MoE-only and the script refuses to pass it to a dense model.
`qwen38` also pins two tensor groups to the GPU with `-ot` regardless of
`-ngl` — the output projection and the final block (the model has 65 blocks,
`blk.0` to `blk.64`), both touched on every token. `lllm-sweep-ngl` passes the
same `-ot`, so its VRAM headroom matches what `lllm-serve` will see. Override
per run with `LLAMA_OT`. `lllm-serve` warns to check the load log's `n_layer`
before treating an `-ngl` as tuned, but only for a dense profile that is
partially offloaded: at `-ngl 99` there is no layer count being chosen.

It additionally runs speculative decoding off the model's own multi-token
prediction head (`--spec-type draft-mtp --spec-draft-n-max 2`), so
no separate draft model is needed: the weights carry
`qwen35.nextn_predict_layers = 1` and `blk.64.nextn.*` tensors, and `-ot`
already keeps that block on the GPU. A draft depth of 2 is deliberately
conservative — rejected drafts cost real compute on a model this CPU-bound.
The Benchmarks section's Tests page reports `draft_n` and `draft_n_accepted`
in its timings, which is the acceptance rate to judge it by.
`LLAMA_SPEC=off lllm-serve qwen38` turns
it off for an A/B; `LLAMA_SPEC="<flags>"` replaces the flags wholesale.
`qwen36` sets none of this: its weights are not on disk here, so its MTP
support is unverified.

Every profile serves with `--parallel 1` (one server slot), overridable with
`LLAMA_PARALLEL`. This is passed unconditionally and independently of the
speculative flags, because omitting `--parallel` is *not* the same as passing
1: `llama-server` defaults it to `-1` (auto), and auto means **4 slots with
`kv_unified = true`** (build 10597, `common/arg.cpp:1400` and
`tools/server/server.cpp:152-155`). `-c` is the total context, which
non-unified slots divide between them, so the slot count changes the attention
and KV-cache configuration whether or not it changes capacity. Until
2026-08-23 `--parallel 1` was bundled into `qwen38`'s speculative flags, so
every `LLAMA_SPEC=off` baseline silently ran 4 unified slots — measured at
15.63 t/s prompt processing against 26.38 t/s at one slot. Any comparison
recorded before that date between a speculative run and a non-speculative one
is invalid, in the direction that flatters speculation. Passing `--parallel`
inside `LLAMA_SPEC` is refused for the same reason; use `LLAMA_PARALLEL`.

The functions:

- `lllm-serve [profile] [args...]` : start `llama-server` on port 8090 (set
  `LLAMA_PORT` to change). One-off overrides: `LLAMA_MODEL`, `LLAMA_CTX`,
  `LLAMA_THREADS`, `LLAMA_NGL`, `LLAMA_MOE`, `LLAMA_OT`, `LLAMA_SPEC`,
  `LLAMA_PARALLEL` (server slots, default 1), `LLAMA_REASONING` (thinking
  effort for `qwen38`). Extra arguments pass through to `llama-server`.
  KV cache types and batch sizes are profile variables too (`LLAMA_CACHE_K`,
  `LLAMA_CACHE_V`, `LLAMA_BATCH`, `LLAMA_UBATCH`; all default to the values in
  the table above), so the flags passed and the flags recorded in the log come
  from one place.
  `--metrics` is always passed, so
  the run's server-wide token totals can be recorded, and `-lv 4`
  (`LLAMA_LOG_VERBOSITY`) so the server prints what it decided about the model
  it loaded — the layer split, the slot count, the fused kernels it resolved,
  the tensors it ignored. Neither affects inference, and both are deliberately
  excluded from the config fingerprint. The server's output is tee'd to a
  temporary `logs/.server.<pid>.log` for the recorder to parse and deleted when
  the server exits; the terminal copy is unchanged except that the GGUF metadata
  dump `-lv 4` adds is filtered out of it.
- `lllm-fetch [profile]` : download the profile's weights with the `hf` CLI.
- `lllm-sweep-threads [profile] [4,6,8,...]` : `llama-bench` across thread
  counts, printed as a markdown table.
- `lllm-sweep-ngl [profile] [12,16,20,...]` : `llama-bench` across GPU layer
  counts, for tuning a dense profile. Values that exceed VRAM error out, which
  is the useful signal.
- `lllm-check` : `GET /v1/models` against the running server.
- `lllm-vram` : live GPU telemetry, refreshed in place, with free VRAM called
  out — on a 6 GB card headroom is what decides whether an `-ngl` is viable.
- `lllm-profiles` : list profiles and whether their weights are present.
- `lllm-profile-json [profile]` : a profile's resolved settings as JSON. Exists
  so the Python tooling can read the serving configuration without re-declaring
  it; `scripts/shell/main.sh` stays the single source of truth. `reasoning` is
  empty for a profile that sets no thinking effort, the same test the telemetry
  fingerprint makes before recording `n/a`, so a caller cannot end up setting
  `LLAMA_REASONING` for a server that ignores it.
- `lllm-profile-names` : the defined profiles, one per line, from the
  `LLAMA_PROFILE_NAMES` array. `lllm-profiles` and the Benchmarks section's
  Serve-page profile picker both read it, so adding a profile is an edit to
  `scripts/shell/main.sh` and nothing else.

Benchmark running, grading, comparison, reporting and tuning are not shell
functions any more. `lllm-test`, `lllm-compare` (`lllm-test compare`),
`lllm-report`, `lllm-tune` and the standalone `lllm-web` dashboard were
retired outright on 2026-09-08, and the whole suite now lives inside the
Open WebUI fork itself, as an admin-only **Benchmarks** section at
`/benchmarks`, served by the same `lllm-frontend`/`lllm-backend` as the rest
of the fork rather than a separate process or port. See
[Testing](#testing) below for the harnesses themselves, and "The Benchmarks
section" further down for the pages and how they got there. Seven pages,
none of them a thin passthrough to a CLI that no longer exists:

- **Serve** (`/benchmarks/serve`) starts and stops `llama-server` from a
  profile with the same overrides `lllm-serve` takes, and streams its output
  live.
- **Live** (`/benchmarks/live`) polls the run being recorded right now, every
  5s to match the recorder's own sample interval.
- **Tests** (`/benchmarks/tests`) runs a tier and streams one structured
  event per graded item over SSE — in-process, not by shelling out to a
  `lllm-test` that no longer exists, so cancelling mid-run stops the loop
  directly rather than sending a signal to a subprocess; every item is still
  its own committed transaction, so the run is exactly as resumable either
  way.
- **Compare** (`/benchmarks/compare`) and **Answers** (`/benchmarks/answers`)
  read the same tables and the same stored responses the old `lllm-test
  compare`/`lllm-test answer` printed, through the same underlying query
  logic, ported into the fork's own backend rather than rewritten.
- **Report** (`/benchmarks/report`) and **Tune** (`/benchmarks/tune`) drive
  the same code `lllm-report`/`lllm-tune` did: Report renders the same
  design-audited markdown and PNGs unmodified, rather than inventing a
  second output path through the statistics; Tune runs the same
  round-elimination search as an in-process, checkpointed async sweep with
  its own port-guarding and cooldown logic, in place of a CLI subprocess —
  it still drives `lllm-serve` under `LLAMA_*` overrides and still
  fingerprints a candidate with `lllm-config-id` before serving it.

The adapter/suite TOMLs and system-prompt text files moved with the code,
into `open-web-ui/openwebui/backend/open_webui/benchmarks/data/`; they no
longer live at `tests/adapters/`, `tests/suites/`, `tests/tuning/` or
`prompts/system/` in this repo (the gitignored, fetched-not-vendored
`tests/data/` cache is left in place, orphaned but harmless, since the fork
fetches its own copy under its own `DATA_DIR` on first use).

Direct database access, replacing `lllm-db`, is a normal Postgres client
against the fork's own database — `psql "$DATABASE_URL"`, or anything else
that speaks that connection string — rather than a bespoke wrapper: every
table from the old schema is there under a `benchmark_` prefix (`config` →
`benchmark_config`, `result` → `benchmark_result`, and so on — see "The
tables" below).

### Recorded telemetry and throughput

`lllm-serve` starts `scripts/shell/vram-log.sh` in the background and stops it
when the server exits, so every serving run leaves a record of what the GPU
actually did and how fast the model answered. That script is still a thin
wrapper: it resolves the profile and computes the configuration fingerprint in
shell exactly as before, then hands off to a recorder that waits for the port
to open, samples `nvidia-smi` every `LLAMA_VRAM_INTERVAL` seconds (default 5),
scrapes `/metrics` on the same pass, parses the server's own load output, and
writes each of those as it happens — not to a file any more, but into the Open
WebUI fork's own Postgres database (`open-web-ui/docker-compose.yml`), the
same one the chat interface itself uses. The recorder is now
`open_webui.benchmarks.telemetry_recorder`, run under the fork's own backend
venv rather than bare `python3`, and it writes with `psycopg` directly (no
SQLAlchemy, no event loop) — but it is still a separate subprocess for the
life of the server, for the same reason as before: a recording has to survive
a crash of whatever started it, which folding it into the backend's own event
loop would give up.

**One database, for everything this repo measures.** Serving configurations, runs,
GPU samples, `/metrics` scrapes, per-request timings, test results, and the full
answers are tables in it, each named with a `benchmark_` prefix so they sit
beside Open WebUI's own tables without colliding. Model and quantization are
columns rather than halves of a filename, so a cross-model question is a query
rather than a comparison between files that never sit beside each other.

Nothing is written as markdown any more and nothing is parsed back out of one.
Markdown is an *output* format — the maintenance policy still requires a
measured table to be pasted into this README, but the Compare page renders
only an HTML table now; there is no built-in markdown export, so that table's
values are copied out by hand. No code reads a markdown table back in
either way.

#### The tables

| table | one row per | holds |
| --- | --- | --- |
| `benchmark_config` | serving configuration | the fingerprinted configuration text verbatim, plus the flags parsed out of it (`arch`, `ngl`, `ctx`, `parallel`, `threads`, `moe`, `override_tensors`, `speculative`, cache types, flash attention, batch sizes, reasoning effort, samplers) |
| `benchmark_run` | serving run | `config_id`, model, quant, llama.cpp build, port, pid, start and end. `ended_at IS NULL` means it is serving now |
| `benchmark_gpu_sample` | `nvidia-smi` sample | temperature, utilization, memory used/total, power, SM clock, and the raw `clocks_throttle_reasons.active` bitmask |
| `benchmark_metrics_scrape` | counter, per scrape | the server's own `/metrics` counters, the whole series |
| `benchmark_run_load_info` | run | what the server said about the model it loaded: the layer split, slot configuration, per-device buffer sizes, `fused_gdn`, the MTP head, unused tensors, warnings, `DEPRECATED` lines |
| `benchmark_request` | request | llama.cpp's raw `timings` fields as columns, the measured wall clock, the request parameters, and the whole `timings` object as JSON |
| `benchmark_result` | graded item | the verdict, with foreign keys to the `benchmark_request` that produced it, the `benchmark_run` it belongs to, and the `benchmark_config` it was measured under |
| `benchmark_answer` | result | prompt, answer, and reasoning as three fields, not one rendered blob |
| `benchmark_suite_exclusion` | item | what no run can attempt, recorded once against a dataset revision rather than once per run |
| `benchmark_schema_note` | discontinuity | append-only provenance: what changed, and on what date, when it changed the meaning of rows either side of it |

This is a schema-preserving 1:1 port of the old SQLite tables (`config` →
`benchmark_config`, `result` → `benchmark_result`, and so on), added by an
ordinary Alembic migration alongside the rest of the fork's schema
(`b3f8a1d94e70_add_benchmark_tables.py`) rather than hand-rolled DDL, and the
historical rows were carried over by a one-time backfill script guarded
against running twice.

The arithmetic that used to be computed at write time (`is_cold`,
`acceptance`, `mean_len` per request; pass rate excluding `skipped`; per-run
GPU stats; each config's latest run) is no longer a set of SQL views —
this fork's own schema uses no views anywhere else, so the same computations
are plain query methods on the `models/benchmark_*.py` table-wrapper classes
instead, which has the advantage of being unit-testable directly rather than
only through a live-Postgres round trip.

**Summaries are derived on read, and every sample is kept.** This reverses the
2026-08-23 retention rule, which discarded raw samples once a newer run finished
and kept only the already-computed summary — so a statistic computed wrongly
could never be recomputed. At roughly 60 bytes a row and 5 s intervals, a day of
continuous serving is about 1 MB. A `DELETE ... WHERE sampled_at < <date>`
against `benchmark_gpu_sample`/`benchmark_metrics_scrape` exists for the day
that matters, and it touches only samples and scrapes, never results,
answers, requests or configurations.

#### What identifies a configuration

The `config_id` is a `sha1[:8]` over the serving flags, computed by
`_vramlog_config` in `scripts/shell/vram-log.sh` — the same function, over the
same six lines, as before the database existed. Config ids are therefore
unchanged: an id quoted in an older log names the same configuration it always
did.

```
arch: dense | ngl: 20 | ctx: 16384 (total) | parallel: 1 | threads: 12 | moe: n/a
override-tensors: output\.weight=CUDA0,blk\.64\..*=CUDA0
speculative: --spec-type draft-mtp --spec-draft-n-max 2
cache: k=q8_0 v=q8_0 | fa: 1 | batch: 512 | ubatch: 512
reasoning effort: medium
samplers: temp 1.0 | top-p 0.95
```

Changing any of them makes a new `benchmark_config` row instead of mixing
incomparable runs. Rebuilding llama.cpp does not: the build string is a
column on `benchmark_run`, not part of the hash. `-lv` and `--metrics` are
excluded for the same reason — they change what the server says about
itself, not what it computes.

`config_text` is stored verbatim because it is what the hash covers, and the
typed columns are parsed out of *that text* on insert rather than supplied
separately, so a column cannot disagree with the fingerprint that identifies its
row.

Two kinds of context are recorded but never fingerprinted, because they are
observations of a run rather than settings — a run that served no request
from the Benchmarks section's Tests page would otherwise be a different
configuration from one that did:

- **`benchmark_request.params`** is what was actually in the request body,
  read back out of it rather than re-derived. It matters because
  `benchmark_config.samplers` records the server's *defaults* and a Tests-page
  request overrides them: the server may say `temp 1.0 | top-p 0.95` while the
  measured request ran at `temperature: 0`.
- **`benchmark_run_load_info`** is what the server said about the model it loaded. None of
  it is derivable from the flags, and all of it decides whether two runs measure
  the same thing:

  | column | why it is here |
  | --- | --- |
  | `n_layer`, `n_layer_all` | the block count the model reports, and the larger count when a head such as MTP makes them differ |
  | `layers_gpu`, `layers_total` | the split llama.cpp *reports*, not the one `-ngl` asked for: `-ngl` is a ceiling, clamped to what fits and counting the output layer. The remainder is CPU-resident, and is what generation speed on this hardware tracks |
  | `n_slots`, `n_ctx_slot`, `kv_unified` | the resolved slot configuration — the thing `--parallel` was silently getting wrong before 2026-08-23 |
  | `buffers`, `cpu_buffer_mib`, `gpu_buffer_mib` | per-device weight bytes, so VRAM headroom can be read against what the weights alone took |
  | `fused_gdn` | whether the fused Gated Delta Net kernels resolved to `enabled` or `disabled` |
  | `mtp_head` | whether the file carries a multi-token-prediction head, and whether the server used it or ignored it. Present-and-ignored is loaded weights doing nothing |
  | `unused_tensors`, `unused_prefixes` | how many tensors the loader found and skipped, with their distinct name prefixes. `blk.64.nextn.*` here means the MTP head was read and dropped |
  | `warnings`, `deprecated` | any device-mismatch or deprecation line, verbatim, because the wording is the evidence |

  **`fused_gdn` makes two runs incomparable.** llama.cpp resolves those kernels
  per context, at load, by checking that the fused node landed on the same device
  as the layer it belongs to (`src/llama-context.cpp:504`). Whether it succeeds
  depends on where the layers ended up, so the same `-ngl` on a machine with a
  slightly different memory state can land on either answer — and the disabled
  path runs a different set of operations, at a different speed, under a
  `config_id` that says nothing about it. When it is `disabled`, the warning lines
  beside it say which layer and which device caused it.

  A run with nothing to say about the load log — a hand-started server — simply
  has no `benchmark_run_load_info` row, rather than a row of `unavailable`. Nothing is
  guessed: a plausible default here would be indistinguishable from an
  observation.

#### Reading it back

The Benchmarks section's Compare page, in its **by serving** view, is the
UI equivalent of the old `lllm-test compare --by serving`:

One row per configuration — `ngl`, `parallel`, `spec`, `-ot`, `fused_gdn`, cold
prefill t/s, generation t/s, draft acceptance, peak VRAM, headroom, build — sorted
by generation throughput, fastest first, with a `derived` table beneath it. Each
row is that configuration's **most recent run**, not an average of its history,
because an older run may predate a llama.cpp rebuild or have shared the machine
with something else, and averaging would hide the change being looked for.
Configurations never measured sort last rather than as zero: they are unknown, not
slow. A figure marked `*` came from `/metrics` rather than from a Tests-page
run — it covers every client and whatever prompts they sent, so it answers a looser
question than a row measured on the version-controlled prompt.

The `derived` table carries `cpu-resident layers`, `ms/token` (the reciprocal of
generation t/s), `cpu bandwidth (GiB/s)` — the CPU-resident weights divided by the
time one token takes — and what the free VRAM is worth in layers. On a dense model
every resident weight is read once per token, so the bandwidth figure is close to
the real effective bandwidth and is what says whether a configuration is bandwidth
bound. On an MoE it reads `n/a (moe)` rather than a number: only the routed experts
are read per token, so dividing by all of them would understate it severalfold.

When two or more configurations differ *only* in `-ngl`, a line beneath the table
fits `ms/token` against `cpu-resident layers` by least squares and reports it as
`<slope> ms per layer + <intercept> ms fixed`. Read the slope as the price of
moving one layer off the GPU — that is the number an `-ngl` decision turns on. Do
**not** divide `ms/token` by `cpu-resident layers` and call that the per-layer
cost: that charges the whole per-token time to the resident layers, fixed part
included, so it always overstates the slope, and by more the larger the fixed part
is. The intercept is that fixed part — the GPU-resident layers, sampling, the
draft head — and on this hardware it is a large share of the total. The fit needs
at least two configurations at different layer counts and is simply absent
otherwise.

The Live page (`/benchmarks/live`) is the run that is serving right now — its
GPU statistics, its `/metrics` deltas and its most recent samples, refreshed
every 5 seconds; that view is possible because samples land in the database
as they are taken rather than being folded in when the recorder exits. The
Answers page (`/benchmarks/answers`) is the pairing for the old `--by
failures` view: pick a suite run, list its failures (or all its items, or its
passes), and read the response rendered as markdown. The thinking is off by
default and toggled with a checkbox — reasoning dominates the token budget on
this model, so a trace routinely runs to tens of thousands of characters, and
it is never graded.

Raw access, replacing `lllm-db`, is a normal Postgres client:

```bash
psql "$DATABASE_URL" -c "SELECT config_id, ngl, speculative FROM benchmark_config"
```

An interactive `psql "$DATABASE_URL"` session, `\d benchmark_config` for the
DDL, and ordinary `DELETE`/`VACUUM`/`COPY ... TO` statements do what
`lllm-db`'s `shell`/`schema`/`prune`/`vacuum`/`export` subcommands used to —
there is no bespoke wrapper any more, just the database.

#### Reading the numbers

**Utilization has two averages, and they answer different questions.** Sampling
runs for the life of the server, so an idle server drags the mean toward zero: a
recorded `qwen38` run that spent 32 s of its 92 s answering two prompts logs
`util avg/max` of `1/9`. The active-only average covers only the samples that saw
work, and the p50/p95 say which of the two states the run mostly sat in. Note that
even the busy samples are low here — the CPU-resident layers are the bottleneck
during generation and the GPU spends most of a token waiting, so a small active
average is the expected reading, not a sign of a stalled run.

**Percentiles and throttle decoding stay in Python**, in the fork's
`open_webui/benchmarks/stats.py` (the same module `llama_stats.py` was
ported into on 2026-09-08, unchanged statistics).
`percentile()` interpolates linearly between closest ranks (numpy's default
method) and `throttle_reasons()` decodes named bits and prints unnamed ones as
hex. Reimplementing either in SQL would silently change every recorded number.

**VRAM headroom is a first-class figure.** It is what was still free at the run's
peak, and any run that finished under `LLAMA_VRAM_HEADROOM_MIB` (default 300) is
named in a warning beneath the table. The load log converts it into the unit
`-ngl` is tuned in — how many more layers would fit, at this model's own
GPU-resident bytes divided by the layers that got there. That per-layer figure is
an average: the output head and the final block are not the size of a repeating
block, and the KV cache grows alongside them, so treat a prediction of one more
layer as a thing to test, not a thing to assume.

**Throttle reasons are recorded per sample and reported per run.** The raw
bitmask is stored on every sample; what is reported is the distinct set decoded
across the run, because per sample it is a column of near-identical hex. `GpuIdle`
is not a fault — it is set whenever the GPU has nothing to do, which here is most
of a run. `SwPowerCap`, `SwThermalSlowdown` and `HwThermalSlowdown` are the ones
that mean a measurement was taken under a limit and is not comparable with one
that was not. Undocumented bits are printed as hex rather than guessed at.

**Speculative decoding gets `acceptance` and `mean_len`, both derived by the
query method that replaced the old `v_request` view.** `acceptance` is `draft_n_accepted / draft_n`; `mean_len` is the
mean accepted length per verification step, `1 + accepted/steps`. Both are blank,
not zero, when nothing was drafted, so a non-speculative configuration is visibly
not a 0% one. The step count is *inferred*: a request's `timings` carry `draft_n`
and `draft_n_accepted` but not the steps (build 10597 keeps `n_draft_verif_steps`
in the slot's stats and exposes it only through `/metrics`), so steps are taken as
`draft_n / --spec-draft-n-max`, read from the configuration row. That is exact
while every step drafts the full depth, which `draft-mtp` at `p_min = 0` always
does. The `/metrics` series carries the server's own exact figure from
`spec_decode_num_drafts_total`, which is the one to trust if they ever disagree.
On the `qwen38` run of 2026-08-24T02:25:34Z they did not: 44 tokens drafted, 41
accepted, and the server counted exactly the 22 verification steps the derivation
assumes, so both read `0.932` / `2.864`.

**Cold and warm prefills are never blended.** `cache_n` is the number of prompt
tokens llama.cpp took from its cache instead of processing; any request with
`cache_n > 0` had part of its prompt already in a slot, so its `prompt_n` counts
only the remainder and its `prompt_per_second` measures a handful of tokens
against fixed per-request overhead — 2.79 t/s where the same prompt cold gives
56.00 t/s. Mixing the two produces a prefill number that belongs to no
configuration. The `is_cold` split `v_request` used to provide is still one
query away — now a method on the request model rather than a view — and
every prefill figure reported is cold-only.

The `/metrics` counters cannot make this split — they do not break down per
request — but they need no correction either: `prompt_tokens_total` counts only
*processed* tokens, with cache hits going to the separate
`prompt_tokens_cached_total` beside it (verified in the build 10597 sources, not
assumed). Their prompt t/s is therefore already cache-free, while their token
totals mix cold and warm runs of every client.

End-to-end time is the wall clock measured around the request, not
`prompt_ms + predicted_ms`; on a streamed response the two differ, and the wall
clock is what you actually waited. It covers every request, cold and warm alike,
as do the output-token counts: generation speed does not depend on how the prefill
was obtained.

**The two throughput sources come from different places on purpose, and will not
agree:**

- **`benchmark_request` rows** are exact and per-request, but only the
  Benchmarks section's Tests page contributes them — a version-controlled
  prompt at `temperature 0`, which is what makes two runs comparable. Traffic
  from Open WebUI or a hand-written `curl` is not counted.
- **`benchmark_metrics_scrape` rows** are the server's own counters, so they cover *every*
  client. They are cumulative totals only: the endpoint exposes no per-request
  breakdown and, as of build 10597, no request counter at all. The first scrape
  lands when `/metrics` first answers, which is after the model finishes loading
  rather than when the port opens — the endpoint returns 503 until then.

**A defect the series fixes.** The old store kept only the first and last scrape
and reported one delta, and that delta could be short by one request's generation:
llama.cpp updates its prompt counters when a prompt is processed but its
generation counters when the task completes, so a scrape taken as the server stops
holds the prompt half and not the generation half. On the 2026-08-24T02:39:18Z run
the prompt tokens matched the per-request rows exactly (518 / 10.8 s, all four
prefills) while output was 2064 against 2677 and drafted 1466 against 1886. With
every scrape stored, the delta can be taken to a scrape after the final
completion, and the intermediate values are a throughput curve rather than a lost
measurement.

#### Crash durability, and the active run

There is no marker file. A run whose `ended_at IS NULL` **is** the active run,
which is how the Benchmarks section's Tests page knows which run its timings
belong to, and a run whose
recorded `pid` is no longer alive is detectably stale and is closed by a sweep on
the next connect. This is strictly more robust than the `logs/.active-run.json`
it replaces: that file was removed by an EXIT trap, which a `kill -9` skips,
leaving a stale marker that later results were filed under. Samples are written as
they are taken, so a killed recorder loses nothing but the sample it was in the
middle of.

A test still runs and prints its numbers when no run is open; its `config_id` is
simply NULL, displayed as `unrecorded`, rather than attributed to a guess.

There is no database file to gitignore any more: the store is the fork's own
Postgres, reached via `DATABASE_URL` (loaded from `open-web-ui/.env` by
`lllm-backend`, and by `scripts/shell/vram-log.sh` for the recorder it execs).
Set `LLAMA_VRAM_LOG=0` to disable recording, or run
`./scripts/shell/vram-log.sh record [profile]` by hand to capture a server that
was started some other way; it stops on its own once the port stops answering.

**Known limitation:** the configuration lines describe the *profile* as resolved
when the recorder started, not the argv of the process actually serving. A server
started by hand, or one whose profile was edited mid-session, can therefore be
filed under a configuration it was never run with. The `benchmark_request`
rows carry the model name the server reported, which at least makes that
detectable.

**The database started empty on 2026-08-30.** The markdown serving logs and
`logs/tests.jsonl` that preceded the original SQLite store were deliberately
not imported, so nothing in it predates that date, and comparisons said
nothing until a new serving run and a new test run happened. Those files were
**deleted on 2026-09-04**: they had been kept in `logs/` as a historical
reference, read by no code, and five days of that was enough to establish
that nothing wanted them. Measurements taken before 2026-08-30 therefore no
longer exist anywhere. **The 2026-09-08 move to Postgres did not repeat
that reset**: every row the SQLite file held was carried over by a one-time
backfill run before the file was retired (kept on disk as
`logs/llama.db.retired-2026-09-08` rather than deleted, since it is no longer
read by anything). `benchmark_schema_note` records this, and every other
discontinuity, inside the database itself.

### Hardware and model

- GPU: NVIDIA GeForce RTX 3060 Laptop, 6 GB VRAM (compute capability 8.6).
- Model: `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` : 34.66 B total parameters, ~3 B
  active per token (MoE), 20.81 GiB on disk.

The weights are far larger than 6 GB of VRAM, so all layers are offloaded
(`-ngl 99`) but the MoE expert tensors of 34 layers are kept in system RAM
(`--n-cpu-moe 34`). The KV cache is quantized to `q8_0` with flash attention
enabled to fit a 64K context.

### Verifying the server

```bash
curl -s -X POST http://localhost:8090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.6-35b-a3b","messages":[{"role":"user","content":"Count from 1 to 30, one number per line."}],"max_tokens":600}'
```

This returns a normal `chat.completion` object; note that the model is a
thinking model, so its chain of thought arrives in a separate
`reasoning_content` field alongside `content`. On the run used for these
notes, 480 completion tokens (most of them reasoning) took ~92 s, i.e. ~5.2
tokens/s end to end, with a 24-token prompt taking ~1.3 s to prefill.

### Measurement: qwen38 with MTP speculative decoding

> **Prompt source changed 2026-08-30; these numbers still stand.** The runs
> below were measured on `prompts/humaneval0-4.txt`, hand-typed files that
> collapsed the two blank lines the canonical HumanEval stub carries between its
> import and its `def`. The test harness now renders prompts from the dataset
> itself, so each of these five prompts is two bytes longer than the string that
> was measured. Checked against the server's `/tokenize` on 2026-08-30 rather
> than assumed: all five tokenize to **the same length as before** (135, 127,
> 96, 130, 129 content tokens) and differ in exactly **one token id** each — the
> newline run absorbs the added blank lines. Same token count, same prefill
> work, so these figures remain comparable to runs made after the change.
> `humaneval0`-`humaneval4` here are `HumanEval/0`-`HumanEval/4` under the new
> naming. See the 2026-08-30 decisions-log entry in `CLAUDE.md`.

One HumanEval item (`HumanEval/0`, run from the Benchmarks section's Tests
page) against `lllm-serve qwen38`, build `95b8e33e1`
(10597), on the RTX 3060 Laptop (6 GB). Serving flags: `-ngl 20`,
`-ot "output\.weight=CUDA0,blk\.64\..*=CUDA0"`, `-c 16384`, `-t 12`,
`--cache-type-k/v q8_0`, `-fa on`, `-b 512 --ubatch-size 512`,
`--spec-type draft-mtp --spec-draft-n-max 2 --parallel 1`, reasoning effort
`medium`, temperature 0:

| metric                | value        |
| --------------------- | -----------: |
| generation            |  2.89 t/s    |
| prompt processing     | 51.41 t/s    |
| completion tokens     |          958 |
| drafted tokens        |          690 |
| drafted tokens accepted |        613 |
| VRAM in use           | 5519/6144 MiB |

Acceptance is 88.8% and drafts cover 72% of the generated tokens, which is a
healthy rate for an MTP head. The throughput gain is nonetheless modest, and
this is **not yet a clean A/B**: the only non-speculative measurement to hand
(2.50 t/s) came from a server that also differed in `-ngl` (22) and had no
`-ot`, and it produced a shorter completion. `LLAMA_SPEC=off lllm-serve
qwen38` followed by the same item run again from the Tests page is the
comparison to make — and
before 2026-08-23 it would not have been valid either, because dropping the
speculative flags also dropped `--parallel 1` and left the baseline serving 4
unified slots (fixed 2026-08-23; see the slot-count paragraph above).

Note the whole request took ~5.5 minutes: 958 tokens at ~2.9 t/s, most of them
reasoning tokens emitted before any answer text. Generation here is bound by
system-RAM bandwidth for the CPU-resident layers, which is also why drafting
helps less than its acceptance rate suggests.

**Four-prompt run, 2026-08-24T02:39:18Z**, same build and same flags as above,
one server, four cold prefills (`cache_prompt: false`), 2048-token cap,
reasoning effort `medium`, temperature 0:

| prompt      | prompt tok | prefill t/s | output tok | generation t/s | drafted | accepted | acceptance | answer  |
| ----------- | ---------: | ----------: | ---------: | -------------: | ------: | -------: | ---------: | ------- |
| humaneval1  |        136 |       42.73 |       1066 |           3.00 |     754 |      688 |      91.2% | correct |
| humaneval2  |        105 |       41.26 |        499 |           2.87 |     364 |      318 |      87.4% | correct |
| humaneval3  |        139 |       55.24 |        499 |           2.98 |     348 |      324 |      93.1% | correct |
| humaneval4  |        138 |       52.96 |        613 |           2.98 |     420 |      404 |      96.2% | correct |
| **run**     |        518 |   **47.74** |       2677 |       **2.97** |    1886 |     1734 |  **91.9%** | 4/4     |

All four solutions were correct. Generation sits in a 2.87-3.00 t/s band across
prompts, so a difference smaller than that band is noise, not a result.
**Prefill is far less stable than it looks from one prompt**: 41.26 to 55.24 t/s
across cold prompts of nearly the same length (105-139 tokens), a 34% spread
under identical flags. Peak VRAM 5521/6144 MiB, 623 MiB headroom, `fused_gdn`
enabled, `GpuIdle` and `SwPowerCap` both observed. GPU utilization averaged 13%
over the samples that saw work — the CPU-resident layers, not the GPU, are what
this configuration waits on.

### Benchmark: thread-count sweep

`llama-bench` on the configuration above (`-ngl 99 -ncmoe 34`), build
`60eeeb608` (10472):

| threads | pp512 (t/s)    | tg128 (t/s) |
| ------: | -------------: | ----------: |
|       4 |  71.75 ± 11.44 | 7.38 ± 0.50 |
|       6 |  75.82 ± 9.24  | 7.90 ± 0.69 |
|       8 |  75.99 ± 13.02 | 7.41 ± 0.43 |
|      10 |  74.85 ± 12.16 | 7.94 ± 0.56 |
|      12 |  76.32 ± 12.18 | 7.40 ± 0.58 |
|      14 |  78.27 ± 17.11 | 7.08 ± 0.45 |

Thread count barely matters here: prompt processing gains ~9% from 4 to 14
threads, and generation is flat at roughly 7.1 to 7.9 t/s with the run-to-run
spread larger than the differences between settings. Generation is bound by
system-RAM bandwidth for the CPU-resident experts, not by CPU cores. The
default of 6 threads is kept since nothing above it pays for itself.

These numbers were measured with build `60eeeb608` (10472) and are historical:
the current build is newer, and `lllm-sweep-threads` now passes the profile's
`-ngl` and `--n-cpu-moe`, so it benchmarks the serving configuration rather
than llama-bench's defaults. Re-measure before relying on them.

## Testing

Serving configurations used to be judged on speed alone. The telemetry above
records throughput, GPU behaviour and per-request timings in detail, but until
2026-08-30 nothing recorded whether a configuration that ran faster also
answered *correctly* — which is the question that decides whether local
inference can replace OpenRouter.

The Benchmarks section's Tests page now runs items from published benchmarks,
grades them with each benchmark's own test code, and records the result
beside the serving telemetry.

**Nothing in this repository states an expected answer.** Every item and every
verdict comes from the dataset. The files under
`open-web-ui/openwebui/backend/open_webui/benchmarks/data/adapters/` (moved
there from this repo's own `tests/adapters/` on 2026-09-08, along with the
code that reads them) describe only *adaptation* — how a completion-style
stub becomes a chat turn, which harness grades it, how long it may run.

Adaptation is still an input to the measurement, so each adapter is
fingerprinted: `adapter_sha` is the first 12 hex of a sha1 over its
`prompt_template`, `[item]`, `[filter]` and `[check]`, recorded on every result
and part of the Compare page's grouping key. It covers the parsed fields rather than
the file's bytes — an adapter carries the prose explaining its own shape, and
hashing that would file a comment edit as a measurement discontinuity. What it
buys is that editing a `prompt_template` can no longer make old and new results
silently incomparable, which is the same failure `config_id` prevents for
serving flags and `system_sha` for system prompts.

A **corrected `prompt_template` should be treated as a new benchmark**, not a
better version of the old one. The ds1000 template was corrected on 2026-09-04
(it told every item to assign `result`, which was false for 194 of the 511
in-filter items); rows recorded before that carry a NULL `adapter_sha`, show as
`?` on the Compare page, and are not comparable to rows after it.

### Commands

| Page / action | What it does |
| --- | --- |
| Tests → run one item | One item, streamed over SSE. Pick a benchmark and an item id (e.g. `humaneval/HumanEval/0`) |
| Tests → run a tier | A whole `smoke`/`standard`/`full` tier. A benchmark filter restricts it, a resume action continues the most recent run of that tier |
| Tests → system prompt | Send the selected system prompt with every item of that run — see below |
| Tests → benchmark list | The benchmarks, their pinned revisions, the tiers, what is calibrated, and the defined system prompts with their shas |
| Tests → fetch datasets | Download and pin the datasets (a force-refetch option is available) |
| Tests → selfcheck | Grade the datasets' own reference solutions and write the calibration |
| Compare | Rank models and configurations — see below |
| Compare → export answers | Write a whole suite run's stored answers back out as flat markdown files, for grepping/diffing/archiving outside the app |
| Answers → view one | Render one stored answer as markdown directly in the browser |
| Report | The statistical comparison, rendered to the page, without running anything new |
| `psql` (or any Postgres client) against `DATABASE_URL` | Raw access to the fork's own database (the `benchmark_*` tables) |

The profile picker on the Serve page names the serving profile whose alias
and `reasoning_effort` are used; the model name itself is read from the
running server (`GET /v1/models`) and a mismatch warns rather than
mislabels, since the profile describes an intended configuration while the
server is already serving something.

#### System prompts

By default a request carries one message: the item. Selecting a system
prompt on the Tests page puts the text of the matching file under
`open-web-ui/openwebui/backend/open_webui/benchmarks/data/prompts/` in front
of it as a `system` message, which is where Open WebUI puts its own, and is
the only place it can go — this `llama-server` build has no system-prompt
flag.

On the Tests page: pick `smoke` with no system prompt and run it as the
baseline, then pick `smoke` again with the `assistant` system prompt — same
24 items, with one difference — and read both off the Compare page.

Both runs are recorded, and **they are separate rows**: `system_sha` joins
`model`, `config_id` and `tier` in the grouping key, so a run with a prompt is
never averaged with a run without one. That is the whole point — the question
is what the prompt costs or buys on a given serving configuration, and a
comparison that mixed the two would answer it wrong while looking fine.

What is recorded is the prompt's **name and a sha of its exact bytes** (the
first 12 hex digits of the SHA-1, the same length the run banners print). The
sha is the identity: a file edited in place is a different prompt under the same
name, so runs either side of an edit stay separate rows, and the Compare page
prints a note when a name shows up with more than one sha. The Answers page
names the prompt in its header, since the stored prompt text is the user
message alone.
A result with no system prompt records NULL, which the database's own schema
note (migration 2) defines as "none was sent" rather than "unknown" — every row
recorded before 2026-09-04 is a genuine baseline, because there was no way to
send one.

The system prompt is deliberately **not** part of `config_id`. That fingerprint
covers the serving flags and is computed by `_vramlog_config` before any request
is made; a system prompt is part of the request. So it is a second grouping key
beside it, in the pass-rate query and on the Compare page, and every existing
`config_id` still means what it always did.

`assistant.txt`, under that same `benchmarks/data/prompts/` directory, is a
copy of the text configured per-model in Open WebUI (see [Model
setup](#model-setup)), kept so a benchmark run can be made under the prompt
the assistant actually serves. Open WebUI remains the source of truth for
that; if it changes there, copy it here in the same change or the comparison
measures a prompt nobody is using. This is a different directory from the
`prompts/` this repo's own 2026-08-30 decision deleted (that one held ad hoc
saved prompts, eyeballed rather than graded); the rule that deleted it still
holds regardless of which repo the file lives in: nothing here is a test
item, nothing here is graded, and ground truth still comes only from the
published datasets.

The four files beside it are a rewrite of that prompt for a local model and an
ablation of the rewrite, so a comparison attributes a difference rather than
just showing one (the standalone `prompts/system/README.md` that used to
carry this reasoning did not move with the files; the reasoning below is now
the only copy of it). The shape is:

| name | what it is |
| --- | --- |
| `assistant` | the deployed Open WebUI prompt, verbatim |
| `assistant-local` | the same six intents, rewritten for a small local model |
| `assistant-direct` | `assistant-local` without "explain the steps" |
| `style-only` | the tone and punctuation rules alone |
| `minimal` | answer directly, code in one fence: the floor |

Three things the rewrite changes, because they matter on a 7B model with a 2048
token cap and do not on a hosted 27B. The deployed prompt's "do not hesitate to
ask clarifying questions before providing a full response" is a scored failure
on a single-turn item, since a model that asks instead of answering produces no
code; the rewrite keeps the intent and puts the question *after* the answer. Its
"delve into topics" can spend the token budget on prose and truncate the code
mid-function, which grades as wrong and reads as a quality problem rather than a
length one. And the rewrites name the code fence, which the graders extract
from. **That last one is a confound and is stated rather than buried**: all four
rewrites name the fence and `assistant` does not, so an `assistant` versus
`assistant-local` delta mixes the rewrite with formatting compliance. The
comparison among the four rewrites is clean, since that instruction is identical
across them.

**None of these is deployed.** Open WebUI still serves `assistant.txt`, and if a
rewrite measures better it is adopted there, with `assistant.txt` updated to
match in the same change. Winning a benchmark here changes nothing on its own.

Request knobs, unchanged from the shell version and read the same way, just
now by the fork's backend process rather than a CLI: `LLAMA_TEST_MAX_TOKENS`
(2048), `LLAMA_TEST_TIMEOUT` (900 s), `LLAMA_TEST_CACHE_PROMPT` (`0`;
prompt-cache reuse makes a prefill figure meaningless, so it is off unless
asked for), `LLAMA_TEST_STREAM` (`1`), and `LLAMA_REASONING` for the effort
level — set them for `lllm-backend` the same way any other override is set.
`temperature` is pinned to 0 and is not overridable — two runs must
differ only by the flags under test. `LLAMA_TEST_RAW` is gone: it used to keep
the response's temp file, and every response is now stored in full in the
`benchmark_answer` table regardless. `LLAMA_GRADER_PYTHON` overrides the
interpreter the graders execute against. `LLAMA_PLAIN=1` (or `NO_COLOR`)
still forces plain output, and the fork now sets it itself on every
subprocess it streams into an SSE connection (the Serve and Tune pages, for
`llama-server`'s and a sweep's own output) — Rich's escape codes would
otherwise show up raw in a browser rather than being rendered.

### The benchmarks

| Benchmark | Items | Ground truth | License | Citation |
| --- | --- | --- | --- | --- |
| [HumanEval](https://github.com/openai/human-eval) | 164 | `test` field: a `check(candidate)` function, plus `entry_point` | MIT | Chen et al. 2021, [arXiv:2107.03374](https://arxiv.org/abs/2107.03374) |
| [MBPP (sanitized)](https://github.com/google-research/google-research/tree/master/mbpp) | 427 | `test_imports` + `test_list` (3 asserts) | CC-BY-4.0 | Austin et al. 2021, [arXiv:2108.07732](https://arxiv.org/abs/2108.07732) |
| [DS-1000](https://github.com/xlang-ai/DS-1000) | 1000 (511 Pandas/Numpy) | `code_context`, which defines `test_execution(solution)` | CC-BY-SA-4.0 | Lai et al. 2022, [arXiv:2211.11501](https://arxiv.org/abs/2211.11501) |

The Tests page's fetch action downloads them into the fork's own
`<DATA_DIR>/benchmarks/datasets/` (`BENCHMARKS_DATA_DIR` overrides it) — no
longer this repo's `tests/data/`, which is gitignored and now orphaned — and
writes a `MANIFEST.json` pinning the upstream revision and a SHA-256 of the
bytes actually downloaded. **Every result records that revision**: per this project's
convention a number without its configuration is not reusable, and for a pass
rate the configuration includes which items were asked. The datasets are fetched
rather than vendored — they are upstream-versioned, carry three different
licenses, and a checked-in copy would make every result trace back to that copy
instead of to a citable release. Fetching is stdlib-only (`urllib` + `json` +
`gzip`); DS-1000 comes from the HuggingFace `datasets-server` rows API, which
needs no authentication and no `datasets` package.

**Saturation, stated plainly:** HumanEval and MBPP are heavily contaminated for
a 2026 model and will sit near ceiling. That is acceptable here because the
question is not model capability but whether a *serving configuration* degrades
output, and a ceiling-hugging benchmark still detects a config that breaks
things. DS-1000 is explicitly perturbed against memorization and carries most of
the discriminating power.

**Coverage gap:** `CLAUDE.md` lists math and statistics among four primary use
cases; the suite covers coding and data analysis, and measures neither of the
other two. Adding GSM8K or a MATH subset is a new file in the fork's
`benchmarks/data/adapters/` rather than new code, but until that exists, a
pass rate here says nothing about
the math and statistics work this assistant is also for.

### Tiers

| Tier | Composition | Purpose |
| --- | --- | --- |
| `smoke` | 8 per benchmark, 24 items | The tuning loop: fast enough to run between two serving configurations |
| `standard` | 100 per benchmark, 300 items | An overnight run |
| `full` | Every gradeable item (164 + 427 + 439 = 1030) | The only tier comparable to a published score |

Sampling is seeded (`seed = 20260830`, recorded in each result) and sorted by the
dataset's own id before sampling, so `smoke` is the same 24 items on every run
and under every configuration.

**`smoke` is n=24. One item is about four percentage points.** Use it to detect
that a configuration *broke* something, not to rank two that both work. The
comparison output prints `passed/attempted` beside every rate and refuses to
rank rows from different tiers against each other.

### Grading

Each harness uses the benchmark's own evaluation logic:

- **HumanEval** — the last fenced block containing a `def` wins; the item's
  `test` field and `check(<entry_point>)` are appended and the whole thing is
  executed. When the model returned only a body, the stub is prepended so that
  answer is graded rather than discarded.
- **MBPP** — `test_imports`, then the code, then each assert in `test_list`.
- **DS-1000** — `code_context` is executed and its own `test_execution(solution)`
  is called with the extracted code as a string literal; `test_string(solution)`
  too when the item defines it.

Outcomes are `pass`, `fail_assert`, `fail_error`, `fail_timeout`, `no_code`, and
`skipped`. `reasoning_content` is never graded — it is chain of thought, not the
answer. **`skipped` is not a failure** and is excluded from every rate; counting
it would make installing a library look like a quality improvement.

Every outcome is a statement about the model's answer, so **a server that stops
answering produces no outcome at all**. A connection refused, or a stream that
dies mid-read, aborts the run: nothing is written for the item, the Tests
page's stream ends with an error event, and the resume action picks up from
there. Recording those as `fail_error` instead is what the 2026-09-04 entry in
`CLAUDE.md` describes — it filed a serving failure as a model failure, and
because `(suite_run_id, benchmark, item_id)` is unique, resuming then skipped
the item permanently. An HTTP error is deliberately not treated this way: the
server answered, and a 400 can be specific to one item.

> **The Tests page executes model-generated Python.** It runs in a
> subprocess, in a temporary working directory, under a timeout, and with
> `-I` (and `-S` for HumanEval/MBPP, which need only the standard library).
> That is **process isolation, not a sandbox.** It is what the upstream
> benchmark runners do and is acceptable on a single-user local box; it is
> not safe against adversarial output. Do not point this at a model you do
> not trust.

### Calibrating the graders — the Tests page's selfcheck action

The selfcheck action grades every benchmark's **own reference solution**
(`canonical_solution`, `code`, `reference_code`). No model is involved, so a
correct harness scores 100%; anything less is a bug in the grader. Measured on
2026-08-30 (Python 3.14.7, numpy 2.5.2, pandas 3.0.5, pyyaml 6.0.3):

**What calibration cannot catch**, stated because this repo has already been
bitten by it: it runs the reference solutions, so it never sees the
`prompt_template`. A template that misinstructs the model — as ds1000's did
until 2026-09-04, naming an output variable that 194 of 511 items do not use —
scores a correct answer wrong, and calibration reports 100% throughout, because
the reference solution uses the variable the problem actually names. Only
reading the failures finds that class of bug.

| Benchmark | Reference solutions passing | Ungradeable here |
| --- | --- | --- |
| HumanEval | 164/164 | 0 |
| MBPP | 427/427 | 0 |
| DS-1000 | 439/511 | 72 |

The 72 are not a grader bug. **DS-1000 was published in 2022 against pandas 1.x**,
and on pandas 3 a chunk of it fails before any model is involved:
`DataFrame.append` was removed in pandas 2.0, `replace(method=)` and
`read_csv(delim_whitespace=)` in 3.0, and the string dtype changed. Grading a
model against a test the dataset's own answer cannot pass measures the library
versions, not the model — it would have understated every model by about 14
points on that benchmark.

So selfcheck writes `<DATA_DIR>/benchmarks/datasets/<benchmark>/CALIBRATION.json`,
and those items are **skipped** when a suite runs, with the benchmark's own
verdict as the evidence. The calibration records the dataset hash and the
grading environment's library versions, and reports itself stale when either
changes — a calibration is only valid for the environment that produced it.
Re-run selfcheck from the Tests page after upgrading pandas or refetching a
dataset.

Note the consequence for comparability: a `full` DS-1000 pass rate from this box
is over 439 items, not 511, so it is not directly comparable to a published
DS-1000 number. The excluded items are in `benchmark_suite_exclusion`, and
their counts are reported beneath every comparison table.

### Where results are stored

Results go into the same Postgres database as the serving telemetry, which is
the point: the question this harness exists to answer — did the configuration
that ran faster also answer correctly — is a join, not a comparison between two
files.

| table | one row per | holds |
| --- | --- | --- |
| `benchmark_result` | attempted item | `suite_run_id`, timestamp, model, profile, benchmark, `item_id`, dataset revision, tier, seed, outcome, reason, `reasoning_chars`, `wall_ms`, the `system_name`/`system_sha` of the system prompt sent (NULL when none was), the `adapter_sha` of the adapter it was asked under (NULL when it predates the fingerprint, which here means *unknown*), the request `params` and the full llama.cpp `timings` — plus foreign keys to the `benchmark_request`, the `benchmark_run` and the `benchmark_config` it was measured under |
| `benchmark_answer` | result | the prompt, the answer that was graded, and the reasoning that was not, as three fields rather than one rendered blob |
| `benchmark_suite_exclusion` | item | what no run can attempt: outside an adapter's library filter, or marked ungradeable by calibration |

Three constraints do work a comment used to do:

- **`outcome` is a `CHECK`**, so an unknown outcome is unwritable rather than
  merely discouraged, and the pass-rate query method excludes `skipped` from
  the denominator rather than depending on every caller remembering to.
- **`request_id` links the throughput measurement to the verdict.** The same call
  used to write two rows to two independent stores with nothing connecting them;
  it is now one transaction and one foreign key.
- **`(suite_run_id, benchmark, item_id)` is unique**, which is what makes an
  interrupted-and-resumed suite idempotent — a re-run cannot double-count an item
  even if the resume check is skipped.

`config_id` is a foreign key to `benchmark_config`, so a row's serving flags
appear beside its pass rate. A hand-started server records NULL, displayed as
`unrecorded`, rather than a guess — a string sentinel would have to be exempt
from the constraint, and then the constraint would guarantee nothing. It is
denormalised onto `benchmark_result` deliberately: a result keeps its
configuration identity even if its run row is later pruned.

**Exclusions are recorded once, not per run.** They are a property of the
adapter, the calibration and this box's library versions — not of any serving
configuration — and are keyed by dataset revision so a refetch that changes the
items invalidates them. Recording them per run made a 24-item `smoke` suite write
569 rows, 545 of them exclusions: 23x the tier it described, and a count of a
suite's rows that meant nothing. It now writes 24.

**Every item is one committed transaction**, so an interrupted run leaves a
valid partial store. Resuming from the Tests page continues where it stopped.
A `full` run is many hours on this hardware and will be interrupted.

The serving telemetry is fed by the same transaction: a test run's requests
land in `benchmark_request` as before, and the Compare page's **by serving**
view reports them. Nothing was displaced.

Reading one answer back is the Answers page (`/benchmarks/answers`): pick a
suite run, pick `humaneval/HumanEval/0` (or any other item that run
attempted) from its list, and it renders that answer as markdown directly in
the browser — headings, and the model's own fenced code with syntax
highlighting, which is most of what there is to read. There is no
terminal/file duality any more: the browser is always the destination for a
single answer, and it always renders.

`--export <dir>`'s whole-run dump survives, but moved to the Compare page's
**export-answers** action rather than a flag on the single-answer viewer.
It recreates the pre-database `<dir>/<run>/*.md` layout on demand — every
graded item's answer already lives in `benchmark_answer`, so this just writes
it back out as flat files, named `<benchmark>__<item>.md`, under
`<DATA_DIR>/benchmarks/answers/<run>/` — for anyone who wants to grep, diff,
or archive a suite run outside the app. Unlike the single-answer view, the
export always includes the full chain of thought (there is no reader to
protect from the wire cost once it is already a file on disk).

One shape difference in the single-answer view follows from what a trace
costs to send rather than from the document format: the chain of thought
defaults to hidden, requested from the server only when a checkbox is
switched on — a trace can run to tens of thousands of characters, and it
should not cross the wire by default. That is the same reasoning collapsing
it in a `<details>` used to serve, just enforced earlier, at the request,
rather than left to whether the viewer happens to expand an element.

### Comparing — the Compare page

Groups results by (model, config-id, tier, system prompt, adapter) and ranks by
pass rate, then by generation throughput. Columns: the flag summary (`ngl`,
`parallel`, `spec`, `-ot`) joined from `benchmark_config` with the same helpers
that render the serving comparison, the `system` column (`<name>@<sha>`, or `-`
for a run that sent none), the `adapter` column (the adapter sha, or `?` for a
row recorded before adapters were fingerprinted), dataset revision, `passed/attempted`, pass rate, cold
prefill t/s, generation t/s, draft acceptance, and **passes per minute**.

`passes/min` is the honest combined metric on this hardware: pass rate alone would
rank a configuration that answers correctly at one token a second above a usable
one, and throughput alone is what the **by serving** view already reports.

Four things the output refuses to do, each learned from a mistake in this
project's decisions log:

- **Never a bare percentage.** `passed/attempted` is printed beside every rate.
- **Tiers never mix.** A 24-item pass rate and a 164-item one are not comparable,
  and the baseline selector reports `n/a (different tier)` rather than a delta.
- **A pair of configs differing in more than one flag is flagged as such.** This
  project lost a measurement to exactly that (the 2026-08-23 `--parallel` entry).
- **Same tier is not the same test.** Restricting a `smoke` run to one
  benchmark on the Tests page still records tier `smoke` while covering a
  third of it, and two rows are warned about when their
  benchmark sets differ or when the same benchmark was asked at two dataset
  revisions. The `revision` column reads `mixed` for any row spanning more than
  one benchmark, so the disagreement check is made per benchmark rather than on
  that collapsed string.
- **A system prompt is not a footnote.** Rows sent one are grouped separately
  from rows sent none, and a name appearing under two shas is called out: the
  file was edited between the runs, so the two rows are different prompts
  wearing the same name.
- **The adapter is part of the question.** `dataset_revision` pins the published
  items; `adapter_sha` pins the wrapper this repo puts around them. Rows either
  side of an adapter edit stay separate, and `?` — recorded before the
  fingerprint existed — is its own group rather than pooled with a known one,
  because it is unknown rather than none.

What each row could not attempt is reported once beneath the table, split by
reason, rather than as a per-configuration column — the exclusion set is identical
across every configuration, so a column for it said nothing.

Four views: **by config** (the default), **by benchmark**, **by failures**
(every item that did not pass, with its reason and the size of its reasoning,
newest first), and **by serving** (throughput and GPU telemetry per
configuration, with no test run involved). Filters on the page: tier, and a
baseline config to diff against. There is no built-in table export any more
(see above) — a measured table pasted into this README, per the maintenance
policy, is copied out of the rendered page by hand.

### Reporting — the Report page

The Report page's form takes the same scope filters the CLI's flags used to:
tier, model, benchmark, and a toggle for figures (off falls back to the same
unicode text plots, inline in the rendered markdown, that `--no-figures` used
to print). Generating a report writes `report.md` and its PNGs to
`<DATA_DIR>/benchmarks/reports/<run>/` — a fresh, timestamped directory per
report, never overwritten — and the page fetches and renders that markdown
document directly; there is no separate `--stdout` mode, since the browser
*is* the destination.

The Compare page's rankings say nothing about whether a difference they show is real. At
`smoke` the gap between two adjacent rows is routinely one item, and this repo's
own rule — never a bare percentage — exists because that gap reads as 4pp.
The Report page is the other half: it audits the design first, refuses the
comparisons the design cannot support, and runs the *paired* test where it can,
which matters because the tiers are seeded so every configuration draws the same
items and a test that ignores the pairing throws away the only thing that makes
8 items informative.

Seven sections, ordered so each gates the next: **provenance** (which database,
which rows, which revisions — the fork's Postgres is not something a reader
can casually open elsewhere, so a number without this is not checkable),
**design audit**, **reliability floor**, **paired accuracy**,
**power/MDE**, **throughput**, **throttle audit**.

The design audit is the part that earns the report. It is mechanical, and
against the current store it finds:

- **`model` and `config_id` are perfectly confounded** (one real config plus
  NULL), so no result here separates the model from the flags it was served
  under. `is_cold` is constant across all 297 requests. Both are reported as
  untestable rather than tested.
- **Levels ran sequentially, one suite per level, never interleaved**, and the
  GPU changed power state partway through run 4. Generation fell from a 39.6–50.8
  t/s band (40 requests, median 49.4) to 6.06–6.12 t/s at 03:05:59 and never
  recovered — not one of the 72 requests after that point exceeded 20 t/s. GPU
  telemetry says why: mean board power 27.2 W against 51.2 W before, and after
  the cliff *every non-idle sample* carries the throttle word `36`
  (`SwPowerCap | SwThermalSlowdown`), the remainder being `GpuIdle` between
  requests. The levels therefore do not share one GPU state, and the report
  prints which regimes each level actually ran under. **Four throughput
  contrasts are refused**, naming both the ordering and, where it applies, the
  power state.

  The naive test is computed anyway and printed beside the refusal, because it
  is what a reader would otherwise have run: for the mbpp × `9b503170` block a
  one-way ANOVA of generation t/s by system prompt returns **F = 419.3,
  p < 0.001** (Kruskal-Wallis H = 36.0), and it is measuring the power cap.
  Stratifying by regime collapses most strata to a single level, which is the
  honest picture: after the cliff there is no within-regime contrast left to
  make. `predicted_n` and `prompt_n` are analysed as the defensible
  responses, being properties of the response rather than of the clock, and a
  prompt-token manipulation check confirms `--system` actually reached the
  request body — this repo has already shipped a bug where it did not (the
  2026-09-04 second entry).

On accuracy the answer is null and the report says so with an interval rather
than a shrug: over the two complete blocks (mbpp × `9b503170` and ds1000 ×
`107a9a47`, each 8 items × 6 system levels, 48/48 cells, no holes), pooled
**Cochran's Q = 0.926 on 5 df, exact permutation p = 1.000 over all 10800
arrangements**. Twelve of the sixteen items are constant across all six prompts
and contribute nothing to a within-item test, so the comparison rests on the
four that vary at all — which the report states in those words rather than
printing `8/8` beside `7/8` and leaving a reader to infer a winner from one
item.

The power section then says what that null is worth, which is the part a ranking
table can never supply. Discordance — the share of item comparisons that change
verdict, and the quantity a paired binary test's power actually depends on — is
15/104 = 14.4%. At the 32 items entering a baseline comparison, **even a 14.4 pp
difference, the largest that can exist under that discordance rate, would be
found only 58% of the time**: there is no effect size this experiment had an 80%
chance of detecting, so its null is a statement about the experiment and not
about the prompts. Detecting 5 pp needs 451 items; 15 pp and 20 pp are reported
as `impossible` rather than as a number, because in a paired design the
difference in pass rate cannot exceed the discordance rate. The output is
therefore "run this next" — re-run one condition unchanged first, since **nothing
in this store measures run-to-run variability at all** and there is currently no
noise floor to read any difference against.

Statistics: scipy for the standard tests; Cochran's Q, its permutation p (exact
by enumeration when the arrangement count allows, Monte Carlo with the `+1`
correction otherwise), Wilson intervals, Holm correction and the MDE search are
written out in the fork's `open_webui/benchmarks/report.py` (a direct port of
the original `scripts/llama_report.py`, unchanged statistics), and were
cross-checked against statsmodels. Every test prints its `n` and its
assumption check; a test whose assumptions fail is printed as refused with
the reason, never dropped silently.

**Reads only.** No migration, no `benchmark_schema_note` row, no row
written — verified by checksum and row counts either side of a run. Rather
than opening the database itself in a read-only mode the way `mode=ro` did
against a SQLite file, the report goes through the same read-only async
Table-wrapper query methods every other read path in the fork uses, and never
touches the migration/stale-run-sweep path that a normal connection runs on
first use and that would therefore write.

Four figures, each drawing the test printed beside it rather than a
friendlier one. `fig1-timeline-run<n>` is generation throughput over run 4 in
request order, with the throttled spans shaded, the system-prompt boundaries
ruled, and the cliff labelled with its UTC timestamp and the medians either
side — the confound itself, in one picture. `fig2-matrix-<benchmark>-<config>`
is the item x level pass/fail grid with the *varying* rows drawn in full colour
and the constant ones muted, because the constant rows are the majority and
carry none of the information. `fig3-discordance-<benchmark>-<config>` is the
paired difference against the baseline — items lost and gained per level, the
`b` and `c` of the McNemar tables above it — and deliberately **not** a bar
chart of marginal pass rates, which would be the picture of the unpaired
comparison this report exists to refuse. `fig4-mde` is the detectable
difference against items per level, with the psi ceiling drawn as a horizontal
asymptote and this experiment's `n` marked whether or not any effect is
reachable at it. A figure with nothing to show is suppressed and replaced by
the sentence saying so, rather than drawn empty.

scipy is required and the Report page's request fails with a 503 naming the
install line rather than degrading (`SciPyUnavailable`, raised as an
`HTTPException`). matplotlib is optional: without it every figure becomes a
unicode block plot in a fenced code block, naming the reason, and the
document is otherwise byte-identical.

### Dependencies

The Benchmarks feature needs no separate Python environment of its own any
more: it runs inside the Open WebUI fork's own backend, under
`open-web-ui/openwebui/backend/.venv`, which `lllm-backend` already
bootstraps on first use (installing `open-web-ui/openwebui/backend/requirements.txt`)
the same way it bootstraps everything else the fork's backend needs. There is
nothing benchmark-specific left to install by hand.

This repo's own `requirements.txt` now carries exactly one thing, **Rich**,
for the three shell commands `scripts/llama_console.py` still backs
(`lllm-profiles`, `lllm-check`, `lllm-vram` — none of them benchmarking).
It degrades to plain stdlib output when Rich is absent, so its repo-local
`.venv` is a convenience, not a hard dependency; the venv is still required
rather than merely tidy on this box, since its Python is externally managed
(PEP 668) and `pip install` refuses outright otherwise. Textual was here for
the Textual dashboard (`llama-ui`); it was retired for `lllm-web` on
2026-09-06 and dropped from `requirements.txt` in that change.

`requirements-extra.txt` is gone. It used to carry **numpy**, **pandas**,
**pyyaml**, **scipy**, **matplotlib**, **fastapi** and **uvicorn** for
`lllm-test`/`lllm-compare`/`lllm-report`/`lllm-tune`/`lllm-web`; all five were
retired into the fork on 2026-09-08 (see "The Benchmarks section" below), and
those dependencies moved with them, into
`open-web-ui/openwebui/backend/requirements.txt` — alongside a new
`scikit-learn`, which widens the DS-1000 slice, and the same `pyyaml` pin,
now needed there for DS-1000 items that round-trip through YAML. scipy is
still a hard dependency (the Report page's request fails outright rather than
degrading, as before) and matplotlib is still soft (the same unicode-plot
fallback as before), just resolved by the fork's own venv now rather than
this repo's.

### The Benchmarks section

Benchmarks is not a second app. It is a set of pages inside the same Open
WebUI fork as chat, served by the same two host processes described in
"Running it" above (`lllm-frontend` on `5173`, `lllm-backend` on `4000`), and
reached through its own entry in the fork's sidebar — admin-only, modeled on
the existing Playground entry (`isMenuItemVisible`/`getMenuItemMeta`/
`menuItemPathPrefixes` in `Sidebar.svelte`, a matching pin-menu block in
`Sidebar/UserMenu.svelte`) rather than a tab inside the Settings modal like
Analytics, since seven interactive pages do not fit a settings panel. A
`benchmarks.enable` config flag (`ENABLE_BENCHMARKS` in the admin config
keys, surfaced as `enable_benchmarks`) gates whether the entry shows at all.

Those two ports are still the whole port table — there is nothing new to add
one for:

| what | port | started by |
| --- | --- | --- |
| Open WebUI chat + Benchmarks (vite dev server) | `5173` | `lllm-frontend` |
| Open WebUI + Benchmarks API (uvicorn) | `4000` | `lllm-backend` |

`lllm-backend` still owns Postgres's lifecycle (`open-web-ui/docker-compose.yml`),
starting it before uvicorn and tearing it down via a trap when uvicorn stops.
See "Running it" above for the full command sequence.

There is consequently no proxy question to answer any more, and there never
had to be a userscript bridging two origins for this to work — Caddy
(`open-web-ui/Caddyfile`) was already removed when the fork itself was set up
to bind `5173`/`4000` directly (see the 2026-09-07 decisions-log entry), well
before Benchmarks existed to need reaching from chat at all. Since Benchmarks
is just another route in the same frontend as chat, there is no second origin
to bridge and nothing for a userscript to do: `open-web-ui/dashboard-link.user.js`
is deleted, not merely unused, and a link from chat to Benchmarks is an
ordinary in-app sidebar entry rather than a fixed-position element glued onto
`<body>` from the outside.

**The GPU telemetry recorder's "must stay stdlib-only" rule is reversed.**
`scripts/llama_db.py`, `llama_record.py`, `llama_stats.py`, `llama_tests.py`,
`llama_compare.py`, `llama_report.py`, `llama_results.py`, `llama_proc.py`,
`llama_fetch.py`, `llama_tune*.py` and `llama_web*.py` are all deleted — that
rule existed only because the store was SQLite (stdlib) and the recorder ran
under bare `python3` for the life of every server; now that the store is
Postgres, a driver is unavoidable either way, so the recorder runs under the
fork's own backend venv and writes with `psycopg` directly (no SQLAlchemy, no
event loop — still a single ~5-second poll loop). It still runs as a
**separate subprocess**, not a task inside the fork's backend's own event
loop, and that part is unchanged on purpose: the whole reason it was ever a
subprocess was so a recording survives a crash or restart of whatever started
it, and folding it into the backend's event loop would trade that guarantee
away for no benefit.

**Retirement note, matching the Textual-dashboard note above:** the
userscript-bridged, two-process `lllm-web` topology this section used to
describe was retired for the fork-native Benchmarks section on 2026-09-08.

## Migrating to local hardware later

When ready to self-host (llama.cpp as above, or Ollama/vLLM), update the
connection under **Admin Panel → Settings → Connections**: change the base URL
to your local server's OpenAI-compatible endpoint (`http://localhost:8090/v1`
for the `lllm-serve` server above, or `http://localhost:11434/v1` for Ollama),
and update the API key if your local server requires one. No other
changes should be necessary, since Open WebUI talks to any OpenAI-compatible
endpoint.
