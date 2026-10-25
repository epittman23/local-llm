# Plan: upgrade the benchmark pipeline (datasets, pre-screen, statistics)

Status: **approved by the owner on 2026-10-19**, with two decisions changed from
the recommendations below: Optuna and optuna-dashboard are used for the
pre-screen (D9), and Optuna's studies live in a dedicated `optuna` Postgres
schema (D13). PR 4 (statistics) is the first to be implemented. Whether the
security batch B0 must land before the dataset PRs (D0) is still open.

Progress: PR 4 and the audit batches B0-B3 have landed. **PR 1 (HumanEval+
and MBPP+) was implemented on 2026-10-25**; its differences from section 7.2
are in that day's decisions entry. **PR 2 (LiveCodeBench) was implemented
the same day**, with the differences from section 7.3 in its own decisions
entry. PR 3 (the pre-screen) is not started.

Scope: four upgrades to `apps/server/local_llm/benchmarks/` and the
Benchmarks pages in `apps/web`:

1. Replace HumanEval and MBPP with HumanEval+ and MBPP+ (EvalPlus).
2. Add a LiveCodeBench slice with a per-run release-date window.
3. Add a llama-bench pre-screen of candidate flags.
4. Replace naive comparisons in Compare and Report with the methods of
   Miller, "Adding Error Bars to Evals" (arXiv:2411.00640).

What was read: AGENTS.md, MAP.md, the benchmarks, llama-cpp, telemetry and
testing guides, docs/decisions.md, docs/audit/ (FINDINGS, FIX_PLAN), and the
code for datasets, adapters, suites, grading, runner, compare, report,
profiles, launcher, fingerprint, the telemetry recorder, Tune's probe, the
Tests/Compare/Report routers and pages, and both benchmark migrations.
Outside the repo, the actual data was downloaded and inspected (section 4).

---

## 1. Summary

