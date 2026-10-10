# Recorded telemetry and throughput

`ServeProcess.start()` (`serving/launcher.py`) spawns the telemetry recorder
itself as soon as `llama-server` starts, so every serving run started from
the Serve page leaves a record of what the GPU actually did and how fast the
model answered. There is no shell wrapper resolving the profile or computing
the fingerprint any more (that was `scripts/shell/vram-log.sh`, deleted in
Phase 2c) — `telemetry_argv()` builds the recorder's argv directly from the
already-resolved `ResolvedConfig` and the fingerprint `serving/fingerprint.py`
already computed for this run, so the two cannot disagree the way a second
shell computation could have. The recorder waits for the port to open,
samples `nvidia-smi` every 5 seconds by default, scrapes `/metrics` on the
same pass, parses the server's own load output, and writes each of those as
it happens into the Open WebUI fork's own Postgres database
(`infra/docker-compose.yml`), the same one the chat interface itself uses.
It is `open_webui.benchmarks.telemetry_recorder`, run under the fork's own
backend venv (`sys.executable`, inheriting the backend process's own
`DATABASE_URL` rather than re-deriving one — see the launcher's own
docstring for why a second encoding site was rejected) and it writes with
`psycopg` directly (no SQLAlchemy, no event loop) — but it is still a
separate process from `llama-server`, for the same reason as always: a
recording has to survive a crash of whatever started it, which folding it
into the backend's own event loop would give up. `ServeProcess.stop()` stops
the server first, then the recorder, then removes the server-log tempfile
that bridges them — in that order, so the recorder always gets to finish
reading it.

**One database, for everything this repo measures.** Serving configurations, runs,
GPU samples, `/metrics` scrapes, per-request timings, test results, and the full
answers are tables in it, each named with a `benchmark_` prefix so they sit
beside Open WebUI's own tables without colliding. Model and quantization are
columns rather than halves of a filename, so a cross-model question is a query
rather than a comparison between files that never sit beside each other.

Nothing is written as markdown any more and nothing is parsed back out of one.
Markdown is an *output* format — the maintenance policy still requires a
measured table to be pasted into these guides, but the Compare page renders
only an HTML table now; there is no built-in markdown export, so that table's
values are copied out by hand. No code reads a markdown table back in
either way.

## The tables

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

## What identifies a configuration

The `config_id` is a `sha1[:8]` over the serving flags, computed by
`serving/fingerprint.py`'s `config_id()` — a Python port of the shell's
`_vramlog_config` (Phase 2a of the migration, 2026-09-14), golden-tested
against 24 fingerprints captured from the shell before the port and matching
all of them exactly, over the same six lines. Config ids are therefore
unchanged: an id quoted in an older log names the same configuration it
always did.

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

## Reading it back

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

## Reading the numbers

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

## Crash durability, and the active run

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
Postgres, reached via `DATABASE_URL` (loaded from `infra/.env` by
`make backend`; the telemetry recorder inherits it directly as a child
process rather than re-deriving it, see the top of this page). There
is no `LLAMA_VRAM_LOG=0`-style opt-out and no way to attach a recorder to a
server started some other way any more — those were `scripts/shell/
vram-log.sh`'s job, and serving itself now only happens through the Serve
page's `ServeProcess`, which always attempts telemetry and degrades to a
`telemetry_warning` rather than refusing to serve if `DATABASE_URL` is
missing (see the 2026-09-17 fix in [docs/decisions.md](../decisions.md)).

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
