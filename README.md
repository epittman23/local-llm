# Personal AI Assistant

A personal AI assistant running on cloud-hosted open-weight models via
OpenRouter, using [Open WebUI](https://github.com/open-webui/open-webui) as
the chat interface. See `CLAUDE.md` for the full project rationale.

Open WebUI runs in Docker and talks directly to OpenRouter's OpenAI-compatible
API — there is no custom backend or frontend code in this repo; Open WebUI
*is* the app.

## Running it

Requires Docker Desktop with WSL integration enabled for this distro
(Docker Desktop → Settings → Resources → WSL Integration).

```bash
docker run -d \
  -p 3000:8080 \
  -e OPENAI_API_BASE_URL=https://openrouter.ai/api/v1 \
  -e OPENAI_API_KEY=<your OpenRouter API key, from https://openrouter.ai/keys> \
  -v open-webui:/app/backend/data \
  --name open-webui \
  --restart unless-stopped \
  ghcr.io/open-webui/open-webui:main
```

Then open `http://localhost:3000`. The first account you create becomes the
admin. Chat history, settings, and the model list are persisted in the
`open-webui` Docker volume.

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

Helper functions live in `scripts/llama-env.sh`. Source it from `~/.bashrc`:

```bash
[ -f "$HOME/dev/repos/local-llm/scripts/llama-env.sh" ] \
  && . "$HOME/dev/repos/local-llm/scripts/llama-env.sh"
```

It can also be invoked directly without sourcing:
`./scripts/llama-env.sh serve qwen38`.

Serving settings are grouped into profiles rather than scattered across env
vars. `llama-profiles` lists them and shows whether the weights are on disk:

| profile | arch  | model                             | ctx   | threads | ngl | slots | n-cpu-moe | override-tensors                         |
| ------- | ----- | --------------------------------- | ----- | ------: | --: | ----: | --------: | ---------------------------------------- |
| qwen36  | MoE   | `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` | 65536 |       6 |  99 |     1 |        34 | n/a                                      |
| qwen38  | dense | `Qwen3.8-27B-UD-Q3_K_XL.gguf`     | 16384 |      12 |  20 |     1 |       n/a | `output\.weight`, `blk\.64\..*` -> CUDA0 |

`qwen38`'s `-ngl 20` is a placeholder pending an `llama-sweep-ngl` run;
`--n-cpu-moe` is MoE-only and the script refuses to pass it to a dense model.
`qwen38` also pins two tensor groups to the GPU with `-ot` regardless of
`-ngl` — the output projection and the final block (the model has 65 blocks,
`blk.0` to `blk.64`), both touched on every token. `llama-sweep-ngl` passes the
same `-ot`, so its VRAM headroom matches what `llama-serve` will see. Override
per run with `LLAMA_OT`.

It additionally runs speculative decoding off the model's own multi-token
prediction head (`--spec-type draft-mtp --spec-draft-n-max 2`), so
no separate draft model is needed: the weights carry
`qwen35.nextn_predict_layers = 1` and `blk.64.nextn.*` tensors, and `-ot`
already keeps that block on the GPU. A draft depth of 2 is deliberately
conservative — rejected drafts cost real compute on a model this CPU-bound.
`llama-test` reports `draft_n` and `draft_n_accepted` in its timings, which is
the acceptance rate to judge it by. `LLAMA_SPEC=off llama-serve qwen38` turns
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

- `llama-serve [profile] [args...]` : start `llama-server` on port 8090 (set
  `LLAMA_PORT` to change). One-off overrides: `LLAMA_MODEL`, `LLAMA_CTX`,
  `LLAMA_THREADS`, `LLAMA_NGL`, `LLAMA_MOE`, `LLAMA_OT`, `LLAMA_SPEC`,
  `LLAMA_PARALLEL` (server slots, default 1), `LLAMA_REASONING` (thinking
  effort for `qwen38`). Extra arguments pass through to `llama-server`.
  KV cache types and batch sizes are profile variables too (`LLAMA_CACHE_K`,
  `LLAMA_CACHE_V`, `LLAMA_BATCH`, `LLAMA_UBATCH`; all default to the values in
  the table above), so the flags passed and the flags recorded in the log come
  from one place.
  `llama-qwen` is a backwards-compatible alias. `--metrics` is always passed, so
  the run's server-wide token totals can be recorded, and `-lv 4`
  (`LLAMA_LOG_VERBOSITY`) so the server prints what it decided about the model
  it loaded — the layer split, the slot count, the fused kernels it resolved,
  the tensors it ignored. Neither affects inference, and both are deliberately
  excluded from the config fingerprint. The server's output is tee'd to a
  temporary `logs/.server.<pid>.log` for the recorder to parse and deleted when
  the server exits; the terminal copy is unchanged except that the GGUF metadata
  dump `-lv 4` adds is filtered out of it.
- `llama-fetch [profile]` : download the profile's weights with the `hf` CLI.
- `llama-sweep-threads [profile] [4,6,8,...]` : `llama-bench` across thread
  counts, printed as a markdown table.
- `llama-sweep-ngl [profile] [12,16,20,...]` : `llama-bench` across GPU layer
  counts, for tuning a dense profile. Values that exceed VRAM error out, which
  is the useful signal.
- `llama-test [prompt] [profile]` : send a saved prompt to the running server
  and print the answer followed by llama.cpp's `timings` (prompt and generation
  tokens/s straight from the server, so a profile change can be judged without
  a separate `llama-bench` run). Prompts are `.txt` files in `prompts/`
  (`llama-test --list`); the default is `humaneval0`. `temperature` is pinned
  to 0 and the prompt is version-controlled, so two runs differ only by what
  you changed. The model name comes from the running server (`GET /v1/models`),
  not from the profile — the profile says how a model *would* be served, but
  something is already loaded, and a measurement labelled with the wrong model
  is worthless. A mismatch prints a warning and tests what is actually running.
  `reasoning_effort` is sent only for profiles whose template uses it.

  The response streams token by token, since at a few tokens per second a
  blocking call is indistinguishable from a hung server. **The answer goes to
  stdout and the model's thinking to stderr**, so `llama-test > answer.md`
  captures only the completion while the reasoning stays watchable in the
  terminal — worth knowing, because on a short prompt the thinking is most of
  the wait and stdout can stay empty for minutes. `--- thinking ---` and
  `--- response ---` banners mark the transition; both are printed to stderr,
  so a redirected answer stays free of them. Overrides: `LLAMA_PROMPTS`,
  `LLAMA_TEST_MAX_TOKENS` (2048), `LLAMA_TEST_TIMEOUT` (900 s),
  `LLAMA_TEST_STREAM=0` for a single blocking request, `LLAMA_TEST_RAW=1` to
  keep the raw response.

  Requests are sent with `cache_prompt: false`. `llama-server`'s own default is
  `true`, which means running the same prompt twice reprocesses only the tokens
  that changed: the second request reports `cache_n = 140, prompt_n = 4,
  prompt_per_second = 2.79` where the first reported `cache_n = 0,
  prompt_n = 144, prompt_per_second = 56.00`. Those are not two measurements of
  the same thing, and averaging them describes neither. `LLAMA_TEST_CACHE_PROMPT=1`
  turns caching back on to measure the follow-up-turn case deliberately; the log
  keeps those requests in their own columns.

  Each request's `timings` are also appended to the running configuration's log
  block (see below), so a comparison survives the terminal scrollback.
