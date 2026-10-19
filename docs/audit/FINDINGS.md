# Audit findings

Audited commit `7a4088b20f3aa27cf35abb07689e68b19408c003` (`main`, 2026-10-19). Line references refer to that SHA.
Each finding was verified by the auditing session itself (repro re-run, or the code path read on both sides).
Security findings are intentionally excluded from this public file and were reported privately.

| ID | Issue | Severity | Area | Status | Unit | Title |
|---|---|---|---|---|---|---|
| A-01 | #126 | Critical | benchmarks | Confirmed | U2 | Grader scores a wrong answer as pass when the model code exits 0 before the dataset tests run, and fails correct answers whose __main__ block reads stdin |
| A-02 | #127 | Critical | benchmarks | Confirmed | U1 | config_id fingerprint ignores the profile's extra args and model file, so different launches share one configuration |
| A-03 | #128 | Critical | benchmarks | Confirmed | U3 | Report headline always says no system prompt differs and that every difference is noise, whatever the statistics show |
| A-04 | #129 | High | benchmarks | Confirmed | U3/U7 | Compare "by serving" response puts the serving rows under derived_columns, and the page crashes the app |
| A-06 | #131 | High | benchmarks | Confirmed | U3 | Compare never extracts the fa flag, so a two-flag difference is reported as a clean comparison |
| A-09 | #134 | High | benchmarks | Confirmed | U4 | Tune sweep adopts (and refines around) a candidate that is slower than the profile defaults |
| A-15 | #140 | High | benchmarks | Confirmed | U2 | Test runs block the backend's event loop: grading and suite preparation run blocking subprocesses inside async code |
| A-16 | #141 | High | benchmarks | Confirmed | U2 | No endpoint fetches datasets, runs selfcheck or runs one item, although the guide documents all three as Tests page actions |
| A-05 | #130 | Medium | benchmarks | Confirmed | U7 | Compare "by benchmark" table is empty: per-benchmark values are nested but the page reads them top-level |
| A-07 | #132 | Medium | benchmarks | Confirmed | U3 | Compare ranks rows across tiers together and binds the baseline delta to the first matching group only |
| A-08 | #133 | Medium | benchmarks | Suspected | U3 | Report power section computes the minimum detectable effect from a pooled item count no single test uses, at an uncorrected alpha |
| A-10 | #135 | Medium | benchmarks | Confirmed | U4 | Tune elimination ranks a candidate exactly tied with the baseline below every slower candidate |
| A-11 | #136 | Medium | benchmarks | Confirmed | U4 | Tune's uncertain-cut sign test pairs mismatched items and treats n=0 as a supported cut |
| A-12 | #137 | Medium | benchmarks | Confirmed | U4 | Cooldown time accounting overwrites the running total, so max_cooldown_share is not enforced across pauses |
| A-13 | #138 | Medium | benchmarks | Suspected | U4 | Stopping a sweep during a visit's teardown or a cooldown can skip ServeProcess.stop and leave visit/pause rows running forever |
| A-17 | #142 | Medium | benchmarks | Suspected | U2 | Grading timeouts kill only the direct child; processes spawned by model code survive |
| A-20 | #145 | Medium | infra | Confirmed | U6 | make frontend ignores a failed bun install, starts the dev server anyway and never sets its cleanup trap |
| A-25 | #150 | Medium | web | Confirmed | U9 | A reply left unfinished on a non-current branch stays "generating" forever after reload |
| A-26 | #151 | Medium | web | Suspected | U9 | Stop pressed before the backend creates the task in an existing chat cancels nothing; the reply keeps streaming after the UI shows stopped |
| A-31 | #156 | Medium | benchmarks | Suspected | U1 | Telemetry recorder attaches a new run to whatever server already answers on the port |
| A-33 | #158 | Medium | web | Confirmed | U10 | Editing a calendar event cannot remove its repeat rule, description or location |
| A-34 | #159 | Medium | web | Confirmed | U10 | Automation schedule picker silently rewrites RRULEs it cannot represent and mislabels them |
| A-35 | #160 | Medium | web | Confirmed | U9 | Chat documents are not pruned to the current conversation path, so a file from a deleted message or another branch is still sent as context |
| A-14 | #139 | Low | benchmarks | Suspected | U4 | A sweep whose baseline fails to load never narrows and does not say why |
| A-18 | #143 | Low | benchmarks | Confirmed | U7/U10 | Benchmarks pages show "[object Object]" or a generic message instead of the server error, and Serve treats network failures as success |
| A-19 | #144 | Low | benchmarks | Confirmed | U10 | Tune page live-status stream can outlive the page or run twice (the L17 fix was not applied to Tune) |
| A-21 | #146 | Low | infra | Confirmed | U6 | make test-e2e does not run Playwright as CI does (workers, CI env), although the docs say it mirrors CI |
| A-22 | #147 | Low | infra | Suspected | U6 | make test-backend runs pytest even if its Postgres never became ready, and the readiness probe can pass before TCP is up |
| A-23 | #148 | Low | infra | Suspected | U6 | make backend does not wait for Postgres before the app runs migrations at import |
| A-24 | #149 | Low | docs | Confirmed | U6 | Stale documentation: pre-commit header claims ruff-check covers only part of the backend, and MAP.md omits tracked top-level files |
| A-27 | #152 | Low | benchmarks | Suspected | U5 | Concurrent archive and set-default can leave the default serving profile archived |
| A-28 | #153 | Low | benchmarks | Suspected | U5 | Concurrent profile create/clone/version edit returns 500 instead of 409 |
| A-29 | #154 | Low | backend | Suspected | U11 | Chat list endpoints turn page < 1 into a negative OFFSET and fail instead of validating |
| A-30 | #155 | Low | backend | Suspected | U11 | Streaming usage is merged on every usage-bearing chunk, double-counting when a provider repeats usage |
| A-32 | #157 | Low | web | Suspected | U10 | Flaky e2e assertion in the knowledge list search test |

## A-01: Grader scores a wrong answer as pass when the model code exits 0 before the dataset tests run, and fails correct answers whose __main__ block reads stdin

Issue: #126. Severity: Critical. Area: benchmarks. Status: Confirmed. Unit: U2.

- **Location**: [`apps/server/local_llm/benchmarks/evaluation/grading/__init__.py:140-160`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/evaluation/grading/__init__.py#L140-L160); [`apps/server/local_llm/benchmarks/evaluation/grading/mbpp.py:15-25`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/evaluation/grading/mbpp.py#L15-L25); [`apps/server/local_llm/benchmarks/evaluation/grading/humaneval.py:25-32`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/evaluation/grading/humaneval.py#L25-L32)
- **Description**: `run_program` returns PASS whenever the grading process exits 0. The harnesses place the model's code before the dataset's asserts/`check()` and run the file as `__main__`, with stdin inherited from the backend. A model answer ending in `if __name__ == "__main__": unittest.main()` or `sys.exit(0)` therefore ends the process before any dataset test runs and is scored PASS; a correct answer whose `__main__` block calls `input()` fails (EOFError, or blocks until `fail_timeout` when the backend runs on a terminal). PASS should mean the dataset's own tests ran to completion.
- **Root cause**: Outcome inferred from exit status alone; the model's code runs as `__main__` with an inherited stdin.
- **Trigger / reproduction**: `docs/audit/repro/u2_grade_exit.py`: MBPP wrong `add` plus `unittest.main()` gives `('pass', '')`; the same code without it gives `fail_assert`; HumanEval wrong answer plus `sys.exit(0)` gives `pass`. `u2_grade_main_input.py`: a correct answer with an `input()` main block gives `fail_error`.
- **Impact**: Pass rates are inflated or deflated depending on each model's answer style, silently corrupting Compare and Report and confounding model comparisons.
- **Suggested fix** (approach only): Have the harness print a random per-run sentinel after the tests and require it in stdout for PASS; run the model code under a non-`__main__` module name (or strip/neutralise its main block); pass `stdin=subprocess.DEVNULL`. Consider whether existing results need re-grading (answers are stored).
- **Docs affected under the maintenance policy**: docs/guides/benchmarks.md (grading section); docs/decisions.md entry, since stored pass rates change meaning.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger)

Found by the repository bug audit of `7a4088b` (finding A-01, unit U2); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-02: config_id fingerprint ignores the profile's extra args and model file, so different launches share one configuration

Issue: #127. Severity: Critical. Area: benchmarks. Status: Confirmed. Unit: U1.

- **Location**: [`apps/server/local_llm/benchmarks/serving/fingerprint.py:76-111`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/serving/fingerprint.py#L76-L111); [`apps/server/local_llm/benchmarks/serving/launcher.py:107`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/serving/launcher.py#L107); [`apps/server/local_llm/benchmarks/serving/launcher.py:146`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/serving/launcher.py#L146); [`apps/server/local_llm/benchmarks/serving/profiles.py:329`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/serving/profiles.py#L329); [`apps/server/local_llm/benchmarks/serving/profiles.py:344`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/serving/profiles.py#L344)
- **Description**: `build_argv` passes the resolved model path (`-m`) and `config.extra` to llama-server, but `config_lines`/`config_id` hash only the alias and six lines that cover neither. AGENTS.md requires the fingerprint to cover exactly the flags the launcher passes (`--metrics` and `-lv` are documented exclusions; `extra` and the model file are not).
- **Root cause**: `extra` is a free-form profile field (only `--parallel` and reasoning flags are rejected) with no fingerprint line; the model is identified by alias only, so a new profile version with a different `model_path` and the same alias collides.
- **Trigger / reproduction**: `docs/audit/repro/u1_fingerprint_extra.py`: base profile, the same plus `extra=['--no-mmap','-sm','none']`, and the same with a different `model_path` all give `932a30cd`, while their argvs differ.
- **Impact**: Runs with different weights or different split/offload flags are filed under one `benchmark_config` row; `upsert_config` (ON CONFLICT DO NOTHING) keeps the first config_text; Compare and Report silently pool them.
- **Suggested fix** (approach only): Add fingerprint coverage for `extra` and the model file (basename or sha), or reject inference-changing `extra` args. To avoid changing every existing id, append the new line only when non-empty/non-default, and decide that explicitly. Update `stats.parse_config_text`, docs/serving-baseline fixtures and their test.
- **Docs affected under the maintenance policy**: fingerprint.py docstring; docs/guides/llama-cpp.md; docs/guides/telemetry.md; docs/serving-baseline/README.md; docs/decisions.md; a `benchmark_schema_note` row via a new Alembic revision if any id changes.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger)

Found by the repository bug audit of `7a4088b` (finding A-02, unit U1); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-03: Report headline always says no system prompt differs and that every difference is noise, whatever the statistics show

Issue: #128. Severity: Critical. Area: benchmarks. Status: Confirmed. Unit: U3.

- **Location**: [`apps/server/local_llm/benchmarks/analysis/report.py:1895-1925`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/analysis/report.py#L1895-L1925); [`apps/server/local_llm/benchmarks/analysis/report.py:1500-1510`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/analysis/report.py#L1500-L1510)
- **Description**: `headline` prints "No system prompt differs from any other" unconditionally (never reads `p_perm` or the Holm p-values) and, when a reliability floor exists, always adds "Every difference in this document is smaller than that" without comparing any difference to the floor. It also summarises only the pooled family or `per_block[0]`. Lines near 1504 similarly always call the floor "the largest number in this document".
- **Root cause**: Text written for one historical null result and hardcoded.
- **Trigger / reproduction**: `docs/audit/repro/u3/headline.py`: 12 items where `(none)` fails all and prompt `p` passes all. Section 4 says "At least one contrast survives correction" (Q=12, p_perm<0.001) while the headline says no prompt differs and the 100 pp difference is "smaller" than a 50% floor.
- **Impact**: The primary conclusion of the generated report contradicts its own analysis.
- **Suggested fix** (approach only): Derive headline wording from `p_perm`/Holm-adjusted p-values and from max |Δ pass rate| compared to the floor; state which family/block it summarises; same for the floor sentence.
- **Docs affected under the maintenance policy**: docs/guides/benchmarks.md Report section if it quotes the headline.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger)

Found by the repository bug audit of `7a4088b` (finding A-03, unit U3); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-04: Compare "by serving" response puts the serving rows under derived_columns, and the page crashes the app

Issue: #129. Severity: High. Area: benchmarks. Status: Confirmed. Unit: U3/U7.

- **Location**: [`apps/server/local_llm/routers/benchmarks/compare.py:27-30`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/benchmarks/compare.py#L27-L30); [`apps/server/local_llm/benchmarks/analysis/compare.py:654`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/analysis/compare.py#L654); [`apps/server/local_llm/benchmarks/analysis/compare.py:727`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/analysis/compare.py#L727); [`apps/web/src/routes/benchmarks/ComparePage.tsx:42`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/benchmarks/ComparePage.tsx#L42); [`apps/web/src/routes/benchmarks/ComparePage.tsx:119-137`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/benchmarks/ComparePage.tsx#L119-L137)
- **Description**: `serving_rows` returns `(rows, derived, notes)`; the router unpacks it as `derived_columns, derived, notes` and returns the row dicts as `derived_columns`. ComparePage uses `derived_columns` as column ids and calls `humanizeHeader(col)` (`col.replace`) on a dict, which throws during render; there is no error boundary, so the SPA goes blank. The main serving table (gen_tps, prefill, VRAM) is never shown under any key.
- **Root cause**: Misnamed tuple unpack in the router; Playwright mocks the shape the page expects and no backend test checks the response keys.
- **Trigger / reproduction**: Benchmarks > Compare, By: Serving, with at least one recorded serving run. `docs/audit/repro/u7_humanize_header.js` throws `col.replace is not a function` on the real response shape.
- **Impact**: The documented way to compare tokens/s across configurations is unusable and takes down the whole page.
- **Suggested fix** (approach only): Return `{rows, derived, notes}` (plus explicit column lists if wanted); render the rows table with columns from the first row's keys, and the derived table beside it; update the e2e mock to the real shape.
- **Docs affected under the maintenance policy**: docs/guides/benchmarks.md (Compare, by serving).
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger)

Found by the repository bug audit of `7a4088b` (finding A-04, unit U3/U7); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-05: Compare "by benchmark" table is empty: per-benchmark values are nested but the page reads them top-level

Issue: #130. Severity: Medium. Area: benchmarks. Status: Confirmed. Unit: U7.

