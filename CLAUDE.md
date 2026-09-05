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
- **Local, fits in VRAM (evaluation only, added 2026-09-04)**:
  `Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf` from `unsloth/Qwen2.5-Coder-7B-Instruct-GGUF`,
  served under the alias `qwen2.5-coder-7b` by the `qwen25c` profile. Dense
  7.6 B, 4.36 GiB on disk, so unlike every other local model here it is fully
  GPU-resident on the 6 GB card. Coding only, and not a thinking model.
  Nothing about it is measured yet.

## Local inference

Hardware: NVIDIA GeForce RTX 3060 Laptop, 6 GB VRAM, compute capability 8.6.

The 20.81 GiB model cannot fit in 6 GB, so the `qwen36` profile offloads all
layers (`-ngl 99`) but keeps the MoE expert tensors of 34 layers in system RAM
(`--n-cpu-moe 34`), with a q8_0-quantized KV cache and flash attention to fit
64K of context. A third profile, `qwen25c`
(`Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf`, 4.36 GiB), was added on 2026-09-04
as the first local model small enough to sit entirely in VRAM: `-ngl 99` with
no `--n-cpu-moe` and no `-ot`, so no weight is read from system RAM. Its
throughput is unmeasured. Serving and benchmarking helpers live in
`scripts/llama-env.sh` (sourced from `~/.bashrc`), which groups settings into
per-model profiles (`qwen36` MoE, `qwen38` dense, `qwen25c` dense and
GPU-resident) rather than loose env vars;
`llama-serve` starts them and `llama-qwen` remains as an alias. Every profile
serves one server slot (`--parallel 1`, `LLAMA_PARALLEL` to override), passed
unconditionally rather than as part of any other flag group. Every serving
run also records GPU telemetry via `scripts/llama-vram-log.sh` (a wrapper over
`scripts/llama_record.py`) into the gitignored `logs/llama.db`, alongside the
throughput of every `llama-test` request, the server's own `/metrics` counters
sampled on the same interval, the parameters `llama-test` actually put in its
request bodies, and what the server's load log said about the model it loaded
(layer split, slot configuration, fused kernels, ignored tensors, warnings).
Every sample is kept; per-run statistics are derived on read and are
distributional (p50/p95, an active-only utilization average, minimum free
VRAM, and the throttle reasons observed), since the mean over a mostly-idle
server says little. `llama-test compare --by serving` ranks configurations by
throughput and prints the derived `-ngl` analysis; `llama-report` (added
2026-09-05) writes the statistical version of that question as markdown with
figures — auditing the design first and refusing a contrast the design cannot
support, which on the current store means every throughput comparison drawn
across the 2026-09-05 power-cap event; `llama-db` is raw SQL access. README.md
documents each function, the schema, and the measured numbers.

Throughput is only half of what a serving configuration has to be judged on.
`llama-test` runs scored items from three published benchmarks (HumanEval,
MBPP sanitized, DS-1000) against whatever the server is currently serving,
executes the benchmark's own harness against the answer, and appends the
result — outcome, llama.cpp `timings`, dataset revision, sample seed, and
foreign keys to the request, run and configuration it belongs to — into the
same `logs/llama.db`, with the full response text in its `answer` table.
`llama-test compare` ranks (model, config) pairs by pass rate and passes per
minute; `llama-test answer` prints a stored response and `--export` writes a
run's answers out as files. A response is markdown with code in it, so
`llama-test answer` renders it on a terminal and writes it raw when redirected
(the `llama_console.wanted()` guard, so a captured answer stays byte-identical),
and `llama-ui` has an Answers tab that lists a suite run's failures and renders
the selected one into a Textual `Markdown` widget with the thinking toggled off
by default. Tiers: `smoke` (24 items, the A/B for a flag
change), `standard` (300), `full` (1030). The datasets are downloaded, not
vendored, into the gitignored `tests/data/`, pinned by upstream revision and
content hash; `llama-test fetch` gets them and `llama-test selfcheck` verifies
the graders against the datasets' own reference solutions. Coding and data
analysis are covered; math and statistics are not yet.

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

- There is no custom backend or frontend code for the *assistant itself* —
  Open WebUI (run via Docker) is the entire chat application, and nothing in
  this repo sits between it and a model. What this repo holds is
  documentation (`README.md`, `CLAUDE.md`), operational shell scripts
  (`openWebUI-docker` to run the container, `scripts/llama-env.sh` for the
  local llama.cpp server and benchmarks, `scripts/llama-vram-log.sh` for GPU
  telemetry capture), and — since 2026-08-30 — a Python evaluation harness
  for the local-inference track:
  - `scripts/llama_db.py` owns `logs/llama.db`: the schema, the ordered
    `MIGRATIONS` list applied by `connect()`, the stale-run sweep, and every
    insert and query the other modules call. Append a migration; never edit
    an applied one.
  - `scripts/llama_record.py` is the recorder loop `llama-vram-log.sh` execs:
    wait for the port, open the run, sample `nvidia-smi`, scrape `/metrics`,
    parse the server's load output, close the run.
  - `scripts/llama_stats.py` holds the statistics and parsers that must not
    move into SQL (`percentile`, `throttle_reasons`, `parse_server_log`,
    `ngl_fit`, `effective_bandwidth`) plus the markdown table renderer, which
    is now terminal output only and is never read back.
  - `scripts/llama_test.py` is `llama-test`: it runs benchmark items against
    the running server, grades them, and writes the request, the result and
    the answer in one transaction.
  - `scripts/llama_tests.py` (adapters, dataset loading, answer extraction,
    the exec harnesses, grader calibration), `scripts/llama_fetch.py`
    (dataset download and revision pinning), `scripts/llama_compare.py`
    (cross model/config comparison, and the serving comparison),
    `scripts/llama_results.py` (the result vocabulary over `llama_db`),
    `scripts/llama_console.py` (Rich-or-plain output, and the one place Rich is
    allowed to touch stdout, in `write_markdown`), `scripts/llama_ui.py`
    (the Textual dashboard: serve, live, tests, compare, answers).
  - `scripts/llama_report.py` is `llama-report`, added 2026-09-05: the
    statistical report over the store — design audit, paired tests, power,
    throughput with the throttle regime as a blocking factor, and figures. It
    is the only module here that requires scipy (matplotlib is optional and
    degrades to text plots), and it **reads only**: it opens the database
    `mode=ro` rather than through `llama_db.connect()`, which migrates and
    sweeps stale runs and therefore writes. Its markdown is output like every
    other markdown here; nothing reads it back.
  - `tests/adapters/*.toml` and `tests/suites/*.toml` describe how each
    published benchmark is adapted and how the tiers are sampled. They are
    the only hand-written test artifacts, and they contain no answers —
    ground truth comes from the datasets, which are downloaded into the
    gitignored `tests/data/` and pinned by revision plus content hash.
  - `prompts/system/*.txt` are system prompts `llama-test --system <name>`
    can send with an item, added 2026-09-04. They are not test artifacts:
    nothing in there is an item, nothing in there is graded, and nothing in
    there states an expected answer. `prompts/system/assistant.txt` is a
    copy of what Open WebUI serves, kept so the assistant's own prompt can
    be measured; Open WebUI remains the source of truth for it. The four
    beside it (`assistant-local`, `assistant-direct`, `style-only`,
    `minimal`) are candidates under evaluation and are deployed nowhere.
    `prompts/system/README.md` says what each one isolates.

  The line to keep: shell scripts here are operational glue, kept thin, with
  `scripts/llama-env.sh` the single source of truth for serving
  configuration; the Python is a *measurement* harness for local inference,
  not application code, and model/system-prompt configuration for the
  assistant still lives in Open WebUI, never in this repo — the copies under
  `prompts/system/` are measurement inputs, read only by `llama-test`, and
  nothing in this repo serves them to anybody. `llama_db.py`,
  `llama_record.py`, `llama_stats.py`, `llama_tests.py`, `llama_results.py`
  and everything `llama-vram-log.sh` invokes must stay **stdlib-only**,
  because the telemetry recorder runs under bare `python3` for the life of
  every server. `sqlite3` is stdlib, so the database costs nothing here.