- `llama-check` : `GET /v1/models` against the running server.
- `llama-vram` : live `nvidia-smi` GPU telemetry.
- `llama-profiles` : list profiles and whether their weights are present.

### Recorded telemetry and throughput

`llama-serve` starts `scripts/llama-vram-log.sh` in the background and stops it
when the server exits, so every serving run leaves a record of what the GPU
actually did and how fast the model answered. The recorder waits for the port to
open, samples `nvidia-smi` every `LLAMA_VRAM_INTERVAL` seconds (default 5), and
appends the run to:

```
logs/<model-name>-<quant>.log     # e.g. logs/Qwen3.8-27B-UD-Q3_K_XL.log
```

The file names the model and quantization at the top, then holds one block per
serving configuration. Each block opens with three groups of context:

```
config-id: 9eab7cfc
server flags:
  arch: dense | ngl: 20 | ctx: 16384 (total) | parallel: 1 | threads: 12 | moe: n/a
  ...
request params (llama-test):
  temperature: 0 | max_tokens: 2048 | cache_prompt: false | stream: true | ...
load log:
  layers: 64 (all 65) | offloaded: 20/66 on GPU | cpu-resident: 46
  ...
```

**Only `server flags:` is fingerprinted.** The `config-id` is a hash over those
lines — arch, ngl, `--n-cpu-moe`, `-ot`, speculative-decoding flags, ctx, slot
count, threads, cache types, flash attention, batch sizes, reasoning effort, and
the server's sampler values. Changing any of them opens a new block instead of
mixing incomparable runs; rebuilding llama.cpp does not, since the build string
is recorded per run rather than fingerprinted.

