# Bug audit coverage plan

Audited commit: `7a4088b20f3aa27cf35abb07689e68b19408c003` on `main` (default
branch), 2026-10-19. All line references in `docs/audit/` refer to that SHA.
Findings go to [FINDINGS.md](FINDINGS.md); the fix plan is
[FIX_PLAN.md](FIX_PLAN.md). Security findings are deliberately not recorded
in any committed file.

Line counts are `wc -l` over the tracked files of each unit at the audited
SHA. Each unit includes the tests that cover it (a test that cannot fail is
a finding).

## Exclusions

| Excluded | Reason |
|---|---|
| `apps/server/uv.lock`, `apps/web/bun.lock` | generated lockfiles; checked only by `uv lock --check` / `--frozen-lockfile` |
| `apps/server/local_llm/static/fonts/*.ttf`, `*.png`, `*.ico`, `apps/web/public/audio/*.mp3` | binary assets |
| `apps/server/local_llm/static/swagger-ui/swagger-ui-bundle.js`, `swagger-ui.css` | vendored third-party build output |
| `apps/web/public/static/user-import.csv` | sample data file |
| `apps/server/tests/fixtures/*.json` (~120k lines) | recorded characterization data; read only where a test's correctness depends on it |
| `LICENSE`, `LICENSE_HISTORY`, `CONTRIBUTOR_LICENSE_AGREEMENT`, `NOTICE` | legal texts |
| `docs/history/*` | completed records; read for known findings, not audited |
| Benchmark datasets | not tracked (fetched into `DATA_DIR` at runtime) |

## Units, in risk order

- [x] **U1 Serving and process lifecycle** (a): `benchmarks/serving/*` (9 files, 1832 lines), `routers/benchmarks/serve.py`, `docs/serving-baseline/`; invariant: fingerprint covers launcher flags incl. `--parallel 1`
  - Status: reviewed; launcher, fingerprint, env_profile, telemetry_recorder, serve router read in full; findings A-02, A-31; tests not read line by line.
- [x] **U2 Evaluation and grading** (a): `benchmarks/evaluation/**` (9 files, 1579 lines), `benchmarks/data/**` (16 files, 2963 lines), the tests/datasets routers
  - Status: reviewed in full; findings A-01, A-15, A-16, A-17; assistant.txt matches README byte for byte.
- [x] **U3 Analysis: Compare, Report, stats** (a): `benchmarks/analysis/*` (5 files, 3986 lines) and their routers
  - Status: reviewed in full; findings A-03..A-08; no tests exist for analysis/*.
- [x] **U4 Tuning** (a): `benchmarks/tuning/*` (5 files, 2901 lines)
  - Status: reviewed in full; findings A-09..A-14.
- [x] **U5 Benchmark persistence and migrations** (a): `models/benchmarks/*` (6 files, 2034 lines), `routers/benchmarks/*` (9 files, 1153 lines), `migrations/**` (64 files, 6318 lines) with git history of applied revisions and `benchmark_schema_note`
  - Status: reviewed; full git history (after `git fetch --unshallow`): no applied revision edited beyond formatting/annotations; fingerprint coverage unchanged since its 2026-09-14 port, so no schema note owed; all benchmark routes admin-only; findings A-27, A-28.
- [x] **U6 Build, infra, CI and doc invariants** (a): `Makefile` (187), `infra/` (52), `.github/` (277), `.pre-commit-config.yaml` (66); invariants: assistant.txt vs README, roadmap mermaid byte-identity, MAP.md, README "Running it"/"Pages and URLs", `WEBUI_*` leftovers
  - Status: reviewed; roadmap mermaid byte-identical, README Pages and URLs match, no live WEBUI_* settings; findings A-20..A-24.
- [x] **U7 Frontend/backend seam** (b): `apps/web/src/lib/apis/**` (32 files, 16605 lines) and every Benchmarks page call, checked against FastAPI routes
  - Status: reviewed; all 448 fetch calls matched to routes by method and path, all 36 benchmark calls checked field by field; non-benchmark bodies spot-checked; findings A-04, A-05, A-18.
- [ ] **U8 Security-relevant inherited backend** (c): `utils/auth.py`, `utils/oauth.py`, `routers/auths.py`, `routers/files.py`, `routers/knowledge.py`, `routers/retrieval.py`, `retrieval/web/**`, `retrieval/loaders/**`, `routers/configs.py`, `main.py` middleware
- [ ] **U9 Ported frontend: chat surface** (d): `routes/chat/**`, `lib/chat/**`, `lib/markdown/**`, `components/chat/**`, `lib/socket`, `lib/auth`
- [ ] **U10 Ported frontend: other surfaces** (d): `routes/{workspace,admin,channels,notes,calendar,automations,playground,benchmarks,public,home}/**`, `components/{common,settings,layout}/**`, remaining `lib/**`; `d863707:` parity spot checks
- [ ] **U11 Remaining backend** (e): remaining `routers/*`, `utils/*` (25411 lines), `models/*` (18422), `retrieval/*` remainder, `socket/*` (1559), `tools/*` (5732), `internal/`, `main.py`, `config.py`, `env.py`, `tasks.py`, `events.py`, `functions.py`

Totals in scope: roughly 230k lines across ~780 files (backend ~105k, frontend ~120k, tests reviewed alongside their units).