- Testing approach, two separate things:
  - Changes to Open WebUI configuration are verified by using it in the
    browser at `http://localhost:3000` (manual — there is no code to run
    automated tests against).
  - Local serving configurations are verified with `llama-test`: three
    published benchmarks (HumanEval, MBPP sanitized, DS-1000), executed and
    scored, tiered `smoke` / `standard` / `full`. See "Local inference"
    below and the Testing section of `README.md`.
- Model/system-prompt configuration lives inside Open WebUI itself (Admin
  Panel → Settings → Connections; Workspace → Models), not in any file in
  this repo. See `README.md` for the current model entries and system prompt
  text. The one file that duplicates that text,
  `prompts/system/assistant.txt`, exists so `llama-test` can measure a local
  configuration under it; it is a copy, it configures nothing, and when the
  prompt changes in Open WebUI it must be copied here in the same change or
  the benchmark measures a prompt nobody is using.

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
  rather than letting both exist. The configuration lines recorded with every
  serving run mirror the flags `llama-serve` passes, so a change to those
  flags must be reflected in `_vramlog_config` too, or old and new runs get
  fingerprinted as the same configuration.
- **The database schema is append-only.** `MIGRATIONS` in
  `scripts/llama_db.py` is an ordered list; add a migration, never edit one
  that has been applied. When a change alters what the `config_id`
  fingerprint covers — which changes every existing id and makes rows either
  side of it incomparable — add a `schema_note` row saying so, in the same
  change, so the database explains its own discontinuities without needing
  this file.
- **Do not document aspirations as facts.** Anything not yet running is stated
  as planned or under evaluation, with what would make it the default.
- **Prune what is no longer true.** When a section describes something that no
  longer exists, delete it and log the deletion; leaving dead configuration in
  place has repeatedly cost time in this project.

## Commit policy

All commits should use conventional commit style and stay focused on one topic.

## Decisions log

- Keep a short, dated log here of model evaluation results and any changes to the
  model/provider choices above, so future sessions have that context without needing
  to re-derive it.
- **2026-09-05**: Added `llama-report` (`scripts/llama_report.py`), a
  statistical report over `logs/llama.db`, and used it to analyse the
  system-prompt ablation the 2026-09-04 (third) entry set up and left unmeasured.
  It was measured on 2026-09-05 02:59-03:33. **The answer is null, and the more
  useful finding is that this experiment could not have found anything.** The
  reason for a second command rather than more columns in `compare` is that
  `compare` ranks and has no way to say whether a difference it shows is real:
  at `smoke` two adjacent rows differ by one item, and the repo's own
  never-a-bare-percentage rule exists because that reads as 4pp.
  **The tests are paired, and not ANOVA.** The tiers are seeded so every
  configuration draws the same items, which makes this a repeated-measures
  design; a one-way test across levels discards the pairing, which is the only
  thing that makes 8 items informative. So: Cochran's Q with an exact
  permutation p, exact McNemar against the no-prompt baseline with Holm, Wilson
  intervals. Over the two complete blocks (mbpp x `9b503170` and ds1000 x
  `107a9a47`, each 8 items x 6 levels, 48/48 cells, no holes) the pooled result
  is **Q = 0.9259 on 5 df, permutation p = 1.000 over all 10800 arrangements**.
  Twelve of the sixteen items are constant across all six prompts, so the whole
  comparison rests on four. Pooling is keyed on the *set* of levels rather than
  the sequence, which was a real bug caught in testing: columns are ordered by
  when each level was first measured, the two blocks ran the same six prompts in
  a different order, and keying on the ordered tuple silently refused to pool
  the two blocks the analysis exists for.
  **What the null is worth is the actionable part.** Discordance -- the share of
  item comparisons changing verdict, and what a paired binary test's power
  actually depends on -- is 15/104 = 14.4%. At the 32 items entering a baseline
  comparison, even a 14.4 pp difference (the largest that *can* exist under that
  discordance rate) would be detected 58% of the time. There is no effect size
  this experiment had an 80% chance of finding. Detecting 5 pp needs 451 items;
  15 and 20 pp are reported as `impossible` rather than as a number, since in a
  paired design the pass-rate difference cannot exceed the discordance rate. **No
  claim is made or should be made about which system prompt is better**, and
  `assistant.txt` stays what Open WebUI serves.
  **A throughput trap was found and is refused rather than reported.** Levels ran
  sequentially, one suite per level. Partway through run 4 generation fell from a
  39.6-50.8 t/s band (40 requests, median 49.4) to 6.06-6.12 t/s at
  2026-09-05T03:05:59Z and never recovered -- not one of the following 72
  requests exceeded 20 t/s. Mean board power was 27.2 W after against 51.2 W
  before, and after the cliff every non-idle GPU sample carries throttle word
  `36` (`SwPowerCap | SwThermalSlowdown`), the rest being `GpuIdle` between
  requests. In the mbpp block the cap is therefore confounded with the level: a
  naive one-way ANOVA of generation t/s by system prompt there returns
  **F = 419.268, p < 0.001** and is measuring the power cap. The report computes
  that test and prints it labelled as the wrong answer beside the refusal,
  because it is what a reader would otherwise have run; four throughput contrasts
  are refused outright, naming the ordering and the power state. Stratifying by
  regime collapses most strata to one level. `predicted_n` and `prompt_n` are
  analysed as the defensible responses, being counts the model produced rather
  than divisions by a wall clock. **Any throughput number from run 4 after
  03:05:59Z is a measurement of a thermally capped GPU**, not of a serving
  configuration, and should not be compared with the figures in `README.md`.
  **A pre-existing belief was corrected by writing the query.** The reliability
  floor was expected to come from 24 cells measured more than once, 6 of which
  flipped. It does not: under the strict cell key (model, config, tier,
  benchmark, item, system prompt, adapter) **no cell in this store was measured
  twice**, so there is no run-to-run estimate at all. The 24 repeat on a looser
  key that ignores the model -- a different model answering the same question is
  a different condition, and counting it would put a between-model effect on the
  noise floor and then use that floor to dismiss between-model effects. The
  report says so in those words. Consequence: **re-running one existing
  condition unchanged is the cheapest and highest-value next run**, ahead of any
  new condition.
  Two design decisions worth recording. scipy is a hard requirement and the
  command exits 2 with the install line rather than degrading, because a
  statistics report with the statistics removed is not a smaller version of
  itself; matplotlib is optional and every figure falls back to a unicode block
  plot in a fenced block, naming the reason, since a missing wheel should cost
  the picture and not the analysis printed beside it. And the store is opened
  `mode=ro`, deliberately **not** through `llama_db.connect()`, which applies
  migrations and sweeps stale runs -- a reporting command must not be able to
  change what it is reporting on. No migration and no `schema_note`: nothing
  here changes what a stored row means.
  Verified: the hand-written statistics (Cochran's Q, its exact permutation p,
  exact McNemar, Wilson, Holm, the power/MDE search) cross-checked against
  statsmodels and scipy on 40 random matrices plus the real ones, with the
  permutation p also checked by brute-force enumeration and the sample-size
  formula checked by simulating the exact test at the n it claims; `--stdout`,
  `--no-figures` and a matplotlib-blocked run each producing a complete
  document; and `logs/llama.db` byte-identical by md5 with integrity, foreign
  keys and all row counts (4 runs, 1 config, 298 results, 298 answers, 297
  requests, 1941 GPU samples, 15488 scrapes) unchanged after every run.