The other two groups are *observations of a run*, not settings, so they are
recorded but not hashed — a run that served no `llama-test` request would
otherwise be a different configuration from one that did. They are replaced by
each new run of the block, and left alone when a run has nothing to say about
them.

- **`request params (llama-test):`** is what was actually in the request body,
  read back out of it rather than re-derived. It matters because the `samplers:`
  line under `server flags:` records the server's *defaults*, and a `llama-test`
  request overrides them: the server may say `temp 1.0 | top-p 0.95`, but the
  measured request ran at `temperature: 0`. If a run used more than one set of
  parameters, each is listed with the number of requests that used it.
- **`load log:`** is what the server said about the model it loaded, parsed from
  its own output. None of it is derivable from the flags, and all of it decides
  whether two runs measure the same thing:

  | field | why it is here |
  | --- | --- |
  | `layers` | the block count the model reports (`n_layer`, and `n_layer_all` when a head such as MTP makes them differ) |
  | `offloaded` | the split llama.cpp *reports*, not the one `-ngl` asked for: `-ngl` is a ceiling, clamped to what fits and counting the output layer. `cpu-resident` is the rest, and is what generation speed on this hardware tracks |
  | `n_slots`, `n_ctx_slot`, `kv_unified` | the resolved slot configuration — the thing `--parallel` was silently getting wrong before 2026-08-23 |
  | `model buffers` | per-device weight bytes, so VRAM headroom can be read against what the weights alone took |
  | `fused_gdn` | whether the fused Gated Delta Net kernels were resolved to `enabled` or `disabled` |
  | `mtp head` | whether the file carries a multi-token-prediction head, and whether the server used it or ignored it. Present-and-ignored is loaded weights doing nothing |
  | `unused tensors` | how many tensors the loader found and skipped, with their distinct name prefixes. `blk.64.nextn.*` here means the MTP head was read and dropped |
  | `warning:` / `DEPRECATED:` | any device-mismatch or deprecation line, verbatim, because the wording is the evidence |

  **`fused_gdn` makes two runs incomparable.** llama.cpp resolves those kernels
  per context, at load, by checking that the fused node landed on the same device
  as the layer it belongs to (`src/llama-context.cpp:504`). Whether it succeeds
  depends on where the layers ended up, so the same `-ngl` on a machine with a
  slightly different memory state can land on either answer — and the disabled
  path runs a different set of operations, at a different speed, under a
  config-id that says nothing about it. When it is `disabled`, the warning lines
  below it say which layer and which device caused it.

  Anything the log does not state is written `unavailable` rather than guessed;
  a plausible default here would be indistinguishable from an observation. If
  the whole group is missing, the run was recorded without the server's output
  (a hand-started server) and whatever an earlier run observed is left in place.

A block then holds four tables:

| section | one row per | contents |
| --- | --- | --- |
| `### previous runs` | run | start, duration, sample count, build, avg/max temperature, utilization, memory used, power, SM clock; then p50/p95 utilization, active-only average utilization, p50/p95 power, p50/p95/max SM clock, VRAM headroom, and the throttle reasons seen |
| `### previous runs - requests` | run | requests split into cold and warm, then **cold-only** total/avg prompt tokens, total/avg prompt parse seconds and prompt t/s; warm avg cached tokens, prompt tokens and prompt seconds; total/avg output tokens, total/avg output seconds, total/avg end-to-end seconds |
| `### previous runs - server totals` | run | `/metrics` deltas: prompt tokens, cached prompt tokens, prompt seconds, prompt t/s, output tokens, output seconds, output t/s, draft tokens, draft tokens accepted, verification steps, acceptance, mean accepted length |
| `### latest run` + `#### requests` | sample / request | every GPU sample, and every `llama-test` request with llama.cpp's raw `timings` fields as columns (`cache_n`, `prompt_n`, `prompt_ms`, `prompt_per_token_ms`, `prompt_per_second`, `predicted_n`, `predicted_ms`, `predicted_per_token_ms`, `predicted_per_second`, `draft_n`, `draft_n_accepted`) plus the measured wall clock, acceptance and mean accepted length |

The two throughput tables come from different places on purpose, and will not
agree:

- **requests** are exact and per-request, but only `llama-test` contributes them
  — a version-controlled prompt at `temperature 0`, which is what makes two runs
  comparable. Traffic from Open WebUI or a hand-written `curl` is not counted.
