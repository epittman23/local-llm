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
- [x] **U8 Security-relevant inherited backend** (c): `utils/auth.py`, `utils/oauth.py`, `routers/auths.py`, `routers/files.py`, `routers/knowledge.py`, `routers/retrieval.py`, `retrieval/web/**`, `retrieval/loaders/**`, `routers/configs.py`, `main.py` middleware
  - Status: reviewed with gaps; auth, files, knowledge, retrieval, SSRF, users, SPAStaticFiles, socket handlers, channels, notes, prompts, groups, models, functions, tools, configs, OAuth login/MCP callback/redirects and loaders read or checked for authorization; not read: tools/knowledge_fs.py and oauth.py 491-930 (role/group sync, dynamic client registration). Findings in this unit are security-relevant and are not recorded here.
- [x] **U9 Ported frontend: chat surface** (d): `routes/chat/**`, `lib/chat/**`, `lib/markdown/**`, `components/chat/**`, `lib/socket`, `lib/auth`
  - Status: reviewed; chat session, history, request, sources, markdown sanitisation, socket and auth read; `d863707` parity checked for request/sources/import; findings A-25, A-26, A-35. Not compared with the original: attachments.ts and the socket event handling.
- [x] **U10 Ported frontend: other surfaces** (d): `routes/{workspace,admin,channels,notes,calendar,automations,playground,benchmarks,public,home}/**`, `components/{common,settings,layout}/**`, remaining `lib/**`; `d863707:` parity spot checks
  - Status: partially reviewed: Benchmarks pages and helpers, calendar and automations models, access grants, knowledge sync (parity) read; workspace models editor/import, admin permission rows, channels feed, notes, settings tabs and most components/common not reviewed line by line; findings A-18, A-19, A-32, A-33, A-34.
- [x] **U11 Remaining backend** (e): remaining `routers/*`, `utils/*` (25411 lines), `models/*` (18422), `retrieval/*` remainder, `socket/*` (1559), `tools/*` (5732), `internal/`, `main.py`, `config.py`, `env.py`, `tasks.py`, `events.py`, `functions.py`
  - Status: partially reviewed: refactors #98, #118, #123/#124 diffed against their originals and found equivalent; env parsing, pgvector client, usage handling, chats pagination read; not reviewed line by line: most of utils/* (25k lines), models/*, routers/openai.py error paths, socket/* beyond authz, tools/*; findings A-29, A-30.

Totals in scope: roughly 230k lines across ~780 files (backend ~105k, frontend ~120k, tests reviewed alongside their units).

## Gap review (2026-10-19, second session)

The partly reviewed areas of U8-U11 were split into 19 bounded packages and
read line by line on the owner's laptop. Every package reported the files it
fully read; all listed files were fully read except where noted.

- [x] B1 `utils/middleware.py` (6371)
- [x] B2 `utils/{tools,misc,anthropic,subagents}.py` (4821)
- [x] B3 `utils/{automations,memory,models,plugin,payload,context_compaction,timers,task}.py` (4275)
- [x] B4 the remaining small `utils/*` modules (about 5300)
- [x] B5 `utils/oauth.py` 1-1019 and 1821-2360, `tools/knowledge_fs.py`, `socket/main.py`, `socket/utils.py` (oauth.py 1019-1820 and 2360-2438 partly read)
- [x] B6 `tools/builtin.py` (4542)
- [x] B7 `routers/openai.py`, `models/chats.py` (4701)
- [x] B8 `models/{knowledge,chat_messages,channels,access_grants,calendar,users}.py` (5747)
- [x] B9 `models/{prompts,models,groups,messages,feedbacks,folders,automations,files,functions,notes}.py` (5670)
- [x] B10 `models/{config,skills,oauth_sessions,tools,memories,auths,prompt_history,shared_chats,tags}.py`, and `config.py`'s persistent-config machinery (config.py partly read)
- [x] F1 chat session, history, attachments, with `d863707` parity
- [x] F2 `routes/workspace/{models,skills,tools,prompts}`
- [x] F3 `routes/workspace/knowledge`, `routes/admin/users`, workspace layout
- [x] F4 admin evaluations/functions/analytics/top level, notes, playground, public, home, layout
- [x] F5 admin settings: Documents, Events, Audio, Images, External Knowledge, Connections
- [x] F6 admin settings: models/, Interface, Web Search, Authentication, General, Pipelines, Arena, Integrations, Code Execution, Subagents, Evaluations, Database, Banners
- [x] F7 `routes/channels`, `lib/{utils,settings,query}`
- [x] F8 `components/common`, `lib/access`
- [x] F9 `components/settings`

## Final review wave (2026-10-19, second session)

Areas no earlier package covered, read line by line:

- [x] W1 `routers/retrieval.py`, `retrieval/external.py`, `retrieval/vector/**`, `retrieval/models/**`
- [x] W2 `routers/{knowledge,files,folders}.py`
- [x] W3 `routers/{channels,notes,groups,notifications,utils}.py`
- [x] W4 `routers/{chats,models,prompts,skills}.py`
- [x] W5 `routers/{ollama,audio,images}.py`
- [x] W6 `routers/{auths,users,scim,analytics}.py`
- [x] W7 `routers/{tools,configs,functions,tasks,memories,pipelines}.py`
- [x] W8 `routers/{evaluations,calendar,terminals,automations}.py`, `retrieval/utils.py`
- [x] W9 `main.py`, `events.py`
- [x] W10 `config.py` (all of it), `env.py`, `functions.py`, `tasks.py`, `constants.py`
- [x] W11 `routes/calendar/**`, `routes/automations/**`, the code in `lib/i18n/` and `lib/emoji/` (their data files checked for consistency only)

### Still not read line by line

- `apps/web/src/components/ui/` (generated shadcn/ui primitives).
- `apps/server/local_llm/utils/oauth.py` lines 1019-1820 and 2360-2438
  (OAuth provider registration helpers and session plumbing; partly read).
- `apps/web/src/lib/apis/**` request and response shapes for calls no page
  package exercised (paths and methods of every call were checked in U7).
- Test files were read where a package judged whether a test could fail, not
  exhaustively.