- **2026-09-04** (sixth): Fixed five defects found by a review of the
  `feat/config-comparison` branch before it merged. Two of them mattered.
  **`llama-test compare --by benchmark` could not run at all.** `benchmark_rows`
  built a four-label header and emitted five leading cells -- it added the
  `adapter` cell that the sibling `COLUMNS` list already names and gave it no
  column -- so every row was one cell wider than its header and the command
  raised `IndexError` on every output path: markdown, plain, Rich, and the
  `llama-ui` Compare tab. The header gained the column rather than the row
  losing the cell, because `adapter_sha` is part of the grouping key: two rows
  differing only by adapter are two different measurements, and a table that
  does not name the difference reads as a contradiction.
  **The multi-flag warning was under-reporting.** `FLAG_KEYS` named four flags
  by their llama-server spelling -- `context`, `n-cpu-moe`, `cache-type-k`,
  `cache-type-v` -- and `_vramlog_config` records them as `ctx`, `moe` and one
  combined `cache: k=... v=...` line, so `config_value` returned None and
  `flags_of` dropped them silently. A comparison whose two configurations
  differed in context size, `--n-cpu-moe` or KV cache type reported neither.
  That warning exists because this project lost a measurement to exactly that
  failure (the 2026-08-23 `--parallel` entry), so a check that cannot see three
  of the flags most likely to change between runs is worse than none: it reads
  as an all-clear. Against the current database the warning went from 5 flags
  to 9. The list now carries a comment saying these are recorded keys and not
  CLI spellings, which is the trap that produced the bug.
  Three smaller ones. `llama_stats.render_table` padded short rows and indexed
  past the end of long ones, which is why a caller's column-count mistake
  surfaced as `IndexError` rather than a visibly odd table; it and both other
  renderers (`llama_console.render_markdown_table`, and `Console_.table`'s Rich
  path) now size to the widest row. Deliberately widening rather than
  truncating: dropping a row's extra cells would turn a caller's bug into a
  table that is quietly wrong about which value sits under which heading, and an
  unnamed trailing column is visible where a shifted one is not.
  `config_value` stopped at the first ` | `, so `config.samplers` recorded
  `temp 0.7` for a profile serving `--temp 0.7 --top-p 0.8 --top-k 20
  --repeat-penalty 1.1`; it takes an opt-in `rest=True` for that one line, whose
  value is itself pipe-separated. And `calibrate()` counted an item with no
  reference solution as ungradeable without counting it as checked, so
  `n_checked - n_ungradeable` -- read as the gradeable count by `llama-test
  list` -- could go negative. Neither is a measurement error: the samplers
  column is written and never read, the fingerprint is computed in the shell
  over the complete text, and no published item in HumanEval, MBPP or DS-1000
  ships without a reference, so the calibration counts on disk are unaffected.
  **Migration 5 carries no DDL and one `schema_note`**, for the samplers fix:
  the column holds different things either side of 2026-09-04 under the same
  name, and a column whose meaning shifts mid-table is what that table exists to
  explain. No `config_id` changed and nothing became incomparable. Verified: all
  five reproduced before the fix and pass after; all four `compare` modes run
  against the real database; `logs/llama.db` backed up first, and integrity,
  foreign keys and every row count (3 runs, 186 results, 186 answers, 185
  requests, 1392 GPU samples, 11104 scrapes) identical afterwards, with the
  migration applying once and staying idempotent on reconnect.
- **2026-09-04** (fifth): Deleted the pre-database files from the gitignored
  `logs/`. The 2026-08-30 entry below kept them deliberately -- "the old files
  stay in gitignored `logs/` as a reference that no code reads" -- and five days
  later nothing had read them, which is the evidence that entry was waiting for.
  Gone: `tests.jsonl` (252K), `tests.log`, `answers/` (three suite runs of
  exported markdown), `.active-run.json`, `.requests.37995.jsonl` and the
  markdown serving log `Qwen3.8-27B-UD-Q3_K_XL.log`. Two orphaned
  `.server.<pid>.log` captures went with them: `llama-serve` tees the server's
  `-lv 4` output there and deletes it on exit, so a surviving one is a server
  that was killed, and both pids were long dead. `logs/llama.db` is the only
  thing left in the directory. **What this costs, stated rather than
  discovered later: every measurement taken before 2026-08-30 is now gone.**
  They were never imported and now cannot be. That is acceptable for the reason
  the move happened in the first place -- those formats stored statistics
  computed at write time rather than the samples behind them, so a figure in
  them could never be recomputed, which is exactly the defect that made this
  project mis-estimate the per-layer `-ngl` cost once -- and the numbers worth
  keeping were transcribed into `README.md` with their full configuration, as
  the maintenance policy requires. The reason to delete rather than keep
  indefinitely is that a directory of files no code reads is a trap: a reader
  finds `tests.jsonl` sitting beside `llama.db` and has no way to tell which
  one is authoritative, and the answer has been "the database" since
  2026-08-30. Migration 4 carries **no DDL and one `schema_note`**, because the
  deletion falsified a note already inside the database: `NOTES_1` tells a
  reader those files "remain in logs/ as a historical reference", and an
  applied migration is never edited, so the correction is a new note rather
  than a rewrite. `README.md`'s copy of the same sentence was updated in the
  same change, since it is documentation rather than history. `llama.db` itself
  was not touched: backed up first, and integrity, foreign keys and every row
  count (3 runs, 186 results, 186 answers, 185 requests, 1392 GPU samples,
  11104 scrapes) checked identical afterwards.