- **The brief conflicts with the 2026-10-19 audit.** These upgrades rewrite
  code that open audit issues also fix: B1 grading (#126, #140, #142), B2
  dataset fetch and selfcheck (#141), B3 fingerprint (#127) and B4
  Compare/Report (#128-#133). The owner has already decided that B0
  (security) goes before any batch. Section 6 proposes an order; whether
  these upgrades wait for B0 is the owner's call.
- **Upgrades 1 and 2 cannot work on this machine without #141.** No endpoint
  fetches a dataset or runs selfcheck, so a fresh `DATA_DIR` has no
  datasets and every run fails. Upgrade 1 can avoid the fetch half by
  vendoring its data files. LiveCodeBench cannot be vendored (section 4.3).
- **LiveCodeBench's newest problem is from 2025-04-06.** The latest release
  is `release_v6` (May 2023 to April 2025, 1055 problems), and nothing newer
  was found. If the 2026 models in use were trained on data after that
  date, no window is free of contamination. The window still separates
  older from newer problems, and that might still show something useful,
  but the owner should know this before Upgrade 2 is built.
- **Clustering DS-1000 by library gives 2 clusters**, because the adapter
  filters to Pandas and Numpy. Cluster-robust standard errors are not
  usable with two clusters. The plan recommends clustering by the original
  StackOverflow problem instead (195 clusters; decision D3).
- **New dependencies: `statsmodels` (PR 4), and `optuna` plus
  `optuna-dashboard` (PR 3, the owner's decision of 2026-10-19; see D9).**
  Not `evalplus`: its 0.3.1 release requires openai, anthropic,
  google-generativeai, transformers and datasets, and has not been released
  since 2024-10.

## 2. Decisions needed before work starts

| # | Question | Recommendation |
|---|---|---|
| D0 | Must B0 (security advisories) land before these upgrades? | Owner's call; the standing decision says yes |
| D1 | Order of the audit batches against the upgrades (section 6) | B4 folded into PR 4; B1, B2, B3 as separate PRs before PR 1 |
| D2 | Vendor dataset files or keep fetching them | Vendor HumanEval+, MBPP+ and DS-1000; fetch LiveCodeBench (pinned) |
| D3 | DS-1000 clustering variable | `(library, perturbation_origin_id)`, not library |
| D4 | LiveCodeBench clustering variable | `(platform, contest_id)` |
| D5 | Where the release-date window lives | A `benchmark_result.item_window` column in the grouping key, not `config_id` |
| D6 | Confidence interval for a pass rate | Wilson with a design-effect-adjusted sample size |
| D7 | How the "not significantly different" groups are shown | Compact letter display |
| D8 | Interval for passes per minute | Delta method, cluster-aware, on the log scale |
| D9 | Optuna and optuna-dashboard | **Decided by the owner (2026-10-19): use both.** Optuna drives every pre-screen, with a grid or a TPE sampler |
| D10 | Pass `-fit off` to `llama-server` | Yes, with the #127 fingerprint change |
| D11 | Pre-screen VRAM fit check at the profile's context | Yes: a short `llama-server` load check for the top candidates |
| D12 | Pre-screen UI location | A new `/benchmarks/prescreen` page |
| D13 | Where Optuna stores its studies | **Decided by the owner (2026-10-19):** a dedicated `optuna` schema in the app's Postgres, reached with `search_path=optuna` |
| D14 | How optuna-dashboard is served | Its own process on `127.0.0.1:8091`, started and stopped from the Pre-screen page |

Each is argued in the section it belongs to; section 9 collects the options.

---

## 3. Answers to the five questions

### Q1. Are per-item results stored?

Yes. `benchmark_result` has one row per graded item per suite run (unique on
`(suite_run_id, benchmark, item_id)`), with the outcome, `wall_ms`, the
llama.cpp `timings`, `config_id`, `system_sha`, `adapter_sha`,
`dataset_revision` and the tier. `benchmark_answer` keeps the prompt, the
answer and the reasoning. No aggregate table exists: Compare and Report
compute everything from these rows.

Two consequences for the statistics:

- **"Several samples per problem" means several suite runs.** Temperature
  is pinned to 0 and an item appears once per suite run, so repeated
  samples come from re-running the same configuration. That repetition
  measures run-to-run nondeterminism in the server, not sampling at a
  temperature. The estimators average within each problem first either way.
- **Cluster membership is not on the row.** DS-1000's origin problem and
  LiveCodeBench's contest exist only in the dataset files. PR 4 adds a
  `cluster` column, written at result time from an adapter field, so the
  Report keeps reading only the database and never depends on a dataset
  file being present or unchanged.

### Q2. How are datasets identified and versioned?

The task's premise needs one correction. The sha-of-bytes scheme under
`benchmarks/data/` identifies **system prompts** (`system_sha`, the first 12
hex digits of the SHA-1 of the prompt file). Datasets work differently:

- They are **fetched, not vendored** (the documented decision in
  `evaluation/datasets.py` and the benchmarks guide), into
  `<DATA_DIR>/benchmarks/datasets/<id>/`: `items.jsonl` plus
  `MANIFEST.json`, which records the upstream `revision` and the
  `content_sha256` of the downloaded bytes.
- `benchmark_result.dataset_revision` stores the `revision` when the host
  reports one and the content sha otherwise. HumanEval and MBPP are fetched
  from the `master` branch, so the content behind a fetch is not fixed. The
  recorded commit sha is what pins it.
- Separately, `adapter_sha` (SHA-1 over the adapter's `prompt_template`,
  `[item]`, `[filter]` and `[check]`) identifies how this repo wraps the
  items.
- `HF_HUB_OFFLINE=1` does not affect this fetcher. It uses plain `urllib`,
  not `huggingface_hub`. Offline robustness is still a good reason to
  vendor, but the flag is not what blocks a fetch.

**Extension (D2).** Vendored files go under
`benchmarks/data/datasets/<id>/<file>`, and each adapter gets a `[source]`
block naming the release, the upstream URL and the file's SHA-256. The
loader hashes the file on every read and refuses a mismatch. The result's
`dataset_revision` becomes `<release>@<sha256[:12]>` (for example
`v0.1.10@272720b90ac3`). LiveCodeBench keeps a fetch, pinned to a Hugging
Face commit and to each file's LFS SHA-256, and verified after download.
Vendoring reverses a recorded decision, so it gets its own decisions-log
entry.

### Q3. How does the sandbox work, and can it run both test formats?

`grading.run_program()` writes the program to a temporary directory and runs
it with the grading interpreter (`-I`, plus `-S` when the adapter says
`isolated`), with `subprocess.run(..., timeout=adapter.check.timeout)`. The
outcome comes from the exit status alone, with `AssertionError` in stderr
meaning `fail_assert`. The benchmarks guide already describes this as
"process isolation, not a sandbox", and it is.

What it can and cannot do today:

- **Function-call tests: yes**, as asserts appended to the program
  (HumanEval's `check()`, MBPP's `test_list`, DS-1000's
  `test_execution`).
- **stdin/stdout tests: no.** It has no way to feed input or compare
  output. Stdin is also inherited from the backend (#126).
- **Known defects, already filed:** an answer that exits 0 before the tests
  run is scored as a pass, and a `__main__` block that reads stdin fails
  (#126). A timeout kills only the direct child (#142). Grading blocks the
  event loop (#140).

All three must be fixed before new harnesses are built on this code. The
new harnesses use the fixed pattern: a per-run nonce printed only after
every check passes, model code run under a non-`__main__` name, stdin from
`/dev/null` for function-call tests, a process group killed on timeout, and
grading run off the event loop. Hardening the process environment and
resource limits is out of scope for this plan; this plan reuses whatever
the security batch (B0) lands for that.

### Q4. How is passes per minute computed?

In `analysis/compare.py`, `Group.passes_per_minute()` is
`passed / (sum of wall_ms over graded results / 60000)`. `wall_ms` is
measured in `runner.ask()` with `time.monotonic()` around the HTTP request,
from sending to the end of the stream. So it includes prefill, reasoning and
generation, and it excludes grading time, the gaps between items, and
skipped items. Results from every suite run in a group are pooled. The
statistic is a ratio of two sums, which is why it needs the delta method
(D8).

### Q5. Does the launcher control llama.cpp's automatic fit?

The launcher does not pass `-fit`. This was checked against llama.cpp
source at the recorded build `95b8e33e1`:

- `common_params.fit_params` defaults to `true`, and `-fit/--fit [on|off]`
  exists.
- Fitting adjusts only parameters the user left unset. The launcher always
  passes `-c` and `-ngl`. With `-c` set, the context is left alone ("context
  size set by user -> no change"). With `-ngl` set, fitting stops at
  `n_gpu_layers already set by user ..., abort`, which `common_fit_params`
  catches and logs as a warning. `--n-cpu-moe` and `-ot` would stop it the
  same way, at the tensor-override check.
- **So today it cannot change a profile's configuration silently.** It
  still costs a memory-measurement pass at every start. It is also fragile:
  a profile that ever leaves `-ngl` unset, or a llama.cpp change to what
  counts as "set", would let fitting rewrite the offload without the
  fingerprint noticing.

`llama-bench` has its own `-fitt/--fit-target` flag, which is off by default
(`fit_target = 0`). Pre-screen numbers are therefore never auto-fitted.

**Recommendation (D10):** pass `-fit off` unconditionally and add a
`fit: off` line to the fingerprint in the same PR as #127, which already
changes every `config_id` once and needs a `benchmark_schema_note`. One
discontinuity is better than two.

---

## 4. What the data actually looks like

Downloaded into a scratch directory and parsed with `python -I`; nothing was
executed.

### 4.1 HumanEval+ and MBPP+

- Releases: `evalplus/humanevalplus_release` **v0.1.10**
  (`HumanEvalPlus.jsonl.gz`, 925,932 bytes, SHA-256
  `272720b90ac375502c8ed23cd791c2a93dfb22a911641a494da74a426c09f101`) and
  `evalplus/mbppplus_release` **v0.2.0** (`MbppPlus.jsonl.gz`, 336,032
  bytes, SHA-256
  `af43697e8791c4c149bdfd6b489d8b5412507551ac20e28a439f650b8225db63`).
  These are the newest releases of each. Both files are under the
  `check-added-large-files` hook's 1024 KB limit.
- 164 and 378 tasks. Fields: `task_id`, `prompt`, `entry_point`,
  `canonical_solution`, `contract`, `base_input`, `plus_input`, `atol`,
  plus `test` (HumanEval+) or `assertion` (MBPP+).
- **The files contain inputs, not expected outputs.** EvalPlus gets each
  expected output by running `canonical_solution` on the input. HumanEval+
  has 122,683 extra inputs (median 972 per task); MBPP+ has 39,841 (median
  105).
- **Inputs are JSON, so tuples arrive as lists.** EvalPlus converts them
  back with `mbpp_deserialize_inputs`, special cases for about 20 MBPP+
  tasks (Mbpp/2's contract asserts `isinstance(test_tup1, tuple)`). Scoring
  without that function would fail correct answers.
- **Comparison is not plain `==`.** EvalPlus (`evalplus/eval/__init__.py`,
  v0.3.1) uses exact match or `np.allclose(out, exp, rtol=1e-07,
  atol=atol)`, with `atol` forced to 1e-6 for float outputs. It also has
  special oracles: set equality, not-None, `are_equivalent`, `sum_div`,
  `surface_Area`, Mbpp/558, and HumanEval/32's `find_zero`, checked through
  `_poly`.
- **Time limits:** each input gets `max(1.0 s, 4 x the reference's time on
  this machine)`, and each task is capped at `min(60, sum) + 1` seconds.
- License: Apache-2.0 (EvalPlus), over HumanEval (MIT) and MBPP
  (CC-BY-4.0) problems.

### 4.2 DS-1000

- `xlangai/DS-1000` at revision `4416080ac5cb80bdf7576aefb8f9a0b4d5426a44`,
  one `test.jsonl` (3,439,876 bytes; 407 KB gzipped), CC-BY-SA-4.0.
- `metadata`: `problem_id`, `library`, `library_problem_id`,
  `perturbation_type`, `perturbation_origin_id`, `test_case_cnt`.
- In the Pandas/Numpy filter there are 511 problems: 195 `Origin` and 316
  perturbations of them. `perturbation_origin_id` is numbered per library,
  so the cluster key is `(library, perturbation_origin_id)`: **195
  clusters**, sized 1 to 6. Clustering by `library` gives **2**.

### 4.3 LiveCodeBench

- `livecodebench/code_generation_lite`, latest commit
  `0fe84c3912ea0c4d4a78037083943e8f0c4dd505` (2025-06-05). The release
  files are cumulative increments: `test.jsonl` (v1) through
  `test6.jsonl`, with **4.5 GB in total** (`test.jsonl` alone is 1.25 GB;
  `test6.jsonl` is 134 MB). The LFS SHA-256 of `test6.jsonl`,
  `bb4c364f71921c4495a6ad15abe1a927350b720009f4933e2e71f8af0f6fd1f5`, was
  confirmed against a download made at the pinned commit.
- `release_v6` covers problems from May 2023 to April 2025 (1055 problems).
  The v6 increment has 175 problems dated 2025-01-04 to 2025-04-06: 112
  AtCoder and 63 LeetCode, in 40 contests of 2 to 7 problems each.
- Fields: `question_title`, `question_content`, `platform`, `question_id`,
  `contest_id`, `contest_date` (ISO datetime), `starter_code`,
  `difficulty`, `public_test_cases` (a JSON string), `private_test_cases`,
  and `metadata` (a JSON string; `{"func_name": ...}` for LeetCode).
- **Two test formats, both checked in the data.** AtCoder tests are all
  `testtype: "stdin"`, with whole-input and expected-output strings.
  LeetCode tests are all `testtype: "functional"`: `input` is one JSON
  value per line, one line per argument, `output` is one JSON value, and
  `starter_code` is a `class Solution` stub with `func_name` in the
  metadata.
- **Hidden tests are `base64(zlib(pickle(str)))`**, and the str is JSON.
  They decoded with an unpickler that refuses every global, so no code ran.
  Up to 40 private tests per problem.
- **No reference solutions**, so selfcheck cannot calibrate this harness.
- **Grading semantics** (`lcb_runner/evaluation/testing_util.py`): 6 s per
  test by default, a global timeout of `(6 + 1) x n_tests + 5`. Stdin
  output is compared as stripped lines, with tokens compared as `Decimal`
  when every token parses as a number.
- **License is ambiguous.** The Hugging Face card says `license: cc` with
  no variant. The loader script and the GitHub repository say MIT. The
  problem statements come from LeetCode, AtCoder and Codeforces. This repo
  is public, so the data is fetched by the user and never redistributed.

---

## 5. Cross-cutting design

### 5.1 New columns, all in new Alembic revisions

| Revision (PR) | Change | Why |
|---|---|---|
| PR 4 | `benchmark_result.cluster TEXT NULL` | Cluster-robust errors from the database alone. NULL means the problem is independent |
| PR 2 | `benchmark_result.item_window TEXT NULL` | The release-date window a windowed item was drawn under (`YYYY-MM-DD..YYYY-MM-DD`, or `YYYY-MM-DD..` with no maximum). NULL for unwindowed benchmarks |
| PR 3 | `benchmark_prescreen_sweep`, `benchmark_prescreen_point` | Pre-screen results, kept apart from serving runs |
| PR 3 | `CREATE SCHEMA IF NOT EXISTS optuna` (no tables) | Optuna's study storage (D13). Optuna creates and migrates the tables inside it |
| B3 (with #127) | none (fingerprint text only) | `model`, `extra` and `fit` lines |

Each revision that changes what rows mean adds its
`benchmark_schema_note` row in the same revision, as the
`5a1f0c3e9b27` migration does. The database holds no benchmark data
(owner, 2026-10-19), so nothing is backfilled.

### 5.2 Comparison key

Compare groups by `(model, config_id, tier, system_sha, adapter_sha)`. This
plan adds `item_window` to that key, and introduces a **block**: the set of
groups that answered the same question and can be compared against each
other.

`(tier, benchmark, adapter_sha, system_sha, item_window, dataset_revision)`
defines a block; the configurations `(model, config_id)` are its levels.

Pairwise statistics are computed only within a block, which also fixes
#132, where rows were ranked across tiers.

### 5.3 Window identity (D5)

`config_id` is the fingerprint of the serving flags. It is computed before
any request, by the launcher and the recorder, from the profile alone.
Putting a request-side choice into it would break what it means. That is
exactly why `system_sha` and `adapter_sha` are separate grouping keys.

The window follows the same precedent. It is a column on the windowed
benchmark's rows, it joins the grouping key and the block key, and a
`benchmark_schema_note` records the change. Two runs with different windows
are therefore never in the same group or block, and never compared as
equivalent.

`BenchmarkResults.latest_suite_run` (resume) currently matches only
`(model, tier)`. It gains `item_window` and the system prompt, so a resume
cannot continue a run under a different window.

The alternative, a new `benchmark_suite_run` table holding every run-level
parameter, is cleaner but larger than this task needs. It is recorded as an
option, not recommended.

---

## 6. Order of work (D0, D1)

| Audit batch | Issues | Touches | Proposed placement |
|---|---|---|---|
| B0 security | private advisories | various | Before everything, per the owner's 2026-10-19 decision, **unless the owner says otherwise (D0)** |
| B4 Compare/Report | #128 #129 #130 #131 #132 #133 | compare.py, report.py, ComparePage | **Folded into PR 4**, one commit per issue. #132 and #133 are superseded by the block design and the new power check, #128 by headlines derived from the tests; #129, #130 and #131 are contract bugs in the same files |
| B1 grading | #126 #140 #142 | grading/__init__.py, runner.py | **Its own PR, before PR 1.** The new harnesses build on the sentinel, process-group and off-loop pattern, and DS-1000 needs the fixes too |
| B2 fetch/selfcheck | #141 | tests router, TestsPage | **Its own PR, after B1, before PR 1.** Selfcheck calibrates EvalPlus; fetch is how LiveCodeBench arrives |
| B3 fingerprint | #127 | fingerprint.py, stats.py | **Its own PR, before any re-measurement**, with `-fit off` (D10) |

Proposed sequence, stacked one on another (`--base` on the previous branch,
never rebased, per the repo's practice):

1. **PR 4: statistics**, with B4 folded in. It reads only the database and
   does not depend on B1-B3.
2. **B1, B2, B3** as three bug-batch PRs, each with its own acceptance
   criteria from `docs/audit/FIX_PLAN.md`.
3. **PR 1: HumanEval+ / MBPP+.**
4. **PR 2: LiveCodeBench.**
5. **PR 3: pre-screen.** It is independent of 1 and 2 and could move
   earlier, but the order the owner asked for is kept.

The owner's 4, 1, 2, 3 order is kept. The audit batches slot in where the
upgrades depend on them. If the owner prefers, B1 can fold into PR 1 and B2
into PR 1/2 instead, at the cost of larger PRs that close bug issues as a
side effect.

---

## 7. The upgrades

### 7.1 PR 4: statistics in Compare and Report

**New module** `analysis/estimators.py` holds pure functions on plain
arrays, with no database access. Compare and Report both call it, so the
two pages cannot disagree.

| Estimator | Definition | Library |
|---|---|---|
| Problem scores | Mean outcome per problem over its samples (suite runs), with the sample count and cluster carried along | numpy |
| Mean and SE, independent | `s / sqrt(n)` over problem scores, with `s` computed using n-1 | numpy |
| Mean and SE, clustered | Cluster-robust (CR1, the statsmodels default, `G/(G-1)` correction) from an intercept-only OLS with `cov_type='cluster'` | statsmodels |
| Pass-rate interval (D6) | Wilson at an effective n, `n_eff = p(1-p)/SE^2` (Kish/Korn-Graubard). It reduces to plain Wilson for single-sample unclustered data and stays inside [0, 1] | statsmodels `proportion_confint(method='wilson')` |
| Paired difference | Over problems shared by both configurations: mean of `d_i = a_i - b_i`, SE (clustered when the block has clusters), t interval on n-1 or G-1 df, and Pearson r of the per-problem scores | numpy, scipy `pearsonr`, statsmodels |
| Test | **Exact McNemar** when every shared problem has one sample and the benchmark is unclustered; otherwise a paired t (Wald) test on `d` with the matching SE | statsmodels `mcnemar(exact=True)`; scipy `t` |
| Multiplicity | Holm across every pairwise test actually run in the block | statsmodels `multipletests(method='holm')` |
| Groups (D7) | Compact letter display (Piepho 2004, insert-and-absorb) over the Holm-significant pairs. Configurations that share a letter are not distinguishable | written here (no library provides it), tested on hand-worked cases |
| Passes per minute (D8) | `R = sum(p_i) / sum(w_i)` over problems; delta-method variance from the residuals `p_i - R w_i`, summed within clusters, with CR1 correction; interval on the log scale, so it stays positive | numpy, scipy `norm` |
| Power check | Minimum detectable difference per pair, `(z_{1-a*/2} + z_{0.80}) x SE_d`, at the nominal alpha and at the Holm worst case `a* = a/m` | scipy `norm` |

**Edge cases, defined up front:**

| Case | Behaviour |
|---|---|
| All pass or all fail | SE is 0, so `n_eff` is undefined. Fall back to Wilson with `n` problems (unclustered) or `G` clusters (clustered). Example: 8/8 gives [0.676, 1] |
| A single problem | The point estimate is shown. SE and the test are "not estimable (1 problem)"; the interval is Wilson at n = 1 for a binary score |
| One cluster | Clustered SE "not estimable (1 cluster)", with no silent fallback to independent errors. Fewer than 20 clusters gets a "few clusters: SE unreliable" warning |
| No shared problems | The pair is "n/a (no shared problems)" and is left out of the Holm family. `m` counts only the tests that ran |
| A constant per-problem score in either configuration | Pearson r is "n/a" |
| No discordant problems | McNemar p = 1. The MDE comes from SE_d = 0, so it is reported as "variance not observable" rather than 0 |

**Compare API (`GET /api/v1/benchmarks/compare?by=config`), additive
except where noted:**

- Each row gains `block` (key string), `item_window`, `n_problems`,
  `n_samples`, `n_clusters` (null when independent), `se_kind`
  (`iid`|`cluster`), `pass_rate_se`, `pass_rate_ci` (`[lo, hi]`),
  `passes_per_minute_ci`, and `group` (letters).
- The response gains `blocks`: `[{key, tier, benchmark, adapter, system,
  item_window, dataset_revision, levels, letters, holm_m, pairs: [{a, b,
  n_shared, mean_diff, se, ci, corr, test, statistic, p, p_holm,
  significant, mde, mde_holm, underpowered}]}]`.
- **Changed:** rows are ordered within blocks, not globally (#132).
  `vs_baseline` is computed against the baseline's group in the same
  block. `by=serving` returns `{rows, derived, notes}` (#129), and
  `by=benchmark` returns flat per-benchmark columns (#130). The frontend
  changes in the same PR.

**Compare page:** a table per block, with the block's tier, benchmark,
system prompt and window in a header above it; pass rate as
`passed/attempted` plus `rate [lo, hi]`; group letters; and a pairwise
table under each block. The "never a bare percentage" rule still holds.

**Report:** a new "Configuration comparison" section per block, using the
same estimators: a rates table with intervals, the pairwise table with
Holm, the letter groups, and passes per minute with its interval. The
interval method is named in the text ("delta method, clustered by
<variable>"). The existing system-prompt ablation sections (Cochran's Q, the
permutation p) stay for blocks with several system levels. Two other
changes:

- The power section is replaced by the per-pair MDE at the per-block n and
  the Holm-corrected alpha (#133), with a sentence per comparison: "n = 24
  shared problems, SD of the paired difference 0.41: differences under 23
  pp are undetectable at 80% power and alpha 0.05 (more after Holm); this
  comparison is underpowered."
- The headline is derived from the tests (#128).

The provenance section lists every window present. `POST /report` gains
`windows: string[]` in its response so the page can show them in its
header; the form is unchanged.

**Dependency:** `uv add statsmodels` (0.15.0; requires numpy <3, scipy and
pandas, all already present, plus patsy and formulaic).

**Clusters:** the ds1000 adapter's `[item]` gains
`cluster_fields = ["metadata.library", "metadata.perturbation_origin_id"]`.
`runner.run_item` writes the joined value to `benchmark_result.cluster`.
`[item]` is fingerprinted, so ds1000's `adapter_sha` changes once (there is
no data, so this is harmless).

**Tests:**

- `tests/test_estimators.py`. Every estimator is checked against values
  worked by hand in the test file, from the formula, never by calling the
  same library again. Examples:
  - Wilson for 7/8 and 8/8;
  - a 6-problem, 3-cluster CR1 SE written out as
    `sqrt(G/(G-1) * sum_c (sum_i e_i)^2) / n`;
  - McNemar on b=5, c=1 (p = 0.21875 by binomial arithmetic);
  - Holm on `[0.01, 0.04, 0.03]`;
  - the delta-method ratio SE on four problems;
  - a 3-configuration letter display.
- An independent bootstrap oracle (`scipy.stats.bootstrap`, fixed seed,
  wide tolerance) cross-checks the ratio interval.
- The edge cases above, one test each.
- `tests/test_compare.py` (new): block partitioning, the per-block baseline,
  the window and cluster in the key, and the response shape for each `by`.
- Report: the headline wording follows the statistics (#128 acceptance),
  and the MDE uses the per-block n and the corrected alpha (#133).
- Vitest for the new Compare rendering helpers; Playwright with mocks
  updated to the real response shape; a real-backend run of every `by` and
  of `POST /report` against seeded rows (section 8).

**Docs:**

- the benchmarks guide's Compare and Report sections;
- a decisions entry ("statistical methods");
- the roadmap milestone;
- MAP.md for `estimators.py`;
- the telemetry guide's table list (the `cluster` column).

### 7.2 PR 1: HumanEval+ and MBPP+

**`evalplus` as a dependency, or vendor the data and score it here?**
Recommendation: vendor and score here.

- `evalplus` 0.3.1 depends on `openai`, `anthropic`,
  `google-generativeai`, `transformers`, `datasets`, `wget` and
  `tree-sitter`, a large dependency surface for a scoring loop. It has had
  no release since 2024-10.
- Its evaluator runs candidates in `multiprocessing` children of the
  calling process. In this app the caller is the uvicorn worker, which is
  exactly the in-process execution the grading design avoids.
- What is needed from it is small and can be ported with attribution: the
  MBPP+ input deserializer, the comparison (`is_floats`, the atol rule,
  allclose), the special oracles and `_poly`, the time-limit formula, and
  the chat prompt wording. Apache-2.0 allows this with a NOTICE entry.
- The cost is fidelity risk, which selfcheck checks directly. EvalPlus's
  own canonical solutions must all pass, and a set of known-wrong fixture
  answers must all fail.

**Data (D2):**

- `data/datasets/humanevalplus/HumanEvalPlus-v0.1.10.jsonl.gz`,
  `data/datasets/mbppplus/MbppPlus-v0.2.0.jsonl.gz` and
  `data/datasets/ds1000/DS-1000-4416080a.jsonl.gz` (DS-1000 re-serialized
  from the pinned revision's `test.jsonl` and gzipped; its SHA-256 is
  pinned).
- Each adapter's `[fetch]` becomes `[source]`
  `{kind = "vendored", release, url, path, sha256}`.
- `read_items()` verifies the hash. The fetch kinds `github_raw` and
  `hf_rows` are deleted, since nothing uses them any more.

**Harness** `grading/evalplus.py`, one module for both datasets, built on
B1's runner:

- One program runs the candidate and, separately, the canonical solution.
  The candidate is loaded into its own namespace with
  `__name__ = 'solution'`, and stdin is `/dev/null`.
- Each input is deserialized (the MBPP+ rules) and deep-copied. The program
  times the reference and computes the expected output, then runs the
  candidate under `signal.setitimer` at `max(1.0, factor x ref_time)`
  seconds and compares with the EvalPlus semantics.
- It stops at the first failure, and prints the per-run nonce only after
  every input passes.
- Base inputs run first. The outcome is the plus outcome (base and plus
  together), and a failure says in `reason` whether it came on a base or a
  plus input.
- **Expected outputs are computed live, inside the grading run**, not
  cached. Reference timing is then measured in the same process and under
  the same load as the candidate, and nothing has to be stored, versioned
  or invalidated. The cost is running the reference once per graded item;
  EvalPlus's references are fast. (Option: precompute and cache at
  selfcheck, as EvalPlus does. Rejected: it needs a serialization format
  for tuples, sets and floats, and a staleness rule.)
- `np.allclose` is reimplemented elementwise with numpy's own formula
  (`|a - b| <= atol + rtol |b|`), so the harness can keep `-S`. It is
  tested against `numpy.allclose` on fixtures.

**Timeout policy**, written into the benchmarks guide:

- Per input: `max(1.0 s, 4 x reference time)`, the EvalPlus defaults
  (`DEFAULT_MIN_TIME_LIMIT`, `DEFAULT_GT_TIME_LIMIT_FACTOR`).
- Per item: a subprocess cap of `min(cap, sum of per-input limits) + 5 s`
  for start-up. `cap` defaults to **120 s**, not EvalPlus's 60, because the
  reference now runs in the same budget and this laptop is slower than
  EvalPlus's machines.
- Factor, floor and cap live in the adapter's `[check]`, so changing them
  changes `adapter_sha`.
- `fail_timeout` reasons name the input index, its limit and the reference
  time, or the cap.

**Prompts:** EvalPlus's own chat instruction (from
`evalplus/provider/utility.py` at v0.3.1, quoted verbatim and checked at
implementation) wraps the `prompt` field. MBPP+ prompts carry one example
assert in the docstring, as EvalPlus intends. The current MBPP adapter's
three-assert template goes away with the adapter.

**Removed** ("Prune what is no longer true"):

- `humaneval.toml`, `mbpp.toml`, `grading/humaneval.py`, `grading/mbpp.py`,
  their registry entries and tests;
- the suites' `humaneval`/`mbpp` entries, which are replaced;
- the `ds1000`-only `missing_libraries` table is kept;
- the e2e mocks that name `humaneval/...` ids.

The llama-cpp guide's 2026-08 measurement sections cite HumanEval items as
history, and stay as recorded history.

**Tiers:** `smoke` keeps 8 per benchmark. `standard` is 100 HumanEval+,
100 MBPP+ and 100 DS-1000. `full` is 164 + 378 + 511, less the calibration
exclusions. The suite comments and the guide's tier table are updated.

**Tests:**

- dataset load and sha verification, plus a tampered-file refusal;
- the MBPP+ deserializer against EvalPlus's expectations for every
  special-cased task;
- every special oracle;
- the allclose port against numpy;
- a correct solution passes;
- wrong answers fail on a base input and on a plus input;
- `sys.exit(0)` and `unittest.main()` before the tests do not pass (#126);
- a slow-but-correct solution passes under the factor;
- an infinite loop is `fail_timeout` and its process group is gone;
- a selfcheck run over a sample of real canonical solutions;
- calibration staleness on a hash change.

**NOTICE:** a new "Benchmark data and evaluation code" section:

- EvalPlus (Apache-2.0, with copyright and source) for the vendored files
  and the ported functions;
- HumanEval (MIT) and MBPP (CC-BY-4.0) as underlying sources;
- DS-1000 (CC-BY-SA-4.0) for its vendored file.

**Docs:**

- the benchmarks guide (the benchmarks table, grading, timeouts, the
  vendored layout);
- a decisions entry ("dataset swap; vendoring reverses the fetched-not-
  vendored decision");
- the roadmap;
- MAP.md (`data/datasets/`, `grading/evalplus.py`).

### 7.3 PR 2: LiveCodeBench

**Fetch:**

- A new kind, `hf_lfs_files`, pinned in `livecodebench.toml`: the commit
  `0fe84c39...` and, for each increment file, its LFS SHA-256 and its date
  range.
- The Tests page's fetch action (from B2) lets the user choose increments
  and shows each one's size. It streams progress, runs off the event loop,
  and writes atomically, to a temporary directory that is then renamed.
- After the hash check, each file is decoded **once**:
  - `items.jsonl` gets the problem metadata, the prompt fields and the
    public tests;
  - `tests/<platform>/<question_id>.json.gz` gets the decoded private
    tests;
  - the raw file is deleted.
- Decoding uses an unpickler whose `find_class` refuses every global.
  Nothing is ever unpickled at grade time.
- The manifest records the increments present and their date coverage.

**Items:**

- id `<platform>/<question_id>`;
- cluster `(platform, contest_id)` (D4);
- `contest_date` truncated to a date for windowing.

**Window:**

- `TestsRunForm` gains `window_min: date | null` and
  `window_max: date | null`. `window_min` is required when the run includes
  a windowed benchmark and refused otherwise.
- The pool is the problems with `window_min <= contest_date <= window_max`
  (inclusive).
- A window that is not covered by the fetched increments is refused, naming
  the increment to fetch. An empty pool is refused.
- A pool smaller than the tier's `n` uses every problem and says so in the
  `start` event.
- The window string is recorded in `benchmark_result.item_window` and in
  the SSE `start` event.
- `GET /tests/options` gains, per benchmark, `windowed` and the fetched
  `date_range`.
- No training cutoffs are stored or suggested anywhere.

**Harness** `grading/livecodebench.py`, two modes, following LiveCodeBench's
`testing_util.py` semantics:

- **Functional (LeetCode).**
  - One program holds LiveCodeBench's import header and the candidate in a
    `solution` namespace.
  - For each test it parses the input lines as JSON arguments and calls
    `Solution().<func_name>(*args)` under a 6 s timer.
  - It compares against the JSON output, with tuples converted to lists as
    LiveCodeBench does, and prints the nonce on success.
  - Stdin is `/dev/null`.
- **Stdin (AtCoder).**
  - The parent runs the candidate as `__main__` (it must be, since it reads
    stdin) once per test, with the input piped in and a 6 s timeout.
  - It compares stripped lines, with `Decimal` comparison when every token
    is numeric.
  - A non-zero exit is `fail_error`.
  - The verdict comes from the comparison in the parent, never from the
    exit code, so #126's early-exit problem cannot occur.
- **Timeouts:** 6 s per test, and a total cap of
  `(6 + 1) x n_tests + 5` per item, as LiveCodeBench does. These are
  absolute, since there is no reference to scale against. Both are in
  `[check]`.

**Prompt:** LiveCodeBench's own code-generation instructions, the variants
with and without starter code from `lcb_runner/prompts/code_generation.py`
at the pinned GitHub commit, quoted verbatim. Its system message goes into
the user turn, because the system slot belongs to the system-prompt
ablation.

**Validation without references:**

- hand-written fixture problems in each format, with correct, wrong,
  wrong-format, crash and timeout solutions;
- the decoder against a recorded fixture string, and a payload that tries
  to load a global, which must be refused;
- window parsing, coverage and an empty pool;
- resume refusing a window mismatch;
- Compare keeping two windows apart.

Calibration reports "not calibratable (no reference solutions)" rather
than claiming 100%.

**UI:**

- Tests: date inputs shown when a windowed benchmark is selected, and a
  window chip on the running stream.
- Compare: the window in each block header.
- Report: the windows in the page header and in provenance.

**NOTICE:**

- LiveCodeBench (MIT, for the evaluation semantics ported from
  `lcb_runner`);
- the dataset's license as published: card `cc`, loader `MIT`; problems
  from LeetCode, AtCoder and Codeforces;
- the data is fetched by the user and not redistributed.

**Docs:**

- the benchmarks guide (the LiveCodeBench section, the window, the
  contamination note that the newest problem is 2025-04-06);
- README "Pages and URLs" if the Tests page gains query parameters (not
  planned);
- a decisions entry;
- the roadmap;
- MAP.md.

### 7.4 PR 3: llama-bench pre-screen

**New subpackage** `benchmarks/prescreen/`:

- `grid.py` reads `data/prescreen/<profile>.toml`. These are new files:
  Tune's grids include knobs llama-bench cannot measure (speculation,
  reasoning, context). Dimensions are at least `ngl`, `moe`, `batch` and
  `ubatch`; optional are `threads`, `cache_k/v` and `fa`. Constraints use
  Tune's syntax, for example `ubatch <= batch`.
- `bench.py` builds the argv, runs one point and parses JSONL.
- `sweep.py` is the async orchestrator, and `study.py` wraps Optuna
  (samplers, constraints, and the `optuna`-schema storage, D13).
- `dashboard.py` is the optuna-dashboard entry point (D14).
- `nvidia-smi` sampling reuses `telemetry_recorder.sample_gpu()`, moved to
  a shared helper. The recorder itself waits for a port and scrapes
  `/metrics`, and llama-bench has neither.

**Process lifecycle**, following `ServeProcess` and Tune's probe:

- **One `llama-bench` process per grid point.** On a failed load or context
  creation, llama-bench returns 1 and abandons every remaining point. The
  guide also records allocations retained across reloads under WSL2.
- `start_new_session=True`. A wall-clock timeout per point. On cancel,
  timeout or backend shutdown, SIGTERM then SIGKILL to the process group,
  from a lifespan hook.
- The sweep row records the backend's pid, and a stale sweep is closed on
  start-up, as stale runs are.
- A pre-screen refuses to start while a serving process, a Tune sweep or a
  test run is active, and vice versa, since they share one GPU.
- **OOM is a recorded outcome:**
  - stderr matching `tune_probe.OOM_PATTERN` gives `oom`;
  - `failed to load model` or `failed to create context` without it gives
    `load_error`;
  - a signal gives `crash`;
  - a timeout gives `timeout`;
  - unparseable output gives `parse_error`.
- **Monotone pruning.** At a given batch and ubatch, if `ngl = N` hits OOM,
  every larger `ngl` is recorded as `pruned (oom at ngl N)` without
  running. The same holds for every smaller `moe`. Under `GridSampler` the
  points are ordered so that pruning applies. Under TPE, each proposal is
  checked against the known OOM boundaries before it runs.

**Command:**

```
llama-bench -m <model> -ngl N [-ncmoe M] -b B -ub U -t T -ctk K -ctv V -fa on [-ot ...] -p 512 -n 128 -r 5 -o jsonl
```

The fixed flags come from the resolved profile, so a point maps onto a
serving configuration. `-p`, `-n` and `-r` are sweep settings, recorded.

**Stored** (numbers carry their context):

- **Sweep:** profile and profile version, sampler, seed, trial budget,
  objective, Optuna study name, model file basename and size,
  llama.cpp `build_commit` and `build_number` (from the JSON), `gpu_info`,
  `cpu_info`, driver version, VRAM and RAM totals and kernel (probed),
  grid path and sha, `n_prompt`/`n_gen`/`reps`, start and end, status.
- **Point:** the flags, the status and reason, `avg_ts`/`stddev_ts` and
  `samples_ts` for pp and tg, the raw JSONL, the peak VRAM, power and
  temperature and the throttle reasons seen during the point, start and
  end. Also the `config_id` the point would have if served with these
  overrides, from `resolve()` and `config_id()`, so a candidate can be
  matched to a later Tests run.

**VRAM at context (D11):** llama-bench sizes its context to the test
(`n_prompt + n_gen + n_depth`), so a point can pass here and still OOM at a
profile's 64K context in `llama-server`. After the grid, the top N
candidates (default 3) get a load check: start `ServeProcess`
(`record_telemetry=False`), wait for `/health`, record free VRAM, stop. A
failure is recorded on the point as `oom_at_ctx`.

**Optuna (D9, decided by the owner on 2026-10-19).** Every pre-screen is an
Optuna study, driven through the ask-and-tell interface from the async
orchestrator. Optuna's calls are blocking, so they run in a worker thread.

- **Dependencies:** `uv add optuna optuna-dashboard` (5.0.0 and 0.21.0,
  both MIT, pure Python). They bring in `bottle`, `colorlog` and `tqdm`.
  Optuna's `alembic` and `sqlalchemy` requirements are lower bounds that
  the app's pins already satisfy.
- **Samplers:**
  - `grid`: `GridSampler`, every point once. This is the default when the
    grid has at most 120 points.
  - `tpe`: `TPESampler(multivariate=True, seed=...)` with a trial budget,
    for larger grids.
  - The sampler, the seed and the budget are recorded on the sweep row.
- **Objective:**
  - `tg` (generation t/s, the default, since generation dominates
    wall-clock time on this hardware);
  - `pp` (prompt processing);
  - `both`: multi-objective, so the dashboard shows the Pareto front.
  - The value is the mean of llama-bench's `-r 5` repetitions; the standard
    deviation is stored beside it.
- **The baseline goes first.** The profile's current flags are enqueued as
  trial 0 (`enqueue_trial`), so every study measures the configuration it
  is trying to beat.
- **OOM teaches the sampler.** TPE leaves out `FAIL` trials when it models
  the space, so it would keep proposing configurations that run out of
  memory. An OOM trial is therefore completed with throughput 0 and a
  violated constraint (`constraints_func`), which is how Optuna learns
  feasibility. The same goes for points skipped by monotone pruning, which
  are recorded with `pruned_by` naming the OOM that implied them, and
  `ubatch > batch` proposals, which are never run.
- **Countering noise:** in the recorded thread sweep, prompt processing had
  a standard deviation of 12-22% of its mean between reps. TPE picks its
  next points from the best-scoring trials so far, and a lucky run can
  mislead it. After the search, the top 3 trials are measured again in
  fresh processes, and the candidate list ranks by the mean of both
  measurements. Both measurements are stored.
- **Optuna's storage is not the record (D13, decided by the owner on
  2026-10-19: a dedicated `optuna` schema).** The `benchmark_prescreen_*`
  tables stay the source of truth, with every number carrying its context;
  points gain `optuna_trial_number`. The studies live in the app's own
  Postgres, in a schema of their own.
  - **Why a separate schema:** Optuna's RDB storage creates generic tables
    (`studies`, `trials`, `version_info`, ...). Its own Alembic migrations
    use the **default `alembic_version` table**, the same one the app's
    migration history uses in `public`. Sharing `public` would corrupt one
    history or the other.
  - **Creating it:** PR 3's app Alembic revision runs
    `CREATE SCHEMA IF NOT EXISTS optuna`, and nothing else in it. Optuna
    creates and owns the tables inside. The revision's downgrade drops the
    schema with `CASCADE`, which removes only Optuna's copy of the studies.
  - **Connecting:** `local_llm.benchmarks.prescreen.study` builds one
    `optuna.storages.RDBStorage` from the backend's `DATABASE_URL`.
    - It uses the `postgresql+psycopg` driver; psycopg 3 is already a
      dependency.
    - Its `engine_kwargs` carry
      `connect_args={'options': '-c search_path=optuna'}`. With `optuna`
      the only schema on the path, every unqualified name Optuna uses,
      `alembic_version` included, resolves to `optuna.*`, and the app's
      `public` tables are invisible to it.
    - The dashboard process builds its storage with the same function and
      inherits `DATABASE_URL` from the environment, never from argv, so
      the password does not show in `ps`.
  - **Guards:**
    - The pre-screen refuses to start, saying why, if `DATABASE_URL` is not
      Postgres, or if the app's own `DATABASE_SCHEMA` is set to `optuna`.
    - Optuna's own Alembic is a second migration authority in the
      database, limited to that schema. `uv.lock` pins Optuna's version,
      so its schema changes only in a deliberate dependency bump. On first
      use after a bump, the study module compares
      `get_current_version()` with `get_head_version()`. If they differ,
      it runs `storage.upgrade()` and logs the change, rather than leaving
      Optuna to raise on its own.
    - The dependencies guide documents this. A `benchmark_schema_note`
      row records that the `optuna` schema exists and who manages it.
  - Deleting a study in the dashboard removes only Optuna's copy, never a
    measurement.

**optuna-dashboard (D14).**

- **It cannot be mounted inside the app.** Its frontend is built with
  root-absolute paths (`/api/...`, `/static/...`, `URL_PREFIX` baked in at
  webpack build time as `/dashboard`), which collide with the app's own
  `/api` and `/static`. Serving it under a sub-path would mean rebuilding
  its frontend.
- **So it runs as its own process**, `python -m
  local_llm.benchmarks.prescreen.dashboard`, a small module that calls
  `optuna_dashboard.run_server(storage, host='127.0.0.1', port=...)`.
  - The Pre-screen page starts and stops it (`POST
    /prescreen/dashboard/start`, `/stop`, `GET /prescreen/dashboard`).
  - It runs with its own process group, under the same lifecycle rules as
    `llama-server`, and is stopped at backend shutdown.
  - The page links to `http://127.0.0.1:8091/dashboard`.
  - The port is `LLLM_OPTUNA_DASHBOARD_PORT`, default 8091.
- **Always loopback.** optuna-dashboard has no authentication and can edit
  and delete studies. It binds to `127.0.0.1` even when the backend is
  started with `LLLM_BACKEND_HOST=0.0.0.0`; from another machine, reach it
  over an SSH tunnel. The page says so.
- **Docs:** the benchmarks guide's port table ("nothing new to add one
  for") gains a row, and README "Running it" mentions it.

**UI and API:**

- A new page `/benchmarks/prescreen` (D12; `routePaths`, `AppRouter`, the
  layout's tab list, README "Pages and URLs").
- Routes under `/api/v1/benchmarks/prescreen`: `GET /grids`,
  `POST /start`, `POST /cancel`, `GET /stream` (SSE),
  `GET /sweeps`, `GET /sweeps/{id}`.
- The results table is titled "Candidates, raw llama-bench throughput (not
  a serving measurement): confirm with a full Tests run". Each row shows
  the overrides to enter on the Serve page. No pre-screen number appears on
  Compare or Report.

**Fingerprint:** the pre-screen does not change what the launcher passes.
`-fit off` (D10) lands with B3.

**Tests:**

- grid expansion, constraints and pruning order;
- Optuna:
  - `GridSampler` visits every feasible point exactly once;
  - a seeded TPE run is reproducible;
  - an OOM trial is completed as infeasible, not `FAIL`;
  - trial 0 is the profile's baseline;
  - the top-3 re-measurement;
  - a cancelled sweep leaves its study readable in the dashboard;
- the `optuna` schema, against the throwaway Postgres that
  `make test-backend` provides:
  - after the app's migrations and a full Optuna study, `public` has no
    Optuna tables and `public.alembic_version` still holds the app's head;
  - `optuna.alembic_version` holds Optuna's head;
  - `alembic upgrade head` for the app still runs cleanly afterwards;
  - the version check calls `storage.upgrade()` when the versions differ
    (simulated by stamping an older Optuna revision);
  - the guards refuse a non-Postgres `DATABASE_URL` and
    `DATABASE_SCHEMA=optuna`;
- the dashboard process: it binds to 127.0.0.1 only, start and stop leave
  no process behind, and it is stopped at shutdown;
- argv building per profile shape (dense with `-ot`, MoE with `-ncmoe`);
- JSONL parsing;
- every failure classification;
- cancel and timeout killing a fake process tree;
- the guard against concurrent GPU work;
- stale-sweep closing.

**No llama.cpp build or CUDA toolkit exists on this machine** (2026-10-19:
the GPU and `nvidia-smi` are present, `nvcc` and `~/llama.cpp` are not).
The JSONL fixture is therefore built from llama-bench's field list at
`95b8e33e1` (`build_commit` ... `samples_ts`) and labelled **synthetic,
not recorded locally**. A stub `llama-bench` script, in the spirit of
Tune's `LLAMA_TUNE_LAUNCH` fault injection, drives the real subprocess
path: success, OOM text with exit 1, hang, and a signal. The PR
description carries a manual checklist for the laptop.

**Docs:**

- the llama-cpp guide: "Preflight sweeps" becomes the pre-screen page; the
  raw commands are kept as a fallback; recorded numbers carry hardware,
  model, build and flags;
- the benchmarks guide (the page);
- the telemetry guide (the tables);
- a decisions entry, which records that the owner chose Optuna and
  optuna-dashboard on 2026-10-19 over the plan's grid-only
  recommendation, and why each side was argued;
- the roadmap;
- MAP.md;
- README "Pages and URLs" and "Running it" (the dashboard's port);
- the dependencies guide (the new packages, the `optuna` schema, and the
  upgrade step on an Optuna version bump);
- the telemetry guide's table list (the `optuna` schema, marked as
  Optuna-managed).

---

## 8. Verification, for every PR

- `make check` green before the PR is opened.
- **Real backend:** Playwright mocks the API, so every changed route is
  also exercised with `make backend` against a throwaway database and data
  directory, never the owner's. Since no `llama-server` can run here, a
  small stub OpenAI-compatible server (a test fixture) answers Tests-page
  requests with canned answers: reference solutions, a wrong answer, and an
  answer that never finishes. That makes `POST /tests/run` with a window,
  `GET /compare` for each `by`, `POST /report`, and the pre-screen routes
  (against the stub `llama-bench`) real end-to-end calls. They are checked
  with curl and in the browser.
- **Statistics:** seeded rows with known answers, with the page's numbers
  checked against the hand-worked test values.
- **PR 3:** the manual checklist for the laptop in the PR description:
  - build llama.cpp at the pinned commit;
  - run a 4-point grid on `qwen25c` and `qwen38`;
  - force an OOM point;
  - cancel mid-point and confirm no `llama-bench` remains (`pgrep`);
  - run a small TPE study, open the dashboard, and check its trials match
    the Pre-screen page's table;
  - check that the stored build and hardware match `llama-bench --version`
    and `nvidia-smi`.

## 9. Design decisions with more than one option

| # | Options | Trade-offs | Recommendation |
|---|---|---|---|
| D2 | (a) vendor the small datasets, fetch LiveCodeBench; (b) fetch everything (pinned); (c) vendor everything | (a) works offline, pins bytes in git, and adds about 1.7 MB and NOTICE obligations; (b) keeps the documented decision but needs #141 for every benchmark and the network; (c) is impossible for LiveCodeBench (4.5 GB, ambiguous license) | (a) |
| D3 | (a) library; (b) `(library, perturbation_origin_id)`; (c) none | (a) is 2 clusters, so CR SEs are meaningless; (b) is 195 clusters and models the real dependence between perturbations of one question; (c) understates SEs | (b), against the brief's wording, for this reason |
| D4 | (a) platform; (b) contest | (a) is 2-3 clusters; (b) is 40 in the v6 increment alone, and contests share setters and themes | (b) |
| D5 | (a) result column in the key; (b) `config_id`; (c) suite-run table | (b) breaks what `config_id` means; (c) is cleaner but larger | (a), plus the resume fix |
| D6 | (a) Wilson at the effective n; (b) Wilson at n, ignoring clusters; (c) Clopper-Pearson; (d) logit-Wald | (a) behaves at 0 and 1 and respects clustering; (b) is too narrow with clusters; (c) is exact only for iid binomial and conservative; (d) degenerates at 0 and 1 | (a) |
| D7 | (a) compact letter display; (b) "indistinguishable from the best" set; (c) strict ranking | (a) handles non-transitive results; (b) is simpler but says nothing below the top; (c) is what the brief rules out | (a) |
| D8 | (a) delta method; (b) cluster bootstrap over problems | (a) is deterministic, cheap and consistent with the clustered SEs; (b) has no assumptions but is random and slower | (a), with (b) as a test oracle |
| D9 | (a) full grid with pruning; (b) Optuna (grid or TPE) with optuna-dashboard | (a) has no new dependencies, and these grids are small; (b) gives one path for any grid size, a Bayesian option as grids grow, and the dashboard's plots (history, Pareto front, parameter importance) | **(b), the owner's decision of 2026-10-19.** The plan had recommended (a); the decisions entry records both |
| D13 | (a) journal file in `DATA_DIR`; (b) dedicated `optuna` Postgres schema; (c) the app's `public` schema | (a) never touches the app's database; (b) keeps one database (backed up with the rest, readable live by the dashboard) but adds a second migration authority, confined to its schema; (c) collides on `alembic_version` | **(b), the owner's decision of 2026-10-19**, with the guards and tests in 7.4 |
| D14 | (a) separate loopback process; (b) mounted in the app behind admin auth | (b) does not work: the dashboard's frontend uses root-absolute paths that collide with the app's `/api` and `/static` | (a) |
| D10 | (a) `-fit off` and fingerprint it; (b) leave it on (inert today) | (a) costs one id change, absorbed by #127; (b) is fragile | (a) |
| D11 | (a) load check for the top N; (b) none, with a caveat on screen; (c) llama-bench `-d` at full depth | (b) leaves an OOM to be found by Tests; (c) costs about 15 min of prefill per point at 64K | (a) |
| D12 | (a) new page; (b) a tab on Tune | (a) is clearer that these are not served results; (b) means fewer routes | (a) |

## 10. What this plan does not do

- No training cutoffs anywhere: the window is the user's input on each run.
- No math or statistics benchmarks (the coverage gap the benchmarks guide
  states remains).
- No sandbox hardening beyond what B1 and B0 deliver.
- No change to temperature (pinned at 0 by policy). The within-problem
  averaging handles repeated runs, whatever their source.
