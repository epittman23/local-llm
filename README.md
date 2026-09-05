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

| profile | arch  | model                                    | size on disk | ctx   | threads | ngl | slots | n-cpu-moe | override-tensors                         |
| ------- | ----- | ---------------------------------------- | -----------: | ----- | ------: | --: | ----: | --------: | ---------------------------------------- |
| qwen36  | MoE   | `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf`        |    20.81 GiB | 65536 |       6 |  99 |     1 |        34 | n/a                                      |
| qwen38  | dense | `Qwen3.8-27B-UD-Q3_K_XL.gguf`            |    12.24 GiB | 16384 |      12 |  20 |     1 |       n/a | `output\.weight`, `blk\.64\..*` -> CUDA0 |
| qwen25c | dense | `Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf`  |     4.36 GiB | 16384 |       6 |  99 |     1 |       n/a | n/a                                      |

`qwen25c` is the only profile here whose weights fit in 6 GB outright, so
`-ngl 99` puts all 28 blocks and the output head on the GPU and nothing is read
from system RAM. That is the whole reason it exists: `qwen36` and `qwen38` are
3-5x this card and are bound by how fast their CPU-resident weights can be read,
which is what holds them to single-digit tokens/s. Nothing about its throughput
is measured yet, so no figure for it is quoted here; `llama-test --suite smoke`
against a served instance is what would produce one. It needs no `-ot` (nothing
is left on the CPU to pin), sets no speculative flags (Qwen2.5 predates the
`nextn` tensors `qwen38` drafts from), and sets no reasoning effort: it is not a
thinking model, so responses carry no `reasoning_content` and the token budget
is all answer. Its samplers are Qwen2.5-Coder's own
(`--temp 0.7 --top-p 0.8 --top-k 20 --repeat-penalty 1.1`), which govern Open
WebUI traffic; `llama-test` pins temperature to 0 in its request body either way.
Its context is 16384 rather than the model's full 32768 because the KV cache
here costs ~29.7 KiB/token at `q8_0` (28 layers, 4 KV heads of 128): ~476 MiB at
16K against ~952 MiB at 32K, on top of 4.36 GiB of weights and the compute
buffer. The full window fits inside 6 GiB only with less margin than
`LLAMA_VRAM_HEADROOM_MIB` warns at, so it is opt-in via `LLAMA_CTX`, to be
confirmed with `llama-vram` rather than assumed.