- **2026-09-04** (fourth): Investigated a run full of `fail_error`s and found
  two defects, one in the harness and one in an adapter, plus a structural gap
  that let the second one exist. Both are fixed here.
  **First, a dead server was being recorded as a model failure.** `run_item`
  graded any transport error as `fail_error`, so when the server stopped
  mid-suite on 2026-09-05T00:05:49Z, the remaining 56 items were written as
  failures in one second with the reason `no response from port 8090`. That run
  reads 13/100 = 13% and what it actually measured is 13/44 = 30%. It was not
  self-correcting either: `(suite_run_id, benchmark, item_id)` is unique, so
  `--resume` found those items already done and would have skipped them
  forever. A benchmark outcome is a statement about the model's answer and a
  connection refused is not one, so `ask()` now marks that case and `run_item`
  raises `ServerGone` **before anything is written**; the suite catches it,
  reports what was measured, prints the resume line and exits 1. HTTPError is
  deliberately excluded: the server answered, and a 400 can be specific to one
  item, which is a per-item fact worth recording. Verified against a stub server
  rigged to answer three requests and die: 3 rows written, 21 not, exit 1, and
  `--resume` then ran exactly those 21 to a complete 24.
  **Second, `tests/adapters/ds1000.toml` was telling the model the wrong
  answer variable.** Its `prompt_template` ended "Assign the answer to `result`
  as the problem asks", which is false for **194 of the 511 in-filter items**:
  DS-1000 items name their own output variable in the problem text (`b = ... #
  put solution in this variable`), and the reference solutions assign `result`
  in 317, `df` in 103, `a` in 13, `B` in 6, `b` in 5. Items 295 and 297 failed
  `NameError: name 'b' is not defined`; item 295's answer (`np.eye(4)[a]`) was
  executed by hand and is numerically identical to the expected result, so a
  correct answer was graded wrong by this repo's own instruction. The template
  now defers to the problem. Stated because it bounds the claim: among the 44
  items actually attempted, those wanting `result` passed 8/25 and those wanting
  another name 4/13, so at this n the bug shows **no aggregate effect** — it is
  a definite defect that cost at least two confirmed items, not a demonstrated
  driver of the failure rate. Grader calibration could never have caught it:
  `selfcheck` runs the reference solutions, which use the right names, and
  reports 100% while the template misleads every model.
  **Third, and the reason the second one could happen silently: nothing
  fingerprinted the adapter.** `dataset_revision` pins the published items and
  nothing pinned the wrapper this repo puts around them, so editing a
  `prompt_template` made every old result incomparable with every new one with
  nothing recording the discontinuity — the exact failure `config_id` prevents
  for serving flags and `system_sha` for system prompts. Migration 3 adds
  `result.adapter_sha` and puts it in the grouping key of `v_pass_rate` and of
  `llama-test compare`, beside `model`, `config_id`, `tier` and `system_sha`.
  It is a sha1 over the **parsed** `prompt_template`, `[item]`, `[filter]` and
  `[check]`, not over the file's bytes, which is the one place it deliberately
  differs from `system_sha`: an adapter carries the prose explaining why it is
  shaped as it is, and hashing that would file every comment edit as a
  measurement discontinuity. NULL means **unknown**, not none — the opposite of
  `system_sha`'s NULL — because a row predating the migration cannot say what
  adapter it ran under; `compare` shows it as `?` and never pools it with a
  known adapter. Two `schema_note` rows record both facts, including that
  NULL-adapter ds1000 rows were measured under the wrong template.
  **The rows already written were deleted**, since the fix above prevents new
  ones but cannot clean up old ones. 65 of them, not the 56 first counted: 56
  in `20260904T235723Z-d6e7b5`, 8 in `20260905T000635Z-220db1` and 1 in
  `20260904T223432Z-3ae35a`. None had a `request` or an `answer` row -- a
  transport failure produces neither -- so nothing was orphaned, and integrity
  and foreign keys were checked after. What that corrected: the ds1000 standard
  run reads **13/44 = 29.5%** instead of 13/100 = 13.0%, `3ae35a` reads 66/78
  instead of 66/79, and `220db1` disappeared from `compare` entirely rather
  than sitting there as a 0/8 = 0.0% row, because all eight of its rows were
  the same dead server and it never measured anything. Both surviving runs are
  resumable again. This is the one kind of deletion this store permits: the
  rows were not measurements, and keeping them would have meant every future
  reader re-deriving the same correction. A `prune` of samples would not have
  touched them; the append-only rule covers the schema, not rows that record an
  event that never happened.
- **2026-09-04** (third): Wrote four candidate system prompts for the local
  models and put them beside the deployed one, so the question "what does the
  assistant's own prompt cost a local model" has an experiment rather than an
  opinion. `assistant.txt` stays the verbatim Open WebUI text and is the
  baseline. The rewrite is `assistant-local.txt`, and `assistant-direct.txt`,
  `style-only.txt` and `minimal.txt` are an ablation of it, each dropping one
  thing from the one above, so a `compare` table attributes a difference
  instead of only showing one. **None of them is deployed**; Open WebUI still
  serves `assistant.txt`, and if a candidate measures better it is adopted
  there with the copy here updated in the same change, per the convention
  above. The three substantive changes in the rewrite are all things that bite
  a 7B model with a 2048 token cap and do not bite a hosted 27B. First, the
  deployed prompt's "do not hesitate to ask clarifying questions before
  providing a full response" is a **scored failure** on a single-turn
  benchmark item: a model that asks instead of answering emits no code and
  grades as wrong. That is a real property of the prompt and not a harness
  artifact, so the rewrite keeps the intent -- state assumptions, invite
  correction -- and moves the question after the answer rather than in place of
  it. Second, "be informative and delve into topics" can spend the whole token
  budget on prose and truncate the code mid-function, which grades as wrong and
  reads as a quality problem rather than a length one; the rewrite bounds the
  explanation to the question instead. Third, the rewrites name the code fence,
  because `extract_code` takes the last fenced block containing a definition
  and passes an unfenced answer to the grader whole. That third one is a
  **confound and is recorded as one**: all four rewrites name the fence and
  `assistant.txt` does not, so an `assistant` versus `assistant-local` delta
  mixes the rewrite with formatting compliance, while the comparison among the
  four rewrites is clean because that instruction is identical across them. The
  alternative was writing prompts that win the benchmark, which was rejected:
  a prompt tuned to the grader measures the grader, and the thing under
  evaluation is a prompt somebody would actually deploy. `llama-test list`
  gained a third table naming each prompt with its sha and first line, since
  with five of them the sha is the identity a result is grouped by and it
  should be readable without opening files or running a suite. **Nothing is
  measured yet.** The run is `--suite smoke` once with no `--system` and once
  per prompt against a served profile; until that exists, no claim is made
  here about which prompt is better or about what any of them costs.