- **server totals** are the deltas of the server's own `/metrics` counters over
  the run, so they cover *every* client. They are cumulative totals only: the
  endpoint exposes no per-request breakdown, and (as of build 10597) no request
  counter at all, which is why that table has no `requests` column. It is
  omitted entirely when nothing was served or when `--metrics` was off. The
  baseline is taken when `/metrics` first answers, which is after the model
  finishes loading rather than when the port opens — the endpoint returns 503
  until then.

**Utilization has two averages, and they answer different questions.** Sampling
runs for the life of the server, so an idle server drags the mean toward zero: a
recorded `qwen38` run that spent 32 s of its 92 s answering two prompts logs
`util avg/max` of `1/9`. `util active avg` averages only the samples that saw
work, and `util p50/p95` say which of the two states the run mostly sat in. Note
that even the busy samples are low here — the CPU-resident layers are the
bottleneck during generation and the GPU spends most of a token waiting, so a
small `util active avg` is the expected reading, not a sign of a stalled run.

**VRAM headroom is a first-class column.** `vram headroom (MiB)` is what was
still free at the run's peak, and the block prints a `> warning:` line naming any
run that finished under `LLAMA_VRAM_HEADROOM_MIB` (default 300). The `load log:`
group converts it into the unit `-ngl` is tuned in — how many more layers would
fit, at this model's own GPU-resident bytes divided by the layers that got there.
That per-layer figure is an average: the output head and the final block are not
the size of a repeating block, and the KV cache grows alongside them, so treat a
prediction of one more layer as a thing to test, not a thing to assume.

**Throttle reasons are recorded per run, not per sample.** The recorder queries
`clocks_throttle_reasons.active`; the log lists the distinct set decoded across
the run, because per sample it would be a column of near-identical hex. `GpuIdle`
is not a fault — it is set whenever the GPU has nothing to do, which here is most
of a run. `SwPowerCap`, `SwThermalSlowdown` and `HwThermalSlowdown` are the ones
that mean a measurement was taken under a limit and is not comparable with one
that was not. Undocumented bits are printed as hex rather than guessed at.

**Speculative decoding gets `acceptance` and `mean_len`.** `acceptance` is
`draft_n_accepted / draft_n`; `mean_len` is llama.cpp's mean accepted length per
verification step, `1 + accepted/steps`. Both are blank, not zero, when nothing
was drafted. In the `llama-test` tables `mean_len` is *derived*: a request's
`timings` carry `draft_n` and `draft_n_accepted` but not the step count (build
10597 keeps `n_draft_verif_steps` in the slot's stats and exposes it only through
`/metrics`), so steps are inferred as `draft_n / --spec-draft-n-max`. That is
exact while every step drafts the full depth, which `draft-mtp` at `p_min = 0`
always does. The `server totals` row beside it carries the server's own exact
figure from `spec_decode_num_drafts_total`, which is the one to trust if they
ever disagree. On the `qwen38` run of 2026-08-24T02:25:34Z they did not: 44
tokens drafted, 41 accepted, and the server counted exactly the 22 verification
steps the derivation assumes, so both tables read `0.932` / `2.864`.

**Cold and warm prefills are never blended.** `cache_n` is the number of prompt
tokens llama.cpp took from its cache instead of processing; any request with
`cache_n > 0` had part of its prompt already in a slot, so its `prompt_n` counts
only the remainder and its `prompt_per_second` measures a handful of tokens
against fixed per-request overhead — 2.79 t/s where the same prompt cold gives
56.00 t/s. Mixing the two produces a prefill number that belongs to no
configuration. So the `cold prompt ...` columns count only `cache_n == 0`
requests, warm ones are averaged separately (their prefill is a real cost, just a
different question: what a follow-up turn costs), and the `cold reqs`/`warm reqs`
counts say what the run contained. Rows with those two counts empty predate
2026-08-23 and did blend the two.

The `server totals` table cannot make this split — the `/metrics` counters do not
break down per request — but it does not need a correction either:
`prompt_tokens_total` counts only *processed* tokens, with cache hits going to
the separate `prompt_tokens_cached_total` shown beside it (verified in the build
10597 sources, not assumed). Its `prompt t/s` is therefore already cache-free,
while its token totals mix cold and warm runs of every client.

End-to-end time is the wall clock measured around the request, not
`prompt_ms + predicted_ms`; on a streamed response the two differ, and the wall
clock is what you actually waited. It covers every request, cold and warm alike,
as do the output-token columns: generation speed does not depend on how the
prefill was obtained.