- **Location**: [`apps/server/local_llm/benchmarks/analysis/compare.py:416-438`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/analysis/compare.py#L416-L438); [`apps/server/local_llm/routers/benchmarks/compare.py:37-39`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/benchmarks/compare.py#L37-L39); [`apps/web/src/routes/benchmarks/ComparePage.tsx:119-137`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/benchmarks/ComparePage.tsx#L119-L137)
- **Description**: `benchmark_rows` returns benchmark names as `columns` and nests each value under `row.per_benchmark[name]`; ComparePage uses `row[col]`, so every cell is undefined, and model/config/tier columns are absent, so rows cannot be identified.
- **Root cause**: Backend pivot shape and the generic table normaliser were never reconciled; mocks hide it.
- **Trigger / reproduction**: Compare, By: Benchmark, with any results. `u7_humanize_header.js` prints `benchmark cells: [ [ undefined ] ]`.
- **Impact**: The per-benchmark comparison shows no information.
- **Suggested fix** (approach only): Flatten in the backend (`row[name] = pass_rate`, identity columns first) or map `per_benchmark` in the page; add tests on both sides.
- **Docs affected under the maintenance policy**: docs/guides/benchmarks.md Compare section if it describes the view.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA, both sides quoted above

Found by the repository bug audit of `7a4088b` (finding A-05, unit U7); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-06: Compare never extracts the fa flag, so a two-flag difference is reported as a clean comparison

Issue: #131. Severity: High. Area: benchmarks. Status: Confirmed. Unit: U3.

- **Location**: [`apps/server/local_llm/benchmarks/analysis/compare.py:108-120`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/analysis/compare.py#L108-L120); [`apps/server/local_llm/benchmarks/serving/fingerprint.py:89-92`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/serving/fingerprint.py#L89-L92)
- **Description**: `flags_of` searches `fa: (\S+)` inside `config_value(lines, 'cache')`, but `config_value` stops at the first " | ", so the cache value is only `k=.. v=..` and `fa` is never found. The code comment says the warning covers `fa`.
- **Root cause**: Wrong source string for the regex; `stats.parse_config_text` already reads `fa` correctly.
- **Trigger / reproduction**: `docs/audit/repro/u3/fa.py`: two configs differing only in `fa` give `differing: []`.
- **Impact**: The multi-flag confound warning misses flash-attention changes, so Compare presents a confounded comparison as attributable to one flag.
- **Suggested fix** (approach only): Read `config_value(lines, 'fa')` directly (as stats does), or regex over the whole cache line.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger)

Found by the repository bug audit of `7a4088b` (finding A-06, unit U3); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-07: Compare ranks rows across tiers together and binds the baseline delta to the first matching group only

Issue: #132. Severity: Medium. Area: benchmarks. Status: Confirmed. Unit: U3.

- **Location**: [`apps/server/local_llm/benchmarks/analysis/compare.py:358-380`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/analysis/compare.py#L358-L380)
- **Description**: `rows_for` sorts all groups globally by pass rate, so a 24-item smoke row ranks among 1000-item full rows (docs/guides/benchmarks.md says tiers are never ranked against each other), and picks `base` as the first group with the baseline config_id, so rows in other tiers get `vs_baseline=None` ("different tier") even when the baseline has a group in that tier.
- **Root cause**: No per-tier partitioning; baseline chosen once instead of per tier (and per system/adapter).
- **Trigger / reproduction**: `docs/audit/repro/u3/baseline.py`: `B full 600/1000 vs None different tier` although `A full` exists; order interleaves tiers.
- **Impact**: Misleading ranking and missing baseline deltas under the default "All" tier filter.
- **Suggested fix** (approach only): Sort within each tier; choose the baseline group per tier, matched on system and adapter.
- **Docs affected under the maintenance policy**: None if the code is brought in line with benchmarks.md.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger)

Found by the repository bug audit of `7a4088b` (finding A-07, unit U3); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-08: Report power section computes the minimum detectable effect from a pooled item count no single test uses, at an uncorrected alpha

Issue: #133. Severity: Medium. Area: benchmarks. Status: Suspected. Unit: U3.

- **Location**: [`apps/server/local_llm/benchmarks/analysis/report.py:1413`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/analysis/report.py#L1413); [`apps/server/local_llm/benchmarks/analysis/report.py:1445`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/analysis/report.py#L1445); [`apps/server/local_llm/benchmarks/analysis/report.py:1462`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/analysis/report.py#L1462); [`apps/server/local_llm/benchmarks/analysis/report.py:1490`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/analysis/report.py#L1490)
- **Description**: `items_now` sums items over all complete blocks and is used as n for a single paired McNemar MDE, while each McNemar test runs on one block; alpha stays 0.05 although the pairwise tests are Holm-adjusted over k-1 comparisons. The MDE is understated and "a null here is informative" can be printed when it is not.
- **Root cause**: Pooled n and nominal alpha used for a per-block, multiplicity-corrected test.
- **Trigger / reproduction**: Any report with more than one complete block or more than two prompts (not reproduced).
- **Impact**: Overstates the report's sensitivity, encouraging wrong "no effect" conclusions.
- **Suggested fix** (approach only): Use per-block n (or label the figure as a hypothetical pooled test) and alpha/(k-1) (or the Holm worst case).
- **Docs affected under the maintenance policy**: docs/guides/benchmarks.md if it explains the power section.
- **Related issues and PRs**: None known.
- **Confidence**: Suspected (medium): methodological reading of the code; no numeric repro was run. Confirm by computing the MDE for a two-block, three-prompt fixture.

Found by the repository bug audit of `7a4088b` (finding A-08, unit U3); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-09: Tune sweep adopts (and refines around) a candidate that is slower than the profile defaults

Issue: #134. Severity: High. Area: benchmarks. Status: Confirmed. Unit: U4.

- **Location**: [`apps/server/local_llm/benchmarks/tuning/tune.py:1282-1285`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/tuning/tune.py#L1282-L1285); [`apps/server/local_llm/benchmarks/tuning/tune.py:1328-1335`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/tuning/tune.py#L1328-L1335); [`apps/server/local_llm/benchmarks/tuning/tune.py:1405-1449`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/tuning/tune.py#L1405-L1449)
- **Description**: `best()` returns the highest-scoring non-baseline candidate even when its score (median log-ratio vs baseline) is negative. `finish()` rejects only when `best()` is None, so a slower winner is "adopted"; `refine()`'s "nothing beat the profile's own defaults" branch (`best.baseline`) can never be true because `best()` excludes the baseline.
- **Root cause**: The "beat the baseline" condition is never checked.
- **Trigger / reproduction**: Any sweep where the defaults are already fastest. `docs/audit/repro/u4_tune.py` case 2: a 50% slower candidate is returned by `best()`.
- **Impact**: Sweeps recommend slower configurations as `adopted`, and refine budget is spent around a worse point.
- **Suggested fix** (approach only): Require score > 0 in `best()` and in `finish()`'s ranked list (optionally a significance test against baseline); make `refine()` stop when none qualifies.
- **Docs affected under the maintenance policy**: docs/guides/benchmarks.md / llama-cpp.md tuning verdicts if they describe the rule.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger)

Found by the repository bug audit of `7a4088b` (finding A-09, unit U4); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-10: Tune elimination ranks a candidate exactly tied with the baseline below every slower candidate

Issue: #135. Severity: Medium. Area: benchmarks. Status: Confirmed. Unit: U4.

- **Location**: [`apps/server/local_llm/benchmarks/tuning/tune.py:1175-1179`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/tuning/tune.py#L1175-L1179)
- **Description**: The sort key `scored.get(c.sha,(None,0))[0] or -math.inf` maps a score of exactly 0.0 to -inf, so a tie with the baseline is eliminated ahead of slower candidates.
- **Root cause**: Falsy-zero bug; only None should map to -inf (tune.py near 1563 already does this correctly).
- **Trigger / reproduction**: `docs/audit/repro/u4_tune.py` case 1: tied candidate A is eliminated while B at -50% survives.
- **Impact**: Wrong candidates eliminated.
- **Suggested fix** (approach only): Use an explicit `is not None` check in the key.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger)

Found by the repository bug audit of `7a4088b` (finding A-10, unit U4); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-11: Tune's uncertain-cut sign test pairs mismatched items and treats n=0 as a supported cut

Issue: #136. Severity: Medium. Area: benchmarks. Status: Confirmed. Unit: U4.

- **Location**: [`apps/server/local_llm/benchmarks/tuning/tune.py:1194-1206`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/tuning/tune.py#L1194-L1206)
- **Description**: It zips `log_ratios(lowest)` with `log_ratios(highest)`, each of which has already dropped items lacking timings for that candidate or the baseline, so the i-th entries can refer to different items; and `if n and p > 0.20` treats n=0 as "supported".
- **Root cause**: Positional pairing instead of keyed pairing; no minimum-n rule.
- **Trigger / reproduction**: One candidate lacks timings for an item the other has (errors, timeouts, partial visits). `u4_tune.py` case 3: aligned diffs give p=0.0625 on 5 pairs; zipped diffs are all 0, n=0.
- **Impact**: The recorded `uncertain` decision for a round is computed on the wrong data.
- **Suggested fix** (approach only): Compute differences over item keys present for all three cells; treat n below a threshold as uncertain.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA, both sides quoted above

Found by the repository bug audit of `7a4088b` (finding A-11, unit U4); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-12: Cooldown time accounting overwrites the running total, so max_cooldown_share is not enforced across pauses

Issue: #137. Severity: Medium. Area: benchmarks. Status: Confirmed. Unit: U4.

- **Location**: [`apps/server/local_llm/benchmarks/tuning/tune.py:515-529`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/tuning/tune.py#L515-L529)
- **Description**: Inside the retry loop `self.total_seconds = time.time() - started` replaces the accumulated total of earlier pauses with this pause's elapsed time; after the loop the elapsed time is added again.
- **Root cause**: Assignment instead of a pause-local variable.
- **Trigger / reproduction**: Any pause needing more than one attempt. `u4_tune.py` case 4: 3000 s of earlier cooling plus a 0.4 s pause leaves 0.8.
- **Impact**: Overnight sweeps can spend far more than the configured share of budget cooling; the recorded total is wrong.
- **Suggested fix** (approach only): Keep a local `elapsed`, check `self.total_seconds + elapsed` in `budget_exhausted`, add once.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA, both sides quoted above

Found by the repository bug audit of `7a4088b` (finding A-12, unit U4); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-13: Stopping a sweep during a visit's teardown or a cooldown can skip ServeProcess.stop and leave visit/pause rows running forever

Issue: #138. Severity: Medium. Area: benchmarks. Status: Suspected. Unit: U4.

- **Location**: [`apps/server/local_llm/benchmarks/tuning/tune.py:942-950`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/tuning/tune.py#L942-L950); [`apps/server/local_llm/benchmarks/tuning/tune.py:255-265`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/tuning/tune.py#L255-L265); [`apps/server/local_llm/benchmarks/tuning/tune_probe.py:195-222`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/tuning/tune_probe.py#L195-L222); [`apps/server/local_llm/routers/benchmarks/tune.py:112-120`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/benchmarks/tune.py#L112-L120)
- **Description**: `/stop` cancels the task. If the cancellation lands inside `finally: await server.stop()` or the following `close_visit`, teardown is interrupted (the recorder and temp log may be orphaned) and the visit stays `running`; `finish()` then sets `ended_at`, and `reclaim_stale_sweeps` skips ended sweeps. A cancellation during `Cooldown.run` leaves the pause row open likewise.
- **Root cause**: Cleanup is cancellable and nothing closes open visits/pauses on interruption.
- **Trigger / reproduction**: Press Stop during the up-to-30 s teardown window of a visit or during a cooldown (not reproduced; needs process and DB mocks).
- **Impact**: Possible orphaned telemetry recorder or llama-server, and permanently "running" rows.
- **Suggested fix** (approach only): Shield teardown (`asyncio.shield`) or run it in an uncancellable finally; close open visits and pauses in `finish()` when interrupted.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Suspected (medium): clear from the code path, not run.

Found by the repository bug audit of `7a4088b` (finding A-13, unit U4); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-14: A sweep whose baseline fails to load never narrows and does not say why

Issue: #139. Severity: Low. Area: benchmarks. Status: Suspected. Unit: U4.

- **Location**: [`apps/server/local_llm/benchmarks/tuning/tune.py:1112`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/tuning/tune.py#L1112); [`apps/server/local_llm/benchmarks/tuning/tune.py:1193`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/tuning/tune.py#L1193)
- **Description**: `run_round` drops infeasible candidates, but `eliminate` re-adds `self.baseline`; with an infeasible baseline every candidate has 0 paired items, is "thin", and is kept forever, and the final verdict omits the cause.
- **Root cause**: No handling for an infeasible baseline.
- **Trigger / reproduction**: A profile whose defaults OOM or time out (not reproduced).
- **Impact**: Budget wasted; an unexplained rejected/indeterminate verdict.
- **Suggested fix** (approach only): End the sweep with an explicit reason when the baseline is infeasible.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Suspected (medium): from reading; confirm with a mocked infeasible baseline.

Found by the repository bug audit of `7a4088b` (finding A-14, unit U4); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-15: Test runs block the backend's event loop: grading and suite preparation run blocking subprocesses inside async code

Issue: #140. Severity: High. Area: benchmarks. Status: Confirmed. Unit: U2.

- **Location**: [`apps/server/local_llm/benchmarks/evaluation/runner.py:352`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/evaluation/runner.py#L352); [`apps/server/local_llm/benchmarks/evaluation/runner.py:492-545`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/evaluation/runner.py#L492-L545); [`apps/server/local_llm/routers/benchmarks/tests.py:55-100`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/benchmarks/tests.py#L55-L100)
- **Description**: `run_item` calls `grade()` (which uses `subprocess.run`, up to 60 s for DS-1000) directly in async code; `prepare_suite` parses large JSON and runs `missing_libraries`/`env_fingerprint` subprocesses synchronously; all of it runs in a task on the server loop.
- **Root cause**: Synchronous I/O in coroutines.
- **Trigger / reproduction**: `docs/audit/repro/u2_loop_block.py`: a 100 ms ticker beside one `grade()` of a 3 s answer shows a 3.12 s gap.
- **Impact**: While a test run is grading, chat, the SSE stream and the cancel endpoint all stall.
- **Suggested fix** (approach only): `await asyncio.to_thread(...)` around grading and preparation, or asyncio subprocesses.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger)

Found by the repository bug audit of `7a4088b` (finding A-15, unit U2); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-16: No endpoint fetches datasets, runs selfcheck or runs one item, although the guide documents all three as Tests page actions

Issue: #141. Severity: High. Area: benchmarks. Status: Confirmed. Unit: U2.

- **Location**: [`apps/server/local_llm/benchmarks/evaluation/datasets.py:90-95`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/evaluation/datasets.py#L90-L95); [`apps/server/local_llm/benchmarks/evaluation/datasets.py:229`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/evaluation/datasets.py#L229); [`apps/server/local_llm/benchmarks/evaluation/grading/__init__.py:273-320`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/evaluation/grading/__init__.py#L273-L320); [`apps/server/local_llm/routers/benchmarks/tests.py:1-120`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/benchmarks/tests.py#L1-L120); [`docs/guides/benchmarks.md:128-137`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/docs/guides/benchmarks.md#L128-L137); [`docs/guides/benchmarks.md:336`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/docs/guides/benchmarks.md#L336)
- **Description**: `datasets.fetch_one` and `grading.calibrate`/`write_calibration` have no callers in the backend or frontend; the tests router exposes only options, run, cancel and stream. On a fresh machine (the 2026-10-09 Fedora move) every run fails with "not downloaded yet (see datasets.fetch_one)", and calibration-based exclusions never exist, so items whose own reference fails are scored as model failures.
- **Root cause**: Functionality lost in the CLI-to-app migration; docs not updated.
- **Trigger / reproduction**: Fresh `DATA_DIR`, start any test run.
- **Impact**: Benchmarks cannot be run at all on a new machine through the app; scores include ungradeable items.
- **Suggested fix** (approach only): Add admin endpoints and Tests page actions for fetch (with force), selfcheck and single-item run, or correct the docs and provide a documented command. This is a product decision (see FIX_PLAN open questions).
- **Docs affected under the maintenance policy**: docs/guides/benchmarks.md; README "Pages and URLs" if UI changes; docs/decisions.md.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA, both sides quoted above

Found by the repository bug audit of `7a4088b` (finding A-16, unit U2); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-17: Grading timeouts kill only the direct child; processes spawned by model code survive

Issue: #142. Severity: Medium. Area: benchmarks. Status: Suspected. Unit: U2.

- **Location**: [`apps/server/local_llm/benchmarks/evaluation/grading/__init__.py:146-150`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/evaluation/grading/__init__.py#L146-L150)
- **Description**: On `TimeoutExpired`, `subprocess.run` kills only the immediate child; anything the code forked keeps running, consuming CPU and skewing later timing.
- **Root cause**: No process group.
- **Trigger / reproduction**: A graded answer that forks a long sleeper or spins in a multiprocessing worker (not reproduced).
- **Impact**: Leaked processes and contaminated wall-time measurements.
- **Suggested fix** (approach only): `start_new_session=True` and kill the process group on timeout.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Suspected (medium): standard subprocess semantics; confirm with a fork-and-sleep repro.

Found by the repository bug audit of `7a4088b` (finding A-17, unit U2); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-18: Benchmarks pages show "[object Object]" or a generic message instead of the server error, and Serve treats network failures as success

Issue: #143. Severity: Low. Area: benchmarks. Status: Confirmed. Unit: U7/U10.

- **Location**: [`apps/web/src/lib/apis/benchmarks/index.ts:131-185`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/apis/benchmarks/index.ts#L131-L185); [`apps/web/src/lib/apis/benchmarks/index.ts:720-790`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/apis/benchmarks/index.ts#L720-L790); [`apps/web/src/routes/benchmarks/ServePage.tsx:171`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/benchmarks/ServePage.tsx#L171); [`apps/web/src/routes/benchmarks/ServePage.tsx:181`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/benchmarks/ServePage.tsx#L181); [`apps/web/src/routes/benchmarks/TunePage.tsx:146-180`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/benchmarks/TunePage.tsx#L146-L180); [`apps/web/src/routes/benchmarks/TunePage.tsx:229`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/benchmarks/TunePage.tsx#L229); [`apps/web/src/routes/benchmarks/TunePage.tsx:467`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/benchmarks/TunePage.tsx#L467); [`apps/web/src/routes/benchmarks/TunePage.tsx:526`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/benchmarks/TunePage.tsx#L526)
- **Description**: The API helpers throw `err.detail` (a string, or a 422 array). ServePage renders `err?.detail ?? String(err)`, so a 422 shows "[object Object]"; TunePage reads `.detail` of the string, so 409 "a sweep is already running" and the 404s always show the generic fallback. On a network error `err.detail` is undefined, so `startServe`/`stopServe` resolve `null` and `onSuccess` runs. The L7 fix of the 2026-09-27 review went into profiles.ts only.
- **Root cause**: Inconsistent error contract between `lib/apis/benchmarks/index.ts` and its callers.
- **Trigger / reproduction**: Serve with `ngl` 1.5 (422); start a sweep while one runs (409); stop Serve with the backend down.
- **Impact**: Misleading errors; a failed start looks like success.
- **Suggested fix** (approach only): Normalise errors in the helpers with the existing `errorMessage()` from profiles.ts and rethrow on network failure; render `String(err)` in the pages.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA, both sides quoted above

Found by the repository bug audit of `7a4088b` (finding A-18, unit U7/U10); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-19: Tune page live-status stream can outlive the page or run twice (the L17 fix was not applied to Tune)

Issue: #144. Severity: Low. Area: benchmarks. Status: Confirmed. Unit: U10.

- **Location**: [`apps/web/src/routes/benchmarks/TunePage.tsx:132-194`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/benchmarks/TunePage.tsx#L132-L194); [`apps/web/src/lib/apis/benchmarks/index.ts:910-939`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/apis/benchmarks/index.ts#L910-L939)
- **Description**: `streamTuneLog` creates its AbortController internally; `startStreaming` stores it only after the await, and the `finally` clears the ref without checking ownership. Unmounting or switching sweeps while the request is pending aborts nothing; the old stream then takes over the ref and interleaves `setStatus` with the new one.
- **Root cause**: The 2026-09-27 L17 fix covered ServePage and TestsPage only.
- **Trigger / reproduction**: Leave Tune, or click another recent sweep, before `/tune/log` answers; dev StrictMode triggers it on every mount.
- **Impact**: Leaked SSE connections and the status panel flipping between sweeps.
- **Suggested fix** (approach only): Pass a caller-owned controller into `streamTuneLog` (as `streamServe` does) and apply the ServePage pattern.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA, both sides quoted above

Found by the repository bug audit of `7a4088b` (finding A-19, unit U10); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-20: make frontend ignores a failed bun install, starts the dev server anyway and never sets its cleanup trap

Issue: #145. Severity: Medium. Area: infra. Status: Confirmed. Unit: U6.

- **Location**: [`Makefile:118-124`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/Makefile#L118-L124)
- **Description**: The recipe `cd ... && bun install --frozen-lockfile && trap ... EXIT; ... astro dev --background; ... logs --follow` relies on `-e`, but a failure in a non-final command of an `&&` list does not exit the shell: the trap is skipped and the daemon starts with stale or missing dependencies and no `astro dev stop` on exit.
- **Root cause**: `&&` and `;` mixed under `-e`.
- **Trigger / reproduction**: `bun install --frozen-lockfile` fails (stale lock, offline). `docs/audit/repro/u6_frontend_recipe.mk` prints "STARTED ... (trap set? )" and exits 0.
- **Impact**: Orphaned astro daemon holding :5174 (later reused by Playwright), failure reported as success.
- **Suggested fix** (approach only): Separate the steps with `;` (so `-e` aborts) and set the trap before starting the daemon.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger)

Found by the repository bug audit of `7a4088b` (finding A-20, unit U6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-21: make test-e2e does not run Playwright as CI does (workers, CI env), although the docs say it mirrors CI

Issue: #146. Severity: Low. Area: infra. Status: Confirmed. Unit: U6.

- **Location**: [`Makefile:175-182`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/Makefile#L175-L182); [`.github/workflows/ci.yml:108-109`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/.github/workflows/ci.yml#L108-L109); [`apps/web/playwright.config.ts:1-30`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/playwright.config.ts#L1-L30); [`docs/guides/testing.md:17-24`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/docs/guides/testing.md#L17-L24); [`docs/guides/testing.md:52-56`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/docs/guides/testing.md#L52-L56)
- **Description**: Make runs `bunx playwright test --workers=2` ("CI's count"), CI runs `bun run test:e2e` with no workers setting (Playwright's default, half the runner's cores). CI also sets `CI=true`, enabling `retries: 2` and `forbidOnly` and disabling server reuse; Make does not, so a stray `test.only` passes `make check` and fails CI.
- **Root cause**: Worker count pinned in the Makefile only; behaviour switched by the CI env var.
- **Trigger / reproduction**: Commit a `test.only`; `make check` passes, CI fails.
- **Impact**: Breaks the "green make check predicts green CI" promise.
- **Suggested fix** (approach only): Pin `workers: 2` in playwright.config.ts and run the Make target as `CI=1 bun run test:e2e`, or document the differences.
- **Docs affected under the maintenance policy**: docs/guides/testing.md, Makefile comment, AGENTS.md Commands.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA, both sides quoted above

Found by the repository bug audit of `7a4088b` (finding A-21, unit U6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-22: make test-backend runs pytest even if its Postgres never became ready, and the readiness probe can pass before TCP is up

Issue: #147. Severity: Low. Area: infra. Status: Suspected. Unit: U6.

- **Location**: [`Makefile:145-166`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/Makefile#L145-L166)
- **Description**: The 60-iteration readiness loop has no failure branch, and probes with `psql` over the container's Unix socket, which can succeed during the image's init phase before the server listens on TCP. The port pre-check greps only `127.0.0.1:PORT`.
- **Root cause**: Probe over the wrong transport; no timeout exit.
- **Trigger / reproduction**: Slow image pull or init (not reproduced; Docker Hub rate-limited here).
- **Impact**: Intermittent or confusing local failures in test_imports.
- **Suggested fix** (approach only): Probe with `pg_isready -h 127.0.0.1` and exit with a message when the loop runs out.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Suspected (medium): follows from the postgres entrypoint's temporary init server.

Found by the repository bug audit of `7a4088b` (finding A-22, unit U6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-23: make backend does not wait for Postgres before the app runs migrations at import

Issue: #148. Severity: Low. Area: infra. Status: Suspected. Unit: U6.

- **Location**: [`Makefile:92`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/Makefile#L92); [`infra/docker-compose.yml:25-41`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/infra/docker-compose.yml#L25-L41); [`apps/server/local_llm/config.py:52-70`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/config.py#L52-L70)
- **Description**: `compose up -d postgres` returns on container creation; Compose has no healthcheck; migrations run at import with no retry. On a fresh volume with an existing venv the import can hit connection refused and the reload worker dies.
- **Root cause**: No readiness wait.
- **Trigger / reproduction**: First run against an empty volume with the venv already synced (not reproduced).
- **Impact**: Backend fails to start until a file change triggers a reload.
- **Suggested fix** (approach only): Add a `pg_isready` healthcheck and use `up -d --wait postgres`.
- **Docs affected under the maintenance policy**: README "Running it" if behaviour changes.
- **Related issues and PRs**: None known.
- **Confidence**: Suspected (medium): timing-dependent.

Found by the repository bug audit of `7a4088b` (finding A-23, unit U6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-24: Stale documentation: pre-commit header claims ruff-check covers only part of the backend, and MAP.md omits tracked top-level files

Issue: #149. Severity: Low. Area: docs. Status: Confirmed. Unit: U6.

- **Location**: [`.pre-commit-config.yaml:10-14`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/.pre-commit-config.yaml#L10-L14); [`.pre-commit-config.yaml:49`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/.pre-commit-config.yaml#L49); [`MAP.md:14-30`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/MAP.md#L14-L30); [`MAP.md:336-342`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/MAP.md#L336-L342)
- **Description**: The `.pre-commit-config.yaml` comment says ruff-check covers only `benchmarks/` and `tests/`, but the hook matches all of `apps/server/(local_llm|tests)/` since #80. MAP.md's tree omits `.github/`, `.pre-commit-config.yaml` and `.git-blame-ignore-revs`, and points to per-module detail in AGENTS.md "Conventions" that is not there. Both violate the maintenance policy.
- **Root cause**: Docs not updated with #80 and later layout changes.
- **Trigger / reproduction**: Read the files.
- **Impact**: Misleads contributors about lint coverage and layout.
- **Suggested fix** (approach only): Delete the stale bullet; add MAP.md entries and fix the cross-reference.
- **Docs affected under the maintenance policy**: These files.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA, both sides quoted above

Found by the repository bug audit of `7a4088b` (finding A-24, unit U6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-25: A reply left unfinished on a non-current branch stays "generating" forever after reload

Issue: #150. Severity: Medium. Area: web. Status: Confirmed. Unit: U9.

- **Location**: [`apps/web/src/lib/chat/history.ts:220-232`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/chat/history.ts#L220-L232); [`apps/web/src/routes/chat/useChatSession.ts:166-190`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useChatSession.ts#L166-L190)
- **Description**: `normalizeHistory` marks non-current assistant replies done only when `done !== false`, so a stored `done: false` sibling stays unfinished; `loadChat` finalises only `currentId` when no tasks are pending. Switching to that branch makes `isGenerating` true, and queued prompts never send until Stop is pressed.
- **Root cause**: Condition contradicts the function's own docstring ("mark every assistant reply but the current one done").
- **Trigger / reproduction**: A chat saved with an interrupted multi-model column or branch. `docs/audit/repro/u9/norm.test.ts` passes, showing `done === false` and `isGenerating === true` after normalisation.
- **Impact**: Chat appears stuck generating; input silently queues.
- **Suggested fix** (approach only): When no tasks are pending, mark every `done: false` assistant reply done in `loadChat` (or in `normalizeHistory` given a no-live-tasks flag).
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger)

Found by the repository bug audit of `7a4088b` (finding A-25, unit U9); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-26: Stop pressed before the backend creates the task in an existing chat cancels nothing; the reply keeps streaming after the UI shows stopped

Issue: #151. Severity: Medium. Area: web. Status: Suspected. Unit: U9.

- **Location**: [`apps/web/src/routes/chat/useChatSession.ts:455-470`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useChatSession.ts#L455-L470); [`apps/server/local_llm/main.py:1714`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/main.py#L1714)
- **Description**: `stop` calls `stopTasksByChatId` when the chat has an id and sets `stopPendingRef` only for new chats. In a saved chat, during the POST's pre-task phase no task exists yet, so nothing is stopped; the replies are marked done locally, then the task starts and its events append to a "done" reply, and the user can start a second generation. `continueReply` ignores the pending-stop flag entirely.
- **Root cause**: The 2026-09-27 L3 fix covered only chats without an id.
- **Trigger / reproduction**: In an existing chat, send and immediately press Stop (window is the pre-`create_task` work, typically hundreds of ms).
- **Impact**: Stop silently fails; two generations can run in one chat.
- **Suggested fix** (approach only): Track an in-flight ref; when no task ids are known yet, set `stopPendingRef` regardless of chat id and stop the ids when the POST resolves; apply the same in `continueReply`.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Suspected (high): the code path is unambiguous; not timed in a browser.

Found by the repository bug audit of `7a4088b` (finding A-26, unit U9); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-27: Concurrent archive and set-default can leave the default serving profile archived

Issue: #152. Severity: Low. Area: benchmarks. Status: Suspected. Unit: U5.

- **Location**: [`apps/server/local_llm/models/benchmarks/profiles.py:341-368`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/benchmarks/profiles.py#L341-L368); [`apps/server/local_llm/routers/benchmarks/profiles.py:257-274`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/benchmarks/profiles.py#L257-L274)
- **Description**: `set_default` and `archive` each read the other flag then write their own without a row lock; interleaved, a profile ends up both default and archived. `get_default()` then returns None, so `/profiles/default` and `/serve/start` without a name return 404.
- **Root cause**: Check-then-write under READ COMMITTED; no constraint.
- **Trigger / reproduction**: Two admin requests interleaving (double click, two tabs). Not run (no Postgres here).
- **Impact**: Serve without a profile name fails until fixed by hand.
- **Suggested fix** (approach only): `SELECT ... FOR UPDATE` in both methods, or a CHECK constraint in a new revision.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Suspected (medium-high): clear interleaving from code.

Found by the repository bug audit of `7a4088b` (finding A-27, unit U5); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-28: Concurrent profile create/clone/version edit returns 500 instead of 409

Issue: #153. Severity: Low. Area: benchmarks. Status: Suspected. Unit: U5.

- **Location**: [`apps/server/local_llm/models/benchmarks/profiles.py:298-330`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/benchmarks/profiles.py#L298-L330); [`apps/server/local_llm/routers/benchmarks/profiles.py:167-222`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/benchmarks/profiles.py#L167-L222)
- **Description**: The name-exists 409 check precedes the insert, and `add_version` computes max(version)+1 relying on a unique constraint; the resulting `IntegrityError` is not caught (only `ProfileError` is), so the loser gets a 500 although the docstring promises it "fails loudly" in a handled way.
- **Root cause**: IntegrityError not mapped.
- **Trigger / reproduction**: Two concurrent creates of the same name or edits of one profile (not run).
- **Impact**: Opaque 500 in the UI; data stays consistent.
- **Suggested fix** (approach only): Catch IntegrityError, roll back, raise 409.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Suspected (high): plain code path.

Found by the repository bug audit of `7a4088b` (finding A-28, unit U5); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-29: Chat list endpoints turn page < 1 into a negative OFFSET and fail instead of validating

Issue: #154. Severity: Low. Area: backend. Status: Suspected. Unit: U11.

- **Location**: [`apps/server/local_llm/routers/chats.py:250-262`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/chats.py#L250-L262); [`apps/server/local_llm/routers/chats.py:306-315`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/chats.py#L306-L315); [`apps/server/local_llm/routers/chats.py:440-453`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/chats.py#L440-L453); [`apps/server/local_llm/models/chats.py:1409`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L1409); [`apps/server/local_llm/models/chats.py:1486`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L1486)
- **Description**: `skip = (page - 1) * limit` with no lower bound; `if skip:` is true for negatives, so Postgres raises "OFFSET must not be negative", surfaced as 400 or 500. The same pattern recurs in several chats routes.
- **Root cause**: No `ge=1` validation (inherited).
- **Trigger / reproduction**: `GET /api/v1/chats/list?page=0` (not run; needs Postgres).
- **Impact**: API clients get an error instead of page 1; the UI does not send page 0.
- **Suggested fix** (approach only): Declare `page` with `Query(ge=1)` on these routes.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Suspected (high): standard Postgres behaviour.

Found by the repository bug audit of `7a4088b` (finding A-29, unit U11); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-30: Streaming usage is merged on every usage-bearing chunk, double-counting when a provider repeats usage

Issue: #155. Severity: Low. Area: backend. Status: Suspected. Unit: U11.

- **Location**: [`apps/server/local_llm/utils/middleware.py:4977`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L4977); [`apps/server/local_llm/utils/middleware.py:5021`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L5021); [`apps/server/local_llm/utils/response.py:100-141`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/response.py#L100-L141)
- **Description**: Each chunk carrying `usage` or `timings` is merged into the running total, which sums summable keys; a provider emitting cumulative usage on several chunks inflates totals and makes them inconsistent.
- **Root cause**: Per-chunk merge instead of last-wins per pass.
- **Trigger / reproduction**: An OpenAI-compatible provider that sends usage on more than the final chunk (OpenRouter sends it once, so the main path is probably unaffected; llama.cpp `timings` behaviour unverified).
- **Impact**: Inflated stored usage for such providers.
- **Suggested fix** (approach only): Keep a per-pass usage that each chunk overwrites; merge it once per pass.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Suspected (medium): depends on provider behaviour and on which keys are summable.

Found by the repository bug audit of `7a4088b` (finding A-30, unit U11); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-31: Telemetry recorder attaches a new run to whatever server already answers on the port

Issue: #156. Severity: Medium. Area: benchmarks. Status: Suspected. Unit: U1.

- **Location**: [`apps/server/local_llm/benchmarks/serving/telemetry_recorder.py:109-117`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/serving/telemetry_recorder.py#L109-L117); [`apps/server/local_llm/benchmarks/serving/telemetry_recorder.py:403-412`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/benchmarks/serving/telemetry_recorder.py#L403-L412)
- **Description**: The recorder waits only for something to answer on the serving port. If an orphaned or hand-started llama-server already holds 8090 (the documented `--reload` orphan case), the new server fails to bind but the recorder opens a run against the old server under the new config_id.
- **Root cause**: Readiness check does not verify the server it measures is the one just spawned.
- **Trigger / reproduction**: Start Serve while an orphaned llama-server holds 8090 (not reproduced; no llama.cpp here).
- **Impact**: Telemetry and throughput attributed to the wrong configuration.
- **Suggested fix** (approach only): Check the spawned pid is alive and/or that `/v1/models` reports the expected alias before opening the run; refuse to start when the port is already bound.
- **Docs affected under the maintenance policy**: docs/guides/telemetry.md.
- **Related issues and PRs**: None known.
- **Confidence**: Suspected (medium): from reading; needs a port collision to confirm.

Found by the repository bug audit of `7a4088b` (finding A-31, unit U1); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-32: Flaky e2e assertion in the knowledge list search test

Issue: #157. Severity: Low. Area: web. Status: Suspected. Unit: U10.

- **Location**: [`apps/web/e2e/workspace-knowledge.spec.ts:156-172`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/e2e/workspace-knowledge.spec.ts#L156-L172)
- **Description**: After the list filters, the test asserts synchronously that a `/search?query=Base+2` call was recorded. The UI can hide "Base 1" before the final debounced request is recorded, so the non-retrying `expect(...)` fails intermittently.
- **Root cause**: Non-polling assertion on request log after a UI condition.
- **Trigger / reproduction**: Failed once in a full `--workers=2` run during this audit; passed 3/3 in isolation.
- **Impact**: Spurious CI red.
- **Suggested fix** (approach only): Use `expect.poll(() => calls.some(...)).toBe(true)` or wait for the request.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Suspected (medium): observed once; cause inferred from the test code.

Found by the repository bug audit of `7a4088b` (finding A-32, unit U10); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-33: Editing a calendar event cannot remove its repeat rule, description or location

Issue: #158. Severity: Medium. Area: web. Status: Confirmed. Unit: U10.

- **Location**: [`apps/web/src/routes/calendar/calendarModel.ts:196-207`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/calendar/calendarModel.ts#L196-L207); [`apps/web/src/lib/apis/calendar/index.ts:319-334`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/apis/calendar/index.ts#L319-L334); [`apps/server/local_llm/models/calendar.py:703-716`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/calendar.py#L703-L716)
- **Description**: `eventPayload` maps an empty repeat, description or location to `undefined`; `JSON.stringify` drops those keys; the update path uses `model_dump(exclude_unset=True)` and only sets fields that are present. Clearing any of them on an existing event therefore keeps the old value while the dialog reports success. Create is unaffected.
- **Root cause**: "Unset" and "cleared" are both encoded as an absent key.
- **Trigger / reproduction**: Edit a weekly event, set Repeat to none (or clear the description/location), save: the event still recurs and the old text returns.
- **Impact**: A recurring event cannot be made non-recurring from the UI; text fields cannot be cleared.
- **Suggested fix** (approach only): When editing, send explicit `null` for cleared fields (the backend form already accepts `None` for rrule; verify description/location); keep omitting an rrule the form cannot express so it is preserved.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA, both sides quoted above

Found by the repository bug audit of `7a4088b` (finding A-33, unit U10); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-34: Automation schedule picker silently rewrites RRULEs it cannot represent and mislabels them

Issue: #159. Severity: Medium. Area: web. Status: Confirmed. Unit: U10.

- **Location**: [`apps/web/src/routes/automations/automationModel.ts:64-75`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/automations/automationModel.ts#L64-L75); [`apps/web/src/routes/automations/automationModel.ts:86-99`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/automations/automationModel.ts#L86-L99); [`apps/web/src/routes/automations/automationModel.ts:122-138`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/automations/automationModel.ts#L122-L138)
- **Description**: `parseRrule` treats any HOURLY/DAILY/WEEKLY/MONTHLY rule as representable, discarding unknown keys and all but the first value of multi-value keys; saving rebuilds the rule from the picker state, and `formatSchedule` labels the lossy version. The doc comment says unrepresentable rules should become CUSTOM.
- **Root cause**: Representability is decided from FREQ alone.
- **Trigger / reproduction**: `docs/audit/repro/u10_automation_rrule.test.ts`: `FREQ=MONTHLY;BYDAY=1MO` becomes `BYMONTHDAY=1` ("Monthly on the 1st"); `BYHOUR=9,17` becomes `BYHOUR=9`; `UNTIL=...` is dropped.
- **Impact**: Automations run on a different schedule than the user set (lost runs, never-ending schedules), and the list shows the wrong schedule.
- **Suggested fix** (approach only): Return CUSTOM (keeping the text verbatim) when any key/value is outside what the picker expresses, for example by requiring `buildRrule(parseRrule(r))` to equal the normalised input; use the same test in `formatSchedule`.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger)

Found by the repository bug audit of `7a4088b` (finding A-34, unit U10); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## A-35: Chat documents are not pruned to the current conversation path, so a file from a deleted message or another branch is still sent as context

Issue: #160. Severity: Medium. Area: web. Status: Confirmed. Unit: U9.

- **Location**: [`apps/web/src/lib/chat/request.ts:142-147`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/chat/request.ts#L142-L147); [`apps/web/src/lib/chat/request.ts:181`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/chat/request.ts#L181); [`apps/web/src/routes/chat/useChatSession.ts:352`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useChatSession.ts#L352); [`apps/web/src/routes/chat/useChatSession.ts:406`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useChatSession.ts#L406); [`apps/web/src/routes/chat/useChatSession.ts:499`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useChatSession.ts#L499)
- **Description**: The SvelteKit original (`d863707:apps/openwebui/src/lib/components/chat/Chat.svelte:3420-3428`) filtered `chatFiles` to files attached to messages on the path being answered before every send. The port's `turnFiles` merges the whole accumulated `chatFiles` list with the user message's files, and `chatFiles` is only appended to, so every document ever attached in the session is sent and saved back to the chat.
- **Root cause**: The pruning step was lost in the port (an undocumented behaviour change).
- **Trigger / reproduction**: Attach a file to a message, then delete that message or switch to a sibling branch without it, and send. `docs/audit/repro/u9_chatfiles.test.ts`: a history with no files on its path and `chatFiles=[X]` yields `files == [X]`.
- **Impact**: Answers are grounded in, and cite, a document the visible conversation no longer contains; the stale list persists across reloads.
- **Suggested fix** (approach only): Before `turnFiles`, filter `chatFiles` by id to files of `messagesList(history, responseId)`, and write the filtered list back with `setChatFiles`, as the original did.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger)

Found by the repository bug audit of `7a4088b` (finding A-35, unit U9); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

## Gap review (2026-10-19, second session)

A second pass over the areas the first session reviewed only partly (see COVERAGE.md), run on the owner's laptop at the same SHA
(the working tree was `3b754d1`, which differs from `7a4088b` only in `apps/server/pyproject.toml` outside application code).
Nineteen bounded review packages (B1-B10 backend, F1-F9 frontend) read every line of their files; every finding below was
re-verified by the auditing session (repro re-run, or the code path read on both sides). Repros are under `repro/gap/`.

| ID | Issue | Severity | Area | Status | Package | Title |
|---|---|---|---|---|---|---|
| A-115 | #241 | High | web | Confirmed | F6 | crypto.randomUUID is unavailable over plain-HTTP LAN access, so sending a chat message throws there |
| A-116 | #242 | High | backend | Confirmed | F6 | JWT expiry accepts negative durations, locking every user out, and silently drops invalid values while the tab reports saved |
| A-36 | #162 | High | backend | Confirmed | B1 | OpenRouter's mid-stream error chunk is ignored, so a cut-off reply is saved and shown as a complete answer |
| A-50 | #176 | High | backend | Confirmed | B6 | The calendar search tool returns unexpanded recurring events that push real in-range events out of the results |
| A-51 | #177 | High | backend | Confirmed | B6 | query_chat_files without a file id returns only the first attached file's chunks |
| A-69 | #195 | High | backend | Confirmed | B8 | Deleting a knowledge directory with its contents leaves the files' chunks in the vector collection, so chat keeps answering from deleted files |
| A-85 | #211 | High | web | Confirmed | F1 | Editing a reply or "Save As Copy" changes only what is displayed; the model keeps receiving the original text |
| A-95 | #221 | High | backend | Confirmed | F2+B9 | Saving a prompt with "Set as Production" unchecked still puts the new content live |
| A-100 | #226 | Medium | web | Confirmed | F2 | Editing any prompt suggestion truncates all others to 2000 characters and drops their other fields |
| A-101 | #227 | Medium | web | Confirmed | F2 | Saving a skill re-enables it if disabled and clears its tags |
| A-102 | #228 | Medium | web | Confirmed | F2+F3 | Debounced autosaves are cancelled on unmount, so edits made just before leaving a page are lost |
| A-103 | #229 | Medium | web | Confirmed | F3 | Knowledge-base actions can leave the user on an empty later page with no pagination to get back |
| A-105 | #231 | Medium | web | Suspected | F3 | Dropping a folder together with other items skips every item after the first folder |
| A-106 | #232 | Medium | backend | Confirmed | F5 | Hybrid search is silently switched off when the reranker fails to load, while Documents reports it saved and on |
| A-109 | #235 | Medium | web | Confirmed | F5 | Admin Documents accepts chunk size 0 or an overlap larger than the chunk size, after which every upload fails |
| A-114 | #240 | Medium | web | Confirmed | F5+F7 | API client helpers resolve null on network or non-JSON errors, so failures are reported as success or lost silently |
| A-117 | #243 | Medium | web | Confirmed | F6 | Admin banners are saved but never displayed anywhere (the port lost the banner display and dismissal) |
| A-118 | #244 | Medium | web | Confirmed | F6 | Cancelling an Ollama pull deletes an installed model of the same name |
| A-119 | #245 | Medium | web | Confirmed | F6 | An Ollama pull whose stream errors spins forever and freezes the admin tab |
| A-121 | #247 | Medium | web | Confirmed | F6 | Clearing the Jupyter timeout in admin Code Execution makes the tab unsaveable |
| A-126 | #252 | Medium | web | Confirmed | F7 | Failed channel message edits, pins, reactions and deletes stay on screen as if saved |
| A-127 | #253 | Medium | web | Confirmed | F7 | A failed channel history load is shown as "the very beginning of the channel" |
| A-133 | #259 | Medium | web | Confirmed | F9 | Account tab: a failed load is silent, and Save then wipes user variables and profile fields |
| A-138 | #264 | Medium | backend | Confirmed | B3 | Automation runs are recorded as successful as soon as they are dispatched, so model and provider failures never reach the run history |
| A-139 | #265 | Medium | backend | Confirmed | B3 | Automation runs fired before the model list is loaded drop the model's default tools, filters, features and terminal |
| A-140 | #266 | Medium | backend | Confirmed | B3 | Daily, weekly and monthly automation rules skip occurrences when the user's timezone is behind the server's, and fire a few seconds late |
| A-142 | #268 | Medium | web | Confirmed | B3 | The app has no handler for the calendar:alert socket event, so in-app calendar reminders are never shown |
| A-151 | #277 | Medium | backend | Confirmed | B9 | Deleting a thread's parent message leaves its replies, pins and reactions reachable |
| A-152 | #278 | Medium | backend | Confirmed | B9 | Leaderboard counts a thumbs-up on a regenerated reply as both a win and a loss for the same model |
| A-156 | #282 | Medium | backend | Confirmed | B10 | Batch memory replace clears the memory's path unless the caller repeats it |
| A-157 | #283 | Medium | backend | Confirmed | B10 | Generated tags that differ only by case or spacing make the whole tag batch fail, leaving chat tags unindexed and unarchive returning 500 |
| A-158 | #284 | Medium | backend | Confirmed | B10 | Every failed OAuth token refresh deletes the session, and refresh has no lock despite its docstring |
| A-163 | #289 | Medium | backend | Confirmed | B7 | Postgres chat search silently excludes chats whose title contains "x00" or whose content contains a literal \u0000 |
| A-164 | #290 | Medium | backend | Confirmed | B7 | Files added to a message by tools or streamed images are written only to the chat JSON, so they are duplicated on save and lost on fork |
| A-37 | #163 | Medium | backend | Confirmed | B1 | If the upstream connection drops mid-stream, the partial reply is discarded and the stream snapshot is never cleared |
| A-38 | #164 | Medium | backend | Confirmed | B1 | Resuming after a tool approval rebuilds messages from the database, dropping the system prompt, injected context and the user's images |
| A-39 | #165 | Medium | backend | Confirmed | B1 | A non-streaming reply with only tool calls, or with empty content, is never finished and spins forever |
| A-43 | #169 | Medium | backend | Suspected | B1+B4 | Connected MCP clients leak when listing tools fails or a later tool-setup step raises |
| A-44 | #170 | Medium | backend | Confirmed | B4 | One failing notification webhook stops delivery to the user's other notification targets |
| A-45 | #171 | Medium | backend | Confirmed | B4+B8 | Recurring calendar occurrences that start before the viewed range are dropped, unlike one-off events with the same times |
| A-52 | #178 | Medium | backend | Confirmed | B6 | Paging view_file / view_knowledge_file with line numbers skips content |
| A-53 | #179 | Medium | backend | Confirmed | B6 | query_knowledge_files lets attached notes and internal hits crowd out more relevant external knowledge hits |
| A-54 | #180 | Medium | backend | Confirmed | B6 | One failing external knowledge base makes query_knowledge_files fail and discards every internal result |
| A-55 | #181 | Medium | backend | Confirmed | B6 | search_notes and search_chats apply date filters after fetching only the newest matches, so older ranges return nothing |
| A-56 | #182 | Medium | backend | Confirmed | B6 | Creating an event without a calendar picks the first shared calendar flagged default, which can be another user's |
| A-57 | #183 | Medium | backend | Confirmed | B6+B8+B3 | Rescheduling an event never re-arms its reminder, and recurring events alert only once |
| A-61 | #187 | Medium | backend | Confirmed | B2 | merge_system_messages keeps only the first text part of a list-content system message |
| A-62 | #188 | Medium | backend | Confirmed | B2 | The Anthropic-compatible endpoint reports upstream failures as a successful end_turn |
| A-63 | #189 | Medium | backend | Confirmed | B2 | OpenAPI tool servers: body fields that share a name with a path or query parameter are removed from the body (regression from #117) |
| A-70 | #196 | Medium | backend | Confirmed | B8 | Every chat save re-adds a continued reply's usage to its chat_message row, inflating stored token usage without bound |
| A-71 | #197 | Medium | backend | Confirmed | B8 | The Knowledge page's "local" source filter matches no knowledge base created in the app |
| A-74 | #200 | Medium | web | Confirmed | F8 | Clearing a custom number parameter in chat controls stores "" and every later request sends it upstream as the value |
| A-76 | #202 | Medium | web | Confirmed | F8 | The note access dialog lost the original's permission props: no write grants, and a Public option that is silently stripped while the UI shows it applied |
| A-77 | #203 | Medium | backend | Confirmed | F4+B9 | Leaderboard Elo ratings depend on database row order rather than time |
| A-86 | #212 | Medium | web | Confirmed | F1 | With the message queue off, sending while a reply streams does not stop that reply |
| A-87 | #213 | Medium | web | Confirmed | F1 | A queued prompt is silently discarded when the reply it waited for fails with no content |
| A-88 | #214 | Medium | web | Confirmed | F1 | A reply whose done event was missed (socket drop, sleep, backend reload) stays "generating" forever |
| A-89 | #215 | Medium | web | Confirmed | F1 | An async message action or rating that finishes while another chat loads saves the old chat's history into the new chat |
| A-98 | #224 | Medium | web | Confirmed | F2 | Importing a model JSON over an existing model deletes its sharing grants, re-enables it, and replaces its meta |
| A-99 | #225 | Medium | web | Confirmed | F2 | Bulk Enable/Disable/Show/Hide on the Models page act on read-only models and can wipe their params |
| A-104 | #230 | Low | web | Confirmed | F3 | The knowledge base detail page starts filtered by the list pages' shared View setting |
| A-107 | #233 | Low | web | Confirmed | F5 | Admin Documents: the BM25 weight "Default" option can never be saved |
| A-108 | #234 | Low | web | Confirmed | F5 | Admin Documents: JSON options pass validation then fail the save after the embedding change was already applied |
| A-110 | #236 | Low | web | Confirmed | F5 | Admin Images: Verify for the edit ComfyUI URL checks the generation server instead |
| A-111 | #237 | Low | web | Confirmed | F5 | Admin Images: a cleared Steps field is sent as "" and fails the whole save |
| A-112 | #238 | Low | web | Confirmed | F5 | "Max Upload Size" 0 means unlimited to the server but rejects every file in the chat and channel composers |
| A-113 | #239 | Low | web | Confirmed | F5 | Admin Connections Save shows "Settings saved" after both saves failed |
| A-120 | #246 | Low | web | Confirmed | F6 | Ollama "Update All Models" reports success even when every pull failed |
| A-122 | #248 | Low | web | Confirmed | F6 | Clearing number fields in admin Interface settings fails the save and can half-apply it |
| A-123 | #249 | Low | web | Confirmed | F6 | After hiding a connection model with no stored record, further toggles on it fail until the tab is reopened |
| A-124 | #250 | Low | web | Suspected | F6 | GGUF upload creates the model twice in file mode and never in URL mode, and stream errors are swallowed |
| A-125 | #251 | Low | web | Confirmed | F6 | Pipelines: an unset list valve loads as an empty required Custom field, blocking Save; its test cannot catch it |
| A-128 | #254 | Low | web | Confirmed | F7 | Every open tab shows its own desktop notification and sound for each channel message |
| A-129 | #255 | Low | web | Confirmed | F7 | Channel unread badges count thread replies and model replies that the server does not count |
| A-130 | #256 | Low | web | Confirmed | F7 | Pressing Enter on a mention suggestion that dropped out of the list throws and inserts nothing |
| A-131 | #257 | Low | web | Confirmed | F7 | The reaction tooltip omits the fourth person when exactly four users reacted |
| A-132 | #258 | Low | web | Confirmed | F7 | The pure-JS SHA-256 fallback is wrong for files of 512 MiB or more, so knowledge sync re-uploads them every time over plain HTTP |
| A-134 | #260 | Low | web | Confirmed | F9 | Enter in a password field on the Account tab runs the profile save instead of the password change |
| A-135 | #261 | Low | web | Confirmed | F9 | A font typed and submitted with Enter on the Interface tab is not saved |
| A-136 | #262 | Low | web | Confirmed | F9 | Personal settings switches fail silently, and the interface permission blocks every settings save while only one tab is hidden |
| A-137 | #263 | Low | web | Confirmed | F9 | A personal tool server saved without a name is listed as a blank row |
| A-141 | #267 | Low | backend | Confirmed | B3 | Sub-daily rules with an old DTSTART are rebuilt from the epoch, reviving exhausted COUNT rules and shifting run times |
| A-143 | #269 | Low | backend | Confirmed | B3 | Plugin import rewriting matches substrings, corrupting imports such as configparser and saving the corrupted source |
| A-144 | #270 | Low | backend | Confirmed | B3 | A chat timer stays "running" forever if anything fails before completion or the process restarts mid-claim |
| A-145 | #271 | Low | backend | Confirmed | B3 | The stop-sequence mapping corrupts non-ASCII stop strings and splits a string stop into characters |
| A-146 | #272 | Low | backend | Confirmed | B3 | With default model metadata set, admins lose base models that have no workspace row when admin bypass is off |
| A-147 | #273 | Low | backend | Confirmed | B5 | MCP OAuth client registration picks a token auth method the client cannot use |
| A-148 | #274 | Low | backend | Confirmed | B5 | OAuth groups in a dotted claim name (Auth0-style URL claims) never resolve |
| A-149 | #275 | Low | backend | Confirmed | B5 | OAuth group sync removes a new user from the default group immediately after adding them |
| A-150 | #276 | Low | backend | Confirmed | B5 | kb_exec ls lists a model's directly attached files inside every knowledge base |
| A-153 | #279 | Low | backend | Confirmed | B9 | Adding several users to a group silently drops new members when one is already a member |
| A-154 | #280 | Low | backend | Confirmed | B9 | The workspace model tag filter matches models whose meta merely contains the tag word |
| A-155 | #281 | Low | backend | Suspected | B9 | Folder delete commits child deletions one by one and reports a mid-way failure as success |
| A-159 | #285 | Low | backend | Confirmed | B10 | Non-expiring OAuth tokens become unusable on servers east of UTC |
| A-160 | #286 | Low | backend | Confirmed | B10 | OAuth provider settings saved in Admin > Authentication are never used for login |
| A-161 | #287 | Low | backend | Confirmed | B10 | A 44-character LLLM_SECRET_KEY that is not a Fernet key stops the backend from starting |
| A-162 | #288 | Low | backend | Confirmed | B10 | Tool valve saves report success when the database write failed |
| A-165 | #291 | Low | backend | Confirmed | B7 | Chat search ignores a folder: filter that matches no folder and returns every chat |
| A-166 | #292 | Low | backend | Confirmed | B7 | LIKE wildcards in chat search text are not escaped, so % or _ matches every chat |
| A-167 | #293 | Low | backend | Confirmed | B7 | Linking an already-linked file to a chat makes the whole chat_file batch fail, so new files are never linked |
| A-168 | #294 | Low | backend | Confirmed | B7 | Chat export pages by OFFSET over updated_at, so a chat updated during export is skipped and another exported twice |
| A-169 | #295 | Low | backend | Confirmed | B7 | Imported chats all show as unread |
| A-40 | #166 | Low | backend | Confirmed | B1 | Tool arguments that are valid JSON but not an object crash the whole reply |
| A-41 | #167 | Low | backend | Confirmed | B1 | A Responses API `response.failed` event is shown live but not saved, so the reply looks successful after reload |
| A-42 | #168 | Low | backend | Confirmed | B1 | Task-model JSON is located with rfind('{'), so generated search queries or prompts containing a brace are mangled |
| A-46 | #172 | Low | backend | Confirmed | B4 | One invalid chat-variable value silently blanks every chat variable in the system prompt |
| A-47 | #173 | Low | backend | Confirmed | B4 | A filter's user valves leak to later filters through the shared `__user__` dict |
| A-48 | #174 | Low | backend | Suspected | B4 | Resolving a tool approval twice can run the tool twice |
| A-49 | #175 | Low | backend | Confirmed | B4 | Custom connection headers with user-name or file-name placeholders break MCP connections for non-ASCII values |
| A-58 | #184 | Low | backend | Confirmed | B6 | Calendar reminders longer than 60 minutes fire 60 minutes before, although the tool offers them |
| A-59 | #185 | Low | backend | Confirmed | B6 | view_channel_thread returns user_name null for every reply not posted by a webhook |
| A-60 | #186 | Low | backend | Confirmed | B6 | Knowledge listing tools load every file's full text just to count files |
| A-64 | #190 | Low | backend | Confirmed | B2 | OpenAPI tool servers: header and cookie parameters are offered to the model but never sent |
| A-65 | #191 | Low | backend | Confirmed | B2 | OpenAPI tool servers: an operation whose JSON body is an array produces an unusable tool |
| A-66 | #192 | Low | backend | Confirmed | B2 | Without Redis, every tool-server and terminal-server lookup refetches every server spec |
| A-67 | #193 | Low | backend | Confirmed | B2 | Sub-agent limit -1 ("unlimited") breaks max_iterations and max_output |
| A-68 | #194 | Low | backend | Confirmed | B2 | Anthropic-to-OpenAI conversion drops top-level document and search_result blocks and ignores tool_choice none |
| A-72 | #198 | Low | backend | Confirmed | B8 | The Analytics 24-hour chart ignores the group filter |
| A-73 | #199 | Low | backend | Suspected | B8+F3+F2 | Paginated listings (users, group members, models, feedback) have no deterministic ORDER BY, so pages can repeat or skip rows |
| A-75 | #201 | Low | web | Confirmed | F8 | A numeric enum valve sends its option as a string, so the backend rejects the save |
| A-78 | #204 | Low | backend | Suspected | F4+B9 | Topic-weighted Elo uses raw cosine similarity, so a negative weight reverses a result |
| A-79 | #205 | Low | web | Confirmed | F4 | Sorting the Feedback table by User sends a key the backend ignores, leaving pages unordered |
| A-80 | #206 | Low | web | Confirmed | F4 | A ?redirect= value with a control character passes safeRedirect, and the signed-in user is left on the sign-in form |
| A-81 | #207 | Low | web | Confirmed | F4 | Playground Cancel and leaving the page cannot abort a request before response headers arrive |
| A-82 | #208 | Low | web | Confirmed | F4 | Playground parameters are spread at the top level of the request, so custom parameters never apply and app-only keys reach the provider |
| A-83 | #209 | Low | web | Confirmed | F4 | Functions "Import JSON" reports success even when every create failed |
| A-84 | #210 | Low | web | Confirmed | F4 | A /notes?title=&content= link whose note creation fails leaves an endless spinner |
| A-90 | #216 | Low | web | Confirmed | F1 | When the request fails in a multi-model chat, only the first column is marked failed and the input stays generating |
| A-91 | #217 | Low | web | Confirmed | F1 | Attachments and the typed draft carry over when switching chats |
| A-92 | #218 | Low | web | Confirmed | F1 | Queued prompts are discarded when switching chats |
| A-93 | #219 | Low | web | Confirmed | F1 | Image uploads to a non-vision model are no longer refused |
| A-94 | #220 | Low | web | Confirmed | F1 | HEIC images are uploaded unconverted |
| A-96 | #222 | Low | backend | Confirmed | B9 | Switching the production prompt version reverts name and tags edited through the metadata path |
| A-97 | #223 | Low | backend | Confirmed | F2+B9 | The prompt version diff endpoint is unreachable |

### A-36: OpenRouter's mid-stream error chunk is ignored, so a cut-off reply is saved and shown as a complete answer

Issue: #162. Severity: High. Area: backend. Status: Confirmed. Package: B1.

- **Location**: [`apps/server/local_llm/utils/middleware.py:5031-5044`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L5031-L5044); [`apps/server/local_llm/utils/middleware.py:5049-5070`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L5049-L5070)
- **Description**: `_StreamingReply._handle_chat_chunk` looks for `data['error']` only when a chunk has no `choices`. OpenRouter's documented mid-stream error is a chunk with a top-level `error` plus `choices:[{delta:{content:''}, finish_reason:'error'}]`, sent with HTTP 200, after which the stream ends. That chunk takes the normal delta path, `_finish` saves `done: true` with the partial text, and no error is saved or shown.
- **Root cause**: The error branch is gated on an empty `choices` list.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B1/repro_stream.py` case 1: deltas "The answer is" then the OpenRouter error chunk give `upsert_message {done: true, output: ["The answer is"]}` and `chat:completion {done: true}`, with no error saved or emitted.
- **Impact**: On the app's day-to-day provider, any provider failure mid-reply produces a silently truncated answer that looks complete, live and after reload.
- **Suggested fix** (approach only): Check for a top-level `error` (or `finish_reason == 'error'`) before branching on `choices`; call `_save_error` and emit the error; add a characterization case.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #188
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-36, package B1); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-37: If the upstream connection drops mid-stream, the partial reply is discarded and the stream snapshot is never cleared

Issue: #163. Severity: Medium. Area: backend. Status: Confirmed. Package: B1.

- **Location**: [`apps/server/local_llm/utils/middleware.py:4859-4874`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L4859-L4874); [`apps/server/local_llm/utils/middleware.py:5499-5516`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L5499-L5516); [`apps/server/local_llm/main.py:1506-1531`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/main.py#L1506-L1531); [`apps/server/local_llm/main.py:1650-1662`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/main.py#L1650-L1662); [`apps/server/local_llm/utils/middleware.py:5568`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L5568); [`apps/server/local_llm/utils/middleware.py:5610`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L5610)
- **Description**: The `async for line in response.body_iterator` loop is outside the try; `_StreamingReply.run` catches only `CancelledError`. An exception from the body iterator (connection reset, payload error, idle timeout) escapes: nothing saves `full_output()`, `clear_response_stream` never runs, and outlet/background handlers are skipped. `_report_chat_error` then writes only `{parentId, error}`, so the text the user watched stream is gone after reload.
- **Root cause**: Only `CancelledError` is handled around the body iterator.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B1/repro_stream.py` case 2: one delta then `ConnectionResetError` raises out of `run`; no `upsert_message`, no `clear_response_stream`.
- **Impact**: Lost replies on flaky networks and long local generations.
- **Suggested fix** (approach only): Catch non-cancellation exceptions in `run` like `_save_cancelled_state`: save the partial output with `done: true` plus the error, clear the stream, then report.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-37, package B1); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-38: Resuming after a tool approval rebuilds messages from the database, dropping the system prompt, injected context and the user's images

Issue: #164. Severity: Medium. Area: backend. Status: Confirmed. Package: B1.

- **Location**: [`apps/server/local_llm/utils/middleware.py:3438-3458`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L3438-L3458); [`apps/server/local_llm/utils/tool_approval.py:162-164`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/tool_approval.py#L162-L164); [`apps/server/local_llm/main.py:1627`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/main.py#L1627)
- **Description**: `drain_approved_tool_calls` replaces `form_data['messages']` with `process_messages_with_output(load_messages_from_db(...))`. That list has no system message (chat/folder prompt, skills, memories, RAG context, file tags) and never calls `_inline_message_images`, so image attachments disappear. Only the Workspace model's own system prompt is re-applied later.
- **Root cause**: The resume path replaces the built message list with a database replay instead of extending it.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B1/repro_misc.py` case (a): a stored user message with an image becomes text only on the drain path; the normal replay path keeps the `image_url` part. Reachable when tool permissions are enabled in `ask` mode and the user approves a call.
- **Impact**: After approving a tool, the model answers without its instructions, retrieved context or the images the user sent.
- **Suggested fix** (approach only): Keep the already-built system message and re-apply `_inline_message_images` (as `_replay_history_from_db` does), or splice the stored output into the built messages instead of replacing them.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-38, package B1); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-39: A non-streaming reply with only tool calls, or with empty content, is never finished and spins forever

Issue: #165. Severity: Medium. Area: backend. Status: Confirmed. Package: B1.

- **Location**: [`apps/server/local_llm/utils/middleware.py:4139-4141`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L4139-L4141); [`apps/server/local_llm/utils/middleware.py:4249-4252`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L4249-L4252)
- **Description**: With streaming off, the `done` event, DB save and outlet/background handlers are all gated on `choices and (content or response_output)`. A native tool-call response (`content: null`) and a thinking model that used its budget on reasoning (`content: ''`) both write nothing, so the placeholder message stays not-done and the UI spins.
- **Root cause**: Finalization is conditional on non-empty content or output.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B1/repro_misc.py` case (b): both cases record no DB writes and no events. Reachable when the chat or model sets stream to off.
- **Impact**: Stuck replies with streaming disabled; tools requested by the model never run.
- **Suggested fix** (approach only): Always finalize: save `done: true` with whatever output exists (reasoning item, or an error explaining tools need streaming).
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-39, package B1); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-40: Tool arguments that are valid JSON but not an object crash the whole reply

Issue: #166. Severity: Low. Area: backend. Status: Confirmed. Package: B1.

- **Location**: [`apps/server/local_llm/utils/middleware.py:4645-4655`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L4645-L4655); [`apps/server/local_llm/utils/middleware.py:6040-6042`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L6040-L6042); [`apps/server/local_llm/utils/middleware.py:3213-3238`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L3213-L3238)
- **Description**: `_parse_tool_params` returns any JSON value; `params.items()` then runs outside the try, so arguments like `"[]"`, `"1"` or `"\"x\""` raise AttributeError and abort the reply instead of producing the existing "could not be parsed" tool error.
- **Root cause**: `_parse_tool_params` accepts any JSON value and callers assume a dict.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B1/repro_stream.py` case 3: arguments `[]` raise `AttributeError: 'list' object has no attribute 'items'`.
- **Impact**: A malformed tool call from the model ends the reply with an error.
- **Suggested fix** (approach only): Treat any non-dict as unparseable in both places.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-40, package B1); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-41: A Responses API `response.failed` event is shown live but not saved, so the reply looks successful after reload

Issue: #167. Severity: Low. Area: backend. Status: Confirmed. Package: B1.

- **Location**: [`apps/server/local_llm/utils/middleware.py:4980-4986`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L4980-L4986); [`apps/server/local_llm/utils/middleware.py:811-812`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L811-L812)
- **Description**: The `response.failed` branch emits the error but never calls `_save_error` (the chat-completions path does); the message is then saved `done: true` with no error. An empty error object is not even emitted.
- **Root cause**: The Responses API failure branch emits but does not persist the error.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B1/repro_stream.py` case 4. Only for connections using the Responses API.
- **Impact**: Failed replies look complete after reload.
- **Suggested fix** (approach only): Call `_save_error` in that branch; handle an empty error object.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-41, package B1); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-42: Task-model JSON is located with rfind('{'), so generated search queries or prompts containing a brace are mangled

Issue: #168. Severity: Low. Area: backend. Status: Confirmed. Package: B1.

- **Location**: [`apps/server/local_llm/utils/middleware.py:1438`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L1438); [`apps/server/local_llm/utils/middleware.py:1816`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L1816); [`apps/server/local_llm/utils/middleware.py:1926`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L1926)
- **Description**: The JSON object is taken from the last `{`, so a brace inside a string value breaks parsing and the fallback uses the sliced fragment as the query. `_task_reply_json` (line 3747) already uses `find('{')`.
- **Root cause**: JSON extraction uses `rfind('{')`.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B1/repro_misc.py` case (c): `{"queries": ["python {set} comprehension syntax"]}` sends `['{set} comprehension syntax"]}']` to the search engine.
- **Impact**: Wrong web-search and retrieval queries, wrong image prompts.
- **Suggested fix** (approach only): Use `find('{')` / `json.JSONDecoder.raw_decode`, or reuse `_task_reply_json`.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-42, package B1); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-43: Connected MCP clients leak when listing tools fails or a later tool-setup step raises

Issue: #169. Severity: Medium. Area: backend. Status: Suspected. Package: B1+B4.

- **Location**: [`apps/server/local_llm/utils/middleware.py:2260-2273`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L2260-L2273); [`apps/server/local_llm/utils/middleware.py:2662-2673`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L2662-L2673); [`apps/server/local_llm/utils/middleware.py:2708-2720`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L2708-L2720); [`apps/server/local_llm/utils/middleware.py:2726`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L2726); [`apps/server/local_llm/utils/middleware.py:2770`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L2770); [`apps/server/local_llm/utils/middleware.py:2872-2881`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L2872-L2881); [`apps/server/local_llm/main.py:1549-1552`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/main.py#L1549-L1552); [`apps/server/local_llm/utils/mcp/client.py:84-87`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/mcp/client.py#L84-L87)
- **Description**: `connect_mcp_server` does not disconnect when `list_tool_specs()` fails after a successful connect, and the client is stored in `mcp_clients` only after it returns; `metadata['mcp_clients']` is set only after `get_tools`, `_add_terminal_tools` (which can raise 503) and `_add_direct_server_tools`. `main.py` disconnects only what is in metadata, so in both cases the httpx client, the streamable-HTTP task group and the session are never closed.
- **Root cause**: Clients are registered for cleanup only after every later setup step succeeds.
- **Trigger / reproduction**: A configured MCP server whose tools/list fails, or an unavailable terminal while MCP servers are connected. Not run (no MCP server available).
- **Impact**: Sockets and anyio tasks accumulate with each affected chat turn.
- **Suggested fix** (approach only): Disconnect on any failure after connect inside `connect_mcp_server`; register clients in metadata as soon as they connect, or clean up in try/finally.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #175
- **Confidence**: Suspected (high): the code path is clear from reading; not run.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-43, package B1+B4); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-44: One failing notification webhook stops delivery to the user's other notification targets

Issue: #170. Severity: Medium. Area: backend. Status: Confirmed. Package: B4.

- **Location**: [`apps/server/local_llm/utils/notifications.py:395-406`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/notifications.py#L395-L406); [`apps/server/local_llm/utils/notifications.py:259-260`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/notifications.py#L259-L260)
- **Description**: The per-user try wraps the whole target loop and `_send_webhook` raises on failure, so the first failing target ends delivery for every later target.
- **Root cause**: The try/except wraps the whole per-user target loop instead of each target.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B4/repro_notify.py`: two enabled targets, the first down; only `https://broken.example/hook` is attempted.
- **Impact**: One dead Slack/Discord hook silently suppresses all other notification channels for that user.
- **Suggested fix** (approach only): Move the try/except inside the `for target` loop.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-44, package B4); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-45: Recurring calendar occurrences that start before the viewed range are dropped, unlike one-off events with the same times

Issue: #171. Severity: Medium. Area: backend. Status: Confirmed. Package: B4+B8.

- **Location**: [`apps/server/local_llm/utils/calendar.py:44`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/calendar.py#L44); [`apps/server/local_llm/utils/calendar.py:69`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/calendar.py#L69); [`apps/server/local_llm/models/calendar.py:562-571`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/calendar.py#L562-L571); [`apps/server/local_llm/utils/calendar.py:64-77`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/calendar.py#L64-L77)
- **Description**: Expansion keeps only occurrences that start inside the range (`instance_start_ns >= range_start_ns`) and scans back only one day; one-off events use overlap semantics (`end_at > start`).
- **Root cause**: Expansion keeps occurrences by start time instead of overlap.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B4/repro_pure.py` section 3: weekly Fri 18:00-Sun 18:00 has 0 instances in a Saturday view; a daily 23:00-01:00 event loses the occurrence overlapping 00:00-01:00. B8 repro `docs/audit/repro/gap/B8/recurring_overlap.py`: a weekly Sat 22:00-Sun 02:00 event viewed from Sunday 00:00 omits the overlapping occurrence.
- **Impact**: Multi-day and past-midnight repeating events vanish from day, week and month views that begin mid-occurrence.
- **Suggested fix** (approach only): Keep occurrences with start < range_end and start + duration > range_start; scan back by at least the event duration.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #176
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-45, package B4+B8); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-46: One invalid chat-variable value silently blanks every chat variable in the system prompt

Issue: #172. Severity: Low. Area: backend. Status: Confirmed. Package: B4.

- **Location**: [`apps/server/local_llm/utils/chat_variables.py:243-253`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/chat_variables.py#L243-L253); [`apps/server/local_llm/utils/chat_variables.py:269-272`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/chat_variables.py#L269-L272); [`apps/server/local_llm/utils/payload.py:25-30`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/payload.py#L25-L30); [`apps/server/local_llm/main.py:1139-1143`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/main.py#L1139-L1143); [`apps/server/local_llm/routers/chats.py:1066-1075`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/chats.py#L1066-L1075)
- **Description**: Rendering validates the whole set and on any `ChatVariablesError` uses `{}`, so every `{{chat.variables.*}}` renders empty with no log. Values are never validated when stored, so a select value later removed from the model's options breaks older chats.
- **Root cause**: Variables are validated as a set and any error discards the whole set.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B4/repro_pure.py` section 4: `level='a'` renders `Name: Ada; Level: a`; `level='c'` (not an option) renders `Name: ; Level: `.
- **Impact**: The model silently runs on a degraded system prompt.
- **Suggested fix** (approach only): Validate per field and drop (and log) only the offending variable; optionally validate on save.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-46, package B4); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-47: A filter's user valves leak to later filters through the shared `__user__` dict

Issue: #173. Severity: Low. Area: backend. Status: Confirmed. Package: B4.

- **Location**: [`apps/server/local_llm/utils/filter.py:135-156`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/filter.py#L135-L156)
- **Description**: Each filter's params reuse the caller's `__user__` object and `params['__user__']['valves'] = user_valves` mutates it, so a later filter without UserValves receives the earlier filter's valves (which may hold per-user secrets).
- **Root cause**: The `__user__` dict is shared and mutated across filters.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B4/repro_pure.py` section 6: filter B sees filter A's `UserValves`.
- **Impact**: Wrong valves applied; a plugin can read another plugin's per-user settings.
- **Suggested fix** (approach only): Give each filter a copy: `{**params['__user__'], 'valves': ...}`.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-47, package B4); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-48: Resolving a tool approval twice can run the tool twice

Issue: #174. Severity: Low. Area: backend. Status: Suspected. Package: B4.

- **Location**: [`apps/server/local_llm/utils/tool_approval.py:55-64`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/tool_approval.py#L55-L64); [`apps/server/local_llm/main.py:1868-1879`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/main.py#L1868-L1879); [`apps/server/local_llm/utils/middleware.py:3309-3316`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L3309-L3316)
- **Description**: The 409 check allows status `queued`; approve sets `queued` + `approved=True` without an output, and every resolve starts a resume that executes all `queued && approved` calls without output. Two resolves (two tabs, or approve then reject) before the first resume writes its output run the tool twice or append both a rejection and a real output.
- **Root cause**: The resolve endpoint treats `queued` as unresolved, and approval is not compare-and-set.
- **Trigger / reproduction**: Two clients resolve the same call_id concurrently (not run; needs the DB). The UI hides the buttons after the first click, so one tab is mostly safe.
- **Impact**: Duplicate side effects from tools.
- **Suggested fix** (approach only): Treat `approved is True` as resolved in the 409 check, or make approval a compare-and-set.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Suspected (medium): logic confirmed by reading; not run.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-48, package B4); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-49: Custom connection headers with user-name or file-name placeholders break MCP connections for non-ASCII values

Issue: #175. Severity: Low. Area: backend. Status: Confirmed. Package: B4.

- **Location**: [`apps/server/local_llm/utils/headers.py:137-151`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/headers.py#L137-L151); [`apps/server/local_llm/utils/headers.py:72`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/headers.py#L72); [`apps/server/local_llm/utils/tools.py:171`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/tools.py#L171); [`apps/server/local_llm/utils/mcp/client.py`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/mcp/client.py)
- **Description**: `parse_custom_headers` substitutes `{{USER_NAME}}`, `{{USER_GROUPS}}`, `{{FILE_NAME}}` raw (the user-info headers at line 72 are `quote()`d); the MCP client (httpx) raises `UnicodeEncodeError` for non-ASCII header values.
- **Root cause**: Header placeholders are substituted without encoding.
- **Trigger / reproduction**: An MCP connection header `X-User: {{USER_NAME}}` for a user named "Zoë": httpx raises UnicodeEncodeError (checked with the venv's httpx); the chat shows "Failed to connect to MCP server".
- **Impact**: MCP tools unavailable for users with non-ASCII names.
- **Suggested fix** (approach only): Percent-encode substituted values (or RFC 8187).
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-49, package B4); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-50: The calendar search tool returns unexpanded recurring events that push real in-range events out of the results

Issue: #176. Severity: High. Area: backend. Status: Confirmed. Package: B6.

- **Location**: [`apps/server/local_llm/tools/builtin.py:4184-4217`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/tools/builtin.py#L4184-L4217); [`apps/server/local_llm/tools/builtin.py:4128-4145`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/tools/builtin.py#L4128-L4145); [`apps/server/local_llm/models/calendar.py:577-579`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/calendar.py#L577-L579); [`apps/server/local_llm/routers/calendar.py:177-193`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/calendar.py#L177-L193)
- **Description**: `get_events_by_range` returns every recurring event regardless of range and expects the caller to expand them (the router uses `expand_recurring_event`); the tool does not, so the model sees each series' first-ever start as if in range, `total` counts them, `items[:count]` cuts real events, and `rrule` is not in the output.
- **Root cause**: The tool calls the range query without expanding recurring rows, unlike the router.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B6/repro_calendar.py`: ten weekly events created in 2020 plus one in-range event, searching 2026-10-14..21: `total = 11`, ten 2020 rows, the in-range event cut off.
- **Impact**: "What's on my calendar next week" is answered wrongly for anyone with recurring events.
- **Suggested fix** (approach only): Expand recurring rows with `expand_recurring_event(..., tz=user tz)` as the router does, then filter, sort and count; include `rrule`.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #171
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-50, package B6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-51: query_chat_files without a file id returns only the first attached file's chunks

Issue: #177. Severity: High. Area: backend. Status: Confirmed. Package: B6.

- **Location**: [`apps/server/local_llm/tools/builtin.py:2593-2611`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/tools/builtin.py#L2593-L2611); [`apps/server/local_llm/retrieval/utils.py:1685-1699`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/retrieval/utils.py#L1685-L1699)
- **Description**: Each file is queried separately with k=count; the tool concatenates sources in attachment order and returns `chunks[:count]`, so when the first file has `count` hits the others are never seen, despite the docstring promising a search of all attached files.
- **Root cause**: Sources are concatenated per file in attachment order and truncated without ranking.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B6/repro.py`: file A scores 0.27-0.31, file B 0.80-0.92; the tool returns five A chunks.
- **Impact**: Multi-file chats answer from the wrong document.
- **Suggested fix** (approach only): Flatten all chunks, sort by score (higher is better for pgvector), then slice; keep per-file order only in full-context mode.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-51, package B6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-52: Paging view_file / view_knowledge_file with line numbers skips content

Issue: #178. Severity: Medium. Area: backend. Status: Confirmed. Package: B6.

- **Location**: [`apps/server/local_llm/tools/builtin.py:2820-2842`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/tools/builtin.py#L2820-L2842); [`apps/server/local_llm/tools/builtin.py:2963-2988`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/tools/builtin.py#L2963-L2988)
- **Description**: `sliced` is replaced by the line-numbered string before `returned_chars` and `next_offset = offset + len(sliced)` are computed, so the prefixes inflate the offset and the next page starts past unread text.
- **Root cause**: The offset is computed from the line-numbered string instead of the raw slice.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B6/repro.py`: max_chars=80 gives next_offset 115 (raw slice ended at 80); page 2 starts at line 15, lines 11-14 never shown.
- **Impact**: The model silently misses parts of files it pages through.
- **Suggested fix** (approach only): Compute offsets from the raw slice before adding prefixes.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-52, package B6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-53: query_knowledge_files lets attached notes and internal hits crowd out more relevant external knowledge hits

Issue: #179. Severity: Medium. Area: backend. Status: Confirmed. Package: B6.

- **Location**: [`apps/server/local_llm/tools/builtin.py:3357-3382`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/tools/builtin.py#L3357-L3382); [`apps/server/local_llm/retrieval/external.py:300-321`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/retrieval/external.py#L300-L321)
- **Description**: Chunks are the full content of every attached note, then internal vector hits (already cut to `count`), then external hits, and the result is `chunks[:count]`: with `count` internal hits external bases never contribute, and with `count` notes no vector hit is returned.
- **Root cause**: Results are concatenated by source type and truncated without ranking.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B6/repro.py`: an external hit scoring 0.99 is dropped behind five 0.2 internal hits.
- **Impact**: Knowledge answers ignore the most relevant sources or fail entirely.
- **Suggested fix** (approach only): Merge internal and external hits by score before slicing and give notes their own budget.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-53, package B6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-54: One failing external knowledge base makes query_knowledge_files fail and discards every internal result

Issue: #180. Severity: Medium. Area: backend. Status: Confirmed. Package: B6.

- **Location**: [`apps/server/local_llm/tools/builtin.py:3369-3382`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/tools/builtin.py#L3369-L3382); [`apps/server/local_llm/retrieval/external.py:300-321`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/retrieval/external.py#L300-L321)
- **Description**: The external retrieval loop has no per-base try/except, so one disabled or unreachable external base (including one shared by someone else, in the default all-accessible mode) turns the whole call into `{'error': ...}`.
- **Root cause**: No per-source error isolation.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B6/repro.py`: with the connection disabled the tool returns `{'error': 'External knowledge connection is disabled'}` and the 5 internal hits are lost.
- **Impact**: Knowledge answers ignore the most relevant sources or fail entirely.
- **Suggested fix** (approach only): Wrap each external retrieval in try/except, log, and continue.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-54, package B6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-55: search_notes and search_chats apply date filters after fetching only the newest matches, so older ranges return nothing

Issue: #181. Severity: Medium. Area: backend. Status: Confirmed. Package: B6.

- **Location**: [`apps/server/local_llm/tools/builtin.py:1153-1175`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/tools/builtin.py#L1153-L1175); [`apps/server/local_llm/tools/builtin.py:1533-1551`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/tools/builtin.py#L1533-L1551); [`apps/server/local_llm/models/notes.py:269`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/notes.py#L269); [`apps/server/local_llm/models/chats.py:2101-2104`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L2101-L2104)
- **Description**: Both fetch the newest `count*3` matches ordered by `updated_at desc`, then filter by start/end in Python.
- **Root cause**: Date filters are applied in Python after a newest-first LIMIT.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B6/repro.py`: 15 recent matches plus 5 from last year, end_timestamp 300 days ago: both tools return `[]`.
- **Impact**: "Find my notes/chats about X from last year" reports nothing.
- **Suggested fix** (approach only): Push the date range into the SQL queries (add parameters to the model methods).
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-55, package B6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-56: Creating an event without a calendar picks the first shared calendar flagged default, which can be another user's

Issue: #182. Severity: Medium. Area: backend. Status: Confirmed. Package: B6.

- **Location**: [`apps/server/local_llm/tools/builtin.py:4277-4284`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/tools/builtin.py#L4277-L4284); [`apps/server/local_llm/models/calendar.py:310-333`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/calendar.py#L310-L333); [`apps/web/src/routes/calendar/calendarModel.ts:210-211`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/calendar/calendarModel.ts#L210-L211)
- **Description**: `get_calendars_by_user` returns owned and shared calendars by `created_at`; the tool (and the frontend's default) take the first with `is_default`, which is the owner's flag, so another user's earlier "Personal" calendar wins: read-only shares give "Access denied", writable shares silently receive the event.
- **Root cause**: `is_default` is the calendar owner's flag, but the lookup does not check ownership.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B6/repro_calendar.py`: with another user's default listed first, `create_calendar_event` returns `{'error': 'Access denied to this calendar'}`.
- **Impact**: Reminders fail or land in someone else's calendar.
- **Suggested fix** (approach only): Prefer `c.user_id == user_id and c.is_default`, then the first owned calendar, in both places.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-56, package B6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-57: Rescheduling an event never re-arms its reminder, and recurring events alert only once

Issue: #183. Severity: Medium. Area: backend. Status: Confirmed. Package: B6+B8+B3.

- **Location**: [`apps/server/local_llm/tools/builtin.py:4446-4469`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/tools/builtin.py#L4446-L4469); [`apps/server/local_llm/models/calendar.py:719-720`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/calendar.py#L719-L720); [`apps/server/local_llm/utils/automations.py:719-721`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/automations.py#L719-L721); [`apps/server/local_llm/utils/automations.py:749-752`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/automations.py#L749-L752); [`apps/server/local_llm/models/calendar.py:731-787`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/calendar.py#L731-L787); [`apps/web/src/routes/calendar/calendarModel.ts:206`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/calendar/calendarModel.ts#L206)
- **Description**: After an alert fires `meta.alerted_at` is set; updates merge `meta` and nothing clears it, and `_check_calendar_alerts` skips events with `alerted_at`. The poll also uses the series `start_at`, so recurring events alert only for their first occurrence.
- **Root cause**: Alert state is stored per event row, not per occurrence or start time.
- **Trigger / reproduction**: An event alerts at 14:50, is moved to tomorrow (tool or UI); no alert fires again.
- **Impact**: Missed reminders.
- **Suggested fix** (approach only): Clear `alerted_at` when `start_at` changes, or store and compare the alerted occurrence start; alert per occurrence for recurring events.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #268, #184
- **Confidence**: Confirmed by reading the update and poll code paths.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-57, package B6+B8+B3); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-58: Calendar reminders longer than 60 minutes fire 60 minutes before, although the tool offers them

Issue: #184. Severity: Low. Area: backend. Status: Confirmed. Package: B6.

- **Location**: [`apps/server/local_llm/tools/builtin.py:4389`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/tools/builtin.py#L4389); [`apps/server/local_llm/models/calendar.py:752-753`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/calendar.py#L752-L753)
- **Description**: The tool docstring offers e.g. 120 minutes, but the alert poll only fetches events starting within `max(default, 60 min)`.
- **Root cause**: The alert poll window is capped at 60 minutes.
- **Trigger / reproduction**: Create an event via the tool with alert_minutes=120: the alert fires 60 minutes before.
- **Impact**: Early-warning reminders arrive late.
- **Suggested fix** (approach only): Widen the poll window to the largest alert, or cap the tool at 60 and fix the docstring.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #183
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-58, package B6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-59: view_channel_thread returns user_name null for every reply not posted by a webhook

Issue: #185. Severity: Low. Area: backend. Status: Confirmed. Package: B6.

- **Location**: [`apps/server/local_llm/tools/builtin.py:2003-2013`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/tools/builtin.py#L2003-L2013); [`apps/server/local_llm/models/messages.py:229-244`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/messages.py#L229-L244); [`apps/server/local_llm/models/messages.py:261`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/messages.py#L261); [`apps/server/local_llm/routers/channels.py:1469-1482`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/channels.py#L1469-L1482)
- **Description**: `get_thread_replies_by_message_id` fills `user` only for webhooks; the router batch-loads users, the tool does not.
- **Root cause**: The model method resolves user info only for webhook messages.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B6/repro.py`: `_resolve_user_info(non-webhook) -> None`.
- **Impact**: The model cannot tell who said what in a thread.
- **Suggested fix** (approach only): Batch-load users as the router does.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-59, package B6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-60: Knowledge listing tools load every file's full text just to count files

Issue: #186. Severity: Low. Area: backend. Status: Confirmed. Package: B6.

- **Location**: [`apps/server/local_llm/tools/builtin.py:2075-2076`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/tools/builtin.py#L2075-L2076); [`apps/server/local_llm/tools/builtin.py:2135-2136`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/tools/builtin.py#L2135-L2136); [`apps/server/local_llm/tools/builtin.py:3073-3074`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/tools/builtin.py#L3073-L3074); [`apps/server/local_llm/models/knowledge.py:331-354`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/knowledge.py#L331-L354); [`apps/server/local_llm/models/knowledge.py:636-647`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/knowledge.py#L636-L647)
- **Description**: `Knowledges.get_files_by_id` selects whole File rows including extracted text for every base on the page, though `search_knowledge_bases` already returns `file_count`. `list_knowledge` also pages over a query with no ORDER BY.
- **Root cause**: The tool loads full File rows to count them.
- **Trigger / reproduction**: Code reading; cost grows with knowledge base size.
- **Impact**: Memory and DB time spent on a number already available; unstable paging.
- **Suggested fix** (approach only): Use `file_count` (or metadata-only queries) and add an ORDER BY before paging.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-60, package B6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-61: merge_system_messages keeps only the first text part of a list-content system message

Issue: #187. Severity: Medium. Area: backend. Status: Confirmed. Package: B2.

- **Location**: [`apps/server/local_llm/utils/misc.py:641-665`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/misc.py#L641-L665); [`apps/server/local_llm/utils/misc.py:248-258`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/misc.py#L248-L258); [`apps/server/local_llm/utils/middleware.py:179-182`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L179-L182); [`apps/server/local_llm/utils/middleware.py:3170`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L3170); [`apps/server/local_llm/utils/anthropic.py:158-172`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/anthropic.py#L158-L172)
- **Description**: Every chat completion ends in `merge_system_messages`, which rebuilds each system message from `get_content_from_message`, which returns only the first text part. Parts 2..n and `cache_control` are dropped.
- **Root cause**: `get_content_from_message` returns only the first text part.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B2/repro_system_merge.py`: an Anthropic `system` with two blocks becomes `'Block one: identity.'`; an OpenAI list system `[A, B]` becomes `'A'`.
- **Impact**: API clients (`/api/v1/messages`, `/api/chat/completions` with list content) silently lose most of their system prompt and its prompt caching. The web UI sends strings and is unaffected.
- **Suggested fix** (approach only): Join all text parts; pass a single system message through unchanged.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-61, package B2); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-62: The Anthropic-compatible endpoint reports upstream failures as a successful end_turn

Issue: #188. Severity: Medium. Area: backend. Status: Confirmed. Package: B2.

- **Location**: [`apps/server/local_llm/utils/anthropic.py:526-530`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/anthropic.py#L526-L530); [`apps/server/local_llm/utils/anthropic.py:659-660`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/anthropic.py#L659-L660); [`apps/server/local_llm/utils/anthropic.py:884-896`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/anthropic.py#L884-L896); [`apps/server/local_llm/utils/anthropic.py:403-425`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/anthropic.py#L403-L425)
- **Description**: An unknown finish_reason such as `error` maps to `end_turn`; a source-stream exception is logged and `close()` emits a normal `message_delta {stop_reason: end_turn}` + `message_stop`; a non-streaming body with `error` and no choices becomes an empty `end_turn` message. PR #87 deliberately keeps the stream well-formed, which is fine, but it marks failure as success.
- **Root cause**: Unknown finish reasons map to end_turn and stream exceptions close the stream normally.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B2/repro_anthropic_stream_error.py`: both the OpenRouter error chunk and a raising source end with `stop_reason: end_turn`; the non-stream error body converts to `content: [], stop_reason: end_turn`.
- **Impact**: Agentic clients accept truncated output as complete.
- **Suggested fix** (approach only): Emit Anthropic's `event: error` (`{type: error, error: {type: api_error, ...}}`), or at least not `end_turn`, when the chunk carries `error`/`finish_reason: error` or the source raises; return an error for the non-stream case.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #162
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-62, package B2); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-63: OpenAPI tool servers: body fields that share a name with a path or query parameter are removed from the body (regression from #117)

Issue: #189. Severity: Medium. Area: backend. Status: Confirmed. Package: B2.

- **Location**: [`apps/server/local_llm/utils/tools.py:1769-1774`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/tools.py#L1769-L1774); [`apps/server/local_llm/utils/tools.py:1214-1219`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/tools.py#L1214-L1219)
- **Description**: Since #117 a body field whose name matches a path/query parameter is dropped from the body, so `PUT /users/{id}` whose body schema requires `id` is sent without it.
- **Root cause**: The #117 parameter filter removes every parameter name from the body.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B2/repro_tool_server.py` against a local server: `PUT /users/u1 body {"name": "N"}`.
- **Impact**: Calls to standard OpenAPI tool servers fail or send the wrong data.
- **Suggested fix** (approach only): Drop a name from the body only when it is not a property of the request-body schema; send it in both places when it is in both.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-63, package B2); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-64: OpenAPI tool servers: header and cookie parameters are offered to the model but never sent

Issue: #190. Severity: Low. Area: backend. Status: Confirmed. Package: B2.

- **Location**: [`apps/server/local_llm/utils/tools.py:1180-1204`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/tools.py#L1180-L1204); [`apps/server/local_llm/utils/tools.py:1705-1723`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/tools.py#L1705-L1723); [`apps/server/local_llm/utils/tools.py:1771-1774`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/tools.py#L1771-L1774)
- **Description**: Header params become tool properties (required ones included), but `_route_params` handles only path and query; the comment claiming they go in the header or cookie is wrong. (Inherited.)
- **Root cause**: Parameter routing ignores header and cookie locations.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B2/repro_tool_server.py`: the server sees `x-api-version: None`.
- **Impact**: Calls to standard OpenAPI tool servers fail or send the wrong data.
- **Suggested fix** (approach only): Send `in: header` params as headers and `in: cookie` params as cookies.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-64, package B2); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-65: OpenAPI tool servers: an operation whose JSON body is an array produces an unusable tool

Issue: #191. Severity: Low. Area: backend. Status: Confirmed. Package: B2.

- **Location**: [`apps/server/local_llm/utils/tools.py:1220-1221`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/tools.py#L1220-L1221); [`apps/server/local_llm/utils/tools.py:1774-1777`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/tools.py#L1774-L1777)
- **Description**: The tool's parameters schema becomes `{type: array}` (not a valid function schema, and path/query params are discarded) and calls send `{"items": [...]}` instead of an array.
- **Root cause**: Array request bodies are used directly as the parameters schema.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B2/repro_tool_server.py`: `SPEC bulk_add {"type": "array"}`, server saw `{"items": ["a","b"]}`.
- **Impact**: Calls to standard OpenAPI tool servers fail or send the wrong data.
- **Suggested fix** (approach only): Wrap the array in an object property and unwrap it when sending.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-65, package B2); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-66: Without Redis, every tool-server and terminal-server lookup refetches every server spec

Issue: #192. Severity: Low. Area: backend. Status: Confirmed. Package: B2.

- **Location**: [`apps/server/local_llm/utils/tools.py:1246-1264`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/tools.py#L1246-L1264); [`apps/server/local_llm/utils/tools.py:1391-1412`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/tools.py#L1391-L1412); [`apps/server/local_llm/utils/tools.py:382`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/tools.py#L382); [`apps/server/local_llm/routers/tools.py:104`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/tools.py#L104); [`apps/server/local_llm/main.py:413`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/main.py#L413)
- **Description**: `get_tool_servers`/`get_terminal_servers` ignore the `app.state` cache filled at startup when `redis is None` and refetch on every call. This deployment has no Redis.
- **Root cause**: The in-process cache is ignored when Redis is absent.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B2/repro_tool_server_refetch.py`: 1 fetch at startup, 4 after three calls.
- **Impact**: A network round-trip per server on each chat and tools list; a transient failure silently drops that server's tools for the request.
- **Suggested fix** (approach only): Use the in-process cache when Redis is absent (it is already refreshed on config change).
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-66, package B2); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-67: Sub-agent limit -1 ("unlimited") breaks max_iterations and max_output

Issue: #193. Severity: Low. Area: backend. Status: Confirmed. Package: B2.

- **Location**: [`apps/server/local_llm/utils/subagents.py:271-281`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/subagents.py#L271-L281); [`apps/server/local_llm/utils/subagents.py:563-564`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/subagents.py#L563-L564); [`apps/server/local_llm/utils/middleware.py:5631`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L5631); [`apps/server/local_llm/utils/middleware.py:5656-5662`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L5656-L5662)
- **Description**: The docstring says -1 means unlimited, but only concurrency limits honour it: `max_output=-1` truncates every summary (`len(summary) > -1`), and `max_iterations=-1` makes the loop condition false so the sub-agent cannot make one tool call and errors.
- **Root cause**: Only the concurrency limits honour -1.
- **Trigger / reproduction**: Set SUBAGENTS_MAX_OUTPUT or SUBAGENTS_MAX_ITERATIONS to -1 (env or POST /api/v1/configs/subagents; the admin UI min prevents it).
- **Impact**: Sub-agents fail or return truncated output.
- **Suggested fix** (approach only): Treat -1 as unlimited for both, or reject it and fix the docstring.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed by tracing the arithmetic; no runtime repro (needs the DB).

Found by the gap review of the repository bug audit of `7a4088b` (finding A-67, package B2); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-68: Anthropic-to-OpenAI conversion drops top-level document and search_result blocks and ignores tool_choice none

Issue: #194. Severity: Low. Area: backend. Status: Confirmed. Package: B2.

- **Location**: [`apps/server/local_llm/utils/anthropic.py:255-286`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/anthropic.py#L255-L286); [`apps/server/local_llm/utils/anthropic.py:343-354`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/anthropic.py#L343-L354)
- **Description**: `_convert_message` handles text, thinking, image, tool_use and tool_result only (`_document_text` is used only inside tool results); `tool_choice {type: none}` maps to None so OpenAI's default `auto` applies.
- **Root cause**: The converter handles only five block types and maps `none` to omission.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B2/repro_anthropic_drops.py`: `[document "Revenue was 42.", text "What was revenue?"]` becomes just the text; tool_choice absent.
- **Impact**: API clients' documents silently vanish; tools are called when the client forbade them.
- **Suggested fix** (approach only): Convert top-level documents/search results with the existing helpers; map `none` to `"none"`.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-68, package B2); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-69: Deleting a knowledge directory with its contents leaves the files' chunks in the vector collection, so chat keeps answering from deleted files

Issue: #195. Severity: High. Area: backend. Status: Confirmed. Package: B8.

- **Location**: [`apps/server/local_llm/models/knowledge.py:1003-1041`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/knowledge.py#L1003-L1041); [`apps/server/local_llm/models/knowledge.py:1059-1069`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/knowledge.py#L1059-L1069); [`apps/server/local_llm/routers/knowledge.py:2302-2341`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/knowledge.py#L2302-L2341); [`apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:265`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx#L265); [`apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:487`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx#L487); [`apps/server/local_llm/routers/knowledge.py:1637-1655`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/knowledge.py#L1637-L1655)
- **Description**: With `move_files=false` (the UI default: the "delete contents" checkbox starts checked), `_delete_files_in_subtree` deletes only `knowledge_file` link rows. Unlike the single-file remove and sync cleanup, it never deletes the vectors (by `file_id`/`hash`) or the File rows. Retrieval searches the whole collection named after the knowledge base, and deleting the file later cannot fix it because the link is already gone.
- **Root cause**: The directory delete path removes link rows only and does not run the file removal path.
- **Trigger / reproduction**: Create a directory, upload files into it, delete it with the default checkbox, then ask about those files: their chunks are still retrieved (traced in code; no vector DB here).
- **Impact**: Deleted documents keep feeding answers and cannot be found or removed from the UI; only a reindex clears them.
- **Suggested fix** (approach only): Collect the subtree's file ids before deleting and run the single-file remove path for each (vectors by file_id and hash, File rows under the same retention rule).
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed by tracing the delete path, the UI default and retrieval (not run end to end).

Found by the gap review of the repository bug audit of `7a4088b` (finding A-69, package B8); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-70: Every chat save re-adds a continued reply's usage to its chat_message row, inflating stored token usage without bound

Issue: #196. Severity: Medium. Area: backend. Status: Confirmed. Package: B8.

- **Location**: [`apps/server/local_llm/models/chat_messages.py:243-246`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chat_messages.py#L243-L246); [`apps/server/local_llm/models/chat_messages.py:297-323`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chat_messages.py#L297-L323); [`apps/server/local_llm/models/chats.py:942-948`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L942-L948); [`apps/server/local_llm/models/chats.py:988-1009`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L988-L1009); [`apps/server/local_llm/models/chats.py:1144`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L1144); [`apps/server/local_llm/routers/chats.py:1077-1081`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/chats.py#L1077-L1081); [`apps/server/local_llm/utils/middleware.py:4711`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L4711); [`apps/server/local_llm/utils/middleware.py:5546-5565`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L5546-L5565); [`apps/web/src/lib/chat/request.ts:212`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/chat/request.ts#L212)
- **Description**: The chat_message upsert merges incoming usage into the stored row instead of replacing it. After a continue (which starts with `self.usage=None`, so the JSON holds only the continuation's usage), the JSON and the row disagree, and every later chat save (title rename, param change, history save) reconciles all messages and adds the JSON usage again. Distinct from A-30 (per-chunk merge inside one stream).
- **Root cause**: The chat_message upsert merges usage instead of replacing it, and continue starts from zero usage.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B8/usage_merge.py` (real static methods in call order): total_tokens 150 after reply, 330 after continue, 510 and 690 after two chat saves; the JSON holds 180.
- **Impact**: Admin Analytics token totals, the user usage summary and per-message usage are inflated; the chat JSON under-counts after a continue.
- **Suggested fix** (approach only): Overwrite usage on upsert (last writer wins) and accumulate only in the middleware, seeding `self.usage` from the stored message on continue.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #155
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-70, package B8); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-71: The Knowledge page's "local" source filter matches no knowledge base created in the app

Issue: #197. Severity: Medium. Area: backend. Status: Confirmed. Package: B8.

- **Location**: [`apps/server/local_llm/models/knowledge.py:206-218`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/knowledge.py#L206-L218); [`apps/server/local_llm/models/knowledge.py:296-302`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/knowledge.py#L296-L302); [`apps/web/src/routes/workspace/knowledge/KnowledgePage.tsx:83-95`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/knowledge/KnowledgePage.tsx#L83-L95); [`apps/web/src/routes/workspace/knowledge/KnowledgePage.tsx:212`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/knowledge/KnowledgePage.tsx#L212)
- **Description**: `insert_new_knowledge` passes `meta=None`, which the JSON column stores as JSON `null` (not SQL NULL); the filter `meta IS NULL OR meta->>'source' != 'external'` is then NULL for those rows.
- **Root cause**: JSON null is stored for meta and the filter tests SQL NULL.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B8/kb_source_local.py` (SQLite, row built as insert does): stored meta `'null'`, 0 rows match local of 1; the Postgres SQL has the same shape.
- **Impact**: Choosing "local" lists nothing.
- **Suggested fix** (approach only): Use `coalesce(meta->>'source', '') != 'external'`, or declare the column `JSON(none_as_null=True)` for new rows.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed on SQLite; Postgres by identical SQL semantics.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-71, package B8); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-72: The Analytics 24-hour chart ignores the group filter

Issue: #198. Severity: Low. Area: backend. Status: Confirmed. Package: B8.

- **Location**: [`apps/server/local_llm/routers/analytics.py:208-209`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/analytics.py#L208-L209); [`apps/server/local_llm/models/chat_messages.py:1012-1053`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chat_messages.py#L1012-L1053); [`apps/web/src/routes/admin/analytics/Analytics.tsx:134-139`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/analytics/Analytics.tsx#L134-L139)
- **Description**: The hourly branch calls `get_hourly_message_counts_by_model` without `group_id`, and the method has no such parameter, while the frontend sends `groupId` with `granularity=hourly`.
- **Root cause**: The hourly query has no group parameter.
- **Trigger / reproduction**: Analytics with a group selected and period "Last 24 hours": the chart counts every user.
- **Impact**: Misleading analytics for the 24-hour view.
- **Suggested fix** (approach only): Add `group_id` to the hourly query (same GroupMember subquery as daily) and pass it through.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-72, package B8); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-73: Paginated listings (users, group members, models, feedback) have no deterministic ORDER BY, so pages can repeat or skip rows

Issue: #199. Severity: Low. Area: backend. Status: Suspected. Package: B8+F3+F2.

- **Location**: [`apps/server/local_llm/models/users.py:331-354`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/users.py#L331-L354); [`apps/server/local_llm/routers/users.py:115`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/users.py#L115); [`apps/server/local_llm/routers/users.py:170`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/users.py#L170); [`apps/server/local_llm/routers/channels.py:563`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/channels.py#L563); [`apps/server/local_llm/models/models.py:398-418`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/models.py#L398-L418); [`apps/web/src/routes/workspace/models/ModelsPage.tsx:226-238`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/models/ModelsPage.tsx#L226-L238); [`apps/server/local_llm/models/feedbacks.py:230-262`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/feedbacks.py#L230-L262); [`apps/web/src/routes/admin/users/UserList.tsx:62-66`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/users/UserList.tsx#L62-L66); [`apps/web/src/routes/admin/users/GroupUsers.tsx:71-77`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/users/GroupUsers.tsx#L71-L77)
- **Description**: Sorting by a non-unique column (e.g. role) uses ORDER BY that column with OFFSET/LIMIT and no `User.id` tiebreaker; filtered and channel member listings without a sort are unordered. The same holds for `search_models` (no ORDER BY when a filter is present without `order_by`, which the Models page bulk actions use through `fetchAll(null, null)`, so a repeated row is toggled twice) and for feedback sorts without an id tiebreaker. Knowledge search and the chat list already add an id tiebreaker.
- **Root cause**: ORDER BY columns are not unique and no primary-key tiebreaker is appended.
- **Trigger / reproduction**: Page through users sorted by role (not run; depends on the Postgres plan).
- **Impact**: Duplicate or missing users across pages.
- **Suggested fix** (approach only): Append the primary key to every ORDER BY used with OFFSET paging (users, group members, models, feedback) and give filtered queries a default order.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #205, #154
- **Confidence**: Suspected (high): SQL as written is nondeterministic; whether rows repeat depends on the plan.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-73, package B8+F3+F2); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-74: Clearing a custom number parameter in chat controls stores "" and every later request sends it upstream as the value

Issue: #200. Severity: Medium. Area: web. Status: Confirmed. Package: F8.

- **Location**: [`apps/web/src/components/common/AdvancedParams.tsx:49`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/components/common/AdvancedParams.tsx#L49); [`apps/web/src/components/common/AdvancedParams.tsx:91`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/components/common/AdvancedParams.tsx#L91); [`apps/web/src/routes/chat/ChatControls.tsx:79`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/ChatControls.tsx#L79); [`apps/web/src/lib/chat/request.ts:192-196`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/chat/request.ts#L192-L196); [`apps/server/local_llm/utils/payload.py:118-121`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/payload.py#L118-L121)
- **Description**: The port maps an empty number box to `""` (the original's `bind:value` gave `null`, meaning Default). The model editor, personal settings, admin task params and Playground strip `""` before saving, but chat controls do not: it is saved to the chat, spread over the user's personal params, and the backend copies any non-None value into the upstream body.
- **Root cause**: An empty number box is stored as "" rather than null, and chat params are not stripped before sending.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F8/advparams-empty.test.tsx` and `docs/audit/repro/gap/F8/payload_empty.py`: after clearing temperature and seed the request carries `{"temperature": "", "seed": ""}` (overriding a saved 0.2) and the backend body has `temperature: ''`, `seed: ''`.
- **Impact**: Every later message in that chat sends non-numeric parameters to OpenRouter or llama-server (likely rejected; not tested live) and the user's saved defaults are silently overridden.
- **Suggested fix** (approach only): Map an empty number box to `null`, or strip `""`/`null` in `completionBody` and when chat params are saved.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #247, #248, #237
- **Confidence**: Confirmed up to the upstream request body; provider rejection suspected (high).

Found by the gap review of the repository bug audit of `7a4088b` (finding A-74, package F8); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-75: A numeric enum valve sends its option as a string, so the backend rejects the save

Issue: #201. Severity: Low. Area: web. Status: Confirmed. Package: F8.

- **Location**: [`apps/web/src/components/common/Valves.tsx:111-119`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/components/common/Valves.tsx#L111-L119); [`apps/server/local_llm/routers/tools.py:832-834`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/tools.py#L832-L834)
- **Description**: `<select>` onChange stores `e.target.value` (a string); the original kept the option's JS value. A `Literal[1, 2, 3]` valve sends `"2"` and pydantic rejects it.
- **Root cause**: The select stores the DOM string value instead of the enum value.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F8/valves-enum.test.tsx` (onChange receives `{n: '2'}` for `{'enum': [1,2,3], 'type': 'integer'}`); `V(n='2')` raises `literal_error`.
- **Impact**: Plugins with int/float Literal valves cannot be configured from the Valves dialog.
- **Suggested fix** (approach only): Map the selected value back to the original `p.enum` entry before `set`.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-75, package F8); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-76: The note access dialog lost the original's permission props: no write grants, and a Public option that is silently stripped while the UI shows it applied

Issue: #202. Severity: Medium. Area: web. Status: Confirmed. Package: F8.

- **Location**: [`apps/web/src/routes/notes/NoteEditorPage.tsx:200-203`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/notes/NoteEditorPage.tsx#L200-L203); [`apps/web/src/routes/notes/NoteEditorPage.tsx:224-230`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/notes/NoteEditorPage.tsx#L224-L230); [`apps/web/src/components/common/AccessControlModal.tsx:11-15`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/components/common/AccessControlModal.tsx#L11-L15); [`apps/server/local_llm/routers/notes.py:643-649`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/notes.py#L643-L649)
- **Description**: The original (`d863707:apps/openwebui/src/lib/components/notes/NoteEditor.svelte:972-978`) passed `accessRoles={['read','write']}` and the `share`/`sharePublic`/`shareUsers` permission gates; the port passes none, so the modal defaults apply: read only, and Public and user sharing offered to everyone. The server strips grants the user may not set, but `saveAccess` caches the grants it sent and ignores the response, so the note shows as public while stored private.
- **Root cause**: The port omitted the permission props the original passed and caches sent grants instead of the response.
- **Trigger / reproduction**: As a non-admin without `sharing.public_notes`, set a note to Public: the UI shows "Accessible to all users"; the server stores it private. Write cannot be granted at all. (Both sides quoted; no browser run.)
- **Impact**: Notes look shared when they are not; collaborators cannot be given write access.
- **Suggested fix** (approach only): Pass the same four props as the original and update the cache from the response.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-76, package F8); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-77: Leaderboard Elo ratings depend on database row order rather than time

Issue: #203. Severity: Medium. Area: backend. Status: Confirmed. Package: F4+B9.

- **Location**: [`apps/server/local_llm/models/feedbacks.py:315-319`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/feedbacks.py#L315-L319); [`apps/server/local_llm/routers/evaluations.py:79-126`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/evaluations.py#L79-L126); [`apps/server/local_llm/routers/evaluations.py:221-227`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/evaluations.py#L221-L227)
- **Description**: Elo is applied one result at a time, but the leaderboard query `select(Feedback.id, Feedback.data)` has no ORDER BY, so editing one feedback (a new row version) or a table rewrite reorders rows and changes every rating.
- **Root cause**: The leaderboard query has no ORDER BY and Elo is order dependent.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F4/elo_repro.py`: the same verdicts give `{A: 996, B: 987, C: 1017}` in insertion order and `{A: 1004, B: 983, C: 1013}` reversed; `A>B then B>A` vs the reverse flips the ranking.
- **Impact**: Ratings and ranks shift with no new data.
- **Suggested fix** (approach only): Order the query by `created_at, id`.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #278, #204
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-77, package F4+B9); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-78: Topic-weighted Elo uses raw cosine similarity, so a negative weight reverses a result

Issue: #204. Severity: Low. Area: backend. Status: Suspected. Package: F4+B9.

- **Location**: [`apps/server/local_llm/routers/evaluations.py:109`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/evaluations.py#L109); [`apps/server/local_llm/routers/evaluations.py:116-117`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/evaluations.py#L116-L117); [`apps/server/local_llm/routers/evaluations.py:189-198`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/evaluations.py#L189-L198)
- **Description**: With a leaderboard search query, each feedback is weighted by the query/tag cosine similarity, which can be negative; a negative weight makes the winner lose points.
- **Root cause**: Similarity weights are used unclamped.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F4/elo_repro.py`: weight 1.0 gives `{A: 1016, B: 984}`, weight -0.2 gives `{A: 997, B: 1003}`.
- **Impact**: Search-filtered leaderboards can invert results.
- **Suggested fix** (approach only): Clamp the weight to `max(0, sim)`.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #203
- **Confidence**: Suspected (about 40%): the function behaviour is confirmed; whether the embedding model returns negative similarities for real tags is unverified (log `similarities` for an unrelated search).

Found by the gap review of the repository bug audit of `7a4088b` (finding A-78, package F4+B9); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-79: Sorting the Feedback table by User sends a key the backend ignores, leaving pages unordered

Issue: #205. Severity: Low. Area: web. Status: Confirmed. Package: F4.

- **Location**: [`apps/web/src/routes/admin/evaluations/Feedbacks.tsx:35`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/evaluations/Feedbacks.tsx#L35); [`apps/web/src/routes/admin/evaluations/Feedbacks.tsx:62-64`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/evaluations/Feedbacks.tsx#L62-L64); [`apps/web/src/lib/apis/evaluations/index.ts:168`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/apis/evaluations/index.ts#L168); [`apps/server/local_llm/models/feedbacks.py:238`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/feedbacks.py#L238); [`apps/server/local_llm/models/feedbacks.py:260`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/feedbacks.py#L260)
- **Description**: The column key is `'user'`; the backend recognises only `'username'`, and the `created_at` default applies only without a filter, so the query has no ORDER BY and OFFSET paging can repeat or skip rows. Other sorts lack an id tiebreaker. (Inherited from the Svelte page.)
- **Root cause**: The frontend column key 'user' does not match the backend's 'username'.
- **Trigger / reproduction**: Admin > Evaluations > Feedback, sort by User.
- **Impact**: Wrong order and unstable pages.
- **Suggested fix** (approach only): Use matching names and add `Feedback.id` as a secondary sort key.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #199
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-79, package F4); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-80: A ?redirect= value with a control character passes safeRedirect, and the signed-in user is left on the sign-in form

Issue: #206. Severity: Low. Area: web. Status: Confirmed. Package: F4.

- **Location**: [`apps/web/src/lib/auth/redirect.ts:8-10`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/auth/redirect.ts#L8-L10); [`apps/web/src/routes/public/AuthPage.tsx:62`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/public/AuthPage.tsx#L62); [`apps/web/src/routes/public/AuthPage.tsx:79-81`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/public/AuthPage.tsx#L79-L81); [`apps/web/src/routes/public/AuthPage.tsx:138`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/public/AuthPage.tsx#L138); [`apps/web/src/routes/public/AuthPage.tsx:157`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/public/AuthPage.tsx#L157)
- **Description**: `safeRedirect` rejects only `//` and `/\`; `/%09/evil.example` decodes to `"/\t/evil.example"`, which URL parsing resolves to `http://evil.example/`. react-router refuses the external navigation (so this is not an open redirect), but `navigate()` is not awaited, the rejection is unhandled, and the user stays on the sign-in form after the session is set.
- **Root cause**: `safeRedirect` checks a denylist of prefixes instead of resolving the URL.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F4/redirect.test.ts`: `safeRedirect -> "/\t/evil.example/x"`, `URL -> http://evil.example/x`, `navigate -> Error: External navigation is not allowed`.
- **Impact**: A crafted link signs the user in but strands them on the form with no message.
- **Suggested fix** (approach only): Resolve with `new URL(target, location.origin)` and accept only same-origin results (or reject control characters and backslashes); handle the navigate promise.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-80, package F4); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-81: Playground Cancel and leaving the page cannot abort a request before response headers arrive

Issue: #207. Severity: Low. Area: web. Status: Confirmed. Package: F4.

- **Location**: [`apps/web/src/routes/playground/PlaygroundPages.tsx:114-128`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/playground/PlaygroundPages.tsx#L114-L128); [`apps/web/src/lib/apis/openai/index.ts:378-399`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/apis/openai/index.ts#L378-L399)
- **Description**: `controller.current` is assigned only after `await chatCompletion(...)`, which awaits `fetch` before returning the controller; until headers arrive Cancel and the unmount cleanup abort nothing.
- **Root cause**: The controller is created inside the API helper after the fetch resolves.
- **Trigger / reproduction**: Start a Playground request against a slow server (e.g. local prompt processing) and press Cancel or navigate away.
- **Impact**: Generation continues after the user cancelled or left.
- **Suggested fix** (approach only): Create the AbortController before the fetch and pass its signal in.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-81, package F4); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-82: Playground parameters are spread at the top level of the request, so custom parameters never apply and app-only keys reach the provider

Issue: #208. Severity: Low. Area: web. Status: Confirmed. Package: F4.

- **Location**: [`apps/web/src/routes/playground/playgroundModel.ts:66-81`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/playground/playgroundModel.ts#L66-L81); [`apps/web/src/routes/playground/PlaygroundPages.tsx:184`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/playground/PlaygroundPages.tsx#L184); [`apps/server/local_llm/utils/payload.py:85-113`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/payload.py#L85-L113); [`apps/server/local_llm/main.py:1093`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/main.py#L1093); [`apps/server/local_llm/routers/openai.py:1642`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/openai.py#L1642)
- **Description**: `chatRequest` spreads params into the body; the backend only processes `form_data['params']`, so `custom_params` is forwarded as an unknown nested field and keys like `function_calling`, `reasoning_tags`, `stream_response` reach the provider raw. (Inherited from Svelte.)
- **Root cause**: Playground params are spread into the body instead of nested under `params`.
- **Trigger / reproduction**: Set a custom parameter in Playground controls and inspect the upstream body (traced).
- **Impact**: Custom parameters silently ignored; unexpected fields sent upstream.
- **Suggested fix** (approach only): Send `params: {...}` like the chat page.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-82, package F4); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-83: Functions "Import JSON" reports success even when every create failed

Issue: #209. Severity: Low. Area: web. Status: Confirmed. Package: F4.

- **Location**: [`apps/web/src/routes/admin/functions/FunctionsPage.tsx:207-214`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/functions/FunctionsPage.tsx#L207-L214)
- **Description**: Each create failure is caught and becomes null, then "Functions imported successfully" is shown unconditionally. (Inherited.)
- **Root cause**: Per-item failures are caught and the success toast is unconditional.
- **Trigger / reproduction**: Re-import an export whose ids already exist: N error toasts, then a success toast.
- **Impact**: Misleading feedback.
- **Suggested fix** (approach only): Count successes and report "imported k of n" or an error.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-83, package F4); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-84: A /notes?title=&content= link whose note creation fails leaves an endless spinner

Issue: #210. Severity: Low. Area: web. Status: Confirmed. Package: F4.

- **Location**: [`apps/web/src/routes/notes/NotesPage.tsx:74-82`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/notes/NotesPage.tsx#L74-L82); [`apps/web/src/routes/notes/NotesPage.tsx:149-155`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/notes/NotesPage.tsx#L149-L155)
- **Description**: `createNote(...).then(...)` has no catch and does not handle an undefined id; `creating` is derived from the URL, so on failure the spinner never ends. `NewNote` (lines 401-410) handles both.
- **Root cause**: The create promise has no rejection or undefined-id handling.
- **Trigger / reproduction**: Open the link without notes permission or with the server failing.
- **Impact**: Stuck page, unhandled rejection.
- **Suggested fix** (approach only): Add the catch and undefined-id handling with a toast and a replace-navigation to /notes.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-84, package F4); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-85: Editing a reply or "Save As Copy" changes only what is displayed; the model keeps receiving the original text

Issue: #211. Severity: High. Area: web. Status: Confirmed. Package: F1.

- **Location**: [`apps/web/src/lib/chat/history.ts:470-493`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/chat/history.ts#L470-L493); [`apps/web/src/lib/chat/history.ts:424`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/chat/history.ts#L424); [`apps/web/src/lib/chat/history.ts:270-271`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/chat/history.ts#L270-L271); [`apps/web/src/routes/chat/useChatSession.ts:565`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useChatSession.ts#L565); [`apps/web/src/routes/chat/useChatSession.ts:604`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useChatSession.ts#L604); [`apps/server/local_llm/utils/middleware.py:2069`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L2069); [`apps/server/local_llm/utils/middleware.py:2113-2133`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L2113-L2133)
- **Description**: `editContent` writes only `content`, but every streamed reply also has `output`, which `toApiMessages`, `runAction`, auto-copy and the server's `process_messages_with_output` prefer. The SvelteKit original (`ResponseMessage.svelte:389-436`, `Messages.svelte` editMessage) edited `output` itself and cleared `content`, including for Save As Copy.
- **Root cause**: Edits write `content` while every consumer prefers `output`.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F1/edit-output.test.ts`: after editing "41" to "42", `getOutputText` is still "41" and `toApiMessages` sends it; `docs/audit/repro/gap/F1/edit_output_backend.py`: the server replays `{role: assistant, content: "The answer is 41."}`.
- **Impact**: A user who corrects a reply before continuing sees the correction, but the model is silently given the uncorrected text.
- **Suggested fix** (approach only): When the message has `output`, rewrite it (one message item holding the edited text) or drop it on edit; same for Save As Copy.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-85, package F1); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-86: With the message queue off, sending while a reply streams does not stop that reply

Issue: #212. Severity: Medium. Area: web. Status: Confirmed. Package: F1.

- **Location**: [`apps/web/src/routes/chat/useChatSession.ts:436-441`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useChatSession.ts#L436-L441); [`apps/web/src/components/settings/interfaceSettingDefs.ts:143-146`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/components/settings/interfaceSettingDefs.ts#L143-L146); [`apps/web/src/routes/chat/ChatInput.tsx:409`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/ChatInput.tsx#L409)
- **Description**: The original ran `await stopResponse()` before sending (the setting's own description says "instead of interrupting active responses"); the port calls `send` directly, so the old task keeps streaming, the new prompt is attached under the half-written reply, and two tasks stream into the chat.
- **Root cause**: The interrupt (stop before send) step of the original was not ported.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F1/session.test.tsx` test 1: `stopTasksByChatId calls: 0 | new prompt parentId: A-a | old reply done: false`.
- **Impact**: Context built from a partial reply; two concurrent generations.
- **Suggested fix** (approach only): `await stop()` before `send` in that branch.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-86, package F1); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-87: A queued prompt is silently discarded when the reply it waited for fails with no content

Issue: #213. Severity: Medium. Area: web. Status: Confirmed. Package: F1.

- **Location**: [`apps/web/src/routes/chat/useChatSession.ts:447-453`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useChatSession.ts#L447-L453); [`apps/web/src/routes/chat/useChatSession.ts:393-396`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useChatSession.ts#L393-L396); [`apps/server/local_llm/main.py:1506-1530`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/main.py#L1506-L1530)
- **Description**: The queue effect pops the item before calling `send`, and `send` refuses when the current reply has an error and no content (the normal shape after a server-side failure). The original's `processNextInQueue` called `submitPrompt` without that check.
- **Root cause**: The queue item is removed before `send` decides whether to proceed.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F1/session.test.tsx` test 2: `queue after: [] | prompt in history: false | completion requests: 0`.
- **Impact**: The user's queued prompt and files are lost.
- **Suggested fix** (approach only): Keep (or re-queue) the item when `send` declines, or skip the check for queued sends.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-87, package F1); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-88: A reply whose done event was missed (socket drop, sleep, backend reload) stays "generating" forever

Issue: #214. Severity: Medium. Area: web. Status: Confirmed. Package: F1.

- **Location**: [`apps/web/src/lib/chat/history.ts:292-294`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/chat/history.ts#L292-L294); [`apps/web/src/routes/chat/useChatSession.ts:259-262`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useChatSession.ts#L259-L262); [`apps/web/src/lib/socket/SocketProvider.tsx`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/socket/SocketProvider.tsx)
- **Description**: `chat:active` with `active: false` only clears `taskIds`, and nothing handles socket reconnect. The original reloaded the chat on inactive with a pending leaf (`Chat.svelte:1220-1233`) and on reconnect when the server had no tasks (`:1513-1530`). Events emitted while the socket is down are lost, so the reply keeps partial content with `done: false`; a later save can then write that partial output over the complete one the server stored.
- **Root cause**: The reconnect and inactive reconciliation of the original were not ported.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F1/session.test.tsx` test 4: after `chat:active` false with no server tasks, `generating = true | reply done = false | extra getChatById calls = 0`.
- **Impact**: Stuck chat (Stop required) and possible overwrite of a completed reply with a partial one.
- **Suggested fix** (approach only): On inactive, reload the chat if the current leaf is not done; on reconnect, reload when a leaf is pending and the server reports no tasks.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed for the stuck state; the overwrite follows from `save()` sending in-memory history (traced, not run).

Found by the gap review of the repository bug audit of `7a4088b` (finding A-88, package F1); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-89: An async message action or rating that finishes while another chat loads saves the old chat's history into the new chat

Issue: #215. Severity: Medium. Area: web. Status: Confirmed. Package: F1.

- **Location**: [`apps/web/src/routes/chat/useChatSession.ts:618-628`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useChatSession.ts#L618-L628); [`apps/web/src/routes/chat/useChatSession.ts:668-673`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useChatSession.ts#L668-L673); [`apps/web/src/routes/chat/useChatSession.ts:490-499`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useChatSession.ts#L490-L499); [`apps/web/src/routes/chat/useChatSession.ts:217-233`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useChatSession.ts#L217-L233)
- **Description**: `runAction` and `rate` capture `historyRef.current`, await network calls, then `save(h)`, and `save` uses `chatIdRef.current` at save time. If the user opened chat B meanwhile, chat A's history is written into B. The original's `chatActionHandler` saved only if the chat id was unchanged.
- **Root cause**: Async actions save to the chat id current at save time, not the one they started in.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F1/session.test.tsx` test 3: `updateChatById calls: [["B",["A-u","A-a"]]]`.
- **Impact**: Chat B is overwritten with chat A's messages (data loss in a narrow race).
- **Suggested fix** (approach only): Capture the chat id at the start and bail or save to it explicitly; make `save` take the chat id.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-89, package F1); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-90: When the request fails in a multi-model chat, only the first column is marked failed and the input stays generating

Issue: #216. Severity: Low. Area: web. Status: Confirmed. Package: F1.

- **Location**: [`apps/web/src/routes/chat/useChatSession.ts:359-363`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useChatSession.ts#L359-L363); [`apps/web/src/lib/chat/history.ts:120-146`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/chat/history.ts#L120-L146)
- **Description**: The catch path fails only `primary`, while `addResponses` makes the last column current, so that column stays `done: false` and `isGenerating` stays true. The original also moved `currentId` to the failed primary.
- **Root cause**: The catch path fails only the primary target.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F1/session.test.tsx` test 5: second column `done: false`, current, `generating = true`.
- **Impact**: Stop is required after a failed multi-model send.
- **Suggested fix** (approach only): Fail every target (or move `currentId` to the primary).
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-90, package F1); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-91: Attachments and the typed draft carry over when switching chats

Issue: #217. Severity: Low. Area: web. Status: Confirmed. Package: F1.

- **Location**: [`apps/web/src/routes/chat/useAttachments.ts:68`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useAttachments.ts#L68); [`apps/web/src/routes/chat/ChatPage.tsx:194-196`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/ChatPage.tsx#L194-L196)
- **Description**: `useAttachments` state has no chat dependency and `ChatPage` stays mounted across `/c/:id`, so files attached in chat A are sent into chat B (their upload metadata names A); the typed text also survives. The original cleared both on navigation and restored per-chat drafts.
- **Root cause**: Attachment state is not keyed by chat.
- **Trigger / reproduction**: Attach a file in chat A, open chat B, send.
- **Impact**: Documents land in the wrong chat; queued prompts are lost.
- **Suggested fix** (approach only): Clear attachments and text on a route change, except when adopting a new chat id.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed by reading.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-91, package F1); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-92: Queued prompts are discarded when switching chats

Issue: #218. Severity: Low. Area: web. Status: Confirmed. Package: F1.

- **Location**: [`apps/web/src/routes/chat/useChatSession.ts:221`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useChatSession.ts#L221)
- **Description**: The route effect does `setQueue([])`. The original kept queues per chat, sent them when the user returned and moved them to a new chat id.
- **Root cause**: The queue is a single list reset on navigation.
- **Trigger / reproduction**: Queue prompts while a reply streams, open another chat, return: the queue is gone.
- **Impact**: Documents land in the wrong chat; queued prompts are lost.
- **Suggested fix** (approach only): Key the queue by chat id (or warn before dropping).
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed by reading.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-92, package F1); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-93: Image uploads to a non-vision model are no longer refused

Issue: #219. Severity: Low. Area: web. Status: Confirmed. Package: F1.

- **Location**: [`apps/web/src/routes/chat/useAttachments.ts:201-202`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useAttachments.ts#L201-L202)
- **Description**: The port only warns that the model is not vision capable and uploads anyway; the original refused and errored at send.
- **Root cause**: The capability check was downgraded to a warning.
- **Trigger / reproduction**: Attach an image with only non-vision models selected and send.
- **Impact**: Provider errors at send; raw HEIC uploads that cannot be displayed or scaled.
- **Suggested fix** (approach only): Restore the refusal (or block send).
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed by reading against `d863707` MessageInput.svelte and Chat.svelte.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-93, package F1); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-94: HEIC images are uploaded unconverted

Issue: #220. Severity: Low. Area: web. Status: Confirmed. Package: F1.

- **Location**: [`apps/web/src/routes/chat/useAttachments.ts:139-150`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useAttachments.ts#L139-L150)
- **Description**: `image/heic` is read as is (the original converted to JPEG); scaling silently fails and the raw HEIC is uploaded.
- **Root cause**: The conversion step was not ported.
- **Trigger / reproduction**: Attach a HEIC photo.
- **Impact**: Provider errors at send; raw HEIC uploads that cannot be displayed or scaled.
- **Suggested fix** (approach only): Restore HEIC conversion (or reject HEIC with a message).
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed by reading against `d863707` MessageInput.svelte and Chat.svelte.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-94, package F1); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-95: Saving a prompt with "Set as Production" unchecked still puts the new content live

Issue: #221. Severity: High. Area: backend. Status: Confirmed. Package: F2+B9.

- **Location**: [`apps/server/local_llm/models/prompts.py:509-524`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/prompts.py#L509-L524); [`apps/server/local_llm/models/prompts.py:547-550`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/prompts.py#L547-L550); [`apps/server/local_llm/models/prompts.py:441-475`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/prompts.py#L441-L475); [`apps/web/src/routes/workspace/prompts/PromptEditView.tsx:168`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/prompts/PromptEditView.tsx#L168); [`apps/web/src/routes/workspace/prompts/PromptEditView.tsx:185-194`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/prompts/PromptEditView.tsx#L185-L194); [`apps/web/src/routes/chat/ChatInput.tsx:143`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/ChatInput.tsx#L143)
- **Description**: `update_prompt_by_id` always assigns `prompt.content` (and name, command, tags) and commits; only `version_id` respects `is_production`. Slash commands read `prompt.content`, so the draft is used immediately while the history panel still marks the old version Live.
- **Root cause**: Row fields are assigned before and regardless of the `is_production` check.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B9/repro_prompts.py`: `version_id unchanged (still v1): True`, `content served for /sum: V2 draft`.
- **Impact**: Staging a draft is impossible; unpublished text is sent to the model.
- **Suggested fix** (approach only): With `is_production` false, write only the history entry and leave the prompt row unchanged.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #222, #223
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-95, package F2+B9); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-96: Switching the production prompt version reverts name and tags edited through the metadata path

Issue: #222. Severity: Low. Area: backend. Status: Confirmed. Package: B9.

- **Location**: [`apps/server/local_llm/models/prompts.py:556-583`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/prompts.py#L556-L583); [`apps/server/local_llm/models/prompts.py:606-613`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/prompts.py#L606-L613); [`apps/web/src/routes/workspace/prompts/PromptEditView.tsx:206-218`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/prompts/PromptEditView.tsx#L206-L218)
- **Description**: Restoring a version copies name, data, meta and tags from the snapshot (not the command), while `update_prompt_metadata` edits name, command and tags without history; the editor keeps showing the new values.
- **Root cause**: Version restore copies name and tags from the snapshot while metadata edits bypass snapshots.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B9/repro_prompt_meta_revert.py`: after rename and switching v1 then v2 live, the row has `Old name ... ['a']`.
- **Impact**: Renames and tag changes silently revert; the UI disagrees with the database.
- **Suggested fix** (approach only): Restore only content (and data/meta) from the snapshot, or snapshot metadata edits; refresh the editor after a switch.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #221
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-96, package B9); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-97: The prompt version diff endpoint is unreachable

Issue: #223. Severity: Low. Area: backend. Status: Confirmed. Package: F2+B9.

- **Location**: [`apps/server/local_llm/routers/prompts.py:636`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/prompts.py#L636); [`apps/server/local_llm/routers/prompts.py:729`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/prompts.py#L729); [`apps/web/src/lib/apis/prompts/index.ts:549`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/apis/prompts/index.ts#L549)
- **Description**: `/id/{prompt_id}/history/diff` is registered after `/id/{prompt_id}/history/{history_id}`, so `diff` is taken as a history id and returns 404. `getPromptDiff` has no caller, so nothing visible breaks.
- **Root cause**: Route registration order lets the history-entry route match first.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B9/repro_diff_route.py`: the first full match is the history-entry route with `history_id=diff`.
- **Impact**: Dead endpoint.
- **Suggested fix** (approach only): Register the diff route first, or delete it and its client.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-97, package F2+B9); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-98: Importing a model JSON over an existing model deletes its sharing grants, re-enables it, and replaces its meta

Issue: #224. Severity: Medium. Area: web. Status: Confirmed. Package: F2.

- **Location**: [`apps/web/src/routes/workspace/models/ModelsPage.tsx:285-292`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/models/ModelsPage.tsx#L285-L292); [`apps/web/src/routes/workspace/models/modelImport.ts:33-43`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/models/modelImport.ts#L33-L43); [`apps/web/src/lib/apis/models/index.ts:291-292`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/apis/models/index.ts#L291-L292); [`apps/server/local_llm/utils/access_control/__init__.py:234-235`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/access_control/__init__.py#L234-L235); [`apps/server/local_llm/models/models.py:183`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/models.py#L183); [`apps/server/local_llm/models/models.py:547-553`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/models.py#L547-L553); [`apps/server/local_llm/models/access_grants.py:452-458`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/access_grants.py#L452-L458)
- **Description**: For an existing id the page calls `updateModelById` with the sanitized model, which always has `access_grants: []` and no `is_active`; the backend replaces grants with none, defaults `is_active` to true, and overwrites meta. The original only updated `{info}`-wrapped entries (bare ones failed with ID taken), and the backend's own `/models/import` merges meta and keeps ACLs.
- **Root cause**: The import sanitizer always sends empty grants and omits is_active on the update path.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F2/f2-repro.test.tsx`: an exported model with `is_active:false` and a group grant produces an update body with `access_grants: []` and no `is_active`.
- **Impact**: Restoring an export silently unshares models and re-enables disabled ones.
- **Suggested fix** (approach only): Use the existing `importModels` client (`/models/import`), or omit `access_grants` and carry `is_active`.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-98, package F2); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-99: Bulk Enable/Disable/Show/Hide on the Models page act on read-only models and can wipe their params

Issue: #225. Severity: Medium. Area: web. Status: Confirmed. Package: F2.

- **Location**: [`apps/web/src/routes/workspace/models/ModelsPage.tsx:239-272`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/models/ModelsPage.tsx#L239-L272); [`apps/server/local_llm/routers/models.py:166-170`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/models.py#L166-L170); [`apps/server/local_llm/routers/models.py:192-193`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/models.py#L192-L193); [`apps/server/local_llm/routers/models.py:795`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/models.py#L795); [`apps/server/local_llm/models/models.py:547-549`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/models.py#L547-L549)
- **Description**: The bulk filters ignore `write_access` and send list rows (whose `params` is `{}` for read-only rows) as update bodies. Non-admins get error toasts; an admin with `BYPASS_ADMIN_ACCESS_CONTROL=false` has the update accepted, overwriting those models' system prompt and parameters with `{}`. (Inherited.)
- **Root cause**: Bulk handlers ignore write_access and send list rows as full bodies.
- **Trigger / reproduction**: Bulk Hide All as such an admin with read-only shared models present (traced).
- **Impact**: Shared models lose their configuration.
- **Suggested fix** (approach only): Act only on `write_access` rows and send full models (or a meta-only update).
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed by tracing both sides.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-99, package F2); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-100: Editing any prompt suggestion truncates all others to 2000 characters and drops their other fields

Issue: #226. Severity: Medium. Area: web. Status: Confirmed. Package: F2.

- **Location**: [`apps/web/src/routes/workspace/models/PromptSuggestionsEditor.tsx:8`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/models/PromptSuggestionsEditor.tsx#L8); [`apps/web/src/routes/workspace/models/PromptSuggestionsEditor.tsx:15-24`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/models/PromptSuggestionsEditor.tsx#L15-L24); [`apps/web/src/routes/workspace/models/PromptSuggestionsEditor.tsx:41-43`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/models/PromptSuggestionsEditor.tsx#L41-L43)
- **Description**: `normalizeSuggestion` (meant for imports) runs on every render and every change emits the normalized array, so content over 2000 characters and titles over 200 are cut and unknown keys dropped. The original had no truncation.
- **Root cause**: Import normalization runs on every render and edit.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F2/f2-repro.test.tsx`: a 3000-character suggestion is 2000 after editing another suggestion's title.
- **Impact**: Silent data loss in model suggestions.
- **Suggested fix** (approach only): Apply limits only when importing.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-100, package F2); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-101: Saving a skill re-enables it if disabled and clears its tags

Issue: #227. Severity: Medium. Area: web. Status: Confirmed. Package: F2.

- **Location**: [`apps/web/src/routes/workspace/skills/SkillEditor.tsx:79-80`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/skills/SkillEditor.tsx#L79-L80); [`apps/web/src/routes/workspace/skills/SkillPages.tsx:92-99`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/skills/SkillPages.tsx#L92-L99); [`apps/server/local_llm/routers/skills.py:316-318`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/skills.py#L316-L318); [`apps/server/local_llm/models/skills.py:92`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/skills.py#L92); [`apps/server/local_llm/models/skills.py:316-320`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/skills.py#L316-L320)
- **Description**: The editor hardcodes `is_active: true, meta: { tags: [] }` and `toDraft` drops meta; the backend writes the whole form. (Inherited.)
- **Root cause**: The editor hardcodes is_active and meta and the backend writes the whole form.
- **Trigger / reproduction**: Disable a skill, edit its text, save: it is active again; imported tags are gone.
- **Impact**: Skills turn back on unexpectedly; tags lost.
- **Suggested fix** (approach only): Carry `is_active` and `meta` through, or have the backend leave unset fields alone.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed by tracing.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-101, package F2); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-102: Debounced autosaves are cancelled on unmount, so edits made just before leaving a page are lost

Issue: #228. Severity: Medium. Area: web. Status: Confirmed. Package: F2+F3.

- **Location**: [`apps/web/src/routes/workspace/prompts/PromptEditView.tsx:76`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/prompts/PromptEditView.tsx#L76); [`apps/web/src/routes/workspace/prompts/PromptEditView.tsx:137-163`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/prompts/PromptEditView.tsx#L137-L163); [`apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:230-250`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx#L230-L250)
- **Description**: The prompt metadata autosave (500 ms) and the knowledge base name/description autosave (1 s) clear their timers on unmount; the originals' timers still fired after navigation. Leaving within the debounce window drops the edit with no message.
- **Root cause**: Timers are cleared on unmount instead of flushed.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F3/kb_page.test.tsx`: a name edit followed within 1 s by Back makes 0 `updateKnowledgeById` calls (the control without leaving makes 1). The prompt page has the same structure.
- **Impact**: Silent loss of the last edits.
- **Suggested fix** (approach only): Flush pending saves on unmount instead of cancelling them.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #259
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-102, package F2+F3); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-103: Knowledge-base actions can leave the user on an empty later page with no pagination to get back

Issue: #229. Severity: Medium. Area: web. Status: Confirmed. Package: F3.

- **Location**: [`apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:215-218`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx#L215-L218); [`apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:344-354`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx#L344-L354); [`apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:390-406`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx#L390-L406); [`apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:501-510`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx#L501-L510); [`apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:702`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx#L702); [`apps/web/src/routes/workspace/knowledge/useKnowledgeUploads.ts:69-82`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/knowledge/useKnowledgeUploads.ts#L69-L82)
- **Description**: The original's `init()` (reset to page 1 and reload) was ported as `refresh()` (reload only, keeping `page`). After a delete, reset, upload or sync drops the total to 30 or fewer, page 2 shows "No content found" and the pagination control is hidden.
- **Root cause**: `init()` (reset to page 1) was ported as reload-only.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F3/kb_page.test.tsx`: delete the only file on page 2 of 31; reset from page 2 then upload one file ("1 files" header, empty list, no pagination).
- **Impact**: Files appear missing until the user changes view or reloads.
- **Suggested fix** (approach only): Call `setPage(1)` wherever the original called `init()`; clamp `page` to the last page when data arrives.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-103, package F3); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-104: The knowledge base detail page starts filtered by the list pages' shared View setting

Issue: #230. Severity: Low. Area: web. Status: Confirmed. Package: F3.

- **Location**: [`apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:150`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx#L150); [`apps/web/src/routes/workspace/knowledge/KnowledgePage.tsx:205`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/knowledge/KnowledgePage.tsx#L205)
- **Description**: The port seeds the detail page's file filter from `localStorage.workspaceViewOption`, which every workspace list writes; the original started unfiltered.
- **Root cause**: The port reads a localStorage key the original did not read on this page.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F3/kb_page.test.tsx`: after choosing "Created by you" on any list, opening a shared base queries files with `viewOption=created`.
- **Impact**: Shared bases look empty.
- **Suggested fix** (approach only): Initialise the filter to '' as the original did.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-104, package F3); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-105: Dropping a folder together with other items skips every item after the first folder

Issue: #231. Severity: Medium. Area: web. Status: Suspected. Package: F3.

- **Location**: [`apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx:286-308`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/knowledge/KnowledgeBasePage.tsx#L286-L308)
- **Description**: The drop loop calls `item.webkitGetAsEntry()`/`getAsFile()` lazily after awaiting the traversal of an earlier directory; once the handler has yielded, the DataTransfer is protected and both return null, so later items are silently skipped. (Inherited.)
- **Root cause**: DataTransfer items are read lazily after an await.
- **Trigger / reproduction**: Drag folder A and file b.txt onto the page with A first.
- **Impact**: Partial uploads with no error.
- **Suggested fix** (approach only): Collect all entries and files synchronously before the first await.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Suspected (high): HTML drag data store semantics; happy-dom does not model them. Confirm in Chrome.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-105, package F3); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-106: Hybrid search is silently switched off when the reranker fails to load, while Documents reports it saved and on

Issue: #232. Severity: Medium. Area: backend. Status: Confirmed. Package: F5.

- **Location**: [`apps/server/local_llm/routers/retrieval.py:164-220`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/retrieval.py#L164-L220); [`apps/server/local_llm/routers/retrieval.py:1180-1197`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/retrieval.py#L1180-L1197); [`apps/server/local_llm/routers/retrieval.py:1338`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/retrieval.py#L1338); [`apps/web/src/routes/admin/settings/Documents.tsx:162-163`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Documents.tsx#L162-L163)
- **Description**: `update_rag_config` catches the reranker load error, sets `ENABLE_RAG_HYBRID_SEARCH = False`, saves and returns 200; the tab shows success and keeps the toggle on (it ignores the response). Each later save repeats this. Likely here: `make backend` sets `HF_HUB_OFFLINE=1`, so a reranker not in the cache cannot load.
- **Root cause**: A reranker load failure is turned into a silent flag change and the tab ignores the response.
- **Trigger / reproduction**: Enable hybrid search with a local reranker that is not cached and save (both sides quoted; not run without the model).
- **Impact**: Retrieval runs without hybrid search or reranking while the admin believes it is on.
- **Suggested fix** (approach only): Return an error or warning instead of silently flipping the flag; have Documents reload from the response and warn when a flag came back different.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #240
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-106, package F5); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-107: Admin Documents: the BM25 weight "Default" option can never be saved

Issue: #233. Severity: Low. Area: web. Status: Confirmed. Package: F5.

- **Location**: [`apps/web/src/routes/admin/settings/Documents.tsx:594`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Documents.tsx#L594); [`apps/web/src/routes/admin/settings/Documents.tsx:624`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Documents.tsx#L624); [`apps/web/src/routes/admin/settings/documents.ts:83-101`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/documents.ts#L83-L101); [`apps/server/local_llm/routers/retrieval.py:976-978`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/retrieval.py#L976-L978)
- **Description**: Default sends `HYBRID_BM25_WEIGHT: null`, which the server treats as keep-stored, so the last custom weight stays and the row reloads as Custom. (Inherited.)
- **Root cause**: null means "keep" on the server but "default" in the UI.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F5/f5.test.tsx`: `payload HYBRID_BM25_WEIGHT = null`.
- **Impact**: Settings that cannot be reset, half-applied saves, and a configuration that breaks every upload.
- **Suggested fix** (approach only): Send 0.5 for Default, or drop the toggle since the server has no null state.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-107, package F5); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-108: Admin Documents: JSON options pass validation then fail the save after the embedding change was already applied

Issue: #234. Severity: Low. Area: web. Status: Confirmed. Package: F5.

- **Location**: [`apps/web/src/routes/admin/settings/documents.ts:50-77`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/documents.ts#L50-L77); [`apps/web/src/routes/admin/settings/Documents.tsx:161-162`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Documents.tsx#L161-L162)
- **Description**: Headers JSON is validated only while the external engine is selected, and Docling/MinerU params accept any JSON (e.g. `[]`) while the server requires an object; `applyEmbedding()` runs before the config save, so the save is half applied (and the 422 toast reads "[object Object]").
- **Root cause**: Validation depends on the current engine and the embedding is applied first.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F5/f5.test.tsx` (`buildRagPayload threw: SyntaxError`, `DOCLING_PARAMS = []`) and `docs/audit/repro/gap/F5/forms_repro.py` (422).
- **Impact**: Settings that cannot be reset, half-applied saves, and a configuration that breaks every upload.
- **Suggested fix** (approach only): Validate every JSON box as an object regardless of engine and build the payload before applying the embedding.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-108, package F5); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-109: Admin Documents accepts chunk size 0 or an overlap larger than the chunk size, after which every upload fails

Issue: #235. Severity: Medium. Area: web. Status: Confirmed. Package: F5.

- **Location**: [`apps/web/src/routes/admin/settings/Documents.tsx:258-273`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Documents.tsx#L258-L273); [`apps/server/local_llm/routers/retrieval.py:926-928`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/retrieval.py#L926-L928); [`apps/server/local_llm/routers/retrieval.py:1212-1216`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/retrieval.py#L1212-L1216); [`apps/server/local_llm/routers/retrieval.py:1713-1740`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/retrieval.py#L1713-L1740)
- **Description**: `min={0}` and no cross-field check on either side; the text splitters then raise on every upload or reindex. (Inherited.)
- **Root cause**: No validation of chunk parameters.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F5/splitter_repro.py`: ValueError for 0 and for 100/200.
- **Impact**: Settings that cannot be reset, half-applied saves, and a configuration that breaks every upload.
- **Suggested fix** (approach only): Require chunk size >= 1 and overlap < size in the form and the server.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-109, package F5); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-110: Admin Images: Verify for the edit ComfyUI URL checks the generation server instead

Issue: #236. Severity: Low. Area: web. Status: Confirmed. Package: F5.

- **Location**: [`apps/web/src/routes/admin/settings/Images.tsx:269-273`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Images.tsx#L269-L273); [`apps/web/src/routes/admin/settings/Images.tsx:503-510`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Images.tsx#L503-L510); [`apps/server/local_llm/routers/images.py:329-360`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/images.py#L329-L360)
- **Description**: The edit-engine Verify calls the same endpoint, which checks only the generation engine's URL (any other engine returns True). (Inherited.)
- **Root cause**: One verify endpoint serves two different settings.
- **Trigger / reproduction**: Generation engine openai, edit engine comfyui with a wrong URL, click Verify: "Server connection verified".
- **Impact**: False verification; failed saves with an unreadable error.
- **Suggested fix** (approach only): Add a generation/edit target to the verify endpoint.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-110, package F5); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-111: Admin Images: a cleared Steps field is sent as "" and fails the whole save

Issue: #237. Severity: Low. Area: web. Status: Confirmed. Package: F5.

- **Location**: [`apps/web/src/routes/admin/settings/Images.tsx:371-376`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Images.tsx#L371-L376); [`apps/web/src/routes/admin/settings/images.ts:107-131`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/images.ts#L107-L131); [`apps/server/local_llm/routers/images.py:231`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/images.py#L231); [`apps/server/local_llm/routers/images.py:292`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/images.py#L292)
- **Description**: The empty box is stored as `''`, which the `int | None` field rejects with 422 (reachable via Verify, which saves without form validation, or after hiding the field); null would then raise TypeError at line 292.
- **Root cause**: Empty number input stored as a string.
- **Trigger / reproduction**: `docs/audit/repro/gap/F5/f5.test.tsx`: `IMAGE_STEPS = ""`; `docs/audit/repro/gap/F5/forms_repro.py`: 422.
- **Impact**: False verification; failed saves with an unreadable error.
- **Suggested fix** (approach only): Store null for an empty box, validate before sending, and handle None on the server.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #200
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-111, package F5); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-112: "Max Upload Size" 0 means unlimited to the server but rejects every file in the chat and channel composers

Issue: #238. Severity: Low. Area: web. Status: Confirmed. Package: F5.

- **Location**: [`apps/web/src/routes/admin/settings/Documents.tsx:661-668`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Documents.tsx#L661-L668); [`apps/server/local_llm/routers/files.py:382-383`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/files.py#L382-L383); [`apps/server/local_llm/routers/files.py:719-720`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/files.py#L719-L720); [`apps/web/src/routes/chat/useAttachments.ts:81-83`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useAttachments.ts#L81-L83); [`apps/web/src/routes/channels/MessageComposer.tsx:161-162`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/channels/MessageComposer.tsx#L161-L162)
- **Description**: The server checks `if max_size and ...` (0 = no limit) while the composers check `maxSize !== null && size > maxSize*MiB` (0 = reject all).
- **Root cause**: Client and server give 0 different meanings.
- **Trigger / reproduction**: Set Max Upload Size to 0 and attach a file in chat.
- **Impact**: Uploads blocked in the UI while the server would accept them.
- **Suggested fix** (approach only): Give 0 one meaning (treat as unlimited on the client, or require >= 1).
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-112, package F5); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-113: Admin Connections Save shows "Settings saved" after both saves failed

Issue: #239. Severity: Low. Area: web. Status: Confirmed. Package: F5.

- **Location**: [`apps/web/src/routes/admin/settings/Connections.tsx:247`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Connections.tsx#L247); [`apps/web/src/routes/admin/settings/Connections.tsx:261`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Connections.tsx#L261); [`apps/web/src/routes/admin/settings/Connections.tsx:290-293`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Connections.tsx#L290-L293)
- **Description**: `saveOpenAI`/`saveOllama` catch their errors and return undefined, and `submitAll` always calls `saved()` afterwards. (Inherited.)
- **Root cause**: The save helpers swallow errors and the success toast is unconditional.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F5/f5.test.tsx`: toasts `error:upstream refused`, `error:ollama refused`, `success:Settings saved successfully!`.
- **Impact**: Contradictory feedback.
- **Suggested fix** (approach only): Return success from the helpers and call `saved()` only when both succeed.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #240
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-113, package F5); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-114: API client helpers resolve null on network or non-JSON errors, so failures are reported as success or lost silently

Issue: #240. Severity: Medium. Area: web. Status: Confirmed. Package: F5+F7.

- **Location**: [`apps/web/src/lib/apis/channels/index.ts:389-396`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/apis/channels/index.ts#L389-L396); [`apps/web/src/lib/apis/channels/index.ts:532-539`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/apis/channels/index.ts#L532-L539); [`apps/web/src/routes/channels/useMessageFeed.ts:181-185`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/channels/useMessageFeed.ts#L181-L185); [`apps/web/src/routes/channels/MessageComposer.tsx:209-212`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/channels/MessageComposer.tsx#L209-L212); [`apps/web/src/lib/apis/retrieval/index.ts:56-81`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/apis/retrieval/index.ts#L56-L81); [`apps/web/src/lib/apis/retrieval/index.ts:137-162`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/apis/retrieval/index.ts#L137-L162); [`apps/web/src/routes/admin/settings/Documents.tsx:131-132`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Documents.tsx#L131-L132); [`apps/web/src/routes/admin/settings/Documents.tsx:162-163`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Documents.tsx#L162-L163); [`apps/web/src/lib/settings/useConfigDraft.ts:21`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/settings/useConfigDraft.ts#L21); [`apps/web/src/lib/settings/useConfigDraft.ts:46`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/settings/useConfigDraft.ts#L46)
- **Description**: Most `lib/apis` helpers (about 360 sites) do `.catch((err) => { error = err.detail; return null })` then `if (error) throw error`. A network failure (`TypeError`) or a non-JSON error body (Starlette's plain-text 500, a proxy 502) has no `.detail`, so the helper resolves `null` instead of throwing. Consequences found: a channel message sent while the backend is unreachable vanishes with no error after the composer cleared the text; Documents reports "Settings saved" when the save never happened; config tabs whose first load resolves null spin forever (`useConfigDraft` treats null as success). #143 is the Benchmarks instance of the same pattern.
- **Root cause**: The shared helper pattern reads `err.detail`, which network and non-JSON errors lack.
- **Trigger / reproduction**: Repros `docs/audit/repro/gap/F7/send.test.tsx` (`sendMessage on network failure resolved to: null`, `messages after: []`) and `docs/audit/repro/gap/F5/f5.test.tsx` (`updateRAGConfig on network failure resolved to null`).
- **Impact**: Lost messages and false success across the app whenever the backend is down or returns a non-JSON error.
- **Suggested fix** (approach only): Change the shared pattern to `throw err?.detail ?? err` (or a readable fallback) and treat `null` as an error where callers rely on it; fix `useConfigDraft` to surface a null load as an error.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #143
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-114, package F5+F7); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-115: crypto.randomUUID is unavailable over plain-HTTP LAN access, so sending a chat message throws there

Issue: #241. Severity: High. Area: web. Status: Confirmed. Package: F6.

- **Location**: [`apps/web/src/lib/chat/history.ts:59`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/chat/history.ts#L59); [`apps/web/src/lib/chat/history.ts:98`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/chat/history.ts#L98); [`apps/web/src/lib/chat/history.ts:130`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/chat/history.ts#L130); [`apps/web/src/lib/chat/history.ts:483`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/chat/history.ts#L483); [`apps/web/src/routes/chat/useChatSession.ts:437`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useChatSession.ts#L437); [`apps/web/src/lib/utils/auth-helpers.ts:84`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/utils/auth-helpers.ts#L84); [`apps/web/src/routes/channels/MessageComposer.tsx:169`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/channels/MessageComposer.tsx#L169); [`apps/web/src/routes/channels/useMessageFeed.ts:158`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/channels/useMessageFeed.ts#L158); [`apps/web/src/routes/admin/settings/banners.ts:6`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/banners.ts#L6); [`apps/web/src/routes/admin/settings/Integrations.tsx:160`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Integrations.tsx#L160)
- **Description**: `crypto.randomUUID` exists only in secure contexts (https or localhost). README and AGENTS.md document `make backend LLLM_BACKEND_HOST=0.0.0.0` for LAN use, which serves plain http on the LAN address, where the call throws `TypeError: crypto.randomUUID is not a function`. `addUserMessage` (the chat send path), channel sends, queued prompts, banners and terminal servers all call it. The original used the `uuid` package; docs/decisions.md records the switch.
- **Root cause**: `crypto.randomUUID` is secure-context only and was adopted without a fallback.
- **Trigger / reproduction**: Headless Chromium on this machine: `http://127.0.0.1` gives `randomUUID: function`, `http://<LAN IP>` gives `isSecureContext: false, randomUUID: undefined` (`getRandomValues` is available).
- **Impact**: The documented LAN mode cannot send chat or channel messages.
- **Suggested fix** (approach only): Add a small UUID helper that falls back to a `getRandomValues`-based v4 and use it everywhere.
- **Docs affected under the maintenance policy**: docs/decisions.md (a dated entry replacing the 2026-09 choice of `crypto.randomUUID`); README.md LAN note under "Running it".
- **Related issues and PRs**: #258
- **Confidence**: Confirmed: the API is absent on the LAN origin in a real browser; the send path calls it unconditionally.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-115, package F6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-116: JWT expiry accepts negative durations, locking every user out, and silently drops invalid values while the tab reports saved

Issue: #242. Severity: High. Area: backend. Status: Confirmed. Package: F6.

- **Location**: [`apps/server/local_llm/routers/auths.py:946-950`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/auths.py#L946-L950); [`apps/server/local_llm/utils/misc.py:1026-1054`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/misc.py#L1026-L1054); [`apps/server/local_llm/routers/auths.py:161-175`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/auths.py#L161-L175); [`apps/server/local_llm/utils/auth.py:119-130`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/auth.py#L119-L130); [`apps/web/src/routes/admin/settings/Authentication.tsx:103-120`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Authentication.tsx#L103-L120); [`apps/web/src/routes/admin/settings/Authentication.tsx:333`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Authentication.tsx#L333)
- **Description**: The validation pattern `^(-1|0|(-?\d+(\.\d+)?)(ms|s|m|h|d|w))$` accepts `-1h`, so every token issued afterwards is already expired and the cookie max_age is negative: sign-in "succeeds" and the next request is 401, for the admin too once the current session ends. `0s` gives `timedelta(0)`, which is falsy, so tokens get no `exp` (the UI warns only for `-1`). Values that fail the pattern (`1 hour`, `24hr`, `1H`) are popped and the endpoint still returns 200; the tab ignores the response and shows success.
- **Root cause**: The pattern allows negative numbers and invalid values are dropped silently.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F6/forms_repro.py` (exact pattern, parse_duration, create_token, decode_token): `-1h` accepted and a fresh token does not decode; `1 hour` silently popped; `0s` gives a token with no expiry.
- **Impact**: One typo by an admin locks everyone out of the UI (recovery needs a database edit or an API key); other typos are silently ignored.
- **Suggested fix** (approach only): Require a positive number (or exactly -1/0), return 400 for invalid values, treat zero durations explicitly, and have the tab re-seed from the response or validate before sending.
- **Docs affected under the maintenance policy**: The field hint text in the Authentication tab.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-116, package F6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-117: Admin banners are saved but never displayed anywhere (the port lost the banner display and dismissal)

Issue: #243. Severity: Medium. Area: web. Status: Confirmed. Package: F6.

- **Location**: [`apps/web/src/routes/admin/settings/General.tsx:151`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/General.tsx#L151); [`apps/web/src/routes/admin/settings/General.tsx:163`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/General.tsx#L163); [`apps/web/src/routes/admin/settings/Banners.tsx:66-71`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Banners.tsx#L66-L71); [`apps/web/src/routes/admin/settings/banners.ts`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/banners.ts)
- **Description**: No React page fetches `/configs/banners` or renders banners; the original loaded them in the app layout and rendered them in the chat navbar with per-banner dismissal. The display was deferred to Phase 10 in the decisions log, but Phase 10 neither ported it nor recorded it as a gap.
- **Root cause**: The banner display was deferred during the migration and never ported.
- **Trigger / reproduction**: `grep -rn "getBanners\|configs/banners\|dismissible" apps/web/src` finds only the admin tab, the API helper and the type.
- **Impact**: An admin feature silently has no effect.
- **Suggested fix** (approach only): Render banners on the chat screen with remembered dismissal, or remove the editor and record the removal in docs/decisions.md.
- **Docs affected under the maintenance policy**: docs/decisions.md (a dated entry if banners are removed instead of displayed).
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-117, package F6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-118: Cancelling an Ollama pull deletes an installed model of the same name

Issue: #244. Severity: Medium. Area: web. Status: Confirmed. Package: F6.

- **Location**: [`apps/web/src/routes/admin/settings/models/ollamaDownloads.ts:113-123`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/models/ollamaDownloads.ts#L113-L123); [`apps/server/local_llm/routers/ollama.py:807-812`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/ollama.py#L807-L812)
- **Description**: Cancel calls `deleteModel(token, tag)` with no `urlIdx` to remove the partial download; a partial pull is never a listed model, so the backend resolves the name to the first instance that has a complete model with that tag and deletes it. (Inherited.)
- **Root cause**: Cancel deletes by name without an instance, and the backend resolves names to any instance.
- **Trigger / reproduction**: With `llama3:8b` installed, pull `llama3:8b` again (to update or to another instance) and press Cancel (traced on both sides; no Ollama here).
- **Impact**: A working model is deleted and must be downloaded again.
- **Suggested fix** (approach only): Drop the delete (Ollama discards partial layers), or pass the pull's urlIdx and delete only if the tag was absent before the pull.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-118, package F6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-119: An Ollama pull whose stream errors spins forever and freezes the admin tab

Issue: #245. Severity: Medium. Area: web. Status: Confirmed. Package: F6.

- **Location**: [`apps/web/src/routes/admin/settings/models/ollamaDownloads.ts:81-101`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/models/ollamaDownloads.ts#L81-L101)
- **Description**: `reader.read()` is inside the per-iteration try; a non-AbortError, non-string rejection is toasted and the loop reads the errored stream again, which rejects immediately forever (a microtask loop that blocks rendering).
- **Root cause**: Read errors and parse errors share one catch that continues.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F6/pull-loop.test.ts`: `reads = 1001; a setTimeout(0) got to run during the loop: false`. Any backend reload or Ollama restart mid-pull triggers it.
- **Impact**: The admin tab hangs and must be killed; failed updates look successful.
- **Suggested fix** (approach only): Break on reader errors; continue only on a JSON parse error of one line.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #246
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-119, package F6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-120: Ollama "Update All Models" reports success even when every pull failed

Issue: #246. Severity: Low. Area: web. Status: Confirmed. Package: F6.

- **Location**: [`apps/web/src/routes/admin/settings/models/ManageOllama.tsx:164-185`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/models/ManageOllama.tsx#L164-L185)
- **Description**: Stream errors are caught to the console and the success toast is unconditional. (Inherited.)
- **Root cause**: Errors are swallowed and success is unconditional.
- **Trigger / reproduction**: Update All with the Ollama instance unreachable.
- **Impact**: The admin tab hangs and must be killed; failed updates look successful.
- **Suggested fix** (approach only): Count failures and report them.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #245
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-120, package F6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-121: Clearing the Jupyter timeout in admin Code Execution makes the tab unsaveable

Issue: #247. Severity: Medium. Area: web. Status: Confirmed. Package: F6.

- **Location**: [`apps/web/src/routes/admin/settings/CodeExecution.tsx:110-113`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/CodeExecution.tsx#L110-L113); [`apps/server/local_llm/routers/configs.py:661`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/configs.py#L661); [`apps/server/local_llm/routers/configs.py:669`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/configs.py#L669)
- **Description**: The cleared field is sent as `""` (Svelte sent null), which the `int | None` field rejects with 422, shown as "[object Object]".
- **Root cause**: Port regression: empty number stored as a string.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F6/codeexec.test.tsx`: `POSTED TIMEOUT = ""`, `TOAST TEXT = [object Object]`.
- **Impact**: Tabs that cannot be saved until a number is typed back, with an unreadable error and possibly half-applied settings.
- **Suggested fix** (approach only): Map empty to null (use BoundNumber).
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #200, #240
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-121, package F6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-122: Clearing number fields in admin Interface settings fails the save and can half-apply it

Issue: #248. Severity: Low. Area: web. Status: Confirmed. Package: F6.

- **Location**: [`apps/web/src/routes/admin/settings/Interface.tsx:122`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Interface.tsx#L122); [`apps/web/src/routes/admin/settings/Interface.tsx:128-131`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Interface.tsx#L128-L131); [`apps/web/src/routes/admin/settings/Interface.tsx:148`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Interface.tsx#L148); [`apps/server/local_llm/routers/tasks.py:119`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/tasks.py#L119); [`apps/server/local_llm/routers/chats.py:160-162`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/chats.py#L160-L162)
- **Description**: Cleared numbers are sent as null to fields that are plain `int` (autocomplete max length, compaction threshold and retention), giving 422; the two saves run in parallel so one can commit while the other fails. (Inherited.)
- **Root cause**: Form allows empty values the backend forms reject.
- **Trigger / reproduction**: `docs/audit/repro/gap/F6/forms_repro.py`: 422 for each field.
- **Impact**: Tabs that cannot be saved until a number is typed back, with an unreadable error and possibly half-applied settings.
- **Suggested fix** (approach only): Require or default these fields in the form (or accept null as default on the server); render errors readably.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #200
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-122, package F6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-123: After hiding a connection model with no stored record, further toggles on it fail until the tab is reopened

Issue: #249. Severity: Low. Area: web. Status: Confirmed. Package: F6.

- **Location**: [`apps/web/src/routes/admin/settings/models/AdminModels.tsx:228-235`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/models/AdminModels.tsx#L228-L235); [`apps/web/src/routes/admin/settings/models/adminModels.ts:221-232`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/models/adminModels.ts#L221-L232); [`apps/server/local_llm/routers/models.py:272-277`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/models.py#L272-L277)
- **Description**: The first Hide creates a record but `toggleHidden` does not refresh `recordIds` (toggleActive does call `init()`), so the next Hide/Show or enable plans another create, which the backend rejects with MODEL_ID_TAKEN. (Inherited.)
- **Root cause**: toggleHidden does not refresh recordIds after a create.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F6/hide-twice.test.ts`: `1st hide -> create`, `2nd click -> create`, `enable switch -> create`.
- **Impact**: Toggles error and do not change until reopening the tab.
- **Suggested fix** (approach only): Call `init()` (or record the id) after a create in toggleHidden.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-123, package F6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-124: GGUF upload creates the model twice in file mode and never in URL mode, and stream errors are swallowed

Issue: #250. Severity: Low. Area: web. Status: Suspected. Package: F6.

- **Location**: [`apps/web/src/routes/admin/settings/models/ManageOllama.tsx:259-297`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/models/ManageOllama.tsx#L259-L297); [`apps/server/local_llm/routers/ollama.py:1605`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/ollama.py#L1605); [`apps/server/local_llm/routers/ollama.py:1702-1718`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/ollama.py#L1702-L1718)
- **Description**: The tab always calls `createModel({model: `${name}:latest`, modelfile})` after upload. In file mode the backend already created the model (done event carries `model_created`), so a second model is made or an error is shown; in URL mode the backend creates none, and current Ollama create no longer accepts `modelfile`. Server `{error}` events are only logged.
- **Root cause**: The client always creates a model after upload regardless of mode.
- **Trigger / reproduction**: Upload a GGUF file (code traced; no Ollama here).
- **Impact**: Duplicate or missing models from an experimental admin path.
- **Suggested fix** (approach only): Skip the client create when `model_created` is present, create via `files`/`from` in URL mode, and toast stream errors.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Duplicate create confirmed by code on both sides; the Ollama API change is suspected (high).

Found by the gap review of the repository bug audit of `7a4088b` (finding A-124, package F6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-125: Pipelines: an unset list valve loads as an empty required Custom field, blocking Save; its test cannot catch it

Issue: #251. Severity: Low. Area: web. Status: Confirmed. Package: F6.

- **Location**: [`apps/web/src/routes/admin/settings/pipelineValves.ts:10-11`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/pipelineValves.ts#L10-L11); [`apps/web/src/routes/admin/settings/Pipelines.tsx:269-318`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Pipelines.tsx#L269-L318); [`apps/web/src/routes/admin/settings/pipelineValves.test.ts`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/pipelineValves.test.ts)
- **Description**: `valvesToForm` turns null into `''`, which renders as Custom with a required text box; without `required`, `[""]` would be saved. The "keeps an unset array valve null" test feeds `formToValves({tags: null})`, a state the UI never produces.
- **Root cause**: `valvesToForm` maps null to an empty string.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F6/valves.test.ts`: `FORM = {"pipelines":""}`, `SAVED = {"pipelines":[""]}`.
- **Impact**: Pipeline valves cannot be saved without manual edits.
- **Suggested fix** (approach only): Keep null in `valvesToForm` and test the load-save round trip.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-125, package F6); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-126: Failed channel message edits, pins, reactions and deletes stay on screen as if saved

Issue: #252. Severity: Medium. Area: web. Status: Confirmed. Package: F7.

- **Location**: [`apps/web/src/routes/channels/useMessageFeed.ts:211-238`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/channels/useMessageFeed.ts#L211-L238); [`apps/web/src/routes/channels/ChannelDialogs.tsx:99-103`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/channels/ChannelDialogs.tsx#L99-L103); [`apps/web/src/routes/channels/SidebarChannels.tsx:107-110`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/channels/SidebarChannels.tsx#L107-L110)
- **Description**: Optimistic updates are applied first and only toast on failure; nothing is rolled back. (Inherited.)
- **Root cause**: Optimistic updates without rollback.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F7/feed.test.tsx`: with all four calls rejecting, the final state shows the edit, reaction, pin and deletion.
- **Impact**: The channel view disagrees with the server until reload; history looks complete when it failed to load.
- **Suggested fix** (approach only): Keep the previous message and restore it on failure.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #240
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-126, package F7); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-127: A failed channel history load is shown as "the very beginning of the channel"

Issue: #253. Severity: Medium. Area: web. Status: Confirmed. Package: F7.

- **Location**: [`apps/web/src/routes/channels/useMessageFeed.ts:76-87`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/channels/useMessageFeed.ts#L76-L87); [`apps/web/src/routes/channels/useMessageFeed.ts:98-100`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/channels/useMessageFeed.ts#L98-L100); [`apps/web/src/routes/channels/MessageList.tsx:38-70`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/channels/MessageList.tsx#L38-L70)
- **Description**: `loadMore` turns any error into an empty page and sets `top`, so older history is hidden behind the channel-start banner with no retry (the original kept a spinner).
- **Root cause**: Errors are mapped to an empty page.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F7/feed.test.tsx`: `after failed loadMore: top = true toasts = 0`.
- **Impact**: The channel view disagrees with the server until reload; history looks complete when it failed to load.
- **Suggested fix** (approach only): Show an error and leave `top` false so a later scroll retries.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #240
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-127, package F7); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-128: Every open tab shows its own desktop notification and sound for each channel message

Issue: #254. Severity: Low. Area: web. Status: Confirmed. Package: F7.

- **Location**: [`apps/web/src/routes/channels/useChannels.ts:117-128`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/channels/useChannels.ts#L117-L128)
- **Description**: The original notified only from the last active tab; the port has no equivalent and the hook is mounted in every AppShell.
- **Root cause**: The last-active-tab guard was not ported.
- **Trigger / reproduction**: Open two tabs and receive a channel message (code comparison).
- **Impact**: Duplicate notifications, misleading badges, a broken mention pick.
- **Suggested fix** (approach only): Restore a last-active-tab guard (BroadcastChannel) or set a notification tag.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed by code comparison with d863707.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-128, package F7); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-129: Channel unread badges count thread replies and model replies that the server does not count

Issue: #255. Severity: Low. Area: web. Status: Confirmed. Package: F7.

- **Location**: [`apps/web/src/routes/channels/channelModel.ts:410-425`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/channels/channelModel.ts#L410-L425); [`apps/web/src/routes/channels/useChannels.ts:117-124`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/channels/useChannels.ts#L117-L124); [`apps/server/local_llm/models/messages.py:437-440`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/messages.py#L437-L440)
- **Description**: Any `message` event bumps the badge (and notifies), including thread replies and the empty-bodied model replies posted in thread mode; the server counts only top-level messages, so the badge drops back on refetch.
- **Root cause**: Client and server count different message sets.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F7/model.test.ts`: `unread after thread reply: 1`.
- **Impact**: Duplicate notifications, misleading badges, a broken mention pick.
- **Suggested fix** (approach only): Skip events with `parent_id` (or count them on purpose and align the server).
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-129, package F7); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-130: Pressing Enter on a mention suggestion that dropped out of the list throws and inserts nothing

Issue: #256. Severity: Low. Area: web. Status: Confirmed. Package: F7.

- **Location**: [`apps/web/src/routes/channels/MessageComposer.tsx:143`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/channels/MessageComposer.tsx#L143); [`apps/web/src/routes/channels/MessageComposer.tsx:218-232`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/channels/MessageComposer.tsx#L218-L232)
- **Description**: `selected` resets only when the query text changes; when the list shrinks (debounced user search), `pick(suggestions[selected])` receives undefined and throws. The original guarded against this.
- **Root cause**: Selection index not clamped.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F7/composer.test.tsx`: window error recorded, text stays `@a`.
- **Impact**: Duplicate notifications, misleading badges, a broken mention pick.
- **Suggested fix** (approach only): Clamp `selected` to the list length or skip a missing item.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-130, package F7); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-131: The reaction tooltip omits the fourth person when exactly four users reacted

Issue: #257. Severity: Low. Area: web. Status: Confirmed. Package: F7.

- **Location**: [`apps/web/src/routes/channels/channelModel.ts:486-495`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/channels/channelModel.ts#L486-L495)
- **Description**: Names are sliced to three and "and N others" is added only when `total > 4`. (Inherited.)
- **Root cause**: Off-by-one threshold.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F7/model.test.ts`.
- **Impact**: Duplicate notifications, misleading badges, a broken mention pick.
- **Suggested fix** (approach only): Use `total > 3` or list all four.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-131, package F7); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-132: The pure-JS SHA-256 fallback is wrong for files of 512 MiB or more, so knowledge sync re-uploads them every time over plain HTTP

Issue: #258. Severity: Low. Area: web. Status: Confirmed. Package: F7.

- **Location**: [`apps/web/src/lib/utils/hash.ts:167-175`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/utils/hash.ts#L167-L175); [`apps/web/src/routes/workspace/knowledge/knowledgeFiles.ts:27`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/workspace/knowledge/knowledgeFiles.ts#L27); [`apps/server/local_llm/routers/knowledge.py:1913`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/knowledge.py#L1913)
- **Description**: When `crypto.subtle` is missing (plain-HTTP LAN access), the fallback writes only the low 32 bits of the message bit length and never the high word, so from 2^32 bits the digest is wrong; the server sees a hash mismatch and treats the file as modified. (Inherited.)
- **Root cause**: The fallback writes only the low 32 bits of the length.
- **Trigger / reproduction**: Directory sync of a file of at least 512 MiB over http://<LAN IP> (code read against FIPS 180-4; not run because of size).
- **Impact**: Large files are re-uploaded and re-embedded on every sync.
- **Suggested fix** (approach only): Also write the high word: `setUint32(padLen-8, Math.floor(bitLen / 2**32))`.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #241
- **Confidence**: Confirmed by reading against the SHA-256 specification.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-132, package F7); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-133: Account tab: a failed load is silent, and Save then wipes user variables and profile fields

Issue: #259. Severity: Medium. Area: web. Status: Confirmed. Package: F9.

- **Location**: [`apps/web/src/components/settings/personal/Account.tsx:79-95`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/components/settings/personal/Account.tsx#L79-L95); [`apps/web/src/components/settings/personal/Account.tsx:102-129`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/components/settings/personal/Account.tsx#L102-L129); [`apps/server/local_llm/routers/users.py:651-671`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/users.py#L651-L671); [`apps/server/local_llm/routers/auths.py:195-205`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/auths.py#L195-L205)
- **Description**: Both loads swallow errors (`.catch(() => null)`). If the variables load fails, the tab shows none and Save posts `{variables: {}}`, deleting them all; if the profile load fails before any reload since sign-in, the form falls back to the sign-in response, so Save clears bio, gender and birth date and replaces an uploaded picture with the default avatar. A success toast is shown either way. The original toasted both load errors.
- **Root cause**: Load errors are swallowed and Save is always enabled.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F9/account.test.tsx`: with both loads returning 500, Save sends `{variables: {}}` and a profile with null fields and `/api/v1/users/u1/profile/image`.
- **Impact**: Silent loss of prompt variables and profile data after a transient error.
- **Suggested fix** (approach only): Track a load-error state, toast it, and disable Save until both loads succeed; never fall back to the store user for fields it lacks.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #240
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-133, package F9); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-134: Enter in a password field on the Account tab runs the profile save instead of the password change

Issue: #260. Severity: Low. Area: web. Status: Confirmed. Package: F9.

- **Location**: [`apps/web/src/components/settings/personal/Account.tsx:292-330`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/components/settings/personal/Account.tsx#L292-L330)
- **Description**: The password inputs sit inside the tab form and "Update password" is a plain button, so Enter posts the profile and variables and shows success while no password request is sent. The original had its own form.
- **Root cause**: Port regression: the separate form was merged into the tab form.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F9/account.test.tsx`: requests `/auths/update/profile`, `/users/user/variables/update`, no password request.
- **Impact**: The user believes the password or font changed when it did not; silent failures.
- **Suggested fix** (approach only): Give the password section its own (sibling) form.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-134, package F9); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-135: A font typed and submitted with Enter on the Interface tab is not saved

Issue: #261. Severity: Low. Area: web. Status: Confirmed. Package: F9.

- **Location**: [`apps/web/src/components/settings/InterfaceSettings.tsx:266-277`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/components/settings/InterfaceSettings.tsx#L266-L277); [`apps/web/src/components/settings/personal/Interface.tsx:42-50`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/components/settings/personal/Interface.tsx#L42-L50); [`apps/web/src/components/settings/controls.tsx:40-49`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/components/settings/controls.tsx#L40-L49)
- **Description**: The font is committed only on blur, so Enter submits without it while the preview stays applied; the original saved the input value.
- **Root cause**: Value committed on blur only.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/F9/fontenter.test.tsx`: `ENTER save body fontFamily: undefined`.
- **Impact**: The user believes the password or font changed when it did not; silent failures.
- **Suggested fix** (approach only): Commit the font on change or flush it on submit.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-135, package F9); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-136: Personal settings switches fail silently, and the interface permission blocks every settings save while only one tab is hidden

Issue: #262. Severity: Low. Area: web. Status: Confirmed. Package: F9.

- **Location**: [`apps/web/src/components/settings/personal/Audio.tsx:118`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/components/settings/personal/Audio.tsx#L118); [`apps/web/src/components/settings/personal/Personalization.tsx:147`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/components/settings/personal/Personalization.tsx#L147); [`apps/web/src/components/settings/personal/Notifications.tsx:109`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/components/settings/personal/Notifications.tsx#L109); [`apps/web/src/components/settings/personal/Shortcuts.tsx:64`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/components/settings/personal/Shortcuts.tsx#L64); [`apps/server/local_llm/routers/users.py:504-510`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/users.py#L504-L510); [`apps/web/src/components/settings/settingsTabs.ts:126-127`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/components/settings/settingsTabs.ts#L126-L127)
- **Description**: Four switches call `void update(...)` with no catch, so a failed save rolls back with no message. `/users/user/settings/update` returns 403 for non-admins without `settings.interface`, but only the Interface tab is hidden, so General, Audio, Personalization, Notifications, Shortcuts, Connections and Integrations all fail to save. (The gate is inherited.)
- **Root cause**: Unhandled promise plus mismatched permission scope.
- **Trigger / reproduction**: Revoke "Interface Settings Access" for a user and toggle a switch on another tab.
- **Impact**: The user believes the password or font changed when it did not; silent failures.
- **Suggested fix** (approach only): Catch and toast; decide the permission scope and align tab visibility with the backend gate.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-136, package F9); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-137: A personal tool server saved without a name is listed as a blank row

Issue: #263. Severity: Low. Area: web. Status: Confirmed. Package: F9.

- **Location**: [`apps/web/src/components/settings/personal/Integrations.tsx:60`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/components/settings/personal/Integrations.tsx#L60); [`apps/web/src/components/settings/toolServerModel.ts:158-161`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/components/settings/toolServerModel.ts#L158-L161)
- **Description**: The label uses `t.info?.name ?? t.url`, but the name defaults to `''`, which `??` does not replace; the original fell back to the URL.
- **Root cause**: Nullish coalescing on an empty string.
- **Trigger / reproduction**: Add a personal tool server without a name.
- **Impact**: The user believes the password or font changed when it did not; silent failures.
- **Suggested fix** (approach only): Use `||`.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed by reading.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-137, package F9); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-138: Automation runs are recorded as successful as soon as they are dispatched, so model and provider failures never reach the run history

Issue: #264. Severity: Medium. Area: backend. Status: Confirmed. Package: B3.

- **Location**: [`apps/server/local_llm/utils/automations.py:468-491`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/automations.py#L468-L491); [`apps/server/local_llm/utils/automations.py:654-678`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/automations.py#L654-L678); [`apps/server/local_llm/main.py:1714-1720`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/main.py#L1714-L1720); [`apps/server/local_llm/main.py:1846-1847`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/main.py#L1846-L1847)
- **Description**: `execute_automation` awaits the chat completion handler, which (with `session_id` and `chat_id` set and no `state.internal`) takes the `_fan_out_chat` path and returns immediately; it then records `success`, emits the result and publishes RUN_COMPLETED. Later failures are never recorded. `AUTOMATION_RUN_STARTED` is never published.
- **Root cause**: A synchronous success is assumed for an asynchronous handler.
- **Trigger / reproduction**: Schedule an automation against a model whose provider errors (e.g. a bad key): the chat shows the error, the runs list and webhook say success (traced on both sides).
- **Impact**: Run history and completion webhooks report success for runs that produced nothing.
- **Suggested fix** (approach only): Record the outcome from the background task (pass the automation id through metadata), or run automations as internal requests and inspect the result; record started at dispatch.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-138, package B3); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-139: Automation runs fired before the model list is loaded drop the model's default tools, filters, features and terminal

Issue: #265. Severity: Medium. Area: backend. Status: Confirmed. Package: B3.

- **Location**: [`apps/server/local_llm/utils/automations.py:308-318`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/automations.py#L308-L318); [`apps/server/local_llm/utils/automations.py:440-466`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/automations.py#L440-L466); [`apps/server/local_llm/utils/automations.py:623-650`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/automations.py#L623-L650); [`apps/server/local_llm/main.py:365-369`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/main.py#L365-L369); [`apps/server/local_llm/config.py:326`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/config.py#L326); [`apps/server/local_llm/routers/openai.py:350-358`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/openai.py#L350-L358)
- **Description**: `_resolve_model_defaults` reads `app.state.MODELS`, which is empty until a user request loads models (the startup prefetch runs only with the base-models cache enabled, off by default) and is cleared on connection changes. The scheduler's first poll runs immediately, exactly when overdue runs fire after the laptop was off or a reload. Nothing else re-derives toolIds/defaultFilterIds/defaultFeatureIds.
- **Root cause**: Model defaults are read from an in-memory list that is empty until a user request.
- **Trigger / reproduction**: Restart the backend with an overdue automation (traced; default config).
- **Impact**: Automations run without their configured tools, filters and web search.
- **Suggested fix** (approach only): Call `get_all_models` when the model is missing from MODELS; consider starting the scheduler after the prefetch.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-139, package B3); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-140: Daily, weekly and monthly automation rules skip occurrences when the user's timezone is behind the server's, and fire a few seconds late

Issue: #266. Severity: Medium. Area: backend. Status: Confirmed. Package: B3.

- **Location**: [`apps/server/local_llm/utils/automations.py:84`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/automations.py#L84); [`apps/server/local_llm/utils/automations.py:101-103`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/automations.py#L101-L103); [`apps/server/local_llm/utils/automations.py:124-177`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/automations.py#L124-L177); [`apps/server/local_llm/models/automations.py:345`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/automations.py#L345); [`apps/web/src/routes/automations/automationModel.ts:68-74`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/automations/automationModel.ts#L68-L74)
- **Description**: `rrulestr` without DTSTART uses the server-local naive `now` as dtstart; the code then asks for occurrences after the user's local naive now, so any occurrence between the user's now and the server's now precedes dtstart and is dropped. The picker always produces rules without DTSTART. Unset BYSECOND also inherits the parse-time seconds.
- **Root cause**: rrulestr without DTSTART anchors at server-local now.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B3/repro_rrule.py` (TZ=UTC, user tz Etc/GMT+6, local 08:03): a daily 10:00 rule next runs tomorrow 10:00:36 instead of today 10:00:00; a weekly rule for today runs in 7 days.
- **Impact**: Skipped runs (every day for multi-time rules) whenever the server timezone differs from the browser's, e.g. a UTC server or LAN access from another zone.
- **Suggested fix** (approach only): Pass an explicit dtstart in the user timezone (e.g. the anchor day) and default BYSECOND to 0.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-140, package B3); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-141: Sub-daily rules with an old DTSTART are rebuilt from the epoch, reviving exhausted COUNT rules and shifting run times

Issue: #267. Severity: Low. Area: backend. Status: Confirmed. Package: B3.

- **Location**: [`apps/server/local_llm/utils/automations.py:109-121`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/automations.py#L109-L121)
- **Description**: When more than 100,000 steps have passed since DTSTART the rule is rebuilt with an epoch-aligned dtstart, dropping the phase and restarting COUNT.
- **Root cause**: Old rules are rebuilt from an epoch-aligned dtstart.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B3/repro_rrule_old_dtstart.py`: an exhausted `COUNT=10` minutely rule from 2024 is accepted and schedules new runs; `INTERVAL=5` from :07:30 runs at :17:30-style epoch-aligned times instead.
- **Impact**: Finished automations restart; schedules drift.
- **Suggested fix** (approach only): Keep the original dtstart for COUNT rules; otherwise realign by stepping from DTSTART.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-141, package B3); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-142: The app has no handler for the calendar:alert socket event, so in-app calendar reminders are never shown

Issue: #268. Severity: Medium. Area: web. Status: Confirmed. Package: B3.

- **Location**: [`apps/server/local_llm/utils/automations.py:736-745`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/automations.py#L736-L745); [`apps/web/src/routes/chat/useChatSession.ts:304`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/chat/useChatSession.ts#L304)
- **Description**: The backend emits `calendar:alert` on the `events` channel; the original layout (`d863707:apps/openwebui/src/routes/+layout.svelte:584-612`) showed a toast and a browser notification. No listener for it exists in apps/web.
- **Root cause**: The app-level listener of the original was not ported.
- **Trigger / reproduction**: `grep -rn "calendar:alert" apps/web/src` finds nothing.
- **Impact**: Reminders reach no one unless a webhook or notification target is configured.
- **Suggested fix** (approach only): Add an app-level `events` listener for `calendar:alert` showing a toast and an optional Notification.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #183
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-142, package B3); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-143: Plugin import rewriting matches substrings, corrupting imports such as configparser and saving the corrupted source

Issue: #269. Severity: Low. Area: backend. Status: Confirmed. Package: B3.

- **Location**: [`apps/server/local_llm/utils/plugin.py:228-242`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/plugin.py#L228-L242); [`apps/server/local_llm/utils/plugin.py:259-260`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/plugin.py#L259-L260); [`apps/server/local_llm/utils/plugin.py:357`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/plugin.py#L357); [`apps/server/local_llm/utils/plugin.py:397-401`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/plugin.py#L397-L401); [`apps/server/local_llm/utils/plugin.py:438-442`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/plugin.py#L438-L442); [`apps/server/local_llm/routers/tools.py:396`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/tools.py#L396); [`apps/server/local_llm/routers/tools.py:538`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/tools.py#L538); [`apps/server/local_llm/routers/functions.py:176`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/functions.py#L176); [`apps/server/local_llm/routers/functions.py:222`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/functions.py#L222); [`apps/server/local_llm/routers/functions.py:392`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/functions.py#L392)
- **Description**: `replace_imports` replaces `'from config'`, `'from main'`, `'from utils'` anywhere, so `from configparser` becomes `from local_llm.configparser`; docstrings are rewritten too, and the rewritten source is persisted (a failed load deactivates a Function).
- **Root cause**: The rewrite uses substring replacement.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B3/repro_plugin_payload.py`: a tool importing configparser fails with `ModuleNotFoundError: No module named 'local_llm.configparser'`.
- **Impact**: Valid tools and functions break on save.
- **Suggested fix** (approach only): Match whole module names at line start, or drop the legacy rewrites now that the package alias exists.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-143, package B3); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-144: A chat timer stays "running" forever if anything fails before completion or the process restarts mid-claim

Issue: #270. Severity: Low. Area: backend. Status: Confirmed. Package: B3.

- **Location**: [`apps/server/local_llm/utils/timers.py:171-199`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/timers.py#L171-L199); [`apps/server/local_llm/utils/timers.py:230-414`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/timers.py#L230-L414)
- **Description**: The claim sets status running and clears `timer_at`; the body has no try, so DB, Redis or emit errors escape an unreferenced task and leave the timer running with no retry; nothing at startup recovers stale running timers (and `make backend` reloads).
- **Root cause**: The timer body has no exception handling and nothing recovers stale running timers.
- **Trigger / reproduction**: Code reading.
- **Impact**: Timers silently never fire.
- **Suggested fix** (approach only): Wrap the body and mark errors; at startup re-pend or fail timers stuck in running.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed by reading; frequency uncertain.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-144, package B3); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-145: The stop-sequence mapping corrupts non-ASCII stop strings and splits a string stop into characters

Issue: #271. Severity: Low. Area: backend. Status: Confirmed. Package: B3.

- **Location**: [`apps/server/local_llm/utils/payload.py:191`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/payload.py#L191); [`apps/server/local_llm/utils/payload.py:245`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/payload.py#L245); [`apps/server/local_llm/routers/openai.py:1474`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/openai.py#L1474)
- **Description**: The unescape step mangles `['。']` into `['ã\x80\x82']` and `['Résumé:']` into `['RÃ©sumÃ©:']`, and a string `'END'` becomes `['E','N','D']`. In the normal chat path the raw value is applied first and wins, so only callers that bypass that merge (direct OpenAI proxy calls, the Ollama path) are affected.
- **Root cause**: The unescape step round-trips through latin-1 and treats strings as iterables.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B3/repro_plugin_payload.py` section 2.
- **Impact**: Wrong stop sequences for those callers.
- **Suggested fix** (approach only): Accept str or list and unescape only literal escape sequences (or drop the unescape).
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-145, package B3); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-146: With default model metadata set, admins lose base models that have no workspace row when admin bypass is off

Issue: #272. Severity: Low. Area: backend. Status: Confirmed. Package: B3.

- **Location**: [`apps/server/local_llm/utils/models.py:297-300`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/models.py#L297-L300); [`apps/server/local_llm/utils/models.py:495-497`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/models.py#L495-L497); [`apps/server/local_llm/utils/models.py:525-536`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/models.py#L525-L536)
- **Description**: Default metadata gives such models `info={'meta': ...}`, which the access filter treats as a configured model; with no `user_id` and not in the accessible ids, the admin branch is never reached. Only with `BYPASS_ADMIN_ACCESS_CONTROL=False` (default True).
- **Root cause**: "Configured" is decided by `info` being truthy instead of a DB row existing.
- **Trigger / reproduction**: Code reading.
- **Impact**: Admins cannot see unconfigured provider models in that configuration.
- **Suggested fix** (approach only): Decide "configured" by whether a DB row exists, not by `info` being truthy.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed by reading.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-146, package B3); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-147: MCP OAuth client registration picks a token auth method the client cannot use

Issue: #273. Severity: Low. Area: backend. Status: Confirmed. Package: B5.

- **Location**: [`apps/server/local_llm/utils/oauth.py:541-549`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/oauth.py#L541-L549); [`apps/server/local_llm/utils/oauth.py:680-686`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/oauth.py#L680-L686)
- **Description**: If `client_secret_post` is not offered, the server's first listed method is taken even when the client model accepts only none/basic/post, so registration (and the static path) fails validation; a client may already be registered on the server but unusable.
- **Root cause**: The fallback ignores the supported set.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B5/repro_dcr_auth_method.py`: server offers `['private_key_jwt','client_secret_basic']` and validation fails.
- **Impact**: MCP OAuth fails against some servers; group sync silently does nothing or drops the default group.
- **Suggested fix** (approach only): Pick the first offered method in the supported set, preferring a secret method when a secret exists.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-147, package B5); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-148: OAuth groups in a dotted claim name (Auth0-style URL claims) never resolve

Issue: #274. Severity: Low. Area: backend. Status: Confirmed. Package: B5.

- **Location**: [`apps/server/local_llm/utils/oauth.py:1948-1953`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/oauth.py#L1948-L1953); [`apps/server/local_llm/utils/oauth.py:1852-1854`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/oauth.py#L1852-L1854)
- **Description**: The groups claim name is always split on `.`, with no fallback to the flat key; the roles code has that fallback.
- **Root cause**: Missing flat-key fallback.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B5/repro_group_sync_dotted.py`: `dotted claim name, IdP says [eng] calls=[]`.
- **Impact**: MCP OAuth fails against some servers; group sync silently does nothing or drops the default group.
- **Suggested fix** (approach only): Mirror the roles fallback.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-148, package B5); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-149: OAuth group sync removes a new user from the default group immediately after adding them

Issue: #275. Severity: Low. Area: backend. Status: Confirmed. Package: B5.

- **Location**: [`apps/server/local_llm/utils/oauth.py:2023-2039`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/oauth.py#L2023-L2039); [`apps/server/local_llm/utils/oauth.py:2270-2271`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/oauth.py#L2270-L2271); [`apps/server/local_llm/utils/oauth.py:2309-2316`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/oauth.py#L2309-L2316)
- **Description**: Sign-up adds the user to `ui.default_group_id`, then `update_user_groups` in the same callback removes every group the IdP did not list, including the default group.
- **Root cause**: Sync treats every app group as IdP-managed.
- **Trigger / reproduction**: OAuth sign-up with group management and a default group configured (code reading).
- **Impact**: MCP OAuth fails against some servers; group sync silently does nothing or drops the default group.
- **Suggested fix** (approach only): Exclude the default (and locally managed) groups from OAuth removal, or apply the default after sync.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed by reading.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-149, package B5); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-150: kb_exec ls lists a model's directly attached files inside every knowledge base

Issue: #276. Severity: Low. Area: backend. Status: Confirmed. Package: B5.

- **Location**: [`apps/server/local_llm/tools/knowledge_fs.py:402-421`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/tools/knowledge_fs.py#L402-L421); [`apps/server/local_llm/tools/knowledge_fs.py:609-612`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/tools/knowledge_fs.py#L609-L612)
- **Description**: Attached files are appended whenever `model_knowledge` is set, even when a `knowledge_id` was asked for, and `_kb_ls` lists them as root files of each base.
- **Root cause**: Attached files are appended regardless of the requested knowledge id.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B5/repro_kb_ls_attached.py`: `attached.csv` appears under "Docs" and again under "Attached Files".
- **Impact**: Misleads the model about where files live.
- **Suggested fix** (approach only): Skip direct attachments when `knowledge_id` is given.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-150, package B5); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-151: Deleting a thread's parent message leaves its replies, pins and reactions reachable

Issue: #277. Severity: Medium. Area: backend. Status: Confirmed. Package: B9.

- **Location**: [`apps/server/local_llm/models/messages.py:574-594`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/messages.py#L574-L594); [`apps/server/local_llm/routers/channels.py:1771`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/channels.py#L1771); [`apps/server/local_llm/tools/builtin.py:1845`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/tools/builtin.py#L1845)
- **Description**: Delete removes only the message and its own reactions; `delete_replies_by_id` and `delete_reactions_by_id` have no callers. Replies disappear from the channel and thread views but remain in the pinned list and in the `search_messages` tool results given to the model, with their reactions.
- **Root cause**: Delete removes only the message and its own reactions.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B9/repro_orphan_replies.py`: `pinned list: ['secret reply in thread']`, `search tool backend: ['secret reply in thread']`.
- **Impact**: Content users deleted keeps surfacing, including to the model.
- **Suggested fix** (approach only): Delete replies and their reactions in the same transaction.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-151, package B9); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-152: Leaderboard counts a thumbs-up on a regenerated reply as both a win and a loss for the same model

Issue: #278. Severity: Medium. Area: backend. Status: Confirmed. Package: B9.

- **Location**: [`apps/server/local_llm/routers/evaluations.py:111-124`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/evaluations.py#L111-L124); [`apps/web/src/lib/chat/feedback.ts:72-86`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/lib/chat/feedback.ts#L72-L86)
- **Description**: `sibling_model_ids` includes every child of the parent message, so regenerations by the same model are opponents; `_calculate_elo` plays the model against itself (rating unchanged, won and lost both +1). An empty sibling model id becomes a phantom leaderboard entry.
- **Root cause**: Opponent ids include the winner and empty ids.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B9/repro_elo.py` case 1: `{'M': {'rating': 1000.0, 'won': 1, 'lost': 1}}`.
- **Impact**: Wrong win/loss counts and percentages for single-model chats with regenerations.
- **Suggested fix** (approach only): Skip opponents equal to the winner or empty, on both sides of the seam.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: #203
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-152, package B9); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-153: Adding several users to a group silently drops new members when one is already a member

Issue: #279. Severity: Low. Area: backend. Status: Confirmed. Package: B9.

- **Location**: [`apps/server/local_llm/models/groups.py:586-600`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/groups.py#L586-L600); [`apps/server/local_llm/models/groups.py:368-389`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/groups.py#L368-L389)
- **Description**: Each insert is flushed; on a unique violation the whole transaction (including earlier new members) is rolled back, yet the group is returned, the route answers 200 and publishes all ids as added. SCIM's set path has the same missing de-duplication but raises.
- **Root cause**: Per-row flush with whole-transaction rollback.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B9/repro_groups.py`: adding `['alice','existing','bob']` leaves `['bob','existing']`.
- **Impact**: Silently missing group members (API callers); wrong model filter results.
- **Suggested fix** (approach only): Insert only non-members (or ON CONFLICT DO NOTHING).
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-153, package B9); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-154: The workspace model tag filter matches models whose meta merely contains the tag word

Issue: #280. Severity: Low. Area: backend. Status: Confirmed. Package: B9.

- **Location**: [`apps/server/local_llm/models/models.py:387-396`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/models.py#L387-L396)
- **Description**: The filter runs `LIKE '%"<tag>"%'` over the whole serialized meta, so tags like `vision` or `web_search` match every model with that capability key; `%`/`_` are not escaped.
- **Root cause**: Substring match over serialized JSON.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B9/repro_model_tag.py`: `tag=vision -> ['m-tagged','m-untagged']`.
- **Impact**: Silently missing group members (API callers); wrong model filter results.
- **Suggested fix** (approach only): Match within `meta.tags[*].name` only.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-154, package B9); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-155: Folder delete commits child deletions one by one and reports a mid-way failure as success

Issue: #281. Severity: Low. Area: backend. Status: Suspected. Package: B9.

- **Location**: [`apps/server/local_llm/models/folders.py:394-415`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/folders.py#L394-L415); [`apps/server/local_llm/routers/folders.py:692-704`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/folders.py#L692-L704)
- **Description**: Each child folder is deleted and committed separately and any exception is swallowed into `[]`; the router then moves or deletes no chats and returns True, leaving chats with a dangling `folder_id` that the sidebar hides.
- **Root cause**: Each child is committed separately and exceptions are swallowed.
- **Trigger / reproduction**: A database error during a subtree delete (not reproduced).
- **Impact**: Hidden chats after a partial failure.
- **Suggested fix** (approach only): One transaction for the subtree; let exceptions propagate.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Suspected (medium): the path is certain; triggering needs a DB fault.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-155, package B9); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-156: Batch memory replace clears the memory's path unless the caller repeats it

Issue: #282. Severity: Medium. Area: backend. Status: Confirmed. Package: B10.

- **Location**: [`apps/server/local_llm/utils/memory.py:264-270`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/memory.py#L264-L270); [`apps/server/local_llm/models/memories.py:227-228`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/memories.py#L227-L228); [`apps/server/local_llm/routers/memories.py:86-91`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/memories.py#L86-L91); [`apps/server/local_llm/routers/memories.py:243-256`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/memories.py#L243-L256); [`apps/server/local_llm/tools/builtin.py:962-997`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/tools/builtin.py#L962-L997); [`apps/server/local_llm/utils/memory.py:545-547`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/memory.py#L545-L547)
- **Description**: `apply_memory_operations` intends to change the path only when supplied (`if 'path' in operation`), but the validator always sets `op['path']` and `model_dump()` includes `path: None`, so every replace without a path sets it to NULL and re-embeds without the prefix. The single-memory route handles this correctly.
- **Root cause**: model_dump without exclude_unset and an unconditional path assignment.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B10/memory_replace_path.py`: path `preferences/languages` becomes `None` after a replace.
- **Impact**: Memory organisation silently lost whenever the model corrects a memory via `update_memory` or background review.
- **Suggested fix** (approach only): Use `model_dump(exclude_unset=True)` and normalise path only when present.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-156, package B10); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-157: Generated tags that differ only by case or spacing make the whole tag batch fail, leaving chat tags unindexed and unarchive returning 500

Issue: #283. Severity: Medium. Area: backend. Status: Confirmed. Package: B10.

- **Location**: [`apps/server/local_llm/models/tags.py:121-134`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/tags.py#L121-L134); [`apps/server/local_llm/models/chats.py:840-849`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L840-L849); [`apps/server/local_llm/utils/middleware.py:3854-3860`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L3854-L3860); [`apps/server/local_llm/routers/chats.py:1615`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/chats.py#L1615)
- **Description**: `ensure_tags_exist` normalises names to ids but does not de-duplicate, so `['Python','python']` inserts two rows with the same key and raises IntegrityError. The chat meta is committed first with the duplicated ids, no Tag rows are created, orphan cleanup is skipped, the tagging task swallows the error, and unarchive later calls `ensure_tags_exist` outside any try and returns 500 after the archive toggle committed.
- **Root cause**: Names are normalized to ids without de-duplication.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B10/tags_dup.py`: `['Python','python']`, `['Data Analysis','data_analysis']`, `['Math','Math']` all raise IntegrityError.
- **Impact**: Tags missing from the tag list and chat display; orphan tags; unarchive errors.
- **Suggested fix** (approach only): De-duplicate by normalised id in `ensure_tags_exist` and in `update_chat_tags_by_id`.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-157, package B10); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-158: Every failed OAuth token refresh deletes the session, and refresh has no lock despite its docstring

Issue: #284. Severity: Medium. Area: backend. Status: Confirmed. Package: B10.

- **Location**: [`apps/server/local_llm/utils/oauth.py:1055-1064`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/oauth.py#L1055-L1064); [`apps/server/local_llm/utils/oauth.py:1071-1180`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/oauth.py#L1071-L1180); [`apps/server/local_llm/utils/oauth.py:1694-1735`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/oauth.py#L1694-L1735); [`apps/server/local_llm/models/oauth_sessions.py:259-294`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/oauth_sessions.py#L259-L294)
- **Description**: Any refresh failure (DNS or network error, IdP 5xx, metadata fetch failure) deletes the session, forcing re-authorisation. No lock exists, so two concurrent requests near expiry both refresh with the same refresh token; with rotation and reuse detection the second fails and deletes the session the first just updated.
- **Root cause**: Any refresh failure deletes the session, and refresh is not serialized.
- **Trigger / reproduction**: A transient network error during refresh (code reading); the concurrent case needs a rotating-refresh IdP.
- **Impact**: MCP and SSO connections drop and must be re-authorised after transient errors.
- **Suggested fix** (approach only): Delete only on a definitive invalid_grant/400/401; keep the session on transient errors; serialise refresh per session.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Deletion on transient failure confirmed from code; the concurrent-refresh loss suspected (about 60%).

Found by the gap review of the repository bug audit of `7a4088b` (finding A-158, package B10); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-159: Non-expiring OAuth tokens become unusable on servers east of UTC

Issue: #285. Severity: Low. Area: backend. Status: Confirmed. Package: B10.

- **Location**: [`apps/server/local_llm/utils/oauth.py:201`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/oauth.py#L201); [`apps/server/local_llm/utils/oauth.py:230-247`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/oauth.py#L230-L247); [`apps/server/local_llm/utils/oauth.py:1050-1053`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/oauth.py#L1050-L1053); [`apps/server/local_llm/utils/oauth.py:1689-1692`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/oauth.py#L1689-L1692); [`apps/server/local_llm/models/oauth_sessions.py:123`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/oauth_sessions.py#L123)
- **Description**: Tokens without `expires_in` or `refresh_token` get the sentinel `expires_at = 253402300799` (9999-12-31 UTC); the expiry check converts it with naive `datetime.fromtimestamp`, which overflows to year 10000 in positive-offset zones; the exception is logged and no token is ever returned.
- **Root cause**: A naive local-time conversion of a far-future sentinel.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B10/nonexpiring.py`: America/Chicago `needs_refresh = False`; Europe/Berlin `raises ValueError year 10000 is out of range`.
- **Impact**: Such providers stop working on servers east of UTC.
- **Suggested fix** (approach only): Compare epoch integers, or use an aware UTC conversion.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-159, package B10); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-160: OAuth provider settings saved in Admin > Authentication are never used for login

Issue: #286. Severity: Low. Area: backend. Status: Confirmed. Package: B10.

- **Location**: [`apps/server/local_llm/routers/auths.py:1037-1046`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/auths.py#L1037-L1046); [`apps/server/local_llm/routers/auths.py:1100-1103`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/auths.py#L1100-L1103); [`apps/server/local_llm/config.py:2390-2536`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/config.py#L2390-L2536); [`apps/server/local_llm/utils/oauth.py:829`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/oauth.py#L829); [`apps/server/local_llm/routers/auths.py:699`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/auths.py#L699); [`apps/web/src/routes/admin/settings/Authentication.tsx:174-215`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/web/src/routes/admin/settings/Authentication.tsx#L174-L215)
- **Description**: With persistent OAuth config on, the tab saves provider URL, client id/secret, scopes, redirect URI, timeouts and methods to the database, but providers are registered once at import from the environment; only logout reads the stored provider URL. (Inherited.)
- **Root cause**: Providers are registered once from environment values.
- **Trigger / reproduction**: Change the provider in the tab and restart: login still uses the environment values.
- **Impact**: Saved settings have no effect; login and logout can use different providers.
- **Suggested fix** (approach only): Build providers from the stored config at startup and after updates, or remove the fields from the form.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed by reading.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-160, package B10); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-161: A 44-character LLLM_SECRET_KEY that is not a Fernet key stops the backend from starting

Issue: #287. Severity: Low. Area: backend. Status: Confirmed. Package: B10.

- **Location**: [`apps/server/local_llm/models/oauth_sessions.py:72-83`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/oauth_sessions.py#L72-L83); [`apps/server/local_llm/models/oauth_sessions.py:343`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/oauth_sessions.py#L343); [`apps/server/local_llm/utils/oauth.py:253-263`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/oauth.py#L253-L263); [`apps/server/local_llm/env.py:777-779`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/env.py#L777-L779)
- **Description**: A key of exactly 44 characters is used as a Fernet key as-is (other lengths are hashed), so `openssl rand -hex 22` or a 44-character passphrase raises ValueError at import.
- **Root cause**: A 44-character key is assumed to be a Fernet key.
- **Trigger / reproduction**: `'a'*44` raises `Fernet key must be 32 url-safe base64-encoded bytes` (run inline).
- **Impact**: The backend refuses to start with a plausible secret.
- **Suggested fix** (approach only): Try `Fernet(key)` and fall back to the SHA-256 derivation on ValueError (keeps working keys unchanged).
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: traced in the code at the audited SHA by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-161, package B10); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-162: Tool valve saves report success when the database write failed

Issue: #288. Severity: Low. Area: backend. Status: Confirmed. Package: B10.

- **Location**: [`apps/server/local_llm/models/tools.py:257-309`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/tools.py#L257-L309); [`apps/server/local_llm/routers/tools.py:836-843`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/tools.py#L836-L843); [`apps/server/local_llm/routers/tools.py:975-983`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/tools.py#L975-L983)
- **Description**: Both model methods swallow every exception and return None (one is annotated `ToolValves | None` but returns a ToolModel); the routes ignore the result and echo the submitted valves with an updated event.
- **Root cause**: Model methods swallow exceptions and routes ignore the result.
- **Trigger / reproduction**: Any DB or encryption error during save (code reading).
- **Impact**: Users see saved values that were never stored.
- **Suggested fix** (approach only): Check the result and return an error; fix the annotation.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed by reading.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-162, package B10); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-163: Postgres chat search silently excludes chats whose title contains "x00" or whose content contains a literal \u0000

Issue: #289. Severity: Medium. Area: backend. Status: Confirmed. Package: B7.

- **Location**: [`apps/server/local_llm/models/chats.py:2066-2071`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L2066-L2071)
- **Description**: Two "safety" filters run on every Postgres search: `Chat.title::text NOT LIKE '%\x00%'` is the pattern backslash-x-0-0, and since backslash is LIKE's escape character it means `%x00%`, excluding titles like "Convert 0x00FF"; the content filter excludes chats containing the text `\u0000`. Null bytes are already stripped on every write, so neither filter is needed.
- **Root cause**: The LIKE patterns are written as if they were C escapes.
- **Trigger / reproduction**: Postgres 16 (pgvector image): `SELECT 'Convert 0x00FF' NOT LIKE '%\x00%'` returns false, and the same for a JSON value containing a literal `\\u0000`; `docs/audit/repro/gap/B7/repro_search2.py` prints the SQL the code sends.
- **Impact**: Hex- and escape-related chats in a coding assistant cannot be found by any search, with no error.
- **Suggested fix** (approach only): Delete both filters (writes already sanitize), or use `strpos(title, chr(0)) = 0`.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-163, package B7); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-164: Files added to a message by tools or streamed images are written only to the chat JSON, so they are duplicated on save and lost on fork

Issue: #290. Severity: Medium. Area: backend. Status: Confirmed. Package: B7.

- **Location**: [`apps/server/local_llm/models/chats.py:1201-1268`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L1201-L1268); [`apps/server/local_llm/models/chats.py:1077-1099`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L1077-L1099); [`apps/server/local_llm/models/chats.py:1013-1064`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L1013-L1064); [`apps/server/local_llm/utils/middleware.py:5187-5207`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/middleware.py#L5187-L5207); [`apps/server/local_llm/socket/main.py:1144-1157`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/socket/main.py#L1144-L1157); [`apps/server/local_llm/routers/chats.py:1392`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/chats.py#L1392); [`apps/server/local_llm/routers/chats.py:1410`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/chats.py#L1410)
- **Description**: `add_message_files_by_id_and_message_id` and `add_message_status_...` update only the chat JSON, while `get_message_metadata` and the messages map prefer the `chat_message` row (NULL here). The middleware emits the full file list and the socket handler extends it with the stale "existing" files and upserts, duplicating entries; forks and compaction built from the messages map lose the images and status history until the next full save.
- **Root cause**: Two write paths update only the chat JSON while reads prefer chat_message rows.
- **Trigger / reproduction**: Repros `docs/audit/repro/gap/B7/repro_chats.py` (`get_message_metadata -> None` while the blob has the file) and `docs/audit/repro/gap/B7/repro_files_dup.py` (after two streamed images: `['img1','img2','img1']`).
- **Impact**: Duplicate images in replies after reload; forks missing generated images.
- **Suggested fix** (approach only): Dual-write files and status_history through `ChatMessages.upsert_message`, fall back to the blob when the column is NULL, and emit only new files (or replace instead of extend).
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-164, package B7); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-165: Chat search ignores a folder: filter that matches no folder and returns every chat

Issue: #291. Severity: Low. Area: backend. Status: Confirmed. Package: B7.

- **Location**: [`apps/server/local_llm/models/chats.py:1953-1957`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L1953-L1957); [`apps/server/local_llm/models/chats.py:2000-2001`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L2000-L2001)
- **Description**: The folder constraint is applied only if a folder matched, so a misspelled folder removes the constraint.
- **Root cause**: Empty resolution treated as no filter.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B7/repro_chats.py`: `folder:nosuch` returns all chats.
- **Impact**: Wrong search results; files in shared chats that viewers cannot open.
- **Suggested fix** (approach only): Return nothing when a folder token resolves to no folder.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-165, package B7); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-166: LIKE wildcards in chat search text are not escaped, so % or _ matches every chat

Issue: #292. Severity: Low. Area: backend. Status: Confirmed. Package: B7.

- **Location**: [`apps/server/local_llm/models/chats.py:2016-2017`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L2016-L2017); [`apps/server/local_llm/models/chats.py:68-99`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L68-L99); [`apps/server/local_llm/models/chats.py:1391`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L1391); [`apps/server/local_llm/models/chats.py:1471`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L1471)
- **Description**: The phrase is bound raw into ILIKE/LIKE patterns in search, the archived list and the admin list.
- **Root cause**: Unescaped user input in LIKE patterns.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B7/repro_chats.py`: searching `%` or `_` returns every chat.
- **Impact**: Wrong search results; files in shared chats that viewers cannot open.
- **Suggested fix** (approach only): Escape `\`, `%`, `_` and use an ESCAPE clause (or `autoescape=True`).
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-166, package B7); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-167: Linking an already-linked file to a chat makes the whole chat_file batch fail, so new files are never linked

Issue: #293. Severity: Low. Area: backend. Status: Confirmed. Package: B7.

- **Location**: [`apps/server/local_llm/models/chats.py:2549-2553`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L2549-L2553); [`apps/server/local_llm/models/chats.py:2578-2602`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L2578-L2602); [`apps/server/local_llm/utils/access_control/files.py:95`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/utils/access_control/files.py#L95)
- **Description**: `insert_chat_files` de-duplicates on chat_file row ids instead of `file_id`, so an already-linked file violates the (chat_id, file_id) constraint and the swallowed error rolls back the new files in the same batch. chat_file drives file access for shared-chat viewers.
- **Root cause**: Wrong field used for de-duplication.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B7/repro_chats.py`: inserting F then F,G leaves only F linked.
- **Impact**: Wrong search results; files in shared chats that viewers cannot open.
- **Suggested fix** (approach only): De-duplicate on file_id across the chat, or ON CONFLICT DO NOTHING per row.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-167, package B7); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-168: Chat export pages by OFFSET over updated_at, so a chat updated during export is skipped and another exported twice

Issue: #294. Severity: Low. Area: backend. Status: Confirmed. Package: B7.

- **Location**: [`apps/server/local_llm/models/chats.py:1845-1892`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L1845-L1892); [`apps/server/local_llm/routers/chats.py:686-703`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/routers/chats.py#L686-L703)
- **Description**: `GET /chats/all` pages through chats ordered by `updated_at DESC`; an update between pages shifts rows.
- **Root cause**: OFFSET paging over a column that changes during the export.
- **Trigger / reproduction**: Repro `docs/audit/repro/gap/B7/repro_export.py`: 150 chats, one updated after the first batch: 149 unique, `missing: ['c010']`, `duplicated: ['c050']`.
- **Impact**: Backups can silently omit chats.
- **Suggested fix** (approach only): Keyset-page on an immutable key, or snapshot ids first.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed: reproduced (see trigger), and re-run by the auditing session.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-168, package B7); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

### A-169: Imported chats all show as unread

Issue: #295. Severity: Low. Area: backend. Status: Confirmed. Package: B7.

- **Location**: [`apps/server/local_llm/models/chats.py:601-618`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L601-L618); [`apps/server/local_llm/models/chats.py:120`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L120); [`apps/server/local_llm/models/chats.py:526`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L526); [`apps/server/local_llm/models/chats.py:1800`](https://github.com/epittman23/local-llm/blob/7a4088b20f3aa27cf35abb07689e68b19408c003/apps/server/local_llm/models/chats.py#L1800)
- **Description**: The import path never sets `last_read_at`, and unread checks use `updated_at > coalesce(last_read_at, 0)`; `insert_new_chat` and the migration backfill set it.
- **Root cause**: The import path never sets last_read_at.
- **Trigger / reproduction**: Import chats: each is unread, sorted first, and inflates folder counts.
- **Impact**: Misleading unread state.
- **Suggested fix** (approach only): Set `last_read_at = updated_at` on import.
- **Docs affected under the maintenance policy**: None.
- **Related issues and PRs**: None known.
- **Confidence**: Confirmed by reading.

Found by the gap review of the repository bug audit of `7a4088b` (finding A-169, package B7); see `docs/audit/FINDINGS.md` on branch `audit/bug-review`.

