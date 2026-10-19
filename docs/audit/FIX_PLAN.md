# Fix plan for the 2026-10-19 bug audit

A self-contained plan for a future session with no memory of the audit.
Findings are in [FINDINGS.md](FINDINGS.md), reproductions in
[repro/](repro/README.md), and non-bug observations in [NOTES.md](NOTES.md).
Security findings are deliberately absent from this repository; the owner
handles them through private security advisories.

## 1. Context

- **Audited commit**: `7a4088b20f3aa27cf35abb07689e68b19408c003` (`main`,
  "fix(server): search knowledge even when a hit has no metadata (#108)").
  Every line reference here and in the issues refers to it; re-locate lines on
  current `main` before editing, since PRs have landed since (open at audit
  time: #125, a ruff configuration chore that touches none of these files).
- **Environment setup that worked** (Claude Code cloud container):
  1. `infra/.env` with placeholder values for `OPENROUTER_API_KEY`,
     `POSTGRES_PASSWORD`, `LLLM_SECRET_KEY` (never commit it).
  2. Start Docker if `docker info` fails: `dockerd &`.
  3. Backend venv without torch when `download.pytorch.org` is blocked:
     `cd apps/server && UV_PROJECT_ENVIRONMENT=$PWD/.venv uv sync --frozen --no-install-project --group dev --no-install-package torch`.
     Pure-Python repros and almost all of pytest run under it.
  4. Postgres for `tests/test_imports.py` needs `pgvector/pgvector:pg16`; Docker
     Hub may rate-limit (429). Retry later or use CI.
  5. Playwright: if `cdn.playwright.dev` is blocked and `/opt/pw-browsers` holds an
     older Chromium, link the expected revision directory to it (outside the
     repo) and run `cd apps/web && bunx playwright test --workers=2`.
  6. If `git show d863707:...` fails, run `git fetch --unshallow origin main`.
- **Baseline results at the audited commit**:

  | Check | Result |
  |---|---|
  | `make test-web` | pass: `astro check` 0 errors (1 warning), Vitest 580/580 in 78 files, build OK |
  | `make test-e2e` | Make target failed at `playwright install` (network); run directly: 340 passed, 1 failed (A-32, flaky, passed 3/3 alone) |
  | `make test-backend` | Make target failed at `uv sync` (torch index blocked); pytest without torch: 1617 passed, 21 skipped, 1 failed (`test_the_app_imports`: no Postgres, image pull 429) |
  | `make lint` | pass, no files changed |

## 2. Summary table

| Issue | Finding | Title | Severity | Area | Status | Location | Effort |
|---|---|---|---|---|---|---|---|
| [#126](https://github.com/epittman23/local-llm/issues/126) | A-01 | Grader scores a wrong answer as pass when the model code exits 0 before the dataset tests run, and fails correct answers whose __main__ block reads stdin | Critical | benchmarks | Confirmed | `__init__.py:140` | M |
| [#127](https://github.com/epittman23/local-llm/issues/127) | A-02 | config_id fingerprint ignores the profile's extra args and model file, so different launches share one configuration | Critical | benchmarks | Confirmed | `fingerprint.py:76` | M |
| [#128](https://github.com/epittman23/local-llm/issues/128) | A-03 | Report headline always says no system prompt differs and that every difference is noise, whatever the statistics show | Critical | benchmarks | Confirmed | `report.py:1895` | S |
| [#129](https://github.com/epittman23/local-llm/issues/129) | A-04 | Compare "by serving" response puts the serving rows under derived_columns, and the page crashes the app | High | benchmarks | Confirmed | `compare.py:27` | S |
| [#131](https://github.com/epittman23/local-llm/issues/131) | A-06 | Compare never extracts the fa flag, so a two-flag difference is reported as a clean comparison | High | benchmarks | Confirmed | `compare.py:108` | S |
| [#134](https://github.com/epittman23/local-llm/issues/134) | A-09 | Tune sweep adopts (and refines around) a candidate that is slower than the profile defaults | High | benchmarks | Confirmed | `tune.py:1282` | S |
| [#140](https://github.com/epittman23/local-llm/issues/140) | A-15 | Test runs block the backend's event loop: grading and suite preparation run blocking subprocesses inside async code | High | benchmarks | Confirmed | `runner.py:352` | M |
| [#141](https://github.com/epittman23/local-llm/issues/141) | A-16 | No endpoint fetches datasets, runs selfcheck or runs one item, although the guide documents all three as Tests page actions | High | benchmarks | Confirmed | `datasets.py:90` | M |
| [#130](https://github.com/epittman23/local-llm/issues/130) | A-05 | Compare "by benchmark" table is empty: per-benchmark values are nested but the page reads them top-level | Medium | benchmarks | Confirmed | `compare.py:416` | S |
| [#132](https://github.com/epittman23/local-llm/issues/132) | A-07 | Compare ranks rows across tiers together and binds the baseline delta to the first matching group only | Medium | benchmarks | Confirmed | `compare.py:358` | M |
| [#133](https://github.com/epittman23/local-llm/issues/133) | A-08 | Report power section computes the minimum detectable effect from a pooled item count no single test uses, at an uncorrected alpha | Medium | benchmarks | Suspected | `report.py:1413` | S |
| [#135](https://github.com/epittman23/local-llm/issues/135) | A-10 | Tune elimination ranks a candidate exactly tied with the baseline below every slower candidate | Medium | benchmarks | Confirmed | `tune.py:1175` | S |
| [#136](https://github.com/epittman23/local-llm/issues/136) | A-11 | Tune's uncertain-cut sign test pairs mismatched items and treats n=0 as a supported cut | Medium | benchmarks | Confirmed | `tune.py:1194` | S |
| [#137](https://github.com/epittman23/local-llm/issues/137) | A-12 | Cooldown time accounting overwrites the running total, so max_cooldown_share is not enforced across pauses | Medium | benchmarks | Confirmed | `tune.py:515` | S |
| [#138](https://github.com/epittman23/local-llm/issues/138) | A-13 | Stopping a sweep during a visit's teardown or a cooldown can skip ServeProcess.stop and leave visit/pause rows running forever | Medium | benchmarks | Suspected | `tune.py:942` | M |
| [#142](https://github.com/epittman23/local-llm/issues/142) | A-17 | Grading timeouts kill only the direct child; processes spawned by model code survive | Medium | benchmarks | Suspected | `__init__.py:146` | S |
| [#145](https://github.com/epittman23/local-llm/issues/145) | A-20 | make frontend ignores a failed bun install, starts the dev server anyway and never sets its cleanup trap | Medium | infra | Confirmed | `Makefile:118` | S |
| [#150](https://github.com/epittman23/local-llm/issues/150) | A-25 | A reply left unfinished on a non-current branch stays "generating" forever after reload | Medium | web | Confirmed | `history.ts:220` | S |
| [#151](https://github.com/epittman23/local-llm/issues/151) | A-26 | Stop pressed before the backend creates the task in an existing chat cancels nothing; the reply keeps streaming after the UI shows stopped | Medium | web | Suspected | `useChatSession.ts:455` | S |
| [#156](https://github.com/epittman23/local-llm/issues/156) | A-31 | Telemetry recorder attaches a new run to whatever server already answers on the port | Medium | benchmarks | Suspected | `telemetry_recorder.py:109` | S |
| [#158](https://github.com/epittman23/local-llm/issues/158) | A-33 | Editing a calendar event cannot remove its repeat rule, description or location | Medium | web | Confirmed | `calendarModel.ts:196` | S |
| [#159](https://github.com/epittman23/local-llm/issues/159) | A-34 | Automation schedule picker silently rewrites RRULEs it cannot represent and mislabels them | Medium | web | Confirmed | `automationModel.ts:64` | S |
| [#160](https://github.com/epittman23/local-llm/issues/160) | A-35 | Chat documents are not pruned to the current conversation path, so a file from a deleted message or another branch is still sent as context | Medium | web | Confirmed | `request.ts:142` | S |
| [#139](https://github.com/epittman23/local-llm/issues/139) | A-14 | A sweep whose baseline fails to load never narrows and does not say why | Low | benchmarks | Suspected | `tune.py:1112` | S |
| [#143](https://github.com/epittman23/local-llm/issues/143) | A-18 | Benchmarks pages show "[object Object]" or a generic message instead of the server error, and Serve treats network failures as success | Low | benchmarks | Confirmed | `index.ts:131` | S |
| [#144](https://github.com/epittman23/local-llm/issues/144) | A-19 | Tune page live-status stream can outlive the page or run twice (the L17 fix was not applied to Tune) | Low | benchmarks | Confirmed | `TunePage.tsx:132` | S |
| [#146](https://github.com/epittman23/local-llm/issues/146) | A-21 | make test-e2e does not run Playwright as CI does (workers, CI env), although the docs say it mirrors CI | Low | infra | Confirmed | `Makefile:175` | S |
| [#147](https://github.com/epittman23/local-llm/issues/147) | A-22 | make test-backend runs pytest even if its Postgres never became ready, and the readiness probe can pass before TCP is up | Low | infra | Suspected | `Makefile:145` | S |
| [#148](https://github.com/epittman23/local-llm/issues/148) | A-23 | make backend does not wait for Postgres before the app runs migrations at import | Low | infra | Suspected | `Makefile:92` | S |
| [#149](https://github.com/epittman23/local-llm/issues/149) | A-24 | Stale documentation: pre-commit header claims ruff-check covers only part of the backend, and MAP.md omits tracked top-level files | Low | docs | Confirmed | `.pre-commit-config.yaml:10` | S |
| [#152](https://github.com/epittman23/local-llm/issues/152) | A-27 | Concurrent archive and set-default can leave the default serving profile archived | Low | benchmarks | Suspected | `profiles.py:341` | S |
| [#153](https://github.com/epittman23/local-llm/issues/153) | A-28 | Concurrent profile create/clone/version edit returns 500 instead of 409 | Low | benchmarks | Suspected | `profiles.py:298` | S |
| [#154](https://github.com/epittman23/local-llm/issues/154) | A-29 | Chat list endpoints turn page < 1 into a negative OFFSET and fail instead of validating | Low | backend | Suspected | `chats.py:250` | S |
| [#155](https://github.com/epittman23/local-llm/issues/155) | A-30 | Streaming usage is merged on every usage-bearing chunk, double-counting when a provider repeats usage | Low | backend | Suspected | `middleware.py:4977` | S |
| [#157](https://github.com/epittman23/local-llm/issues/157) | A-32 | Flaky e2e assertion in the knowledge list search test | Low | web | Suspected | `workspace-knowledge.spec.ts:156` | S |

## 3. Execution order

Batches are ordered by dependency first and severity second. One branch and one pull request per batch (a batch may be split into consecutive PRs where noted).

- **B0 Security fixes**: tracked in the repository's private security advisories, not here. Owner decision (2026-10-19): fix these **before** any batch below. Their details are deliberately not in this public file; read them from the advisories (repository Security tab). See the execution-time note in section 6 about where to do the work.

- **B1 Grading correctness**: [#126](https://github.com/epittman23/local-llm/issues/126) A-01, [#142](https://github.com/epittman23/local-llm/issues/142) A-17, [#140](https://github.com/epittman23/local-llm/issues/140) A-15. First: every pass rate recorded before it is suspect (A-01), and later batches measure with the grader. A-15 moves grading off the event loop; A-17 touches the same subprocess call, so the three share one PR.
- **B2 Dataset fetch and selfcheck**: [#141](https://github.com/epittman23/local-llm/issues/141) A-16. After B1: the new endpoints call the grader (selfcheck) and must use the non-blocking pattern from A-15. Owner decision: build the endpoints and Tests page actions properly (section 6).
- **B3 Fingerprint coverage**: [#127](https://github.com/epittman23/local-llm/issues/127) A-02. Owner decision: take the best fix, changing every existing id (section 6). Independent of B1/B2 in code, but do it before re-measuring anything so new runs are fingerprinted correctly.
- **B4 Compare and Report correctness**: [#129](https://github.com/epittman23/local-llm/issues/129) A-04, [#130](https://github.com/epittman23/local-llm/issues/130) A-05, [#131](https://github.com/epittman23/local-llm/issues/131) A-06, [#132](https://github.com/epittman23/local-llm/issues/132) A-07, [#128](https://github.com/epittman23/local-llm/issues/128) A-03, [#133](https://github.com/epittman23/local-llm/issues/133) A-08. A-04 and A-05 change the same response contract between the router and ComparePage, so they go together; A-06/A-07 are in the same module. A-03/A-08 are Report-only and can be a second PR in this batch.
- **B5 Tuning decisions**: [#134](https://github.com/epittman23/local-llm/issues/134) A-09, [#135](https://github.com/epittman23/local-llm/issues/135) A-10, [#136](https://github.com/epittman23/local-llm/issues/136) A-11, [#137](https://github.com/epittman23/local-llm/issues/137) A-12, [#138](https://github.com/epittman23/local-llm/issues/138) A-13, [#139](https://github.com/epittman23/local-llm/issues/139) A-14. All in tuning/tune.py; A-09 to A-12 share the ranking/cooldown code and its new test module. A-13 and A-14 are suspected: confirm first.
- **B6 Benchmarks frontend robustness**: [#143](https://github.com/epittman23/local-llm/issues/143) A-18, [#144](https://github.com/epittman23/local-llm/issues/144) A-19, [#156](https://github.com/epittman23/local-llm/issues/156) A-31. After B4, which edits ComparePage and lib/apis/benchmarks/index.ts types; A-18/A-19 edit the same API module. A-31 (backend, suspected) fits here as serving robustness.
- **B7 Chat correctness**: [#160](https://github.com/epittman23/local-llm/issues/160) A-35, [#150](https://github.com/epittman23/local-llm/issues/150) A-25, [#151](https://github.com/epittman23/local-llm/issues/151) A-26. Same hook (useChatSession.ts); independent of the benchmark batches.
- **B8 Calendar and automations**: [#158](https://github.com/epittman23/local-llm/issues/158) A-33, [#159](https://github.com/epittman23/local-llm/issues/159) A-34. Independent.
- **B9 Benchmark profile concurrency**: [#152](https://github.com/epittman23/local-llm/issues/152) A-27, [#153](https://github.com/epittman23/local-llm/issues/153) A-28. Suspected; confirm with a two-session test against Postgres. A CHECK constraint needs a new Alembic revision.
- **B10 Backend minor**: [#154](https://github.com/epittman23/local-llm/issues/154) A-29, [#155](https://github.com/epittman23/local-llm/issues/155) A-30. Suspected; independent.
- **B11 Build, CI and docs hygiene**: [#145](https://github.com/epittman23/local-llm/issues/145) A-20, [#146](https://github.com/epittman23/local-llm/issues/146) A-21, [#147](https://github.com/epittman23/local-llm/issues/147) A-22, [#148](https://github.com/epittman23/local-llm/issues/148) A-23, [#149](https://github.com/epittman23/local-llm/issues/149) A-24, [#157](https://github.com/epittman23/local-llm/issues/157) A-32. Last, or in parallel at any time: no code dependencies. A-21 changes how `make check` runs e2e, so land it before the other batches if possible to avoid surprises.

## 4. Per-bug detail

### B1 Grading correctness

#### A-01 [#126](https://github.com/epittman23/local-llm/issues/126): Grader scores a wrong answer as pass when the model code exits 0 before the dataset tests run, and fails correct answers whose __main__ block reads stdin

- Severity / status / effort: Critical / Confirmed / M
- Locations: `apps/server/local_llm/benchmarks/evaluation/grading/__init__.py:140-160`; `apps/server/local_llm/benchmarks/evaluation/grading/mbpp.py:15-25`; `apps/server/local_llm/benchmarks/evaluation/grading/humaneval.py:25-32`
- Root cause: Outcome inferred from exit status alone; the model's code runs as `__main__` with an inherited stdin.
- Recommended fix: Have the harness print a random per-run sentinel after the tests and require it in stdout for PASS; run the model code under a non-`__main__` module name (or strip/neutralise its main block); pass `stdin=subprocess.DEVNULL`. Do not re-grade stored answers (owner decision, section 6).
- Files likely to change: grading/__init__.py, grading/mbpp.py, grading/humaneval.py, grading/ds1000.py, tests/test_grading*.py
- Regression risks: DS-1000 harness structure differs; sentinel must not be forgeable by printing it from model code (use a nonce generated per run). Calibration results may shift.
- Docs to update: docs/guides/benchmarks.md (grading section); docs/decisions.md entry recording the changed meaning of PASS (any results recorded before the fix are not comparable; the database held none on 2026-10-19).
- Acceptance criteria: New pytest cases: a wrong answer with `unittest.main()`/`sys.exit(0)` grades as fail; a correct answer with an `input()` main block grades as pass; existing grading tests stay green.

#### A-17 [#142](https://github.com/epittman23/local-llm/issues/142): Grading timeouts kill only the direct child; processes spawned by model code survive

- Severity / status / effort: Medium / Suspected / S
- Locations: `apps/server/local_llm/benchmarks/evaluation/grading/__init__.py:146-150`
- Root cause: No process group.
- Recommended fix: `start_new_session=True` and kill the process group on timeout.
- Files likely to change: grading/__init__.py, tests
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Test: a forked sleeper is gone after the timeout.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-15 [#140](https://github.com/epittman23/local-llm/issues/140): Test runs block the backend's event loop: grading and suite preparation run blocking subprocesses inside async code

- Severity / status / effort: High / Confirmed / M
- Locations: `apps/server/local_llm/benchmarks/evaluation/runner.py:352`; `apps/server/local_llm/benchmarks/evaluation/runner.py:492-545`; `apps/server/local_llm/routers/benchmarks/tests.py:55-100`
- Root cause: Synchronous I/O in coroutines.
- Recommended fix: `await asyncio.to_thread(...)` around grading and preparation, or asyncio subprocesses.
- Files likely to change: evaluation/runner.py, tests
- Regression risks: Thread safety of anything grade() touches (it is self-contained per temp dir).
- Docs to update: None.
- Acceptance criteria: Async test: a ticker keeps running (max gap well under 1 s) during a slow grade.

### B2 Dataset fetch and selfcheck

#### A-16 [#141](https://github.com/epittman23/local-llm/issues/141): No endpoint fetches datasets, runs selfcheck or runs one item, although the guide documents all three as Tests page actions

- Severity / status / effort: High / Confirmed / M
- Locations: `apps/server/local_llm/benchmarks/evaluation/datasets.py:90-95`; `apps/server/local_llm/benchmarks/evaluation/datasets.py:229`; `apps/server/local_llm/benchmarks/evaluation/grading/__init__.py:273-320`; `apps/server/local_llm/routers/benchmarks/tests.py:1-120`; `docs/guides/benchmarks.md:128-137`; `docs/guides/benchmarks.md:336`
- Root cause: Functionality lost in the CLI-to-app migration; docs not updated.
- Recommended fix: Build admin endpoints (`get_admin_user`) and Tests page actions for dataset fetch (with a force-refetch option), selfcheck (grade the references and write the calibration) and single-item run, as docs/guides/benchmarks.md already describes them. Owner decision: these are approved interface additions (section 6). Run downloads and grading off the event loop (A-15's pattern) and stream progress the way the existing run endpoint does. Make the refetch atomic (write items and manifest to a temp directory, then rename), see NOTES.md.
- Files likely to change: routers/benchmarks/tests.py, routes/benchmarks/TestsPage.tsx, lib/apis/benchmarks/index.ts, tests
- Regression risks: Long-running downloads need the same non-blocking treatment as A-15.
- Docs to update: docs/guides/benchmarks.md; README "Pages and URLs" if UI changes; docs/decisions.md.
- Acceptance criteria: Router tests for each new endpoint (admin required, success, error); a Vitest/Playwright test for each Tests page action; `datasets.py`'s "not downloaded yet" message names the Tests page action instead of `datasets.fetch_one`.

### B3 Fingerprint coverage

#### A-02 [#127](https://github.com/epittman23/local-llm/issues/127): config_id fingerprint ignores the profile's extra args and model file, so different launches share one configuration

- Severity / status / effort: Critical / Confirmed / M
- Locations: `apps/server/local_llm/benchmarks/serving/fingerprint.py:76-111`; `apps/server/local_llm/benchmarks/serving/launcher.py:107`; `apps/server/local_llm/benchmarks/serving/launcher.py:146`; `apps/server/local_llm/benchmarks/serving/profiles.py:329`; `apps/server/local_llm/benchmarks/serving/profiles.py:344`
- Root cause: `extra` is a free-form profile field (only `--parallel` and reasoning flags are rejected) with no fingerprint line; the model is identified by alias only, so a new profile version with a different `model_path` and the same alias collides.
- Recommended fix (owner decision, section 6: no data exists, take the best fix): add two fingerprint lines, always present, so every id changes once: `model: <basename of the resolved model file>` and `extra: <args joined with spaces, or n/a>`. Use the **basename**, not the path: results are grouped by the server's alias (`env_profile.served_model` reads `/v1/models`), so two quants under one alias are merged today, while relocating the weights directory must not change the id. Update `stats.parse_config_text` and `compare.flags_of` so the new lines parse and count in the multi-flag warning.
- Serving baseline: `docs/serving-baseline/` is the record of what the shell produced, so do not rewrite its captured ids. Keep the shell-parity test for the six-line form (for example by testing the six lines and the legacy hash separately), add new expected cases for the eight-line form, and replace the `model-path-not-fingerprinted` invariant with `model-directory-not-fingerprinted` (same basename, different directory, same id). Explain the change in its README.
- Files likely to change: serving/fingerprint.py, analysis/stats.py, docs/serving-baseline/*, tests/test_fingerprint*.py, a new migration
- Regression risks: every config_id changes (accepted: the database held no benchmark data on 2026-10-19); the baseline fingerprint test pins the six-line ids and must keep passing for them.
- Docs to update: fingerprint.py docstring; docs/guides/llama-cpp.md; docs/guides/telemetry.md; docs/serving-baseline/README.md; docs/decisions.md (dated entry) and the matching roadmap milestone; a `benchmark_schema_note` row in a new Alembic revision (AGENTS.md requires it even with no data).
- Acceptance criteria: new tests: different `extra` gives a different id; a different model basename gives a different id; the same basename in another directory gives the same id; the legacy six-line cases in `fingerprints.json` still hash to their captured ids; `parse_config_text` round-trips the new lines.

### B4 Compare and Report correctness

#### A-04 [#129](https://github.com/epittman23/local-llm/issues/129): Compare "by serving" response puts the serving rows under derived_columns, and the page crashes the app

- Severity / status / effort: High / Confirmed / S
- Locations: `apps/server/local_llm/routers/benchmarks/compare.py:27-30`; `apps/server/local_llm/benchmarks/analysis/compare.py:654`; `apps/server/local_llm/benchmarks/analysis/compare.py:727`; `apps/web/src/routes/benchmarks/ComparePage.tsx:42`; `apps/web/src/routes/benchmarks/ComparePage.tsx:119-137`
- Root cause: Misnamed tuple unpack in the router; Playwright mocks the shape the page expects and no backend test checks the response keys.
- Recommended fix: Return `{rows, derived, notes}` (plus explicit column lists if wanted); render the rows table with columns from the first row's keys, and the derived table beside it; update the e2e mock to the real shape.
- Files likely to change: routers/benchmarks/compare.py, routes/benchmarks/ComparePage.tsx, lib/apis/benchmarks/index.ts types, e2e/benchmarks.spec.ts, a backend router test
- Regression risks: Response key rename is a contract change between the two apps; change both in one PR.
- Docs to update: docs/guides/benchmarks.md (Compare, by serving).
- Acceptance criteria: A backend test asserts the serving response keys and that rows carry gen_tps; an e2e test with the real shape renders both tables.

#### A-05 [#130](https://github.com/epittman23/local-llm/issues/130): Compare "by benchmark" table is empty: per-benchmark values are nested but the page reads them top-level

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/benchmarks/analysis/compare.py:416-438`; `apps/server/local_llm/routers/benchmarks/compare.py:37-39`; `apps/web/src/routes/benchmarks/ComparePage.tsx:119-137`
- Root cause: Backend pivot shape and the generic table normaliser were never reconciled; mocks hide it.
- Recommended fix: Flatten in the backend (`row[name] = pass_rate`, identity columns first) or map `per_benchmark` in the page; add tests on both sides.
- Files likely to change: analysis/compare.py or ComparePage.tsx, tests
- Regression risks: Same contract caveat as A-04; batch them together.
- Docs to update: docs/guides/benchmarks.md Compare section if it describes the view.
- Acceptance criteria: Test renders a pass-rate cell per benchmark plus model/config/tier for a mocked real-shape response.

#### A-06 [#131](https://github.com/epittman23/local-llm/issues/131): Compare never extracts the fa flag, so a two-flag difference is reported as a clean comparison

- Severity / status / effort: High / Confirmed / S
- Locations: `apps/server/local_llm/benchmarks/analysis/compare.py:108-120`; `apps/server/local_llm/benchmarks/serving/fingerprint.py:89-92`
- Root cause: Wrong source string for the regex; `stats.parse_config_text` already reads `fa` correctly.
- Recommended fix: Read `config_value(lines, 'fa')` directly (as stats does), or regex over the whole cache line.
- Files likely to change: analysis/compare.py, new tests/test_compare.py
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Unit test: configs differing only in fa produce `differing == ['fa']`.

#### A-07 [#132](https://github.com/epittman23/local-llm/issues/132): Compare ranks rows across tiers together and binds the baseline delta to the first matching group only

- Severity / status / effort: Medium / Confirmed / M
- Locations: `apps/server/local_llm/benchmarks/analysis/compare.py:358-380`
- Root cause: No per-tier partitioning; baseline chosen once instead of per tier (and per system/adapter).
- Recommended fix: Sort within each tier; choose the baseline group per tier, matched on system and adapter.
- Files likely to change: analysis/compare.py, tests
- Regression risks: Changes row order the UI shows; update e2e expectations if any.
- Docs to update: None if the code is brought in line with benchmarks.md.
- Acceptance criteria: Unit test: with baseline A, `B full` gets a delta against `A full`, and rows are grouped by tier.

#### A-03 [#128](https://github.com/epittman23/local-llm/issues/128): Report headline always says no system prompt differs and that every difference is noise, whatever the statistics show

- Severity / status / effort: Critical / Confirmed / S
- Locations: `apps/server/local_llm/benchmarks/analysis/report.py:1895-1925`; `apps/server/local_llm/benchmarks/analysis/report.py:1500-1510`
- Root cause: Text written for one historical null result and hardcoded.
- Recommended fix: Derive headline wording from `p_perm`/Holm-adjusted p-values and from max |Δ pass rate| compared to the floor; state which family/block it summarises; same for the floor sentence.
- Files likely to change: analysis/report.py, new tests/test_report_headline.py
- Regression risks: None beyond wording; check other hardcoded verdict sentences in report.py.
- Docs to update: docs/guides/benchmarks.md Report section if it quotes the headline.
- Acceptance criteria: Unit test: significant data yields a headline stating a difference; null data keeps the current wording; the floor sentence appears only when every difference is below the floor.

#### A-08 [#133](https://github.com/epittman23/local-llm/issues/133): Report power section computes the minimum detectable effect from a pooled item count no single test uses, at an uncorrected alpha

- Severity / status / effort: Medium / Suspected / S
- Locations: `apps/server/local_llm/benchmarks/analysis/report.py:1413`; `apps/server/local_llm/benchmarks/analysis/report.py:1445`; `apps/server/local_llm/benchmarks/analysis/report.py:1462`; `apps/server/local_llm/benchmarks/analysis/report.py:1490`
- Root cause: Pooled n and nominal alpha used for a per-block, multiplicity-corrected test.
- Recommended fix: Use per-block n (or label the figure as a hypothetical pooled test) and alpha/(k-1) (or the Holm worst case).
- Files likely to change: analysis/report.py, tests
- Regression risks: Low.
- Docs to update: docs/guides/benchmarks.md if it explains the power section.
- Acceptance criteria: Unit test pins MDE for a two-block design to the per-block n and corrected alpha.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

### B5 Tuning decisions

#### A-09 [#134](https://github.com/epittman23/local-llm/issues/134): Tune sweep adopts (and refines around) a candidate that is slower than the profile defaults

- Severity / status / effort: High / Confirmed / S
- Locations: `apps/server/local_llm/benchmarks/tuning/tune.py:1282-1285`; `apps/server/local_llm/benchmarks/tuning/tune.py:1328-1335`; `apps/server/local_llm/benchmarks/tuning/tune.py:1405-1449`
- Root cause: The "beat the baseline" condition is never checked.
- Recommended fix: Require score > 0 in `best()` and in `finish()`'s ranked list (optionally a significance test against baseline); make `refine()` stop when none qualifies.
- Files likely to change: tuning/tune.py, new tests/test_tune_ranking.py
- Regression risks: Past sweep verdicts in the DB may be wrong; consider a decisions.md note.
- Docs to update: docs/guides/benchmarks.md / llama-cpp.md tuning verdicts if they describe the rule.
- Acceptance criteria: Unit test: with all candidates slower than baseline, `best()` is None and the verdict is rejected.

#### A-10 [#135](https://github.com/epittman23/local-llm/issues/135): Tune elimination ranks a candidate exactly tied with the baseline below every slower candidate

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/benchmarks/tuning/tune.py:1175-1179`
- Root cause: Falsy-zero bug; only None should map to -inf (tune.py near 1563 already does this correctly).
- Recommended fix: Use an explicit `is not None` check in the key.
- Files likely to change: tuning/tune.py, tests
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Unit test: a 0.0-scored candidate survives over a negative one.

#### A-11 [#136](https://github.com/epittman23/local-llm/issues/136): Tune's uncertain-cut sign test pairs mismatched items and treats n=0 as a supported cut

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/benchmarks/tuning/tune.py:1194-1206`
- Root cause: Positional pairing instead of keyed pairing; no minimum-n rule.
- Recommended fix: Compute differences over item keys present for all three cells; treat n below a threshold as uncertain.
- Files likely to change: tuning/tune.py, tests
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Unit test with misaligned missing items reproduces the aligned p-value.

#### A-12 [#137](https://github.com/epittman23/local-llm/issues/137): Cooldown time accounting overwrites the running total, so max_cooldown_share is not enforced across pauses

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/server/local_llm/benchmarks/tuning/tune.py:515-529`
- Root cause: Assignment instead of a pause-local variable.
- Recommended fix: Keep a local `elapsed`, check `self.total_seconds + elapsed` in `budget_exhausted`, add once.
- Files likely to change: tuning/tune.py, tests
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Unit test with a fake clock: totals accumulate across pauses and the cap trips.

#### A-13 [#138](https://github.com/epittman23/local-llm/issues/138): Stopping a sweep during a visit's teardown or a cooldown can skip ServeProcess.stop and leave visit/pause rows running forever

- Severity / status / effort: Medium / Suspected / M
- Locations: `apps/server/local_llm/benchmarks/tuning/tune.py:942-950`; `apps/server/local_llm/benchmarks/tuning/tune.py:255-265`; `apps/server/local_llm/benchmarks/tuning/tune_probe.py:195-222`; `apps/server/local_llm/routers/benchmarks/tune.py:112-120`
- Root cause: Cleanup is cancellable and nothing closes open visits/pauses on interruption.
- Recommended fix: Shield teardown (`asyncio.shield`) or run it in an uncancellable finally; close open visits and pauses in `finish()` when interrupted.
- Files likely to change: tuning/tune.py, tuning/tune_probe.py, tests
- Regression risks: Shielded teardown must still respect a hard timeout.
- Docs to update: None.
- Acceptance criteria: Async test cancelling during teardown shows ServeProcess.stop called and rows closed.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-14 [#139](https://github.com/epittman23/local-llm/issues/139): A sweep whose baseline fails to load never narrows and does not say why

- Severity / status / effort: Low / Suspected / S
- Locations: `apps/server/local_llm/benchmarks/tuning/tune.py:1112`; `apps/server/local_llm/benchmarks/tuning/tune.py:1193`
- Root cause: No handling for an infeasible baseline.
- Recommended fix: End the sweep with an explicit reason when the baseline is infeasible.
- Files likely to change: tuning/tune.py, tests
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Unit test: infeasible baseline ends the sweep with that reason.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

### B6 Benchmarks frontend robustness

#### A-18 [#143](https://github.com/epittman23/local-llm/issues/143): Benchmarks pages show "[object Object]" or a generic message instead of the server error, and Serve treats network failures as success

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/lib/apis/benchmarks/index.ts:131-185`; `apps/web/src/lib/apis/benchmarks/index.ts:720-790`; `apps/web/src/routes/benchmarks/ServePage.tsx:171`; `apps/web/src/routes/benchmarks/ServePage.tsx:181`; `apps/web/src/routes/benchmarks/TunePage.tsx:146-180`; `apps/web/src/routes/benchmarks/TunePage.tsx:229`; `apps/web/src/routes/benchmarks/TunePage.tsx:467`; `apps/web/src/routes/benchmarks/TunePage.tsx:526`
- Root cause: Inconsistent error contract between `lib/apis/benchmarks/index.ts` and its callers.
- Recommended fix: Normalise errors in the helpers with the existing `errorMessage()` from profiles.ts and rethrow on network failure; render `String(err)` in the pages.
- Files likely to change: lib/apis/benchmarks/index.ts, ServePage.tsx, TunePage.tsx, unit tests
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Vitest: a 422 and a 409 produce readable messages; a rejected fetch rejects the helper.

#### A-19 [#144](https://github.com/epittman23/local-llm/issues/144): Tune page live-status stream can outlive the page or run twice (the L17 fix was not applied to Tune)

- Severity / status / effort: Low / Confirmed / S
- Locations: `apps/web/src/routes/benchmarks/TunePage.tsx:132-194`; `apps/web/src/lib/apis/benchmarks/index.ts:910-939`
- Root cause: The 2026-09-27 L17 fix covered ServePage and TestsPage only.
- Recommended fix: Pass a caller-owned controller into `streamTuneLog` (as `streamServe` does) and apply the ServePage pattern.
- Files likely to change: TunePage.tsx, lib/apis/benchmarks/index.ts, tests
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Vitest or e2e: switching sweeps mid-request leaves exactly one active stream.

#### A-31 [#156](https://github.com/epittman23/local-llm/issues/156): Telemetry recorder attaches a new run to whatever server already answers on the port

- Severity / status / effort: Medium / Suspected / S
- Locations: `apps/server/local_llm/benchmarks/serving/telemetry_recorder.py:109-117`; `apps/server/local_llm/benchmarks/serving/telemetry_recorder.py:403-412`
- Root cause: Readiness check does not verify the server it measures is the one just spawned.
- Recommended fix: Check the spawned pid is alive and/or that `/v1/models` reports the expected alias before opening the run; refuse to start when the port is already bound.
- Files likely to change: serving/telemetry_recorder.py, serving/launcher.py, tests
- Regression risks: Low.
- Docs to update: docs/guides/telemetry.md.
- Acceptance criteria: Test with a stub listener already on the port: start fails or no run is opened.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

### B7 Chat correctness

#### A-35 [#160](https://github.com/epittman23/local-llm/issues/160): Chat documents are not pruned to the current conversation path, so a file from a deleted message or another branch is still sent as context

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/lib/chat/request.ts:142-147`; `apps/web/src/lib/chat/request.ts:181`; `apps/web/src/routes/chat/useChatSession.ts:352`; `apps/web/src/routes/chat/useChatSession.ts:406`; `apps/web/src/routes/chat/useChatSession.ts:499`
- Root cause: The pruning step was lost in the port (an undocumented behaviour change).
- Recommended fix: Before `turnFiles`, filter `chatFiles` by id to files of `messagesList(history, responseId)`, and write the filtered list back with `setChatFiles`, as the original did.
- Files likely to change: lib/chat/request.ts, routes/chat/useChatSession.ts, request.test.ts
- Regression risks: Files attached through other paths (e.g. knowledge/collections in chatFiles) must still be kept if the original kept them; compare carefully.
- Docs to update: None.
- Acceptance criteria: Vitest: a history whose path carries no files produces no `files` in the body; a path carrying X still sends X.

#### A-25 [#150](https://github.com/epittman23/local-llm/issues/150): A reply left unfinished on a non-current branch stays "generating" forever after reload

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/lib/chat/history.ts:220-232`; `apps/web/src/routes/chat/useChatSession.ts:166-190`
- Root cause: Condition contradicts the function's own docstring ("mark every assistant reply but the current one done").
- Recommended fix: When no tasks are pending, mark every `done: false` assistant reply done in `loadChat` (or in `normalizeHistory` given a no-live-tasks flag).
- Files likely to change: lib/chat/history.ts, routes/chat/useChatSession.ts, their unit tests
- Regression risks: Do not finalise a reply whose task is still live.
- Docs to update: None.
- Acceptance criteria: Vitest: loading a history with a stale non-current `done:false` reply and no pending tasks leaves nothing generating.

#### A-26 [#151](https://github.com/epittman23/local-llm/issues/151): Stop pressed before the backend creates the task in an existing chat cancels nothing; the reply keeps streaming after the UI shows stopped

- Severity / status / effort: Medium / Suspected / S
- Locations: `apps/web/src/routes/chat/useChatSession.ts:455-470`; `apps/server/local_llm/main.py:1714`
- Root cause: The 2026-09-27 L3 fix covered only chats without an id.
- Recommended fix: Track an in-flight ref; when no task ids are known yet, set `stopPendingRef` regardless of chat id and stop the ids when the POST resolves; apply the same in `continueReply`.
- Files likely to change: routes/chat/useChatSession.ts, useChatSession.test.tsx
- Regression risks: Must not double-stop.
- Docs to update: None.
- Acceptance criteria: Vitest with a delayed POST: Stop before resolution results in a stop call for the returned task ids.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

### B8 Calendar and automations

#### A-33 [#158](https://github.com/epittman23/local-llm/issues/158): Editing a calendar event cannot remove its repeat rule, description or location

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/calendar/calendarModel.ts:196-207`; `apps/web/src/lib/apis/calendar/index.ts:319-334`; `apps/server/local_llm/models/calendar.py:703-716`
- Root cause: "Unset" and "cleared" are both encoded as an absent key.
- Recommended fix: When editing, send explicit `null` for cleared fields (the backend form already accepts `None` for rrule; verify description/location); keep omitting an rrule the form cannot express so it is preserved.
- Files likely to change: routes/calendar/calendarModel.ts, its unit test; possibly the backend form
- Regression risks: Must not clear rrules the picker cannot represent.
- Docs to update: None.
- Acceptance criteria: Vitest: editing an event with repeat set to none produces a payload with `rrule: null`; an e2e or backend test shows the rule removed.

#### A-34 [#159](https://github.com/epittman23/local-llm/issues/159): Automation schedule picker silently rewrites RRULEs it cannot represent and mislabels them

- Severity / status / effort: Medium / Confirmed / S
- Locations: `apps/web/src/routes/automations/automationModel.ts:64-75`; `apps/web/src/routes/automations/automationModel.ts:86-99`; `apps/web/src/routes/automations/automationModel.ts:122-138`
- Root cause: Representability is decided from FREQ alone.
- Recommended fix: Return CUSTOM (keeping the text verbatim) when any key/value is outside what the picker expresses, for example by requiring `buildRrule(parseRrule(r))` to equal the normalised input; use the same test in `formatSchedule`.
- Files likely to change: routes/automations/automationModel.ts, its unit test
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Vitest: the three rules above round-trip unchanged and are labelled as custom.

### B9 Benchmark profile concurrency

#### A-27 [#152](https://github.com/epittman23/local-llm/issues/152): Concurrent archive and set-default can leave the default serving profile archived

- Severity / status / effort: Low / Suspected / S
- Locations: `apps/server/local_llm/models/benchmarks/profiles.py:341-368`; `apps/server/local_llm/routers/benchmarks/profiles.py:257-274`
- Root cause: Check-then-write under READ COMMITTED; no constraint.
- Recommended fix: `SELECT ... FOR UPDATE` in both methods, or a CHECK constraint in a new revision.
- Files likely to change: models/benchmarks/profiles.py, maybe a migration, tests
- Regression risks: A new constraint must handle existing rows.
- Docs to update: None.
- Acceptance criteria: Concurrency test (two sessions) cannot produce an archived default.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-28 [#153](https://github.com/epittman23/local-llm/issues/153): Concurrent profile create/clone/version edit returns 500 instead of 409

- Severity / status / effort: Low / Suspected / S
- Locations: `apps/server/local_llm/models/benchmarks/profiles.py:298-330`; `apps/server/local_llm/routers/benchmarks/profiles.py:167-222`
- Root cause: IntegrityError not mapped.
- Recommended fix: Catch IntegrityError, roll back, raise 409.
- Files likely to change: models/benchmarks/profiles.py or routers/benchmarks/profiles.py, tests
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Test: a duplicate insert returns 409.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

### B10 Backend minor

#### A-29 [#154](https://github.com/epittman23/local-llm/issues/154): Chat list endpoints turn page < 1 into a negative OFFSET and fail instead of validating

- Severity / status / effort: Low / Suspected / S
- Locations: `apps/server/local_llm/routers/chats.py:250-262`; `apps/server/local_llm/routers/chats.py:306-315`; `apps/server/local_llm/routers/chats.py:440-453`; `apps/server/local_llm/models/chats.py:1409`; `apps/server/local_llm/models/chats.py:1486`
- Root cause: No `ge=1` validation (inherited).
- Recommended fix: Declare `page` with `Query(ge=1)` on these routes.
- Files likely to change: routers/chats.py, tests
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: Test: page=0 returns 422.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-30 [#155](https://github.com/epittman23/local-llm/issues/155): Streaming usage is merged on every usage-bearing chunk, double-counting when a provider repeats usage

- Severity / status / effort: Low / Suspected / S
- Locations: `apps/server/local_llm/utils/middleware.py:4977`; `apps/server/local_llm/utils/middleware.py:5021`; `apps/server/local_llm/utils/response.py:100-141`
- Root cause: Per-chunk merge instead of last-wins per pass.
- Recommended fix: Keep a per-pass usage that each chunk overwrites; merge it once per pass.
- Files likely to change: utils/middleware.py, tests
- Regression risks: Characterization fixtures pin current behaviour; update deliberately.
- Docs to update: None.
- Acceptance criteria: Characterization test with repeated cumulative usage records it once.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

### B11 Build, CI and docs hygiene

#### A-20 [#145](https://github.com/epittman23/local-llm/issues/145): make frontend ignores a failed bun install, starts the dev server anyway and never sets its cleanup trap

- Severity / status / effort: Medium / Confirmed / S
- Locations: `Makefile:118-124`
- Root cause: `&&` and `;` mixed under `-e`.
- Recommended fix: Separate the steps with `;` (so `-e` aborts) and set the trap before starting the daemon.
- Files likely to change: Makefile
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: With `bun install` forced to fail, `make frontend` exits non-zero and no astro daemon is left (`bunx astro dev status`).

#### A-21 [#146](https://github.com/epittman23/local-llm/issues/146): make test-e2e does not run Playwright as CI does (workers, CI env), although the docs say it mirrors CI

- Severity / status / effort: Low / Confirmed / S
- Locations: `Makefile:175-182`; `.github/workflows/ci.yml:108-109`; `apps/web/playwright.config.ts:1-30`; `docs/guides/testing.md:17-24`; `docs/guides/testing.md:52-56`
- Root cause: Worker count pinned in the Makefile only; behaviour switched by the CI env var.
- Recommended fix (owner decision: use `CI=1`): pin `workers: 2` in playwright.config.ts and run the Make target as `CI=1 bun run test:e2e`, so retries, `forbidOnly` and server reuse match CI. Note in the Makefile comment and testing.md that `CI=1` disables dev-server reuse, so a running `make frontend` must be stopped first (it already must be).
- Files likely to change: Makefile, playwright.config.ts, docs
- Regression risks: CI=1 locally disables dev-server reuse.
- Docs to update: docs/guides/testing.md, Makefile comment, AGENTS.md Commands.
- Acceptance criteria: Make and CI invoke the same command; a `test.only` fails `make test-e2e`.

#### A-22 [#147](https://github.com/epittman23/local-llm/issues/147): make test-backend runs pytest even if its Postgres never became ready, and the readiness probe can pass before TCP is up

- Severity / status / effort: Low / Suspected / S
- Locations: `Makefile:145-166`
- Root cause: Probe over the wrong transport; no timeout exit.
- Recommended fix: Probe with `pg_isready -h 127.0.0.1` and exit with a message when the loop runs out.
- Files likely to change: Makefile
- Regression risks: Low.
- Docs to update: None.
- Acceptance criteria: With a container that never becomes ready, the target fails with a clear message before pytest.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-23 [#148](https://github.com/epittman23/local-llm/issues/148): make backend does not wait for Postgres before the app runs migrations at import

- Severity / status / effort: Low / Suspected / S
- Locations: `Makefile:92`; `infra/docker-compose.yml:25-41`; `apps/server/local_llm/config.py:52-70`
- Root cause: No readiness wait.
- Recommended fix: Add a `pg_isready` healthcheck and use `up -d --wait postgres`.
- Files likely to change: Makefile, infra/docker-compose.yml
- Regression risks: Low.
- Docs to update: README "Running it" if behaviour changes.
- Acceptance criteria: `make backend` against a fresh volume starts on the first try.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

#### A-24 [#149](https://github.com/epittman23/local-llm/issues/149): Stale documentation: pre-commit header claims ruff-check covers only part of the backend, and MAP.md omits tracked top-level files

- Severity / status / effort: Low / Confirmed / S
- Locations: `.pre-commit-config.yaml:10-14`; `.pre-commit-config.yaml:49`; `MAP.md:14-30`; `MAP.md:336-342`
- Root cause: Docs not updated with #80 and later layout changes.
- Recommended fix: Delete the stale bullet; add MAP.md entries and fix the cross-reference.
- Files likely to change: .pre-commit-config.yaml, MAP.md
- Regression risks: None.
- Docs to update: These files.
- Acceptance criteria: `make lint` green; every tracked top-level entry appears in MAP.md.

#### A-32 [#157](https://github.com/epittman23/local-llm/issues/157): Flaky e2e assertion in the knowledge list search test

- Severity / status / effort: Low / Suspected / S
- Locations: `apps/web/e2e/workspace-knowledge.spec.ts:156-172`
- Root cause: Non-polling assertion on request log after a UI condition.
- Recommended fix: Use `expect.poll(() => calls.some(...)).toBe(true)` or wait for the request.
- Files likely to change: apps/web/e2e/workspace-knowledge.spec.ts
- Regression risks: None.
- Docs to update: None.
- Acceptance criteria: The spec passes repeatedly under `--repeat-each=20 --workers=2`.
- Before fixing: write the reproduction first; if it does not reproduce, comment on the issue with the evidence and ask before closing it.

## 5. Rules for the fixing session (from AGENTS.md)

- One branch and one pull request per batch; `main` takes squash-merged PRs
  after the required `CI passed` check.
- Conventional commits, one topic each (for example
  `fix(benchmarks): require the grading sentinel before scoring a pass`).
- Run `make check` (or each of its parts, as above) and get it green before
  opening a PR.
- A regression test for every fix, failing before and passing after; name it in
  the PR. Playwright mocks the backend, so a fix across the seam (B4, B6) also
  needs a backend test of the real response shape.
- Update the docs in the same commit as the code, per the maintenance policy
  (README, AGENTS.md "Local inference", `docs/guides/*`, MAP.md as applicable).
- Add a dated entry at the top of `docs/decisions.md` (never edit older
  entries) when a fix changes a decision, and the matching milestone in
  `docs/roadmap-timeline.mmd` plus the byte-identical block in `docs/ROADMAP.md`.
  Likely for B1 (meaning of stored pass rates), B2 and B3.
- Schema changes are new Alembic revisions under
  `apps/server/local_llm/migrations/versions/`; never edit an applied one.
- When fingerprint coverage changes (B3), add a `benchmark_schema_note` row in
  the same change and mirror the flags in `serving/fingerprint.py`.
- Never reformat files under `apps/server/local_llm/benchmarks/data/prompts/`.
- No co-author lines and no "Generated with Claude Code" text in commits or PRs.
- Stop and ask the owner before changing a public interface (API routes or
  response shapes beyond what the issue describes) or making an architectural
  decision; section 6 records the decisions already made.
- Reference the issue in each PR (`Fixes #N`) and do not touch issues outside
  the batch.

## 6. Owner decisions (2026-10-19)

The owner answered the audit's open questions on 2026-10-19. Context for all
of them: the database held no benchmark data that day, and the owner plans to
re-test everything once the fixes land.

1. **A-02 fingerprint ([#127](https://github.com/epittman23/local-llm/issues/127))**: take the best fix, even though every
   `config_id` changes. See A-02 in section 4 (model basename and `extra`
   lines, always present; a `benchmark_schema_note` row still required).
2. **A-16 dataset fetch and selfcheck ([#141](https://github.com/epittman23/local-llm/issues/141))**: build the endpoints and Tests
   page actions properly; do not settle for a docs-only fix.
3. **A-01 grader ([#126](https://github.com/epittman23/local-llm/issues/126))**: do not re-grade stored answers.
4. **A-09 tuning verdicts ([#134](https://github.com/epittman23/local-llm/issues/134))**: do not review past `adopted` sweeps.
5. **A-21 ([#146](https://github.com/epittman23/local-llm/issues/146))**: run `make test-e2e` with `CI=1`.
6. **Security findings**: filed as private draft security advisories, to be
   fixed first (batch B0), before any bug-fix batch.

### Still open at execution time

- **Where to fix B0.** A normal pull request in this public repository
  discloses the vulnerability before the advisory is published. GitHub's
  temporary private fork (an advisory's "Start a temporary private fork")
  avoids that, but check before relying on it that GitHub Actions run there
  and that the required `CI passed` check is satisfied; if not, run
  `make check` locally and ask the owner how to merge. The B0 findings are
  small default and validation changes, so the window a public PR opens is
  short either way; the owner chooses.