**The head of the file compares configurations.** Everything below the notes and
above the first block is a `## comparison` section, rebuilt from scratch on every
merge, holding one row per `config-id` — `ngl`, `parallel`, `spec`, `-ot`,
`fused_gdn`, cold prefill t/s, generation t/s, acceptance, peak VRAM, headroom,
and how many runs the block holds — sorted by generation throughput, fastest
first. Configurations that have never been measured sort last rather than as
zero: they are unknown, not slow. Each row is that configuration's **most recent
run**, not an average of its history, because an older run may predate a
llama.cpp rebuild or have shared the machine with something else, and averaging
would hide the change being looked for. Long values are shortened for the table
(`-ot` shows its first pattern and a count of the rest, `spec` shows the draft
type and depth); the block below always has the full text. A figure marked `*`
came from `/metrics` rather than from `llama-test` — it covers every client and
whatever prompts they sent, so it answers a looser question than a row measured
on the version-controlled prompt.

A `### derived` table follows it with `cpu-resident layers`, `ms/token` (the
reciprocal of generation t/s), and `cpu bandwidth (GiB/s)` — the CPU-resident
weights from the load log divided by the time one token takes. On a dense model
every resident weight is read once per token, so that is close to the real
effective bandwidth and is what says whether a configuration is bandwidth bound.
On an MoE it reads `n/a (moe)` rather than a number: only the routed experts are
read per token, so dividing by all of them would understate the bandwidth
severalfold.

When two or more configurations differ *only* in `-ngl`, a line beneath the table
fits `ms/token` against `cpu-resident layers` by least squares and reports it in
the form `<slope> ms per layer + <intercept> ms fixed`. Read the slope as the
price of moving one layer off the GPU — that is the number an `-ngl` decision
turns on. Do **not** divide `ms/token` by `cpu-resident layers` and call that the
per-layer cost: that charges the whole per-token time to the resident layers,
fixed part included, so it always overstates the slope, and by more the larger
the fixed part is. The intercept is that fixed part — the GPU-resident layers,
sampling, the draft head — and on this hardware it is a large share of the total.
The fit needs at least two configurations at different layer counts and is simply
absent otherwise.

Only the most recent run of a configuration keeps its full sample and request
tables; when a newer run finishes, the older one survives as its summary rows,
so the files stay small over time. Every table is rewritten with padded,
uniform-width columns on each write (numeric columns right-aligned), so the whole
file stays readable as plain text, not just when rendered as markdown.

`scripts/llama_log.py` does the assembly — parsing, statistics, retention, and
formatting — and is called by the shell functions, never directly. The shell
stays the interface; the arithmetic lives where it is easier to get right.

`logs/` is gitignored. Set `LLAMA_VRAM_LOG=0` to disable recording, or run
`./scripts/llama-vram-log.sh record [profile]` by hand to capture a server that
was started some other way; it stops on its own once the port stops answering.
While it is recording it leaves `logs/.active-run.json`, which is how
`llama-test` knows which run its timings belong to; without it a test still runs
and prints its numbers, they are just not recorded.

**Known limitation:** the config lines describe the *profile* as resolved when
the recorder started, not the argv of the process actually serving. A server
started by hand, or one whose profile was edited mid-session, can therefore be
filed under a configuration it was never run with. The per-request rows carry
the model name the server reported, which at least makes that detectable.

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

`llama-test humaneval0` against `llama-serve qwen38`, build `95b8e33e1`
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
`-ot`, and it produced a shorter completion. `LLAMA_SPEC=off llama-serve
qwen38` followed by the same `llama-test` run is the comparison to make — and
before 2026-08-23 it would not have been valid either, because dropping the
speculative flags also dropped `--parallel 1` and left the baseline serving 4
unified slots (fixed 2026-08-23; see the slot-count paragraph above).

Note the whole request took ~5.5 minutes: 958 tokens at ~2.9 t/s, most of them
reasoning tokens emitted before any answer text. Generation here is bound by
system-RAM bandwidth for the CPU-resident layers, which is also why drafting
helps less than its acceptance rate suggests.

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
the current build is newer, and `llama-sweep-threads` now passes the profile's
`-ngl` and `--n-cpu-moe`, so it benchmarks the serving configuration rather
than llama-bench's defaults. Re-measure before relying on them.

## Migrating to local hardware later

When ready to self-host (llama.cpp as above, or Ollama/vLLM), update the
connection under **Admin Panel → Settings → Connections**: change the base URL
to your local server's OpenAI-compatible endpoint (`http://localhost:8090/v1`
for the `llama-qwen` server above, or `http://localhost:11434/v1` for Ollama),
and update the API key if your local server requires one. No other
changes should be necessary, since Open WebUI talks to any OpenAI-compatible
endpoint.
