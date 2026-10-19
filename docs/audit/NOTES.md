# Audit notes (not filed as issues)

Observations from the audit of `7a4088b` that are style, design questions,
dead code, or test gaps rather than incorrect behaviour. None was filed as an
issue; each is a candidate for a deliberate decision or a cleanup PR.

## Invariants checked and holding

- `benchmarks/data/prompts/assistant.txt` is byte-identical to the system
  prompt block in README.md "Model setup" (`cmp`, 5 lines, LF, trailing newline).
- `docs/roadmap-timeline.mmd` is byte-identical to the mermaid block in `docs/ROADMAP.md`.
- README "Running it" and "Pages and URLs" match the Makefile, ports, `infra/.env` keys,
  `AppRouter.tsx` and `routePaths.ts`, including every query parameter read.
- No `WEBUI_*` environment variable is still read; remaining `WEBUI_*` names are internal
  Python/JS identifiers, the intentional plugin alias map in `env.py`, and history.
- `--parallel 1` is passed unconditionally and is fingerprinted. The fingerprint's coverage
  has not changed since its 2026-09-14 port, so no `benchmark_schema_note` row was owed.
  (Its gap, `extra` and the model file, is A-02.)
- No applied Alembic revision was edited semantically. Later commits touching revisions are
  formatting (`5a11c0e`, before the revision was applied; `1fde9b2`), type-annotation
  modernisation (`f19bb6b`) and import sorting (`0e0ef1c`, `44ab8a2`). Single head
  `5a1f0c3e9b27`; upgrade/downgrade/upgrade ran clean on SQLite.
- Every `routers/benchmarks/*` route depends on `get_admin_user`.
- Ported pieces compared against `d863707` and found equivalent apart from A-35 and the
  gaps the 2026-09-27 review already recorded: `lib/chat/importChats.ts`, `lib/chat/sources.ts`,
  `lib/chat/request.ts`, `workspace/knowledge/knowledgeFiles.ts` and `useKnowledgeUploads.ts`,
  `lib/access/accessGrants.ts`.

## Test gaps (each would have caught a filed bug)

- No tests cover `benchmarks/analysis/compare.py`, `report.py`, `stats.py`, or the compare and
  report routers (A-03 to A-08).
- `tests/test_tune_probe.py` covers only `Server.start`; nothing tests `eliminate`, `best`,
  `finish`, `log_ratios`/`sign_test`, `plan_schedule`, `Cooldown` or `resume_sweep` (A-09 to A-14).
- Playwright mocks for Compare use the shape the page expects, not what the backend returns
  (A-04, A-05); a backend test asserting response keys would pin the contract.
- DB-touching methods of `BenchmarkProfileTable` have no tests (A-27, A-28).

## Design questions

- `resume_sweep` resets `started`, the full `budget_seconds` and `visits`, so each resume gets
  a fresh budget, although an inline comment says resuming "does not hand back the time already spent".
- The Report's reliability floor ("share of repeated cells that flipped") is compared with net
  pass-rate differences, which mixes units; cells measured three or more times bias it upward.
- `Regimes.window` falls back to the nearest GPU sample with no distance limit.
- Grading uses `max_tokens` 2048 by default and does not record `finish_reason`, so a truncated
  thinking-model answer is indistinguishable from a wrong one.
- `humaneval.py` checks only for `def entry`, so a solution that defines it as a class method is
  not given the stub and fails with NameError.
- `datasets.fetch_one` writes `items.jsonl` then `MANIFEST.json` without an atomic rename.
- `/benchmarks/tests/stream` reads from one shared queue, so two viewers split the events.
- `load_system` hashes the prompt text with trailing newlines stripped, consistent with what is
  sent but not literally "a sha of the exact bytes" as AGENTS.md says.
- `parallel` is an editable profile field and Serve override, while AGENTS.md says every profile
  serves one slot with `--parallel 1` passed unconditionally; the validator rejects `--parallel`
  only inside `extra`. Reconcile the wording or the field.
- In a multi-model chat request `_resolve_chat_model` access-checks only the primary model up
  front; secondary models are checked later, after payload processing (noted in #118 already).
- `ProfileDefinitionForm.tsx`: clearing `parallel`, `batch` or `ubatch` submits `Number('') = 0`;
  outcome depends on backend validation.
- `validate_definition` accepts non-positive `ctx`, `threads`, `batch`, `parallel`.

## Dead code and stale text

- `lib/apis/retrieval/index.ts` `processWebSearch` posts `{query, collection_name}` where the
  backend requires `queries: list[str]`; it has no callers.
- `retrieval/vector/dbs/pgvector.py` around lines 90-97: the `ScopedSession` branch is unreachable.
- `BenchmarkSchemaNoteTable.add_note` is never called (notes come only from migrations).
- `serving/launcher.py` `build_database_url` is used only by the Makefile.
- The ORM models for benchmark tables omit indexes and server defaults that the migrations
  create; harmless now, but a future autogenerate would propose dropping them.
- `5a1f0c3e9b27`'s downgrade deletes its own schema-note row.
- `tuning/tune.py` docstrings still describe launching through `benchmarks.proc.Command` and
  `llama-env.sh`.
- `routePaths.ts` lines 2-4 still mention a fallback `<a>` to the SvelteKit app.
- `docs/guides/frontend.md` lines 13-15 omit `/static` from the proxied paths in `astro.config.mjs`.
- `make lint` omits CI's `--color=always` (cosmetic); `COMPOSE` in the Makefile does not quote
  the compose file path.
- `lib/apis/utils/index.ts:99` declares an unused `error` (astro check warning).
- CI pins Node 26 while AGENTS.md and `package.json` state a floor of 22.12 that CI never tests.

## Environment limits met during the audit

- `download.pytorch.org` is blocked by this environment's network policy, so `make test-backend`
  failed at `uv sync`; the suite was run with the venv synced without torch.
- Docker Hub returned 429 for `pgvector/pgvector:pg16`, so `test_the_app_imports` could not get
  its database and failed; no migration ran against Postgres (SQLite only).
- `cdn.playwright.dev` is blocked; the pre-installed Chromium is revision 1194 while the pinned
  Playwright expects 1248, so e2e ran against 1194 through a symlink outside the repository.
- No GPU, CUDA, llama.cpp or OpenRouter access: serving, telemetry and tuning had static review
  plus unit-level repros only.
- The clone was shallow; `git fetch --unshallow` was run to check migration history and `d863707`.