`qwen38`'s `-ngl 20` is a placeholder pending an `llama-sweep-ngl` run;
`--n-cpu-moe` is MoE-only and the script refuses to pass it to a dense model.
`qwen38` also pins two tensor groups to the GPU with `-ot` regardless of
`-ngl` — the output projection and the final block (the model has 65 blocks,
`blk.0` to `blk.64`), both touched on every token. `llama-sweep-ngl` passes the
same `-ot`, so its VRAM headroom matches what `llama-serve` will see. Override
per run with `LLAMA_OT`. `llama-serve` warns to check the load log's `n_layer`
before treating an `-ngl` as tuned, but only for a dense profile that is
partially offloaded: at `-ngl 99` there is no layer count being chosen.

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
- `llama-test <benchmark>/<item-id>` : run one published benchmark item against
  the running server, grade it with that benchmark's own tests, and record the
  result. `llama-test --suite smoke|standard|full` runs a whole tier. See
  [Testing](#testing) below — this command replaced the earlier
  "send a saved prompt from `prompts/` and eyeball the answer" version. Test
  items now come from the datasets; `prompts/` holds only the optional system
  prompts `--system` sends, and nothing in it is a test item or an answer.
- `llama-ui` : a Textual dashboard over serving, testing, comparison and the
  stored answers. Every screen shows the shell command equivalent to its current
  form state, so it teaches the flags rather than hiding them.
- `llama-db {shell|sql|schema|prune|vacuum|export}` : raw access to
  `logs/llama.db`, where every measurement this repo takes is stored.
- `llama-check` : `GET /v1/models` against the running server.
- `llama-vram` : live GPU telemetry, refreshed in place, with free VRAM called
  out — on a 6 GB card headroom is what decides whether an `-ngl` is viable.
- `llama-profiles` : list profiles and whether their weights are present.
- `llama-profile-json [profile]` : a profile's resolved settings as JSON. Exists
  so the Python tooling can read the serving configuration without re-declaring
  it; `scripts/llama-env.sh` stays the single source of truth. `reasoning` is
  empty for a profile that sets no thinking effort, the same test the telemetry
  fingerprint makes before recording `n/a`, so a caller cannot end up setting
  `LLAMA_REASONING` for a server that ignores it.
- `llama-profile-names` : the defined profiles, one per line, from the
  `LLAMA_PROFILE_NAMES` array. `llama-profiles` and the dashboard's profile
  picker both read it, so adding a profile is an edit to `scripts/llama-env.sh`
  and nothing else.

### Recorded telemetry and throughput

`llama-serve` starts `scripts/llama-vram-log.sh` in the background and stops it
when the server exits, so every serving run leaves a record of what the GPU
actually did and how fast the model answered. That script is now a thin wrapper:
it resolves the profile, computes the configuration fingerprint, and hands off to
`scripts/llama_record.py`, which waits for the port to open, samples `nvidia-smi`
every `LLAMA_VRAM_INTERVAL` seconds (default 5), scrapes `/metrics` on the same
pass, parses the server's own load output, and writes each of those as it happens
to one file:

```
logs/llama.db
```

**One database, for everything this repo measures.** Serving configurations, runs,
GPU samples, `/metrics` scrapes, per-request timings, test results, and the full
answers are tables in it. Model and quantization are columns rather than halves of
a filename, so a cross-model question is a query rather than a comparison between
files that never sit beside each other.

Nothing is written as markdown any more and nothing is parsed back out of one.
Markdown is an *output* format — `llama-test compare --format markdown` renders a
measured table for pasting into this README, as the maintenance policy requires —
and no code reads it.

#### The tables

| table | one row per | holds |
| --- | --- | --- |
| `config` | serving configuration | the fingerprinted configuration text verbatim, plus the flags parsed out of it (`arch`, `ngl`, `ctx`, `parallel`, `threads`, `moe`, `override_tensors`, `speculative`, cache types, flash attention, batch sizes, reasoning effort, samplers) |
| `run` | serving run | `config_id`, model, quant, llama.cpp build, port, pid, start and end. `ended_at IS NULL` means it is serving now |
| `gpu_sample` | `nvidia-smi` sample | temperature, utilization, memory used/total, power, SM clock, and the raw `clocks_throttle_reasons.active` bitmask |
| `metrics_scrape` | counter, per scrape | the server's own `/metrics` counters, the whole series |
| `run_load_info` | run | what the server said about the model it loaded: the layer split, slot configuration, per-device buffer sizes, `fused_gdn`, the MTP head, unused tensors, warnings, `DEPRECATED` lines |
| `request` | request | llama.cpp's raw `timings` fields as columns, the measured wall clock, the request parameters, and the whole `timings` object as JSON |
| `result` | graded item | the verdict, with foreign keys to the `request` that produced it, the `run` it belongs to, and the `config` it was measured under |
| `answer` | result | prompt, answer, and reasoning as three fields, not one rendered blob |
| `suite_exclusion` | item | what no run can attempt, recorded once against a dataset revision rather than once per run |
| `schema_note` | discontinuity | append-only provenance: what changed, and on what date, when it changed the meaning of rows either side of it |

Views do the arithmetic that used to be computed at write time: `v_request`
(adds `is_cold`, `acceptance`, `mean_len`), `v_pass_rate` (which encodes
"`skipped` is excluded from the denominator" in SQL rather than in every
caller), `v_run_gpu`, `v_run_metrics`, and `v_config_latest`.

**Summaries are derived on read, and every sample is kept.** This reverses the
2026-08-23 retention rule, which discarded raw samples once a newer run finished
and kept only the already-computed summary — so a statistic computed wrongly
could never be recomputed. At roughly 60 bytes a row and 5 s intervals, a day of
continuous serving is about 1 MB. `llama-db prune --before <date>` exists for the
day that matters, and it deletes only samples and scrapes, never results,
answers, requests or configurations.

#### What identifies a configuration

The `config_id` is a `sha1[:8]` over the serving flags, computed by
`_vramlog_config` in `scripts/llama-vram-log.sh` — the same function, over the
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

Changing any of them makes a new `config` row instead of mixing incomparable
runs. Rebuilding llama.cpp does not: the build string is a column on `run`, not
part of the hash. `-lv` and `--metrics` are excluded for the same reason — they
change what the server says about itself, not what it computes.

`config_text` is stored verbatim because it is what the hash covers, and the
typed columns are parsed out of *that text* on insert rather than supplied
separately, so a column cannot disagree with the fingerprint that identifies its
row.

Two kinds of context are recorded but never fingerprinted, because they are
observations of a run rather than settings — a run that served no `llama-test`
request would otherwise be a different configuration from one that did:

- **`request.params`** is what was actually in the request body, read back out of
  it rather than re-derived. It matters because `config.samplers` records the
  server's *defaults* and a `llama-test` request overrides them: the server may
  say `temp 1.0 | top-p 0.95` while the measured request ran at `temperature: 0`.
- **`run_load_info`** is what the server said about the model it loaded. None of
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
  has no `run_load_info` row, rather than a row of `unavailable`. Nothing is
  guessed: a plausible default here would be indistinguishable from an
  observation.

#### Reading it back

```bash
llama-test compare --by serving
```

One row per configuration — `ngl`, `parallel`, `spec`, `-ot`, `fused_gdn`, cold
prefill t/s, generation t/s, draft acceptance, peak VRAM, headroom, build — sorted
by generation throughput, fastest first, with a `derived` table beneath it. Each
row is that configuration's **most recent run**, not an average of its history,
because an older run may predate a llama.cpp rebuild or have shared the machine
with something else, and averaging would hide the change being looked for.
Configurations never measured sort last rather than as zero: they are unknown, not
slow. A figure marked `*` came from `/metrics` rather than from `llama-test` — it
covers every client and whatever prompts they sent, so it answers a looser
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

`llama-ui` shows the same tables, plus two tabs of its own. **Live** is the run
that is serving right now — its GPU statistics, its `/metrics` deltas and its most
recent samples, refreshed every 5 seconds; that view is possible because samples
land in the database as they are taken rather than being folded in when the
recorder exits. **Answers** is the pairing for `--by failures`: pick a suite run,
list its failures (or all its items, or its passes), and read the response
rendered as markdown, with the `llama-test answer` invocation for the highlighted
row shown above it. The thinking is off by default and toggled with a button —
reasoning dominates the token budget on this model, so a trace routinely runs to
tens of thousands of characters, and it is never graded.

`llama-db` is the raw access:

```bash
llama-db sql "SELECT config_id, ngl, speculative FROM config"
```

`shell` opens an interactive `sqlite3`, `schema` prints the DDL, `prune --before
YYYY-MM-DD` drops old samples and scrapes, `vacuum` reclaims the space, and
`export` writes every table to CSV.

#### Reading the numbers

**Utilization has two averages, and they answer different questions.** Sampling
runs for the life of the server, so an idle server drags the mean toward zero: a
recorded `qwen38` run that spent 32 s of its 92 s answering two prompts logs
`util avg/max` of `1/9`. The active-only average covers only the samples that saw
work, and the p50/p95 say which of the two states the run mostly sat in. Note that
even the busy samples are low here — the CPU-resident layers are the bottleneck
during generation and the GPU spends most of a token waiting, so a small active
average is the expected reading, not a sign of a stalled run.

**Percentiles and throttle decoding stay in Python**, in `scripts/llama_stats.py`.
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

**Speculative decoding gets `acceptance` and `mean_len`, both derived in
`v_request`.** `acceptance` is `draft_n_accepted / draft_n`; `mean_len` is the
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
configuration. `v_request.is_cold` makes the split queryable, and every prefill
figure reported is cold-only.

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

- **`request` rows** are exact and per-request, but only `llama-test` contributes
  them — a version-controlled prompt at `temperature 0`, which is what makes two
  runs comparable. Traffic from Open WebUI or a hand-written `curl` is not
  counted.
- **`metrics_scrape` rows** are the server's own counters, so they cover *every*
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
which is how `llama-test` knows which run its timings belong to, and a run whose
recorded `pid` is no longer alive is detectably stale and is closed by a sweep on
the next connect. This is strictly more robust than the `logs/.active-run.json`
it replaces: that file was removed by an EXIT trap, which a `kill -9` skips,
leaving a stale marker that later results were filed under. Samples are written as
they are taken, so a killed recorder loses nothing but the sample it was in the
middle of.

A test still runs and prints its numbers when no run is open; its `config_id` is
simply NULL, displayed as `unrecorded`, rather than attributed to a guess.

`logs/` is gitignored, so `logs/llama.db` and its `-wal`/`-shm` files need no
`.gitignore` change. Set `LLAMA_VRAM_LOG=0` to disable recording, or run
`./scripts/llama-vram-log.sh record [profile]` by hand to capture a server that
was started some other way; it stops on its own once the port stops answering.
`LLAMA_DB` overrides the database path.

**Known limitation:** the configuration lines describe the *profile* as resolved
when the recorder started, not the argv of the process actually serving. A server
started by hand, or one whose profile was edited mid-session, can therefore be
filed under a configuration it was never run with. The `request` rows carry the
model name the server reported, which at least makes that detectable.

**The database starts empty.** The markdown serving logs and `logs/tests.jsonl`
that preceded it were deliberately not imported, so nothing in it predates
2026-08-30 and `llama-test compare` says nothing until a new serving run and a new
test run happen. Those files were **deleted on 2026-09-04**: they had been kept
in `logs/` as a historical reference, read by no code, and five days of that was
enough to establish that nothing wanted them. Measurements taken before
2026-08-30 therefore no longer exist anywhere. `schema_note` records this, and
every other discontinuity, inside the database itself.

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
> import and its `def`. `llama-test` now renders prompts from the dataset
> itself, so each of these five prompts is two bytes longer than the string that
> was measured. Checked against the server's `/tokenize` on 2026-08-30 rather
> than assumed: all five tokenize to **the same length as before** (135, 127,
> 96, 130, 129 content tokens) and differ in exactly **one token id** each — the
> newline run absorbs the added blank lines. Same token count, same prefill
> work, so these figures remain comparable to runs made after the change.
> `humaneval0`-`humaneval4` here are `HumanEval/0`-`HumanEval/4` under the new
> naming. See the 2026-08-30 decisions-log entry in `CLAUDE.md`.

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
the current build is newer, and `llama-sweep-threads` now passes the profile's
`-ngl` and `--n-cpu-moe`, so it benchmarks the serving configuration rather
than llama-bench's defaults. Re-measure before relying on them.

## Testing

Serving configurations used to be judged on speed alone. The telemetry above
records throughput, GPU behaviour and per-request timings in detail, but until
2026-08-30 nothing recorded whether a configuration that ran faster also
answered *correctly* — which is the question that decides whether local
inference can replace OpenRouter.

`llama-test` now runs items from published benchmarks, grades them with each
benchmark's own test code, and records the result beside the serving telemetry.

**Nothing in this repository states an expected answer.** Every item and every
verdict comes from the dataset. The files in `tests/adapters/` describe only
*adaptation* — how a completion-style stub becomes a chat turn, which harness
grades it, how long it may run.

Adaptation is still an input to the measurement, so each adapter is
fingerprinted: `adapter_sha` is the first 12 hex of a sha1 over its
`prompt_template`, `[item]`, `[filter]` and `[check]`, recorded on every result
and part of the `compare` grouping key. It covers the parsed fields rather than
the file's bytes — an adapter carries the prose explaining its own shape, and
hashing that would file a comment edit as a measurement discontinuity. What it
buys is that editing a `prompt_template` can no longer make old and new results
silently incomparable, which is the same failure `config_id` prevents for
serving flags and `system_sha` for system prompts.

A **corrected `prompt_template` should be treated as a new benchmark**, not a
better version of the old one. The ds1000 template was corrected on 2026-09-04
(it told every item to assign `result`, which was false for 194 of the 511
in-filter items); rows recorded before that carry a NULL `adapter_sha`, show as
`?` in `compare`, and are not comparable to rows after it.

### Commands

| Command | What it does |
| --- | --- |
| `llama-test <benchmark>/<item-id>` | One item, streamed. `llama-test humaneval/HumanEval/0` |
| `llama-test --suite smoke\|standard\|full` | A whole tier. `--benchmark <id>` restricts it, `--resume` continues the most recent run of that tier, `--quiet` drops the streaming for a long run |
| `llama-test --system <name>` | Send the system prompt in `prompts/system/<name>.txt` with every item of that run — see below |
| `llama-test list` | The benchmarks, their pinned revisions, the tiers, what is calibrated, and the defined system prompts with their shas |
| `llama-test fetch [benchmark]` | Download and pin the datasets (`--force` refetches) |
| `llama-test selfcheck [benchmark]` | Grade the datasets' own reference solutions and write the calibration |
| `llama-test compare [...]` | Rank models and configurations — see below |
| `llama-test answer <benchmark>/<item-id>` | Print a stored answer, rendered as markdown on a terminal and raw when redirected. `--run-id` picks a suite run, `--export <dir>` writes a whole run's answers as files |
| `llama-test report` | The comparison, to the terminal, without running anything (`llama-test compare` with `--format`/`--tier` only) |
| `llama-test ui` | The Textual dashboard (same as `llama-ui`) |
| `llama-db {shell\|sql\|schema\|prune\|vacuum\|export}` | Raw access to `logs/llama.db` |

`--profile` names the serving profile whose alias and `reasoning_effort` are
used; the model name itself is read from the running server (`GET /v1/models`)
and a mismatch warns rather than mislabels, since the profile describes an
intended configuration while the server is already serving something.

#### System prompts

By default a request carries one message: the item. `--system <name>` puts the
text of `prompts/system/<name>.txt` in front of it as a `system` message, which
is where Open WebUI puts its own, and is the only place it can go — this
`llama-server` build has no system-prompt flag.

```bash
llama-test list                               # the prompts, with their shas
llama-test --suite smoke                      # baseline: no system prompt
llama-test --suite smoke --system assistant   # the same 24 items, with one
llama-test compare
```

Both runs are recorded, and **they are separate rows**: `system_sha` joins
`model`, `config_id` and `tier` in the grouping key, so a run with a prompt is
never averaged with a run without one. That is the whole point — the question
is what the prompt costs or buys on a given serving configuration, and a
comparison that mixed the two would answer it wrong while looking fine.

What is recorded is the prompt's **name and a sha of its exact bytes** (the
first 12 hex digits of the SHA-1, the same length the run banners print). The
sha is the identity: a file edited in place is a different prompt under the same
name, so runs either side of an edit stay separate rows, and `compare` prints a
note when a name shows up with more than one sha. `llama-test answer` names the
prompt in its header, since the stored prompt text is the user message alone.
A result with no system prompt records NULL, which the database's own schema
note (migration 2) defines as "none was sent" rather than "unknown" — every row
recorded before 2026-09-04 is a genuine baseline, because there was no way to
send one.