- **2026-09-04** (second): `llama-test` can send a system prompt, and a system
  prompt is now part of what identifies a measurement. `--system <name>` puts
  the contents of `prompts/system/<name>.txt` in front of the item as a
  `system` message; without the flag nothing is sent, which is the same request
  body every run before today made. Opt-in is the whole design: the alternative
  considered was a default prompt, and it would have silently made every
  recorded result incomparable with every new one, which is the exact failure
  the 2026-08-23 `--parallel` entry describes. There is no server-side option
  to do this instead — checked `llama-server --help` on this build rather than
  assumed — so it lives in the request body, which is also where Open WebUI
  puts its own. The design question that mattered was where the identity goes.
  It is deliberately **not** in `config_id`: that fingerprint is computed by
  `_vramlog_config` over the serving flags before any request exists, folding a
  request property into it would change every existing id, and a server serves
  many prompts. Instead migration 2 adds `system_name` and `system_sha` to
  `result` and puts `system_sha` in the grouping key of `v_pass_rate` and of
  `llama-test compare`, beside `model`, `config_id` and `tier`. Grouping is the
  point rather than a nicety: without it a run with a prompt and a run without
  one would be averaged into a single pass rate, and the measurement would look
  fine while answering the wrong question. The identity is the **sha of the
  file's bytes**, with the name carried alongside for reading. A prompt edited
  in place is a different prompt, so runs either side of an edit stay separate,
  and `compare` prints a caveat naming any prompt whose name appears under more
  than one sha — the case that would otherwise look like an unexplained
  regression. NULL means *no system prompt was sent*, not *unknown*: migration
  2 carries a `schema_note` saying so, because nothing else in the database
  distinguishes "recorded before the feature existed" from "deliberately none",
  and both are in fact the same thing here. This brings `prompts/` back, five
  days after the 2026-08-30 entry deleted it, and the rule that deleted it is
  unchanged: the five files removed then were *unscored test items*, and
  nothing under `prompts/system/` is a test item, is graded, or states an
  expected answer. `prompts/system/assistant.txt` is the Open WebUI prompt
  copied verbatim so the assistant's actual configuration can be benchmarked;
  Open WebUI stays the source of truth and the copy has to be updated with it.
  `llama-ui`'s Tests screen gained a matching selector defaulting to none.
  One bug was found and fixed on the way, worth recording because it failed
  quietly in the worst possible way: `llama_test.py` carried an unused
  `nargs=argparse.REMAINDER` positional, so `llama-test humaneval/HumanEval/0
  --system assistant` swallowed the flag, sent no system message, and recorded
  the run as having had none — a wrong measurement with no error anywhere. The
  catch-all is deleted; unknown flags now fail loudly, and `--system` works in
  either position. Verified end to end against a stub OpenAI-compatible server
  that echoes the request body, so the message actually sent could be read
  rather than inferred; its rows were then deleted from `logs/llama.db` and the
  database integrity-checked. No GPU measurement has been made with a system
  prompt yet — the A/B (`--suite smoke` with and without `--system assistant`)
  is the user's to run, and until it is, nothing here claims what a system
  prompt costs.
