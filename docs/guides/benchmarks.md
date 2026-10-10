# Benchmarks: testing serving configurations

The admin-only Benchmarks section (`/benchmarks`) serves, tests, compares,
reports on and tunes local llama.cpp configurations. This guide covers how
it is built, what each page does, and how results are graded and compared.
Serving itself is in [llama-cpp.md](llama-cpp.md) and the recorded GPU and
throughput data in [telemetry.md](telemetry.md).

## Architecture

Benchmarks is not a second app. It is a set of pages inside the same Open
WebUI fork as chat, started by the same `make backend` described in [Running
it](../../README.md#running-it)
(port `4000`; `make frontend` adds a dev server on `5174`),
and reached through its own entry in the sidebar (`apps/web/src/components/
layout/Sidebar.tsx`) — admin-only, like Playground, rather than a tab inside
the Settings modal like Analytics, since seven interactive pages do not fit
a settings panel. A `benchmarks.enable` config flag (`ENABLE_BENCHMARKS`,
the **Benchmarks** switch in Admin Settings > General, surfaced to the
frontend as `enable_benchmarks`) gates whether the entry shows at all.

Those are the whole port table — there is nothing new to add one for:

| what | port | started by |
| --- | --- | --- |
| Chat + Benchmarks UI and API (uvicorn, serving `apps/web/dist`) | `4000` | `make backend` |
| UI dev server with hot reload (optional) | `5174` | `make frontend` |

`make backend` still owns Postgres's lifecycle (`infra/docker-compose.yml`),
starting it before uvicorn and tearing it down via a trap when uvicorn stops,
Ctrl-C included. See [Running it](../../README.md#running-it) for the full command sequence.

The GPU telemetry recorder runs under the backend's venv and writes with
`psycopg` directly. It runs as a
**separate subprocess**, not a task inside the fork's backend's own event
loop, and that part is unchanged on purpose: the whole reason it was ever a
subprocess was so a recording survives a crash or restart of whatever started
it, and folding it into the backend's event loop would trade that guarantee
away for no benefit.

## The pages

Benchmark running, grading, comparison, reporting and tuning are not shell
functions any more. `lllm-test`, `lllm-compare` (`lllm-test compare`),
`lllm-report`, `lllm-tune` and the standalone `lllm-web` dashboard were
retired outright on 2026-09-08, and the whole suite now lives inside the
Open WebUI fork itself, as an admin-only **Benchmarks** section at
`/benchmarks`, served by the same `make backend` as the rest
of the fork rather than a separate process or port. See the sections
below for the harnesses themselves. Seven pages,
none of them a thin passthrough to a CLI that no longer exists:

- **Serve** (`/benchmarks/serve`) starts and stops `llama-server` from a
  profile with the same overrides the shell layer took, now typed request
  fields instead of environment variables, and streams its output live.
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
  it drives `serving/launcher.py`'s `ServeProcess` directly for each
  candidate (Phase 2b, 2026-09-17) and fingerprints one in-process with
  `serving/fingerprint.py`'s `config_id()` before serving it, rather than
  shelling out to `lllm-serve`/`lllm-config-id`.

The adapter/suite TOMLs and system-prompt text files moved with the code,
into `apps/server/open_webui/benchmarks/data/`; they no
longer live at `tests/adapters/`, `tests/suites/`, `tests/tuning/` or
`prompts/system/` in this repo. The datasets themselves are fetched, not
vendored, into the backend's own `DATA_DIR` on first use.

Direct database access, replacing `lllm-db`, is a normal Postgres client
against the fork's own database — `psql "$DATABASE_URL"`, or anything else
that speaks that connection string — rather than a bespoke wrapper: every
table from the old schema is there under a `benchmark_` prefix (`config` →
`benchmark_config`, `result` → `benchmark_result`, and so on — see [The
tables](telemetry.md#the-tables)).

## Correctness, not just speed

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
`apps/server/open_webui/benchmarks/data/adapters/` (moved
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

## Page actions

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

## System prompts

By default a request carries one message: the item. Selecting a system
prompt on the Tests page puts the text of the matching file under
`apps/server/open_webui/benchmarks/data/prompts/` in front
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
covers the serving flags and is computed by `config_id()` before any request
is made; a system prompt is part of the request. So it is a second grouping key
beside it, in the pass-rate query and on the Compare page, and every existing
`config_id` still means what it always did.

`assistant.txt`, under that same `benchmarks/data/prompts/` directory, is a
copy of the text configured per-model in Open WebUI (see [Model
setup](../../README.md#model-setup)), kept so a benchmark run can be made under the prompt
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
level — set them for `make backend` the same way any other override is set
(exported in the shell before running it; the Makefile only loads
`infra/.env` for the three secrets, everything else in the environment
passes through to uvicorn as normal).
`temperature` is pinned to 0 and is not overridable — two runs must
differ only by the flags under test. `LLAMA_TEST_RAW` is gone: it used to keep
the response's temp file, and every response is now stored in full in the
`benchmark_answer` table regardless. `LLAMA_GRADER_PYTHON` overrides the
interpreter the graders execute against. `LLAMA_PLAIN=1` (or `NO_COLOR`)
still forces plain output, and the fork now sets it itself on every
subprocess it streams into an SSE connection (the Serve and Tune pages, for
`llama-server`'s and a sweep's own output) — Rich's escape codes would
otherwise show up raw in a browser rather than being rendered.

## The benchmarks

| Benchmark | Items | Ground truth | License | Citation |
| --- | --- | --- | --- | --- |
| [HumanEval](https://github.com/openai/human-eval) | 164 | `test` field: a `check(candidate)` function, plus `entry_point` | MIT | Chen et al. 2021, [arXiv:2107.03374](https://arxiv.org/abs/2107.03374) |
| [MBPP (sanitized)](https://github.com/google-research/google-research/tree/master/mbpp) | 427 | `test_imports` + `test_list` (3 asserts) | CC-BY-4.0 | Austin et al. 2021, [arXiv:2108.07732](https://arxiv.org/abs/2108.07732) |
| [DS-1000](https://github.com/xlang-ai/DS-1000) | 1000 (511 Pandas/Numpy) | `code_context`, which defines `test_execution(solution)` | CC-BY-SA-4.0 | Lai et al. 2022, [arXiv:2211.11501](https://arxiv.org/abs/2211.11501) |

The Tests page's fetch action downloads them into the fork's own
`<DATA_DIR>/benchmarks/datasets/` (`BENCHMARKS_DATA_DIR` overrides it) and
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

**Coverage gap:** [AGENTS.md](../../AGENTS.md#why) lists math and statistics among four primary use
cases; the suite covers coding and data analysis, and measures neither of the
other two. Adding GSM8K or a MATH subset is a new file in the fork's
`benchmarks/data/adapters/` rather than new code, but until that exists, a
pass rate here says nothing about
the math and statistics work this assistant is also for.

## Tiers

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

## Grading

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
[docs/decisions.md](../decisions.md) describes — it filed a serving failure as a model failure, and
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

## Calibrating the graders — the Tests page's selfcheck action

The selfcheck action grades every benchmark's **own reference solution**
(`canonical_solution`, `code`, `reference_code`). No model is involved, so a
correct harness scores 100%; anything less is a bug in the grader. Measured on
2026-08-30 (Python 3.14.7, numpy 2.5.2, pandas 3.0.5, pyyaml 6.0.3):

| Benchmark | Reference solutions passing | Ungradeable here |
| --- | --- | --- |
| HumanEval | 164/164 | 0 |
| MBPP | 427/427 | 0 |
| DS-1000 | 439/511 | 72 |

**What calibration cannot catch**, stated because this repo has already been
bitten by it: it runs the reference solutions, so it never sees the
`prompt_template`. A template that misinstructs the model — as ds1000's did
until 2026-09-04, naming an output variable that 194 of 511 items do not use —
scores a correct answer wrong, and calibration reports 100% throughout, because
the reference solution uses the variable the problem actually names. Only
reading the failures finds that class of bug.

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

## Where results are stored

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

## Comparing — the Compare page

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
project's decisions log ([docs/decisions.md](../decisions.md)):

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
(see above) — a measured table pasted into these guides, per the maintenance
policy, is copied out of the rendered page by hand.

## Reporting — the Report page

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