The system prompt is deliberately **not** part of `config_id`. That fingerprint
covers the serving flags and is computed by `_vramlog_config` before any request
is made; a system prompt is part of the request. So it is a second grouping key
beside it, in `v_pass_rate` and in `llama-test compare`, and every existing
`config_id` still means what it always did.

`prompts/system/assistant.txt` is a copy of the text configured per-model in
Open WebUI (see [Model setup](#model-setup)), kept so a benchmark run can be
made under the prompt the assistant actually serves. Open WebUI remains the
source of truth for that; if it changes there, copy it here in the same change
or the comparison measures a prompt nobody is using. Note this is the same
`prompts/` directory the 2026-08-30 decision deleted, and the rule that deleted
it still holds: nothing in it is a test item, nothing in it is graded, and
ground truth still comes only from the published datasets.

The four files beside it are a rewrite of that prompt for a local model and an
ablation of the rewrite, so a comparison attributes a difference rather than
just showing one. `prompts/system/README.md` has the full reasoning; the shape
is:

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

Request knobs, unchanged from the shell version: `LLAMA_TEST_MAX_TOKENS`
(2048), `LLAMA_TEST_TIMEOUT` (900 s), `LLAMA_TEST_CACHE_PROMPT` (`0`;
prompt-cache reuse makes a prefill figure meaningless, so it is off unless
asked for), `LLAMA_TEST_STREAM` (`1`), and `LLAMA_REASONING` for the effort
level. `temperature` is pinned to 0 and is not overridable — two runs must
differ only by the flags under test. `LLAMA_TEST_RAW` is gone: it used to keep
the response's temp file, and every response is now stored in full in the
`answer` table regardless. `LLAMA_GRADER_PYTHON` overrides the interpreter the
graders execute against, and `LLAMA_PLAIN=1` (or `NO_COLOR`) forces plain
output.

### The benchmarks

| Benchmark | Items | Ground truth | License | Citation |
| --- | --- | --- | --- | --- |
| [HumanEval](https://github.com/openai/human-eval) | 164 | `test` field: a `check(candidate)` function, plus `entry_point` | MIT | Chen et al. 2021, [arXiv:2107.03374](https://arxiv.org/abs/2107.03374) |
| [MBPP (sanitized)](https://github.com/google-research/google-research/tree/master/mbpp) | 427 | `test_imports` + `test_list` (3 asserts) | CC-BY-4.0 | Austin et al. 2021, [arXiv:2108.07732](https://arxiv.org/abs/2108.07732) |
| [DS-1000](https://github.com/xlang-ai/DS-1000) | 1000 (511 Pandas/Numpy) | `code_context`, which defines `test_execution(solution)` | CC-BY-SA-4.0 | Lai et al. 2022, [arXiv:2211.11501](https://arxiv.org/abs/2211.11501) |

`llama-test fetch` downloads them into `tests/data/` (gitignored) and writes a
`MANIFEST.json` pinning the upstream revision and a SHA-256 of the bytes
actually downloaded. **Every result records that revision**: per this project's
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
other two. Adding GSM8K or a MATH subset is a new file in `tests/adapters/`
rather than new code, but until that exists, a pass rate here says nothing about
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
dies mid-read, aborts the suite: nothing is written for the item, `llama-test`
exits 1, and `--resume` picks up from there. Recording those as `fail_error`
instead is what the 2026-09-04 entry in `CLAUDE.md` describes — it filed a
serving failure as a model failure, and because `(suite_run_id, benchmark,
item_id)` is unique, `--resume` then skipped the item permanently. An HTTP error
is deliberately not treated this way: the server answered, and a 400 can be
specific to one item.

> **`llama-test` executes model-generated Python.** It runs in a subprocess, in
> a temporary working directory, under a timeout, and with `-I` (and `-S` for
> HumanEval/MBPP, which need only the standard library). That is **process
> isolation, not a sandbox.** It is what the upstream benchmark runners do and is
> acceptable on a single-user local box; it is not safe against adversarial
> output. Do not point this at a model you do not trust.

### Calibrating the graders — `llama-test selfcheck`

`llama-test selfcheck` grades every benchmark's **own reference solution**
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

So `selfcheck` writes `tests/data/<benchmark>/CALIBRATION.json`, and those items
are **skipped** when a suite runs, with the benchmark's own verdict as the
evidence. The calibration records the dataset hash and the grading environment's
library versions, and reports itself stale when either changes — a calibration
is only valid for the environment that produced it. Re-run `selfcheck` after
upgrading pandas or refetching a dataset.

Note the consequence for comparability: a `full` DS-1000 pass rate from this box
is over 439 items, not 511, so it is not directly comparable to a published
DS-1000 number. The excluded items are in `suite_exclusion`, and their counts
are reported beneath every comparison table.

### Where results are stored

Results go into the same `logs/llama.db` as the serving telemetry, which is the
point: the question this harness exists to answer — did the configuration that
ran faster also answer correctly — is a join, not a comparison between two files.

| table | one row per | holds |
| --- | --- | --- |
| `result` | attempted item | `suite_run_id`, timestamp, model, profile, benchmark, `item_id`, dataset revision, tier, seed, outcome, reason, `reasoning_chars`, `wall_ms`, the `system_name`/`system_sha` of the system prompt sent (NULL when none was), the `adapter_sha` of the adapter it was asked under (NULL when it predates the fingerprint, which here means *unknown*), the request `params` and the full llama.cpp `timings` — plus foreign keys to the `request`, the `run` and the `config` it was measured under |
| `answer` | result | the prompt, the answer that was graded, and the reasoning that was not, as three fields rather than one rendered blob |
| `suite_exclusion` | item | what no run can attempt: outside an adapter's library filter, or marked ungradeable by calibration |

Three constraints do work a comment used to do:

- **`outcome` is a `CHECK`**, so an unknown outcome is unwritable rather than
  merely discouraged, and `v_pass_rate` excludes `skipped` from the denominator
  in SQL rather than depending on every caller remembering to.
- **`request_id` links the throughput measurement to the verdict.** The same call
  used to write two rows to two independent stores with nothing connecting them;
  it is now one transaction and one foreign key.
- **`(suite_run_id, benchmark, item_id)` is unique**, which is what makes an
  interrupted-and-resumed suite idempotent — a re-run cannot double-count an item
  even if the resume check is skipped.

`config_id` is a foreign key to `config`, so a row's serving flags appear beside
its pass rate. A hand-started server records NULL, displayed as `unrecorded`,
rather than a guess — a string sentinel would have to be exempt from the
constraint, and then the constraint would guarantee nothing. It is denormalised
onto `result` deliberately: a result keeps its configuration identity even if its
run row is later pruned.

**Exclusions are recorded once, not per run.** They are a property of the
adapter, the calibration and this box's library versions — not of any serving
configuration — and are keyed by dataset revision so a refetch that changes the
items invalidates them. Recording them per run made a 24-item `smoke` suite write
569 rows, 545 of them exclusions: 23x the tier it described, and a count of a
suite's rows that meant nothing. It now writes 24.

**Every item is one committed transaction under `synchronous=FULL`**, so an
interrupted run leaves a valid partial store. `llama-test --suite full --resume`
continues where it stopped. A `full` run is many hours on this hardware and will
be interrupted.

The serving telemetry is fed by the same transaction: a test run's requests land
in `request` as before, and `llama-test compare --by serving` reports them.
Nothing was displaced.

Reading answers back:

```bash
llama-test answer humaneval/HumanEval/0
```

`--run-id` picks a specific suite run rather than the most recent, and
`--export <dir>` writes a whole run's answers as `<dir>/<run>/<benchmark>_<item>.md`
for reading with an editor. The files are produced on demand from the database
rather than written during a run.

**On a terminal the answer is rendered as markdown** — headings, and the model's
own fenced code with syntax highlighting, which is most of what there is to read.
Redirected or piped it is the raw document, unchanged: `llama-test answer ... >
answer.md` and `--export` write exactly the bytes they wrote before. The decision
goes through the same `llama_console.wanted()` guard every other output path in
this repo uses — not a TTY, or `NO_COLOR`/`LLAMA_PLAIN` set, or Rich not
installed, means raw — because Rich reflows paragraphs and pads code blocks, and
a captured answer must be the answer.

Two shape differences follow from *where* the document is going, and only there:

- The chain of thought is wrapped in `<details>` in a file and printed under a
  plain heading on a terminal. Nothing in a terminal expands a `<details>`, and
  both Rich and Textual drop raw HTML, so a collapsed document rendered to a
  terminal would show the reasoning with no heading at all.
- A response that carries a fence of its own is handed over intact so it gets
  highlighted; one that does not keeps the outer fence, because the graded text
  is code and reflowing it into paragraphs would destroy the indentation that
  makes it code. Highlighting depends on the model emitting a language tag —
  a missing tag loses the colour, not the content.

### Comparing — `llama-test compare`

Groups results by (model, config-id, tier, system prompt, adapter) and ranks by
pass rate, then by generation throughput. Columns: the flag summary (`ngl`,
`parallel`, `spec`, `-ot`) joined from the `config` table with the same helpers
that render the serving comparison, the `system` column (`<name>@<sha>`, or `-`
for a run that sent none), the `adapter` column (the adapter sha, or `?` for a
row recorded before adapters were fingerprinted), dataset revision, `passed/attempted`, pass rate, cold
prefill t/s, generation t/s, draft acceptance, and **passes per minute**.

`passes/min` is the honest combined metric on this hardware: pass rate alone would
rank a configuration that answers correctly at one token a second above a usable
one, and throughput alone is what `--by serving` already reports.

Four things the output refuses to do, each learned from a mistake in this
project's decisions log:

- **Never a bare percentage.** `passed/attempted` is printed beside every rate.
- **Tiers never mix.** A 24-item pass rate and a 164-item one are not comparable,
  and `--baseline` reports `n/a (different tier)` rather than a delta.
- **A pair of configs differing in more than one flag is flagged as such.** This
  project lost a measurement to exactly that (the 2026-08-23 `--parallel` entry).
- **Same tier is not the same test.** `--benchmark humaneval` records tier
  `smoke` while covering a third of it, and two rows are warned about when their
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

`--by config` (the default), `--by benchmark`, `--by failures` (every item that
did not pass, with its reason and the size of its reasoning, newest first), and
`--by serving` (throughput and GPU telemetry per configuration, with no test run
involved). Filters: `--tier`, `--model`, `--baseline <config-id>`. Output:
`--format table|markdown|json`, where markdown is for pasting a measured table
into this README and is never read back.

### Reporting — `llama-report`

```bash
llama-report                        # logs/report/<UTC date>/report.md + PNGs
llama-report --out /tmp/r           # somewhere else
llama-report --stdout               # the document on stdout, so it pipes
llama-report --tier smoke --benchmark mbpp   # narrow the scope
llama-report --no-figures           # text plots instead of PNGs
```

`compare` ranks; it has no way to say whether a difference it shows is real. At
`smoke` the gap between two adjacent rows is routinely one item, and this repo's
own rule — never a bare percentage — exists because that gap reads as 4pp.
`llama-report` is the other half: it audits the design first, refuses the
comparisons the design cannot support, and runs the *paired* test where it can,
which matters because the tiers are seeded so every configuration draws the same
items and a test that ignores the pairing throws away the only thing that makes
8 items informative.

Seven sections, ordered so each gates the next: **provenance** (which database,
which rows, which revisions — the store is gitignored, so a number without this
is not checkable), **design audit**, **reliability floor**, **paired accuracy**,
**power/MDE**, **throughput**, **throttle audit**.

The design audit is the part that earns the command. It is mechanical, and
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
written out in `scripts/llama_report.py`, and were cross-checked against
statsmodels. Every test prints its `n` and its assumption check; a test whose
assumptions fail is printed as refused with the reason, never dropped silently.

**Reads only.** No migration, no `schema_note`, no row written — verified by
checksum and row counts either side of a run. The database is opened
`mode=ro`, deliberately not through `llama_db.connect()`, which migrates and
sweeps stale runs and would therefore write.

scipy is required and the command exits 2 with the install line rather than
degrading. matplotlib is optional: without it every figure becomes a unicode
block plot in a fenced code block, naming the reason, and the document is
otherwise byte-identical.

### Dependencies

Rich, Textual, numpy, pandas and pyyaml, in a repo-local `.venv`. This box's
Python is externally managed (PEP 668), so `pip install` refuses outright and a
venv is required rather than merely tidy — `llama-test` creates it on first use
in an interactive shell (`LLAMA_NO_BOOTSTRAP=1` disables that).

Everything degrades without it: `llama-test list`, `compare`, `check` and
`profiles` print plain markdown tables under bare `python3`. Only DS-1000
grading genuinely needs the venv, since it needs pandas and numpy.
`requirements-extra.txt` carries two things: **scipy**, which `llama-report`
requires outright (it exits 2 with the install line rather than degrading) and
which also widens the DS-1000 slice alongside scikit-learn — the adapter's filter
would need widening to use them for that — and **matplotlib**, which only
`llama-report` uses and which is genuinely optional, since without it the figures
render as unicode plots in fenced blocks and the document is otherwise identical.

**`scripts/llama_db.py`, `llama_record.py`, `llama_stats.py`, `llama_tests.py`
and `llama_results.py` are stdlib-only and must stay that way.** The telemetry
recorder runs with bare `python3` in the background for the life of every
server and cannot depend on a venv that may not exist. SQLite is stdlib
(`import sqlite3`), so the database costs nothing here.

## Migrating to local hardware later

When ready to self-host (llama.cpp as above, or Ollama/vLLM), update the
connection under **Admin Panel → Settings → Connections**: change the base URL
to your local server's OpenAI-compatible endpoint (`http://localhost:8090/v1`
for the `llama-qwen` server above, or `http://localhost:11434/v1` for Ollama),
and update the API key if your local server requires one. No other
changes should be necessary, since Open WebUI talks to any OpenAI-compatible
endpoint.