- **2026-09-04** (first): Added a third serving profile, `qwen25c`
  (`unsloth/Qwen2.5-Coder-7B-Instruct-GGUF`, `Q4_K_M`, 4.36 GiB, alias
  `qwen2.5-coder-7b`). The reason it is worth a profile rather than a one-off
  `llama-server` invocation is that it is the first local model here that fits
  in 6 GB of VRAM outright: `-ngl 99` with no `--n-cpu-moe` and no `-ot`, so
  nothing is read from system RAM. Every throughput number recorded in this
  project so far is bound by exactly that -- `qwen36` at ~7-8 t/s and `qwen38`
  at ~3 t/s are reading CPU-resident weights over system RAM at every token --
  so a fully resident model is the one configuration whose speed the existing
  measurements say nothing about. **Nothing about it is measured yet**, and no
  figure for it is quoted in `README.md`; `llama-test --suite smoke` against a
  served instance is what would produce one, and it will be directly comparable
  to the existing runs because it lands in `logs/llama.db` under its own
  `config_id` (`71bc58dd` as of this change) with the same benchmark items.
  What it costs, stated because it is a real trade and not a free win: the
  model is a 7.6 B coder against a 27 B and a 35 B, it covers coding only, and
  quality is the thing `llama-test` exists to measure rather than assume.
  Three configuration decisions worth recording. Its context is **16384, not
  the model's full 32768**: this GGUF is 28 layers with 4 KV heads of 128, so a
  `q8_0` KV cache costs ~29.7 KiB/token, which is ~476 MiB at 16K against ~952
  MiB at 32K on top of 4.36 GiB of weights and the compute buffer -- the full
  window fits inside 6 GiB only with less margin than this project's own
  `LLAMA_VRAM_HEADROOM_MIB` (300) warns at, so it is opt-in via `LLAMA_CTX` and
  to be confirmed with `llama-vram`, not assumed. It sets **no speculative
  flags** (Qwen2.5 predates the `nextn`/MTP tensors `qwen38` drafts from) and
  **no reasoning effort** (not a thinking model: no `reasoning_content`, so the
  token budget is all answer, which matters more than it sounds given that
  reasoning tokens dominate `qwen36`'s wall clock on short prompts). Its
  samplers are Qwen2.5-Coder's own `generation_config.json` values
  (`--temp 0.7 --top-p 0.8 --top-k 20 --repeat-penalty 1.1`), read from the
  repo rather than guessed. Three smaller fixes came with it, each of which was
  a latent copy of the profile list waiting to disagree with `llama-env.sh`.
  Profile names now live in one `LLAMA_PROFILE_NAMES` array exposed as
  `llama-env.sh profile-names`; `llama_console.py` and `llama_ui.py` read it
  instead of the hardcoded `("qwen38", "qwen36")` each carried, so a fourth
  profile will appear in `llama-profiles` and the dashboard picker without
  touching either. `llama-profile-json` now reports `reasoning` as empty for a
  profile that sets no thinking effort -- it was reporting `medium`
  unconditionally, which would have had the dashboard emit `LLAMA_REASONING`
  for a server that ignores it -- matching the test `_vramlog_config` already
  made before recording `n/a`. And `llama-serve`'s "confirm VRAM headroom
  before treating `-ngl` as tuned" warning is now scoped to a dense profile
  that is *partially* offloaded, since at `-ngl 99` there is no layer count
  being chosen. Nothing in the fingerprint changed, so every existing
  `config_id` still names the same configuration.
- **2026-08-30** (last): Stored answers are rendered as markdown when a human
  is reading them, and left alone when a machine is. Two paths: `llama-test
  answer` prints through a new `llama_console.write_markdown`, and `llama-ui`
  gained an **Answers** tab that lists a suite run's items and renders the
  selected one into a Textual `Markdown` widget. The reason is that a response
  is markdown with fenced code in it, and the code is the part that reads worst
  as flat text -- which is what a grading harness was leaving people to read.
  The constraint this had to respect is the one `llama_console` exists for: a
  piped `llama-test answer ... > answer.md` must contain the document and
  nothing else, and Rich reflows paragraphs and pads code blocks, so rendering
  to a redirected stream would corrupt exactly the artifact someone redirected
  in order to keep. So `write_markdown` is gated on the existing
  `wanted()` -- not a TTY, or `NO_COLOR`/`LLAMA_PLAIN`, or no Rich, means raw --
  and it is the only place in this repo Rich writes to stdout at all; `Console_`
  still writes to stderr on purpose. Verified byte-identical output on the
  redirected path and on `--export`, which is the whole point of the guard.
  Two shape decisions follow from the destination and are worth recording
  because they look like inconsistency otherwise. The chain of thought keeps its
  `<details>` wrapper in a file and loses it on a terminal: nothing in a
  terminal expands one, and *both* Rich's and Textual's markdown drop raw HTML
  blocks, so a collapsed document rendered to a terminal would show the
  reasoning under no heading at all. And a response is handed over unfenced only
  when it carries a fence of its own; without one it keeps the outer fence,
  because the graded text is code and reflowing it into paragraphs would destroy
  the indentation that makes it code -- unhighlighted and correct beats
  highlighted and wrong. That check is deliberately *not* the extractor in
  `llama_tests.py`: that one decides what gets graded and must stay strict,
  while this one only decides how to print, where a wrong guess costs colour.
  Known limitation, stated rather than discovered later: highlighting depends on
  the model emitting a language tag on its fence, so a missing or wrong info
  string silently loses the colour. Fine for Python today; if a multi-language
  benchmark is ever added it will be more visible. The UI tab defaults to
  failures, which is the pairing for `compare --by failures` -- that view names
  the items worth looking at and this one shows them -- and keeps the thinking
  off behind a toggle, because reasoning traces run to tens of thousands of
  characters on this model and parsing one into a widget on every row change
  would make the table feel broken. It also shows the `llama-test answer`
  invocation for the highlighted row, per the rule the dashboard already
  follows: the form teaches the flags rather than hiding them. One helper was
  added to `llama_db` for it, `suite_runs()`, so a run can be picked without
  knowing its coined id.
- **2026-08-30** (later): All measurement data moved from nine hand-rolled
  file formats in `logs/` to one SQLite database, `logs/llama.db`. The reason
  is that markdown was not just written but *parsed back*: `llama_log.py`
  read values out of rendered table cells on every merge, which is where the
  "all four tables were extended by appending columns only, so historical rows
  keep their meaning positionally" rule and the `LEGACY_REQUEST_SUMMARY`
  positional remap came from, and why every block was re-rendered whole on
  every write. Those rules are retired: markdown is now **output only**
  (`--format markdown`, so a measured table can be pasted into `README.md` as
  the maintenance policy requires) and no code reads it. `logs/tests.log`,
  `logs/tests.jsonl`, `logs/answers/` and `logs/<model>-<quant>.log` stop
  being written. `scripts/llama_log.py` is deleted; the statistics and parsers
  worth keeping moved to `scripts/llama_stats.py`, the storage to
  `scripts/llama_db.py`, and the recorder loop out of shell into
  `scripts/llama_record.py` (which takes `jq` off the recorder path;
  `llama-vram-log.sh` is now a wrapper that resolves the profile, computes
  the fingerprint, and execs it). Six things this bought, each of which was a
  real defect and not a tidiness argument. **First, the 2026-08-23 retention
  rule is reversed**: every GPU sample and every `/metrics` scrape is now
  kept, and summaries are derived on read. The old rule discarded raw samples
  once a newer run finished and kept only the summary computed at the time,
  which meant a statistic computed wrongly could never be recomputed — and
  this project has already had to correct a statistic once (the per-layer
  `-ngl` cost). At ~60 bytes a row and 5 s intervals a day of continuous
  serving is ~1 MB; `llama-db prune --before <date>` exists for the day that
  matters and touches only samples and scrapes, never results or answers.
  **Second, `config_id` is a foreign key** instead of a string resolved by
  globbing `logs/*.log` and parsing every markdown block in every file to
  rebuild a lookup dict. A hand-started server records NULL rather than the
  string `"unrecorded"`: a string sentinel would have to be exempt from the
  constraint, and then the constraint would guarantee nothing. The name
  survives at the display layer. **Third, the `server totals` scrape-timing
  defect is fixed by storing the whole series.** Only the first and last
  scrape were kept, so a delta taken as the server stopped held the prompt
  half of a request and not the generation half (llama.cpp updates prompt
  counters at prompt time and generation counters at task completion); with
  every scrape stored the delta can end after the final completion, and the
  intermediate values are a throughput curve rather than a lost measurement.
  **Fourth, a request's throughput and its verdict are one transaction and one
  foreign key** instead of two rows in two independent stores with nothing
  connecting them. **Fifth, the exclusion blow-up is fixed**: a 24-item
  `smoke` suite was writing 569 rows, 545 of them `skipped` — 489 DS-1000
  items outside the adapter's library filter and 72 marked ungradeable by
  calibration, re-recorded every run. Pass rates were never affected, but the
  store was 23x the tier it described. Exclusions are a property of the
  adapter, the calibration and this box's library versions, so they now live
  in `suite_exclusion`, written once against a dataset revision; the same
  suite writes 24 rows. **Sixth, `logs/.active-run.json` is gone**: a run with
  `ended_at IS NULL` is the active run, and one whose recorded pid is dead is
  closed by a sweep on connect. The file was removed by an EXIT trap that a
  `kill -9` skips, so a crash left a stale marker that later results were
  filed under. Two more constraints replaced comments: `outcome` is a `CHECK`
  so an unknown outcome is unwritable, and `(suite_run_id, benchmark,
  item_id)` is unique so a resumed suite cannot double-count. Percentiles and
  throttle-bit decoding deliberately stayed in Python — reimplementing linear
  interpolation between closest ranks in SQL would silently change every
  recorded number. **No historical data was imported**, by decision, so
  `llama-test compare` says nothing until a new serving run and a new test run
  happen; the old files stay in gitignored `logs/` as a reference that no code
  reads. **The fingerprint itself is unchanged** — still `_vramlog_config` in
  `scripts/llama-vram-log.sh`, over the same six lines — so a `config_id`
  quoted in an old log still names the same serving configuration. Two
  `schema_note` rows record both of those facts inside the database. The one
  capability that had to be rebuilt rather than carried over is the serving
  comparison the log files opened with: it is now `llama-test compare --by
  serving`, one row per configuration from its most recent run, with the
  `derived` table (cpu-resident layers, ms/token, effective CPU bandwidth,
  headroom in layers) and the least-squares `-ngl` fit beneath it, plus a live
  view in `llama-ui` that is only possible because samples land as they are
  taken. Verified before shipping: schema integrity and migration idempotency;
  a stdlib-only import audit plus an end-to-end recorder run under bare
  `python3` with `.venv` moved aside; a `kill -9` mid-run leaving its samples
  intact and the run closed as stale on the next connect; one item writing
  exactly one request, one result and one answer, mutually linked, with the
  stdout/stderr contract unchanged; a resumed suite finding its work already
  done; 300 results written while sampling every 0.5 s with no `database is
  locked`; and statistic parity — a speculative run's acceptance and mean_len
  came out of `v_request` as 0.932 and 2.864, exactly the figures recorded on
  2026-08-23. The A/B against the real server is the user's to run.
- **2026-08-30**: Local serving configurations are now judged on *correctness*
  as well as speed, which reverses the 2026-08-23 position that "adding scoring
  would mean application code, which this repo deliberately does not hold". The
  reversal is deliberate and the reason is that the tuning loop had become
  unfalsifiable: `-ngl`, `-ot`, `--parallel` and MTP speculative decoding were
  being chosen on tokens/second alone, with the answers eyeballed once and
  thrown away, so a configuration that ran faster and answered worse was
  indistinguishable from one that ran faster and answered the same. The five
  unscored files in `prompts/` are deleted; their exact wrapper survives as the
  HumanEval adapter's `prompt_template`. Test items come only from published
  benchmarks that ship their own ground truth — nothing in this repo authors a
  test or its answer — because a hand-written suite would measure the author's
  guesses about the model, and its numbers would compare to nothing outside
  this machine. The three: **HumanEval** (164, MIT, Chen et al. 2021),
  **MBPP sanitized** (427, CC-BY-4.0, Austin et al. 2021), **DS-1000** (1000,
  CC-BY-SA-4.0, Lai et al. 2022, filtered to the 511 Pandas/Numpy items so the
  grading environment needs only those two libraries). Grading executes the
  benchmark's own harness; `reasoning_content` is never graded. Tiers are
  `smoke` (24, the config A/B), `standard` (300), `full` (1030), each seeded so
  the same items are drawn for every configuration, and the comparison refuses
  to put rows from different tiers side by side. The metric is pass rate *and*
  passes per minute, always printed with `passed/attempted` beside it: at
  n=24 one item is 4pp, so a bare percentage would invite conclusions the
  sample cannot support. Contamination is expected and is not a defect here —
  HumanEval and MBPP will sit near ceiling for a 2026 model, but a
  ceiling-hugging benchmark still detects a serving configuration that breaks
  output, which is the actual question; DS-1000 is perturbed against
  memorization and carries the discriminating power. **Known coverage gap,
  stated rather than papered over**: this measures coding and data analysis.
  Math and statistics, two of the four primary use cases named above, are not
  measured at all; adding GSM8K or MATH is a new adapter TOML, not new code.
  Two findings worth keeping. First, **grader calibration**: 72 of DS-1000's
  own reference solutions fail in this environment, and none of it is the
  grader's fault — they are written against pandas 1.x and this box has 3.0.5,
  so `DataFrame.append`, `replace(method=)` and `delim_whitespace` are simply
  gone. Scoring those as model failures would have understated every model by
  ~14pp on that benchmark forever. Instead each benchmark's reference
  solutions are run with no model involved and the failures are recorded as
  *ungradeable* in `tests/data/<bench>/CALIBRATION.json`, then dropped from the
  pool *before* sampling so a tier stays exactly the size it advertises. The
  calibration self-invalidates when the dataset hash or the library versions
  change. On pandas 3.0.5 / numpy 2.5.2 / python 3.14.7: HumanEval 164/164 and
  MBPP 427/427 reference solutions pass, DS-1000 439 of 511 are gradeable.
  Second, the prompt-source change did **not** invalidate the prefill figures
  already in `README.md`: checked against the server's `/tokenize` rather than
  assumed, the five old files and their templated replacements tokenize to the
  same length and differ in exactly one token id each. Operationally,
  `llama-test` is now the single entry point (`list`, `fetch`, `selfcheck`,
  a single item, `--suite`, `compare`, `report`, `ui`), results append to
  `logs/tests.jsonl` with a fsync per item so an interrupted run is still
  valid, joined to the serving run by the `config_id` in
  `logs/.active-run.json`, and the existing `llama_log.py request` path is
  still written so the four tables in the serving log keep filling. Rich
  output and a Textual dashboard (`llama-ui`) were added over the shell
  surface, which introduces this repo's first dependencies: `requirements.txt`
  and an auto-bootstrapped `<repo>/.venv` (this Python is PEP 668
  externally-managed, so a venv is required, not merely tidy). Every entry
  point degrades to plain stdlib output when the venv is absent, and the
  telemetry recorder was deliberately not routed through it. Stated plainly
  because it is a real risk and not a theoretical one: grading runs
  model-generated Python in a subprocess, in a temp cwd, under a timeout, with
  `-I`. That is process isolation, not a sandbox — it is what the upstream
  benchmark runners do and is fine on a single-user local box, and it is not
  safe against adversarial output.
- **2026-08-24**: First multi-prompt measurement of `qwen38` with MTP
  speculative decoding: `humaneval1`-`humaneval4` in one server session (build
  95b8e33e1/10597, `-ngl 20` with the `-ot` pin, `--spec-draft-n-max 2`,
  `--parallel 1`, effort medium, temperature 0, four cold prefills). All four
  answers were correct. Generation held a 2.87-3.00 t/s band and draft
  acceptance ran 87.4% to 96.2% (91.9% over the run), so the earlier
  single-prompt figure of 2.89 t/s at 88.8% was representative rather than
  lucky. The finding worth keeping is about prefill, not generation: cold
  prefill ranged 41.26 to 55.24 t/s across prompts of 105-139 tokens under
  identical flags, a 34% spread, which means a single-prompt prefill comparison
  cannot resolve anything smaller than that -- and prefill is the instrument the
  `-ngl` spill cliff is read with. Full numbers with their flags are in
  README.md. Also learned, and now documented as a known limitation: the
  `server totals` row is scraped on the sampling interval, and llama.cpp updates
  its prompt counters when a prompt is processed but its generation counters
  when the task completes, so stopping the server immediately after a request
  leaves that row holding the prompt half and not the generation half. It is
  short by exactly one request's output here while its prompt tokens match the
  `llama-test` table exactly. Nothing is wrong with either table; they are
  sampled at different moments, and the per-request rows are the complete ones.
- **2026-08-23** (last): Each log file now opens with a `## comparison`
  section: one row per `config-id` (ngl, parallel, spec, -ot, fused_gdn, cold
  prefill t/s, generation t/s, acceptance, peak VRAM, headroom, run count),
  sorted by generation throughput descending, plus a `### derived` table of
  cpu-resident layers, ms/token and effective CPU bandwidth. The blocks
  themselves already held everything needed to choose an `-ngl`, but choosing
  meant scrolling between blocks and dividing by hand, which is how the
  per-layer cost came to be mis-estimated once already. The whole section is
  derived: it is stripped and rebuilt on every merge rather than parsed back, so
  it can never drift from the blocks below it, and nothing in it is
  fingerprinted. Each row is a configuration's most recent run rather than an
  average over its history, since an older run may predate a rebuild or a busy
  machine. Figures fall back to `/metrics` when a configuration has no
  `llama-test` rows, marked `*`, because a number covering every client and
  arbitrary prompts is worth having but is not the same measurement.
  Configurations with no throughput at all sort last, not as zero. Effective CPU
  bandwidth is computed only for dense models -- for an MoE the denominator is
  the routed experts, not the resident weights, and dividing by all of them
  would understate it severalfold, so it prints `n/a (moe)`. When two or more
  configurations differ only in `-ngl`, ms/token is fit against cpu-resident
  layers by least squares and reported as slope plus intercept. The intercept is
  the point: `ms_per_token / cpu_resident_layers` charges the fixed cost (the
  GPU-resident layers, sampling, the draft head) to the resident layers and
  overstates the per-layer price, which was an error in an earlier analysis of
  this data and is why the fit is reported rather than the ratio.
- **2026-08-23** (latest): Run summaries gained distribution, not just means.
  The GPU table now carries p50/p95 for utilization and power, p50/p95/max for
  SM clock, a `util active avg` over the samples with non-zero utilization, the
  run's minimum free VRAM as `vram headroom (MiB)`, and the distinct set of
  `clocks_throttle_reasons.active` bits seen over the run. Percentiles were
  added because the mean was misleading in a specific way: sampling covers the
  whole life of the server, so a run that spent 32 s of 92 s serving logged
  `util avg/max = 1/9` and looked idle. The active-only average is the number to
  compare between configurations; the raw average still measures how much of a
  session was spent waiting for a prompt. Throttle reasons are recorded per run
  rather than per sample -- per sample they would be a column of identical hex,
  and what matters is whether a limit was ever hit while a measurement was
  taken. `GpuIdle` is expected here and is not a fault; the thermal and power
  bits are what invalidate a comparison. Bits without a documented name are
  printed as hex rather than guessed at. Headroom is warned about inline (a
  `> warning:` line naming the run, under `LLAMA_VRAM_HEADROOM_MIB`, default
  300) because the whole point of the `-ngl` sweep on this card is finding the
  layer count just below the spill cliff, and a run that fit with 40 MiB to
  spare is a result that will not reproduce after a context-size change. The
  `load log:` group converts headroom into layers using the model's own
  GPU-resident bytes divided by the layers that got there, which is an average
  over unequal layers (the output head and `blk.64` are pinned by `-ot` and are
  not block-sized), so it is a hypothesis to test with a run, not a number to
  plan around. Speculative decoding gained `acceptance` and `mean_len` in both
  request tables; they are blank rather than zero when nothing was drafted, so
  a non-speculative configuration is visibly not a 0% one. `mean_len` in the
  `llama-test` tables is derived -- build 10597 keeps `n_draft_verif_steps` in
  the slot's stats and exposes it only through `/metrics`
  (`tools/server/server-task.cpp:1560`), never in a response's `timings`
  (`tools/server/server-common.cpp:81`) -- so steps are inferred as
  `draft_n / --spec-draft-n-max`, which is exact only while every step drafts
  the full depth. `draft-mtp` at `p_min = 0` does, and the server log states
  `n_max=2, n_min=0, p_min=0.00` at load; the `server totals` row beside it now
  scrapes `spec_decode_num_drafts_total` and carries the server's exact figure,
  which is the one to believe if they ever disagree. On the first run recorded
  with both (`qwen38`, 2026-08-24T02:25:34Z, build 95b8e33e1/10597, `-ngl 20`
  with the `-ot` pin, `--spec-draft-n-max 2`) they agreed exactly: 44 drafted,
  41 accepted, 22 verification steps counted by the server against 22 inferred,
  both tables reading acceptance 0.932 and mean_len 2.864. All four tables were
  extended by appending columns only, so historical rows keep their meaning
  positionally and are padded on re-render rather than migrated.
- **2026-08-23** (later still): A log block's header is now three groups, and
  two of them are not fingerprinted. `server flags:` is the old config lines
  unchanged -- same text, so every existing `config-id` is preserved -- and is
  still what the hash covers. `request params (llama-test):` records what was
  actually in the request body, read back out of the body rather than
  re-derived; it exists because the `samplers:` line records the *server's*
  defaults while a `llama-test` request overrides them with `temperature: 0`, so
  a reader was being shown sampler values that were not in effect for the
  measurement. `load log:` records what the server said about the model it
  loaded: the reported layer split (not the `-ngl` that was asked for),
  `n_slots`/`n_ctx_slot`/`kv_unified`, per-device model buffer sizes, whether
  the fused Gated Delta Net kernels resolved to enabled or disabled, whether
  the MTP head was used or ignored, `DEPRECATED` lines verbatim, and a count of
  ignored tensors with their name prefixes. `fused_gdn` is the reason this
  group is worth the trouble: llama.cpp resolves those kernels per context at
  load time by checking that the fused node landed on the same device as its
  layer (`src/llama-context.cpp:504`), so two runs with an identical
  fingerprint can execute different operations at different speeds. None of it
  is fingerprinted: it is observed per run, not configured, and hashing it
  would make a run that served no `llama-test` request a different
  configuration from one that did. Each group is replaced by a run that has
  something to say about it and left alone by one that does not, so a
  hand-started server does not overwrite an earlier run's observations with
  "unavailable". To get the facts at all, `llama-serve` now passes `-lv 4`
  (`LLAMA_LOG_VERBOSITY`) -- `print_info`, `load_tensors` and
  `resolve_fused_ops` print nothing at the default verbosity -- and tees the
  server's output to a temporary `logs/.server.<pid>.log` that the recorder
  parses and `llama-serve` deletes on exit. `-lv` and `--metrics` are both
  excluded from the fingerprint: they change what the server says about itself,
  not what it computes. KV cache types and batch sizes became profile variables
  (`LLAMA_P_CACHE_K/V`, `LLAMA_P_BATCH/UBATCH`) in the same change, so the
  flags passed and the flags recorded come from one place; their defaults are
  the previous literals, so the config lines and their hashes are unchanged.
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
