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
