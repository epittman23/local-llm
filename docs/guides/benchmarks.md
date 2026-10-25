# Benchmarks: testing serving configurations

The admin-only Benchmarks section (`/benchmarks`) serves, tests, compares,
reports on and tunes local llama.cpp configurations. This guide covers how
it is built, what each page does, and how results are graded and compared.
Serving itself is in [llama-cpp.md](llama-cpp.md) and the recorded GPU and
throughput data in [telemetry.md](telemetry.md).

## Architecture

Benchmarks is not a second app. It is a set of pages inside the same app
as chat, started by the same `make backend` described in [Running
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

`make backend` still owns Postgres's (and Redis's) lifecycle (`infra/docker-compose.yml`),
starting it before uvicorn and tearing it down via a trap when uvicorn stops,
Ctrl-C included. See [Running it](../../README.md#running-it) for the full command sequence.

The GPU telemetry recorder runs under the backend's venv and writes with
`psycopg` directly. It runs as a
**separate subprocess**, not a task inside the backend's own event
loop, and that part is unchanged on purpose: the whole reason it was ever a
subprocess was so a recording survives a crash or restart of whatever started
it, and folding it into the backend's event loop would trade that guarantee
away for no benefit.

## The pages

Benchmark running, grading, comparison, reporting and tuning are not shell
functions any more. `lllm-test`, `lllm-compare` (`lllm-test compare`),
`lllm-report`, `lllm-tune` and the standalone `lllm-web` dashboard were
retired outright on 2026-09-08, and the whole suite now lives inside the
app itself, as an admin-only **Benchmarks** section at
`/benchmarks`, served by the same `make backend` as the rest
of the app rather than a separate process or port. See the sections
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
  logic, ported into the backend rather than rewritten.
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
into `apps/server/local_llm/benchmarks/data/`; they no
longer live at `tests/adapters/`, `tests/suites/`, `tests/tuning/` or
`prompts/system/` in this repo. The datasets themselves are fetched, not
vendored, into the backend's own `DATA_DIR` on first use.

Direct database access, replacing `lllm-db`, is a normal Postgres client
against the app's own database — `psql "$DATABASE_URL"`, or anything else
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
`apps/server/local_llm/benchmarks/data/adapters/` (moved
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
| Tests → run one item | Ask and grade one item against what is being served, with the run's system prompt, and show the outcome and the answer. Pick a benchmark and an item id (e.g. `HumanEval/0`). **Not recorded**: a one-item run would land in every comparison that spans tiers. It says when a suite here would leave the item out (the library filter, or a reference solution that fails here) |
| Tests → run a tier | A whole `smoke`/`standard`/`full` tier. A benchmark filter restricts it, a resume action continues the most recent run of that tier. The window dates include LiveCodeBench, drawn from that window; without them it is left out |
| Tests → system prompt | Send the selected system prompt with every item of that run — see below |
| Tests → Datasets panel | Each benchmark's dataset: its item count and pinned revision, and its calibration (gradeable items, or why it is stale) |
| Tests → Fetch / Force refetch | A vendored dataset (HumanEval+, MBPP+, DS-1000) downloads nothing: Fetch only verifies its file and reports "in the repository, verified". LiveCodeBench downloads the increments ticked under the table, streaming progress; Fetch keeps one already on disk, Force refetch (after a confirmation) downloads it again, and a failed or cancelled download leaves the increments already there whole |
| Tests → Selfcheck | Grade every dataset's own reference solutions (LiveCodeBench has none, and says "not calibratable"), several at a time, streaming each verdict, and write the calibrations; cancelling writes none |
| Compare | Rank models and configurations — see below |
| Compare → export answers | Write a whole suite run's stored answers back out as flat markdown files, for grepping/diffing/archiving outside the app |
| Answers → view one | Render one stored answer as markdown directly in the browser |
| Report | The statistical comparison, rendered to the page, without running anything new |
| `psql` (or any Postgres client) against `DATABASE_URL` | Raw access to the app's own database (the `benchmark_*` tables) |

The Tests page runs one job at a time (a tier run, a fetch, a selfcheck or one
item), and none while a tune sweep runs, nor a sweep while one of them does: a
fetch would change the datasets under a run, and each competes with a sweep for
the server and the CPU it measures.

The profile picker on the Serve page names the serving profile whose alias
and `reasoning_effort` are used; the model name itself is read from the
running server (`GET /v1/models`) and a mismatch warns rather than
mislabels, since the profile describes an intended configuration while the
server is already serving something.

## Through the app (harness mode)

By default an item goes straight to `llama-server`, so a run measures the
bare model. With `harness_model` set on a Tests run (`POST
/api/v1/benchmarks/tests/run` or `/item`, the id of a Workspace model entry),
each item is answered the way a chat answers it instead:

- through that model entry, with its system prompt and params;
- with the code interpreter on the Jupyter engine, and `execute_code` as the
  only tool offered (the builtin tools that browse notes, chats and
  knowledge are cut);
- through the app's own chat pipeline (`benchmarks/evaluation/harness.py`),
  with a `temporary:` chat id, so no chat row, title or memory is written,
  and a plot a code run prints stays inline rather than being stored in the
  owner's Files.

There is no switch on the Tests page yet (planned in PR 2 of
[the plan](../plans/benchmarks-through-the-app.md)).

**The model has to make structured tool calls** for the code interpreter to
run. On 2026-10-24, `qwen25c` (Qwen2.5-Coder-7B) wrote its `execute_code`
call as JSON text in a code fence instead, so `llama-server` never parsed
it, no code ran, and a harness run on it measured the bare model plus the
entry's system prompt. `qwen38` made a structured call; the code ran in
Jupyter; and a second round answered. That one item took 452 s, partly
offloaded and thinking. `harness_stats.code_runs` shows which case a run is.

**What it needs.** The model entry has to be on an OpenAI-compatible
connection that points at the `llama-server` being measured, for example
`http://127.0.0.1:8090/v1` in Admin Settings > Connections. The code
interpreter has to be on, on the Jupyter engine. Native function calling
only.

**What it refuses.** A result is recorded only when the harness can vouch
for where it came from. The run stops, with `not recorded: ...`, when:

- the entry is served by any other URL, or its base model is missing;
- it turns streaming off, uses legacy function calling, or sets
  `max_completion_tokens` (in its own params or in the global model
  defaults);
- the Jupyter server does not answer, or a code run fails in the
  interpreter itself rather than in the code;
- a single upstream request would go anywhere but `127.0.0.1:<port>`.
  It is stopped before it is sent, so the item never reaches that host;
- no upstream request is seen at all;
- the request changes between items: the system prompt, the tools or any
  param. That includes a resume, which continues under the spec its run was
  recorded with.

**What is recorded.**

- **`harness_sha`.** A sha of what every item shares, read back from the
  first request actually sent upstream: the model entry, the system
  message, the tools offered, every other key of the request body (the
  sampling params, whatever their source), and the limits (at most 8 tool
  rounds, no tool approval). `benchmark_harness` holds what each sha
  stands for. NULL means a bare request.
- **What is graded.** Only the text of the message after the last code run,
  never the code the model ran on the way. The whole structured output is
  kept in `benchmark_answer.output`.
- **No llama.cpp timings.** llama.cpp reports them for the last upstream
  call only, so a speed read from them would mix one-call items with
  multi-round ones. Instead, `harness_stats` holds the rounds, the code runs,
  their total time and the output tokens, and `wall_ms` is the whole item.
- **Errors.** An error with the server still up is the item's
  `fail_error`. A server that stopped answering raises, as in the bare
  mode, and records nothing.

**Kept apart.** Compare and Report leave harness rows out for now, until
they group and label by `harness_sha` (PR 2). A resume continues only a run
in the same mode. Like the system prompt, the harness is not part of
`config_id`.

## System prompts

By default a request carries one message: the item. Selecting a system
prompt on the Tests page puts the text of the matching file under
`apps/server/local_llm/benchmarks/data/prompts/` in front
of it as a `system` message, which is where the app puts its own, and is
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
copy of the text configured per-model in the app (see [Model
setup](../../README.md#model-setup)), kept so a benchmark run can be made under the prompt
the assistant actually serves. The app remains the source of truth for
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
| `assistant` | the deployed prompt, verbatim |
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

**None of these is deployed.** The app still serves `assistant.txt`, and if a
rewrite measures better it is adopted there, with `assistant.txt` updated to
match in the same change. Winning a benchmark here changes nothing on its own.

Request knobs, unchanged from the shell version and read the same way, just
now by the backend process rather than a CLI: `LLAMA_TEST_MAX_TOKENS`
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
still forces plain output, and the backend now sets it itself on every
subprocess it streams into an SSE connection (the Serve and Tune pages, for
`llama-server`'s and a sweep's own output) — Rich's escape codes would
otherwise show up raw in a browser rather than being rendered.

## The benchmarks

| Benchmark | Items | Ground truth | License | Citation |
| --- | --- | --- | --- | --- |
| [HumanEval+](https://github.com/evalplus/evalplus) (`humanevalplus`), release v0.1.10 | 164 | `base_input` + `plus_input` (a median of 973 inputs per task); the expected outputs come from `canonical_solution` | Apache-2.0 (EvalPlus), over HumanEval (MIT) | Liu et al. 2023, [arXiv:2305.01210](https://arxiv.org/abs/2305.01210); Chen et al. 2021, [arXiv:2107.03374](https://arxiv.org/abs/2107.03374) |
| [MBPP+](https://github.com/evalplus/evalplus) (`mbppplus`), release v0.2.0 | 378 | the same, a median of 105 plus inputs | Apache-2.0 (EvalPlus), over MBPP (CC-BY-4.0) | Liu et al. 2023; Austin et al. 2021, [arXiv:2108.07732](https://arxiv.org/abs/2108.07732) |
| [DS-1000](https://github.com/xlang-ai/DS-1000) (`ds1000`), revision `4416080a` | 1000 (511 Pandas/Numpy) | `code_context`, which defines `test_execution(solution)` | CC-BY-SA-4.0 | Lai et al. 2022, [arXiv:2211.11501](https://arxiv.org/abs/2211.11501) |
| [LiveCodeBench](https://livecodebench.github.io/) (`livecodebench`), release_v6 at commit `0fe84c39` | 1055, dated 2023-05-07 to 2025-04-06 | public and private tests per problem (stdin, or functional for LeetCode); no reference solutions | unclear (card `cc`, loader MIT), fetched, not redistributed | Jain et al. 2024, [arXiv:2403.07974](https://arxiv.org/abs/2403.07974) |

HumanEval+ and MBPP+ replaced HumanEval and MBPP (sanitized) on 2026-10-25.
They are the same problems with EvalPlus's corrected reference solutions and
many more inputs, so an answer that passed the original three or so asserts
but breaks on an edge case now fails. The ids are new (`humanevalplus`,
`mbppplus`), although the task ids are not (`HumanEval/0`, `Mbpp/2`): a
resume, which skips items by benchmark and item id, can never mistake an old
item for a new one. MBPP+ keeps 378 of the 427 sanitized problems; EvalPlus
removed the ones it found ill-posed.

**The datasets are vendored.** Each file is in the repository under
`apps/server/local_llm/benchmarks/data/datasets/<id>/`, and its adapter's
`[source]` names the release, the upstream URL and the SHA-256 of its
decompressed rows. The loader checks that hash whenever the file changes on
disk (the verified bytes are cached by path, modification time and size) and
refuses a file that does not match, so an edited dataset is never graded. The
Datasets panel shows the refusal on that dataset's row.

- The HumanEval+ and MBPP+ files are upstream's release assets, byte for
  byte.
- The DS-1000 file is the pinned revision's `test.jsonl`, gzipped. Its 1000
  rows are identical, field for field, to what the datasets-server fetch
  returned before.

**Every result records the dataset's revision**, `<release>@<sha256[:12]>`
(for example `v0.1.10@42526ec0e7d5`). DS-1000 is the exception: its rows are
the fetched ones, so it keeps the revision the fetch recorded
(`4416080ac5cb…`, the adapter's `revision`), and its results from before and
after vendoring stay comparable. Per this project's convention a number
without its configuration is not reusable, and for a pass rate the
configuration includes which items were asked.

Until 2026-10-25 the datasets were fetched from upstream branch heads into
`<DATA_DIR>/benchmarks/datasets/`, which resolve to different content over
time. A fresh data directory had nothing to run until someone pressed Fetch.
Vendoring reverses that decision; the 2026-10-25 entry in
[docs/decisions.md](../decisions.md) gives the reasons, and
[NOTICE](../../NOTICE) carries the three licenses. The fetch machinery stays,
for LiveCodeBench, which is too large to vendor, and calibrations still live in
that directory (`BENCHMARKS_DATA_DIR` overrides it).

### LiveCodeBench and the release-date window

LiveCodeBench (added 2026-10-25) is competition problems from LeetCode,
AtCoder and Codeforces, each dated by its contest. A run draws them from a
**release-date window** the user gives on the Tests page ("Window from", and
optionally "Window to"): only problems from contests inside it. A model can
then be measured on problems published after its training data was
collected. The newest problem in the newest release is from **2025-04-06**,
so for a 2026 model no window is guaranteed unseen. Its problems are still far
less common than HumanEval's, which every training set has.

**Fetching is by increment.** The release is six files, 4.5 GB in all, pinned
in `livecodebench.toml`. Tick the ones wanted in the Datasets panel, then
Fetch:

| Increment | Problems | Contest dates | Download |
| --- | --- | --- | --- |
| `test.jsonl` | 400 | 2023-05-07 to 2024-03-02 | 1.17 GiB |
| `test2.jsonl` | 111 | 2024-03-09 to 2024-05-25 | 680 MiB |
| `test3.jsonl` | 101 | 2024-06-01 to 2024-08-10 | 594 MiB |
| `test4.jsonl` | 101 | 2023-08-26 to 2024-10-05 | 1.12 GiB |
| `test5.jsonl` | 167 | 2024-09-22 to 2025-01-04 | 532 MiB |
| `test6.jsonl` | 175 | 2025-01-04 to 2025-04-06 | 128 MiB |

- **What a fetch does:** each file is streamed to disk and checked against its
  pinned SHA-256. It is then decoded once, into `items.jsonl` and one gzipped
  file of private tests per problem, and the raw file is deleted. test6 takes
  about 40 s and 97 MB.
- **Decoding:** the private tests are pickled upstream. They are unpickled at
  fetch time by an unpickler that refuses every global, and never when an
  answer is graded.
- **Coverage:** a window needs **every increment whose dates it touches.** The
  ranges overlap (test4 reaches back to 2023-08-26), so a run refuses a window
  until those are all fetched, and names the missing ones. The pool then
  depends on the window alone, never on what happens to be on disk.
  - A window from 2025-01-05 needs test6 only.

**In a tier**, LiveCodeBench is the fourth benchmark (8, 100 or every
problem), but only when a window is given:
- Without one, the run leaves it out and says so in the run's notes. Tune's
  sweeps and every unwindowed run behave as before.
- Picking `livecodebench` in the benchmark filter without a window is refused.
- A window that holds fewer problems than the tier asks for uses all of them,
  and says so.
- The window is recorded on every LiveCodeBench result (`item_window`) and
  shown on the running stream. Compare and Report keep each window's results
  in a block of their own.
- Resuming a run under a different window is refused.


**Saturation, stated plainly:** HumanEval and MBPP are heavily contaminated for
a 2026 model, and their `+` versions share those problems, so they still sit
near ceiling. The extra inputs make them stricter, not unseen. That is
acceptable here because the question is not model capability but whether a
*serving configuration* degrades output, and a ceiling-hugging benchmark still
detects a config that breaks things. DS-1000 is explicitly perturbed against
memorization and carries most of the discriminating power.

**Coverage gap:** [AGENTS.md](../../AGENTS.md#why) lists math and statistics among four primary use
cases; the suite covers coding and data analysis, and measures neither of the
other two. Adding GSM8K or a MATH subset is a new file in
`apps/server/local_llm/benchmarks/data/adapters/` rather than new code, but until that exists, a
pass rate here says nothing about
the math and statistics work this assistant is also for.

## Tiers

| Tier | Composition | Purpose |
| --- | --- | --- |
| `smoke` | 8 per benchmark: 24 items, 32 with a window | The tuning loop: fast enough to run between two serving configurations |
| `standard` | 100 per benchmark: 300 items, 400 with a window | An overnight run |
| `full` | Every gradeable item (163 + 377 + 456 = 996 on 2026-10-25; DS-1000's count depends on the grading environment), plus every LiveCodeBench problem in the window | The only tier comparable to a published score |

Sampling is seeded (`seed = 20260830`, recorded in each result) and sorted by the
dataset's own id before sampling, so `smoke` is the same 24 items on every run
and under every configuration.

**`smoke` is n=24. One item is about four percentage points.** Use it to detect
that a configuration *broke* something, not to rank two that both work. The
comparison output prints `passed/attempted` beside every rate and refuses to
rank rows from different tiers against each other.

## Grading

Each harness uses the benchmark's own evaluation logic:

- **HumanEval+ and MBPP+** (`grading/evalplus.py`, one harness for both) —
  EvalPlus's own evaluation, ported from v0.3.1 into
  `grading/evalplus_runtime.py`, which is embedded in every grading program:
  - The last fenced block containing a `def` wins. For HumanEval+, when the
    model returned only a body, the stub is prepended so that answer is
    graded rather than discarded.
  - The canonical solution (`prompt` + `canonical_solution`) runs first, on
    deep copies of every input, giving the expected outputs and how long each
    took. Only then is the answer loaded, as the module `solution`.
  - The answer is called on every base input, then every plus input, and each
    output is compared as EvalPlus compares it: exact match, or
    `allclose(rtol=1e-7, atol)` for floats, with `atol` forced to 1e-6 once
    a float output appears. EvalPlus's special oracles apply: set equality
    for eight MBPP+ tasks, presence for three, Mbpp/164, 295, 558 and 581,
    and HumanEval/32 (`find_zero`), where any root within `atol` passes.
    That last one is a deliberate difference: in EvalPlus 0.3.1 the oracle
    skips the progress counter, so every answer fails it.
  - MBPP+ inputs are deserialized by EvalPlus's rules first: JSON stores
    tuples as lists, and 62 special-cased task ids need tuples, sets,
    complex numbers or dicts of tuples back.
  - The first failure ends the item, and its reason names the input set, the
    input and what differed (`plus input 0: expected 49, got 0`).
  - Before any of that, the answer is sanitized as EvalPlus sanitizes it: its
    imports, then the entry point and the top-level definitions it reaches,
    and nothing else. A model's own `assert`s and example calls never run,
    so a wrong self-test cannot fail a correct function. Two of EvalPlus's
    quirks come along: a function with no `return` is dropped, and so is a
    decorated one. EvalPlus starts from the longest run of lines in the reply
    that parses. This harness starts from the block `extract_code()` chose
    (the last fenced block with a `def`).

  `allclose` is numpy's formula, reimplemented so the program can run with
  `-S`, and tested against `numpy.allclose` on every float task's real
  outputs.
- **DS-1000** — `code_context` is executed and its own `test_execution(solution)`
  is called with the extracted code as a string literal; `test_string(solution)`
  too when the item defines it.
- **LiveCodeBench** (`grading/livecodebench.py`) — LiveCodeBench's own
  semantics from `lcb_runner/evaluation/testing_util.py` at commit
  `28fef95e`:
  - The code is the text between the reply's last two fence lines, as
    LiveCodeBench extracts it. A reply with no fenced block is `no_code`.
  - LiveCodeBench's import header goes in first. It brings in `gcd`, `deque`,
    `List` and the like without an import, and raises the recursion limit to
    50000.
  - Public tests run first, then private ones. The first failure ends the
    problem, and its reason names the test.
  - **Functional (LeetCode):** one grading program, under the driver below.
    It calls `Solution().<func_name>` (or a module-level function, when the
    reply has no `class Solution`) with each test's JSON arguments, and
    compares the result exactly, a tuple counting as a list.
  - **Stdin (AtCoder, Codeforces):** the reply runs as `__main__` once per
    test, in its own subprocess, with the test's input piped to stdin. Its
    stdout is compared in the grader: stripped lines, each equal exactly or
    as `Decimal` tokens. A `SystemExit` after the output is ignored, as
    LiveCodeBench ignores it. Any other exception is `fail_error`. The
    verdict never comes from the program's own exit status.
  - LiveCodeBench grades stdin problems in one process instead, with stdin
    mocked. That mock fails two common correct idioms (repeated
    `sys.stdin.buffer.readline()`, and a `global` in a helper), so real stdin
    is used here; the decisions entry records it.

**How a verdict is reached.** The program is not run directly: a small
driver (`DRIVER` in `evaluation/grading/__init__.py`) runs it as the module
`__graded__`, then prints a random per-run nonce, and **`pass` means that
nonce was printed** — the model's code and the dataset's tests ran to the
end. Until 2026-10-19 the verdict was the exit status, so code that called
`sys.exit(0)`, `os._exit(0)` or a bare `unittest.main()` before the tests
ran passed (#126). Running as `__graded__` rather than `__main__` means a
model's `if __name__ == '__main__':` block does not run, as it would not when
a benchmark's own runner imports a solution; such a block that read stdin
used to fail a correct answer. The nonce reaches the driver on stdin, which
is replaced with `/dev/null` before any graded code runs, so the program has
no file, argument or environment variable to read it from. A program that
exits early fails with `fail_error`, "exited before its tests finished".

**Time limits.** DS-1000 items have a fixed subprocess timeout (60 s, the
adapter's `[check] timeout`). LiveCodeBench's are its own: 6 s per test
(`timeout_per_test`, plus 1 s for a stdin test's interpreter to start), and
(6 + 1) x tests + 5 s for the whole problem. It has no reference to scale
against, so these are absolute. Its answers get the same 4 GiB address-space
limit, which LiveCodeBench does not set. HumanEval+ and MBPP+ follow EvalPlus, from
their adapters' `[check]`, so a change to any of these changes `adapter_sha`:

| Limit | Value | EvalPlus's |
| --- | --- | --- |
| Per input | `max(min_time_limit, time_limit_factor x the reference's time on that input)` = `max(1.0 s, 4 x ref)` | the same defaults |
| Per item | `cap` = 120 s, the reference's run included; the answer gets what is left of it, or the sum of its per-input limits if that is less | `min(60, sum) + 1` s per input set, the reference timed separately |
| Subprocess | `cap` + 5 s, for start-up | none |
| Memory | `memory_limit_gib` = 4 GiB of address space | 4 GiB |

The cap is wider than EvalPlus's because the reference now runs inside it, on
a laptop slower than EvalPlus's machines. Reference times are measured in the
same run, under the same load as the answer, rather than cached from an
earlier one. A per-input timeout is `fail_timeout`, with a reason naming the
input, its limit and the reference's time (harness version 3 recognises
it).

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
> `-I` (and `-S` for HumanEval+/MBPP+, which need only the standard library).
> It has no stdin and an environment of `PATH`, `LANG`, `LC_ALL`, `HOME`
> and `TMPDIR` only (the latter two pointing at the temporary directory),
> never the backend's own. It runs in its own session, and the whole
> process group is killed when it ends or times out, so nothing it starts
> outlives the grade (#142). Grading runs in a worker thread, so a slow
> grade does not stall the backend's other requests (#140).
> That is **process isolation, not a sandbox.** It is what the upstream
> benchmark runners do and is acceptable on a single-user local box; it is
> not safe against adversarial output. Do not point this at a model you do
> not trust.

## Calibrating the graders — the Tests page's selfcheck action

The selfcheck action grades every benchmark's **own reference solution**
(`canonical_solution`, `reference_code`). No model is involved, so a
correct harness scores 100%; anything less is a bug in the grader, or in the
dataset.

**LiveCodeBench ships no reference solutions**, so selfcheck reports it as
"not calibratable" and excludes nothing. Its harness was checked by hand
instead, on 2026-10-25, against test6's real tests:
- Hand-written correct answers passed every test of their problem. They were
  `atcoder/abc387_b` (40 tests) three ways (`input()`, repeated
  `sys.stdin.buffer.readline()`, and `open(0)` behind a main guard), plus
  `leetcode/3708` and `leetcode/3731` (31 tests each).
- Wrong, crashing, looping and unfenced answers came out as `fail_assert`,
  `fail_error`, `fail_timeout` and `no_code`. Measured on 2026-10-25 on the NVIDIA GeForce RTX 3060 Laptop machine
under native Fedora 44 (grading runs on the CPU), with harness version 3,
dataset revisions HumanEval+ `v0.1.10@42526ec0e7d5`, MBPP+ `v0.2.0@b54e76275524`
and DS-1000 `4416080ac5cb`, and the grading environment Python
3.12.14, numpy 2.5.3, pandas 3.0.6, scipy 1.18.1, scikit-learn 1.9.1, pyyaml
6.0.3:

| Benchmark | Reference solutions passing | Ungradeable here |
| --- | --- | --- |
| HumanEval+ | 163/164 | 1 (HumanEval/32) |
| MBPP+ | 377/378 | 1 (Mbpp/630) |
| DS-1000 | 456/511 | 55 |

**HumanEval/32 is EvalPlus's own inconsistency**, twice over: under EvalPlus
0.3.1 no answer can pass it (see Grading). Its task is `find_zero`,
graded by evaluating the polynomial at the returned root. The canonical
solution is a Newton iteration (tolerance 1e-5, at most 1000 steps), and on
plus input 119, whose constant term is 9,450,000, it ends at a point where
|p(x)| = 0.0023, above the task's `atol` of 1e-4. Graded as EvalPlus
grades it, the reference fails, so calibration excludes the item rather than
score every model against a test its own answer cannot pass.

**Mbpp/630 is EvalPlus's sanitizer.** The reference's helper `adjac` is a
generator, with `yield` and no `return`, and EvalPlus's sanitizer keeps only
functions that contain a `return`. EvalPlus never sanitizes its references,
so it never sees this; graded as an answer, which is what selfcheck does, the
reference loses its helper and fails with a `NameError`. A model that wrote
the same helper would fail under EvalPlus too.

The DS-1000 slice is the same 55 items as on 2026-10-19, under harness
version 2 and the fetched copy of the same rows. The 2026-10-19 figures for
the benchmarks HumanEval+ and MBPP+ replaced were HumanEval 164/164 and MBPP
427/427. Every reference solution got the same verdict under the harness
before the 2026-10-19 verdict change and under the one after it, item for
item. The
historical figure, measured on 2026-08-30 under WSL2 with Python 3.14.7, numpy
2.5.2 and pandas 3.0.5, was 439/511 for DS-1000 (72 ungradeable); the
environments differ in those three versions, and which difference moved the 17
items was not established.

**What calibration cannot catch**, stated because this repo has already been
bitten by it: it runs the reference solutions, so it never sees the
`prompt_template`. A template that misinstructs the model — as ds1000's did
until 2026-09-04, naming an output variable that 194 of 511 items do not use —
scores a correct answer wrong, and calibration reports 100% throughout, because
the reference solution uses the variable the problem actually names. Only
reading the failures finds that class of bug.

The ungradeable DS-1000 items are not a grader bug. **DS-1000 was published in 2022 against pandas 1.x**,
and on pandas 3 a chunk of it fails before any model is involved:
`DataFrame.append` was removed in pandas 2.0, `replace(method=)` and
`read_csv(delim_whitespace=)` in 3.0, and the string dtype changed. Grading a
model against a test the dataset's own answer cannot pass measures the library
versions, not the model — it would understate every model by about 11 points
on that benchmark here (55 of 511), and did by about 14 under the 2026-08-30
environment.

So selfcheck writes `<DATA_DIR>/benchmarks/datasets/<benchmark>/CALIBRATION.json`,
and those items are **skipped** when a suite runs, with the benchmark's own
verdict as the evidence. The calibration records the dataset hash, the
grading environment's library versions and the grader's `HARNESS_VERSION`,
and reports itself stale when any of them changes — a calibration is only
valid for the environment and the grader that produced it. Bump
`HARNESS_VERSION` with any change to how programs are run that can change a
verdict.
Re-run selfcheck from the Tests page after upgrading pandas or refetching a
dataset.

Note the consequence for comparability: a `full` DS-1000 pass rate from this box
is over the gradeable items (456 here on 2026-10-19), not 511, so it is not directly comparable to a published
DS-1000 number. The excluded items are in `benchmark_suite_exclusion`, and
their counts are reported beneath every comparison table.

## Where results are stored

Results go into the same Postgres database as the serving telemetry, which is
the point: the question this harness exists to answer — did the configuration
that ran faster also answer correctly — is a join, not a comparison between two
files.

| table | one row per | holds |
| --- | --- | --- |
| `benchmark_result` | attempted item | `suite_run_id`, timestamp, model, profile, benchmark, `item_id`, dataset revision, tier, seed, outcome, reason, `reasoning_chars`, `wall_ms`, the `system_name`/`system_sha` of the system prompt sent (NULL when none was), the `adapter_sha` of the adapter it was asked under (NULL when it predates the fingerprint, which here means *unknown*), the `cluster` the problem belongs to (NULL when the benchmark's problems are independent), the request `params` and the full llama.cpp `timings` — plus foreign keys to the `benchmark_request`, the `benchmark_run` and the `benchmark_config` it was measured under |
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
suite run, pick `humanevalplus/HumanEval/0` (or any other item that run
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

Results are grouped into **blocks**: one tier, benchmark, adapter, system
prompt, release-date window and dataset revision. Inside a block every
configuration was asked the same problems, so a difference is the
configuration's; across blocks it is not, and rows are never ordered or
compared across them. Each block is one table, headed by what defines it (the
release-date window first, when the benchmark has one), with one row per
configuration (model, config-id).

Columns: the group letter (below), the configuration, `passed/attempted`, the
problem count (and cluster count), the pass rate with its 95% interval, its
standard error and whether it is `iid` or `cluster`-robust, **passes per
minute** with its interval, generation and cold prefill t/s, and the flag
summary (`ngl`, `parallel`, `spec`, `-ot`, `fa`, ...) joined from
`benchmark_config` with the same helpers that render the serving comparison.
A baseline config-id adds each row's difference from the baseline's rate *in
the same block*.

The statistics follow Evan Miller, "Adding Error Bars to Evals"
(arXiv:2411.00640), in `local_llm/benchmarks/analysis/estimators.py`, which
Report uses too:

- **Per problem first.** A problem asked in several suite runs (the only way
  this store gets more than one sample, since temperature is pinned to 0) is
  averaged before anything else, so it counts once. `passed/attempted` still
  counts samples.
- **Interval:** Wilson. With one sample per problem and independent problems
  it is plain Wilson at n; otherwise it is Wilson at the design-effect sample
  size n_eff = p(1-p)/SE^2, falling back to n problems (or G clusters) at 0%
  and 100%, where the variance estimate is zero. Wilson because the normal
  interval collapses at 0% and 100%, which is where a good configuration on
  an easy benchmark sits.
- **Clusters.** Problems are not always independent: DS-1000's 511
  Pandas/Numpy problems are perturbations of 195 StackOverflow questions, and
  perturbations of one question share most of their difficulty. An adapter
  names its cluster with `[item] cluster_fields`, the runner writes it to
  `benchmark_result.cluster`, and the standard error is then cluster-robust
  (CR1). DS-1000 clusters by `(library, perturbation_origin_id)`; library
  alone would give two clusters, too few for the estimator to mean anything.
  Fewer than 20 clusters is reported with a warning.
- **Pairs.** Every two configurations in a block are compared as paired
  differences on the problems both answered: the mean difference, its
  interval, and the correlation of their per-problem scores. The test is
  exact McNemar when every shared problem is one pass/fail sample and the
  problems are independent, and otherwise a paired t test with the matching
  standard error (n-1 or G-1 degrees of freedom). Holm corrects across every
  pair tested in the block; a pair with no shared problems is reported and
  left out of the family.
- **Groups, not a ranking.** Configurations that are not significantly
  different after Holm share a letter (a compact letter display, Piepho
  2004). `a` is the best group. Read the letters rather than the row order.
- **Power.** Each pair carries its minimum detectable difference,
  (z_{1-a/2} + z_{0.80}) x SE of the paired difference, at alpha 0.05 and at
  the Holm worst case alpha/m. A pair that is not significant and whose
  observed difference is below that is marked **underpowered**: the design
  could not have found it.

`passes/min` is the honest combined metric on this hardware: pass rate alone would
rank a configuration that answers correctly at one token a second above a usable
one, and throughput alone is what the **by serving** view already reports.
It is the per-problem mean passes over the per-problem mean wall-clock minutes
(`wall_ms`, measured around the HTTP request, so grading time is excluded). A
ratio of two sums is not a mean, so its interval comes from the **delta
method**, clustered like the standard error and formed on the log scale so it
stays positive.

Things the output refuses to do, each learned from a mistake in this
project's decisions log ([docs/decisions.md](../decisions.md)):

- **Never a bare percentage.** `passed/attempted` and an interval are printed
  beside every rate.
- **Blocks never mix.** A 24-item `smoke` rate and a 164-item `full` one, two
  benchmarks, two dataset revisions or two release-date windows are different
  questions, so they are different blocks; the baseline difference reads
  `baseline not measured on this block` rather than crossing one. (Until
  2026-10-19 the rows of every tier were ranked together, #132.)
- **No strict ranking.** Two configurations that are not significantly
  different after Holm share a group letter, however their rates happen to
  order.
- **A pair of configs differing in more than one flag is flagged as such.** This
  project lost a measurement to exactly that (the 2026-08-23 `--parallel` entry).
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

Four views: **by config** (the default, the block tables above, each followed
by its pairs), **by benchmark** (one row per configuration, with a
`passed/attempted` and a pass-rate column per benchmark), **by failures** (every
item that did not pass, with its reason and the size of its reasoning, newest
first), and **by serving** (throughput and GPU telemetry per configuration,
with no test run involved, and the derived table beneath it). Filters on the
page: tier, and a baseline config to diff against. There is no built-in table
export any more (see above) — a measured table pasted into these guides, per the
maintenance policy, is copied out of the rendered page by hand.

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

Eight sections after a headline, ordered so each gates the next:
**provenance** (which database, which rows, which revisions and release-date
windows — the app's Postgres is not something a reader can casually open
elsewhere, so a number without this is not checkable), **design audit**,
**reliability floor**, **paired accuracy** (system prompts), **configuration
comparison**, **power/MDE**, **throughput**, **throttle audit**.

The design audit ends with a **power check** (added 2026-10-19): per block,
how many shared problems the configuration comparisons rest on, the smallest
difference they could detect at 80% power after Holm, and how many of them are
underpowered, so a comparison the design cannot resolve is known before its
result is read.

The **configuration comparison** (section 5, added 2026-10-19) is the Compare
page's statistics written out with their methods: per block, every
configuration's rate with its Wilson interval and standard error, passes per
minute with its delta-method interval, every pair's paired difference, test,
Holm p and minimum detectable difference, the group letters, and one sentence
per underpowered pair saying how large a difference it could have found. The
**headline** is derived from the tests: a system-prompt or configuration
difference that survives Holm is reported as one, and the reliability-floor
sentence dismisses differences as noise only when none survived and all are
below the floor (until 2026-10-19 the headline was fixed text that always
reported no difference, #128). The page shows the release-date windows in scope
above the document.

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

That figure pooled the items of every block into one count (32), which no test
in the report actually ran on (#133). Since 2026-10-19 the power section
assesses each block at its own item count and at the Holm worst-case level
alpha/m, m being the number of levels compared with that block's baseline.

Statistics: the configuration comparison uses `analysis/estimators.py`, with
statsmodels for the cluster-robust errors, Wilson intervals, exact McNemar and
Holm, and scipy for the distributions; each estimator is tested against values
worked by hand (`tests/test_estimators.py`). The system-prompt sections keep
their own implementations: Cochran's Q, its permutation p (exact by enumeration
when the arrangement count allows, Monte Carlo with the `+1` correction
otherwise), Wilson intervals, Holm correction and the MDE search are written
out in `local_llm/benchmarks/analysis/report.py` (a direct port of the original
`scripts/llama_report.py`), and were cross-checked against statsmodels. Every test prints its `n` and its
assumption check; a test whose assumptions fail is printed as refused with
the reason, never dropped silently.

**Reads only.** No migration, no `benchmark_schema_note` row, no row
written — verified by checksum and row counts either side of a run. Rather
than opening the database itself in a read-only mode the way `mode=ro` did
against a SQLite file, the report goes through the same read-only async
Table-wrapper query methods every other read path in the backend uses, and never
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
